// Fantasy Frontiers — server-authoritative gold wallet (Stage 1).
//
// Endpoints (all POST, identity from the auth token, never the body):
//   { action:"get" }                      -> { ok, gold }   (seeds from the player's save on first touch)
//   { action:"earn", earned_total:number} -> { ok, gold, credited }   rate-limited credit of new earnings
//   { action:"earn_chest", count, gold }  -> { ok, gold, credited }   FULL credit (no rate limit), gated
//                                            by an item_debit of `count` treasure_chest -- treasure-chest
//                                            gold is exempt from the bucket/clamp but bounded by real chests
//   { action:"spend", amount:number }     -> { ok, gold }   debits if the balance covers it, else ok:false
//
// EARNING is client-reported (the server can't simulate combat/gathering) but RATE-LIMITED: the credit
// per call is capped by real time elapsed, the same way submit_profile caps leaderboard gains, so a
// spoofed "earned_total" only ever banks at the honest rate. That rate is gated on the account's
// server-VALIDATED progression (profiles.total_level) and age (dailyAllowanceFor), so the "fetch the
// wallet sync, bump gold+earned_total, re-send" injection only ever banks what your legitimately-earned
// level already permits -- a fresh/bot account is pinned to the early-game floor. Spoof-shaped requests
// are logged to wallet_audit (migration 20260716010000). SPENDING is hard-enforced against the server
// balance (wallet_debit fails when the gold isn't there). Existing balances are grandfathered from the
// player's current save the first time the wallet is touched.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Rate limits (token bucket). The bucket holds ONE DAY's allowance and refills continuously over 24h;
// unused allowance CARRIES between claims up to the full bucket (see bucketState). A scripted earn loop
// can't beat the sustained time-based rate, but a single legit burst up to a full day's allowance
// credits at once -- so opening a chest stack or banking a long offline haul isn't throttled away. A
// freshly-seeded wallet starts with a FULL bucket (see ensureWallet).
const HARD_CAP = 1_000_000_000_000_000; // 1e15, keeps totals safe JS integers
const BUCKET_FILL_MS = 86_400_000;      // the bucket is one day's allowance, refilling over 24h

