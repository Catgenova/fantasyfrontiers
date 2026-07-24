// Fantasy Frontiers — server-authoritative guild bank.
//
// Backs the Bank subtab. Reads/writes go through this function (service role) and the
// SECURITY DEFINER RPCs (guild_bank_deposit/withdraw/buy_slot) so quantity changes are
// atomic and capacity-checked. Identity comes from the token; rank rules are enforced here.
//
// Actions (POST { action, ... }):
//   get                              -> { slots, used, items:[{item_key,qty}], uniques:[{bank_uid,base,...}], min_withdraw_rank }
//   deposit  { item_key, qty }       -> member; add to the vault (respects the slot cap)
//   deposit_unique { unique:{...} }  -> member; store one enchanted/enhanced item (one slot)
//   withdraw { item_key, qty }       -> requires rank >= guild's min_withdraw_rank
//   withdraw_unique { bank_uid }     -> requires rank >= min_withdraw_rank; returns the unique blob
//   buy_slot                         -> (leader/officer) +1 slot; PAID FROM THE TREASURY
//   set_withdraw_rank { rank }       -> (leader) set the minimum rank allowed to withdraw
//   donate_gold   { amount }         -> member; add gold to the shared treasury
//   withdraw_gold { amount }         -> requires rank >= guild's min_withdraw_rank
//   spend_gold    { amount }         -> (leader/officer) burn treasury gold for a guild expense
//
// Verify JWT must be OFF (publishable key isn't a JWT; token validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_QTY = 1_000_000_000_000; // 1e12, matches the gold sanity ceiling
const RANKVAL: Record<string, number> = { member: 1, officer: 2, leader: 3 };

