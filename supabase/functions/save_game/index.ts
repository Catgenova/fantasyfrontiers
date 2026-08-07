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
// The wallet is the authoritative gold store (HARD_CAP 1e15 there); a legit balance never exceeds it.
// The save blob, though, was stored VERBATIM, so a tampered `data.gold` (e.g. a memory/localStorage edit)
// persisted at face value -- surviving the round-trip, showing up as an absurd balance, AND feeding the
// wallet's first-touch seed (ensureWallet reads saves.data.gold). Clamp it here so a tampered value can
// never be stored or laundered into a real wallet seed. Legit gold is unaffected (already <= this).
const GOLD_CAP = 1_000_000_000_000_000; // 1e15, mirrors the wallet's HARD_CAP
// How long a claim keeps fencing after its holder's last write. A live client pushes at least every 8s
// (CLOUD_PUSH_INTERVAL), so anything past this means the tab is closed, asleep or gone -- and holding the
// account hostage to a dead tab is worse than the rare double-session this guards against.
const STALE_CLAIM_MS = 45_000;

// ---- Auto-detection (account clamps; see migrations 20260724210000 / 220000) ----
// ENFORCING: a tripped signal is recorded AND clamps the account (a review of the shadow signals confirmed
// the threshold has a ~1000x margin over legit play). Set back to false to return to shadow (record-only).
const CLAMP_AUTOENFORCE = true;
// SUPERSEDED REASONING, kept because the mistake is instructive -- do not restore it. The original claim was:
// "a progress jump of 1e10 XP inside a live save window (2s-2min elapsed) is impossible for real play but far
// below an edited save (which lands 1e12-1e15). Per-action XP is capped in the economy (submit_profile: gather
// <=8k, craft <=200k), so a legit ~120s window accrues at most ~1e6-1e7 across all skills -- 1000x under this
// line." Every clause of that is true and the conclusion is still wrong, because it enumerates gathering and
// crafting and silently omits combat. See the block below.
// The window still excludes offline returns, whose elapsed is the whole away-time.
const SIGNAL_MIN_ELAPSED_MS = 2_000;
const SIGNAL_MAX_ELAPSED_MS = 120_000;
const SIGNAL_PROGRESS_JUMP = 10_000_000_000; // 1e10 -- an absolute FLOOR only; see the relative test below
// ---- THE ABSOLUTE THRESHOLD ABOVE WAS MISCALIBRATED, and it clamped the game's strongest account twice in
// one day (Valuren, 31 Jul). The reasoning in the comment block above is sound for GATHERING and CRAFTING and
// omits the channel that actually dominates: deriveProgress sums every xp value, and CLASS XP IS AWARDED 1:1
// WITH COMBAT DAMAGE DEALT (index.html awardClassXp -> addXp(id, effDmg)). So "progress per second" is, to a
// first approximation, the player's DPS -- which is unbounded by design and, after this month's class reworks,
// sits at 1e9-1e11 for an endgame account. Valuren's two clamps were 2.09e9 and 1.70e9 progress/sec: they
// crossed a 1e10 line in under five seconds of ordinary combat, and only the one-signal-per-hour audit
// rate-limit stopped it firing on every 8-second save.
//
// THE SHAPE OF THE FIX IS THE ONE THE ITEM LEDGER ALREADY TAUGHT US: judge a delta against the ACCOUNT'S OWN
// SCALE, never against an absolute number. Absolute thresholds always catch the strongest player first, because
// their legitimate absolute numbers are the largest -- the identical error as "an absolute count of top-rarity
// items" and "fantastic share of lifetime earned_total" (see 20260731200000).
//
// A jump must now exceed BOTH tests to signal:
//   1. the absolute floor (so small accounts and rounding noise never generate signals), AND
//   2. a share of prior progress proportional to elapsed time -- SIGNAL_JUMP_RATE_PER_SEC.
// Because progress is roughly proportional to power, the FRACTIONAL rate is roughly scale-invariant, so one
// number fits every account. Valuren's real play measures 0.21%/s and 0.17%/s; 5%/s leaves a ~25x margin at
// any window length, while an edited save (the reported profile lands 1e12-1e15) is hundreds to millions of
// times over. It still catches a save that merely DOUBLES progress inside one window.
//
// WHAT THIS DOES NOT CLOSE, stated plainly: a patient editor who keeps each jump under the line. That was
// ALREADY true of the absolute test -- staying under 1e10 per save was always enough -- so the relative test
// opens no new hole; it removes a false-positive class. The real bound on the economy is the per-action XP cap
// in submit_profile, not this detector.
// WHY A SINGLE RATE FITS EVERY ACCOUNT, and where it is thin. Progress accumulates AT the combat rate, so after
// t seconds of cumulative combat at damage D, progress is ~D*t and the fractional rate is D/(D*t) = 1/t. The
// allowance is therefore only ever tight for accounts with very little playtime -- and those are excluded by the
// absolute floor anyway. The one genuinely thin case is a player whose POWER jumps suddenly (a best-in-slot
// upgrade): their current damage briefly outruns their accumulated XP. At 5%/s an account pushing ten times
// Valuren's measured rate still has 2.5x of headroom, which is why this is worth watching during the shadow
// week rather than asserting is safe. Verified arithmetic, all nine cases as intended: Valuren's two real
// clamps clear by 23x and 30x, a 120s window at his rate clears by 24x, and a save that merely DOUBLES progress
// is still caught 2.5x over.
const SIGNAL_JUMP_RATE_PER_SEC = 0.05;          // allowed growth: 5% of prior progress per second of elapsed
const SIGNAL_RELATIVE_MIN_PROGRESS = 1_000_000_000; // below 1e9 prior progress there is no scale to measure
                                                    // against, so the absolute floor stands alone there
