// Fantasy Frontiers — server-validated leaderboard submission.
// The client can no longer write public.profiles directly (see the RLS migration). It
// calls this function with its computed { total_level, gold, skills }. The function:
//   1. Verifies the caller's auth token and derives id + username from it (no spoofing).
//   2. Runs STRUCTURAL checks: each skill level 1..100, total_level == sum(skills),
//      skill count in bounds, gold within an absolute cap.
//   3. Runs RATE checks via a TOKEN BUCKET on total_level (the ranking metric): the stored value is
//      CLAMPED to what's earnable at the sustained rate since the last write (burst carried, not re-granted
//      per call), so rapid repeat submissions can't ratchet the leaderboard up -- and a legit big/offline
//      gain is trimmed, never rejected, then catches up over subsequent writes.
//   4. Upserts the row with the service role (bypasses RLS) if the structural checks pass.
// Progress is still computed client-side, so this stops impossible values / impossible
// speed — not a determined cheater who stays within plausible rates. Full authority
// would require simulating the game server-side.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Tunable limits (safe, generous defaults) ----
const MAX_SKILL_LEVEL = 100;      // getLevel caps at content tier 100
const MIN_SKILL_LEVEL = 1;        // getLevel() returns >= 1
const MAX_SKILLS = 400;           // main skills + proficiencies + classes + physiques + attunements. The
                                 // submitted set is ~172 today and grows every time a class/skill is
                                 // added (e.g. Samurai) -- was 160, which the set had OUTGROWN, so EVERY
                                 // submission 400'd ("Too many skills") and the whole leaderboard stopped
                                 // updating. 400 leaves generous headroom while still bounding abuse.
const GOLD_ABS_CAP = 1_000_000_000_000; // 1e12 sanity ceiling

