-- Server-authoritative cooldowns for PERSONAL estate jobs.
--
-- Reported bug: with the same account open in two browsers, starting a 10-minute tile-clear in one
-- did not exist in the other -- the second browser showed the tile already cleared and could act on
-- it. Root cause: the job lived only in the client save blob (state.estate.job), so each browser ran
-- its own copy of the timer, and save_game's whole-blob last-write-wins (guarded only by total-XP
-- monotonicity) let whichever blob landed last define reality.
--
-- Fix: the ACTIVE JOB moves to this table. user_id is the PRIMARY KEY, so "one estate task at a time"
-- becomes a database invariant rather than a client-side if-check, and a second browser racing a start
-- gets the FIRST job handed back instead of opening its own. ready_at is computed HERE from the server's
-- clock and the canonical duration table -- a client cannot shorten it.
--
-- Scope: PERSONAL estate only. Guild-estate jobs already round-trip through the synced guild_estate
-- blob and keep their existing path.
--
-- NOTE: the grid itself still lives in the save blob, so the server owns the COOLDOWN, not the map.
-- That is deliberate and matches the accepted constraint that the server cannot replay the idle sim.

create table if not exists public.estate_jobs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  kind       text        not null check (kind in ('clear','raise','lower','pave','workshop','cottage','field')),
  x          int         not null check (x >= 0 and x < 64),
  y          int         not null check (y >= 0 and y < 64),
  payload    jsonb       not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  ready_at   timestamptz not null
);

alter table public.estate_jobs enable row level security;

-- Players may READ their own active job (handy for debugging via PostgREST); every WRITE goes through
-- the RPCs below, which is what keeps ready_at server-computed.
drop policy if exists estate_jobs_select_own on public.estate_jobs;
create policy estate_jobs_select_own on public.estate_jobs
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.estate_jobs from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Canonical durations. These MUST mirror index.html: ESTATE_OBSTACLE_MS_PER_TIER (10m/tier),
-- ESTATE_TERRAFORM_MS (10m flat), ESTATE_PAVE_MS_PER_TIER (10m/tier),
-- ESTATE_WORKSHOP_MS_PER_TIER (30m/tier), ESTATE_COTTAGE_MS_PER_TIER (10m/tier),
-- ESTATE_FIELD_MS_PER_TIER (5m/tier). If a duration changes client-side, change it here too.
--
-- Tier comes from the item id suffix (`..._t<N>`) for pave/workshop/cottage, straight from the payload
-- for clear/field. A client that lies about the tier gets a DIFFERENT duration, not a zero one -- the
-- cooldown is still real and still server-clocked, which is what this migration is here to guarantee.
-- ---------------------------------------------------------------------------------------------
create or replace function public.estate_job_tier_from_id(p_id text)
returns int language sql immutable as $$
  select greatest(0, least(20, coalesce((regexp_match(coalesce(p_id,''), '_t(\d+)$'))[1]::int, 0)));
$$;

create or replace function public.estate_job_duration_ms(p_kind text, p_payload jsonb)
returns bigint language plpgsql immutable as $$
declare
  t int;
begin
  if p_kind = 'raise' or p_kind = 'lower' then
    return 600000;                                   -- ESTATE_TERRAFORM_MS
  elsif p_kind = 'clear' then
    t := greatest(0, least(20, coalesce((p_payload->>'tierIndex')::int, 0)));
    return (t + 1)::bigint * 600000;                 -- (tierIndex+1) * 10m
  elsif p_kind = 'pave' then
    t := public.estate_job_tier_from_id(p_payload->>'paveTileId');
    return (t + 1)::bigint * 600000;
  elsif p_kind = 'workshop' then
    t := public.estate_job_tier_from_id(p_payload->>'workshopId');
    return (t + 1)::bigint * 1800000;                -- 30m per tier
  elsif p_kind = 'cottage' then
    t := public.estate_job_tier_from_id(p_payload->>'cottageId');
    return (t + 1)::bigint * 600000;
  elsif p_kind = 'field' then
    t := greatest(0, least(20, coalesce((p_payload->>'fieldTier')::int, 0)));
    return (t + 1)::bigint * 300000;                 -- 5m per tier
  end if;
  return 600000;