// Progress-jump enforcement is SEPARATE from CLAMP_AUTOENFORCE and starts OFF. This detector has now produced
// two confirmed false positives against a real, active player, so it goes back to shadow (record-only) until a
// week of signals under the relative test comes back clean. The gold-injection clamp below keeps enforcing --
// its threshold is age-gated and has never misfired. Precedent: the unexplained-rarity sweep shipped
// shadow-only for exactly this reason.
const PROGRESS_JUMP_AUTOENFORCE = false;
const CLAMP_INDEFINITE_MS = 5_256_000 * 60_000; // ~10 years, matches the clamp RPC's cap
// Gold-injection HARD CLAMP at the entry point. The exploit lands data.gold / data.goldEarnedTotal HERE;
// a young account (< HARD_CLAMP_MAX_AGE_DAYS) whose save carries >= HARD_CLAMP_GOLD gold OR lifetime
// earnings is injecting -> clamp on the NEXT save push (every ~8s), instead of waiting for a wallet sync.
// Mirrors the wallet earn-path rule; age-gated so it never touches an established account. 500M is the
// full-rate allowance for a whole week -- no legit sub-7-day save reaches it.
const HARD_CLAMP_MAX_AGE_DAYS = 7;
const HARD_CLAMP_GOLD = 500_000_000;
function accountAgeDays(createdAtIso: string | undefined): number {
  return createdAtIso ? Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000) : 0;
}
// Blast-radius ceiling on what a save may STORE for gold AND the lifetime-earned receipt (goldEarnedTotal).
// A sub-7-day account cannot legitimately hold or have earned HARD_CLAMP_GOLD (500M) -- the same
// ~1000x-margin line the injection clamp already uses -- so both are pinned there; established accounts
// (>=7 days) carry legit large balances, bounded only by the absolute GOLD_CAP. This is what makes a
// bug/injection SELF-HEAL: goldEarnedTotal was previously stored RAW, so a stuck receipt survived a reset
// and kept re-authorizing the wallet + re-tripping the clamp. Capped on every write, it can never persist
// beyond the ceiling and decays to it on the next save. NB: never bites a legit young player -- by the
// clamp's own definition none reach 500M in under a week.
function storeCeiling(ageDays: number): number {
  return ageDays < HARD_CLAMP_MAX_AGE_DAYS ? HARD_CLAMP_GOLD : GOLD_CAP;
}
function normNonNeg(v: unknown, cap: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), cap);
}

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

