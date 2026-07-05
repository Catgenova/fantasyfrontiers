// Fantasy Frontiers — server-side registration.
// The browser calls this Edge Function to create an account. It re-runs the same
// username rules the client enforces (format, reserved words, profanity) using the
// service role, so the checks can't be bypassed by editing the client. On success it
// creates a Supabase Auth user whose synthetic email encodes the username; the client
// then signs in normally with signInWithPassword.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_EMAIL_DOMAIN = "players.fantasyfrontiers.app";
const USERNAME_MIN = 3, USERNAME_MAX = 20, PASSWORD_MIN = 8;

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
  if (RESERVED.indexOf(name.toLowerCase()) !== -1 || RESERVED.indexOf(norm) !== -1) return "That username is reserved.";
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
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
  return json({ ok: true });
});
