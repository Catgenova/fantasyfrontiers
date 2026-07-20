// Fantasy Frontiers — cloud save writer.
// Clients read their save directly (RLS-guarded select on public.saves), but WRITE
// through here so we can enforce a freshness guard: a device holding an older save
// can't overwrite a newer one already in the cloud (prevents multi-device clobbering).
// Identity comes from the auth token, never the body.
//
// SESSION FENCING (migration 20260720140000): the forward-only progress guard stops a REGRESSION, but
// not two live sessions. Two browsers on one account are two independent simulations pushing full blobs
// every 8s, and the higher-XP blob wins wholesale -- which is how a 10-minute estate cooldown could be
// bypassed in a second window, and how combat drops were collected twice. So each tab claims the save
// with a random session id, and a write from a session that no longer holds the claim is refused.
//
// Rollout-safe by construction:
//   * a request with NO session_id is never fenced  -> an old client keeps working after this deploys
//   * a row with a NULL active_session is never fenced -> nothing breaks before the first claim
// That also means the fence is not a security boundary (a crafted request can simply omit session_id).
// It is a correctness measure for real players running two windows; the economy stays guarded by the
// wallet/item ledgers. Once clients have rolled out, requiring session_id is the phase-2 tightening.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_BYTES = 500_000; // keep under the table's ~512KB column guard
// Absolute ceiling on the stored progress score. Far above any real play, but FINITE: an unbounded
// value pinned the row's progress so high that every later legitimate save was rejected as stale,
// which locked the account out of saving entirely.
const MAX_PROGRESS = 1_000_000_000_000_000; // 1e15
// How long a claim keeps fencing after its holder's last write. A live client pushes at least every 8s
// (CLOUD_PUSH_INTERVAL), so anything past this means the tab is closed, asleep or gone -- and holding the
// account hostage to a dead tab is worse than the rare double-session this guards against.
const STALE_CLAIM_MS = 45_000;

