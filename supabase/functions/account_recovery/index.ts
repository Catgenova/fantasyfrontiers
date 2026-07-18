// Fantasy Frontiers — account recovery via user-authored security questions.
//
// We collect no email/PII, so this is the self-service password-reset path. Answers are a secondary
// credential: they're hashed (bcrypt via pgcrypto, in the recovery_set/recovery_verify RPCs), never
// returned in plaintext, verified server-side, and rate-limited with a lockout. On a successful
// answer check the server resets the account's password with the service role.
//
// Actions (POST { action, ... }):
//   set           { questions:[{q,a}, ...] }              -> AUTH; store/replace the caller's questions (answers hashed)
//   status                                                -> AUTH; { has_questions, questions:[q,...] } (no answers)
//   get_questions { username }                            -> no auth; { questions:[q,...] } for the recovery UI
//   recover       { username, answers:[...], new_password}-> no auth; verify answers, then reset the password
//
// Verify JWT must be OFF (publishable key isn't a JWT; the user token is validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const QUESTION_COUNT = 3;   // users author this many
const NEEDED = 2;           // ...and must answer at least this many correctly to recover. Raised 1 -> 2:
                            // with only 1-of-3 required, and questions readable unauthenticated via
                            // get_questions, a single guessable user-authored answer was a plausible
                            // account-takeover under the 5-try/15-min lockout. Requiring 2 correct makes
                            // brute-forcing two independent answers far harder while staying user-friendly.
const MAX_FAIL = 5;         // failed recovery attempts before a temporary lock
const LOCK_MINUTES = 15;
const Q_MIN = 3, Q_MAX = 120;
const A_MIN = 5, A_MAX = 80;  // min answer length, checked on the NORMALIZED answer (trimmed/collapsed), so
                              // 5 = five meaningful chars -- single-char answers are too guessable/brute-forceable.
                              // Only enforced on `set`; existing shorter answers still work for `recover`.
const PW_MIN = 8;

// Identical normalization on set + verify so matching is forgiving of case/spacing.
const normAnswer = (a: unknown) => String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, A_MAX);

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

  // ---- Authenticated actions (managing your own questions) ----
  async function requireUser() {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  if (action === "set") {
    const user = await requireUser();
    if (!user) return json({ ok: false, error: "Not authenticated." }, 401);
    const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
    if (!username) return json({ ok: false, error: "Account has no username." }, 400);

    const raw = body.questions;
    if (!Array.isArray(raw) || raw.length !== QUESTION_COUNT) return json({ ok: false, error: `Provide exactly ${QUESTION_COUNT} questions.` }, 400);
    const items: { q: string; a: string }[] = [];
    for (const it of raw) {
      const q = String((it && (it as Record<string, unknown>).q) ?? "").trim();
      const a = normAnswer(it && (it as Record<string, unknown>).a);
      if (q.length < Q_MIN || q.length > Q_MAX) return json({ ok: false, error: "Each question must be 3–120 characters." }, 400);
      if (a.length < A_MIN) return json({ ok: false, error: `Each answer must be at least ${A_MIN} characters.` }, 400);
      items.push({ q, a });
    }
    const { error } = await admin.rpc("recovery_set", { p_user: user.id, p_username: username, p_items: items });
    if (error) return json({ ok: false, error: "Could not save recovery questions." }, 500);
    return json({ ok: true });
  }

  if (action === "status") {
    const user = await requireUser();
    if (!user) return json({ ok: false, error: "Not authenticated." }, 401);
    const { data } = await admin.from("account_recovery").select("questions").eq("user_id", user.id).maybeSingle();
    const questions = (data?.questions as { q: string }[] | undefined || []).map((x) => x.q);
    return json({ ok: true, has_questions: questions.length > 0, count: questions.length, needed: NEEDED, question_count: QUESTION_COUNT, questions });
  }

  // ---- Unauthenticated actions (the forgot-password flow) ----
  if (action === "get_questions") {
    const username = String(body.username || "").trim();
    if (!username) return json({ ok: false, error: "Enter your username." }, 400);
    const { data } = await admin.from("account_recovery").select("questions").ilike("username", username).maybeSingle();
    const questions = (data?.questions as { q: string }[] | undefined || []).map((x) => x.q);
    if (!questions.length) return json({ ok: false, error: "No recovery questions are set for that account." }, 404);
    return json({ ok: true, needed: NEEDED, questions });
  }

  if (action === "recover") {
    const username = String(body.username || "").trim();
    const newPassword = String(body.new_password || "");
    if (!username) return json({ ok: false, error: "Enter your username." }, 400);
    if (newPassword.length < PW_MIN) return json({ ok: false, error: `New password must be at least ${PW_MIN} characters.` }, 400);
    const answers = Array.isArray(body.answers) ? (body.answers as unknown[]).map(normAnswer) : [];
    const { data: row } = await admin.from("account_recovery").select("user_id").ilike("username", username).maybeSingle();
    if (!row?.user_id) return json({ ok: false, error: "No recovery questions are set for that account." }, 404);

    const { data: r, error } = await admin.rpc("recovery_verify", {
      p_user: row.user_id, p_answers: answers, p_needed: NEEDED, p_max_fail: MAX_FAIL, p_lock_minutes: LOCK_MINUTES,
    });
    if (error) return json({ ok: false, error: "Recovery failed." }, 500);
    const res = r as { status?: string; remaining?: number; until?: string };
    if (res?.status === "locked") return json({ ok: false, error: "Too many incorrect attempts. Try again later.", code: "locked" }, 429);
    if (res?.status === "none") return json({ ok: false, error: "No recovery questions are set for that account." }, 404);
    if (res?.status !== "ok") {
      return json({ ok: false, error: `Not enough answers were correct (need ${NEEDED}).`, code: "fail", remaining: res?.remaining }, 401);
    }
    const { error: upErr } = await admin.auth.admin.updateUserById(row.user_id as string, { password: newPassword });
    if (upErr) return json({ ok: false, error: "Answers verified, but the password couldn't be reset. Try again." }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
