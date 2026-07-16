// Fantasy Frontiers — server-wide buffs.
//
// A buff a player buys with gold that helps EVERY player on the server. Shared state is a single
// `active_until` per buff kind; buying extends it (see the server_buff_extend RPC). The gold cost
// is charged CLIENT-SIDE (client-authoritative economy, like the guild treasury); this function
// only guarantees the shared timer's integrity. First buff: 'exp' (+50% XP for all players, 1h).
//
// Actions (POST { action, ... }):
//   get              -> { buffs: { exp: <iso active_until | null> } }   (current server buff state)
//   buy { kind }     -> AUTH + gold charge (wallet_debit); extend that buff; returns new active_until
//
// There is NO free "grant" action anymore (it let any player pin the server buff on for free). The one
// legitimate free grant -- a fresh registration -- now runs server-side inside the `register` function.
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

// Buyable buffs: kind -> how long one purchase extends the shared timer (seconds).
// `test` is a 1s no-op kind the integration script exercises so it doesn't extend the real
// `exp` buff for the whole server; no client reads it.
const BUFF_SECONDS: Record<string, number> = { exp: 3600, test: 1 };
// Gold cost per purchase, charged server-side against the player_wallet (must match the client's
// SERVER_BUFF_EXP_COST). The `test` kind is free so the integration script doesn't need a funded wallet.
const BUFF_COST: Record<string, number> = { exp: 100000, test: 0 };

// NOTE: there is intentionally NO free client-callable "grant" action. It used to auto-extend the shared
// exp buff on a client-sent `reason` ("register" 1h / "familiar" 5min) with no gold and no verification
// -- any logged-in player could pin the server-wide +50% XP on for free, defeating the 100k/hr `buy`
// price. The one legitimately server-verifiable grant (a fresh registration) now fires INSIDE the
// `register` edge function (service role, exactly once per real account). Finding a familiar is
// client-only state the server can't verify, so it no longer gifts a server-wide buff.

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
  if (userErr || !userData?.user) return json({ ok: false, error: "Not authenticated." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  async function snapshot() {
    const { data } = await admin.from("server_buffs").select("kind, active_until");
    const buffs: Record<string, string | null> = { exp: null };
    for (const r of data || []) buffs[r.kind as string] = r.active_until as string;
    return buffs;
  }

  if (action === "get") {
    return json({ ok: true, buffs: await snapshot() });
  }

  if (action === "buy") {
    const kind = String(body.kind || "");
    const secs = BUFF_SECONDS[kind];
    if (!secs) return json({ ok: false, error: "Unknown buff." }, 400);
    // Charge the gold against the server-authoritative wallet BEFORE extending the shared timer, so
    // spoofed client gold can't buy a buff that helps the whole server. Refund on a downstream failure.
    const cost = BUFF_COST[kind] || 0;
    if (cost > 0) {
      const { data: paid } = await admin.rpc("wallet_debit", { p_user: userData.user.id, p_amount: cost });
      if (paid !== true) return json({ ok: false, error: "Not enough gold." }, 402);
    }
    const { data: until, error } = await admin.rpc("server_buff_extend", { p_kind: kind, p_seconds: secs });
    if (error || !until) {
      if (cost > 0) await admin.rpc("wallet_credit", { p_user: userData.user.id, p_amount: cost }); // refund
      return json({ ok: false, error: "Purchase failed." }, 500);
    }
    return json({ ok: true, kind, active_until: until, buffs: await snapshot() });
  }

  // "grant" is deliberately gone -- it was a free, unverified server-wide buff extender (see the note by
  // BUFF_SECONDS). Reject it explicitly so an old client calling it fails loudly instead of silently.
  if (action === "grant") return json({ ok: false, error: "Grants are no longer client-callable." }, 403);

  return json({ ok: false, error: "Unknown action." }, 400);
});
