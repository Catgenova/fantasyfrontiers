-- ============================================================================
-- SCHEDULE THE SHADOW DETECTORS. Applying 20260807140000 created unique_provenance_sweep but nothing calls
-- it, so it has produced exactly zero rows since deploy. This schedules it.
--
-- A DEPARTURE FROM THE HOUSE PATTERN, deliberately. Every other cron schedule in this directory lives in a
-- runbook COMMENT for the owner to run by hand (item-unexplained-sweep at :7). Doing it in a migration is
-- better here for one reason: a detector that is deployed but unscheduled looks identical to a detector that
-- is scheduled and finding nothing, which is the same ambiguity the digest exists to solve. Making the
-- schedule part of the migration means "applied" and "running" cannot drift apart again.
--
-- SLOTS. :7 is taken by item-unexplained-sweep. The provenance sweep goes at :23 and the digest at :35, so
-- the digest reads both sweeps' output in the same hour they produce it, and no two jobs share a minute --
-- a webhook burst from three jobs at once is how posts get rate-limited into nothing.
--
-- IDEMPOTENT. Unschedules by name before scheduling, rather than relying on cron.schedule's upsert-by-name
-- (which is version dependent). Re-running this file is safe and leaves exactly one job per name.
--
-- FAILS LOUDLY, never silently. If pg_cron is not installed, or the sweep function is missing, this raises
-- rather than reporting success on a database where nothing will run. The digest is the one exception: it is
-- scheduled only if its function exists, with a NOTICE if not, because 20260807180000 may not be applied yet
-- and a hard failure there would block the sweep schedule this file is actually for.
-- ============================================================================

begin;

do $do$
begin
  -- pg_cron itself. On Supabase this is enabled from Database -> Extensions; a migration cannot reliably
  -- create it (it needs superuser and a shared_preload_libraries entry), so this reports rather than tries.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed. Enable it in Database -> Extensions, then re-run this file.';
  end if;

  -- The sweep this file exists for. Missing = 20260807140000 was never applied, which is worth stopping on.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'unique_provenance_sweep'
  ) then
    raise exception 'public.unique_provenance_sweep() does not exist. Apply 20260807140000_sweep_unique_provenance.sql first.';
  end if;

  if exists (select 1 from cron.job where jobname = 'unique-provenance-sweep') then
    perform cron.unschedule('unique-provenance-sweep');
  end if;
  -- p_enforce is FALSE and the function has no clamp path at all. This detector cannot act on anyone; it
  -- records candidates for a human to read. Do not change the false without reading that migration's
  -- header -- a legitimate guild-bank withdrawal is indistinguishable from an injection until transfers
  -- are logged, which is exactly why it ships shadow-only.
  perform cron.schedule('unique-provenance-sweep', '23 * * * *',
                        $job$ select public.unique_provenance_sweep(false) $job$);
  raise notice 'scheduled unique-provenance-sweep at :23 (shadow only, no clamp path)';

  -- The digest that makes the sweep's output audible. Soft-gated: it lives in a separate migration that may
  -- not be applied yet, and this file's job is the sweep.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'shadow_signal_digest'
  ) then
    if exists (select 1 from cron.job where jobname = 'shadow-signal-digest') then
      perform cron.unschedule('shadow-signal-digest');
    end if;
    perform cron.schedule('shadow-signal-digest', '35 * * * *',
                          $job$ select public.shadow_signal_digest() $job$);
    raise notice 'scheduled shadow-signal-digest at :35';
  else
    raise notice 'shadow_signal_digest() not found: apply 20260807180000_shadow_signal_digest.sql and re-run this file, or the sweep will record signals that nobody is told about';
  end if;
end
$do$;

commit;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY. I cannot run any of this here (no database in the build environment).
--
-- STEP 1 -- the jobs exist, one per name, on the minutes intended:
--     select jobid, jobname, schedule, active, command
--     from cron.job
--     where jobname in ('unique-provenance-sweep', 'shadow-signal-digest', 'item-unexplained-sweep')
--     order by jobname;
--     -- EXPECT: three rows, schedules '23 * * * *', '35 * * * *', '7 * * * *', all active.
--     -- More than one row per name means the unschedule above did not match; fix before waiting an hour.
--
-- STEP 2 -- the FIRST run baselines and reports nothing, by design. Do not read silence as a failure:
--     select public.unique_provenance_sweep(false);   -- EXPECT: zero rows on the first run, ever
--     select count(*) from public.unique_watch;       -- EXPECT: > 0 once it has run
--
-- STEP 3 -- confirm the scheduler actually ran them, after the next :23 and :35. This is the query that
--     distinguishes "scheduled and quiet" from "not running", which is the whole reason for this file:
--     select j.jobname, d.start_time, d.status, d.return_message
--     from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--     where j.jobname in ('unique-provenance-sweep', 'shadow-signal-digest')
--     order by d.start_time desc limit 20;
--     -- EXPECT: status 'succeeded'. A failure message here is the only place a broken job announces itself,
--     -- since the digest posts nothing on a clean hour and the sweep returns no rows on a clean sweep.
--
-- TO STOP EITHER, without dropping anything:
--     select cron.unschedule('unique-provenance-sweep');
--     select cron.unschedule('shadow-signal-digest');
