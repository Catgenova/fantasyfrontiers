-- ============================================================================
-- GUILDS — Phase 4: async damage-pool Guild Bosses.
--
-- An officer summons a boss with a shared HP pool. Members "assault" it: each ping
-- accrues damage = combat_power * elapsed_time, rate-capped server-side (the power is a
-- client DPS proxy, clamped; elapsed is capped per ping) so nobody can dump impossible
-- damage. When HP hits 0 the boss is defeated: its gold goes to the guild TREASURY (once),
-- and each contributor CLAIMS an item share proportional to the damage they dealt (items
-- land in the claimer's own inventory — client-authoritative, same as the rest of the
-- economy). The server owns the shared pool: atomic damage subtraction, one-active-boss,
-- single gold payout, and single claim per contributor.
-- ============================================================================

create table if not exists public.guild_bosses (
  id           bigint generated always as identity primary key,
  guild_id     uuid not null references public.guilds(id) on delete cascade,
  boss_key     text not null,
  name         text not null,
  hp_max       bigint not null,
  hp_current   bigint not null,
  gold_reward  bigint not null default 0,
  total_damage bigint not null default 0,
  status       text not null default 'active' check (status in ('active','defeated','expired')),
  started_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  defeated_at  timestamptz
);
-- At most one ACTIVE boss per guild (partial unique index).
create unique index if not exists guild_bosses_one_active on public.guild_bosses (guild_id) where status = 'active';
create index if not exists guild_bosses_guild_idx on public.guild_bosses (guild_id);

create table if not exists public.guild_boss_damage (
  boss_id   bigint not null references public.guild_bosses(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  username  text not null,
  damage    bigint not null default 0,
  last_tick timestamptz not null default now(),
  claimed   boolean not null default false,
  primary key (boss_id, user_id)
);

-- Function-only tables (RLS on, no client policies).
alter table public.guild_bosses enable row level security;
alter table public.guild_boss_damage enable row level security;

-- Atomic assault: accrue this member's damage (power * elapsed, elapsed capped by caller),
-- subtract from the shared HP pool, and on the killing blow flip to 'defeated' and pay the
-- boss gold into the guild treasury exactly once. The boss row lock serializes assaults.
create or replace function public.guild_boss_assault(p_boss bigint, p_user uuid, p_username text, p_power bigint, p_max_seconds int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_guild uuid; v_status text; v_hp bigint; v_hpmax bigint; v_exp timestamptz; v_gold bigint;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_mydmg bigint; v_defeated boolean := false;
begin
  select guild_id, status, hp_current, hp_max, expires_at, gold_reward
    into v_guild, v_status, v_hp, v_hpmax, v_exp, v_gold
    from public.guild_bosses where id = p_boss for update;
  if v_guild is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  if now() >= v_exp then
    update public.guild_bosses set status = 'expired' where id = p_boss;
    return jsonb_build_object('status','expired');
  end if;
  if p_power < 0 then p_power := 0; end if;

  select damage, last_tick into v_mydmg, v_last
    from public.guild_boss_damage where boss_id = p_boss and user_id = p_user;
  if not found then v_last := now() - interval '3 seconds'; v_mydmg := 0; end if;
  v_elapsed := extract(epoch from (now() - v_last));
  if v_elapsed < 0 then v_elapsed := 0; end if;
  if v_elapsed > p_max_seconds then v_elapsed := p_max_seconds; end if;
  v_add := floor(p_power * v_elapsed);
  if v_add < 0 then v_add := 0; end if;

  insert into public.guild_boss_damage(boss_id, user_id, username, damage, last_tick)
    values (p_boss, p_user, p_username, v_add, now())
    on conflict (boss_id, user_id)
      do update set damage = public.guild_boss_damage.damage + v_add, last_tick = now(), username = excluded.username;
  v_mydmg := v_mydmg + v_add;
  v_hp := v_hp - v_add;

  if v_hp <= 0 then
    v_hp := 0; v_defeated := true;
    update public.guild_bosses set hp_current = 0, total_damage = total_damage + v_add, status = 'defeated', defeated_at = now() where id = p_boss;
    update public.guilds set treasury = treasury + v_gold where id = v_guild;
  else
    update public.guild_bosses set hp_current = v_hp, total_damage = total_damage + v_add where id = p_boss;
  end if;

  return jsonb_build_object('status', case when v_defeated then 'defeated' else 'active' end,
    'hp_current', v_hp, 'hp_max', v_hpmax, 'added', v_add, 'my_damage', v_mydmg, 'defeated', v_defeated);
end $$;

-- Atomic claim: mark this contributor's share claimed once, return the damage fractions so
-- the client can grant the proportional item loot into its own inventory.
create or replace function public.guild_boss_claim(p_boss bigint, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_total bigint; v_key text; v_mydmg bigint; v_claimed boolean;
begin
  select status, total_damage, boss_key into v_status, v_total, v_key from public.guild_bosses where id = p_boss;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'defeated' then return jsonb_build_object('status','notdefeated'); end if;
  select damage, claimed into v_mydmg, v_claimed
    from public.guild_boss_damage where boss_id = p_boss and user_id = p_user for update;
  if v_mydmg is null or v_mydmg <= 0 then return jsonb_build_object('status','nocontribution'); end if;
  if v_claimed then return jsonb_build_object('status','claimed'); end if;
  update public.guild_boss_damage set claimed = true where boss_id = p_boss and user_id = p_user;
  return jsonb_build_object('status','ok','boss_key',v_key,'my_damage',v_mydmg,'total_damage',greatest(v_total,1));
end $$;
