-- ============================================================================
-- ESTATE CLEAR — best-effort server level gate on 'clear' jobs (personal + guild).
--
-- Pentest ("Estate Character Level Not Enforced for Clear"): estate_job_start accepted a clear job for any
-- tier regardless of the caller's skill, so hand-crafting a /rest/v1/rpc/estate_job_start call let a level-1
-- account start clearing a tier-8 obstacle it could never reach in the UI. The client gates this
-- (estateCanClearObstacle: getLevel(state.xp[skill]) >= TIER_LEVELS[tierIndex]); the server did not.
--
-- Fix: on a 'clear' job, derive the required skill (from the obstacle type) and the required level
-- (TIER_LEVELS[tierIndex]) from the payload, and reject ('level') if the caller's PUBLISHED profile skill
-- level is below it. This blocks the naive "just call the endpoint" attack in the finding.
--
-- HONEST SCOPE (why this is best-effort, not a hard guarantee -- deliberately, per the design discussion):
--   * The grid lives in the client save blob, so the server can't re-derive what obstacle is actually on a
--     tile -- it can only check the tier the CALLER claims in the payload. Lying about tierIndex bypasses it.
--   * profiles.skills is client-authored (the leaderboard publish), so a determined attacker can inflate it.
--   * The reward (items + XP) is applied client-side; the item ledger's rate-cap + catalog gate and the
--     monotonic XP guard remain the real economic backstop, exactly as before.
-- It raises the bar on the reported exploit without pretending the estate grid is server-authoritative
-- (which is infeasible while obstacles are client Math.random() and unre-derivable server-side).
-- ============================================================================

-- True if the caller's published profile skill meets the level the CLAIMED obstacle tier requires.
-- Type->skill mirrors ESTATE_OBSTACLE_TYPES; the level array mirrors TIER_LEVELS in index.html. An unknown/
-- absent obstacle type (empty tile or malformed payload) has nothing to gate on -> allow (the RPC's other
-- guards and the item/XP backstops still apply).
create or replace function public.estate_clear_meets_level(p_payload jsonb)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_skill  text;
  v_tier   int;
  v_req    int;
  v_have   int;
  v_levels int[] := array[1,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100];  -- TIER_LEVELS
begin
  v_skill := case p_payload->>'type'
    when 'berries' then 'foraging'
    when 'herbs'   then 'herbalism'
    when 'trees'   then 'forestry'
    when 'rocks'   then 'mining'
    when 'ore'     then 'mining'
    else null end;
  if v_skill is null then return true; end if;                     -- nothing to gate on
  begin
    v_tier := (p_payload->>'tierIndex')::int;
  exception when others then
    v_tier := 0;                                                   -- non-numeric tier -> treat as the easiest
  end;
  v_tier := least(20, greatest(0, coalesce(v_tier, 0)));           -- clamp into the level array
  v_req  := v_levels[v_tier + 1];
  v_have := coalesce((select (skills->> v_skill)::int from public.profiles where id = auth.uid()), 0);
  return v_have >= v_req;
exception when others then
  return true;  -- never let a gate-lookup error block a legitimate clear; the finding is about bypass, not DoS.
end $$;

-- ---- PERSONAL estate: add the clear gate (otherwise identical to 20260724150000_estate_job_no_restart). ----
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
  -- Best-effort level gate on clears (see header). Runs before the sentinel so an under-level clear is
  -- rejected even when the caller currently has no job.
  if p_kind = 'clear' and not public.estate_clear_meets_level(coalesce(p_payload, '{}'::jsonb)) then
    return jsonb_build_object('ok', false, 'error', 'level');
  end if;

  -- SENTINEL: if a job already exists for this user, it is authoritative and untouchable.
  --   * finished (ready_at <= now): 'pending' -- collect it first (the client completes then retries).
  --   * still running (ready_at > now): hand it back unchanged (claimed=false) -- NEVER restart its clock
  --     and NEVER start a second task. This runs BEFORE the insert, so a refire cannot rewrite the timer.
  select * into r from public.estate_jobs where user_id = auth.uid();
  if r.user_id is not null then
    if r.ready_at <= now() then
      return jsonb_build_object('ok', false, 'error', 'pending', 'job', public.estate_job_row(r));
    end if;
    return jsonb_build_object('ok', true, 'claimed', false, 'job', public.estate_job_row(r));
  end if;

  dur := public.estate_job_duration_ms(p_kind, coalesce(p_payload, '{}'::jsonb));

  -- No existing row -> claim one. ON CONFLICT DO NOTHING still guards the (rare) concurrent-insert race:
  -- the loser gets claimed=false + whichever job won, so two windows starting at once can't double-claim.
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

-- ---- GUILD estate: same clear gate (guild obstacles train + gate on the member's PERSONAL skill too). ----
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

-- Internal helper: never called directly by a client.
revoke execute on function public.estate_clear_meets_level(jsonb)           from public, anon, authenticated;
-- Client-callable RPCs (identity from auth.uid()), grants unchanged from their prior migrations.
revoke execute on function public.estate_job_start(text,int,int,jsonb)       from public, anon;
grant  execute on function public.estate_job_start(text,int,int,jsonb)       to authenticated;
revoke execute on function public.guild_estate_job_start(text,int,int,jsonb) from public, anon;
grant  execute on function public.guild_estate_job_start(text,int,int,jsonb) to authenticated;
