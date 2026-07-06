// Fantasy Frontiers — server-authoritative shared Guild Estate (5 task slots).
//
// Members run estate-crafting jobs on 5 shared slots (one task per member). Inputs are
// funded from the member's own inventory client-side; output is deposited into the guild
// bank on collect. This function owns the shared mechanics: slot allocation, one-per-member,
// real-time completion (finish_at is set here, not trusted from the client), and atomic
// collect→bank (via the guild_estate_collect RPC).
//
// Actions (POST { action, ... }):
//   get                                                  -> { tasks:[...], now }
//   start  { slot, skill_id, output_key, batches, time_per_batch_ms }
//   collect { slot }                                     -> deposits output to the bank
//   cancel  { slot }                                     -> owner or officer/leader
//
// Verify JWT must be OFF (publishable key isn't a JWT; token validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const ESTATE_SKILLS = new Set(["stonecutting", "masonry", "paving"]);
const MIN_BATCH_MS = 3_000;        // floor per batch — no instant tasks
const MAX_BATCH_MS = 3_600_000;    // 1h per batch ceiling
const MAX_BATCHES = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  const { data: me } = await admin.from("guild_members")
    .select("guild_id, rank").eq("user_id", user.id).maybeSingle();
  if (!me) return json({ ok: false, error: "You're not in a guild." }, 403);
  const guildId = me.guild_id as string;
  const isOfficer = me.rank === "officer" || me.rank === "leader";

  async function snapshot() {
    const { data: tasks } = await admin.from("guild_estate_tasks")
      .select("slot, user_id, username, skill_id, output_key, output_qty, batches, started_at, finish_at")
      .eq("guild_id", guildId).order("slot", { ascending: true });
    return { tasks: tasks || [], now: new Date().toISOString() };
  }

  if (action === "get") {
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "start") {
    const slot = Number(body.slot);
    const skillId = String(body.skill_id || "");
    const outputKey = String(body.output_key || "");
    const batches = Number(body.batches);
    let perMs = Number(body.time_per_batch_ms);
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) return json({ ok: false, error: "Invalid slot." }, 400);
    if (!ESTATE_SKILLS.has(skillId)) return json({ ok: false, error: "Not an estate skill." }, 400);
    if (!KEY_RE.test(outputKey)) return json({ ok: false, error: "Invalid recipe." }, 400);
    if (!Number.isInteger(batches) || batches < 1 || batches > MAX_BATCHES) return json({ ok: false, error: "Batches must be 1–" + MAX_BATCHES + "." }, 400);
    if (!Number.isFinite(perMs)) return json({ ok: false, error: "Invalid duration." }, 400);
    perMs = Math.min(MAX_BATCH_MS, Math.max(MIN_BATCH_MS, Math.round(perMs))); // server owns timing

    // Friendly pre-checks (the UNIQUE constraints are the real backstop).
    const { data: existing } = await admin.from("guild_estate_tasks")
      .select("slot, user_id").eq("guild_id", guildId);
    if ((existing || []).some((t) => t.user_id === user.id)) return json({ ok: false, error: "You already have an active estate task." }, 409);
    if ((existing || []).some((t) => t.slot === slot)) return json({ ok: false, error: "That slot is taken." }, 409);

    const finishAt = new Date(Date.now() + perMs * batches).toISOString();
    const { error } = await admin.from("guild_estate_tasks").insert({
      guild_id: guildId, slot, user_id: user.id, username,
      skill_id: skillId, output_key: outputKey, output_qty: batches, batches, finish_at: finishAt,
    });
    if (error) {
      const m = String(error.message || "").toLowerCase();
      if (m.includes("guild_id") && m.includes("user_id")) return json({ ok: false, error: "You already have an active estate task." }, 409);
      if (m.includes("slot")) return json({ ok: false, error: "That slot is taken." }, 409);
      return json({ ok: false, error: "Could not start task." }, 500);
    }
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "collect") {
    const slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) return json({ ok: false, error: "Invalid slot." }, 400);
    const { data: r, error } = await admin.rpc("guild_estate_collect", { p_guild: guildId, p_slot: slot });
    if (error) return json({ ok: false, error: "Collect failed." }, 500);
    const res = r as { status?: string; owner?: string; skill?: string; output_key?: string; qty?: number; batches?: number };
    if (res?.status === "empty") return json({ ok: false, error: "That slot is empty." }, 404);
    if (res?.status === "notready") return json({ ok: false, error: "That task isn't finished yet." }, 409);
    if (res?.status === "bankfull") return json({ ok: false, error: "The guild bank is full — free a slot before collecting." }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Collect rejected." }, 400);
    return json({
      ok: true,
      collected: { owner: res.owner, skill: res.skill, output_key: res.output_key, qty: res.qty, batches: res.batches },
      ...(await snapshot()),
    });
  }

  if (action === "cancel") {
    const slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) return json({ ok: false, error: "Invalid slot." }, 400);
    const { data: task } = await admin.from("guild_estate_tasks")
      .select("id, user_id").eq("guild_id", guildId).eq("slot", slot).maybeSingle();
    if (!task) return json({ ok: false, error: "That slot is empty." }, 404);
    if (task.user_id !== user.id && !isOfficer) return json({ ok: false, error: "Only the task owner or an officer can cancel it." }, 403);
    await admin.from("guild_estate_tasks").delete().eq("id", task.id);
    return json({ ok: true, ...(await snapshot()) });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
