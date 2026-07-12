-- ============================================================================
-- DUNGEONS — Phase 2: synchronous multiplayer dungeon runs (server-authoritative).
--
-- 1-4 players form a party in a LOBBY, then descend together. The server owns the SHARED
-- state: which enemy the party is on (enemy_index), the enemy's shared HP pool, the roster
-- of members and who is alive, and the run's status. Like the async Guild Bosses, each
-- member's damage is accrued server-side as power*elapsed (power is a clamped client DPS
-- proxy; elapsed is capped per ping) so nobody can dump impossible damage -- the server can't
-- run the JS combat engine, so damage is a trusted-but-bounded proxy, consistent with the
-- rest of the economy. When the shared enemy's HP hits 0 the server advances to the next
-- foe; clearing the 25th (the boss) flips the run to 'cleared'.
--
-- Stage A ships the session + lobby lifecycle + the shared-HP assault RPC (the co-op DPS
-- core). Stage B will add enemy-attacks-back with threat targeting, player death/wipe, and
-- the Formula claim (those extend dungeon_members.alive + a claim flag already present here).
--
-- Function-only writes (security-definer RPCs); a permissive SELECT policy lets clients read
-- + realtime-subscribe to sessions/members. Verify JWT OFF on the edge function.
-- ============================================================================

