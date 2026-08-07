-- ============================================================================
-- ONE ESTATE JOB KIND FOR EVERY FUTURE BUILDING: 'build'.
--
-- WHY THIS SHAPE. Every placeable so far got its own kind, and the cost of that is written across this
-- directory: 20260803200000 taught estate_job_start the 'totem' kind, then 20260803260000 had to be written
-- the same day because the estate_jobs TABLE has its own CHECK constraint that was still refusing it (the
-- SteakHouse freeze: the function accepts, the INSERT throws, the client shows one quiet line, and a QUEUED
-- job redispatches into the same error forever). 20260803250000 was the guild half of the same fix. Client
-- side the count is worse: a kind must appear in EIGHT switches, and 'totem' was missing from one of them in
-- three separate releases.
--
-- So v0.0.90.0 adds ONE generic kind carrying { buildingId } in its payload, exactly as 'totem' carries
-- { totemId }, landing in the grid cell's `buildingId` field -- which has been in the cell constructor since
-- the beginning and was never used. Batch A ships three buildings on it (Aqueduct, Sun Terrace, Apiary) and
-- the next eight need NO migration at all: a def in the client's table, a draw model, done.
--
-- ALL FOUR PLACES, in one file, because that is the lesson above:
--   1. estate_jobs.kind          CHECK constraint
--   2. guild_estate_jobs.kind    CHECK constraint (keeps 'assist', which is guild-only)
--   3. estate_job_start          whitelist
--   4. guild_estate_job_start    whitelist
--   ...plus estate_job_duration_ms, which both start functions share.
--
-- DURATION: 10 minutes per tier, matching Cottages, read off the buildingId with the same
-- estate_job_tier_from_id helper every other arm uses. The client's ESTATE_BUILD_MS_PER_TIER must stay equal
-- to this -- the server figure is authoritative for the personal (server-owned) job, so if they disagree the
-- timer the player watches is not the timer that gates their reward.
--
-- The two start functions are otherwise re-created VERBATIM from their latest versions
-- (20260803200000 for the personal one, 20260803250000 for the guild one) with only the whitelist line
-- changed. Copy the latest, never the one you remember.
-- ============================================================================

begin;

-- ---- 1 + 2: the two table constraints ---------------------------------------------------------------
alter table public.estate_jobs drop constraint if exists estate_jobs_kind_check;
alter table public.estate_jobs add constraint estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem','build'));

alter table public.guild_estate_jobs drop constraint if exists guild_estate_jobs_kind_check;
alter table public.guild_estate_jobs add constraint guild_estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem','build','assist'));

-- ---- the shared duration table ----------------------------------------------------------------------
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
  elsif p_kind = 'totem' then
    t := public.estate_job_tier_from_id(p_payload->>'totemId');
    return (t + 1)::bigint * 120000;                 -- 2m per tier (ESTATE_TOTEM_MS_PER_TIER)
  elsif p_kind = 'build' then
    t := public.estate_job_tier_from_id(p_payload->>'buildingId');
    return (t + 1)::bigint * 600000;                 -- 10m per tier (ESTATE_BUILD_MS_PER_TIER)
  end if;
  return 600000;
exception when others then
  return 600000;                                     -- malformed payload -> full default cooldown, never 0
end $$;

-- ---- 3: the personal start function ------------------------------------------------------------------
-- VERBATIM from 20260803200000 (the latest version), whitelist line only. Its sentinel/on-conflict shape,
-- the 64x64 coordinate bounds and the estate_job_row() response helper are all load-bearing.
create or replace function public.estate_job_start(p_kind text, p_x int, p_y int, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        public.estate_jobs;
  ins      public.estate_jobs;
  dur      bigint;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem','build') then
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

-- ---- 4: the guild start function ---------------------------------------------------------------------
-- VERBATIM from 20260803250000 (the latest version), whitelist line only. Note it carries the clamp gate,
-- guild_estate_my_guild(), the tile-busy conflict and guild_estate_job_row() -- none of which the personal
-- one has, which is exactly why these are copied rather than written from memory.
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
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem','build') then
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

revoke execute on function public.guild_estate_job_start(text,int,int,jsonb) from public, anon;
grant  execute on function public.guild_estate_job_start(text,int,int,jsonb) to authenticated;

commit;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY. I cannot run any of this here (no database in the build environment). This is the step that
-- would have caught the missed constraint half last time, so please actually run it.
--
-- STEP 1 -- BOTH constraints accept the new kind. Run as any authenticated player with no estate job:
--     select public.estate_job_start('build', 1, 1, '{"buildingId":"apiary_t0"}'::jsonb);
--     -- EXPECT: {"ok":true,"claimed":true,...} with readyAt ~10 minutes out.
--     -- A raw ERROR mentioning estate_jobs_kind_check means the constraint half did not apply.
--     select public.estate_job_cancel();     -- tidy the probe up
--
-- STEP 2 -- the duration table reads the payload, per tier:
--     select public.estate_job_duration_ms('build', '{"buildingId":"apiary_t0"}'::jsonb)  as t0,
--            public.estate_job_duration_ms('build', '{"buildingId":"apiary_t20"}'::jsonb) as t20,
--            public.estate_job_duration_ms('build', '{}'::jsonb)                          as no_payload;
--     -- EXPECT: t0 = 600000 (10m), t20 = 12600000 (3h30m), no_payload = 600000 (the safe default).
--
-- STEP 3 -- the guild half, as a guild member with no guild job running:
--     select public.guild_estate_job_start('build', 2, 2, '{"buildingId":"aqueduct_t0"}'::jsonb);
--     -- EXPECT: {"ok":true,"claimed":true,...}. {"ok":false,"error":"kind"} = the whitelist did not apply.
--
-- STEP 4 -- nothing else regressed. Every old kind still starts (spot-check the one most recently added):
--     select public.estate_job_duration_ms('totem', '{"totemId":"totem_t1"}'::jsonb);   -- EXPECT: 240000
--
-- ALSO RE-RUN THE ITEM CATALOGUE SEED with this release: the three building families add 63 keys
-- (aqueduct/sunterrace/apiary, 21 tiers each, all market-tradeable). Without it item_sync refuses to ledger
-- a crafted building and the marketplace refuses to list one. The small additive paste:
--     insert into public.item_catalog (item_key, tradeable)
--     select p || '_t' || t, true
--     from   unnest(array['aqueduct','sunterrace','apiary']) as p
--     cross join generate_series(0, 20)                      as t
--     on conflict (item_key) do nothing;
--     -- EXPECT: 63 rows inserted. Verify: select count(*) from public.item_catalog;  -- 14582
