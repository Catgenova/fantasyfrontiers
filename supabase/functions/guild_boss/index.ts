// Fantasy Frontiers — Guild Bosses (tower-style, solo entry, daily reset).
//
// 5 fixed bosses per guild (indices 0..4) at rising Tower-floor difficulties. Each is entered
// like a Tower fight and resolved in the player's client (combat is client-authoritative, same
// as the Tower). The server owns the parts that must be shared/trusted:
//   * a member may ENTER at most one boss per UTC day (win or lose);
//   * the FIRST member to defeat a boss CLEARS it for the whole guild that day (nobody else can
//     enter it until the next UTC day);
//   * on a clear EVERY current guild member is credited barrier shards (reward = index+1 => 1..5),
//     banked as a pending balance each claims on next sync (offline members get theirs on return).
// Everything is keyed by UTC day, so the roster resets implicitly each day (no cron).
//
// Actions (POST { action, ... }):
//   get                  -> { bosses:[{idx,cleared,cleared_by}], my_entry_boss, pending, day }
//   enter { boss_idx }   -> reserve today's single entry on a boss
//   clear { boss_idx }   -> report a defeat; first writer clears it + credits members
//   claim                -> drain the caller's pending shard balance ({ granted })
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

// Barrier-shard reward per boss index (0..4): 1,2,3,4,5. Derived server-side — never trusted from the client.
const BOSS_REWARDS = [1, 2, 3, 4, 5];
const BOSS_COUNT = BOSS_REWARDS.length;
// The UTC calendar day, so the roster resets at 00:00 UTC for every guild regardless of DB timezone.
function utcDay(): string { return new Date().toISOString().slice(0, 10); }
function validIdx(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < BOSS_COUNT ? n : null;
}

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
  // Volume rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down.
  try { const { data: _over } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "guild_boss", p_limit: 120, p_window_secs: 60 }); if (_over === true) return json({ ok: false, error: "Too many requests." }, 429); } catch { /* limiter unavailable -> allow */ }
  // Clamp gate: an account quarantined from the guild surface is refused (see migration 20260724210000).
  // Fail-open like the rate limiter -- a check that is DOWN must never lock a legit player out.
  try { const { data: _cl } = await admin.rpc("is_clamped", { p_user: user.id, p_surface: "guild" }); if (_cl === true) return json({ ok: false, clamped: true, error: "This account is restricted from guild features." }); } catch { /* clamp check unavailable -> allow */ }
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  const { data: me } = await admin.from("guild_members").select("guild_id").eq("user_id", user.id).maybeSingle();
  if (!me) return json({ ok: false, error: "You're not in a guild." }, 403);
  const guildId = me.guild_id as string;
  const day = utcDay();

  async function pendingFor(): Promise<number> {
    const { data } = await admin.from("guild_boss_pending").select("shards").eq("user_id", user.id).maybeSingle();
    const n = Number(data?.shards); return Number.isFinite(n) && n > 0 ? n : 0;
  }
  async function snapshot() {
    const { data: clears } = await admin.from("guild_boss_clears")
      .select("boss_idx, cleared_by_username").eq("guild_id", guildId).eq("day", day);
    const byIdx = new Map<number, string>();
    for (const c of clears || []) byIdx.set(Number(c.boss_idx), String(c.cleared_by_username));
    const bosses = Array.from({ length: BOSS_COUNT }, (_, i) => ({
      idx: i, cleared: byIdx.has(i), cleared_by: byIdx.get(i) ?? null,
    }));
    const { data: entry } = await admin.from("guild_boss_entries")
      .select("boss_idx").eq("user_id", user.id).eq("day", day).maybeSingle();
    return { bosses, my_entry_boss: entry ? Number(entry.boss_idx) : null, pending: await pendingFor(), day };
  }

  if (action === "get") return json({ ok: true, ...(await snapshot()) });

  if (action === "enter") {
    const idx = validIdx(body.boss_idx);
    if (idx === null) return json({ ok: false, error: "Unknown boss." }, 400);
    const { data: r, error } = await admin.rpc("guild_boss_enter", { p_user: user.id, p_guild: guildId, p_day: day, p_boss: idx });
    if (error) return json({ ok: false, error: "Could not enter." }, 500);
    const status = (r as { status?: string })?.status;
    if (status === "cleared") return json({ ok: false, error: "Another member has already cleared that boss today.", ...(await snapshot()) }, 409);
    if (status === "used") return json({ ok: false, error: "You've already taken on a boss today. Come back tomorrow.", ...(await snapshot()) }, 409);
    if (status !== "ok") return json({ ok: false, error: "Could not enter." }, 500);
    return json({ ok: true, entered: idx, ...(await snapshot()) });
  }

  if (action === "clear") {
    const idx = validIdx(body.boss_idx);
    if (idx === null) return json({ ok: false, error: "Unknown boss." }, 400);
    const reward = BOSS_REWARDS[idx];
    const { data: r, error } = await admin.rpc("guild_boss_clear", {
      p_user: user.id, p_username: username, p_guild: guildId, p_day: day, p_boss: idx, p_reward: reward,
    });
    if (error) return json({ ok: false, error: "Could not record the clear." }, 500);
    const status = (r as { status?: string })?.status;
    if (status === "noentry") return json({ ok: false, error: "You didn't enter that boss today.", ...(await snapshot()) }, 403);
    if (status === "alreadycleared") return json({ ok: false, alreadycleared: true, error: "Another member cleared it first.", ...(await snapshot()) }, 409);
    if (status !== "ok") return json({ ok: false, error: "Could not record the clear." }, 500);
    return json({ ok: true, cleared: idx, reward, ...(await snapshot()) });
  }

  if (action === "claim") {
    const { data: r, error } = await admin.rpc("guild_boss_claim_pending", { p_user: user.id });
    if (error) return json({ ok: false, error: "Claim failed." }, 500);
    const granted = Number(r); 
    return json({ ok: true, granted: Number.isFinite(granted) && granted > 0 ? granted : 0, ...(await snapshot()) });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