// Derive the progress score from the SUBMITTED SAVE instead of trusting a client-sent number.
// Previously `progress` was read straight off the body with only a `>= 0` floor, so a request could
// claim an arbitrarily large value, sail past the forward-only guard forever, and (because the guard
// only ever compares against the stored number) keep doing so. Mirrors the client's
// saveProgressScore(): the sum of all skill XP + physique XP.
function deriveProgress(d: Record<string, unknown>): number {
  let total = 0;
  for (const key of ["xp", "physique"]) {
    const m = d[key];
    if (m && typeof m === "object" && !Array.isArray(m)) {
      for (const v of Object.values(m as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) total += n;
      }
    }
  }
  if (!Number.isFinite(total) || total < 0) total = 0;
  return Math.min(MAX_PROGRESS, Math.floor(total));
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

  // Identity from token.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;
  // Volume rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down.
  try { const { data: _over } = await admin.rpc("rl_hit", { p_subject: userId, p_bucket: "save_game", p_limit: 60, p_window_secs: 60 }); if (_over === true) return json({ ok: false, error: "Too many requests." }, 429); } catch { /* limiter unavailable -> allow */ }

  // Parse.
  let body: { data?: unknown; client_saved_at?: unknown; progress?: unknown; force?: unknown; session_id?: unknown; action?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  const sessionId = (typeof body.session_id === "string" && body.session_id.length > 0 && body.session_id.length <= 64)
    ? body.session_id : "";

  // action:"claim" -- take ownership of the save without writing any data. Sent once on load, before the
  // client has anything new to push. Last claim wins, which is what makes opening a second window take
  // over and freeze the first rather than letting both simulate.
  if (body.action === "claim") {
    if (!sessionId) return json({ ok: false, error: "Missing session." }, 400);
    // Only claims an EXISTING row. A brand-new account has no save yet; its first real write claims
    // implicitly (see the upsert below), so there is nothing to do here.
    const { data: row } = await admin.from("saves").select("version").eq("user_id", userId).maybeSingle();
    // Stamp updated_at too: a fresh claim must immediately look "live", or a third tab arriving seconds
    // later would see a stale timestamp and take the save straight back off this one.
    if (row) await admin.from("saves").update({ active_session: sessionId, updated_at: new Date().toISOString() }).eq("user_id", userId);
    return json({ ok: true, claimed: true, version: row?.version ?? 0 });
  }

  const data = body.data;
  if (typeof data !== "object" || data === null) return json({ ok: false, error: "Invalid save." }, 400);
  const savedAt = typeof body.client_saved_at === "number" && Number.isFinite(body.client_saved_at)
    ? Math.floor(body.client_saved_at) : 0;
  // NOTE: body.progress is deliberately IGNORED -- it's computed from `data` below. Accepting it was
  // the reported hole (no upper bound), and a client-declared score can always disagree with the save
  // it claims to describe.
  const progress = deriveProgress(data as Record<string, unknown>);
  const force = body.force === true;
  if (JSON.stringify(data).length > MAX_BYTES) return json({ ok: false, error: "Save too large." }, 413);

  // Forward-only PROGRESS guard: never let a lower-progress state overwrite a higher one
  // (this is what stops an empty/regressed save from clobbering real progress).
  const { data: prev } = await admin.from("saves")
    .select("progress, version, active_session, updated_at").eq("user_id", userId).maybeSingle();
  const prevProgress = prev?.progress ?? 0;

  // Session fence. Deliberately returns HTTP 200 with { fenced:true } rather than a 4xx: cloudSave runs
  // every 8s on the client's hot path, and supabase-js turns a non-2xx into a FunctionsHttpError whose
  // body must be read back off error.context -- extra async work on every push just to learn a flag.
  // The existing `stale` 409 is already ignored client-side for the same reason.
  //
  // A claim only fences while its holder is STILL WRITING. Reported live: a player closed every other tab
  // and was still locked out, because active_session persisted forever with nothing to expire it -- a dead
  // tab fenced them out of their own account permanently. A live client pushes at least every 8s, so if
  // the holder has gone quiet for STALE_CLAIM_MS it is not playing and the newcomer silently takes over.
  if (sessionId && prev?.active_session && prev.active_session !== sessionId) {
    const lastWrite = prev.updated_at ? Date.parse(prev.updated_at as string) : 0;
    const quietFor = Date.now() - (Number.isFinite(lastWrite) ? lastWrite : 0);
    if (quietFor < STALE_CLAIM_MS) {
      return json({ ok: false, fenced: true, error: "This account is open in another window." });
    }
    // else: fall through and let this session take the save over (the upsert below re-stamps the claim).
  }
  // `force` exists for a deliberate RESET, which by definition LOWERS progress. It must never be a
  // way to push progress UP -- otherwise it's a blanket bypass of the guard for anyone who sets the
  // flag, which is exactly what a client-controlled override becomes.
  if (prev && progress < prevProgress && !force) {
    return json({ ok: false, stale: true, server_progress: prevProgress }, 409);
  }

  const nextVersion = (prev?.version ?? 0) + 1;
  const record: Record<string, unknown> = {
    user_id: userId,
    data,
    version: nextVersion,
    progress,
    client_saved_at: savedAt,
    updated_at: new Date().toISOString(),
  };
  // An accepted write (re)asserts the claim, so a brand-new account's first save claims implicitly and a
  // reconnecting tab doesn't need a separate claim round-trip. Omitted when the client sent no session_id,
  // so an old client never clears a newer client's claim.
  if (sessionId) record.active_session = sessionId;
  const { error: upErr } = await admin.from("saves").upsert(record, { onConflict: "user_id" });
  if (upErr) {
    const msg = (upErr.message || "").toLowerCase();
    if (msg.includes("saves_size_chk") || msg.includes("check constraint")) return json({ ok: false, error: "Save too large." }, 413);
    return json({ ok: false, error: "Could not save." }, 500);
  }
  return json({ ok: true, version: nextVersion });
});
