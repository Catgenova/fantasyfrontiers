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

  if (action === "get") {
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "deposit") {
    const key = String(body.item_key || "");
    const qty = Number(body.qty);
    if (!KEY_RE.test(key)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return json({ ok: false, error: "Invalid quantity." }, 400);
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
    const { data: r, error } = await admin.rpc("guild_bank_withdraw", { p_guild: guildId, p_key: key, p_qty: qty });
    if (error) return json({ ok: false, error: "Withdraw failed." }, 500);
    if (r === "short") return json({ ok: false, error: "Not enough of that item in the bank.", code: "short" }, 409);
    if (r !== "ok") return json({ ok: false, error: "Withdraw rejected." }, 400);
    // The withdrawn items become real ledger stock for the withdrawer (verified transfer).
    await admin.rpc("item_credit", { p_user: user.id, p_key: key, p_qty: qty });
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
    if (!["normal", "rare", "supreme", "fantastic"].includes(rarity)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(tier) || tier < 0 || tier > 40) return json({ ok: false, error: "Invalid item." }, 400);
    // Enchants: an array of { mod:string, roll:number }, capped so the blob stays small.
    const rawEnch = Array.isArray(u.enchants) ? u.enchants : [];
    if (rawEnch.length > 8) return json({ ok: false, error: "Invalid item." }, 400);
    const enchants = rawEnch.map((e) => {
      const o = (e || {}) as Record<string, unknown>;
      return { mod: String(o.mod || "").slice(0, 32), roll: Math.max(0, Math.min(100000, Math.floor(Number(o.roll) || 0))) };
    }).filter((e) => e.mod);
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
    const { data: r, error } = await admin.rpc("guild_treasury_withdraw", { p_guild: guildId, p_amount: amount });
    if (error) return json({ ok: false, error: "Withdraw failed." }, 500);
    const res = r as { status?: string; granted?: number };
    if (res?.status === "short") return json({ ok: false, error: "Not enough gold in the treasury.", code: "short" }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Withdraw rejected." }, 400);
    // Credit the withdrawn gold into the withdrawer's server-authoritative wallet so it's real,
    // spendable balance (not just a client-side number). Unthrottled: it's a verified transfer.
    const granted = Number(res.granted);
    if (granted > 0) await admin.rpc("wallet_credit", { p_user: user.id, p_amount: granted });
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
