// Fantasy Frontiers — upgrade a guest account to a real one, IN PLACE.
// A guest (register_guest) is a real Auth user with a system-assigned guest<digits> username and an
// is_guest flag. This authenticated endpoint lets that same user claim a real username + password of their
// choosing. It UPDATES the existing user (never creates a new one), so the user id is unchanged and every
// row keyed by it -- save, wallet, item ledger, profile, estate, guild membership -- carries over untouched.
//
// Optional security questions are NOT set here: the client sets them via the existing account_recovery
// `set` action after it re-signs-in with the new credentials.
//
// Auth: the caller's own token identifies the account; the desired username/password come from the body.
// Re-runs the same username rules register enforces (format, reserved words, profanity), plus a reservation
// on the guest<digits> shape so a chosen name can't masquerade as a system guest. Deploy normally (JWT on).
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
  // The guest<digits> shape is reserved for system-assigned guests -- a chosen name can't impersonate one.
  if (/^guest[0-9]+$/i.test(name)) return "That username is reserved.";
  const norm = normalizeForFilter(name);
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
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Identity from the token (never the body).
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  // Volume limit, keyed on the account. Fail-open.
  try { const { data: over } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "guest_upgrade", p_limit: 20, p_window_secs: 600 }); if (over === true) return json({ ok: false, error: "Too many attempts. Try again shortly." }, 429); } catch { /* allow */ }

  // Only a guest may upgrade. A real account hitting this is a no-op refusal (its username/password are
  // changed elsewhere), so guard rather than silently rewrite a permanent account's credentials.
  if ((user.user_metadata as Record<string, unknown> | undefined)?.is_guest !== true) {
    return json({ ok: false, error: "This account is already registered." }, 400);
  }

  let username = "", password = "";
  try { const b = await req.json(); username = String(b?.username ?? "").trim(); password = String(b?.password ?? ""); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  const uErr = validateUsername(username);
  if (uErr) return json({ ok: false, error: uErr }, 400);
  if (password.length < PASSWORD_MIN) return json({ ok: false, error: "Password must be at least " + PASSWORD_MIN + " characters." }, 400);
  if (password.length > PASSWORD_MAX) return json({ ok: false, error: "Password must be " + PASSWORD_MAX + " characters or fewer." }, 400);

  const email = username.toLowerCase() + "@" + AUTH_EMAIL_DOMAIN;

  // Update the SAME user: new synthetic email (login key), password, and username; clear the guest flag.
  // email_confirm keeps the address usable immediately regardless of project confirmation settings.
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    email,
    password,
    email_confirm: true,
    user_metadata: { ...(user.user_metadata || {}), username, is_guest: false },
  });
  if (error) {
    const m = (error.message || "").toLowerCase();
    if (m.includes("already") || m.includes("exists") || m.includes("registered") || m.includes("duplicate")) {
      return json({ ok: false, error: "That username is already taken." }, 409);
    }
    return json({ ok: false, error: "Upgrade failed." }, 400);
  }
  // The client now re-signs-in with the new credentials (the email change can invalidate the old session),
  // then may set security questions via account_recovery.
  return json({ ok: true, username });
});
