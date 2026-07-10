// Fantasy Frontiers — server-authoritative item ledger (the item counterpart of `wallet`).
//
// Endpoints (all POST, identity from the auth token, never the body):
//   { action:"get" }                 -> { ok, items: { item_key: qty } }   the caller's ledger
//   { action:"sync", inventory:{…} } -> { ok, items: { item_key: qty } }   reconcile the full inventory
//
// EARNING is client-reported (the server can't simulate gathering/crafting) but RATE-LIMITED per item
// type: item_sync grandfathers the existing inventory once, then caps how fast any one item's count can
// grow and clamps the stored qty to what the client reports (a spoofed-high count can't raise it).
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

  let body: { action?: unknown; inventory?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "get");

  if (action === "get") {
    const { data } = await admin.from("player_items").select("item_key, qty").eq("user_id", userId);
    const items: Record<string, number> = {};
    for (const r of data || []) { const q = Number(r.qty); if (q > 0) items[r.item_key as string] = q; }
    return json({ ok: true, items });
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
    const { data, error } = await admin.rpc("item_sync", {
      p_user: userId, p_items: clean, p_per_hour: ITEM_PER_HOUR, p_burst: ITEM_BURST,
    });
    if (error) return json({ ok: false, error: "Sync failed." }, 500);
    const out: Record<string, number> = {};
    const rec = (data || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) { const q = Number(v); if (q > 0) out[k] = q; }
    return json({ ok: true, items: out });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
