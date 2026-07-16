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
// spoofed "earned_total" only ever banks at the honest rate -- and that rate RAMPS with account age
// (dailyAllowanceFor), so a throwaway account can't farm at endgame speed. Spoof-shaped requests are logged
// to wallet_audit (see migration 20260716010000). SPENDING is hard-enforced against the server balance
// (wallet_debit fails when the gold isn't there). Existing balances are grandfathered from the player's
// current save the first time the wallet is touched.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Rate limits (token bucket). The bucket holds ONE DAY's allowance and refills continuously over 24h;
// unused allowance CARRIES between claims up to the full bucket (see bucketState). A scripted earn loop
// can't beat the sustained time-based rate, but a single legit burst up to a full day's allowance
// credits at once -- so opening a chest stack or banking a long offline haul isn't throttled away. A
// freshly-seeded wallet starts with a FULL bucket (see ensureWallet).
const HARD_CAP = 1_000_000_000_000_000; // 1e15, keeps totals safe JS integers
const BUCKET_FILL_MS = 86_400_000;      // the bucket is one day's allowance, refilling over 24h

// Account-age ramp: the full daily allowance is endgame-scale, so a freshly-registered (bot) account
// shouldn't get it. The allowance scales with the auth account's age (server-trusted created_at, the
// same anti-spoof anchor as the item-ledger grandfather cap): 10M gold/day at <=1 day, ramping linearly
// to 500M gold/day at >=7 days (~= the old 20M/hr sustained rate). Day-one legit players earn a tiny
// fraction of 10M, so the ramp is invisible to them; it only starves day-zero farm bots.
// FF_RATE_RAMP_OFF=1 (staging secret) pins the full allowance for integration runs.
const RAMP_DAY1_GOLD = 10_000_000;    // daily allowance at account age <= 1 day
const RAMP_DAY7_GOLD = 500_000_000;   // daily allowance at account age >= 7 days
const RAMP_START_DAYS = 1, RAMP_END_DAYS = 7;
const RAMP_OFF = Deno.env.get("FF_RATE_RAMP_OFF") === "1";
function dailyAllowanceFor(createdAtIso: string | undefined): number {
  if (RAMP_OFF || !createdAtIso) return RAMP_DAY7_GOLD;
  const days = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  const t = Math.min(1, Math.max(0, (days - RAMP_START_DAYS) / (RAMP_END_DAYS - RAMP_START_DAYS)));
  return Math.floor(RAMP_DAY1_GOLD + (RAMP_DAY7_GOLD - RAMP_DAY1_GOLD) * t);
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
  const perDay = dailyAllowanceFor(user.created_at);

  // Best-effort audit trail for spoof-shaped requests (never blocks the response path).
  async function audit(note: string, extra: Record<string, unknown>): Promise<void> {
    try { await admin.from("wallet_audit").insert({ user_id: userId, note, ...extra }); } catch { /* table missing / transient -- don't fail the request */ }
  }

  let body: { action?: unknown; earned_total?: unknown; amount?: unknown; count?: unknown; gold?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "get");

  // Ensure the wallet row exists, grandfathering the player's current save gold the first time.
  async function ensureWallet(): Promise<{ gold: number; earned_total: number; updated_at: string }> {
    const { data: row } = await admin.from("player_wallet")
      .select("gold, earned_total, updated_at, seeded").eq("user_id", userId).maybeSingle();
    if (row) return { gold: Number(row.gold), earned_total: Number(row.earned_total), updated_at: row.updated_at };
    // No row yet -> read the player's save gold and seed once.
    const { data: save } = await admin.from("saves").select("data").eq("user_id", userId).maybeSingle();
    let seedGold = 0;
    const g = (save?.data as Record<string, unknown> | undefined)?.gold;
    if (typeof g === "number" && Number.isFinite(g) && g > 0) seedGold = Math.floor(g);
    const { data: seeded } = await admin.rpc("wallet_seed", { p_user: userId, p_gold: Math.min(seedGold, HARD_CAP) });
    // Start the bucket FULL: back-date updated_at by the fill window so the first legit earn after
    // seeding isn't throttled to ~0 (which, on a 0-gold seed, wiped freshly-earned gold to 0).
    const backdated = new Date(Date.now() - BUCKET_FILL_MS).toISOString();
    await admin.from("player_wallet").update({ updated_at: backdated }).eq("user_id", userId);
    return { gold: Number(seeded ?? seedGold), earned_total: 0, updated_at: backdated };
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
    const delta = Math.max(0, Math.floor(reported) - w.earned_total);
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
    const CHEST_MAX_GOLD = 10_000; // per-chest gold ceiling (matches openTreasureChests' roll cap)
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
    const delta = Math.max(0, Math.floor(reported) - w.earned_total);
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

  return json({ ok: false, error: "Unknown action." }, 400);
});
