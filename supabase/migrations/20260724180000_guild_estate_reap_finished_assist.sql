-- ============================================================================
-- GUILD ESTATE — server auto-clears a finished ASSIST row so an assist no longer
-- depends on BOTH players logging back in.
--
-- Report: after member B assists member A's landscaping job, both hold a
-- guild_estate_jobs row that ends at the SAME (halved) time. A's row is the real
-- job -- its owner collects the reward and applies the grid change on return.
-- B's 'assist' row is pure bookkeeping: it grants nothing and touches no tile, it
-- only marks B busy. Completion was owner-driven (each client releases its OWN row
-- via guild_estate_job_complete), so B's finished assist row LINGERED until B
-- logged back in -- keeping B shown "busy" and the assist pairing effectively
-- locked until BOTH players returned.
--
-- Fix: guild_estate_job_get() now deletes finished assist rows for the caller's
-- guild before returning the list. Any member viewing the shared grid -- including
-- A on return -- reaps B's elapsed assist marker, so B never has to log in. An
-- assist shares its target's ready_at, so a finished assist implies its helped job
-- is finished too: this can never free an assister while the job it sped is still
-- running. The realtime DELETE it emits refreshes every online member's view
-- (guildEstateJobsRefresh), and guildEstate.job is a getter over that list, so the
-- assister's own client also sees itself freed with no code change.
--
-- NOT reaped here: the DOER's own finished job. Its grid change lives in the
-- client-synced estate blob (the server cannot apply it) and its XP/resource reward
-- credits the owner's own client -- so it is still finalized by its owner on return,
-- exactly like a solo (un-assisted) job and every other estate job. This removes the
-- assist-specific SECOND dependency; it does not (and cannot) server-apply a grid
-- mutation. A departed member's stranded job is still handled by the existing
-- reapOrphanGuildEstateJobs path.
-- ============================================================================

create or replace function public.guild_estate_job_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g uuid; v_jobs jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  g := public.guild_estate_my_guild();
  if g is null then return jsonb_build_object('ok', false, 'error', 'noguild'); end if;

  -- Self-heal: an 'assist' row grants nothing and owns no tile, so once its timer elapses it is safe to
  -- drop server-side -- the assister does not need to be online to release it. (It shares its target's
  -- ready_at, so a finished assist means the helped job is finished too, never one still in progress.)
  -- The DELETE emits a realtime event that refreshes every member's grid view.
  delete from public.guild_estate_jobs
    where guild_id = g and kind = 'assist' and ready_at <= now();

  select coalesce(jsonb_agg(public.guild_estate_job_row(j)), '[]'::jsonb) into v_jobs
    from public.guild_estate_jobs j where j.guild_id = g;
  return jsonb_build_object('ok', true, 'jobs', v_jobs);
end $$;

-- Grants unchanged from 20260724160000 (client-callable; identity from auth.uid()).
revoke execute on function public.guild_estate_job_get() from public, anon;
grant  execute on function public.guild_estate_job_get() to authenticated;
