-- ============================================================================
-- ESTATE JOBS — say NO out loud. Structured refusal instead of an ambiguous success.
--
-- Ticket (ITxToxic, 28 Jul): "Estate Tile Clear Bug — refiring estate_job_start restarts the completion
-- time." The RESTART ITSELF IS NOT HAPPENING. His own capture disproves it: the response's startAt is
-- 01:31:44 against a request at 01:38:11 -- 387 seconds EARLIER -- with readyAt still the original
-- start+600s. The sentinel in 20260724150000 handed back the pre-existing job untouched, and `user_id` is
-- the primary key of estate_jobs so a second concurrent job is impossible anyway.
--
-- What he actually found is a RESPONSE-DESIGN defect, and it is a fair hit: the server signals REFUSAL with
-- HTTP 200 + {"ok": true, "claimed": false}. That is indistinguishable from success by inspection, which is
-- exactly why a careful tester concluded it was unpatched. An endpoint whose "denied" and "accepted"
-- responses share a shape is a bad endpoint however sound the database logic underneath is -- and it is the
-- direct cause of the client desync he also reported, because any caller that checks only `ok` treats a
-- refusal as a success and drifts.
--
-- THIS CHANGE: a running job now returns
--     {"ok": false, "error": "inprogress", "job": {...}, "remainingMs": 213000}
-- `error` is the machine-readable "cannot duplicate job" he asked for; `job` is still included so the
-- client can ADOPT the server's authoritative job and resync rather than guessing; `remainingMs` lets the
-- UI say "ready in 3m 33s" instead of only refusing.
--
-- Applied to all THREE functions that carried the same ambiguous branch -- estate_job_start,
-- guild_estate_job_start and guild_estate_job_assist -- so the next person to probe a sibling endpoint
-- doesn't re-file the same finding. Bodies are otherwise reproduced verbatim from the deployed versions
-- (20260724150000 / 20260724230000): same gates, same order, same duration table, same insert races.
--
-- NOTE ON THE HTTP STATUS: he expected a 4xx. PostgREST can do that via `raise sqlstate 'PT400'`, but an
-- exception cannot carry a JSON body, so the client would lose the `job` payload it needs to resync. The
-- structured refusal is the better trade: unambiguous to a reader AND useful to the client. Every other
-- refusal these functions already emit (auth / kind / coords / clamped / noguild / level / pending) is
-- shaped the same way, so this makes the endpoint internally consistent rather than adding a new idiom.
--
-- CLIENT PAIRING: index.html handles BOTH shapes ('inprogress' OR the legacy ok+!claimed), so a new client
-- is correct against an old server and vice versa. An OLD client against this migration shows a generic
-- "could not start" instead of "you already have one running" until Pages redeploys -- cosmetic, and the
-- window is only as long as the gap between the two deploys.
-- ============================================================================

