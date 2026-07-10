-- ============================================================================
-- SERVER-AUTHORITATIVE GOLD WALLET (Stage 1 of the anti-cheat migration).
--
-- Today the economy is client-authoritative: a tampered client can set state.gold to anything and
-- spend it on the Marketplace / Guild Bank, harming other players. This introduces a server-owned
-- gold balance per player. The plan lands in stages so nothing breaks mid-flight:
--   Stage 1 (this file): the ledger table + atomic debit/credit RPCs + a `wallet` edge function.
--            ADDITIVE ONLY -- the client does not read/write it yet, so deploying this changes nothing.
--   Stage 2: the client displays the server balance and flushes earnings through wallet.earn (which
--            rate-limits how fast gold can be credited, capping spoofed "earnings").
--   Stage 3: every gold SPEND (market buy, guild donate/withdraw, buff, guild create) debits this
--            wallet server-side via wallet_debit and rejects when the balance is insufficient --
--            which is what actually stops spoofed gold from being spent.
--
-- Trust model going forward: SPENDING is hard-enforced against the server balance; EARNING is
-- client-reported but rate-limited (the server can't simulate combat/gathering, so it caps the
-- credit rate the same way submit_profile caps leaderboard gains). Existing balances are grandfathered
-- in on first touch (seeded from the player's current save) so nobody loses their hard-earned gold.
-- ============================================================================

create table if not exists public.player_wallet (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  gold         bigint      not null default 0 check (gold >= 0),
  earned_total bigint      not null default 0,       -- lifetime gold the client has reported earning (rate-limit anchor)
  seeded       boolean     not null default false,    -- has the one-time migration from the save's gold run?
  updated_at   timestamptz not null default now()
);

alter table public.player_wallet enable row level security;

-- The owner may READ their own balance (the client shows it). Only the service role (the edge
-- functions / SECURITY DEFINER RPCs) ever writes -- there is no client insert/update policy.
drop policy if exists wallet_read on public.player_wallet;
create policy wallet_read on public.player_wallet
  for select using (auth.uid() = user_id);

-- Atomic debit: subtract p_amount only if the balance covers it; returns whether it succeeded. A
-- non-positive amount is a no-op success. This is the gate that makes spoofed gold unspendable --
-- the row simply doesn't have the gold, so the update matches nothing and returns false.
create or replace function public.wallet_debit(p_user uuid, p_amount bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  if p_amount is null or p_amount <= 0 then return true; end if;
  update public.player_wallet set gold = gold - p_amount, updated_at = now()
    where user_id = p_user and gold >= p_amount
    returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- Atomic credit: add p_amount (creating the row if needed); returns the new balance. Used by the
-- earn path and by seller/refund credits. Capped at a 1e15 sanity ceiling so a bug can't mint infinity.
create or replace function public.wallet_credit(p_user uuid, p_amount bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_gold bigint;
begin
  if p_amount is null or p_amount <= 0 then
    select gold into v_gold from public.player_wallet where user_id = p_user;
    return coalesce(v_gold, 0);
  end if;
  insert into public.player_wallet(user_id, gold) values (p_user, least(p_amount, 1000000000000000))
    on conflict (user_id) do update
      set gold = least(public.player_wallet.gold + excluded.gold, 1000000000000000), updated_at = now()
    returning gold into v_gold;
  return v_gold;
end $$;

-- One-time seed: grandfather a player's existing (client-authoritative) gold into the ledger the
-- first time it's touched, so nobody loses progress at cutover. Runs at most once per player.
create or replace function public.wallet_seed(p_user uuid, p_gold bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_gold bigint;
begin
  insert into public.player_wallet(user_id, gold, seeded)
    values (p_user, greatest(0, least(coalesce(p_gold,0), 1000000000000000)), true)
    on conflict (user_id) do nothing;
  select gold into v_gold from public.player_wallet where user_id = p_user;
  return coalesce(v_gold, 0);
end $$;

-- Function-only access: revoke direct EXECUTE from the client roles (PostgREST exposes SECURITY
-- DEFINER funcs to PUBLIC by default) and grant only to the service role the edge functions use.
do $$
declare fn text; fns text[] := array[
  'public.wallet_debit(uuid, bigint)',
  'public.wallet_credit(uuid, bigint)',
  'public.wallet_seed(uuid, bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
