// Fantasy Frontiers — server-wide buffs.
//
// A buff a player buys with gold that helps EVERY player on the server. Shared state is a single
// `active_until` per buff kind; buying extends it (see the server_buff_extend RPC). The gold cost
// is charged CLIENT-SIDE (client-authoritative economy, like the guild treasury); this function
// only guarantees the shared timer's integrity. First buff: 'exp' (+50% XP for all players, 1h).
//
// Actions (POST { action, ... }):
//   get              -> { buffs: { exp: <iso active_until | null> } }   (current server buff state)
//   buy { kind }     -> AUTH; extend that buff by its fixed duration; returns the new active_until
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

// Auto-granted (no gold) extensions to the shared `exp` buff, keyed by reason. A fresh registration
// gifts 1h; finding a familiar gifts 5min. Server-side extension only -- same trust model as `buy`
// (the client can already extend for free there), so this doesn't widen the abuse surface.
const GRANT_SECONDS: Record<string, number> = { register: 3600, familiar: 300 };

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
    const { data: until, error } = await admin.rpc("server_buff_extend", { p_kind: kind, p_seconds: secs });
    if (error || !until) return json({ ok: false, error: "Purchase failed." }, 500);
    return json({ ok: true, kind, active_until: until, buffs: await snapshot() });
  }

  if (action === "grant") {
    const reason = String(body.reason || "");
    const secs = GRANT_SECONDS[reason];
    if (!secs) return json({ ok: false, error: "Unknown grant." }, 400);
    const { data: until, error } = await admin.rpc("server_buff_extend", { p_kind: "exp", p_seconds: secs });
    if (error || !until) return json({ ok: false, error: "Grant failed." }, 500);
    return json({ ok: true, kind: "exp", reason, active_until: until, buffs: await snapshot() });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
