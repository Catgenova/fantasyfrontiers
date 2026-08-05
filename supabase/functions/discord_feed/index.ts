// Fantasy Frontiers — community Discord feed relay.
//
// WHY THIS EXISTS (pentest finding, 2026-07-31): the feed webhook URL was a plain string literal in
// index.html (`DISCORD_FEED_WEBHOOK`), so it shipped to every player and sat in the deployed build in
// clear text. A webhook token is write access to that channel for ANYONE who greps the page:
//   * post arbitrary content as the feed bot (spam, slurs, scam links),
//   * ping @everyone (the client's allowed_mentions guard is the CLIENT's, not the webhook's),
//   * override username/avatar_url per post, i.e. impersonate a player or a moderator,
//   * forge "X forged a Fantastic Y" events, destroying the feed's value as a record,
//   * DELETE the webhook outright (DELETE /webhooks/{id}/{token} needs only the token).
// The URL is now an edge-function secret and the client posts STRUCTURED EVENTS here instead of text.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. The game is client-authoritative for crafting -- the server
// never simulates a forge -- so this cannot PROVE an event happened. It bounds the damage instead:
//   * a JWT is required             -> anonymous spam is gone entirely
//   * rl_hit per user               -> a logged-in griefer is rate-bounded
//   * the SERVER owns the template  -> no arbitrary content, no mentions, no username/avatar override
//   * the display name comes from the caller's profile, never the body -> no impersonation
//   * item_key is checked against public.item_catalog -> made-up item keys are refused
// Verifying that the caller actually OWNS the item means cross-checking public.saves; that is a separate
// (deliberately deferred) step. `enhance` here is CLAIMED, range-checked, and not proven.
//
// Verify JWT must be OFF (the publishable key isn't a JWT; the caller's token is validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Posts per user. Deliberately generous against real play -- a big offline catch-up can legitimately roll
// several Fantastic creations at once -- while bounding a logged-in griefer to a trickle.
const RL_PER_HOUR = 30;
const RL_PER_DAY = 120;

