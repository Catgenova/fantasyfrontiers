-- ESTATE TOTEM JOBS (v0.0.77.34) ----------------------------------------------------------------------
--
-- Ticket (SteakHouse): raising a totem on a paved personal tile "does nothing" when the estate is idle,
-- and a QUEUED totem placement freezes forever when its turn comes.
--
-- Root cause: totems (client v0.0.54, Jul 28) shipped EIGHT DAYS AFTER the server took ownership of
-- personal estate jobs (20260720120000, Jul 20) -- and no migration ever taught estate_job_start the
-- 'totem' kind. Every totem start is refused with {error:'kind'}: a direct click errors out (one easily
-- missed toast), and the queue redispatches its head into the same refusal every 4 seconds, which is the
-- reported freeze. The guild path deliberately stays totem-less: totems are personal-estate only (the
-- client's totem menu renders only when !estIsGuild, and the yield aura ignores guild plots).
--
-- Two changes, both bodies otherwise verbatim from the deployed versions:
--   1. estate_job_duration_ms grows a totem arm: (tier + 1) * 2 minutes, matching the client's
--      ESTATE_TOTEM_MS_PER_TIER. estate_job_tier_from_id already parses totem_t<k> ids.
--   2. estate_job_start (latest body: 20260731130000, the structured-refusal version) accepts 'totem'.
--
-- The client pairing (same release) fixes the mirror half: estateJobFromServer never mapped totemId, so
-- a server-mirrored totem job would have lost its payload on resync and been dropped by the save-load
-- shape check -- the v0.0.73 totem-vanish bug reborn through a different door.

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
  end if;
  return 600000;
exception when others then
  return 600000;                                     -- malformed payload -> full default cooldown, never 0
end $$;

create or replace function public.estate_job_start(p_kind text, p_x int, p_y int, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        public.estate_jobs;
  ins      public.estate_jobs;
  dur      bigint;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem') then
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
