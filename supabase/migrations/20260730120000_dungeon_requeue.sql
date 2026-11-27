-- Party requeue (ticket-0117, Mr Cookie): after a group run finishes, put the SAME party back in its
-- lobby so they can descend again without re-forming from scratch.
--
-- Why a server function: the party roster and run state live in dungeon_sessions/dungeon_members, and
-- members have no way to discover a brand-new session id. Resetting the EXISTING session in place keeps
-- everyone attached to the row they are already subscribed to, so every client sees the lobby appear on
-- its next snapshot with no coordination and no join race.
--
-- Host-only, and only from a finished run ('cleared' or 'wiped'). An 'active' session is never touched,
-- so this can't be used to rewind a run in progress or to escape a wipe mid-fight.
create or replace function public.dungeon_requeue(p_session uuid, p_user uuid, p_count int, p_hours int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_status text; v_n int;
begin
  select host_id, status into v_host, v_status
    from public.dungeon_sessions where id = p_session for update;
  if v_host is null then return jsonb_build_object('status','gone'); end if;
  if v_host <> p_user then return jsonb_build_object('status','nothost'); end if;
  -- Only a FINISHED run may be requeued. Guarding on this (rather than "not active") also refuses a
  -- session already sitting in 'lobby', so a double-tap can't extend the timer forever.
  if v_status not in ('cleared','wiped') then return jsonb_build_object('status','notdone'); end if;

  -- Back to a fresh lobby: drop the run's progress and re-arm the expiry window.
  update public.dungeon_sessions
     set status      = 'lobby',
         enemy_index = 0,
         enemy_hp    = 0,
         enemy_count = greatest(1, p_count),
         target_id   = null,
         version     = version + 1,
         updated_at  = now(),
         expires_at  = now() + make_interval(hours => greatest(1, p_hours))
   where id = p_session;

  -- Every member returns alive with a clean slate. hp/max_hp/mit/threat/power are re-reported by each
  -- client when it joins the descent (dungeon_start reads the roster), so zeroing the run-scoped columns
  -- here is enough -- and `claimed` MUST reset or the next clear would pay nobody.
  update public.dungeon_members
     set alive = true,
         damage = 0,
         claimed = false,
         shield = 0,
         pending_swings = 0,
         last_tick = now()
   where session_id = p_session;

  select count(*) into v_n from public.dungeon_members where session_id = p_session;
  return jsonb_build_object('status','ok','members', v_n);
end $$;
