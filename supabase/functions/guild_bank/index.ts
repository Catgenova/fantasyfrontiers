// Fantasy Frontiers — server-authoritative guild bank.
//
// Backs the Bank subtab. Reads/writes go through this function (service role) and the
// SECURITY DEFINER RPCs (guild_bank_deposit/withdraw/buy_slot) so quantity changes are
// atomic and capacity-checked. Identity comes from the token; rank rules are enforced here.
//
// Actions (POST { action, ... }):
//   get                              -> { slots, used, items:[{item_key,qty}], min_withdraw_rank }
//   deposit  { item_key, qty }       -> member; add to the vault (respects the slot cap)
//   withdraw { item_key, qty }       -> requires rank >= guild's min_withdraw_rank
//   buy_slot                         -> (leader/officer) +1 slot; returns the gold cost
//   set_withdraw_rank { rank }       -> (leader) set the minimum rank allowed to withdraw
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
    const { data: g } = await admin.from("guilds").select("bank_slots, bank_min_withdraw_rank").eq("id", guildId).maybeSingle();
    const { data: items } = await admin.from("guild_bank")
      .select("item_key, qty").eq("guild_id", guildId).order("updated_at", { ascending: false });
    const list = items || [];
    return {
      slots: g?.bank_slots ?? 5,
      used: list.length,
      items: list,
      min_withdraw_rank: g?.bank_min_withdraw_rank ?? "member",
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
    const { data: r, error } = await admin.rpc("guild_bank_deposit", { p_guild: guildId, p_key: key, p_qty: qty });
    if (error) return json({ ok: false, error: "Deposit failed." }, 500);
    if (r === "full") return json({ ok: false, error: "The bank is full — buy more slots.", code: "full" }, 409);
    if (r !== "ok") return json({ ok: false, error: "Deposit rejected." }, 400);
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
    return json({ ok: true, granted: qty, ...(await snapshot()) });
  }

  if (action === "buy_slot") {
    if (!isOfficer) return json({ ok: false, error: "Only officers or the leader can buy bank slots." }, 403);
    const { data: r, error } = await admin.rpc("guild_bank_buy_slot", { p_guild: guildId });
    if (error) return json({ ok: false, error: "Purchase failed." }, 500);
    const res = r as { status?: string; cost?: number; slots?: number };
    if (res?.status === "max") return json({ ok: false, error: "The bank is already at the 500-slot maximum." }, 409);
    if (res?.status !== "ok") return json({ ok: false, error: "Purchase rejected." }, 400);
    return json({ ok: true, cost: res.cost, ...(await snapshot()) });
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
