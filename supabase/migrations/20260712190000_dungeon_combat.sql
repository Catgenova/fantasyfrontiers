-- ============================================================================
-- DUNGEONS — Phase 2, Stage B: enemy-attacks-back (threat targeting), death/wipe, claim.
--
-- Extends the Stage A shared-enemy sessions with a server-authoritative danger layer:
--   * The enemy attacks on its own cadence (enemy_attack_at), each batch of swings landing
--     on a THREAT-WEIGHTED random alive member (heavier armour -> more threat -> more hits).
--   * Player HP is server-owned (max_hp/hp), fed a clamped client mitigation proxy (mit%) and
--     a light self-regen; when a member's hp hits 0 they're downed (alive=false). When every
--     member is down the run WIPES.
--   * On a clear only SURVIVORS may claim the Formula (dungeon_claim, one per member).
-- HP / mitigation are trusted-but-bounded proxies (the server can't run the JS combat engine),
-- exactly like the power damage proxy -- consistent with the Guild Boss / economy trust model.
-- ============================================================================

alter table public.dungeon_sessions add column if not exists enemy_attack_at bigint not null default 0; -- epoch ms of last resolved enemy swing
alter table public.dungeon_members  add column if not exists max_hp bigint not null default 0;
alter table public.dungeon_members  add column if not exists hp     bigint not null default 0;
alter table public.dungeon_members  add column if not exists mit    int    not null default 0;  -- mitigation %, 0..85
alter table public.dungeon_members  add column if not exists threat int    not null default 10;

-- Signatures change (extra combat params) -> drop the Stage A versions before recreating.
drop function if exists public.dungeon_create(uuid, text, text, bigint, int, int);
drop function if exists public.dungeon_join(uuid, uuid, text, bigint);
drop function if exists public.dungeon_assault(uuid, uuid, bigint, int, bigint[]);

-- Create a lobby with the host as its first member (now carrying combat stats).
create or replace function public.dungeon_create(p_user uuid, p_username text, p_layer text, p_power bigint, p_threat int, p_max_hp bigint, p_mit int, p_count int, p_hours int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if public.dungeon_engaged(p_user) then return jsonb_build_object('status','engaged'); end if;
  insert into public.dungeon_sessions(layer, host_id, status, enemy_count, expires_at)
    values (p_layer, p_user, 'lobby', p_count, now() + make_interval(hours => greatest(1, p_hours)))
    returning id into v_id;
  insert into public.dungeon_members(session_id, user_id, username, power, threat, max_hp, hp, mit)
    values (v_id, p_user, p_username, greatest(0,p_power), greatest(1,p_threat), greatest(1,p_max_hp), greatest(1,p_max_hp), least(85,greatest(0,p_mit)));
  return jsonb_build_object('status','ok','session_id', v_id);
end $$;

create or replace function public.dungeon_join(p_session uuid, p_user uuid, p_username text, p_power bigint, p_threat int, p_max_hp bigint, p_mit int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_n int;
begin
  select status into v_status from public.dungeon_sessions where id = p_session for update;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'lobby' then return jsonb_build_object('status','started'); end if;
  if public.dungeon_engaged(p_user) then return jsonb_build_object('status','engaged'); end if;
  select count(*) into v_n from public.dungeon_members where session_id = p_session;
  if v_n >= 4 then return jsonb_build_object('status','full'); end if;
  insert into public.dungeon_members(session_id, user_id, username, power, threat, max_hp, hp, mit)
    values (p_session, p_user, p_username, greatest(0,p_power), greatest(1,p_threat), greatest(1,p_max_hp), greatest(1,p_max_hp), least(85,greatest(0,p_mit)))
    on conflict (session_id, user_id) do update set username=excluded.username, power=excluded.power, threat=excluded.threat, max_hp=excluded.max_hp, hp=excluded.hp, mit=excluded.mit;
  update public.dungeon_sessions set version = version + 1, updated_at = now() where id = p_session;
  return jsonb_build_object('status','ok');
end $$;

-- Host starts: lobby -> active, seed the first foe + everyone to full, arm the enemy clock.
create or replace function public.dungeon_start(p_session uuid, p_user uuid, p_enemy0_hp bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_status text;
begin
  select host_id, status into v_host, v_status from public.dungeon_sessions where id = p_session for update;
  if v_host is null then return jsonb_build_object('status','gone'); end if;
  if v_host <> p_user then return jsonb_build_object('status','nothost'); end if;
  if v_status <> 'lobby' then return jsonb_build_object('status', v_status); end if;
  update public.dungeon_members set alive = true, hp = greatest(1,max_hp), damage = 0, claimed = false, last_tick = now() where session_id = p_session;
  update public.dungeon_sessions
    set status='active', enemy_index=0, enemy_hp=greatest(1,p_enemy0_hp), target_id=null,
        enemy_attack_at=floor(extract(epoch from now())*1000), version=version+1, updated_at=now()
    where id = p_session;
  return jsonb_build_object('status','ok');
end $$;

-- The tick: accrue the caller's power*elapsed into the shared enemy + self-regen, resolve the
-- enemy's swings since enemy_attack_at against a threat-weighted alive target, then advance /
-- clear / wipe. p_hp/p_atk/p_spd_ms are the per-index server roster (1-based in SQL).
create or replace function public.dungeon_assault(p_session uuid, p_user uuid, p_power bigint, p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_hp bigint; v_idx int; v_count int; v_exp timestamptz; v_eaa bigint;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_myhp bigint; v_mymax bigint;
        v_now_ms bigint; v_interval int; v_swings int; v_atk int; v_tgt uuid; v_alive int;
        v_tot bigint; v_r numeric; v_dmg bigint;
        v_advanced boolean := false; v_cleared boolean := false; v_wiped boolean := false;
begin
  select status, enemy_hp, enemy_index, enemy_count, expires_at, coalesce(enemy_attack_at,0)
    into v_status, v_hp, v_idx, v_count, v_exp, v_eaa
    from public.dungeon_sessions where id = p_session for update;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  if now() >= v_exp then update public.dungeon_sessions set status='expired', version=version+1, updated_at=now() where id=p_session; return jsonb_build_object('status','expired'); end if;
  if p_power < 0 then p_power := 0; end if;
  v_now_ms := floor(extract(epoch from now()) * 1000);

  select last_tick, hp, max_hp into v_last, v_myhp, v_mymax
    from public.dungeon_members where session_id=p_session and user_id=p_user and alive;
  if not found then return jsonb_build_object('status','notmember'); end if;
  v_elapsed := extract(epoch from (now() - v_last));
  if v_elapsed < 0 then v_elapsed := 0; end if;
  if v_elapsed > p_max_seconds then v_elapsed := p_max_seconds; end if;

  -- 1) caller's damage to the shared enemy + self-regen (3%/s of max HP)
  v_add := floor(p_power * v_elapsed); if v_add < 0 then v_add := 0; end if;
  v_myhp := least(v_mymax, v_myhp + floor(v_mymax * 0.03 * v_elapsed));
  update public.dungeon_members set damage=damage+v_add, power=p_power, hp=v_myhp, last_tick=now() where session_id=p_session and user_id=p_user;
  v_hp := v_hp - v_add;

  -- 2) enemy swings (global cadence) onto a threat-weighted alive target
  if v_eaa = 0 then v_eaa := v_now_ms; end if;
  v_interval := greatest(500, coalesce(p_spd_ms[v_idx + 1], 2500));
  v_swings := floor((v_now_ms - v_eaa) / v_interval);
  if v_swings < 0 then v_swings := 0; end if;
  if v_swings > 20 then v_swings := 20; v_eaa := v_now_ms - 20 * v_interval; end if; -- anti-burst after a long gap
  if v_swings > 0 then
    v_atk := greatest(1, coalesce(p_atk[v_idx + 1], 300));
    select sum(greatest(1, threat)) into v_tot from public.dungeon_members where session_id=p_session and alive;
    if v_tot > 0 then
      v_r := random() * v_tot;
      select user_id into v_tgt from (
        select user_id, sum(greatest(1, threat)) over (order by user_id) as cum
        from public.dungeon_members where session_id=p_session and alive
      ) t where t.cum >= v_r order by t.cum limit 1;
    end if;
    if v_tgt is not null then
      update public.dungeon_members m
        set hp = greatest(0, m.hp - floor(v_swings * v_atk * (1 - least(85, greatest(0, m.mit)) / 100.0))),
            alive = (m.hp - floor(v_swings * v_atk * (1 - least(85, greatest(0, m.mit)) / 100.0))) > 0
        where m.session_id=p_session and m.user_id=v_tgt;
      v_eaa := v_eaa + v_swings * v_interval;
      select hp into v_myhp from public.dungeon_members where session_id=p_session and user_id=p_user; -- refresh if I was the target
    end if;
  end if;

  -- 3) advance / clear / wipe
  if v_hp <= 0 then
    if v_idx >= v_count - 1 then
      v_cleared := true;
      update public.dungeon_sessions set enemy_hp=0, status='cleared', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      v_advanced := true; v_idx := v_idx + 1; v_hp := coalesce(p_hp[v_idx + 1], 1);
      update public.dungeon_sessions set enemy_index=v_idx, enemy_hp=v_hp, target_id=v_tgt, enemy_attack_at=v_now_ms, version=version+1, updated_at=now() where id=p_session;
    end if;
  else
    select count(*) into v_alive from public.dungeon_members where session_id=p_session and alive;
    if v_alive = 0 then
      v_wiped := true;
      update public.dungeon_sessions set enemy_hp=greatest(v_hp,0), status='wiped', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      update public.dungeon_sessions set enemy_hp=greatest(v_hp,0), target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    end if;
  end if;

  return jsonb_build_object('status', case when v_cleared then 'cleared' when v_wiped then 'wiped' else 'active' end,
    'enemy_index', v_idx, 'enemy_hp', greatest(v_hp,0), 'target_id', v_tgt, 'my_hp', greatest(coalesce(v_myhp,0),0),
    'advanced', v_advanced, 'cleared', v_cleared, 'wiped', v_wiped);
end $$;

-- Only a SURVIVING member may claim a cleared run's Formula, and only once.
create or replace function public.dungeon_claim(p_session uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_alive boolean; v_claimed boolean; v_layer text;
begin
  select status, layer into v_status, v_layer from public.dungeon_sessions where id = p_session;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'cleared' then return jsonb_build_object('status','notcleared'); end if;
  select alive, claimed into v_alive, v_claimed from public.dungeon_members where session_id=p_session and user_id=p_user for update;
  if v_alive is null then return jsonb_build_object('status','notmember'); end if;
  if not v_alive then return jsonb_build_object('status','dead'); end if;
  if v_claimed then return jsonb_build_object('status','claimed'); end if;
  update public.dungeon_members set claimed = true where session_id=p_session and user_id=p_user;
  return jsonb_build_object('status','ok','layer',v_layer);
end $$;
