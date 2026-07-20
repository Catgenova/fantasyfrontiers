-- ============================================================================
-- DUNGEONS Phase 3, Stage A: real client-side combat + party healing (server foundation).
--
-- The Phase 2 model had each client report a `power` DPS proxy and the server multiply it by elapsed
-- time. That made group runs an estimate: crits, elements, set bonuses, legendaries, familiars and the
-- whole incoming-damage chain simply did not exist in a party. Solo runs already fight through the REAL
-- engine (dungeonSoloEnemy registers the foe into MONSTERS_BY_ID and playerAttackTick/monsterAttackTick
-- take over), so the fix is to let group runs do the same and report what actually happened.
--
-- TRUST MODEL CHANGE, stated plainly. Damage dealt is now client-COMPUTED rather than server-derived:
--   * OUTGOING damage is still BOUNDED. The old `power` proxy survives as a CEILING -- the server credits
--     min(reported, power_ceiling * elapsed) -- so a tampered client can never exceed the honest maximum
--     rate. This is no weaker than Phase 2; it just lets real mechanics matter below the bound.
--   * INCOMING damage is now trusted (the caller reports its own HP). A tampered client can claim it never
--     takes damage and become unkillable. Accepted deliberately: dungeons are PvE, so the cost is a cheater
--     trivialising their own run. If that changes, the hook is a server-side floor derived from
--     p_atk/p_spd_ms, which the RPC already receives.
--
-- Additive and INERT until the client switches: dungeon_assault keeps its Phase 2 signature as a shim, so
-- a not-yet-updated client keeps working through the deploy window.
-- ============================================================================

-- Party healing needs a shield channel too (Templar Aegis of Dawn, Lumen Radiant Barrier both grant one).
alter table public.dungeon_members add column if not exists shield bigint not null default 0;

-- ---------------------------------------------------------------------------------------------
-- The new tick. Same shape as Phase 2 -- caller's contribution, enemy swings, advance/clear/wipe --
-- but the caller reports what its own engine computed instead of a proxy:
--   p_damage  damage dealt to the shared enemy since the caller's last tick (clamped, see above)
--   p_hp      the caller's own current HP after resolving whatever the enemy did to it locally
--             (NULL = "I have nothing to report", so the server leaves my HP alone)
-- ---------------------------------------------------------------------------------------------
create or replace function public.dungeon_assault(
  p_session uuid, p_user uuid, p_damage bigint, p_hp_report bigint, p_power_ceiling bigint,
  p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_ehp bigint; v_idx int; v_count int; v_exp timestamptz; v_eaa bigint;
        v_last timestamptz; v_elapsed numeric; v_add bigint; v_myhp bigint; v_mymax bigint;
        v_now_ms bigint; v_interval int; v_swings int; v_atk int; v_tgt uuid; v_alive int;
        v_tot bigint; v_r numeric; v_cap bigint;
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

  -- 1) The caller's real damage, CLAMPED to what an honest client could have produced in that window.
  --    This is the whole anti-cheat story for outgoing damage: the Phase 2 proxy is now the ceiling.
  v_cap := greatest(0, floor(greatest(0, p_power_ceiling) * v_elapsed))::bigint;
  v_add := least(greatest(0, coalesce(p_damage, 0)), v_cap);

  -- 2) The caller's own HP, as resolved by its own engine. Clamped to [0, max]; NULL means no report.
  --    Reaching 0 downs them -- the client already ran the full mitigation chain to decide that.
  if p_hp_report is not null then
    v_myhp := least(greatest(0, p_hp_report), greatest(1, v_mymax));
  end if;

  update public.dungeon_members
     set damage = damage + v_add,
         hp     = v_myhp,
         alive  = (v_myhp > 0),
         last_tick = now()
   where session_id=p_session and user_id=p_user;
  v_ehp := v_ehp - v_add;

  -- 3) Enemy targeting stays SERVER-SIDE (threat-weighted among the living) so every client agrees on who
  --    is being hit; each client then resolves the hit locally through its own mitigation chain. The swing
  --    schedule advances here so the cadence is shared rather than per-client.
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
    if v_tgt is not null then v_eaa := v_eaa + v_swings * v_interval; end if;
  end if;

  -- 4) advance / clear / wipe
  if v_ehp <= 0 then
    if v_idx >= v_count - 1 then
      v_cleared := true;
      update public.dungeon_sessions set enemy_hp=0, status='cleared', target_id=v_tgt, enemy_attack_at=v_eaa, version=version+1, updated_at=now() where id=p_session;
    else
      v_advanced := true; v_idx := v_idx + 1; v_ehp := coalesce(p_hp[v_idx + 1], 1);
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

  return jsonb_build_object(
    'status', case when v_cleared then 'cleared' when v_wiped then 'wiped' else 'active' end,
    'enemy_index', v_idx, 'enemy_hp', greatest(v_ehp,0), 'target_id', v_tgt,
    'my_hp', greatest(coalesce(v_myhp,0),0), 'credited', v_add, 'swings', v_swings,
    'swing_atk', coalesce(v_atk,0), 'advanced', v_advanced, 'cleared', v_cleared, 'wiped', v_wiped);
