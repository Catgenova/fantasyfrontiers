// Fantasy Frontiers — cloud save writer.
// Clients read their save directly (RLS-guarded select on public.saves), but WRITE
// through here so we can enforce a freshness guard: a device holding an older save
// can't overwrite a newer one already in the cloud (prevents multi-device clobbering).
// Identity comes from the auth token, never the body.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_BYTES = 500_000; // keep under the table's ~512KB column guard

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

  // Identity from token.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;

  // Parse.
  let body: { data?: unknown; client_saved_at?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const data = body.data;
  if (typeof data !== "object" || data === null) return json({ ok: false, error: "Invalid save." }, 400);
  const incoming = typeof body.client_saved_at === "number" && Number.isFinite(body.client_saved_at)
    ? Math.floor(body.client_saved_at) : 0;
  if (JSON.stringify(data).length > MAX_BYTES) return json({ ok: false, error: "Save too large." }, 413);

  // Freshness guard: don't let an older save overwrite a newer cloud save.
  const { data: prev } = await admin.from("saves")
    .select("client_saved_at, version").eq("user_id", userId).maybeSingle();
  if (prev && incoming < (prev.client_saved_at ?? 0)) {
    return json({ ok: false, stale: true, server_saved_at: prev.client_saved_at }, 409);
  }

  const nextVersion = (prev?.version ?? 0) + 1;
  const { error: upErr } = await admin.from("saves").upsert({
    user_id: userId,
    data,
    version: nextVersion,
    client_saved_at: incoming,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (upErr) {
    const msg = (upErr.message || "").toLowerCase();
    if (msg.includes("saves_size_chk") || msg.includes("check constraint")) return json({ ok: false, error: "Save too large." }, 413);
    return json({ ok: false, error: "Could not save." }, 500);
  }
  return json({ ok: true, version: nextVersion });
});
