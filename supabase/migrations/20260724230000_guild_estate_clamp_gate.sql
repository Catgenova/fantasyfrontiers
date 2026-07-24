-- ============================================================================
-- GUILD-ESTATE CLAMP GATE — close the last gap in the account-clamp system (migration 20260724210000).
--
-- The clamp's 'guild' surface is enforced by the guild_* EDGE functions, but the shared guild estate runs
-- on SECURITY DEFINER RPCs (guild_estate_job_start / _assist), not an edge function -- so a clamped account
-- could still start landscaping jobs on, and assist teammates on, the shared grid. This gates those two
-- ACTION RPCs on is_clamped(auth.uid(),'guild').
--
-- Scope: only the two RPCs that ADD work to / touch the shared grid are gated. _complete and _cancel (which
-- only REMOVE the caller's OWN job) are deliberately left open, so a clamp can never STRAND an in-flight job
-- on the shared grid -- a clamped member's existing job winds down cleanly, and they simply can't start a new
-- one. _get (read) stays open too; seeing the estate harms no one.
--
-- Each function is recreated VERBATIM from its current authoritative definition (job_start from
-- 20260724170000 WITH its clear-level gate intact; assist from 20260724160000) plus one clamp check right
-- after the auth check. create-or-replace keeps existing grants; they're re-issued below for clarity.
-- Deploy-safe: additive, and is_clamped already exists (20260724210000).
-- ============================================================================

-- ---- guild_estate_job_start: level-gated clear (from 170000) + clamp gate. ----
create or replace function public.guild_estate_job_start(p_kind text, p_x int, p_y int, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g       uuid;
  uname   text;
  r       public.guild_estate_jobs;
  ins     public.guild_estate_jobs;
  dur     bigint;
  v_ready timestamptz;
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
    return jsonb_build_object('ok', true, 'claimed', false, 'job', public.guild_estate_job_row(r));
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
  return jsonb_build_object('ok', true, 'claimed', false, 'job', public.guild_estate_job_row(r));
end $$;

-- ---- guild_estate_job_assist: unchanged body (from 160000) + clamp gate. ----
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
    return jsonb_build_object('ok', true, 'claimed', false, 'job', public.guild_estate_job_row(me));
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
revoke execute on function public.guild_estate_job_assist(uuid)              from public, anon;
grant  execute on function public.guild_estate_job_start(text,int,int,jsonb) to authenticated;
grant  execute on function public.guild_estate_job_assist(uuid)              to authenticated;
