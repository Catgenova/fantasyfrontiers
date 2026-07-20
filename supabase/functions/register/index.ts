// Fantasy Frontiers — server-side registration.
// The browser calls this Edge Function to create an account. It re-runs the same
// username rules the client enforces (format, reserved words, profanity) using the
// service role, so the checks can't be bypassed by editing the client. On success it
// creates a Supabase Auth user whose synthetic email encodes the username; the client
// then signs in normally with signInWithPassword.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_EMAIL_DOMAIN = "players.fantasyfrontiers.app";
const USERNAME_MIN = 3, USERNAME_MAX = 20, PASSWORD_MIN = 8, PASSWORD_MAX = 200;

const RESERVED = ["admin","administrator","moderator","mod","mods","staff","system","systemmessage","server","owner","root","support","help","helpdesk","official","fantasyfrontiers","anon","anonymous","null","undefined","everyone","here"];
const BLOCKLIST = ["nigger","nigga","niggr","niggah","nikka","chink","gook","wetback","kike","beaner","dago","raghead","sandnigger","jigaboo","porchmonkey","towelhead","faggot","faggit","fudgepacker","tranny","shemale","retard","spastic","mongoloid","hitler","nazi","kkk","whitepower","heilhitler","fuck","fuk","fucker","motherfucker","fuckface","shit","bullshit","dipshit","cunt","bitch","bastard","asshole","arsehole","asswipe","pussy","whore","slut","wanker","twat","bollocks","dildo","jizz","cumshot","blowjob","handjob","cocksucker","dickhead","dumbass","jackass","prick","smegma","pedophile","molester"];

function normalizeForFilter(str: string): string {
  return String(str || "").toLowerCase()
    .replace(/@/g, "a").replace(/\$/g, "s").replace(/[!|]/g, "i").replace(/\(/g, "c")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/8/g, "b").replace(/9/g, "g")
    .replace(/[^a-z]/g, "");
}
function validateUsername(name: string): string {
  name = (name || "").trim();
  if (name.length < USERNAME_MIN) return "Username must be at least " + USERNAME_MIN + " characters.";
  if (name.length > USERNAME_MAX) return "Username must be " + USERNAME_MAX + " characters or fewer.";
  if (!/^[A-Za-z0-9_]+$/.test(name)) return "Use only letters, numbers, and underscores.";
  if (!/^[A-Za-z0-9]/.test(name)) return "Username must start with a letter or number.";
  const norm = normalizeForFilter(name);
  // Also compare with trailing digits/underscores stripped. Leetspeak folding happens BEFORE this check,
  // so `adm1n` and `4dmin` were already caught -- but `admin1` normalised to "admini" and sailed through,
  // because 1 maps to i. Same for `staff1`, `moderator2` and friends. Trailing filler is the cheapest way
  // to sit next to a reserved name in chat, so strip it and re-check.
  const stripped = normalizeForFilter(name.replace(/^[0-9_]+|[0-9_]+$/g, ""));
  if (RESERVED.indexOf(name.toLowerCase()) !== -1 || RESERVED.indexOf(norm) !== -1
      || (stripped.length >= USERNAME_MIN && RESERVED.indexOf(stripped) !== -1)) {
    return "That username is reserved.";
  }
  for (const bad of BLOCKLIST) { if (norm.indexOf(bad) !== -1) return "Please choose a different username."; }
  return "";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  let username = "", password = "";
  try {
    const b = await req.json();
    username = String(b?.username ?? "").trim();
    password = String(b?.password ?? "");
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  const uErr = validateUsername(username);
  if (uErr) return json({ ok: false, error: uErr }, 400);
  if (password.length < PASSWORD_MIN) return json({ ok: false, error: "Password must be at least " + PASSWORD_MIN + " characters." }, 400);
  // Ceiling as well as a floor: without one, a multi-megabyte password reaches the hashing path and buys
  // an attacker a lot of server CPU for one request.
  if (password.length > PASSWORD_MAX) return json({ ok: false, error: "Password must be " + PASSWORD_MAX + " characters or fewer." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Volume limit. This endpoint is unauthenticated by nature, so there is no auth.uid() to key on -- the
  // subject is the caller's IP. That is weaker than the other functions' limiter (a determined caller can
  // rotate addresses, and the leftmost x-forwarded-for hop is client-supplied), so it is anti-spam and
  // nothing more. It is only ACCEPTABLE as such because the server-buff grant below has been removed: a
  // flood of registrations now yields junk accounts rather than a free server-wide buff.
  // Generous enough for a shared IP behind NAT and for retries after a rejected username.
  const fwd = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const ip = fwd || req.headers.get("cf-connecting-ip") || "unknown";
  if (ip !== "unknown") {
    try {
      const { data: over } = await admin.rpc("rl_hit", { p_subject: "reg:" + ip, p_bucket: "register", p_limit: 10, p_window_secs: 600 });
      if (over === true) return json({ ok: false, error: "Too many sign-ups from here. Try again in a few minutes." }, 429);
    } catch { /* limiter unavailable -> allow, same fail-open stance as every other function */ }
  }

  const email = username.toLowerCase() + "@" + AUTH_EMAIL_DOMAIN;

  // email_confirm:true auto-confirms the synthetic address so the user can sign in
  // immediately, regardless of the project's email-confirmation setting.
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  });

  if (error) {
    const m = (error.message || "").toLowerCase();
    if (m.includes("already") || m.includes("exists") || m.includes("registered") || m.includes("duplicate")) {
      return json({ ok: false, error: "That username is already taken." }, 409);
    }
    return json({ ok: false, error: "Registration failed." }, 400);
  }

  // NO SERVER-BUFF GRANT HERE. A fresh registration used to gift the whole server 1h of +50% XP, moved
  // into this function on the reasoning that it fires "exactly once per real account creation" -- which
  // was the mistake. Nothing makes an account real. This endpoint needs no auth (it is how you get an
  // account) and had no rate limit, and server_buff_extend ACCUMULATES:
  //
  //   active_until = least(now() + 30 days, greatest(active_until, now()) + p_seconds)
  //
  // so each sign-up banked another full hour on top. Roughly 720 scripted registrations pinned the
  // server-wide buff on for a month, free -- reinstating the exact exploit that removing the
  // client-callable server_buff `grant` action was meant to close, and defeating the 100k gold price on
  // `buy`. The grant is gone rather than throttled: a rate limit on an unauthenticated endpoint only
  // raises the cost of the attack, and the reward here was permanent.
  //
  // Buying the buff (server_buff `buy`, wallet-charged) remains the way it turns on.
  return json({ ok: true });
});
