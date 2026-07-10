// Fantasy Frontiers — server-mediated player marketplace (order-book exchange).
//
// Backs the Market tab. Reads/writes go through this function (service role) + the SECURITY DEFINER
// RPCs (market_place / market_cancel / market_collect) so matching is atomic, dupe-free, and taxed
// correctly. Identity comes from the bearer token; the username is read from user_metadata.
//
// Trust model — like the guild bank, item/gold OWNERSHIP is client-authoritative: placing a sell
// removes items client-side, placing a buy removes gold, and the resting order is that escrow. The
// server guarantees the shared book's integrity, not that anyone actually held what they traded.
// Only item_key + numbers are stored; the client rebuilds names/icons, so no HTML is trusted.
//
// Actions (POST { action, ... }):
//   listings                                       -> everything for sale, aggregated by item (min ask, qty, #)
//   book    { item_key }                          -> aggregated ask/bid ladders + best ask/bid for one item
//   mine                                           -> caller's open orders + proceeds inbox summary
//   place   { side, item_key, unit_price, qty }    -> match + rest; returns { filled, rest, refund, order_id }
//   cancel  { order_id }                           -> delete caller's order; returns escrow to re-credit
//   collect                                        -> drain proceeds; returns { gold, items:[{item_key,amount}] }
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
const MAX_PRICE = 1_000_000_000; // 1e9
const MAX_QTY = 1_000_000;       // 1e6  (price*qty <= 1e15, a safe JS integer)
const BOOK_DEPTH = 100;          // rows scanned per side when building a ladder

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
  const username = ((user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined) || "";

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  // ---- Aggregate a price -> total-qty ladder from a list of resting orders ----
  function ladder(rows: { unit_price: number; qty_remaining: number }[]) {
    const byPrice = new Map<number, number>();
    for (const r of rows) byPrice.set(Number(r.unit_price), (byPrice.get(Number(r.unit_price)) || 0) + Number(r.qty_remaining));
    return Array.from(byPrice.entries()).map(([price, qty]) => ({ price, qty }));
  }

  if (action === "book") {
    const key = String(body.item_key || "");
    if (!KEY_RE.test(key)) return json({ ok: false, error: "Invalid item." }, 400);
    const { data: asks } = await admin.from("market_orders").select("unit_price, qty_remaining")
      .eq("item_key", key).eq("side", "sell").order("unit_price", { ascending: true }).order("created_at", { ascending: true }).limit(BOOK_DEPTH);
    const { data: bids } = await admin.from("market_orders").select("unit_price, qty_remaining")
      .eq("item_key", key).eq("side", "buy").order("unit_price", { ascending: false }).order("created_at", { ascending: true }).limit(BOOK_DEPTH);
    const askL = ladder(asks || []).sort((a, b) => a.price - b.price);
    const bidL = ladder(bids || []).sort((a, b) => b.price - a.price);
    return json({ ok: true, item_key: key, asks: askL, bids: bidL, best_ask: askL.length ? askL[0].price : null, best_bid: bidL.length ? bidL[0].price : null });
  }

  if (action === "listings") {
    // Everything currently for sale, aggregated by item (cheapest ask + total qty + # listings).
    // Scans the cheapest asks first so a huge book still surfaces the best prices.
    const { data } = await admin.from("market_orders").select("item_key, unit_price, qty_remaining")
      .eq("side", "sell").order("unit_price", { ascending: true }).limit(3000);
    const agg = new Map<string, { item_key: string; min_ask: number; qty: number; count: number }>();
    for (const r of data || []) {
      const k = r.item_key as string, price = Number(r.unit_price), qty = Number(r.qty_remaining);
      const cur = agg.get(k);
      if (!cur) agg.set(k, { item_key: k, min_ask: price, qty, count: 1 });
      else { cur.qty += qty; cur.count += 1; if (price < cur.min_ask) cur.min_ask = price; }
    }
    return json({ ok: true, listings: Array.from(agg.values()) });
  }

  if (action === "mine") {
    const { data: orders } = await admin.from("market_orders")
      .select("id, side, item_key, unit_price, qty_remaining, qty_original, created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false });
    const { data: proc } = await admin.from("market_proceeds").select("kind, item_key, amount").eq("user_id", user.id);
    let gold = 0; const items: { item_key: string; amount: number }[] = [];
    for (const p of proc || []) {
      if (p.kind === "gold") gold += Number(p.amount);
      else items.push({ item_key: p.item_key as string, amount: Number(p.amount) });
    }
    return json({ ok: true, orders: orders || [], proceeds: { gold, items } });
  }

  if (action === "place") {
    if (!username) return json({ ok: false, error: "Account has no username." }, 400);
    const side = String(body.side || "");
    const key = String(body.item_key || "");
    const price = Number(body.unit_price);
    const qty = Number(body.qty);
    if (side !== "buy" && side !== "sell") return json({ ok: false, error: "Invalid side." }, 400);
    if (!KEY_RE.test(key)) return json({ ok: false, error: "Invalid item." }, 400);
    if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE) return json({ ok: false, error: "Invalid price." }, 400);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return json({ ok: false, error: "Invalid quantity." }, 400);
    // A BUY escrows price*qty of GOLD -- take it from the server-authoritative wallet up front so
    // spoofed client gold can't buy from other players. (A SELL escrows items, not gold.) Price
    // improvement and, later, sale proceeds are returned to the wallet via `collect`; a cancelled
    // buy returns its remaining escrow via `cancel`. Refund the escrow if the order itself fails.
    const buyEscrow = side === "buy" ? price * qty : 0;
    if (buyEscrow > 0) {
      const { data: paid } = await admin.rpc("wallet_debit", { p_user: user.id, p_amount: buyEscrow });
      if (paid !== true) return json({ ok: false, error: "Not enough gold.", code: "poor" }, 402);
    }
    // A SELL escrows the ITEMS being listed -- take them from the server item ledger up front so
    // minted/spoofed items can't be sold to other players. Returned on failure / collect / cancel.
    if (side === "sell") {
      const { data: held } = await admin.rpc("item_debit", { p_user: user.id, p_key: key, p_qty: qty });
      if (held !== true) {
        if (buyEscrow > 0) await admin.rpc("wallet_credit", { p_user: user.id, p_amount: buyEscrow });
        return json({ ok: false, error: "You don't have those items to sell.", code: "poor" }, 402);
      }
    }
    const refundEscrow = async () => {
      if (buyEscrow > 0) await admin.rpc("wallet_credit", { p_user: user.id, p_amount: buyEscrow });
      if (side === "sell") await admin.rpc("item_credit", { p_user: user.id, p_key: key, p_qty: qty });
    };
    const { data: r, error } = await admin.rpc("market_place", {
      p_user: user.id, p_username: username, p_side: side, p_item: key, p_price: price, p_qty: qty,
    });
    if (error) { await refundEscrow(); return json({ ok: false, error: "Order failed." }, 500); }
    const res = r as { status?: string; filled?: number; rest?: number; refund?: number; order_id?: number };
    if (res?.status === "toomany") { await refundEscrow(); return json({ ok: false, error: "You already have the maximum of 40 open orders.", code: "toomany" }, 409); }
    if (res?.status !== "ok") { await refundEscrow(); return json({ ok: false, error: "Order rejected." }, 400); }
    return json({ ok: true, filled: Number(res.filled || 0), rest: Number(res.rest || 0), refund: Number(res.refund || 0), order_id: res.order_id ?? null });
  }

  if (action === "cancel") {
    const orderId = Number(body.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ ok: false, error: "Invalid order." }, 400);
    const { data: r, error } = await admin.rpc("market_cancel", { p_user: user.id, p_order: orderId });
    if (error) return json({ ok: false, error: "Cancel failed." }, 500);
    const res = r as { status?: string; side?: string; item_key?: string; qty?: number; unit_price?: number };
    if (res?.status === "notfound") return json({ ok: false, error: "That order no longer exists.", code: "notfound" }, 404);
    if (res?.status !== "ok") return json({ ok: false, error: "Cancel rejected." }, 400);
    // A cancelled BUY returns its remaining gold escrow (qty_remaining * bid price) to the wallet;
    // a cancelled SELL returns the remaining escrowed ITEMS to the item ledger.
    if (res.side === "buy") {
      const back = Number(res.qty) * Number(res.unit_price);
      if (back > 0) await admin.rpc("wallet_credit", { p_user: user.id, p_amount: back });
    } else if (res.side === "sell") {
      const back = Number(res.qty);
      if (back > 0) await admin.rpc("item_credit", { p_user: user.id, p_key: String(res.item_key), p_qty: back });
    }
    return json({ ok: true, side: res.side, item_key: res.item_key, qty: Number(res.qty), unit_price: Number(res.unit_price) });
  }

  if (action === "collect") {
    const { data: r, error } = await admin.rpc("market_collect", { p_user: user.id });
    if (error) return json({ ok: false, error: "Collect failed." }, 500);
    const res = r as { status?: string; gold?: number; items?: { item_key: string; amount: number }[] };
    if (res?.status !== "ok") return json({ ok: false, error: "Collect rejected." }, 400);
    // Gold proceeds (a seller's sale receipts + a buyer's price-improvement refunds) are credited
    // into the server-authoritative wallet so they're real spendable balance. Verified transfer,
    // so unthrottled. The client still adds the same gold locally; the sync clamp reconciles.
    const goldOut = Number(res.gold || 0);
    if (goldOut > 0) await admin.rpc("wallet_credit", { p_user: user.id, p_amount: goldOut });
    // Item proceeds (units a buyer bought, or items returned to a seller) become real ledger stock.
    const items = (res.items || []).map((i) => ({ item_key: i.item_key, amount: Number(i.amount) }));
    for (const it of items) {
      if (it.amount > 0 && KEY_RE.test(String(it.item_key))) await admin.rpc("item_credit", { p_user: user.id, p_key: it.item_key, p_qty: it.amount });
    }
    return json({ ok: true, gold: goldOut, items });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