// The daily earn allowance is gated on TWO server-trusted anchors, whichever is LOWER:
//
//  (1) PROGRESSION -- profiles.total_level, which submit_profile independently validates and rate-limits
//      to LEVELS_PER_HOUR=200. Earning is client-reported, so the wallet can't tell a real earn from a
//      fabricated `earned_total` bump (the reported-fetch-inject exploit). But it CAN cap how much you're
//      allowed to bank against how far you've LEGITIMATELY progressed: near-nothing at the early-game
//      floor, rising to the full endgame rate only once you've grinded ~thousands of levels (which takes
//      real, rate-limited time). A day-zero bot at total_level ~170 is stuck at the floor.
//  (2) ACCOUNT AGE -- created_at, a belt-and-suspenders cap so a not-yet-caught high level on a
//      brand-new account still can't unlock the full rate: 10M/day at <=1 day -> 500M/day at >=7 days.
//
// perDay = min(level-allowance, age-allowance). Legit players earn a tiny fraction of the floor, so the
// gate is invisible to them; it only bites accounts trying to bank far more gold than their (validated)
// progression could plausibly have produced. FF_RATE_RAMP_OFF=1 (staging secret) pins the full rate.
const RAMP_DAY1_GOLD = 10_000_000;    // age cap at account age <= 1 day
const RAMP_DAY7_GOLD = 500_000_000;   // age cap at account age >= 7 days  (also the absolute per-day ceiling)
const RAMP_START_DAYS = 1, RAMP_END_DAYS = 7;
const LVL_FLOOR_GOLD = 250_000;       // daily allowance at/below the early-game level floor
const LVL_FULL_GOLD = 500_000_000;    // daily allowance at/above the endgame total_level
const LVL_LO = 500, LVL_HI = 8000;    // total_level band the allowance ramps across
const RAMP_OFF = Deno.env.get("FF_RATE_RAMP_OFF") === "1";
// RAMP_OFF lifts the earn throttle only for accounts AT LEAST this old. A younger account keeps the
// normal age+level gate even with the flag on -- so gold injection (spoofing goldEarnedTotal through
// save_game, which the wallet credits under this throttle) on a fresh account can NEVER bank at the full
// rate, even if FF_RATE_RAMP_OFF is mistakenly set in production. The flag is meant to stop throttling
// established real players, not to disable fraud protection on brand-new ones.
const RAMP_OFF_MATURE_DAYS = 14;
function accountAgeDays(createdAtIso: string | undefined): number {
  return createdAtIso ? Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000) : 0;
}
function ageAllowance(createdAtIso: string | undefined): number {
  if (!createdAtIso) return RAMP_DAY1_GOLD;
  const days = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  const t = Math.min(1, Math.max(0, (days - RAMP_START_DAYS) / (RAMP_END_DAYS - RAMP_START_DAYS)));
  return Math.floor(RAMP_DAY1_GOLD + (RAMP_DAY7_GOLD - RAMP_DAY1_GOLD) * t);
}
function levelAllowance(totalLevel: number): number {
  const t = Math.min(1, Math.max(0, (totalLevel - LVL_LO) / (LVL_HI - LVL_LO)));
  return Math.floor(LVL_FLOOR_GOLD + (LVL_FULL_GOLD - LVL_FLOOR_GOLD) * t);
}
function dailyAllowanceFor(createdAtIso: string | undefined, totalLevel: number): number {
  const gated = Math.min(ageAllowance(createdAtIso), levelAllowance(totalLevel));
  if (!RAMP_OFF) return gated;
  // Flag ON: full rate for established accounts, but a young account stays gated (see RAMP_OFF_MATURE_DAYS).
  return accountAgeDays(createdAtIso) >= RAMP_OFF_MATURE_DAYS ? RAMP_DAY7_GOLD : gated;
}
// HARD CLAMP on the earn path: no account younger than HARD_CLAMP_MAX_AGE_DAYS can legitimately have
// received HARD_CLAMP_EARNED gold in its lifetime (that's the full-rate allowance for a WHOLE WEEK). A
// young account reporting an earned_total at/above this line is injecting goldEarnedTotal -> clamp,
// unconditionally and regardless of FF_RATE_RAMP_OFF. Flat threshold (not age-scaled) so it bites the
// entire pre-7-day window, not just day zero.
const HARD_CLAMP_MAX_AGE_DAYS = 7;
const HARD_CLAMP_EARNED = 500_000_000; // 500M lifetime earned on a <7-day account == injection

// Blast-radius ceiling on the lifetime-earned receipt we will CREDIT against. A sub-7-day account cannot
// legitimately have earned HARD_CLAMP_EARNED (500M) -- the same ~1000x-margin line the injection clamp
// uses -- so the reported goldEarnedTotal is capped there before it becomes a credit delta. Belt to the
// token bucket's suspenders: even if a stuck/spoofed/bug-inflated receipt slips through, the amount it can
// bank is bounded, so gold can't be refilled toward an absurd number (the runaway loop). Detection still
// runs on the RAW report (an injector's real 5B is still flagged). Established accounts (>=7 days) are
// unbounded (HARD_CAP), and a legit young player never reaches 500M, so this only ever trims cheat/bug values.
function earnedCeiling(createdAtIso: string | undefined): number {
  return accountAgeDays(createdAtIso) < HARD_CLAMP_MAX_AGE_DAYS ? HARD_CLAMP_EARNED : HARD_CAP;
}

