-- ============================================================================
-- PERSONAL ESTATE — make "a started job cannot be restarted" an explicit server guard.
--
-- Pentest: refiring /rest/v1/rpc/estate_job_start for a tile already in progress was reported to restart
-- the completion clock. The current estate_job_start (20260720120000) already prevents that structurally
-- -- user_id is the PK and the insert is ON CONFLICT DO NOTHING, so a refire leaves the row untouched and
-- hands the existing job back (claimed=false). If the reported behavior is live, the DEPLOYED function
-- predates that migration.
--
-- This rebuild makes the invariant EXPLICIT and independent of the conflict clause: an ACTIVE (unexpired)
-- job is returned unchanged BEFORE any insert is attempted, so its started_at/ready_at can never be
-- rewritten -- by a second browser, or by a hand-crafted PostgREST call. Redeploy it to guarantee the
-- guard is live. Response shape is unchanged, so the client needs no change.
--
-- (Re-clearing an already-cleared tile can't be blocked here: the server owns the COOLDOWN, not the grid
-- -- the map lives in the save blob. Any items a re-clear would grant still flow through the rate-capped,
-- catalog-gated item ledger and the monotonic XP guard, so it can't be farmed for real profit.)
-- ============================================================================

create or replace function public.estate_job_start(p_kind text, p_x int, p_y int, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        public.estate_jobs;
  ins      public.estate_jobs;
  dur      bigint;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field') then
    return jsonb_build_object('ok', false, 'error', 'kind');
  end if;
  if p_x is null or p_y is null or p_x < 0 or p_y < 0 or p_x >= 64 or p_y >= 64 then
    return jsonb_build_object('ok', false, 'error', 'coords');
  end if;

  -- SENTINEL: if a job already exists for this user, it is authoritative and untouchable.
  --   * finished (ready_at <= now): 'pending' -- collect it first (the client completes then retries).
  --   * still running (ready_at > now): hand it back unchanged (claimed=false) -- NEVER restart its clock
  --     and NEVER start a second task. This runs BEFORE the insert, so a refire cannot rewrite the timer.
  select * into r from public.estate_jobs where user_id = auth.uid();
  if r.user_id is not null then
    if r.ready_at <= now() then
      return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.estate_job_row(r));
    end if;
    return jsonb_build_object('ok', true, 'claimed', false, 'job', public.estate_job_row(r));
  end if;

  dur := public.estate_job_duration_ms(p_kind, coalesce(p_payload, '{}'::jsonb));

  -- No existing row -> claim one. ON CONFLICT DO NOTHING still guards the (rare) concurrent-insert race:
  -- the loser gets claimed=false + whichever job won, so two windows starting at once can't double-claim.
  insert into public.estate_jobs (user_id, kind, x, y, payload, started_at, ready_at)
  values (auth.uid(), p_kind, p_x, p_y, coalesce(p_payload, '{}'::jsonb), now(), now() + (dur || ' milliseconds')::interval)
  on conflict (user_id) do nothing
  returning * into ins;

  if ins.user_id is not null then
    return jsonb_build_object('ok', true, 'claimed', true, 'job', public.estate_job_row(ins));
  end if;

  select * into r from public.estate_jobs where user_id = auth.uid();
  return jsonb_build_object('ok', true, 'claimed', false, 'job', public.estate_job_row(r));
end $$;

revoke execute on function public.estate_job_start(text,int,int,jsonb) from public, anon;
grant  execute on function public.estate_job_start(text,int,int,jsonb) to authenticated;