// ---- Unique-deposit rate cap + injection detection (account clamps; migrations 20260724210000 / 220000) ----
// Uniques are client-authoritative and NOT ledger-tracked, so a forged top-tier item (a plausible-shaped
// fantastic / +12 nobody earned) is the one remaining way to push fake value into the SHARED bank. We can't
// verify provenance, but we can rate-limit: a 'notable' unique (fantastic rarity or +12-or-better enhance --
// exactly what the community feed celebrates, and what a forger targets) is a rare, per-session event
// legitimately. Two tiers, keyed on the depositor (rl_hit counters):
//   SOFT: beyond this many notable deposits/hour, BLOCK further ones (protects the bank; no punishment --
//         covers a veteran seeding a bank from a genuinely large hoard, who just spreads it out).
//   HARD: continuing far past that is minting -> record a clamp_signal + clamp (Discord fires on the clamp).
const UNIQUE_NOTABLE_ENHANCE = 12;      // +12-or-better is a celebrated/forger-targeted enhance
const UNIQUE_DEPOSIT_SOFT_PER_HOUR = 15; // block notable deposits beyond this/hour
const UNIQUE_DEPOSIT_HARD_PER_HOUR = 40; // clamp beyond this/hour (clearly minting)
const CLAMP_INDEFINITE_MS = 5_256_000 * 60_000; // ~10 years, matches the clamp RPC's cap

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  // Volume rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down.
  try { const { data: _over } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "guild_bank", p_limit: 60, p_window_secs: 60 }); if (_over === true) return json({ ok: false, error: "Too many requests." }, 429); } catch { /* limiter unavailable -> allow */ }
  // Clamp gate: an account quarantined from the guild surface is refused (see migration 20260724210000).
  // Fail-open like the rate limiter -- a check that is DOWN must never lock a legit player out of their guild.
  try { const { data: _cl } = await admin.rpc("is_clamped", { p_user: user.id, p_surface: "guild" }); if (_cl === true) return json({ ok: false, clamped: true, error: "This account is restricted from guild features." }); } catch { /* clamp check unavailable -> allow */ }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  // Membership + rank.
  const { data: me } = await admin.from("guild_members")
    .select("guild_id, rank").eq("user_id", user.id).maybeSingle();
  if (!me) return json({ ok: false, error: "You're not in a guild." }, 403);
  const guildId = me.guild_id as string;
  const myRank = me.rank as string;
  const isOfficer = myRank === "officer" || myRank === "leader";

  // Mortal guilds keep no shared vault: every bank action is refused for them.
  const { data: guildRow } = await admin.from("guilds").select("mortal").eq("id", guildId).maybeSingle();
  if (guildRow?.mortal === true) return json({ ok: false, error: "Mortal guilds have no bank." }, 403);

  async function snapshot() {
    const { data: g } = await admin.from("guilds").select("bank_slots, bank_min_withdraw_rank, treasury").eq("id", guildId).maybeSingle();
    const { data: items } = await admin.from("guild_bank")
      .select("item_key, qty").eq("guild_id", guildId).order("updated_at", { ascending: false });
    const { data: uniq } = await admin.from("guild_bank_unique")
      .select("id, base, kind, tier, rarity, enhance, enchants").eq("guild_id", guildId).order("updated_at", { ascending: false });
    const list = items || [];
    const uniques = (uniq || []).map((u) => ({
      bank_uid: u.id, base: u.base, kind: u.kind, tier: u.tier, rarity: u.rarity, enhance: u.enhance, enchants: u.enchants,
    }));
    return {
      slots: g?.bank_slots ?? 5,
      used: list.length + uniques.length,   // uniques share the slot cap with stacks
      items: list,
      uniques,
      min_withdraw_rank: g?.bank_min_withdraw_rank ?? "member",
      treasury: Number(g?.treasury ?? 0),
    };
  }

  // Item-key allowlist (item_catalog): reject made-up item keys so a tampered client can't bank a fake
  // item (stackable deposit is already ledger-gated by item_debit, but deposit_unique is client-
  // authoritative and bypasses the ledger entirely -- its `base` must still be a real catalogued item).
  // Enforced only once the catalog is SEEDED; an empty catalog gates nothing (safe deploy window).
  async function catalogRejects(key: string): Promise<boolean> {
    const { data: hit } = await admin.from("item_catalog").select("item_key").eq("item_key", key).maybeSingle();
    if (hit) return false;                                   // known item -> allowed
    const { data: seeded } = await admin.from("item_catalog").select("item_key").limit(1);
    return !!(seeded && seeded.length);                      // populated but absent -> reject; empty -> allow
  }

  if (action === "get") {
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "deposit") {
    const key = String(body.item_key || "");
    const qty = Number(body.qty);
    if (!KEY_RE.test(key)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return json({ ok: false, error: "Invalid quantity." }, 400);
    if (await catalogRejects(key)) return json({ ok: false, error: "That item can’t be banked.", code: "badkey" }, 400);
    // Take the items from the depositor's server ledger first, so minted/spoofed items can't fill the
    // shared vault. Refund to the ledger if the deposit then fails (full / error / rejected).
    const { data: held } = await admin.rpc("item_debit", { p_user: user.id, p_key: key, p_qty: qty });
    if (held !== true) return json({ ok: false, error: "You don't have those items.", code: "poor" }, 402);
    const { data: r, error } = await admin.rpc("guild_bank_deposit", { p_guild: guildId, p_key: key, p_qty: qty });
    if (error || r !== "ok") {
      await admin.rpc("item_credit", { p_user: user.id, p_key: key, p_qty: qty }); // refund the escrow
      if (error) return json({ ok: false, error: "Deposit failed." }, 500);
      if (r === "full") return json({ ok: false, error: "The bank is full — buy more slots.", code: "full" }, 409);
      return json({ ok: false, error: "Deposit rejected." }, 400);
    }
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "withdraw") {
    if (RANKVAL[myRank] < RANKVAL[(await snapshot()).min_withdraw_rank]) {
      return json({ ok: false, error: "Your rank can't withdraw from the bank." }, 403);
    }
    const key = String(body.item_key || "");
    const qty = Number(body.qty);
    if (!KEY_RE.test(key)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return json({ ok: false, error: "Invalid quantity." }, 400);
    // guild_bank_withdraw_tx drains the vault AND credits the withdrawer's ledger in ONE transaction, so a
    // mid-withdraw failure can't remove the item from the shared vault without delivering it. No separate
    // item_credit here anymore -- the RPC did it.
    const { data: r, error } = await admin.rpc("guild_bank_withdraw_tx", { p_guild: guildId, p_user: user.id, p_key: key, p_qty: qty });
    if (error) return json({ ok: false, error: "Withdraw failed." }, 500);
    if (r === "short") return json({ ok: false, error: "Not enough of that item in the bank.", code: "short" }, 409);
    if (r !== "ok") return json({ ok: false, error: "Withdraw rejected." }, 400);
    return json({ ok: true, granted: qty, ...(await snapshot()) });
  }

  // Deposit a UNIQUE (enchanted/enhanced) item. Ownership is client-authoritative (uniques aren't in
  // the server item ledger), matching the bank's trust model; the server validates the blob shape and
  // enforces the shared slot cap. Every unique is one slot.
  if (action === "deposit_unique") {
    const u = (body as { unique?: unknown }).unique as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return json({ ok: false, error: "Invalid item." }, 400);
    const base = String(u.base || "");
    const kind = String(u.kind || "weapon");
    const rarity = String(u.rarity || "normal");
    const tier = Number(u.tier);
    const enhance = Number(u.enhance) || 0;
    if (!KEY_RE.test(base)) return json({ ok: false, error: "Invalid item." }, 400);
    // Uniques are client-authoritative (not in the item ledger), so the `base` is the one identity the
    // server CAN verify: reject a made-up base outright. Every real unique's base is a catalogued
    // equipment key (stackable weapon/shield/ward, body armour, etc.), so this never blocks legit gear.
    if (await catalogRejects(base)) return json({ ok: false, error: "That item can’t be banked.", code: "badkey" }, 400);
    if (!["normal", "rare", "supreme", "fantastic"].includes(rarity)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(tier) || tier < 0 || tier > 40) return json({ ok: false, error: "Invalid item." }, 400);
    // Enchants: an array of { mod:string, roll:number }, capped so the blob stays small.
    const rawEnch = Array.isArray(u.enchants) ? u.enchants : [];
    if (rawEnch.length > 8) return json({ ok: false, error: "Invalid item." }, 400);
    const enchants = rawEnch.map((e) => {
      const o = (e || {}) as Record<string, unknown>;
      return { mod: String(o.mod || "").slice(0, 32), roll: Math.max(0, Math.min(100000, Math.floor(Number(o.roll) || 0))) };
    }).filter((e) => e.mod);

    // Rate-cap notable (high-value) unique deposits. Uniques carry no server provenance, so a plausible
    // forged top-tier item can't be validated -- only throttled. SOFT breach blocks; HARD breach clamps.
    const notable = rarity === "fantastic" || Math.max(0, Math.floor(enhance)) >= UNIQUE_NOTABLE_ENHANCE;
    if (notable) {
      let softOver = false, hardOver = false;
      // Two counters increment together per notable attempt (incl. blocked ones, so a persistent dumper
      // still escalates into the HARD clamp). Fail-open like every other limiter.
      try { const { data } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "unique_dep_hard", p_limit: UNIQUE_DEPOSIT_HARD_PER_HOUR, p_window_secs: 3600 }); hardOver = data === true; } catch { hardOver = false; }
      try { const { data } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "unique_dep_soft", p_limit: UNIQUE_DEPOSIT_SOFT_PER_HOUR, p_window_secs: 3600 }); softOver = data === true; } catch { softOver = false; }
      if (hardOver) {
        // Minting-scale dump of top-tier uniques into the shared bank -> clamp (sibling of item_inject).
        try {
          const detail = { kind: "unique_dump", base, rarity, tier, enhance: Math.max(0, Math.floor(enhance)), cap_per_hour: UNIQUE_DEPOSIT_HARD_PER_HOUR };
          const { data: recent } = await admin.from("clamp_signals").select("id")
            .eq("user_id", user.id).eq("kind", "unique_dump")
            .gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
          if (!recent || !recent.length) {
            console.warn(`clamp signal unique_dump: user=${user.id} base=${base} rarity=${rarity} enhance=${enhance}`);
            await admin.from("clamp_signals").insert({ user_id: user.id, kind: "unique_dump", detail, would_clamp: true });
            await admin.from("account_clamps").upsert({
              user_id: user.id, surfaces: ["marketplace", "leaderboard", "guild", "chat"],
              clamped_until: new Date(Date.now() + CLAMP_INDEFINITE_MS).toISOString(),
              auto: true, signal: detail, clamped_by: null,
            }, { onConflict: "user_id" });
          }
        } catch { /* best-effort */ }
        return json({ ok: false, clamped: true, code: "clamped", error: "This account is restricted from guild features." });
      }
      if (softOver) {
        // 200 (not 429) so supabase-js hands the client the body -> the message shows (like the clamp gates).
        return json({ ok: false, error: "You’ve banked a lot of high-end items recently — try again later.", code: "rate" });
      }
    }
    const { data: id, error } = await admin.rpc("guild_bank_deposit_unique", {
      p_guild: guildId, p_base: base, p_kind: kind.slice(0, 24), p_tier: tier, p_rarity: rarity,
      p_enhance: Math.max(0, Math.min(15, Math.floor(enhance))), p_enchants: enchants,
    });
    if (error) return json({ ok: false, error: "Deposit failed." }, 500);
    if (id === -2) return json({ ok: false, error: "The bank is full — buy more slots.", code: "full" }, 409);
    if (typeof id !== "number" || id < 0) return json({ ok: false, error: "Deposit rejected." }, 400);
    return json({ ok: true, bank_uid: id, ...(await snapshot()) });
  }

  // Withdraw a unique by its bank id. Same rank gate as stackable withdraw; returns the full blob for
  // the client to re-mint into its uniqueItems.
  if (action === "withdraw_unique") {
    if (RANKVAL[myRank] < RANKVAL[(await snapshot()).min_withdraw_rank]) {
      return json({ ok: false, error: "Your rank can't withdraw from the bank." }, 403);
    }
    const bankUid = Number((body as { bank_uid?: unknown }).bank_uid);
    if (!Number.isInteger(bankUid) || bankUid <= 0) return json({ ok: false, error: "Invalid item." }, 400);
    const { data: row, error } = await admin.rpc("guild_bank_withdraw_unique", { p_guild: guildId, p_id: bankUid });
    if (error) return json({ ok: false, error: "Withdraw failed." }, 500);
    if (!row) return json({ ok: false, error: "That item is no longer in the bank.", code: "short" }, 409);
    return json({ ok: true, unique: row, ...(await snapshot()) });
  }

  if (action === "buy_slot") {
    if (!isOfficer) return json({ ok: false, error: "Only officers or the leader can buy bank slots." }, 403);
    const { data: r, error } = await admin.rpc("guild_bank_buy_slot", { p_guild: guildId });
    if (error) return json({ ok: false, error: "Purchase failed." }, 500);
    const res = r as { status?: string; cost?: number; slots?: number };
    if (res?.status === "max") return json({ ok: false, error: "The bank is already at the 500-slot maximum." }, 409);
    if (res?.status === "poor") return json({ ok: false, error: "The guild treasury doesn't have enough gold for the next slot.", code: "poor" }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Purchase rejected." }, 400);
    return json({ ok: true, cost: res.cost, ...(await snapshot()) });
  }

  if (action === "spend_gold") {
    if (!isOfficer) return json({ ok: false, error: "Only officers or the leader can spend the guild treasury." }, 403);
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_QTY) return json({ ok: false, error: "Invalid amount." }, 400);
    const { data: r, error } = await admin.rpc("guild_treasury_spend", { p_guild: guildId, p_amount: amount });
    if (error) return json({ ok: false, error: "Spend failed." }, 500);
    const res = r as { status?: string; spent?: number };
    if (res?.status === "poor") return json({ ok: false, error: "The guild treasury doesn't have enough gold.", code: "poor" }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Spend rejected." }, 400);
    return json({ ok: true, spent: Number(res.spent), ...(await snapshot()) });
  }

  if (action === "donate_gold") {
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_QTY) return json({ ok: false, error: "Invalid amount." }, 400);
    // Take the gold from the donor's server-authoritative wallet FIRST, so spoofed client gold can't
    // fill the shared treasury. Refund the wallet if the treasury update then fails.
    const { data: paid } = await admin.rpc("wallet_debit", { p_user: user.id, p_amount: amount });
    if (paid !== true) return json({ ok: false, error: "Not enough gold." }, 402);
    const { data: r, error } = await admin.rpc("guild_treasury_donate", { p_guild: guildId, p_amount: amount });
    if (error || (r as { status?: string })?.status !== "ok") {
      await admin.rpc("wallet_credit", { p_user: user.id, p_amount: amount }); // refund
      return json({ ok: false, error: error ? "Donation failed." : "Donation rejected." }, error ? 500 : 400);
    }
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "withdraw_gold") {
    if (RANKVAL[myRank] < RANKVAL[(await snapshot()).min_withdraw_rank]) {
      return json({ ok: false, error: "Your rank can't withdraw from the bank." }, 403);
    }
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_QTY) return json({ ok: false, error: "Invalid amount." }, 400);
    // guild_treasury_withdraw_tx debits the treasury AND credits the withdrawer's wallet in ONE
    // transaction, so a mid-withdraw failure can't remove gold from the treasury without delivering it.
    // No separate wallet_credit here anymore -- the RPC did it.
    const { data: r, error } = await admin.rpc("guild_treasury_withdraw_tx", { p_guild: guildId, p_user: user.id, p_amount: amount });
    if (error) return json({ ok: false, error: "Withdraw failed." }, 500);
    const res = r as { status?: string; granted?: number };
    if (res?.status === "short") return json({ ok: false, error: "Not enough gold in the treasury.", code: "short" }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Withdraw rejected." }, 400);
    const granted = Number(res.granted);
    return json({ ok: true, granted, ...(await snapshot()) });
  }

  if (action === "set_withdraw_rank") {
    if (myRank !== "leader") return json({ ok: false, error: "Only the leader can change this." }, 403);
    const rank = String(body.rank || "");
    if (!RANKVAL[rank]) return json({ ok: false, error: "Invalid rank." }, 400);
    await admin.from("guilds").update({ bank_min_withdraw_rank: rank }).eq("id", guildId);
    return json({ ok: true, ...(await snapshot()) });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