exception when others then
  return 600000;                                     -- malformed payload -> full default cooldown, never 0
end $$;

-- Shape the row the client consumes. Times go out as epoch ms to match the client's Date.now() math.
create or replace function public.estate_job_row(r public.estate_jobs)
returns jsonb language sql immutable as $$
  select case when r.user_id is null then null else jsonb_build_object(
    'kind',    r.kind,
    'x',       r.x,
    'y',       r.y,
    'payload', r.payload,
    'startAt', (extract(epoch from r.started_at) * 1000)::bigint,
    'readyAt', (extract(epoch from r.ready_at)   * 1000)::bigint
  ) end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client-callable RPCs. Identity comes from auth.uid() -- there is deliberately NO p_user parameter,
-- which is why these stay granted to `authenticated` rather than being locked to service_role like the
-- dungeon_*/wallet_*/item_* RPCs (see 20260716220000_lock_definer_rpcs.sql). Nothing here trusts a
-- caller-supplied identity.
-- ---------------------------------------------------------------------------------------------
create or replace function public.estate_job_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  select * into r from public.estate_jobs where user_id = auth.uid();
  return jsonb_build_object('ok', true, 'job', public.estate_job_row(r));
end $$;

-- Atomic claim. `claimed` is true only for the caller that actually created the row; a second browser
-- racing the same start gets claimed=false plus the EXISTING job, so it neither double-spends materials
-- nor restarts the timer.
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

  -- If a finished job is sitting uncollected, hand it back instead of starting a new one -- and do NOT
  -- delete it here. Deleting would silently destroy that job's rewards for the browser that earned them
  -- (a player who closed the tab mid-job collects on next load). The client applies the completion and
  -- retries the start, so this cannot wedge.
  select * into r from public.estate_jobs where user_id = auth.uid();
  if r.user_id is not null and r.ready_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.estate_job_row(r));
  end if;

  dur := public.estate_job_duration_ms(p_kind, coalesce(p_payload, '{}'::jsonb));

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

-- Completion is the actual cooldown gate: the row is only released once the SERVER's clock passes
-- ready_at. A second browser asking early gets ok=false and the real remaining time.
create or replace function public.estate_job_complete()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  done public.estate_jobs;
  cur  public.estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  delete from public.estate_jobs
   where user_id = auth.uid() and ready_at <= now()
  returning * into done;

  if done.user_id is not null then
    return jsonb_build_object('ok', true, 'job', public.estate_job_row(done));
  end if;

  select * into cur from public.estate_jobs where user_id = auth.uid();
  if cur.user_id is null then
    return jsonb_build_object('ok', false, 'error', 'none');   -- nothing running (already collected)
  end if;
  return jsonb_build_object('ok', false, 'error', 'early', 'job', public.estate_job_row(cur));
end $$;

create or replace function public.estate_job_cancel()
returns jsonb language plpgsql security definer set search_path = public as $$
declare gone public.estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  delete from public.estate_jobs where user_id = auth.uid() returning * into gone;
  if gone.user_id is null then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  return jsonb_build_object('ok', true, 'job', public.estate_job_row(gone));
end $$;

revoke execute on function public.estate_job_get()                     from public, anon;
revoke execute on function public.estate_job_start(text,int,int,jsonb) from public, anon;
revoke execute on function public.estate_job_complete()                from public, anon;
revoke execute on function public.estate_job_cancel()                  from public, anon;
grant  execute on function public.estate_job_get()                     to authenticated;
grant  execute on function public.estate_job_start(text,int,int,jsonb) to authenticated;
grant  execute on function public.estate_job_complete()                to authenticated;
grant  execute on function public.estate_job_cancel()                  to authenticated;

-- Internal helpers: never called directly by a client.
revoke execute on function public.estate_job_duration_ms(text,jsonb)   from public, anon, authenticated;
revoke execute on function public.estate_job_tier_from_id(text)        from public, anon, authenticated;
revoke execute on function public.estate_job_row(public.estate_jobs)   from public, anon, authenticated;
