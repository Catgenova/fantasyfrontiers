-- ============================================================================
-- SERVER-AUTHORITATIVE ITEM LEDGER (the item counterpart of player_wallet).
--
-- The gold wallet stopped spoofed GOLD from being spent on other players. Items are still
-- client-authoritative, so a tampered client can mint items and SELL them on the marketplace (for
-- real, wallet-gated gold from a real buyer) or DEPOSIT them into a guild bank -- inflating the
-- shared economy. This ledger is the item analogue: a server-owned count of what each player holds.
--
-- Rollout mirrors the wallet, in stages so nothing breaks mid-flight:
--   Stage 1 (this file): the ledger table + atomic item_debit/item_credit + the item_sync reconcile.
--            ADDITIVE ONLY -- the client doesn't read/write it yet, so deploying this changes nothing.
--   Stage 2: the client reconciles its inventory through item_sync (grandfather once, then rate-cap
--            increases + clamp to the reported count), the same shape as the gold walletSync.
--   Stage 3: market SELL and guild-bank DEPOSIT debit this ledger (item_debit) and are rejected when
--            it can't cover them; market BUY / bank WITHDRAW / cancelled sell credit it (item_credit).
--
-- Trust model: identical to gold. SPENDING (listing/depositing) is hard-enforced against the ledger;
-- EARNING is client-reported but RATE-LIMITED per item type (the server can't simulate gathering /
-- crafting). A player's existing stock is grandfathered in once on first sync.
-- ============================================================================

create table if not exists public.player_items (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  item_key   text        not null,
  qty        bigint      not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),  -- last time qty was CREDITED (rate-limit accrual clock)
  primary key (user_id, item_key)
);

-- One row per player: has the one-time grandfather of the existing inventory run yet?
create table if not exists public.player_item_meta (
  user_id   uuid        primary key references auth.users(id) on delete cascade,
  seeded    boolean     not null default false,
  synced_at timestamptz not null default now()
);

alter table public.player_items enable row level security;
alter table public.player_item_meta enable row level security;

-- Owners may READ their own ledger (the client shows/uses it). Only the service role writes.
drop policy if exists items_read on public.player_items;
create policy items_read on public.player_items for select using (auth.uid() = user_id);
drop policy if exists item_meta_read on public.player_item_meta;
create policy item_meta_read on public.player_item_meta for select using (auth.uid() = user_id);

-- 1e12 per-stack sanity ceiling (a stack can't exceed this; a bug can't mint infinity).
-- ITEM rate limits (per item type). Allowed increase per sync = min(BURST, PER_HOUR * hoursElapsed),
-- a token bucket keyed on each row's updated_at -- so hammering item_sync grants nothing extra.
-- Generous defaults: even a fast 12h offline haul of one item stays well under these.

-- Atomic debit: subtract p_qty of one item only if the row has it. Returns whether it succeeded.
-- This is the gate that makes minted items unlistable -- the ledger simply doesn't have them.
create or replace function public.item_debit(p_user uuid, p_key text, p_qty bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  if p_qty is null or p_qty <= 0 then return true; end if;
  update public.player_items set qty = qty - p_qty, updated_at = updated_at
    where user_id = p_user and item_key = p_key and qty >= p_qty
    returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- Atomic credit: add p_qty of one item (create the row if needed); returns the new qty. Used by the
-- reconcile and by market-buy / bank-withdraw / cancelled-sell receipts. Capped at the stack ceiling.
create or replace function public.item_credit(p_user uuid, p_key text, p_qty bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_qty bigint;
begin
  if p_qty is null or p_qty <= 0 then
    select qty into v_qty from public.player_items where user_id = p_user and item_key = p_key;
    return coalesce(v_qty, 0);
  end if;
  insert into public.player_items(user_id, item_key, qty)
    values (p_user, p_key, least(p_qty, 1000000000000))
    on conflict (user_id, item_key) do update
      set qty = least(public.player_items.qty + excluded.qty, 1000000000000), updated_at = now()
    returning qty into v_qty;
  return v_qty;
end $$;

-- Whole-inventory reconcile. p_items is the client's full inventory { item_key: qty }. On the player's
-- FIRST sync we grandfather every reported stock as-is (existing players keep their goods); after that
-- each item's INCREASE is rate-capped (token bucket on the row's updated_at) and the stored qty is
-- clamped to what the client reports -- so a spoofed-high count can't push the ledger up (min only
-- lowers), while genuine spending pulls it down with no per-item plumbing. Items the client no longer
-- reports are zeroed. Returns the reconciled ledger { item_key: qty } for the client to adopt.
create or replace function public.item_sync(p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded into is_seeded from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    if not is_seeded then
      newq := least(reported, 1000000000000);                 -- first sync: grandfather as-is
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      if prev is null then prev := 0; prev_at := now(); end if; -- a NEW item type after seeding starts empty
      allowed := least(p_burst, floor(p_per_hour * (extract(epoch from (now() - prev_at)) / 3600.0))::bigint);
      if allowed < 0 then allowed := 0; end if;
      newq := least(reported, least(prev + allowed, 1000000000000));
      if newq < 0 then newq := 0; end if;
    end if;
    insert into public.player_items(user_id, item_key, qty, updated_at)
      values (p_user, k, newq, now())
      on conflict (user_id, item_key) do update
        -- advance the accrual clock only when we actually credited more (so idle syncs keep filling)
        set qty = excluded.qty,
            updated_at = case when excluded.qty > public.player_items.qty then now() else public.player_items.updated_at end;
    result := result || jsonb_build_object(k, newq);
  end loop;

  -- Anything the ledger holds that the client no longer reports was spent/dropped -> zero it so stale
  -- stock can't linger and be listed later.
  update public.player_items set qty = 0, updated_at = now()
    where user_id = p_user and qty > 0 and not (p_items ? item_key);

  insert into public.player_item_meta(user_id, seeded, synced_at) values (p_user, true, now())
    on conflict (user_id) do update set seeded = true, synced_at = now();
  return result;
end $$;

-- Function-only access: revoke direct EXECUTE from the client roles, grant only to the service role
-- the edge functions run as (matches the wallet / lock_down_rpc pattern).
do $$
declare fn text; fns text[] := array[
  'public.item_debit(uuid, text, bigint)',
  'public.item_credit(uuid, text, bigint)',
  'public.item_sync(uuid, jsonb, bigint, bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
