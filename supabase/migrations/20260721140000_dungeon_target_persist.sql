-- Group dungeons: keep the enemy's target visible between its swings.
--
-- dungeon_assault picks a threat-weighted target only on ticks where the enemy actually SWINGS
-- (v_swings > 0), but every branch writes target_id = v_tgt. v_tgt started null each call, so on the
-- (majority) ticks with no swing -- the client reports every 0.5s while the enemy swings every ~2-3.6s --
-- target_id was overwritten with NULL. The client's "the X is attacking <name>" banner and the targeted
-- row highlight therefore blinked off between swings: "threat / enemy target isn't clear and randomly
-- stops working."
--
-- Fix: seed v_tgt from the session's CURRENT target_id, so a no-swing tick preserves the standing target
-- and only a real swing re-rolls it. Everything else is identical to 20260721120000 (trusted damage +
-- overkill carry). If the standing target has since died, the client shows "choosing a target..." until
-- the next swing re-picks among the living.
create or replace function public.dungeon_assault(
  p_session uuid, p_user uuid, p_damage bigint, p_hp_report bigint, p_power_ceiling bigint,
  p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[],
  p_swings_resolved int default 0, p_shield_taken bigint default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_ehp bigint; v_idx int; v_count int; v_exp timestamptz; v_eaa bigint;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_myhp bigint; v_mymax bigint;
        v_now_ms bigint; v_interval int; v_swings int; v_atk int; v_tgt uuid; v_alive int;
        v_tot bigint; v_r numeric; v_mypend int; v_myshield bigint; v_guard int;
        v_advanced boolean := false; v_cleared boolean := false; v_wiped boolean := false;
begin
  -- Seed v_tgt from target_id so a tick with no swing keeps the standing target instead of nulling it.
  select status, enemy_hp, enemy_index, enemy_count, expires_at, coalesce(enemy_attack_at,0), target_id
    into v_status, v_ehp, v_idx, v_count, v_exp, v_eaa, v_tgt
    from public.dungeon_sessions where id = p_session for update;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  if now() >= v_exp then
    update public.dungeon_sessions set status='expired', version=version+1, updated_at=now() where id=p_session;
    return jsonb_build_object('status','expired');
  end if;
  v_now_ms := floor(extract(epoch from now()) * 1000);

  select last_tick, hp, max_hp into v_last, v_myhp, v_mymax
    from public.dungeon_members where session_id=p_session and user_id=p_user and alive;
  if not found then return jsonb_build_object('status','notmember'); end if;
  v_elapsed := extract(epoch from (now() - v_last));
  if v_elapsed < 0 then v_elapsed := 0; end if;
  if v_elapsed > p_max_seconds then v_elapsed := p_max_seconds; end if;

  -- 1) Credit the caller's REAL measured damage (trusted; no power*elapsed clamp).
  v_add := greatest(0, coalesce(p_damage, 0));

  -- 2) The caller's own HP after resolving what it was told to, and the queues it drained.
  if p_hp_report is not null then
    v_myhp := least(greatest(0, p_hp_report), greatest(1, v_mymax));
  end if;
  update public.dungeon_members
     set damage = damage + v_add,
         hp     = v_myhp,
         alive  = (v_myhp > 0),
         pending_swings = greatest(0, pending_swings - greatest(0, coalesce(p_swings_resolved,0))),
         shield         = greatest(0, shield - greatest(0, coalesce(p_shield_taken,0))),
         last_tick = now()
   where session_id=p_session and user_id=p_user;
  v_ehp := v_ehp - v_add;

  -- 3) Enemy cadence + targeting, server-owned. Only a real swing re-rolls v_tgt; otherwise it keeps the
  --    standing target seeded above.
  if v_eaa = 0 then v_eaa := v_now_ms; end if;
  v_interval := greatest(500, coalesce(p_spd_ms[v_idx + 1], 2500));
  v_swings := floor((v_now_ms - v_eaa) / v_interval);
  if v_swings < 0 then v_swings := 0; end if;
  if v_swings > 20 then v_swings := 20; v_eaa := v_now_ms - 20 * v_interval; end if; -- anti-burst after a gap
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
      update public.dungeon_members
         set pending_swings = least(20, pending_swings + v_swings)
       where session_id=p_session and user_id=v_tgt;
      v_eaa := v_eaa + v_swings * v_interval;
    end if;
  end if;

  -- 4) Advance / clear / wipe. Overkill carries to the next foe (bounded by the roster length).
  v_guard := 0;
  while v_ehp <= 0 and v_idx < v_count - 1 and v_guard < v_count loop
    v_idx  := v_idx + 1;
    v_ehp  := v_ehp + coalesce(p_hp[v_idx + 1], 1);
    v_advanced := true;
    v_guard := v_guard + 1;
  end loop;
  if v_ehp <= 0 and v_idx >= v_count - 1 then v_cleared := true; end if;

  if v_cleared then
    update public.dungeon_sessions set enemy_hp=0, status='cleared', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
  elsif v_advanced then
    update public.dungeon_members set pending_swings = 0 where session_id = p_session;
    update public.dungeon_sessions set enemy_index=v_idx, enemy_hp=v_ehp, target_id=v_tgt, enemy_attack_at=v_now_ms, version=version+1, updated_at=now() where id=p_session;
  else
    select count(*) into v_alive from public.dungeon_members where session_id=p_session and alive;
    if v_alive = 0 then
      v_wiped := true;
      update public.dungeon_sessions set enemy_hp=greatest(v_ehp,0), status='wiped', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      update public.dungeon_sessions set enemy_hp=greatest(v_ehp,0), target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    end if;
  end if;

  select pending_swings, shield into v_mypend, v_myshield
    from public.dungeon_members where session_id=p_session and user_id=p_user;

  return jsonb_build_object(
    'status', case when v_cleared then 'cleared' when v_wiped then 'wiped' else 'active' end,
    'enemy_index', v_idx, 'enemy_hp', greatest(v_ehp,0), 'target_id', v_tgt,
    'my_hp', greatest(coalesce(v_myhp,0),0), 'credited', v_add,
    'my_pending_swings', coalesce(v_mypend,0), 'my_shield', coalesce(v_myshield,0),
    'advanced', v_advanced, 'cleared', v_cleared, 'wiped', v_wiped);
end $$;

revoke execute on function public.dungeon_assault(uuid, uuid, bigint, bigint, bigint, int, bigint[], int[], int[], int, bigint) from public, anon, authenticated;