-- ---- Personal estate ------------------------------------------------------------------------------
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

  -- SENTINEL: an existing job is authoritative and untouchable. Its clock is never rewritten.
  select * into r from public.estate_jobs where user_id = auth.uid();
  if r.user_id is not null then
    if r.ready_at <= now() then
      return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.estate_job_row(r));
    end if;
    -- REFUSED, and it says so. (Was: ok=true, claimed=false -- a refusal wearing a success's clothes.)
    return jsonb_build_object('ok', false, 'error', 'inprogress',
                              'job', public.estate_job_row(r),
                              'remainingMs', greatest(0, floor(extract(epoch from (r.ready_at - now())) * 1000))::bigint);
  end if;

  dur := public.estate_job_duration_ms(p_kind, coalesce(p_payload, '{}'::jsonb));

  insert into public.estate_jobs (user_id, kind, x, y, payload, started_at, ready_at)
  values (auth.uid(), p_kind, p_x, p_y, coalesce(p_payload, '{}'::jsonb), now(), now() + (dur || ' milliseconds')::interval)
  on conflict (user_id) do nothing
  returning * into ins;

  if ins.user_id is not null then
    return jsonb_build_object('ok', true, 'claimed', true, 'job', public.estate_job_row(ins));
  end if;

  -- Lost the concurrent-insert race (a second tab won). Semantically identical to the sentinel above, so
  -- it reports identically rather than as a success.
  select * into r from public.estate_jobs where user_id = auth.uid();
  return jsonb_build_object('ok', false, 'error', 'inprogress',
                            'job', public.estate_job_row(r),
                            'remainingMs', greatest(0, floor(extract(epoch from (r.ready_at - now())) * 1000))::bigint);
end $$;

revoke execute on function public.estate_job_start(text,int,int,jsonb) from public, anon;
grant  execute on function public.estate_job_start(text,int,int,jsonb) to authenticated;

-- ---- Guild estate: start --------------------------------------------------------------------------
create or replace function public.guild_estate_job_start(p_kind text, p_x int, p_y int, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g        uuid;
  uname    text;
  r        public.guild_estate_jobs;
  ins      public.guild_estate_jobs;
  dur      bigint;
  v_ready  timestamptz;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if public.is_clamped(auth.uid(), 'guild') then return jsonb_build_object('ok', false, 'error', 'clamped'); end if;
  g := public.guild_estate_my_guild();
  if g is null then return jsonb_build_object('ok', false, 'error', 'noguild'); end if;
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field') then
    return jsonb_build_object('ok', false, 'error', 'kind');
  end if;
  if p_x is null or p_y is null or p_x < 0 or p_y < 0 or p_x >= 64 or p_y >= 64 then
    return jsonb_build_object('ok', false, 'error', 'coords');
  end if;
  if p_kind = 'clear' and not public.estate_clear_meets_level(coalesce(p_payload, '{}'::jsonb)) then
    return jsonb_build_object('ok', false, 'error', 'level');
  end if;

  -- SENTINEL: the caller's existing job is authoritative -- never rewritten by a refire.
  select * into r from public.guild_estate_jobs where user_id = auth.uid();
  if r.user_id is not null then
    if r.ready_at <= now() then
      return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.guild_estate_job_row(r));
    end if;
    return jsonb_build_object('ok', false, 'error', 'inprogress',
                              'job', public.guild_estate_job_row(r),
                              'remainingMs', greatest(0, floor(extract(epoch from (r.ready_at - now())) * 1000))::bigint);
  end if;

  dur := public.estate_job_duration_ms(p_kind, coalesce(p_payload, '{}'::jsonb));  -- reuse the personal duration table
  v_ready := now() + (dur || ' milliseconds')::interval;
  uname := coalesce((select username from public.guild_members where user_id = auth.uid()), 'A member');

  insert into public.guild_estate_jobs (user_id, guild_id, username, kind, x, y, payload, started_at, ready_at)
  values (auth.uid(), g, left(uname, 32), p_kind, p_x, p_y, coalesce(p_payload, '{}'::jsonb), now(), v_ready)
  on conflict (user_id) do nothing
  returning * into ins;

  if ins.user_id is not null then
    return jsonb_build_object('ok', true, 'claimed', true, 'job', public.guild_estate_job_row(ins));
  end if;

  select * into r from public.guild_estate_jobs where user_id = auth.uid();
  return jsonb_build_object('ok', false, 'error', 'inprogress',
                            'job', public.guild_estate_job_row(r),
                            'remainingMs', greatest(0, floor(extract(epoch from (r.ready_at - now())) * 1000))::bigint);
end $$;

-- ---- Guild estate: assist -------------------------------------------------------------------------
-- Body reproduced verbatim from 20260724230000; only the caller's own-job sentinel changes shape.
create or replace function public.guild_estate_job_assist(p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g        uuid;
  uname    text;
  me       public.guild_estate_jobs;
  tgt      public.guild_estate_jobs;
  v_ready  timestamptz;
  ins      public.guild_estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if public.is_clamped(auth.uid(), 'guild') then return jsonb_build_object('ok', false, 'error', 'clamped'); end if;
  g := public.guild_estate_my_guild();
  if g is null then return jsonb_build_object('ok', false, 'error', 'noguild'); end if;
  if p_target is null or p_target = auth.uid() then return jsonb_build_object('ok', false, 'error', 'assist'); end if;

  -- The caller must be free (one job per member).
  select * into me from public.guild_estate_jobs where user_id = auth.uid();
  if me.user_id is not null then
    if me.ready_at <= now() then return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.guild_estate_job_row(me)); end if;
    return jsonb_build_object('ok', false, 'error', 'inprogress',
                              'job', public.guild_estate_job_row(me),
                              'remainingMs', greatest(0, floor(extract(epoch from (me.ready_at - now())) * 1000))::bigint);
  end if;

  -- Lock the target and validate it's a helpable, still-running, not-yet-assisted job in the same guild.
  select * into tgt from public.guild_estate_jobs where user_id = p_target and guild_id = g for update;
  if tgt.user_id is null or tgt.kind = 'assist' or tgt.ready_at <= now() or tgt.assisted_by is not null then
    return jsonb_build_object('ok', false, 'error', 'assist');
  end if;

  v_ready := now() + greatest(interval '1 second', (tgt.ready_at - now()) / 2);   -- halve the remaining time
  update public.guild_estate_jobs set ready_at = v_ready, assisted_by = auth.uid() where user_id = p_target;

  uname := coalesce((select username from public.guild_members where user_id = auth.uid()), 'A member');
  insert into public.guild_estate_jobs (user_id, guild_id, username, kind, x, y, payload, started_at, ready_at)
  values (auth.uid(), g, left(uname, 32), 'assist', tgt.x, tgt.y,
          jsonb_build_object('assistOf', p_target::text, 'assistOfName', tgt.username), now(), v_ready)
  returning * into ins;

  return jsonb_build_object('ok', true, 'claimed', true, 'job', public.guild_estate_job_row(ins),
                            'target', public.guild_estate_job_row((select t from public.guild_estate_jobs t where t.user_id = p_target)));
end $$;

-- create-or-replace keeps existing privileges; re-issue for clarity (idempotent).
revoke execute on function public.guild_estate_job_start(text,int,int,jsonb) from public, anon;
grant  execute on function public.guild_estate_job_start(text,int,int,jsonb) to authenticated;
revoke execute on function public.guild_estate_job_assist(uuid) from public, anon;
grant  execute on function public.guild_estate_job_assist(uuid) to authenticated;

-- ============================================================================
-- VERIFY (the reporter's own repro, which should now read unambiguously):
--   1. Start a clear, then refire estate_job_start for any tile mid-job. Expect
--        {"ok": false, "error": "inprogress", "job": {...}, "remainingMs": <counting down>}
--   2. Confirm startAt is UNCHANGED between the two responses -- that is the no-restart guard, now legible
--      instead of having to be inferred from a timestamp comparison.
--   3. Let it finish without collecting, refire: expect error "pending" (unchanged behaviour).
--   4. Collect, then start again: expect {"ok": true, "claimed": true} with a fresh startAt.
--   5. Repeat 1-2 against guild_estate_job_start and guild_estate_job_assist.
-- ============================================================================