// Proper token bucket keyed off `updated_at`: allowance = time since updated_at at the (age-scaled)
// daily rate, capped at a full day's allowance and CARRIED between claims (unused allowance persists).
// `bucketState` reports the available allowance and the effective start; `bucketAdvance` moves the
// clock forward only by what was actually consumed. This fixes the old bug where a legit earn right
// after a credit/seed was throttled to ~0 and the sync-clamp then wiped the balance.
function bucketState(updatedAtIso: string, perDay: number): { available: number; from: number } {
  const now = Date.now();
  const from = Math.max(new Date(updatedAtIso).getTime(), now - BUCKET_FILL_MS); // cap the backlog at a full bucket
  const available = Math.min(perDay, Math.floor((perDay * (now - from)) / 86_400_000));
  return { available, from };
}
function bucketAdvance(from: number, consumed: number, perDay: number): string {
  if (consumed <= 0) return new Date(from).toISOString();
  return new Date(Math.min(Date.now(), from + Math.floor((consumed / perDay) * 86_400_000))).toISOString();
}

// Audit thresholds: rows land in wallet_audit (service-role-only table) when a request looks like a
// spoof rather than normal throttled play, so probing is visible instead of silently clamped.
const AUDIT_HUGE_DELTA = 1_000_000_000;   // one request claiming >1B new earnings
const AUDIT_GOLD_ABS = 1_000_000;         // sync-clamp trip: reported gold exceeds server by >1M AND >2x

// ---- One-time SEED grandfather cap + gold-injection clamp (account clamps; migrations 210000/220000) ----
// The first wallet touch seeds from saves.data.gold. Un-bounded, that let a BRAND-NEW/tampered account seed
// a spoofed balance (edit data.gold=1e9, save, first wallet call -> 1e9 real gold). Bound the seed by
// account age at the same daily rate the earn path uses -- mirrors the item-ledger grandfather cap
// (20260715020000). A fresh account seeds ~0; a genuinely-old dormant account still gets its legit balance.
// Gold beyond the cap is the injection signature -> record a clamp_signal + clamp (LIVE: the seed cap makes
// the over-cap amount unambiguous). Reuses clamp_signals / account_clamps (no migration).
const SEED_BURST_GOLD = 100_000;          // small floor so legit starter/early gold at first touch isn't zeroed
const GOLD_INJECT_MIN_OVER = 10_000_000;  // seed exceeding the age cap by >=1e7 is an injection, not rounding
const GOLD_INJECT_CLAMP_MAX_AGE_DAYS = 14; // only CLAMP a young account; an old dormant one (legit pre-wallet
                                          // balance predating the rate limit) is capped but never punished
