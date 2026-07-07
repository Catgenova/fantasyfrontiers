-- ============================================================================
-- MARKETPLACE — player-to-player order-book exchange (gold-priced).
--
-- A shared continuous double auction: players place buy/sell limit orders; a new order that
-- crosses the book fills immediately (partial fills, price-time priority) at the RESTING order's
-- price. A 5% sales tax is burned on every fill (gold sink). Settled winnings land in a per-user
-- proceeds "inbox" the owner collects later (so an offline counterparty still gets paid).
--
-- Trust model — identical to the Guild Bank: the economy is CLIENT-AUTHORITATIVE. The server can't
-- prove a seller held the items or a buyer had the gold. Placing a sell removes items client-side;
-- placing a buy removes gold client-side; the resting order IS that escrow. What the server
-- guarantees is shared-state integrity: atomic matching, no dupes, no over-collect, correct tax.
-- Only item_key + numbers are stored; the client reconstructs names/icons from its registry, so no
-- HTML is ever stored or trusted.
--
-- Value caps keep every gold figure a safe JS integer (< 2^53): price <= 1e9, qty <= 1e6, so a
-- single fill's gross <= 1e15.
-- ============================================================================

-- Resting orders. A row is the escrow: a 'sell' holds qty_remaining items, a 'buy' holds
-- qty_remaining * unit_price gold (both already removed on the client that placed it).
create table if not exists public.market_orders (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  username      text not null check (char_length(username) between 1 and 32),
  side          text not null check (side in ('buy','sell')),
  item_key      text not null check (item_key ~ '^[A-Za-z0-9_]{1,64}$'),
  unit_price    bigint not null check (unit_price > 0 and unit_price <= 1000000000),
  qty_remaining bigint not null check (qty_remaining > 0 and qty_remaining <= 1000000),
  qty_original  bigint not null check (qty_original > 0 and qty_original <= 1000000),
  created_at    timestamptz not null default now()
);
create index if not exists market_orders_book_idx on public.market_orders (item_key, side, unit_price);
create index if not exists market_orders_user_idx on public.market_orders (user_id);

-- Settlement inbox. Gold rows use item_key='' (empty, not NULL) so the PK upsert works.
create table if not exists public.market_proceeds (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('gold','item')),
  item_key   text not null default '',
  amount     bigint not null check (amount > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, item_key)
);

-- Function-only tables: RLS on, no client policies (edge function service role + SECURITY DEFINER
-- RPCs are the only accessors).
alter table public.market_orders enable row level security;
alter table public.market_proceeds enable row level security;

