// Fantasy Frontiers — server-authoritative item ledger (the item counterpart of `wallet`).
//
// Endpoints (all POST, identity from the auth token, never the body):
//   { action:"get" }                 -> { ok, items }                      the caller's ledger
//   { action:"sync", inventory:{…} } -> { ok, items }                      reconcile the full inventory
//   { action:"debit", bill:{…} }     -> { ok, debited, items }             atomic all-or-nothing spend
//   { action:"craft", recipe_key,mult}-> { ok, debited, items }            debit a server-canonical recipe
//
// EARNING is client-reported (the server can't simulate gathering/crafting) but RATE-LIMITED per item
// type: item_sync grandfathers the existing inventory once (bounded by ACCOUNT AGE, so a fresh/tampered
// account can't seed a spoofed stock), then caps how fast any one item's count can grow and clamps the
// stored qty to what the client reports (a spoofed-high count can't raise it).
// SPENDING (Stage 3: market list / bank deposit) will be hard-enforced against this ledger via
// item_debit. Mirrors the wallet's trust model exactly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Per-item-type rate limits. Allowed increase per sync = min(BURST, PER_HOUR * hoursElapsed).
// Generous by design: a fast 12h offline haul of a single item stays well under these, so a legit
// player is never throttled; a minter is bounded to this rate instead of instant. Tunable.
const ITEM_PER_HOUR = 50_000;
const ITEM_BURST = 25_000;
const MAX_KEYS = 2000;            // hard cap on distinct item types accepted in one sync (payload guard)
const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

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

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;

  let body: { action?: unknown; inventory?: unknown; bill?: unknown; recipe_key?: unknown; mult?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "get");

  // The caller's current ledger as a clean { key: qty>0 } map (for returning after a debit so the client
  // can reconcile immediately).
  async function ledgerSnapshot(): Promise<Record<string, number>> {
    const { data } = await admin.from("player_items").select("item_key, qty").eq("user_id", userId);
    const items: Record<string, number> = {};
    for (const r of data || []) { const q = Number(r.qty); if (q > 0) items[r.item_key as string] = q; }
    return items;
  }
  // Sanitize a { item_key: qty } bill (valid keys, positive integers, bounded size) before it reaches SQL.
  function cleanBill(raw: unknown): Record<string, number> | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const out: Record<string, number> = {}; let n = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) continue;
      const q = Number(v);
      if (!Number.isFinite(q) || q <= 0) continue;
      out[k] = Math.min(1_000_000_000_000, Math.floor(q));
      if (++n >= MAX_KEYS) break;
    }
    return Object.keys(out).length ? out : null;
  }

  if (action === "get") {
    return json({ ok: true, items: await ledgerSnapshot() });
  }

  // Server-authoritative SPEND (Stage A foundation; the client wires these in a later stage):
  //   { action:"debit", bill:{item_key:qty} }        -> atomic all-or-nothing debit of an explicit bill
  //   { action:"craft", recipe_key, mult }           -> debit the server-canonical recipe bill x mult
  // Both return { ok, debited, items } where `debited` says whether the ledger covered it and `items` is
  // the fresh ledger so the client can reconcile. `ok:false` is reserved for malformed input; an
  // insufficient ledger is a valid response with debited:false.
  if (action === "debit") {
    const bill = cleanBill(body.bill);
    if (!bill) return json({ ok: false, error: "Invalid bill." }, 400);
    const { data, error } = await admin.rpc("item_debit_bill", { p_user: userId, p_bill: bill });
    if (error) return json({ ok: false, error: "Debit failed." }, 500);
    return json({ ok: true, debited: data === true, items: await ledgerSnapshot() });
  }

  if (action === "craft") {
    const recipeKey = String(body.recipe_key || "");
    if (!/^[A-Za-z0-9_]{1,64}$/.test(recipeKey)) return json({ ok: false, error: "Invalid recipe." }, 400);
    const mRaw = Number(body.mult);
    const mult = Number.isFinite(mRaw) && mRaw > 0 ? Math.min(1_000_000, Math.floor(mRaw)) : 1;
    const { data, error } = await admin.rpc("craft_debit", { p_user: userId, p_recipe_key: recipeKey, p_mult: mult });
    if (error) return json({ ok: false, error: "Craft debit failed." }, 500);
    return json({ ok: true, debited: data === true, items: await ledgerSnapshot() });
  }

  if (action === "sync") {
    const inv = body.inventory;
    if (typeof inv !== "object" || inv === null || Array.isArray(inv)) {
      return json({ ok: false, error: "Invalid inventory." }, 400);
    }
    // Sanitize into a clean { key: non-negative-integer } map before it reaches SQL: valid keys only,
    // finite non-negative counts, bounded number of distinct types.
    const clean: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(inv as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) continue;
      const q = Number(v);
      if (!Number.isFinite(q) || q <= 0) continue;
      clean[k] = Math.min(1_000_000_000_000, Math.floor(q));
      if (++n >= MAX_KEYS) break;
    }
    // Pass the account's created_at so item_sync can bound the one-time grandfather by account age --
    // a fresh/tampered account can't seed the ledger with a spoofed inventory (only an established
    // account has the age headroom to grandfather a large legit stock). See the item_sync migration.
    const { error } = await admin.rpc("item_sync", {
      p_user: userId, p_items: clean, p_per_hour: ITEM_PER_HOUR, p_burst: ITEM_BURST,
      p_created_at: user.created_at,
    });
    if (error) return json({ ok: false, error: "Sync failed." }, 500);
    // Re-read the reconciled ledger + the per-item lifetime-earned anchor. `earned` lets the client
    // adopt the ledger without dropping legit gathered items the rate cap hasn't credited yet (Stage B-2).
    const { data: rows } = await admin.from("player_items").select("item_key, qty, earned_total").eq("user_id", userId);
    const out: Record<string, number> = {};
    const earned: Record<string, number> = {};
    for (const r of rows || []) {
      const q = Number(r.qty), e = Number(r.earned_total);
      if (q > 0) out[r.item_key as string] = q;
      if (e > 0) earned[r.item_key as string] = e;
    }
    return json({ ok: true, items: out, earned });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
