-- ============================================================================
-- BORDERS BECOME TIMED ESTATE JOBS: the 'border' kind.
--
-- Curbs, Fences and Walls were the ONE estate construction that finished instantly. estateBuildBorder
-- consumed the Masonry recipe and wrote the edge in the same click, with no job row, no clock and no
-- server round trip, while paving / workshops / cottages / fields / totems / buildings all queue behind
-- the single server-owned estate job. v0.0.94.0 gives them a build timer and an Architecture placement
-- gate, which means they need a job kind.
--
-- THIS FILE IS SELF-SUFFICIENT ON PURPOSE. It carries BOTH 'build' (from 20260807260000) and 'border' in
-- all four places, so it does not matter whether 20260807260000 was ever applied and it does not matter
-- which order the two run in. Applying THIS one alone is enough for both kinds. Everything below the
-- constraint block is copied VERBATIM from 20260807260000, which is the latest version of both start
-- functions -- copy the latest, never the one you remember (the lesson written into that file's header,
-- and the reason its guild half was correct).
--
-- ALL FOUR PLACES, in one file:
--   1. estate_jobs.kind          CHECK constraint
--   2. guild_estate_jobs.kind    CHECK constraint (keeps 'assist', which is guild-only)
--   3. estate_job_start          whitelist
--   4. guild_estate_job_start    whitelist
--   ...plus estate_job_duration_ms, which both start functions share.
--
-- DURATION: 1 minute per tier times the type's multiplier (Curb 1x, Fence 2x, Wall 3x). The tier ENCODES
-- the type, because Masonry's recipe list is 7 stones x 3 types in order, so tier % 3 is 0 for a Curb,
-- 1 for a Fence and 2 for a Wall. That is why this arm needs no new payload field and why the client's
-- borderBuildMs can compute the same number from the same id. THE SERVER FIGURE IS AUTHORITATIVE for a
-- personal job, so if the two ever disagree the timer the player watches is not the timer that gates
-- their reward. Change both or neither.
--
-- NO NEW ITEM KEYS. A border is built in place from its recipe's own inputs (bricks, pillars, fill), not
-- from a crafted item, so there is nothing to add to item_catalog with this release.
-- ============================================================================

begin;

-- ---- 1 + 2: the two table constraints ---------------------------------------------------------------
alter table public.estate_jobs drop constraint if exists estate_jobs_kind_check;
alter table public.estate_jobs add constraint estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem','build','border'));

alter table public.guild_estate_jobs drop constraint if exists guild_estate_jobs_kind_check;
alter table public.guild_estate_jobs add constraint guild_estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem','build','border','assist'));

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
  elsif p_kind = 'border' then
    -- 1 minute per tier x the TYPE's own multiplier. The tier ENCODES the type on Masonry's 7-stone x
    -- 3-type list (tier % 3 = 0 Curb / 1 Fence / 2 Wall), so no extra payload field is needed and the
    -- client's borderBuildMs computes the identical number. A Sand Curb is 1 minute, a Lime Wall is 63.
    t := public.estate_job_tier_from_id(p_payload->>'masonryTileId');
    return (t + 1)::bigint * 60000 * ((t % 3) + 1)::bigint;
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
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem','build','border') then
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
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem','build','border') then
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
-- VERIFY. I cannot run any of this here (no database in the build environment). Please actually run it.
--
-- STEP 1 -- BOTH constraints accept the new kind. As any authenticated player with no estate job:
--     select public.estate_job_start('border', 1, 1, '{"orient":"y","masonryTileId":"masonry_t0"}'::jsonb);
--     -- EXPECT: {"ok":true,"claimed":true,...} with readyAt ~1 minute out (a Sand Curb).
--     -- A raw ERROR mentioning estate_jobs_kind_check means the constraint half did not apply.
--     select public.estate_job_cancel();     -- tidy the probe up
--
-- STEP 2 -- the duration table, and that the TYPE multiplier really comes out of the tier:
--     select public.estate_job_duration_ms('border', '{"masonryTileId":"masonry_t0"}'::jsonb)  as curb_t0,
--            public.estate_job_duration_ms('border', '{"masonryTileId":"masonry_t1"}'::jsonb)  as fence_t1,
--            public.estate_job_duration_ms('border', '{"masonryTileId":"masonry_t2"}'::jsonb)  as wall_t2,
--            public.estate_job_duration_ms('border', '{"masonryTileId":"masonry_t20"}'::jsonb) as wall_t20,
--            public.estate_job_duration_ms('border', '{}'::jsonb)                              as no_payload;
--     -- EXPECT: curb_t0 = 60000 (1m), fence_t1 = 240000 (4m), wall_t2 = 540000 (9m),
--     --         wall_t20 = 3780000 (63m), no_payload = 60000 (tier 0 reads as a Curb).
--     -- These five numbers are asserted against the client's borderBuildMs in tests/selftest.js.
--
-- STEP 3 -- the guild half, as a guild member with no guild job running:
--     select public.guild_estate_job_start('border', 2, 2, '{"orient":"x","masonryTileId":"masonry_t2"}'::jsonb);
--     -- EXPECT: {"ok":true,"claimed":true,...}. {"ok":false,"error":"kind"} = the whitelist did not apply.
--
-- STEP 4 -- nothing else regressed. Both previously-added kinds still price correctly:
--     select public.estate_job_duration_ms('build', '{"buildingId":"apiary_t20"}'::jsonb) as build_t20,
--            public.estate_job_duration_ms('totem', '{"totemId":"totem_t1"}'::jsonb)      as totem_t1;
--     -- EXPECT: build_t20 = 12600000, totem_t1 = 240000.
--
-- NOTE ON COORDINATES: a border's x/y address an EDGE, not a tile, so x or y may legitimately equal 20
-- (the outer boundary of a 20x20 plot). The existing 0..63 bound in both start functions already allows
-- that, which is why the coordinate check needed no change.
