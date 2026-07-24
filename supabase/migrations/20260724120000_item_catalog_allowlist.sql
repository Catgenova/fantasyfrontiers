-- ============================================================================
-- ITEM-KEY ALLOWLIST — reject made-up item keys across the ledger and the marketplace.
--
-- Reported (pentest): the marketplace accepted BUY orders for an arbitrary item_key
-- (`fake_item_does_not_exist`) — market_place validated only the key CHARSET (^[A-Za-z0-9_]{1,64}$),
-- never that the item is real. And because item_sync ledgers whatever keys a (client-authoritative)
-- inventory reports, a tampered client could also mint a fake item INTO the ledger and then sell it.
--
-- Fix: a server-side catalog of every legitimate item key (dumped from the client's registries by
-- scripts/dump-item-catalog.mjs -> supabase/seeds/item_catalog_seed.sql, CI-checked so it can't drift).
--   * item_sync only ledgers CATALOGUED keys  -> a fake item can't enter the ledger (can't be sold/banked).
--   * market_place only rests/matches TRADEABLE keys -> a fake (or non-tradeable, e.g. Legendary) item
--     can't be listed or bid on.
-- `tradeable` distinguishes the two universes: everything in the client's ALL_SELLABLE is tradeable(true);
-- Legendary equipment lives in inventory (so it must be catalogued or item_sync/adoption would drop it)
-- but is NOT market-tradeable (false).
--
-- SAFE ROLLOUT: both gates are NO-OPS while the catalog table is EMPTY (deploy this migration, nothing
-- changes), and only start enforcing once the seed has been loaded. So the order is: (1) run this
-- migration, (2) run supabase/seeds/item_catalog_seed.sql. If a later client ships new items, re-run the
-- dump + seed (CI --check fails the build if the committed seed is stale) BEFORE/with that client deploy.
-- ============================================================================

create table if not exists public.item_catalog (
  item_key  text    not null primary key check (item_key ~ '^[A-Za-z0-9_]{1,64}$'),
  tradeable boolean not null default true
);

-- Function-only table (matches recipe_inputs): RLS on, no client policy. The service-role edge functions
-- and the SECURITY DEFINER RPCs are the only readers; clients have their own client-side registry.
alter table public.item_catalog enable row level security;

-- ---- item_sync (5-arg): only ledger catalogued keys ------------------------------------------------
-- Rebuild of the current item_sync (20260715050000_item_earned_total) with a single added guard: a
-- reported key that isn't in a POPULATED catalog is skipped entirely (never seeded, credited, or rowed),
-- so a tampered inventory can't mint a fake item into the ledger. Everything else — the account-age
-- grandfather cap (20260715020000), the prev=0 burst grant (20260713170000), and earned_total accrual
-- (20260715050000) — is preserved verbatim.
create or replace function public.item_sync(
  p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint, p_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint; credited bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb; grandfather_cap bigint; age_hours numeric;
  catalog_ready boolean;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded into is_seeded from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  -- Enforce the allowlist ONLY once it's been seeded; an empty catalog gates nothing (safe deploy window).
  select exists (select 1 from public.item_catalog) into catalog_ready;

  age_hours := greatest(0, extract(epoch from (now() - coalesce(p_created_at, now()))) / 3600.0);
  grandfather_cap := least(1000000000000, greatest(p_burst, floor(p_per_hour * age_hours)::bigint));

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    -- Unknown item key (not in the populated catalog) -> not a real item; never enters the ledger.
    if catalog_ready and not exists (select 1 from public.item_catalog c where c.item_key = k) then
      continue;
    end if;
    if not is_seeded then
      newq := least(reported, grandfather_cap);                 -- first sync: grandfather, capped by account age
      credited := newq;                                         -- the whole grandfathered stock counts as earned
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      if prev is null then prev := 0; end if;
      if prev = 0 then
        allowed := p_burst;                                     -- new OR depleted-to-0: grant the burst up front
      else
        allowed := least(p_burst, floor(p_per_hour * (extract(epoch from (now() - prev_at)) / 3600.0))::bigint);
        if allowed < 0 then allowed := 0; end if;
      end if;
      newq := least(reported, least(prev + allowed, 1000000000000));
      if newq < 0 then newq := 0; end if;
      credited := greatest(0, newq - prev);                     -- only an INCREASE counts as newly earned
    end if;
    insert into public.player_items(user_id, item_key, qty, earned_total, updated_at)
      values (p_user, k, newq, credited, now())
      on conflict (user_id, item_key) do update
        set qty = excluded.qty,
            earned_total = public.player_items.earned_total + excluded.earned_total,
            updated_at = case when excluded.qty > public.player_items.qty then now() else public.player_items.updated_at end;
    result := result || jsonb_build_object(k, newq);
  end loop;

  -- Anything the ledger holds that the client no longer reports was spent/dropped -> zero the QTY (but
  -- NOT earned_total, which is monotonic lifetime-credited).
  update public.player_items set qty = 0, updated_at = now()
    where user_id = p_user and qty > 0 and not (p_items ? item_key);

  insert into public.player_item_meta(user_id, seeded, synced_at) values (p_user, true, now())
    on conflict (user_id) do update set seeded = true, synced_at = now();
  return result;
end $$;

-- ---- market_place: only rest/match TRADEABLE catalogued keys ----------------------------------------
-- Rebuild of market_place (20260707040000_marketplace) with a single added guard right after the key
-- charset check: an item that isn't a TRADEABLE catalogued key (while the catalog is populated) is
-- rejected with status 'badkey'. The edge function refunds the caller's escrow and reports it. Matching /
-- tax / escrow logic below is unchanged.
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
  -- Item-key allowlist (enforced only once the catalog is seeded): reject made-up or non-tradeable keys.
  if exists (select 1 from public.item_catalog)
     and not exists (select 1 from public.item_catalog c where c.item_key = p_item and c.tradeable) then
    return jsonb_build_object('status','badkey');
  end if;
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
    insert into public.market_orders(user_id, username, side, item_key, unit_price, qty_remaining, qty_original)
      values (p_user, p_username, p_side, p_item, p_price, v_remaining, p_qty)
      returning id into v_order_id;
  end if;

  return jsonb_build_object('status','ok','filled', v_filled, 'rest', v_remaining, 'refund', v_refund, 'order_id', v_order_id);
end $$;

-- Function-only access (service role only; revoke from client roles) -- matches item_sync / market_place.
do $$
declare fn text; fns text[] := array[
  'public.item_sync(uuid, jsonb, bigint, bigint, timestamptz)',
  'public.market_place(uuid, text, text, text, bigint, bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
