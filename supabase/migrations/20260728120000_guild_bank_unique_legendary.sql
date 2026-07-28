-- ============================================================================
-- GUILD BANK — carry a UNIQUE's legendary / armor-set identity through the vault.
--
-- Bug: a banked Masterwork legendary (a unique with a `leg` key) or an armor-set piece (`set`/`setLayer`)
-- read back as its plain BASE ("Rare Tool Steel Rapier") instead of its legendary/set name ("Rare
-- Bloodwaltz"), because the vault only stored base/kind/tier/rarity/enhance/enchants. Worse, a WITHDRAWN
-- legendary lost its `leg` entirely -- its effect vanished, leaving a plain base weapon.
--
-- Fix: persist leg / set_key / set_layer alongside the rest of the blob and hand them back on withdraw,
-- so the client re-mints the item with its real name AND effect. All three are nullable, so plain
-- (non-legendary, non-set) uniques are unaffected.
-- ============================================================================
alter table public.guild_bank_unique
  add column if not exists leg       text,
  add column if not exists set_key   text,
  add column if not exists set_layer text;

-- Deposit now accepts the legendary/set identity (all default null -> older callers keep working).
drop function if exists public.guild_bank_deposit_unique(uuid, text, text, int, text, int, jsonb);
create or replace function public.guild_bank_deposit_unique(
  p_guild uuid, p_base text, p_kind text, p_tier int, p_rarity text, p_enhance int, p_enchants jsonb,
  p_leg text default null, p_set text default null, p_set_layer text default null)
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
  insert into public.guild_bank_unique(guild_id, base, kind, tier, rarity, enhance, enchants, leg, set_key, set_layer, deposited_by)
    values (p_guild, p_base, coalesce(nullif(p_kind,''),'weapon'), coalesce(p_tier,0), p_rarity,
            least(greatest(coalesce(p_enhance,0),0),15), p_enchants,
            nullif(left(coalesce(p_leg,''),48),''), nullif(left(coalesce(p_set,''),48),''), nullif(left(coalesce(p_set_layer,''),8),''),
            auth.uid())
    returning id into v_id;
  return v_id;
end $$;

-- Withdraw returns the legendary/set identity so the client restores name + effect. Keys are shaped for
-- the client (`set` / `setLayer`), matching the unique-object fields it re-mints from.
create or replace function public.guild_bank_withdraw_unique(p_guild uuid, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.guild_bank_unique;
begin
  select * into v_row from public.guild_bank_unique where guild_id = p_guild and id = p_id for update;
  if v_row.id is null then return null; end if;
  delete from public.guild_bank_unique where id = v_row.id;
  return jsonb_build_object('bank_uid', v_row.id, 'base', v_row.base, 'kind', v_row.kind,
    'tier', v_row.tier, 'rarity', v_row.rarity, 'enhance', v_row.enhance, 'enchants', v_row.enchants,
    'leg', v_row.leg, 'set', v_row.set_key, 'setLayer', v_row.set_layer);
end $$;
