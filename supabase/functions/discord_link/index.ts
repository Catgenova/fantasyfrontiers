// Fantasy Frontiers — Discord identity helper (linking-first model).
//
// Discord is a SECONDARY login attached to an existing username account via the client's
// auth.linkIdentity() flow. But signInWithOAuth('discord') for a Discord that ISN'T linked to any
// account still auto-creates a throwaway auth user with a Discord identity and NO game username.
// If we just left it, that Discord identity would be permanently bound to a usernameless ghost user,
// and the player could never link it to the real account they later register.
//
// This function's one job (`cleanup_orphan`) lets that ghost session delete ITSELF so the Discord
// identity is freed for future linking. SAFETY INVARIANT: it refuses to delete any account that has a
// username (a real player) — it only removes usernameless Discord ghosts.
//
// Verify JWT must be OFF (the publishable key isn't a JWT; the caller's token is validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return json({ ok: false, error: "Not authenticated." }, 401);
  const user = data.user;

  if (action === "cleanup_orphan") {
    // SAFETY: never delete an account that has a game username — that's a real player.
    const username = (user.user_metadata as Record<string, unknown> | null)?.username;
    if (username) return json({ ok: false, error: "Account is linked to a player; nothing to clean up." }, 400);

    // Only qualify sessions that actually hold a Discord identity (a usernameless OAuth ghost).
    const hasDiscord = (user.identities || []).some((i) => i.provider === "discord");
    if (!hasDiscord) return json({ ok: false, error: "No Discord identity on this session." }, 400);

    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) return json({ ok: false, error: "Cleanup failed." }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