-- Credit helpers: upsert into the proceeds inbox (used by the matching engine).
create or replace function public.market_credit_gold(p_user uuid, p_amount bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount is null or p_amount <= 0 then return; end if;
  insert into public.market_proceeds(user_id, kind, item_key, amount)
    values (p_user, 'gold', '', p_amount)
    on conflict (user_id, kind, item_key) do update set amount = public.market_proceeds.amount + excluded.amount, updated_at = now();
end $$;

create or replace function public.market_credit_item(p_user uuid, p_item text, p_qty bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_qty is null or p_qty <= 0 then return; end if;
  insert into public.market_proceeds(user_id, kind, item_key, amount)
    values (p_user, 'item', p_item, p_qty)
    on conflict (user_id, kind, item_key) do update set amount = public.market_proceeds.amount + excluded.amount, updated_at = now();
end $$;

-- The matching engine. Places p_qty of an order on p_side, filling against crossing resting orders
-- on the opposite side (price-time priority, skipping the caller's own orders), then resting any
-- remainder. Every fill executes at the RESTING order's price; the 5% tax is burned; both parties
-- are paid through the proceeds inbox (the active caller collects right after). Returns a summary
-- the client uses for UI feedback (actual crediting is via market_collect).
create or replace function public.market_place(
  p_user uuid, p_username text, p_side text, p_item text, p_price bigint, p_qty bigint
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_remaining bigint := p_qty;
  v_filled    bigint := 0;
  v_refund    bigint := 0;    -- price-improvement gold returned to an active BUY placer
  v_open_ct   int;
  rec         public.market_orders%rowtype;
  v_take      bigint;
  v_exec      bigint;
  v_gross     bigint;
  v_tax       bigint;
  v_net       bigint;
  v_order_id  bigint := null;
begin
  if p_side not in ('buy','sell') then return jsonb_build_object('status','bad'); end if;
  if p_item is null or p_item !~ '^[A-Za-z0-9_]{1,64}$' then return jsonb_build_object('status','bad'); end if;
  if p_username is null or char_length(p_username) < 1 or char_length(p_username) > 32 then return jsonb_build_object('status','bad'); end if;
  if p_price is null or p_price <= 0 or p_price > 1000000000 then return jsonb_build_object('status','bad'); end if;
  if p_qty  is null or p_qty  <= 0 or p_qty  > 1000000    then return jsonb_build_object('status','bad'); end if;

  select count(*) into v_open_ct from public.market_orders where user_id = p_user;
  if v_open_ct >= 40 then return jsonb_build_object('status','toomany'); end if;

  loop
    exit when v_remaining <= 0;
    if p_side = 'buy' then
      select * into rec from public.market_orders
        where item_key = p_item and side = 'sell' and user_id <> p_user and unit_price <= p_price
        order by unit_price asc, created_at asc, id asc
        for update skip locked limit 1;
    else
      select * into rec from public.market_orders
        where item_key = p_item and side = 'buy' and user_id <> p_user and unit_price >= p_price
        order by unit_price desc, created_at asc, id asc
        for update skip locked limit 1;
    end if;
    exit when not found;

    v_take  := least(v_remaining, rec.qty_remaining);
    v_exec  := rec.unit_price;                 -- execute at the resting order's price
    v_gross := v_take * v_exec;
    v_tax   := floor(v_gross * 0.05)::bigint;   -- burned
    v_net   := v_gross - v_tax;

    if p_side = 'buy' then
      perform public.market_credit_gold(rec.user_id, v_net);          -- resting seller earns
      v_filled := v_filled + v_take;                                  -- active buyer's items (credited after loop)
      v_refund := v_refund + v_take * (p_price - v_exec);             -- ...and price improvement
    else
      perform public.market_credit_gold(p_user, v_net);               -- active seller earns
      perform public.market_credit_item(rec.user_id, p_item, v_take); -- resting buyer's items
    end if;

    if rec.qty_remaining = v_take then
      delete from public.market_orders where id = rec.id;
    else
      update public.market_orders set qty_remaining = qty_remaining - v_take where id = rec.id;
    end if;
    v_remaining := v_remaining - v_take;
  end loop;

  if p_side = 'buy' and v_filled > 0 then
    perform public.market_credit_item(p_user, p_item, v_filled);
    if v_refund > 0 then perform public.market_credit_gold(p_user, v_refund); end if;
  end if;

  if v_remaining > 0 then
    -- qty_original = the full order size so the UI can show how much filled on placement.
    insert into public.market_orders(user_id, username, side, item_key, unit_price, qty_remaining, qty_original)
      values (p_user, p_username, p_side, p_item, p_price, v_remaining, p_qty)
      returning id into v_order_id;
  end if;

  return jsonb_build_object('status','ok','filled', v_filled, 'rest', v_remaining, 'refund', v_refund, 'order_id', v_order_id);
end $$;

-- Cancel: delete the caller's order (locked) and report the remaining escrow so the client
-- re-credits it (sell -> items back; buy -> qty_remaining*unit_price gold back).
create or replace function public.market_cancel(p_user uuid, p_order bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rec public.market_orders%rowtype;
begin
  select * into rec from public.market_orders where id = p_order and user_id = p_user for update;
  if not found then return jsonb_build_object('status','notfound'); end if;
  delete from public.market_orders where id = rec.id;
  return jsonb_build_object('status','ok','side',rec.side,'item_key',rec.item_key,'qty',rec.qty_remaining,'unit_price',rec.unit_price);
end $$;

-- Collect: drain the caller's proceeds inbox atomically (delete-returning avoids losing a
-- concurrently-credited fill). Returns total gold + a per-item list for the client to apply.
create or replace function public.market_collect(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_gold bigint; v_items jsonb;
begin
  with del as (
    delete from public.market_proceeds where user_id = p_user returning kind, item_key, amount
  )
  select coalesce(sum(amount) filter (where kind = 'gold'), 0),
         coalesce(jsonb_agg(jsonb_build_object('item_key', item_key, 'amount', amount)) filter (where kind = 'item'), '[]'::jsonb)
    into v_gold, v_items from del;
  return jsonb_build_object('status','ok','gold', v_gold, 'items', v_items);
end $$;