// ---- FORGED-UNIQUE VALIDATION (ticket-0163, AndJustice4All) ---------------------------------------
// Reported and reproduced: a nonexistent uid inserted into the outgoing save was accepted, survived a
// refresh, and came back in a later unmodified save. True -- this function stored `data` verbatim apart
// from the gold clamps, and nothing anywhere in supabase/ ever looked at uniqueItems.
//
// THE REPORTER'S SUGGESTED FIX MUST NOT BE APPLIED. "At minimum, strip data.uniqueItems / uidSeq /
// equipped*Uid before storing" would delete every player's entire kit on their next save: uniqueItems is
// not a cache of server state, it is the ONLY record that any enchanted, enhanced or legendary item
// exists (the server does not simulate crafting -- the same reason item_sync is client-reported).
// Stripping the equip pointers unequips everyone; stripping uidSeq causes id collisions afterwards.
//
// Their second point -- "accept UID references only when the referenced UID belongs to the authenticated
// user" -- has no cross-account dimension here either: these uids live inside the account's own blob and
// are only ever read back to that same account. The property being violated is not ownership, it is
// PROVENANCE: the account can invent items for itself. A literal ownership check would pass trivially and
// look like a fix while changing nothing.
//
// So this validates STRUCTURE instead, which is the part that needs no server-side crafting simulation:
// a unique must name a real catalogue item, its tier/rarity must agree with the key that encodes them,
// its enhance level must be inside the real cap, and it cannot carry more enchant slots than its rarity
// allows. That kills the arbitrary-object class outright at zero cost to legitimate play.
//
// WHAT THIS DELIBERATELY DOES NOT CLOSE, stated plainly:
//   * a CATALOGUE-VALID item that was never earned. That is the provenance gap player_items closes for
//     stackables, and the durable answer is the same batch-validated server-side crafting project.
//     The shadow sweep drafted in migration 20260807140000 is the interim detector for it.
//   * per-enchant ROLL bounds. Those need the ENCHANT_MODS min/max table server-side, and the raw
//     damage lines are tier-scaled rather than fixed, so it is a generated-seed job like item_catalog
//     rather than a constant. Phase 2, and called out so it is not mistaken for covered.
//   * what a memory editor does inside its own session. Equip effects are computed client-side; this
//     stops PERSISTENCE and the guild-bank hand-off to other accounts, which is the reachable target.
const UNIQUE_ENCHANT_SLOTS: Record<string, number> = { normal: 1, rare: 2, supreme: 3, fantastic: 4 };
const UNIQUE_ENHANCE_MAX = 15;                       // mirrors ENHANCE_MAX in index.html
const UNIQUE_BASE_RE = /_t(\d+)_(normal|rare|supreme|fantastic)$/;
const UNIQUE_MAX_AUDIT = 400;                        // bases to check per save; a real pack is far under this
// WARN-ONLY. The findings are logged and signalled; nothing is removed from the save. Turn on only after a
// week of signals reads clean, because the enforcement path DELETES items -- a bounds bug here costs a real
// player their gear, which is precisely the failure mode the reporter's own suggestion would have caused.
const UNIQUE_VALIDATE_ENFORCE = false;

type UniqueFinding = { uid: string; base: string; why: string };

