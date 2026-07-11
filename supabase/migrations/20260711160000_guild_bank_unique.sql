-- ============================================================================
-- GUILD BANK — store UNIQUE (enchanted / enhanced) equipment.
-- Uniques carry per-instance data (base id + enchants + enhance), so unlike stackable goods they can't
-- be a key+qty stack -- each is its own row and counts as ONE bank slot (shared with the stackable
-- vault against guilds.bank_slots). Trust model matches the stackable bank: item OWNERSHIP is
-- client-authoritative (uniques live outside the server item ledger, so the server can't prove the
-- depositor held it); the server only guarantees vault integrity -- no dupe/over-withdraw, and the
-- shared slot cap. No HTML is stored: the client reconstructs the card from base/kind/tier/rarity.
-- ============================================================================
create table if not exists public.guild_bank_unique (
  id           bigint generated always as identity primary key,
  guild_id     uuid not null references public.guilds(id) on delete cascade,
  base         text not null check (char_length(base) between 1 and 64),
  kind         text not null check (char_length(kind) between 1 and 24),
  tier         int  not null default 0 check (tier >= 0 and tier <= 40),
  rarity       text not null check (rarity in ('normal','rare','supreme','fantastic')),
  enhance      int  not null default 0 check (enhance >= 0 and enhance <= 15),
  enchants     jsonb not null default '[]'::jsonb check (jsonb_typeof(enchants) = 'array' and char_length(enchants::text) <= 2048),
  deposited_by uuid,
  updated_at   timestamptz not null default now()
);
create index if not exists guild_bank_unique_guild_idx on public.guild_bank_unique (guild_id);

-- Function-only table: RLS on, no client policies (only the edge function + SECURITY DEFINER RPCs touch it).
alter table public.guild_bank_unique enable row level security;

-- Every unique row now also counts toward the slot cap, so the STACKABLE deposit must count uniques too.
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
  select (select count(*) from public.guild_bank where guild_id = p_guild)
       + (select count(*) from public.guild_bank_unique where guild_id = p_guild) into v_used;
  if v_used >= v_slots then return 'full'; end if;
  insert into public.guild_bank(guild_id, item_key, qty) values (p_guild, p_key, p_qty);
  return 'ok';
end $$;

-- Atomic deposit of one unique: refuse (-2) when the combined stack + unique count is at the slot cap,
-- -1 on bad input. Returns the new row id (the "bank uid") on success.
create or replace function public.guild_bank_deposit_unique(
  p_guild uuid, p_base text, p_kind text, p_tier int, p_rarity text, p_enhance int, p_enchants jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_slots int; v_used int; v_id bigint;
begin
  if p_base is null or char_length(p_base) < 1 or char_length(p_base) > 64 then return -1; end if;
  if p_rarity not in ('normal','rare','supreme','fantastic') then return -1; end if;
  if p_enchants is null or jsonb_typeof(p_enchants) <> 'array' or char_length(p_enchants::text) > 2048 then return -1; end if;
  select bank_slots into v_slots from public.guilds where id = p_guild;
  if v_slots is null then return -1; end if;
  select (select count(*) from public.guild_bank where guild_id = p_guild)
       + (select count(*) from public.guild_bank_unique where guild_id = p_guild) into v_used;
  if v_used >= v_slots then return -2; end if;
  insert into public.guild_bank_unique(guild_id, base, kind, tier, rarity, enhance, enchants, deposited_by)
    values (p_guild, p_base, coalesce(nullif(p_kind,''),'weapon'), coalesce(p_tier,0), p_rarity,
            least(greatest(coalesce(p_enhance,0),0),15), p_enchants, auth.uid())
    returning id into v_id;
  return v_id;
end $$;

-- Atomic withdraw of one unique by its bank id: deletes it and returns its full blob (or null if gone).
create or replace function public.guild_bank_withdraw_unique(p_guild uuid, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.guild_bank_unique;
begin
  select * into v_row from public.guild_bank_unique where guild_id = p_guild and id = p_id for update;
  if v_row.id is null then return null; end if;
  delete from public.guild_bank_unique where id = v_row.id;
  return jsonb_build_object('bank_uid', v_row.id, 'base', v_row.base, 'kind', v_row.kind,
    'tier', v_row.tier, 'rarity', v_row.rarity, 'enhance', v_row.enhance, 'enchants', v_row.enchants);
end $$;
