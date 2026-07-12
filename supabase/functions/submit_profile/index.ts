// Fantasy Frontiers — server-validated leaderboard submission.
// The client can no longer write public.profiles directly (see the RLS migration). It
// calls this function with its computed { total_level, gold, skills }. The function:
//   1. Verifies the caller's auth token and derives id + username from it (no spoofing).
//   2. Runs STRUCTURAL checks: each skill level 1..100, total_level == sum(skills),
//      skill count in bounds, gold within an absolute cap.
//   3. Runs RATE checks: the INCREASE since the last accepted submission can't exceed
//      what's earnable in that much real time; the first submission is anchored to the
//      account's age so a fresh account can't already be maxed.
//   4. Upserts the row with the service role (bypasses RLS) if everything passes.
// Progress is still computed client-side, so this stops impossible values / impossible
// speed — not a determined cheater who stays within plausible rates. Full authority
// would require simulating the game server-side.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Tunable limits (safe, generous defaults) ----
const MAX_SKILL_LEVEL = 100;      // getLevel caps at content tier 100
const MIN_SKILL_LEVEL = 1;        // getLevel() returns >= 1
const MAX_SKILLS = 160;           // main skills + proficiencies + classes + physiques + attunements (~100), with headroom
const GOLD_ABS_CAP = 1_000_000_000_000; // 1e12 sanity ceiling

// Rate limits. Allowed increase = BURST + PER_HOUR * hoursElapsed.
// Long gaps (incl. offline idle) grant proportionally larger allowances, so returning
// players are never falsely rejected; only implausibly fast jumps are blocked.
const LEVELS_PER_HOUR = 200;      // total-level gain/hour (ranking metric — the strict one)
const BURST_LEVELS = 400;
const GOLD_PER_HOUR = 20_000_000; // loose; gold is secondary display, not the rank key
const BURST_GOLD = 10_000_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1. Identity from the token (never from the body).
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  // 2. Parse + structural validation.
  let body: { total_level?: unknown; gold?: unknown; skills?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  const skills = body.skills;
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    return json({ ok: false, error: "Invalid skills." }, 400);
  }
  const entries = Object.entries(skills as Record<string, unknown>);
  if (entries.length > MAX_SKILLS) return json({ ok: false, error: "Too many skills." }, 400);

  let sum = 0;
  for (const [key, val] of entries) {
    if (typeof key !== "string" || key.length > 40) return json({ ok: false, error: "Invalid skill id." }, 400);
    if (typeof val !== "number" || !Number.isInteger(val) || val < MIN_SKILL_LEVEL || val > MAX_SKILL_LEVEL) {
      return json({ ok: false, error: "Skill level out of range." }, 400);
    }
    sum += val;
  }

  const totalLevel = body.total_level;
  if (typeof totalLevel !== "number" || !Number.isInteger(totalLevel) || totalLevel !== sum) {
    return json({ ok: false, error: "total_level must equal the sum of skill levels." }, 400);
  }

  const gold = body.gold;
  if (typeof gold !== "number" || !Number.isInteger(gold) || gold < 0 || gold > GOLD_ABS_CAP) {
    return json({ ok: false, error: "Gold out of range." }, 400);
  }

  // 3. Rate validation against the previous accepted row (or account age for the first).
  const { data: prev } = await admin.from("profiles")
    .select("total_level, gold, updated_at").eq("id", userId).maybeSingle();

  const nowMs = Date.now();
  const sinceMs = prev?.updated_at
    ? new Date(prev.updated_at).getTime()
    : new Date(user.created_at).getTime();
  const hours = Math.max(0, (nowMs - sinceMs) / 3_600_000);

  const prevTotal = prev?.total_level ?? 0;
  const prevGold = prev?.gold ?? 0;

  // Only increases are limited; decreases (e.g. after a reset) are always allowed.
  const levelGain = totalLevel - prevTotal;
  if (levelGain > BURST_LEVELS + LEVELS_PER_HOUR * hours) {
    return json({ ok: false, error: "Progress increased faster than possible." }, 422);
  }
  const goldGain = gold - prevGold;
  if (goldGain > BURST_GOLD + GOLD_PER_HOUR * hours) {
    return json({ ok: false, error: "Gold increased faster than possible." }, 422);
  }

  // Sanitize optional equipment (weapons/armor loadout for the profile view). Cosmetic, so
  // never reject the whole submission over it -- coerce to bounded strings or drop it.
  const cleanEquipList = (list: unknown) => {
    if (!Array.isArray(list)) return [];
    const out: { slot: string; name: string; rarity: string }[] = [];
    for (const it of list.slice(0, 16)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const name = String(o.name ?? "").slice(0, 60);
      if (!name) continue;
      out.push({ slot: String(o.slot ?? "").slice(0, 24), name, rarity: String(o.rarity ?? "normal").slice(0, 16) });
    }
    return out;
  };
  const eqRaw = (body as { equipment?: unknown }).equipment;
  const equipment = (eqRaw && typeof eqRaw === "object")
    ? { weapons: cleanEquipList((eqRaw as Record<string, unknown>).weapons), armor: cleanEquipList((eqRaw as Record<string, unknown>).armor) }
    : null;

  // Lifetime stats for the leaderboard filters. Bounded to non-negative integers; a known
  // key set only. Cosmetic + client-authoritative, so never reject the submission over it.
  const STAT_KEYS = ["kills", "deaths", "gathered", "crafted", "craftedRare", "craftedSupreme", "craftedFantastic", "combat_score", "hoursBuffed"];
  const STAT_CAP = 1_000_000_000_000;
  const cleanStats = (raw: unknown) => {
    const out: Record<string, number> = {};
    const o = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    for (const k of STAT_KEYS) {
      const v = o[k];
      out[k] = (typeof v === "number" && Number.isFinite(v) && v >= 0) ? Math.min(STAT_CAP, Math.floor(v)) : 0;
    }
    return out;
  };
  const stats = cleanStats((body as { stats?: unknown }).stats);

  // Mortal-path flag (leaderboard styling + guild segregation). Client-authoritative, like the rest
  // of the game's progress — a Mortal's death flips this to false when they republish as Immortal.
  const mortal = (body as { mortal?: unknown }).mortal === true;

  // 4. Accept.
  const { error: upErr } = await admin.from("profiles").upsert({
    id: userId,
    username,
    total_level: totalLevel,
    gold,
    skills,
    equipment,
    stats,
    mortal,
    updated_at: new Date(nowMs).toISOString(),
  }, { onConflict: "id" });
  if (upErr) return json({ ok: false, error: "Could not save profile." }, 500);

  return json({ ok: true });
});