// Structural audit of data.uniqueItems. Returns the findings; the caller decides whether to act.
async function auditUniques(
  admin: ReturnType<typeof createClient>,
  data: Record<string, unknown>,
): Promise<{ findings: UniqueFinding[]; checked: number }> {
  const bag = data.uniqueItems;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return { findings: [], checked: 0 };
  const entries = Object.entries(bag as Record<string, unknown>);
  if (!entries.length) return { findings: [], checked: 0 };

  const findings: UniqueFinding[] = [];
  const shaped: { uid: string; u: Record<string, unknown>; base: string }[] = [];

  // Pass 1: shape and self-consistency, all of it local -- no catalogue needed.
  for (const [uid, raw] of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      findings.push({ uid, base: "", why: "not_an_object" });
      continue;
    }
    const u = raw as Record<string, unknown>;
    const base = typeof u.base === "string" ? u.base : "";
    if (!base) { findings.push({ uid, base: "", why: "no_base" }); continue; }

    const m = UNIQUE_BASE_RE.exec(base);
    if (!m) { findings.push({ uid, base, why: "base_not_tier_rarity_shaped" }); continue; }
    const keyTier = Number(m[1]), keyRarity = m[2];

    // The base key ENCODES tier and rarity, so the object's own fields must agree with it. This is what
    // catches a real base relabelled as fantastic t20: the key is the authority, the fields are a copy.
    if (u.rarity !== undefined && u.rarity !== keyRarity) {
      findings.push({ uid, base, why: `rarity_mismatch:${String(u.rarity)}!=${keyRarity}` });
      continue;
    }
    if (u.tier !== undefined) {
      const t = Number(u.tier);
      if (!Number.isFinite(t) || Math.floor(t) !== keyTier) {
        findings.push({ uid, base, why: `tier_mismatch:${String(u.tier)}!=${keyTier}` });
        continue;
      }
    }
    const enh = u.enhance === undefined ? 0 : Number(u.enhance);
    if (!Number.isFinite(enh) || enh < 0 || Math.floor(enh) !== enh || enh > UNIQUE_ENHANCE_MAX) {
      findings.push({ uid, base, why: `enhance_out_of_range:${String(u.enhance)}` });
      continue;
    }
    if (u.enchants !== undefined) {
      if (!Array.isArray(u.enchants)) {
        findings.push({ uid, base, why: "enchants_not_array" });
        continue;
      }
      const slots = UNIQUE_ENCHANT_SLOTS[keyRarity] || 1;
      if (u.enchants.length > slots) {
        findings.push({ uid, base, why: `enchant_slots:${u.enchants.length}>${slots}` });
        continue;
      }
      // Each line must at least name a mod and carry a finite roll. The per-mod MAX is phase 2 (see above).
      const bad = u.enchants.some((e) => {
        if (!e || typeof e !== "object") return true;
        const mod = (e as Record<string, unknown>).mod;
        const roll = Number((e as Record<string, unknown>).roll);
        return typeof mod !== "string" || !mod || !Number.isFinite(roll) || roll < 0;
      });
      if (bad) { findings.push({ uid, base, why: "enchant_line_malformed" }); continue; }
    }
    shaped.push({ uid, u, base });
  }

  // Pass 2: every surviving base must be a REAL item. item_catalog is the existing allowlist (generated
  // from the client's own catalogue by scripts/dump-item-catalog.mjs and CI-checked against drift), so
  // this needs no new data. Query the DISTINCT bases only -- a pack of 80 uniques is usually ~30 keys.
  const distinct = Array.from(new Set(shaped.map((s) => s.base))).slice(0, UNIQUE_MAX_AUDIT);
  if (distinct.length) {
    const { data: known, error } = await admin.from("item_catalog").select("item_key").in("item_key", distinct);
    // A catalogue read failure must NEVER invent findings -- that would delete real gear once enforcement
    // is on. Fail OPEN here: the structural pass above already ran, and the sweep catches the rest.
    if (!error && known) {
      const ok = new Set((known as { item_key: string }[]).map((r) => r.item_key));
      for (const s of shaped) {
        if (distinct.indexOf(s.base) !== -1 && !ok.has(s.base)) {
          findings.push({ uid: s.uid, base: s.base, why: "base_not_in_catalog" });
        }
      }
    }
  }

  // Dangling equip pointers: harmless on their own (the client just renders nothing) but they are the
  // signature of a hand-edited blob, so they are worth a line in the signal.
  for (const k of ["equippedMainhandUid", "equippedOffhandUid", "equippedRelicUid", "equippedBeltUid"]) {
    const v = data[k];
    if (v != null && v !== "" && !Object.prototype.hasOwnProperty.call(bag as object, String(v))) {
      findings.push({ uid: String(v), base: "", why: `dangling_pointer:${k}` });
    }
  }
  return { findings, checked: entries.length };
}

