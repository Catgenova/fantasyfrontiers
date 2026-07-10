// Fantasy Frontiers — server-authoritative gold wallet (Stage 1).
//
// Endpoints (all POST, identity from the auth token, never the body):
//   { action:"get" }                      -> { ok, gold }   (seeds from the player's save on first touch)
//   { action:"earn", earned_total:number} -> { ok, gold, credited }   rate-limited credit of new earnings
//   { action:"spend", amount:number }     -> { ok, gold }   debits if the balance covers it, else ok:false
//
// EARNING is client-reported (the server can't simulate combat/gathering) but RATE-LIMITED: the credit
// per call is capped by real time elapsed, the same way submit_profile caps leaderboard gains, so a
// spoofed "earned_total" only ever banks at the honest rate. SPENDING is hard-enforced against the
// server balance (wallet_debit fails when the gold isn't there). Existing balances are grandfathered
// from the player's current save the first time the wallet is touched.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Rate limits (token bucket). Credit accrues at GOLD_PER_HOUR since the last credit, capped at
// BURST_GOLD per claim -- see the `earn` handler. A scripted earn loop can't beat the time-based rate.
const GOLD_PER_HOUR = 20_000_000;
const BURST_GOLD = 10_000_000;
const HARD_CAP = 1_000_000_000_000_000; // 1e15, keeps totals safe JS integers

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

  let body: { action?: unknown; earned_total?: unknown; amount?: unknown };
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
    return { gold: Number(seeded ?? seedGold), earned_total: 0, updated_at: new Date().toISOString() };
  }

  if (action === "get") {
    const w = await ensureWallet();
    return json({ ok: true, gold: w.gold });
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
    // Token-bucket rate limit: the allowance accrues from wall-clock time SINCE THE LAST
    // credit (updated_at advances only when we credit), capped at BURST_GOLD per claim. Because
    // it's a function of elapsed time and not call count, hammering earn in a loop grants nothing
    // extra -- max sustained credit is GOLD_PER_HOUR, max single claim is BURST_GOLD.
    const hours = Math.max(0, (Date.now() - new Date(w.updated_at).getTime()) / 3_600_000);
    const allowed = Math.min(BURST_GOLD, Math.floor(GOLD_PER_HOUR * hours));
    const credited = Math.min(delta, allowed);
    if (credited > 0) {
      await admin.from("player_wallet").update({
        gold: Math.min(HARD_CAP, w.gold + credited),
        earned_total: w.earned_total + credited, // advance only by what we credited, so throttling persists
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    }
    const { data: row } = await admin.from("player_wallet").select("gold").eq("user_id", userId).maybeSingle();
    return json({ ok: true, gold: Number(row?.gold ?? w.gold), credited });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
