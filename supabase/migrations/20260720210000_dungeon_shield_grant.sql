-- ============================================================================
-- DUNGEONS Phase 3, Stage E: a barrier can be GRANTED outright, not only spilled from overheal.
--
-- Aegis of Dawn (Templar Lv80) reads "Every 10s, you (and your party in a dungeon) gain a Holy shield
-- absorbing up to 15% max HP". The party half has never worked: the only path that wrote
-- dungeon_members.shield was dungeon_heal, and that only banks OVERHEAL. A pure shield with no healing
-- attached had nowhere to go, so a Templar's capstone protected only the Templar.
--
-- dungeon_shield grants directly. It TOPS UP rather than accumulates -- greatest(shield, amount), the
-- same shape as the self-buff's `if (current < cap) set = cap` -- so a Templar ticking every 10s keeps
-- the party's barrier at its intended level instead of stacking an unbounded wall.
-- ============================================================================

create or replace function public.dungeon_shield(
  p_session uuid, p_granter uuid, p_target uuid, p_amount bigint, p_max_shield bigint
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_max bigint; v_alive boolean; v_shield bigint; v_amt bigint;
begin
  select status into v_status from public.dungeon_sessions where id = p_session;
  if v_status is null then return jsonb_build_object('status','gone'); end if;
  if v_status <> 'active' then return jsonb_build_object('status', v_status); end if;
  -- The granter must be a LIVING member of this run: a fallen Templar shields nobody.
  if not exists (select 1 from public.dungeon_members where session_id=p_session and user_id=p_granter and alive) then
    return jsonb_build_object('status','notmember');
  end if;

  select max_hp, alive, shield into v_max, v_alive, v_shield
    from public.dungeon_members where session_id=p_session and user_id=p_target for update;
  if v_max is null then return jsonb_build_object('status','notarget'); end if;
  if not v_alive then return jsonb_build_object('status','dead'); end if;   -- no warding the fallen

  -- Bounded by the caller-supplied ceiling AND by the target's own max HP, so a forged grant can't hand
  -- someone an arbitrarily large wall.
  v_amt := least(greatest(0, coalesce(p_amount,0)), greatest(0, coalesce(p_max_shield,0)), greatest(1, v_max));
  if v_amt <= 0 then return jsonb_build_object('status','ok','granted',0); end if;

  update public.dungeon_members
     set shield = greatest(shield, v_amt)     -- top up to the granted level; never stack past it
   where session_id=p_session and user_id=p_target;

  return jsonb_build_object('status','ok','granted',v_amt);
end $$;

revoke execute on function public.dungeon_shield(uuid, uuid, uuid, bigint, bigint) from public, anon, authenticated;
grant  execute on function public.dungeon_shield(uuid, uuid, uuid, bigint, bigint) to service_role;
