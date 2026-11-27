-- GUILD ESTATE TOTEMS (v0.0.79.0) ----------------------------------------------------------------------
--
-- Ticket (SteakHouse): "the option for totems doesnt show in guild estate". Until now that was BY DESIGN
-- (20260803200000 kept totems personal-only); the owner has ordered the design changed, so the guild path
-- gains the 'totem' kind end to end. The client pairing (same release) un-gates the totem menu on the
-- guild estate, teaches the yield aura to read the guild grid, and logs raisings to the guild activity log.
--
-- Two server changes, mirroring exactly what 20260803200000 did for the personal path:
--   1. guild_estate_jobs' kind CHECK constraint gains 'totem' ('assist' stays -- it is a guild-only kind
--      the personal table never had).
--   2. guild_estate_job_start (latest body: 20260731130000, the structured-refusal version) accepts
--      'totem'. Durations need nothing: it already delegates to estate_job_duration_ms, whose totem arm
--      ((tier+1) * 2 minutes) shipped in 20260803200000. Assists work on totem jobs for free, since
--      assist logic never inspects the kind.
--
-- The shared grid needs nothing either: guild_estate.data is an opaque blob written by the clients under
-- a version CAS, and cell.totemId simply rides along like workshopId/cottageId always have.

alter table public.guild_estate_jobs drop constraint if exists guild_estate_jobs_kind_check;
alter table public.guild_estate_jobs add constraint guild_estate_jobs_kind_check
  check (kind in ('clear','raise','lower','pave','workshop','cottage','field','totem','assist'));

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
  if p_kind is null or p_kind not in ('clear','raise','lower','pave','workshop','cottage','field','totem') then
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

-- HOW TO VERIFY (as any guild member, after the client release):
--   select public.guild_estate_job_start('totem', 1, 1, '{"totemId":"totem_t1"}'::jsonb);
--   -- BEFORE this migration: {"ok":false,"error":"kind"} (the SteakHouse refusal, one silent toast)
--   -- AFTER: {"ok":true,"claimed":true,...} with ready_at ~4 minutes out ((1+1) * 2m)
--   select public.guild_estate_job_cancel();   -- tidy up the probe job
