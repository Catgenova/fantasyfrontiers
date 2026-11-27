-- ============================================================================
-- GUILDS — Phase 2: shared Guild Bank.
--
-- A vault of item stacks (one row per item type). The number of distinct stacks is
-- capped by guilds.bank_slots (starts at 5, buyable up to 500). All access goes through
-- the `guild_bank` edge function (service role) plus the SECURITY DEFINER RPCs below,
-- which make deposits/withdrawals/slot-buys atomic and capacity-checked.
--
-- Trust model: item OWNERSHIP is client-authoritative, like the rest of the economy —
-- the server can't prove a depositor actually held the item. What the server DOES
-- guarantee is the shared vault's integrity: no over-withdraw, no withdraw races/dupes,
-- and the slot cap. That's the meaningful server-authority for shared state. The bank
-- stores only `item_key` + `qty`; the client reconstructs name/icon from its item
-- registry, so no HTML is ever stored or trusted.
-- ============================================================================

-- Leader-set minimum rank required to withdraw (deposits are always open to members).
alter table public.guilds
  add column if not exists bank_min_withdraw_rank text not null default 'member'
  check (bank_min_withdraw_rank in ('member','officer','leader'));

create table if not exists public.guild_bank (
  id         bigint generated always as identity primary key,
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  item_key   text not null check (char_length(item_key) between 1 and 64),
  qty        bigint not null check (qty > 0),
  updated_at timestamptz not null default now(),
  unique (guild_id, item_key)
);
create index if not exists guild_bank_guild_idx on public.guild_bank (guild_id);

-- Function-only table: RLS on, no client policies (the edge function + RPCs are the
-- only writers/readers; the service role and SECURITY DEFINER bypass RLS).
alter table public.guild_bank enable row level security;

-- Atomic deposit: top up an existing stack, or open a new one if under the slot cap.
create or replace function public.guild_bank_deposit(p_guild uuid, p_key text, p_qty bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_slots int; v_used int; v_exists boolean;
begin
  if p_qty is null or p_qty <= 0 or p_key is null or char_length(p_key) > 64 then return 'bad'; end if;
  select bank_slots into v_slots from public.guilds where id = p_guild;
  if v_slots is null then return 'bad'; end if;
  select exists(select 1 from public.guild_bank where guild_id = p_guild and item_key = p_key) into v_exists;
  if v_exists then
    update public.guild_bank set qty = qty + p_qty, updated_at = now()
      where guild_id = p_guild and item_key = p_key;
    return 'ok';
  end if;
  select count(*) into v_used from public.guild_bank where guild_id = p_guild;
  if v_used >= v_slots then return 'full'; end if;
  insert into public.guild_bank(guild_id, item_key, qty) values (p_guild, p_key, p_qty);
  return 'ok';
end $$;

-- Atomic withdraw: decrement if enough on hand; delete the stack when it hits zero.
create or replace function public.guild_bank_withdraw(p_guild uuid, p_key text, p_qty bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_qty bigint;
begin
  if p_qty is null or p_qty <= 0 then return 'bad'; end if;
  select qty into v_qty from public.guild_bank
    where guild_id = p_guild and item_key = p_key for update;
  if v_qty is null or v_qty < p_qty then return 'short'; end if;
  if v_qty = p_qty then
    delete from public.guild_bank where guild_id = p_guild and item_key = p_key;
  else
    update public.guild_bank set qty = qty - p_qty, updated_at = now()
      where guild_id = p_guild and item_key = p_key;
  end if;
  return 'ok';
end $$;

-- Atomic slot purchase. Cost = 10,000 * 1.25^(slots-5), computed on the locked row so
-- concurrent buys can't underpay. Gold is deducted client-side (client-authoritative);
-- this only grows the authoritative slot cap. Returns the cost so the client charges the
-- exact server price.
create or replace function public.guild_bank_buy_slot(p_guild uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_slots int; v_costn numeric; v_cost bigint;
begin
  select bank_slots into v_slots from public.guilds where id = p_guild for update;
  if v_slots is null then return jsonb_build_object('status','bad'); end if;
  if v_slots >= 500 then return jsonb_build_object('status','max'); end if;
  v_costn := round(10000 * power(1.25::numeric, (v_slots - 5)::numeric));
  if v_costn > 9000000000000000000 then return jsonb_build_object('status','toohigh'); end if;
  v_cost := v_costn::bigint;
  update public.guilds set bank_slots = bank_slots + 1 where id = p_guild;
  return jsonb_build_object('status','ok','cost',v_cost,'slots',v_slots + 1);
end $$;