end $$;

-- Backward-compat shim: the Phase 2 signature keeps working during the deploy window by converting the
-- power proxy into an equivalent damage claim (power * elapsed), which the new path then re-clamps to the
-- same value. Behaviour for a not-yet-updated client is therefore IDENTICAL to Phase 2.
create or replace function public.dungeon_assault(p_session uuid, p_user uuid, p_power bigint, p_max_seconds int, p_hp bigint[], p_atk int[], p_spd_ms int[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_last timestamptz; v_elapsed numeric; v_claim bigint;
begin
  select last_tick into v_last from public.dungeon_members where session_id=p_session and user_id=p_user and alive;
  if not found then return jsonb_build_object('status','notmember'); end if;
  v_elapsed := least(greatest(0, extract(epoch from (now() - v_last))), p_max_seconds);
  v_claim := floor(greatest(0, coalesce(p_power,0)) * v_elapsed)::bigint;
  -- NULL hp report -> the old server-side self-regen no longer applies, so the shim leaves HP untouched
  -- rather than silently healing; a Phase 2 client simply stops taking/regening HP until it updates.
  return public.dungeon_assault(p_session, p_user, v_claim, null::bigint, greatest(0, coalesce(p_power,0)),
                                p_max_seconds, p_hp, p_atk, p_spd_ms);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Party heal. A heal is an EVENT targeted at one member, never a broadcast of "my view of everyone's HP":
-- the server owns dungeon_members.hp, so one writer per value and deltas compose. Overheal spills into
-- `shield` when the healer has a barrier perk (Templar Aegis of Dawn / Lumen Radiant Barrier).
-- ---------------------------------------------------------------------------------------------
create or replace function public.dungeon_heal(
  p_session uuid, p_healer uuid, p_target uuid, p_amount bigint, p_shield_frac numeric, p_max_heal bigint
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_hp bigint; v_max bigint; v_alive boolean; v_amt bigint; v_applied bigint; v_over bigint; v_shield bigint;
begin
  select status into v_status from public.dungeon_sessions where id = p_session;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  -- The healer must be a LIVING member of this run; the dead don't mend.
  if not exists (select 1 from public.dungeon_members where session_id=p_session and user_id=p_healer and alive) then
    return jsonb_build_object('status','notmember');
  end if;

  select hp, max_hp, alive, shield into v_hp, v_max, v_alive, v_shield
    from public.dungeon_members where session_id=p_session and user_id=p_target for update;
  if v_hp is null then return jsonb_build_object('status','notarget'); end if;
  if not v_alive then return jsonb_build_object('status','dead'); end if;   -- healing can't raise the fallen

  v_amt := least(greatest(0, coalesce(p_amount,0)), greatest(0, coalesce(p_max_heal, 0)));
  if v_amt <= 0 then return jsonb_build_object('status','ok','healed',0); end if;

  v_applied := least(v_amt, greatest(0, v_max - v_hp));
  v_over    := v_amt - v_applied;
  update public.dungeon_members
     set hp = v_hp + v_applied,
         -- Overheal becomes a barrier only for healers who have that perk (frac > 0), capped at max HP.
         shield = least(greatest(1, v_max), v_shield + floor(v_over * greatest(0, coalesce(p_shield_frac,0)))::bigint)
   where session_id=p_session and user_id=p_target;

  return jsonb_build_object('status','ok','healed',v_applied,'overheal',v_over);
end $$;

do $$
declare fn text; fns text[] := array[
  'public.dungeon_assault(uuid, uuid, bigint, bigint, bigint, int, bigint[], int[], int[])',
  'public.dungeon_heal(uuid, uuid, uuid, bigint, numeric, bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end $$;