// Remove the offending uniques and any equip pointer aimed at them. Only ever called with
// UNIQUE_VALIDATE_ENFORCE on -- kept beside the audit so the two can never drift apart.
function stripFindings(data: Record<string, unknown>, findings: UniqueFinding[]): number {
  const bag = data.uniqueItems as Record<string, unknown> | undefined;
  if (!bag) return 0;
  let removed = 0;
  const kill = new Set(findings.filter((f) => !f.why.startsWith("dangling_pointer")).map((f) => f.uid));
  for (const uid of kill) {
    if (Object.prototype.hasOwnProperty.call(bag, uid)) { delete bag[uid]; removed++; }
  }
  for (const k of ["equippedMainhandUid", "equippedOffhandUid", "equippedRelicUid", "equippedBeltUid"]) {
    const v = data[k];
    if (v != null && v !== "" && !Object.prototype.hasOwnProperty.call(bag, String(v))) data[k] = null;
  }
  // Jewelry lives in slots that carry their own uid; clear any that now point at nothing.
  const jew = data.jewelrySlots;
  if (jew && typeof jew === "object" && !Array.isArray(jew)) {
    for (const slot of Object.values(jew as Record<string, unknown>)) {
      if (slot && typeof slot === "object") {
        const s = slot as Record<string, unknown>;
        if (s.uid != null && !Object.prototype.hasOwnProperty.call(bag, String(s.uid))) s.uid = null;
      }
    }
  }
  return removed;
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
  // Normalize the stored gold AND the lifetime-earned receipt (goldEarnedTotal) so a tampered or
  // bug-inflated save blob can neither persist an absurd balance nor seed/authorize the wallet high. Both
  // are bounded by storeCeiling(age): a sub-7-day account is pinned to the 500M injection line, older
  // accounts to the absolute GOLD_CAP. goldEarnedTotal was previously stored RAW -- that let a stuck
  // receipt survive a reset and keep re-authorizing the wallet + re-tripping the clamp, which is the loop
  // this closes. The detection below reads these normalized values (an injector's raw 5B still lands at
  // the 500M ceiling and trips the clamp), and goldEarnedTotal is only touched when the save carries it.
  {
    const ceiling = storeCeiling(accountAgeDays(user.created_at));
    const d = data as Record<string, unknown>;
    d.gold = normNonNeg(d.gold, ceiling);
    if ("goldEarnedTotal" in d) d.goldEarnedTotal = normNonNeg(d.goldEarnedTotal, ceiling);
  }
  // ---- Forged-unique audit (ticket-0163). Runs BEFORE the blob is stored, so enforcement (once it is on)
  // strips the item rather than letting it persist. In warn-only mode nothing is removed. Best-effort by
  // construction: a thrown audit must never cost a player their save.
  let uniqAudit: { findings: UniqueFinding[]; checked: number } = { findings: [], checked: 0 };
  try {
    uniqAudit = await auditUniques(admin, data as Record<string, unknown>);
    if (uniqAudit.findings.length && UNIQUE_VALIDATE_ENFORCE) {
      const removed = stripFindings(data as Record<string, unknown>, uniqAudit.findings);
      console.warn(`unique_forged ENFORCED: user=${userId} removed=${removed}`);
    }
  } catch (e) {
    console.warn(`unique audit threw (ignored): ${String(e).slice(0, 200)}`);
  }
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

  // Auto-detection (see migrations 20260724210000 / 220000). A live client pushes progress every ~8s, so a
  // Δprogress that is large RELATIVE TO THIS ACCOUNT'S OWN SCALE in a sub-2-minute window is not a fast player
  // -- it's an edited save. A large ABSOLUTE jump, by contrast, is just an endgame player in combat, which is
  // what this used to clamp. Offline returns don't trip it either: their elapsed is the whole away-window
  // (>120s), so the same gain is spread over real time.
  // Records a signal when both tests trip; clamps only when PROGRESS_JUMP_AUTOENFORCE is on (currently FALSE --
  // shadow mode after two false positives on a live player). Best-effort: never fail a save on it.
  try {
    if (prev?.updated_at) {
      const elapsed = Date.now() - Date.parse(prev.updated_at as string);
      const jump = progress - prevProgress;
      // The relative allowance: what this account's OWN scale says it could plausibly have gained in this
      // window. Accounts under SIGNAL_RELATIVE_MIN_PROGRESS have no meaningful scale yet, so they are judged by
      // the absolute floor alone (allowance 0 => the relative test always passes for them).
      const relAllowance = prevProgress >= SIGNAL_RELATIVE_MIN_PROGRESS
        ? prevProgress * SIGNAL_JUMP_RATE_PER_SEC * (elapsed / 1000)
        : 0;
      const overAbsolute = jump >= SIGNAL_PROGRESS_JUMP;
      const overRelative = jump >= relAllowance;
      if (elapsed >= SIGNAL_MIN_ELAPSED_MS && elapsed <= SIGNAL_MAX_ELAPSED_MS && overAbsolute && overRelative) {
        // Rate-limit the audit log to ~1 row/hour/user so a cheater re-saving every 8s can't flood it.
        const { data: recent } = await admin.from("clamp_signals").select("id")
          .eq("user_id", userId).gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
        if (!recent || !recent.length) {
          // Carry the relative figures into the signal so a review can judge it without recomputing: how far
          // over the account's own allowance this was, and the implied growth rate per second.
          const detail = {
            jump, elapsed_ms: elapsed, prev_progress: prevProgress, progress,
            rel_allowance: Math.round(relAllowance),
            over_allowance_x: relAllowance > 0 ? Number((jump / relAllowance).toFixed(2)) : null,
            rate_per_sec_pct: prevProgress > 0
              ? Number(((jump / prevProgress) / (elapsed / 1000) * 100).toFixed(4)) : null,
            enforced: PROGRESS_JUMP_AUTOENFORCE,
          };
          console.warn(`clamp signal progress_jump: user=${userId} jump=${jump} elapsedMs=${elapsed} overAllowance=${detail.over_allowance_x}x`);
          await admin.from("clamp_signals").insert({ user_id: userId, kind: "progress_jump", detail, would_clamp: PROGRESS_JUMP_AUTOENFORCE });
          if (PROGRESS_JUMP_AUTOENFORCE) {
            await admin.from("account_clamps").upsert({
              user_id: userId, surfaces: ["marketplace", "leaderboard", "guild", "chat"],
              clamped_until: new Date(Date.now() + CLAMP_INDEFINITE_MS).toISOString(),
              auto: true, signal: detail, clamped_by: null,
            }, { onConflict: "user_id" });
          }
        }
      }
    }
  } catch { /* detection is best-effort -- never block a save on it */ }

  // Forged-unique signal (ticket-0163). Recorded whether or not enforcement is on, so a week of real
  // traffic tells us whether the bounds are right BEFORE anything starts deleting items. Rate-limited to
  // ~1 row/hour/user like the others: a client re-saves every 8s and would otherwise flood the log.
  // Deliberately NOT clamping any surface yet -- a structural finding can also mean a stale client shipped
  // an item the catalogue seed has not been regenerated for, and that is a deploy-order mistake on our
  // side, not cheating. Read the signals first; that distinction is exactly what the shadow week is for.
  try {
    if (uniqAudit.findings.length) {
      const { data: recent } = await admin.from("clamp_signals").select("id")
        .eq("user_id", userId).eq("kind", "unique_forged")
        .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
      if (!recent || !recent.length) {
        const byWhy: Record<string, number> = {};
        for (const f of uniqAudit.findings) {
          const key = f.why.split(":")[0];
          byWhy[key] = (byWhy[key] || 0) + 1;
        }
        const detail = {
          kind: "unique_forged",
          uniques_checked: uniqAudit.checked,
          finding_count: uniqAudit.findings.length,
          by_reason: byWhy,
          sample: uniqAudit.findings.slice(0, 8),   // uid + base + why, enough to judge without the blob
          enforced: UNIQUE_VALIDATE_ENFORCE,
        };
        console.warn(`clamp signal unique_forged: user=${userId} findings=${uniqAudit.findings.length} of ${uniqAudit.checked} reasons=${Object.keys(byWhy).join(",")}`);
        await admin.from("clamp_signals").insert({ user_id: userId, kind: "unique_forged", detail, would_clamp: false });
      }
    }
  } catch { /* detection is best-effort -- never block a save on it */ }

  // Gold-injection detector (mirrors the wallet earn-path hard clamp). The injection lands here first, so
  // catching it here clamps an ACTIVE injector on their next push rather than waiting for a wallet sync.
  // Both gold and goldEarnedTotal were normalized to storeCeiling(age) above -- for a sub-7-day account
  // that pins each at the 500M line, so a raw 5B still reads >= HARD_CLAMP_GOLD here and trips the clamp,
  // while a legit young value (< 500M) passes untouched. Age-gated so an established account is never
  // touched. Best-effort.
  try {
    const ageDays = accountAgeDays(user.created_at);
    const gNum = Number((data as Record<string, unknown>).gold);
    const eNum = Number((data as Record<string, unknown>).goldEarnedTotal);
    const worst = Math.max(Number.isFinite(gNum) ? gNum : 0, Number.isFinite(eNum) ? eNum : 0);
    if (ageDays < HARD_CLAMP_MAX_AGE_DAYS && worst >= HARD_CLAMP_GOLD) {
      const { data: recent } = await admin.from("clamp_signals").select("id")
        .eq("user_id", userId).eq("kind", "gold_inject")
        .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
      if (!recent || !recent.length) {
        const detail = {
          kind: "gold_inject", via: "save",
          save_gold: Math.floor(Number.isFinite(gNum) ? gNum : 0),
          save_earned: Math.floor(Number.isFinite(eNum) ? eNum : 0),
          age_days: Math.floor(ageDays),
        };
        console.warn(`clamp signal gold_inject(save): user=${userId} worst=${Math.floor(worst)} ageDays=${ageDays.toFixed(2)}`);
        await admin.from("clamp_signals").insert({ user_id: userId, kind: "gold_inject", detail, would_clamp: true });
        if (CLAMP_AUTOENFORCE) {
          await admin.from("account_clamps").upsert({
            user_id: userId, surfaces: ["marketplace", "leaderboard", "guild", "chat"],
            clamped_until: new Date(Date.now() + CLAMP_INDEFINITE_MS).toISOString(),
            auto: true, signal: detail, clamped_by: null,
          }, { onConflict: "user_id" });
        }
      }
    }
  } catch { /* detection is best-effort -- never block a save on it */ }

  return json({ ok: true, version: nextVersion });
});