create table if not exists public.dungeon_sessions (
  id           uuid primary key default gen_random_uuid(),
  layer        text not null,
  host_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'lobby' check (status in ('lobby','active','cleared','wiped','expired')),
  enemy_index  int not null default 0,
  enemy_count  int not null,
  enemy_hp     bigint not null default 0,
  target_id    uuid,                 -- who the enemy is currently attacking (Stage B)
  version      bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists dungeon_sessions_open_idx on public.dungeon_sessions (layer, status) where status = 'lobby';

create table if not exists public.dungeon_members (
  session_id  uuid not null references public.dungeon_sessions(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  username    text not null,
  power       bigint not null default 0,
  damage      bigint not null default 0,
  alive       boolean not null default true,
  claimed     boolean not null default false,
  last_tick   timestamptz not null default now(),
  joined_at   timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists dungeon_members_user_idx on public.dungeon_members (user_id);

alter table public.dungeon_sessions enable row level security;
alter table public.dungeon_members  enable row level security;

-- Readable by any authenticated client (ephemeral game state; needed for lobby lists + realtime).
-- All writes go through the security-definer RPCs below -- no client write policies exist.
drop policy if exists dungeon_sessions_read on public.dungeon_sessions;
create policy dungeon_sessions_read on public.dungeon_sessions for select to authenticated using (true);
drop policy if exists dungeon_members_read on public.dungeon_members;
create policy dungeon_members_read on public.dungeon_members for select to authenticated using (true);

-- Live updates: sessions (enemy HP / index / status) and members (roster / alive) both stream.
do $$ begin alter publication supabase_realtime add table public.dungeon_sessions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.dungeon_members;  exception when duplicate_object then null; end $$;

-- A user is "engaged" if they already hold a lobby/active session membership (only one at a time).
create or replace function public.dungeon_engaged(p_user uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.dungeon_members m
      join public.dungeon_sessions s on s.id = m.session_id
    where m.user_id = p_user and s.status in ('lobby','active'));
$$;

-- Create a fresh lobby with the host as its first member. Refuses if already engaged elsewhere.
create or replace function public.dungeon_create(p_user uuid, p_username text, p_layer text, p_power bigint, p_count int, p_hours int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if public.dungeon_engaged(p_user) then return jsonb_build_object('status','engaged'); end if;
  insert into public.dungeon_sessions(layer, host_id, status, enemy_count, expires_at)
    values (p_layer, p_user, 'lobby', p_count, now() + make_interval(hours => greatest(1, p_hours)))
    returning id into v_id;
  insert into public.dungeon_members(session_id, user_id, username, power)
    values (v_id, p_user, p_username, greatest(0, p_power));
  return jsonb_build_object('status','ok','session_id', v_id);
end $$;

-- Join an open lobby (capacity 4). Refuses if full, not a lobby, or already engaged elsewhere.
create or replace function public.dungeon_join(p_session uuid, p_user uuid, p_username text, p_power bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_n int;
begin
  select status into v_status from public.dungeon_sessions where id = p_session for update;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'lobby' then return jsonb_build_object('status','started'); end if;
  if public.dungeon_engaged(p_user) then return jsonb_build_object('status','engaged'); end if;
  select count(*) into v_n from public.dungeon_members where session_id = p_session;
  if v_n >= 4 then return jsonb_build_object('status','full'); end if;
  insert into public.dungeon_members(session_id, user_id, username, power)
    values (p_session, p_user, p_username, greatest(0, p_power))
    on conflict (session_id, user_id) do update set username = excluded.username, power = excluded.power;
  update public.dungeon_sessions set version = version + 1, updated_at = now() where id = p_session;
  return jsonb_build_object('status','ok');
end $$;

-- Leave a session. If the host leaves, or the last member leaves, the session is dropped.
create or replace function public.dungeon_leave(p_session uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_n int;
begin
  select host_id into v_host from public.dungeon_sessions where id = p_session for update;
  if v_host is null then return jsonb_build_object('status','gone'); end if;
  delete from public.dungeon_members where session_id = p_session and user_id = p_user;
  select count(*) into v_n from public.dungeon_members where session_id = p_session;
  if v_host = p_user or v_n = 0 then
    delete from public.dungeon_sessions where id = p_session; -- cascades members
    return jsonb_build_object('status','disbanded');
  end if;
  update public.dungeon_sessions set version = version + 1, updated_at = now() where id = p_session;
  return jsonb_build_object('status','ok');
end $$;

-- Host starts the descent: lobby -> active, seed the first enemy's shared HP, arm every member.
create or replace function public.dungeon_start(p_session uuid, p_user uuid, p_enemy0_hp bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_status text;
begin
  select host_id, status into v_host, v_status from public.dungeon_sessions where id = p_session for update;
  if v_host is null then return jsonb_build_object('status','gone'); end if;
  if v_host <> p_user then return jsonb_build_object('status','nothost'); end if;
  if v_status <> 'lobby' then return jsonb_build_object('status', v_status); end if;
  update public.dungeon_members set alive = true, damage = 0, last_tick = now() where session_id = p_session;
  update public.dungeon_sessions
    set status = 'active', enemy_index = 0, enemy_hp = greatest(1, p_enemy0_hp), version = version + 1, updated_at = now()
    where id = p_session;
  return jsonb_build_object('status','ok');
end $$;

-- The shared-HP assault (co-op core, mirrors guild_boss_assault). Accrues this member's
-- power*elapsed (elapsed capped) into the shared pool; on the kill, advances to the next foe
-- (enemy_hp reseeded from the caller-supplied HP roster) or flips to 'cleared' after the boss.
-- p_hp is the full per-index HP array (1-based in SQL) supplied by the server (edge function).
create or replace function public.dungeon_assault(p_session uuid, p_user uuid, p_power bigint, p_max_seconds int, p_hp bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_hp bigint; v_idx int; v_count int; v_exp timestamptz;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_advanced boolean := false; v_cleared boolean := false;
begin
  select status, enemy_hp, enemy_index, enemy_count, expires_at
    into v_status, v_hp, v_idx, v_count, v_exp
    from public.dungeon_sessions where id = p_session for update;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  if now() >= v_exp then
    update public.dungeon_sessions set status = 'expired', version = version + 1, updated_at = now() where id = p_session;
    return jsonb_build_object('status','expired');
  end if;
  if p_power < 0 then p_power := 0; end if;

  select last_tick into v_last from public.dungeon_members where session_id = p_session and user_id = p_user;
  if not found then return jsonb_build_object('status','notmember'); end if;
  v_elapsed := extract(epoch from (now() - v_last));
  if v_elapsed < 0 then v_elapsed := 0; end if;
  if v_elapsed > p_max_seconds then v_elapsed := p_max_seconds; end if;
  v_add := floor(p_power * v_elapsed);
  if v_add < 0 then v_add := 0; end if;

  update public.dungeon_members
    set damage = damage + v_add, power = p_power, last_tick = now()
    where session_id = p_session and user_id = p_user;
  v_hp := v_hp - v_add;

  if v_hp <= 0 then
    if v_idx >= v_count - 1 then
      v_cleared := true;
      update public.dungeon_sessions set enemy_hp = 0, status = 'cleared', version = version + 1, updated_at = now() where id = p_session;
    else
      v_advanced := true; v_idx := v_idx + 1;
      v_hp := coalesce(p_hp[v_idx + 1], 1); -- SQL arrays are 1-based
      update public.dungeon_sessions set enemy_index = v_idx, enemy_hp = v_hp, version = version + 1, updated_at = now() where id = p_session;
    end if;
  else
    update public.dungeon_sessions set enemy_hp = v_hp, version = version + 1, updated_at = now() where id = p_session;
  end if;

  return jsonb_build_object('status', case when v_cleared then 'cleared' else 'active' end,
    'enemy_index', v_idx, 'enemy_hp', greatest(v_hp, 0), 'added', v_add, 'advanced', v_advanced, 'cleared', v_cleared);
end $$;