// Rate limits. The ranking metric (total_level) is bounded by a proper TOKEN BUCKET keyed off the
// stored row's clock, NOT a flat "BURST + rate*hours". The old flat form reset `hours` to ~0 right after
// every accepted write, so it handed out the full BURST on EVERY call -- firing N rapid submissions banked
// BURST*N levels in seconds (the reported "inject XP onto the leaderboard", which also unlocked the gold
// gate that reads profiles.total_level). The bucket accrues at LEVELS_PER_HOUR up to BURST_LEVELS and
// CARRIES between writes; rapid resubmits drain it and then get ~0 until real time passes.
const LEVELS_PER_HOUR = 200;      // total-level gain/hour (ranking metric — the strict one)
const BURST_LEVELS = 400;         // bucket size: max levels bankable in one burst (also caps a first-sync grandfather)
const LEVEL_FILL_MS = Math.floor((BURST_LEVELS / LEVELS_PER_HOUR) * 3_600_000); // time to refill the burst (2h); floors the clock so unused allowance can't exceed BURST
const GOLD_PER_HOUR = 20_000_000; // loose; profiles.gold is a secondary DISPLAY column (player_wallet is authoritative)
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
    .select("*").eq("id", userId).maybeSingle(); // "*" so reading prev.mastery never fails if that column isn't migrated yet

  const nowMs = Date.now();
  const prevTotal = prev?.total_level ?? 0;
  const prevGold = prev?.gold ?? 0;

  // Over-100 Mastery: a DISPLAY-ONLY { skill_id: extended_level } map for gathering/crafting skills past
  // 100 (kept out of skills/total_level, which stay capped at 100 for ranking). Cleaned here -- valid keys,
  // integer 101..MAX, capped count -- BEFORE the rate section so its over-100 "extra" levels can be metered
  // through the SAME token bucket. It used to be stored verbatim with NO rate limit, so a cheater could
  // flash e.g. fishing 114 instantly (reported). Only touched when the body carries the field.
  const MASTERY_MAX_LEVEL = 200, MASTERY_MAX_KEYS = 200;
  const masteryProvided = Object.prototype.hasOwnProperty.call(body, "mastery");
  let mastery: Record<string, number> | null = null;
  const mRaw = (body as { mastery?: unknown }).mastery;
  if (mRaw && typeof mRaw === "object" && !Array.isArray(mRaw)) {
    const clean: Record<string, number> = {}; let n = 0;
    for (const [k, v] of Object.entries(mRaw as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length > 40) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= MAX_SKILL_LEVEL || v > MASTERY_MAX_LEVEL) continue;
      clean[k] = v;
      if (++n >= MASTERY_MAX_KEYS) break;
    }
    mastery = Object.keys(clean).length ? clean : null;
  }
  // Sum of over-100 "extra" levels claimed (each entry 101..200, so v-100 is the grind past the cap).
  const masteryExtraOf = (m: Record<string, number> | null | undefined) =>
    m ? Object.values(m).reduce((s, v) => s + Math.max(0, Number(v) - MAX_SKILL_LEVEL), 0) : 0;
  const prevMasteryExtra = masteryExtraOf(prev?.mastery as Record<string, number> | null | undefined);
  const newMasteryExtra = masteryExtraOf(mastery);

  // Token bucket for the ranking metric. The clock is the stored row's updated_at, or -- on the FIRST
  // submission (no prior row) -- the account's auth creation time, exactly like the gold clamp below and
  // the item-ledger/wallet age grandfathering. Using account age (not a flat fill-window back-date) is the
  // fix for the reported injection: the old code handed EVERY brand-new account a full BURST_LEVELS (400)
  // grandfather, so a seconds-old account could inject ~400 levels in one shot (test3 jumped digging 1->97
  // + forestry 1->81 = ~178, well under 400). Age-keyed, a fresh account's allowance is ~0 and its real
  // progress catches up at LEVELS_PER_HOUR; a genuinely old account syncing for the first time still gets
  // the full BURST (levelAllow caps there regardless of how far back created_at is).
  // Allowance = time since the clock at LEVELS_PER_HOUR, capped at BURST_LEVELS and carried between writes.
  // We CLAMP (accept, trim to the allowance) rather than reject, so a legit big/offline gain is never
  // blocked -- it catches up over the next writes -- while a cheater is bounded to the sustained rate.
  const clockBase = prev?.updated_at ? new Date(prev.updated_at).getTime() : new Date(user.created_at).getTime();
  // Floor the clock at now-FILL so a deep-past base (old account's first sync, or a drifted clock) can bank
  // at most BURST -- never an unbounded, repeatable grandfather.
  const bucketFromMs = Math.max(clockBase, nowMs - LEVEL_FILL_MS);
  const levelAllow = Math.min(BURST_LEVELS, Math.floor(LEVELS_PER_HOUR * Math.max(0, nowMs - bucketFromMs) / 3_600_000));
  const allowedTotal = totalLevel <= prevTotal ? totalLevel : Math.min(totalLevel, prevTotal + levelAllow); // decreases (resets) always allowed
  const baseConsumed = Math.max(0, allowedTotal - prevTotal);
  // Over-100 mastery shares the SAME bucket, base levels first. Publish the new mastery map only if its
  // growth since the last accepted map fits the leftover allowance; otherwise hold the last accepted map --
  // so a fresh/cheating account whose bucket is empty (or spent on base) can't flash fake mastery (fishing
  // 114). Whole-map hold (not a partial trim) keeps it simple; a legit grind catches up as the bucket refills.
  const masteryRemaining = Math.max(0, levelAllow - baseConsumed);
  const masteryGrow = Math.max(0, newMasteryExtra - prevMasteryExtra);
  const masteryOk = newMasteryExtra <= prevMasteryExtra || masteryGrow <= masteryRemaining;
  const storedMastery = masteryOk ? mastery : ((prev?.mastery as Record<string, number> | null) ?? null);
  const consumedLevels = baseConsumed + (masteryOk ? masteryGrow : 0);
  // Advance the bucket clock ONLY by what was consumed (so unused allowance persists; a burst of writes
  // drains it). No consumption -> keep the clock so allowance keeps accruing across idle no-op submits.
  const nextClockMs = consumedLevels > 0
    ? Math.min(nowMs, bucketFromMs + Math.floor((consumedLevels / LEVELS_PER_HOUR) * 3_600_000))
    : bucketFromMs;
  // A too-fast jump (submitted > allowance). When this happens we clamp total_level to the allowance AND
  // refuse to publish the submitted per-skill map -- otherwise the inflated skills (e.g. digging 97) would
  // still display on the profile even though the ranking total is clamped. On a clamp we keep the last
  // accepted skills (or {} for a first submission), so a burst can't flash fake per-skill levels.
  const clamped = allowedTotal < totalLevel;
  const storedSkills = clamped ? (prev?.skills ?? {}) : skills;
  if (totalLevel - allowedTotal > 100) {
    console.warn(`submit_profile level clamp: user=${userId} submitted=${totalLevel} prev=${prevTotal} stored=${allowedTotal}`);
  }

  // profiles.gold is a DISPLAY column (player_wallet is the authority), so clamp it the same way with a
  // loose flat allowance -- never reject the whole submission over a gold jump, but don't let a spoof
  // flex the leaderboard's gold number arbitrarily either.
  const goldHours = Math.max(0, (nowMs - (prev?.updated_at ? new Date(prev.updated_at).getTime() : new Date(user.created_at).getTime())) / 3_600_000);
  const allowedGold = gold <= prevGold ? gold : Math.min(gold, prevGold + BURST_GOLD + Math.floor(GOLD_PER_HOUR * goldHours));

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

  // Currently-equipped Class id (for the leaderboard's class icon). Cosmetic + client-authoritative;
  // stored as a bounded slug or null. The client maps it to an icon (unknown/null -> neutral figure).
  // Pattern allows camelCase: class ids like 'treasureHunter' are legitimate (the old lowercase-only
  // pattern silently nulled them, hiding those players' class icons). The client selftest asserts
  // every CLASS_DEFS id matches this exact pattern so the two can't drift apart again.
  const clsRaw = (body as { class?: unknown }).class;
  const cls = (typeof clsRaw === "string" && /^[a-z][a-zA-Z0-9_]{0,23}$/.test(clsRaw)) ? clsRaw : null;

  // Optional public estate snapshot (render-only) so others can view it read-only from the
  // leaderboard. Cosmetic + client-authoritative; never reject the submission over it. Bounded by a
  // size cap + a basic shape check so a client can't bloat the row. Stored verbatim (the viewer only
  // reads grid geometry + placements) or null. Only touched when the body actually carries the field,
  // so an older client that doesn't send `estate` never clobbers a previously-published one.
  const ESTATE_MAX_BYTES = 80_000;
  const estateProvided = Object.prototype.hasOwnProperty.call(body, "estate");
  const estRaw = (body as { estate?: unknown }).estate;
  let estate: unknown = null;
  if (estRaw && typeof estRaw === "object" && !Array.isArray(estRaw) && Array.isArray((estRaw as Record<string, unknown>).grid)) {
    try { if (JSON.stringify(estRaw).length <= ESTATE_MAX_BYTES) estate = estRaw; } catch { estate = null; }
  }

  // 4. Accept.
  const record: Record<string, unknown> = {
    id: userId,
    username,
    total_level: allowedTotal,   // clamped to the bucket allowance (ranking metric)
    gold: allowedGold,           // clamped display gold
    skills: storedSkills,        // submitted map only when within allowance; otherwise the last accepted (no fake per-skill flash)
    equipment,
    stats,
    mortal,
    class: cls,
    updated_at: new Date(nextClockMs).toISOString(), // bucket clock (advances only by consumed levels)
  };
  if (estateProvided) record.estate = estate;   // omit entirely -> upsert leaves any existing estate untouched
  if (masteryProvided) record.mastery = storedMastery; // bucket-metered map (held at last accepted when over-rate); absent field never clobbers
  let { error: upErr } = await admin.from("profiles").upsert(record, { onConflict: "id" });
  if (upErr && (estateProvided || masteryProvided)) {
    // The `estate`/`mastery` columns may not be migrated yet -- retry WITHOUT them so a new client never
    // loses its leaderboard update just because those migrations haven't been applied. (Deploy-order safety.)
    delete record.estate; delete record.mastery;
    ({ error: upErr } = await admin.from("profiles").upsert(record, { onConflict: "id" }));
  }
  if (upErr) return json({ ok: false, error: "Could not save profile." }, 500);

  return json({ ok: true });
});
