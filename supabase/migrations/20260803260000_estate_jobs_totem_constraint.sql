-- ESTATE TOTEM JOBS, THE MISSED HALF (v0.0.79.1) --------------------------------------------------------
--
-- SteakHouse's retest after 20260803200000: "still the same, nothing happens when I click the totems."
-- That migration taught estate_job_start's WHITELIST the 'totem' kind -- but the estate_jobs TABLE has its
-- own CHECK constraint on kind (from 20260720120000), and 'totem' was never added there. So the function
-- accepts the kind, reaches its INSERT, and the constraint throws: the RPC comes back as an ERROR rather
-- than a structured refusal, the client shows one quiet log line (reads as "nothing happened"), and a
-- QUEUED totem redispatches into the same error forever (the reported freeze). The function-vs-table split
-- is exactly why the guild migration (20260803250000) altered guild_estate_jobs' constraint explicitly;
-- this brings the personal table in line.
--
-- The client pairing (same release) fixes the two failure modes that made this invisible: the queue
-- dispatcher now copies totemId onto the claimed job (a THIRD copy-pasted field list had omitted it), and
-- a hard server refusal now drops + refunds the queued head with a visible reason instead of retrying
-- silently forever.

alter table public.estate_jobs drop constraint if exists estate_jobs_kind_check;
alter table public.estate_jobs add constraint estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem'));

-- HOW TO VERIFY (RUN THIS -- it is the step that would have caught the missed half last time).
-- As any authenticated player with no estate job running:
--   select public.estate_job_start('totem', 1, 1, '{"totemId":"totem_t1"}'::jsonb);
--   -- BEFORE this migration: ERROR  new row for relation "estate_jobs" violates check constraint
--   --                        "estate_jobs_kind_check"
--   -- AFTER: {"ok":true,"claimed":true,...} with ready_at ~4 minutes out
--   select public.estate_job_cancel();   -- tidy up the probe job (or let it finish; it is 4 minutes)