const GOLD_CLAMP_ENFORCE = true;          // live enforcement (this signal is clean, like item_inject)
const CLAMP_INDEFINITE_MS = 5_256_000 * 60_000; // ~10 years, matches the clamp RPC's cap
// Ramp-INDEPENDENT absolute ceiling on a YOUNG account's first-touch seed. No account younger than
// GOLD_INJECT_CLAMP_MAX_AGE_DAYS can legitimately hold this much gold, so this cap + the injection
// clamp must hold EVEN when FF_RATE_RAMP_OFF is set. RAMP_OFF is only meant to relax the legit EARN
// throttle for real players -- it must NEVER disable fraud detection on brand-new accounts (that hole
// let a billion-gold seed sail through with no cap and no clamp). Generous enough to cover any
// plausible first-fortnight legit gold.
const YOUNG_SEED_ABS_CAP = 25_000_000;
// Age-bounded ceiling on the one-time seed: max(burst, plausible earnings over the account's whole life).
// Under RAMP_OFF this relaxes to HARD_CAP for OLD accounts (legit big dormant balances), but young
// accounts are still pinned by YOUNG_SEED_ABS_CAP at the call site regardless of the ramp.
function seedCapFor(createdAtIso: string | undefined, totalLevel: number): number {
  if (RAMP_OFF) return HARD_CAP;          // staging: seeding unbounded for OLD accounts, like the earn ramp
  const days = createdAtIso ? Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000) : 0;
  return Math.min(HARD_CAP, Math.max(SEED_BURST_GOLD, Math.floor(dailyAllowanceFor(createdAtIso, totalLevel) * days)));
}

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

  // Identity from the token.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;
  // Volume rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down.
  try { const { data: _over } = await admin.rpc("rl_hit", { p_subject: userId, p_bucket: "wallet", p_limit: 300, p_window_secs: 60 }); if (_over === true) return json({ ok: false, error: "Too many requests." }, 429); } catch { /* limiter unavailable -> allow */ }
  // Server-validated progression anchor (0 if the player hasn't submitted a leaderboard profile yet ->
  // treated as the early-game floor). Only submit_profile can write this, and it rate-limits growth.
  const { data: prof } = await admin.from("profiles").select("total_level").eq("id", userId).maybeSingle();
  const totalLevel = Number(prof?.total_level ?? 0);
  const perDay = dailyAllowanceFor(user.created_at, totalLevel);

  // Best-effort audit trail for spoof-shaped requests (never blocks the response path).
  async function audit(note: string, extra: Record<string, unknown>): Promise<void> {
    try { await admin.from("wallet_audit").insert({ user_id: userId, note, ...extra }); } catch { /* table missing / transient -- don't fail the request */ }
  }

  // Gold-injection HARD CLAMP on the earn/sync path. The throttle bounds what a spoofed goldEarnedTotal
  // can BANK, but a young account (< HARD_CLAMP_MAX_AGE_DAYS) reporting a lifetime earned_total at/above
  // HARD_CLAMP_EARNED (500M) is unambiguously injecting -> clamp all shared surfaces (Discord fires on the
  // clamp) + signal, rate-limited ~1/hr, regardless of FF_RATE_RAMP_OFF. Flat, well past any legit
  // sub-week total, so it can't false-positive a real player. Best-effort; never blocks the credit.
  async function flagEarnInjection(reportedEarned: number): Promise<void> {
    try {
      if (accountAgeDays(user.created_at) >= HARD_CLAMP_MAX_AGE_DAYS) return;
      if (!Number.isFinite(reportedEarned) || reportedEarned < HARD_CLAMP_EARNED) return;
      await audit("gold_inject_earn", { reported_earned: Math.floor(reportedEarned), ceiling: HARD_CLAMP_EARNED });
      const detail = { kind: "gold_inject", via: "earn", reported_earned: Math.floor(reportedEarned), ceiling: HARD_CLAMP_EARNED };
      const { data: recent } = await admin.from("clamp_signals").select("id")
        .eq("user_id", userId).eq("kind", "gold_inject")
        .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
      if (recent && recent.length) return;
      console.warn(`clamp signal gold_inject(earn): user=${userId} reported=${Math.floor(reportedEarned)} ceiling=${HARD_CLAMP_EARNED}`);
      await admin.from("clamp_signals").insert({ user_id: userId, kind: "gold_inject", detail, would_clamp: true });
      if (GOLD_CLAMP_ENFORCE) {
        await admin.from("account_clamps").upsert({
          user_id: userId, surfaces: ["marketplace", "leaderboard", "guild", "chat"],
          clamped_until: new Date(Date.now() + CLAMP_INDEFINITE_MS).toISOString(),
          auto: true, signal: detail, clamped_by: null,
        }, { onConflict: "user_id" });
      }
    } catch { /* detection is best-effort -- never block the credit path */ }
  }

  let body: { action?: unknown; earned_total?: unknown; amount?: unknown; count?: unknown; gold?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "get");

  // Ensure the wallet row exists, grandfathering the player's current save gold the first time.
  async function ensureWallet(): Promise<{ gold: number; earned_total: number; updated_at: string }> {
    const { data: row } = await admin.from("player_wallet")
      .select("gold, earned_total, updated_at, seeded").eq("user_id", userId).maybeSingle();
    if (row) return { gold: Number(row.gold), earned_total: Number(row.earned_total), updated_at: row.updated_at };
    // No row yet -> read the player's save gold and seed once, AGE-BOUNDED so a fresh/tampered account
    // can't grandfather a spoofed balance (the reported "1B gold on a brand-new account" hole).
    const { data: save } = await admin.from("saves").select("data").eq("user_id", userId).maybeSingle();
    let seedGold = 0;
    const g = (save?.data as Record<string, unknown> | undefined)?.gold;
    if (typeof g === "number" && Number.isFinite(g) && g > 0) seedGold = Math.floor(g);
    // A young account (< GOLD_INJECT_CLAMP_MAX_AGE_DAYS) is pinned by the ramp-INDEPENDENT absolute cap so
    // fraud detection survives FF_RATE_RAMP_OFF; an older account uses the (ramp-aware) age-bounded cap.
    const accountDays = user.created_at ? Math.max(0, (Date.now() - new Date(user.created_at).getTime()) / 86_400_000) : 0;
    const young = accountDays < GOLD_INJECT_CLAMP_MAX_AGE_DAYS;
    const seedCap = young ? Math.min(seedCapFor(user.created_at, totalLevel), YOUNG_SEED_ABS_CAP)
                          : seedCapFor(user.created_at, totalLevel);
    const cappedSeed = Math.min(seedGold, seedCap, HARD_CAP);
    // Injection is measured against the young absolute cap (ramp-independent) so RAMP_OFF can't zero `over`
    // and silence the clamp -- the previous hole. Only young accounts are clamped; an OLD dormant account
    // carrying a legit pre-wallet balance is capped by seedCapFor but never punished.
    const over = young ? seedGold - Math.min(seedGold, YOUNG_SEED_ABS_CAP) : 0;
    if (over >= GOLD_INJECT_MIN_OVER) {
      // The save claims far more gold than this young account's age could plausibly hold -> injection.
      // Best-effort clamp (Discord fires on the clamp) + audit; the seed itself is already trimmed regardless.
      try {
        await audit("gold_inject_seed", { seed_gold: seedGold, seed_cap: seedCap, over });
        const detail = { kind: "gold_inject", seed_gold: seedGold, seed_cap: seedCap, over };
        const { data: recent } = await admin.from("clamp_signals").select("id")
          .eq("user_id", userId).eq("kind", "gold_inject")
          .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
        if (!recent || !recent.length) {
          console.warn(`clamp signal gold_inject: user=${userId} seed=${seedGold} cap=${seedCap}`);
          await admin.from("clamp_signals").insert({ user_id: userId, kind: "gold_inject", detail, would_clamp: true });
          if (GOLD_CLAMP_ENFORCE) {
            await admin.from("account_clamps").upsert({
              user_id: userId, surfaces: ["marketplace", "leaderboard", "guild", "chat"],
              clamped_until: new Date(Date.now() + CLAMP_INDEFINITE_MS).toISOString(),
              auto: true, signal: detail, clamped_by: null,
            }, { onConflict: "user_id" });
          }
        }
      } catch { /* detection is best-effort -- never block seeding */ }
    }
    const { data: seeded } = await admin.rpc("wallet_seed", { p_user: userId, p_gold: cappedSeed });
    // Start the bucket FULL: back-date updated_at by the fill window so the first legit earn after
    // seeding isn't throttled to ~0 (which, on a 0-gold seed, wiped freshly-earned gold to 0).
    const backdated = new Date(Date.now() - BUCKET_FILL_MS).toISOString();
    await admin.from("player_wallet").update({ updated_at: backdated }).eq("user_id", userId);
    return { gold: Number(seeded ?? cappedSeed), earned_total: 0, updated_at: backdated };
  }

  if (action === "get") {
    const w = await ensureWallet();
    return json({ ok: true, gold: w.gold, earned: w.earned_total });
  }

  if (action === "spend") {
    const amount = body.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return json({ ok: false, error: "Invalid amount." }, 400);
    }
    await ensureWallet();
    const { data: ok } = await admin.rpc("wallet_debit", { p_user: userId, p_amount: amount });
    const { data: row } = await admin.from("player_wallet").select("gold").eq("user_id", userId).maybeSingle();
    return json({ ok: ok === true, gold: Number(row?.gold ?? 0) });
  }

  if (action === "earn") {
    const reported = body.earned_total;
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0) {
      return json({ ok: false, error: "Invalid earned_total." }, 400);
    }
    const w = await ensureWallet();
    await flagEarnInjection(Math.floor(reported)); // young account reporting an impossible lifetime -> clamp
    const reportedForCredit = Math.min(Math.floor(reported), earnedCeiling(user.created_at)); // cap the receipt we bank against
    const delta = Math.max(0, reportedForCredit - w.earned_total);
    const { available, from } = bucketState(w.updated_at, perDay);
    let credited = Math.max(0, Math.min(delta, available));
    if (delta > AUDIT_HUGE_DELTA) await audit("earn_delta_huge", { action, reported_earned: Math.floor(reported), credited, server_gold: w.gold });
    if (credited > 0) {
      // Optimistic-concurrency guard: only apply if earned_total is still what we read, so two
      // concurrent requests can't interleave writes (the loser skips; its earnings stay claimable).
      const { data: applied } = await admin.from("player_wallet").update({
        gold: Math.min(HARD_CAP, w.gold + credited),
        earned_total: w.earned_total + credited, // advance only by what we credited, so un-credited earnings stay claimable
        updated_at: bucketAdvance(from, credited, perDay),
      }).eq("user_id", userId).eq("earned_total", w.earned_total).select("user_id");
      if (!applied || applied.length === 0) credited = 0; // lost the race -- report what actually happened
    }
    const { data: row } = await admin.from("player_wallet").select("gold, earned_total").eq("user_id", userId).maybeSingle();
    return json({ ok: true, gold: Number(row?.gold ?? w.gold), earned: Number(row?.earned_total ?? w.earned_total), credited });
  }

  // Treasure-chest gold: credited in FULL and EXEMPT from the token bucket / clamp. Security comes not
  // from the rate limit but from the item ledger: we item_debit the opened chests first, so the credit
  // is bounded by chests the player actually holds server-side (can't be forged) and capped at the
  // per-chest gold ceiling. Deliberately does NOT touch earned_total or updated_at -- this credit is
  // outside the normal earnings anchor, so the periodic `sync`/`earn` path never double-credits it.
  if (action === "earn_chest") {
    const count = body.count;
    const reportedGold = body.gold;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0 || count > 10_000_000) {
      return json({ ok: false, error: "Invalid count." }, 400);
    }
    if (typeof reportedGold !== "number" || !Number.isFinite(reportedGold) || reportedGold < 0) {
      return json({ ok: false, error: "Invalid gold." }, 400);
    }
    await ensureWallet();
    // Verify + consume the chests from the item ledger. Fails (ok:false) if the player doesn't hold N
    // chests server-side -- the client then falls back to the normal rate-limited earn path.
    const { data: debited } = await admin.rpc("item_debit", { p_user: userId, p_key: "treasure_chest", p_qty: count });
    if (debited !== true) return json({ ok: false, error: "Chests not available in the ledger." });
    const w = await ensureWallet();
    const CHEST_MAX_GOLD = 5_000; // per-chest gold ceiling (matches openTreasureChests' roll cap)
    const credit = Math.max(0, Math.min(Math.floor(reportedGold), count * CHEST_MAX_GOLD));
    const newGold = Math.min(HARD_CAP, w.gold + credit);
    await admin.from("player_wallet").update({ gold: newGold }).eq("user_id", userId); // earned_total & updated_at unchanged: exempt from the bucket
    return json({ ok: true, gold: newGold, credited: credit });
  }

  // The reconcile the client calls periodically (and on load). It (1) credits new earnings under
  // the same throttle as `earn`, then (2) CLAMPS the balance to the client's reported gold with a
  // min(). The clamp is what makes the wallet authoritative while staying offline-safe: a legit
  // player's local spends (estate, bank, etc.) pull the number DOWN with no per-spend plumbing,
  // but a spoofed-HIGH balance can't push it UP -- min() only ever lowers. The returned gold is
  // written back into state.gold, so a cheat that inflates local gold is undone on the next sync.
  if (action === "sync") {
    const reported = body.earned_total;
    const reportedGold = (body as { gold?: unknown }).gold;
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0) {
      return json({ ok: false, error: "Invalid earned_total." }, 400);
    }
    if (typeof reportedGold !== "number" || !Number.isFinite(reportedGold) || reportedGold < 0) {
      return json({ ok: false, error: "Invalid gold." }, 400);
    }
    const w = await ensureWallet();
    await flagEarnInjection(Math.floor(reported)); // young account reporting an impossible lifetime -> clamp
    const reportedForCredit = Math.min(Math.floor(reported), earnedCeiling(user.created_at)); // cap the receipt we bank against
    const delta = Math.max(0, reportedForCredit - w.earned_total);
    const { available, from } = bucketState(w.updated_at, perDay);
    const credited = Math.max(0, Math.min(delta, available));
    const goldAfterCredit = Math.min(HARD_CAP, w.gold + credited);
    const clamped = Math.max(0, Math.min(goldAfterCredit, Math.floor(Math.min(reportedGold, HARD_CAP))));
    // Spoof signatures -> audit trail (the clamp already neutralizes them; this makes probing VISIBLE).
    if (delta > AUDIT_HUGE_DELTA) await audit("earn_delta_huge", { action, reported_earned: Math.floor(reported), credited, server_gold: w.gold });
    if (reportedGold > goldAfterCredit * 2 && reportedGold - goldAfterCredit > AUDIT_GOLD_ABS) {
      await audit("gold_spoof_clamped", { action, reported_gold: Math.floor(reportedGold), credited, server_gold: goldAfterCredit });
    }
    // Bank ONLY the credit that survived the clamp. If a legit earn can't be reflected yet (client
    // reports lower gold, e.g. throttled or previously mis-clamped), we DON'T burn earned_total for it,
    // so it stays claimable on a later sync -- this makes wrongly-lost gold recoverable and stops the
    // old death-spiral where throttled earnings were consumed but never delivered.
    const stuckCredit = Math.max(0, Math.min(credited, clamped - w.gold));
    const earnedTotal = w.earned_total + stuckCredit;
    // Same optimistic-concurrency guard as `earn`: if another request landed between our read and this
    // write, skip -- the client re-syncs within a minute and reconciles against the fresher row.
    const { data: applied } = await admin.from("player_wallet").update({
      gold: clamped,
      earned_total: earnedTotal,
      updated_at: stuckCredit > 0 ? bucketAdvance(from, stuckCredit, perDay) : w.updated_at, // carry the clock otherwise
    }).eq("user_id", userId).eq("earned_total", w.earned_total).select("user_id");
    if (!applied || applied.length === 0) {
      const { data: cur } = await admin.from("player_wallet").select("gold, earned_total").eq("user_id", userId).maybeSingle();
      return json({ ok: true, gold: Number(cur?.gold ?? w.gold), earned: Number(cur?.earned_total ?? w.earned_total), credited: 0 });
    }
    return json({ ok: true, gold: clamped, earned: earnedTotal, credited: stuckCredit });
  }

  // Deliberate account wipe ("Start Over as a Mortal"). The client has zeroed its own save; make the wallet
  // match at the SOURCE. Without this, the wallet's MONOTONIC earned_total survives the wipe, so the fresh
  // character's low goldEarnedTotal leaves every earn delta <=0 and the sync-clamp keeps dragging gold to 0
  // (bug: a Mortal-reset account's earned gold -- e.g. a 200k quest reward -- never sticks). Zeroing gold +
  // earned_total here removes the mismatch, and back-dating updated_at starts the bucket FULL so the fresh
  // character's first legit earn isn't throttled. Self-authenticating (uid from the token) and it only ever
  // LOWERS this account's OWN wallet to 0 -- there is nothing to gain by calling it, so it is safe to expose
  // to authenticated. Idempotent.
  if (action === "reset") {
    const backdated = new Date(Date.now() - BUCKET_FILL_MS).toISOString();
    await admin.from("player_wallet").upsert({ user_id: userId, gold: 0, earned_total: 0, updated_at: backdated, seeded: true });
    return json({ ok: true, gold: 0, earned: 0 });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
