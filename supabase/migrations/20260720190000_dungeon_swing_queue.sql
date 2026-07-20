-- ============================================================================
-- DUNGEONS Phase 3, Stage D: the server owns swing TIMING as well as targeting, and party shields
-- actually reach the player they were granted to.
--
-- Stage B left two clocks running side by side: the server computed how many swings the foe had taken
-- (v_swings) while each client separately swung on its own local attackSpeed timer. They agreed only by
-- construction, and the server's count was effectively vestigial. Stage D makes the server's count the
-- authority and gives the client one job: resolve the swings it is TOLD about, through the real
-- mitigation chain, and report what it survived with.
--
-- Two server -> client queues, drained the same way (client consumes, then reports what it took):
--   pending_swings  enemy hits owed to this member (server decides how many and when)
--   shield          barrier owed to this member (granted by an ally's overheal)
--
-- The client rolls the actual DAMAGE itself from its own roster copy -- atkMin..atkMax, damage types,
-- element -- so range, type advantage and every mitigation source stay real. The server only says
-- "you were hit N times by enemy #i"; it never computes a number.
-- ============================================================================

alter table public.dungeon_members add column if not exists pending_swings int not null default 0;

comment on column public.dungeon_members.pending_swings is
  'Enemy swings the server has assigned to this member and the client has not yet resolved. The target''s '
  'client applies them through its own mitigation chain, then reports how many it drained. Capped so an '
  'absent player does not return to an unsurvivable backlog.';

create or replace function public.dungeon_assault(
  p_session uuid, p_user uuid, p_damage bigint, p_hp_report bigint, p_power_ceiling bigint,
  p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[],
  p_swings_resolved int default 0, p_shield_taken bigint default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_ehp bigint; v_idx int; v_count int; v_exp timestamptz; v_eaa bigint;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_myhp bigint; v_mymax bigint;
        v_now_ms bigint; v_interval int; v_swings int; v_atk int; v_tgt uuid; v_alive int;
        v_tot bigint; v_r numeric; v_cap bigint; v_mypend int; v_myshield bigint;
        v_advanced boolean := false; v_cleared boolean := false; v_wiped boolean := false;
begin
  select status, enemy_hp, enemy_index, enemy_count, expires_at, coalesce(enemy_attack_at,0)
    into v_status, v_ehp, v_idx, v_count, v_exp, v_eaa
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

  -- 1) The caller's real damage, clamped to what an honest client could have produced in that window.
  v_cap := greatest(0, floor(greatest(0, p_power_ceiling) * v_elapsed))::bigint;
  v_add := least(greatest(0, coalesce(p_damage, 0)), v_cap);

  -- 2) The caller's own HP after resolving whatever it was told to resolve, and the queues it drained.
  if p_hp_report is not null then
    v_myhp := least(greatest(0, p_hp_report), greatest(1, v_mymax));
  end if;

  update public.dungeon_members
     set damage = damage + v_add,
         hp     = v_myhp,
         alive  = (v_myhp > 0),
         -- Drain only what the client says it actually applied, so a dropped response replays rather
         -- than silently eating the hit.
         pending_swings = greatest(0, pending_swings - greatest(0, coalesce(p_swings_resolved,0))),
         shield         = greatest(0, shield - greatest(0, coalesce(p_shield_taken,0))),
         last_tick = now()
   where session_id=p_session and user_id=p_user;
  v_ehp := v_ehp - v_add;

  -- 3) Enemy cadence + targeting, both server-owned. The swing COUNT is now assigned to the target's
  --    queue instead of being returned as trivia -- that member's client resolves exactly this many hits
  --    through its own armour/block/dodge/reflect/ward chain and reports the result back.
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
      -- Capped at 20 outstanding: a player whose tab slept comes back to a survivable debt, not a deletion.
      update public.dungeon_members
         set pending_swings = least(20, pending_swings + v_swings)
       where session_id=p_session and user_id=v_tgt;
      v_eaa := v_eaa + v_swings * v_interval;
    end if;
  end if;

  -- 4) advance / clear / wipe
  if v_ehp <= 0 then
    if v_idx >= v_count - 1 then
      v_cleared := true;
      update public.dungeon_sessions set enemy_hp=0, status='cleared', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      v_advanced := true; v_idx := v_idx + 1; v_ehp := coalesce(p_hp[v_idx + 1], 1);
      -- A fresh foe starts clean: nobody owes swings from the corpse of the last one.
      update public.dungeon_members set pending_swings = 0 where session_id = p_session;
      update public.dungeon_sessions set enemy_index=v_idx, enemy_hp=v_ehp, target_id=v_tgt, enemy_attack_at=v_now_ms, version=version+1, updated_at=now() where id=p_session;
    end if;
  else
    select count(*) into v_alive from public.dungeon_members where session_id=p_session and alive;
    if v_alive = 0 then
      v_wiped := true;
      update public.dungeon_sessions set enemy_hp=greatest(v_ehp,0), status='wiped', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      update public.dungeon_sessions set enemy_hp=greatest(v_ehp,0), target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    end if;
  end if;

  -- What the CALLER now owes / is owed. Read after the updates so it reflects this tick, including a
  -- swing the caller may have just been assigned by its own ping.
  select pending_swings, shield into v_mypend, v_myshield
    from public.dungeon_members where session_id=p_session and user_id=p_user;

  return jsonb_build_object(
    'status', case when v_cleared then 'cleared' when v_wiped then 'wiped' else 'active' end,
    'enemy_index', v_idx, 'enemy_hp', greatest(v_ehp,0), 'target_id', v_tgt,
    'my_hp', greatest(coalesce(v_myhp,0),0), 'credited', v_add,
    'my_pending_swings', coalesce(v_mypend,0), 'my_shield', coalesce(v_myshield,0),
    'advanced', v_advanced, 'cleared', v_cleared, 'wiped', v_wiped);
end $$;

-- Stage A signature kept as a shim so a client mid-rollout keeps working (no queues drained).
create or replace function public.dungeon_assault(
  p_session uuid, p_user uuid, p_damage bigint, p_hp_report bigint, p_power_ceiling bigint,
  p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[]
)
returns jsonb language sql security definer set search_path = public as $$
  select public.dungeon_assault(p_session, p_user, p_damage, p_hp_report, p_power_ceiling,
                                p_max_seconds, p_hp, p_atk, p_spd_ms, 0, 0::bigint);
$$;

do $$
declare fn text; fns text[] := array[
  'public.dungeon_assault(uuid, uuid, bigint, bigint, bigint, int, bigint[], int[], int[], int, bigint)',
  'public.dungeon_assault(uuid, uuid, bigint, bigint, bigint, int, bigint[], int[], int[])'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end $$;
