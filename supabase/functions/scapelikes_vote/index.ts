// Fantasy Frontiers — Scapelikes vote webhook receiver.
//
// Scapelikes (the game-listing / voting site) POSTs a signed webhook here every time a player votes for
// Fantasy Frontiers with an identifier supplied. On a VERIFIED vote we extend the shared server-wide
// 'exp' buff (+50% XP for everyone) by 10 minutes via `server_buff_extend('exp', 600)`. There is no
// per-player payout — the reward is the server buff — so the player-facing effect is simply that the
// "+50% EXP" top-bar timer every client already renders ticks up by 10 minutes.
//
// SECURITY MODEL. The reward helps the whole server, so an unauthenticated caller must never be able to
// trigger it. The gate is Scapelikes' HMAC signature (per their spec, docs v1.4.0):
//   * X-Scapelikes-Signature: sha256=<hex of HMAC-SHA256(raw_body, webhook_secret)>
//   * verified over the RAW request bytes, constant-time, before anything else happens.
// We also require event === "vote", schema_version === "1.0", and the configured game slug, and we make
// the grant IDEMPOTENT on webhook_id (Scapelikes retries on any non-2xx or timeout). Only after the buff
// extend is safely recorded do we return 2xx — a failure returns 5xx so Scapelikes retries.
//
// SECRETS (edge-function secrets, never in index.html — the webhook secret is write-access to the server
// buff for anyone who has it):
//   * SCAPELIKES_WEBHOOK_SECRET — the dashboard-generated signing secret.
//   * SCAPELIKES_GAME_SLUG      — our public Scapelikes slug; the webhook's game.slug must match it.
//   * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — standard.
//
// DEPLOY: this endpoint is called by Scapelikes, which does NOT send a Supabase JWT, so it MUST be
// deployed with JWT verification OFF:  supabase functions deploy scapelikes_vote --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUFF_KIND = "exp";       // reuse the existing +50% EXP server buff (owner decision, 2026-08-16)
const BUFF_SECONDS = 600;      // one vote = +10 minutes for the whole server
const SCHEMA_VERSION = "1.0";  // Scapelikes webhook schema we understand
const MAX_BODY = 16 * 1024;    // a vote payload is tiny; refuse anything larger than 16 KiB

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Constant-time hex-string compare (equal length required; lengths differ -> not equal).
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// HMAC-SHA256(raw, secret) as lowercase hex.
async function hmacSha256Hex(raw: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const bytes = new Uint8Array(mac);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Verify Scapelikes' X-Scapelikes-Signature ("sha256=<hex>") against HMAC-SHA256 of the raw body.
async function verifySignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const m = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!m) return false;
  const provided = m[1].toLowerCase();
  const expected = await hmacSha256Hex(rawBody, secret);
  return timingSafeEqualHex(provided, expected);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const secret = Deno.env.get("SCAPELIKES_WEBHOOK_SECRET");
  const expectedSlug = Deno.env.get("SCAPELIKES_GAME_SLUG");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Fail CLOSED if the signing secret is missing: without it we cannot authenticate the caller, and an
  // unauthenticated caller must never move the server buff. (Contrast the rate limiter, which fails open.)
  if (!secret || !expectedSlug || !supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "Webhook not configured." }, 500);
  }

  // Read the RAW body once — the signature is over these exact bytes, so never re-serialize before verify.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return json({ ok: false, error: "Body too large." }, 413);

  if (!(await verifySignature(rawBody, req.headers.get("X-Scapelikes-Signature"), secret))) {
    return json({ ok: false, error: "Bad signature." }, 401);
  }

  let evt: Record<string, unknown>;
  try { evt = JSON.parse(rawBody); } catch { return json({ ok: false, error: "Invalid JSON." }, 400); }

  // Only a vote event of the schema we understand, for OUR game, is actionable. Anything else is ACKed
  // 2xx (so Scapelikes does not retry a delivery we simply do not reward) but changes nothing.
  const event = String(evt.event || "");
  const schema = String(evt.schema_version || "");
  const game = (evt.game && typeof evt.game === "object") ? evt.game as Record<string, unknown> : {};
  const slug = String(game.slug || "");
  if (event !== "vote") return json({ ok: true, ignored: "not_a_vote" });
  if (schema !== SCHEMA_VERSION) return json({ ok: true, ignored: "schema_version" });
  if (slug !== expectedSlug) return json({ ok: true, ignored: "slug" });

  const webhookId = String(evt.webhook_id || "");
  if (!webhookId) return json({ ok: false, error: "Missing webhook_id." }, 400);
  const vote = (evt.vote && typeof evt.vote === "object") ? evt.vote as Record<string, unknown> : {};
  const identifier = String(vote.identifier || "");
  const votedAtRaw = vote.last_voted_at_utc;
  const votedAt = (typeof votedAtRaw === "string" && votedAtRaw) ? votedAtRaw : null;

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Idempotency: record this webhook_id. TRUE only when THIS call was the first to see it. A retry gets
  // FALSE and we ack 2xx without re-extending the buff (grant at most one reward per webhook_id).
  const { data: isNew, error: recErr } = await admin.rpc("scapelikes_vote_record", {
    p_webhook_id: webhookId, p_identifier: identifier, p_voted_at: votedAt,
  });
  if (recErr) return json({ ok: false, error: "Record failed." }, 500);   // 5xx -> Scapelikes retries
  if (isNew !== true) return json({ ok: true, duplicate: true });          // already rewarded this vote

  // Extend the shared +50% EXP buff by 10 minutes. If it fails, undo the idempotency record so the retry
  // can re-process, and return 5xx so Scapelikes retries.
  const { data: until, error: buffErr } = await admin.rpc("server_buff_extend", {
    p_kind: BUFF_KIND, p_seconds: BUFF_SECONDS,
  });
  if (buffErr || !until) {
    await admin.rpc("scapelikes_vote_unrecord", { p_webhook_id: webhookId });
    return json({ ok: false, error: "Reward failed." }, 500);
  }

  return json({ ok: true, kind: BUFF_KIND, seconds: BUFF_SECONDS, active_until: until });
});
