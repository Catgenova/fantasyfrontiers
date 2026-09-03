// Fantasy Frontiers -- in-game bug / feedback ticket relay.
//
// WHY THIS EXISTS (Mr Cookie's request, 2026-08-19, "Great idea!" from the owner): an onsite ticket button
// that submits bugs. The ticket system lives on Discord, so a report has to reach a Discord channel -- but
// the webhook must NEVER ship in index.html (it is served to every player in clear text; a pentest already
// found the community-feed webhook that way). So the client posts a STRUCTURED report here and this function,
// holding the webhook as an edge-function secret, composes and delivers the message.
//
// The trust model mirrors discord_feed exactly:
//   * a JWT is required                 -> anonymous spam is gone entirely
//   * rl_hit per user                   -> a logged-in griefer is rate-bounded to a trickle
//   * the SERVER owns the template      -> the author line, headers and layout are fixed here
//   * the author name comes from the caller's PROFILE, never the body -> no impersonation
//   * allowed_mentions parse:[] is pinned here -> the report can never ping @everyone/@here or a role/user,
//     whatever the text contains, so the message body does not need @ stripped to be safe
// A report is CLAIMED, not proven -- the server does not verify the bug is real. That is fine: a bug ticket
// is meant to be human-triaged, and the controls above bound abuse to "a signed-in player wrote some text".
//
// Verify JWT must be OFF for this function (the publishable/anon key the client sends is not a JWT; the
// caller's token is validated internally with admin.auth.getUser). Deploy with --no-verify-jwt.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Reports per user. Tighter than the cosmetic feed: a genuine bug-hunting session files a handful, and this
// keeps a spammer from flooding the triage channel.
const RL_PER_HOUR = 6;
const RL_PER_DAY = 20;

const MSG_MIN = 8;        // a report shorter than this is almost never actionable (mirrors index.html)
const MSG_MAX = 1000;     // the report body
const CTX_MAX = 220;      // the client-gathered diagnostics line (tab / class / total level / user agent)
const VER_MAX = 24;       // a game version string like "0.1.2.3"
const AUTHOR_MAX = 32;

// Categories the client offers. Anything else collapses to "other". Each carries a header glyph, a label,
// and an embed colour so the triage channel can be skimmed at a glance.
const CATS: Record<string, { label: string; emoji: string; color: number }> = {
  bug:        { label: "Bug",        emoji: "🐞", color: 0xd9534f },
  balance:    { label: "Balance",    emoji: "⚖️", color: 0xe0a800 },
  suggestion: { label: "Suggestion", emoji: "💡", color: 0x5bc0de },
  other:      { label: "Other",      emoji: "📝", color: 0x8a8a8a },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---- Text sanitising -------------------------------------------------------------------------------
// Unlike the feed (which allowlists a tiny set of code points because its fields are terse item names), a
// bug report is prose the triager has to READ, so this KEEPS letters/digits/punctuation and, for the body,
// newlines. What it removes is the injection/void surface: control characters, and the zero-width / bidi
// tricks that can hide or reorder text. It does NOT strip '@' or markdown -- pings are neutralised by
// allowed_mentions at the relay, and markdown only restyles the reporter's own words inside their embed.
function isJunkCp(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return true;                 // C0 controls + DEL (newline handled by caller)
  if (cp >= 0x80 && cp <= 0x9f) return true;                 // C1 controls
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return true; // zero-width + BOM
  if (cp >= 0x202a && cp <= 0x202e) return true;             // bidi embeddings/overrides
  if (cp >= 0x2066 && cp <= 0x2069) return true;             // bidi isolates
  return false;
}
function clean(raw: unknown, max: number, multiline: boolean): string {
  let src = String(raw ?? "").normalize("NFKC").replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of src) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a) { out += multiline ? "\n" : " "; continue; }
    if (isJunkCp(cp)) continue;
    out += ch;
  }
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return out.slice(0, max);
}
// The author line is placed inside bold in the server template, so strip the few characters that could
// unbalance that emphasis or open a code span. Usernames are alphanumeric by registration, so this is
// belt-and-braces.
function cleanAuthor(raw: unknown): string {
  return clean(raw, AUTHOR_MAX, false).replace(/[*_`~|]/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhook = Deno.env.get("DISCORD_BUGS_WEBHOOK");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  // As in discord_feed, the missing-webhook check is deferred to the very end: auth, rate limit and
  // validation all run first, so the request path is testable before the secret is live and an anonymous
  // caller cannot probe whether the webhook is configured.

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authData?.user) return json({ ok: false, error: "Not authenticated." }, 401);
  const user = authData.user;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  // ---- Rate limit (Postgres rl_hit). Fail-open if the limiter is down, like the feed. ---------------
  try {
    const { data: overHour } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "bug_report_h", p_limit: RL_PER_HOUR, p_window_secs: 3600 });
    if (overHour === true) return json({ ok: false, error: "You have sent a lot of reports. Please try again later." }, 429);
    const { data: overDay } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "bug_report_d", p_limit: RL_PER_DAY, p_window_secs: 86400 });
    if (overDay === true) return json({ ok: false, error: "Daily report limit reached. Please try again tomorrow." }, 429);
  } catch { /* limiter unavailable -> allow */ }

  // ---- Author: from the caller's profile, NEVER the body (anti-impersonation) ---------------------
  const { data: prof } = await admin.from("profiles").select("username").eq("id", user.id).maybeSingle();
  const author = cleanAuthor(prof?.username) || "A player";

  // ---- Validate + sanitise the report -------------------------------------------------------------
  const message = clean(body.message, MSG_MAX, true);
  if (message.length < MSG_MIN) return json({ ok: false, error: "Please add a little more detail." }, 400);
  const catKey = String(body.category || "other");
  const cat = CATS[catKey] || CATS.other;
  const version = clean(body.version, VER_MAX, false);
  const context = clean(body.context, CTX_MAX, false);

  // ---- Compose the message SERVER-SIDE ------------------------------------------------------------
  // The header, fields and layout are fixed here; only the report body and the diagnostics come from the
  // caller, both sanitised. The report goes in an embed description (visually contained) and the metadata
  // in fields, so a triager sees who/what/version at a glance.
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Category", value: cat.label, inline: true },
    { name: "Version", value: version || "unknown", inline: true },
  ];
  if (context) fields.push({ name: "Context", value: context.slice(0, 1024), inline: false });
  // The account id is included so the team can correlate a report with the account for follow-up or
  // moderation. It only ever appears in the private ticket channel, never to other players.
  fields.push({ name: "Account", value: user.id, inline: false });

  const payload = {
    content: cat.emoji + " New **" + cat.label + "** report from **" + author + "**",
    embeds: [{
      description: message.slice(0, 4000),
      color: cat.color,
      fields,
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] as string[] },
  };

  // ---- Relay --------------------------------------------------------------------------------------
  // A missing webhook must not surface to the player as a hard failure. Unlike the cosmetic feed, though, a
  // report the player TYPED deserves honest handling: report posted:false so the caller can tell delivery
  // apart, while still returning ok:true (the report was accepted and validated). The owner sets
  // DISCORD_BUGS_WEBHOOK for delivery to begin.
  if (!webhook) return json({ ok: true, posted: false, reason: "bugs_disabled" });

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return json({ ok: false, error: "Could not deliver the report. Please try again shortly." }, 502);
  } catch {
    return json({ ok: false, error: "Could not deliver the report. Please try again shortly." }, 502);
  }
  return json({ ok: true, posted: true });
});
