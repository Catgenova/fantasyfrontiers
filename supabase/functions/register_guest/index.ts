// Fantasy Frontiers — guest account creation.
// "Play as Guest" on the landing page calls this. It mints a throwaway account with a SERVER-GENERATED
// username (guest<digits>) and a strong random password, and returns both so the client can sign in and
// keep the credentials for device resume. The player upgrades later (guest_upgrade) to a real username and
// password of their choosing, in place, so all progress carries over.
//
// Guarded the same way as register: Turnstile (a guest row is a real DB row, so an unguarded endpoint is a
// bot-flood vector) plus the per-IP volume limiter. Inert Turnstile until TURNSTILE_SECRET is set, matching
// the client, so the two roll out in either order.
//
// DEPLOY: called before the caller has any session, so it must be deployed with JWT verification OFF:
//   supabase functions deploy register_guest --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_EMAIL_DOMAIN = "players.fantasyfrontiers.app";
const GUEST_DIGITS = 9;          // guest + 9 digits, e.g. guest123418349 (matches the client's expectation)
const CREATE_ATTEMPTS = 6;       // retries on the (astronomically unlikely) username/email collision

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// A cryptographically-random integer in [0, max). Rejection-sampled so it isn't modulo-biased.
function randInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  let v = 0;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return v % max;
}
function guestUsername(): string {
  let s = "";
  for (let i = 0; i < GUEST_DIGITS; i++) s += String(randInt(10));
  // Avoid a leading zero so the visible number reads naturally and stays GUEST_DIGITS long.
  if (s[0] === "0") s = String(1 + randInt(9)) + s.slice(1);
  return "guest" + s;
}
// A strong random password the client stores locally to resume the guest on this device. Not user-facing.
function guestPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  for (let i = 0; i < bytes.length; i++) s += alpha[bytes[i] % alpha.length];
  return "G!" + s; // prefix guarantees length + a symbol, well past any minimum
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  let captchaToken = "";
  try { const b = await req.json(); captchaToken = String(b?.captcha_token ?? ""); } catch { /* body optional */ }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Per-IP volume limit (anti-spam; the IP is the only subject an unauthenticated endpoint has). Same
  // fail-open stance as register.
  const fwd = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const ip = fwd || req.headers.get("cf-connecting-ip") || "unknown";
  if (ip !== "unknown") {
    try {
      const { data: over } = await admin.rpc("rl_hit", { p_subject: "guest:" + ip, p_bucket: "register_guest", p_limit: 10, p_window_secs: 600 });
      if (over === true) return json({ ok: false, error: "Too many guests from here. Try again in a few minutes." }, 429);
    } catch { /* limiter unavailable -> allow */ }
  }

  // Turnstile (fail CLOSED once configured, like register): a guest is a real account, so it must not be
  // creatable by a bot. Inert until TURNSTILE_SECRET is set.
  const turnstileSecret = Deno.env.get("TURNSTILE_SECRET");
  if (turnstileSecret) {
    if (!captchaToken) return json({ ok: false, error: "Human verification required. Please reload and try again." }, 400);
    let human = false;
    try {
      const form = new FormData();
      form.append("secret", turnstileSecret);
      form.append("response", captchaToken);
      if (ip !== "unknown") form.append("remoteip", ip);
      const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
      const vj = await vr.json();
      human = vj?.success === true;
    } catch { human = false; }
    if (!human) return json({ ok: false, error: "Human verification failed. Please reload and try again." }, 400);
  }

  // Mint the guest. Retry on the vanishingly rare collision (the synthetic email must be unique).
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const username = guestUsername();
    const password = guestPassword();
    const email = username + "@" + AUTH_EMAIL_DOMAIN;
    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, is_guest: true },
    });
    if (!error) return json({ ok: true, username, password });
    const m = (error.message || "").toLowerCase();
    if (m.includes("already") || m.includes("exists") || m.includes("registered") || m.includes("duplicate")) {
      continue; // collision -> try a new number
    }
    return json({ ok: false, error: "Could not start a guest session." }, 400);
  }
  return json({ ok: false, error: "Could not start a guest session. Please try again." }, 500);
});
