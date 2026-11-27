-- ============================================================================
-- GUILDS — Guild Bosses REWORK: 5 tower-style bosses, solo entry, daily reset.
--
-- Replaces the async shared-HP damage-pool bosses. Now there are 5 fixed bosses per guild
-- (indices 0..4) at rising Tower-floor difficulties. Each is entered like a Tower fight:
--   * A member may ENTER at most ONE boss per UTC day (win or lose, it spends their day).
--   * The FIRST member to defeat a boss CLEARS it for the whole guild for that day; nobody
--     else can enter that boss until the next UTC day.
--   * On a clear, EVERY current guild member is credited barrier shards (reward scales with
--     the boss: index+1 => 1..5), banked as a pending balance they claim on next sync
--     (offline members get theirs on return). Shards land in the claimer's inventory
--     client-side, same client-authoritative item model as the rest of the economy.
--   * Everything is keyed by UTC day, so the roster "resets" implicitly each day with no cron.
-- The combat itself runs in the player's client (Tower-equivalent foe); the server owns the
-- cross-player clear lock, the one-entry-per-day limit, and the guild-wide shard payout.
-- ============================================================================

-- Retire the old damage-pool schema (replaced wholesale).
drop function if exists public.guild_boss_assault(bigint, uuid, text, bigint, int);
drop function if exists public.guild_boss_claim(bigint, uuid);
drop table if exists public.guild_boss_damage;
drop table if exists public.guild_bosses;

-- One row per (guild, UTC day, boss index) — its existence IS the "cleared today" lock.
create table if not exists public.guild_boss_clears (
  guild_id            uuid not null references public.guilds(id) on delete cascade,
  day                 date not null,
  boss_idx            int  not null check (boss_idx between 0 and 4),
  cleared_by_user     uuid not null references auth.users(id) on delete set null,
  cleared_by_username text not null,
  cleared_at          timestamptz not null default now(),
  primary key (guild_id, day, boss_idx)
);
create index if not exists guild_boss_clears_guild_day_idx on public.guild_boss_clears (guild_id, day);

-- One row per (member, UTC day) — the one-entry-per-day limit. boss_idx records which boss they took.
create table if not exists public.guild_boss_entries (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  boss_idx   int  not null check (boss_idx between 0 and 4),
  entered_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Running unclaimed barrier-shard balance from guild-boss clears (claimed into inventory on sync).
create table if not exists public.guild_boss_pending (
  user_id uuid primary key references auth.users(id) on delete cascade,
  shards  bigint not null default 0
);

-- Function-only tables (RLS on, no client policies; the edge function uses the service role).
alter table public.guild_boss_clears  enable row level security;
alter table public.guild_boss_entries enable row level security;
alter table public.guild_boss_pending enable row level security;

-- Reserve a member's single daily entry on a boss. Rejects an already-cleared boss and a
-- member who has already entered today. Atomic via the (user_id, day) primary key.
create or replace function public.guild_boss_enter(p_user uuid, p_guild uuid, p_day date, p_boss int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int;
begin
  if exists (select 1 from public.guild_boss_clears where guild_id = p_guild and day = p_day and boss_idx = p_boss) then
    return jsonb_build_object('status','cleared');
  end if;
  insert into public.guild_boss_entries(user_id, day, guild_id, boss_idx)
    values (p_user, p_day, p_guild, p_boss)
    on conflict (user_id, day) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return jsonb_build_object('status','used'); end if;
  return jsonb_build_object('status','ok');
end $$;

-- Record a clear (first writer wins via the primary key) and, on success, credit every current
-- guild member p_reward pending shards. Requires the caller to have entered THIS boss today.
create or replace function public.guild_boss_clear(p_user uuid, p_username text, p_guild uuid, p_day date, p_boss int, p_reward int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_entry int; v_ins int;
begin
  select boss_idx into v_entry from public.guild_boss_entries where user_id = p_user and day = p_day;
  if v_entry is null or v_entry <> p_boss then return jsonb_build_object('status','noentry'); end if;
  insert into public.guild_boss_clears(guild_id, day, boss_idx, cleared_by_user, cleared_by_username)
    values (p_guild, p_day, p_boss, p_user, p_username)
    on conflict (guild_id, day, boss_idx) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return jsonb_build_object('status','alreadycleared'); end if;
  if p_reward > 0 then
    insert into public.guild_boss_pending(user_id, shards)
      select gm.user_id, p_reward from public.guild_members gm where gm.guild_id = p_guild
      on conflict (user_id) do update set shards = public.guild_boss_pending.shards + p_reward;
  end if;
  return jsonb_build_object('status','ok','reward',p_reward);
end $$;

-- Drain and return a member's pending shard balance (0 if none). The client grants that many
-- Barrier Shards into its own inventory once this returns.
create or replace function public.guild_boss_claim_pending(p_user uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  select shards into v from public.guild_boss_pending where user_id = p_user for update;
  if v is null or v <= 0 then return 0; end if;
  update public.guild_boss_pending set shards = 0 where user_id = p_user;
  return v;
end $$;