const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const ENHANCE_MIN = 15;   // mirrors index.html DISCORD_ENHANCE_MIN (owner order 2026-08-05: only a maxed +15 is blast-worthy; +11 to +14 no longer trigger)
const ENHANCE_MAX = 15;   // the enhance ceiling; above this is impossible, so refuse it
const MAX_NAME = 80;      // an item display name
const MAX_STATS = 320;    // the " (stat · stat · ...)" tail

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---- Text sanitising -------------------------------------------------------------------------------
// The item NAME and the STATS tail are the only free-ish text in a post, because both are derived from
// client-side game tables (enchant lines, material bonuses, tool tier data) that do not exist server-side.
// Everything structural about the message -- the verb, the emphasis, the offline tag, the author -- is
// built here, so these two fields are the whole injection surface. See the allowlist below.
// Permitted characters, as CODE POINTS rather than a regex class. Two reasons: an allowlist of code points
// cannot be corrupted by a copy-paste that strips invisible characters (a lost range endpoint in
// /[\x00-\x1f...]/ would silently change what the filter matches), and it is auditable by reading.
// Everything not listed becomes a space -- dropped, never escaped -- which removes mentions, links,
// newlines, code fences, and every zero-width / bidi trick in one pass, whatever Discord renders next.
const ALLOW_EXTRA = new Set<number>([
  0x20,           // space
  0x2b,           // +
  0x2d,           // - (hyphen)
  0x25,           // %
  0x2e, 0x2c,     // . ,
  0x27,           // ' (apostrophe)
  0x28, 0x29,     // ( ) -- inner stat parentheses, e.g. "Damage 100-200 (+12)"
  0x2f,           // /
  0x00b7,         // middle dot: the stat separator
  0x2013, 0x2014, // en dash / em dash: damage ranges
  0x2019,         // right single quote: names like "Gorewyrm's Edge"
]);
// Deliberately ABSENT, and each for a reason: @ and < > (mentions and mention syntax), ` (code fences),
// * _ ~ | (markdown that could restyle the server's own template), : (custom :emoji: and URL schemes),
// # (channel links), and every letter outside A-Za-z0-9 (so a homoglyph cannot impersonate a name).
function allowedCp(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39)      // 0-9
      || (cp >= 0x41 && cp <= 0x5a)      // A-Z
      || (cp >= 0x61 && cp <= 0x7a)      // a-z
      || ALLOW_EXTRA.has(cp);
}
function clean(raw: unknown, max: number): string {
  const src = String(raw ?? "").normalize("NFKC");
  let s = "";
  // Iterate by code point (not char) so astral characters are rejected whole rather than by surrogate.
  for (const ch of src) s += allowedCp(ch.codePointAt(0) as number) ? ch : " ";
  return s.replace(/ +/g, " ").trim().slice(0, max);
}
// Wrap a sanitised value for bold display. `clean` has already removed '*', so no escaping is needed --
// the value cannot break out of the emphasis it is placed in.
function bold(s: string): string { return "**" + s + "**"; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhook = Deno.env.get("DISCORD_FEED_WEBHOOK");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  // NOTE: the missing-webhook check deliberately does NOT happen here. It used to, and that made every
  // call -- unauthenticated, malformed, rate-limited, whatever -- return the same feed_disabled reply, which
  // (a) let an anonymous caller probe whether the feed is configured, and (b) made the whole request path
  // untestable until the secret was live: a validation test could not tell "correctly refused" from "feed
  // off". Auth, rate limit, validation and sanitising all run first now; only the final HTTP post is
  // skipped. See the relay at the bottom.

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authData?.user) return json({ ok: false, error: "Not authenticated." }, 401);
  const user = authData.user;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  // ---- Rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down. --
  try {
    const { data: overHour } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "discord_feed_h", p_limit: RL_PER_HOUR, p_window_secs: 3600 });
    if (overHour === true) return json({ ok: false, error: "Too many requests." }, 429);
    const { data: overDay } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "discord_feed_d", p_limit: RL_PER_DAY, p_window_secs: 86400 });
    if (overDay === true) return json({ ok: false, error: "Too many requests." }, 429);
  } catch { /* limiter unavailable -> allow */ }

  // ---- Author: from the caller's profile, NEVER the body -----------------------------------------
  // This is the anti-impersonation control. A caller cannot claim to be someone else, and cannot post at
  // all without a game profile (which every real player has).
  const { data: prof } = await admin.from("profiles").select("username").eq("id", user.id).maybeSingle();
  const author = clean(prof?.username, 32);
  if (!author) return json({ ok: false, error: "No profile." }, 403);

  // ---- Clamped accounts do not broadcast ----------------------------------------------------------
  // An account under an economy clamp is, by definition, one whose reported progress we do not trust.
  // Silently ok so a clamped cheater learns nothing from the response.
  try {
    const { data: clamp } = await admin.from("account_clamps").select("clamped_until").eq("user_id", user.id).maybeSingle();
    if (clamp?.clamped_until && new Date(clamp.clamped_until).getTime() > Date.now()) return json({ ok: true, posted: false, reason: "clamped" });
  } catch { /* no clamp table / not clamped -> continue */ }

  // ---- Validate the event ------------------------------------------------------------------------
  const kind = String(body.kind || "");
  const itemKey = String(body.item_key || "");
  const rarity = String(body.rarity || "");
  const name = clean(body.name, MAX_NAME);
  const stats = clean(body.stats, MAX_STATS);
  const offline = body.offline === true;
  if (!name) return json({ ok: false, error: "Invalid event." }, 400);

  // item_key is OPTIONAL, and this is a real limitation rather than an oversight. Three of the four feed
  // events carry a catalogued inventory key, but two do not exist as inventory items at all: typed weapons
  // (state.weaponTiers, keyed by typeId) and minted set pieces / legendaries (uniques keyed by uid). So a
  // missing key cannot be treated as an error without dropping those posts.
  //
  // Consequently the catalog check below is DEFENCE IN DEPTH, not a boundary: `name` is client-supplied
  // (sanitised) text, so a caller with a valid JWT can already name a nonexistent item whatever the key
  // says. What actually bounds abuse here is the JWT + rate limit + server-owned template. Proving the
  // item is real AND owned requires the public.saves cross-check, which is deliberately not in this pass.
  if (itemKey) {
    if (!KEY_RE.test(itemKey)) return json({ ok: false, error: "Invalid item." }, 400);
    try {
      // Same allowlist the ledger and marketplace use (migration 20260724120000), and likewise a no-op
      // while that table is empty, so this cannot break before the seed is loaded.
      const { count: total } = await admin.from("item_catalog").select("item_key", { count: "exact", head: true });
      if ((total ?? 0) > 0) {
        const { count } = await admin.from("item_catalog").select("item_key", { count: "exact", head: true }).eq("item_key", itemKey);
        if ((count ?? 0) === 0) return json({ ok: false, error: "Unknown item." }, 400);
      }
    } catch { /* catalog unreadable -> don't block the feed on it */ }
  }

  // ---- Compose the message SERVER-SIDE -----------------------------------------------------------
  // The client sends no prose. Every template below is fixed here, so the set of shapes a post can take
  // is closed: an attacker with a valid JWT can pick one of four sentences about a real item, nothing more.
  const tail = stats ? " (" + stats + ")" : "";
  const offlineTag = offline ? " *(offline catch-up)*" : "";
  let content = "";
  if (kind === "forge" || kind === "relic") {
    // The feed's whole premise is that these posts are RARE, so the rarity is checked twice over: the
    // claimed rarity must be fantastic, AND -- when the item has a catalogued key -- the key's own suffix
    // must agree. The suffix is the stronger of the two (it is server-side data), which is why it is
    // enforced whenever a key is present rather than trusting `rarity` alone.
    if (rarity !== "fantastic") return json({ ok: false, error: "Not a feed-worthy item." }, 400);
    if (itemKey && !/_fantastic$/.test(itemKey)) return json({ ok: false, error: "Rarity does not match the item." }, 400);
    const verb = kind === "relic" ? "recovered a" : "forged a";
    content = "🌟 " + bold(author) + " " + verb + " " + bold(name) + "!" + tail + offlineTag;
  } else if (kind === "mastercraft") {
    content = "🌟 " + bold(author) + " mastercrafted the " + bold(name) + "!" + tail + offlineTag;
  } else if (kind === "enhance") {
    // CLAIMED, not proven -- range-checked only. Proving it needs the save cross-check.
    const enh = Math.floor(Number(body.enhance));
    if (!isFinite(enh) || enh < ENHANCE_MIN || enh > ENHANCE_MAX) return json({ ok: false, error: "Invalid enhance." }, 400);
    content = "⚒️ " + bold(author) + " enhanced their " + bold(name) + " to " + bold("+" + enh) + "!" + tail + offlineTag;
  } else {
    return json({ ok: false, error: "Unknown event." }, 400);
  }

  // ---- Relay ------------------------------------------------------------------------------------
  // allowed_mentions is pinned here where the caller cannot reach it, and username/avatar_url are never
  // forwarded, so a post can neither ping nor wear someone else's identity.
  // Everything above has passed: the caller is authenticated, under their rate limit, and the message has
  // been validated and composed. Only the delivery is optional. Reporting ok:true here is deliberate -- the
  // feed is cosmetic and a missing webhook must never surface to a player as a gameplay failure -- and
  // `reason` names the cause so a smoke test can tell it apart from a refusal.
  if (!webhook) return json({ ok: true, posted: false, reason: "feed_disabled" });

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) return json({ ok: false, error: "Feed unavailable." }, 502);
  } catch {
    return json({ ok: false, error: "Feed unavailable." }, 502);
  }
  return json({ ok: true, posted: true });
});
