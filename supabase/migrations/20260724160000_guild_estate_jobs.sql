-- ============================================================================
-- GUILD ESTATE (landscaping grid) — server-authoritative jobs, parity with the PERSONAL estate.
--
-- Pentest parity: personal estate tile jobs are server-clocked (estate_jobs / estate_job_start), so a
-- refire can't restart the timer and only one job runs at a time. The GUILD estate's landscaping jobs
-- (clear/raise/lower/pave/workshop/cottage/field on the shared grid) lived only in the client-synced
-- `guild_estate` blob, so a member could restart a job's clock or start extras by editing the blob.
--
-- This moves those jobs onto a server table with the same guarantees:
--   * PK on user_id  -> one landscaping job per member (a database invariant, not a client if-check).
--   * ready_at is computed HERE from the server clock + the canonical duration table -> can't be shortened.
--   * A started job is returned UNCHANGED on a refire (claimed=false) -> its clock can never be restarted.
-- guild_estate_job_get returns EVERY member's job for the caller's guild, so the client can show all of
-- them live (the table is added to the realtime publication). The grid itself stays in the blob (the
-- server owns the COOLDOWN, not the map) exactly like the personal estate.
--
-- Guild identity is derived server-side from guild_members (never a client arg), so a caller can't act on
-- another guild. This is a NEW table + NEW RPCs; the client cutover ships alongside.
-- ============================================================================

create table if not exists public.guild_estate_jobs (
  user_id     uuid primary key references auth.users(id) on delete cascade,  -- one landscaping job per member
  guild_id    uuid        not null references public.guilds(id) on delete cascade,
  username    text        not null check (char_length(username) between 1 and 32),
  kind        text        not null check (kind in ('clear','raise','lower','pave','workshop','cottage','field','assist')),
  x           int         not null check (x >= 0 and x < 64),
  y           int         not null check (y >= 0 and y < 64),
  payload     jsonb       not null default '{}'::jsonb,
  assisted_by uuid        references auth.users(id) on delete set null,       -- who is speeding THIS job (assist), if anyone
  started_at  timestamptz not null default now(),
  ready_at    timestamptz not null
);
create index if not exists guild_estate_jobs_guild_idx on public.guild_estate_jobs (guild_id);

alter table public.guild_estate_jobs enable row level security;
-- Members may READ their guild's jobs (the client renders every member's in-progress task). All WRITES go
-- through the RPCs below, which is what keeps ready_at server-computed and un-restartable.
drop policy if exists guild_estate_jobs_read on public.guild_estate_jobs;
create policy guild_estate_jobs_read on public.guild_estate_jobs
  for select to authenticated using (guild_id = (select guild_id from public.guild_members where user_id = auth.uid()));
revoke insert, update, delete on public.guild_estate_jobs from anon, authenticated;

-- Live updates so a member sees others' jobs start/finish without polling (matches the guild_estate blob).
do $$ begin alter publication supabase_realtime add table public.guild_estate_jobs; exception when duplicate_object then null; end $$;

-- Row shape the client consumes. Includes owner + ownerName (the guild view shows WHOSE job each is);
-- times go out as epoch ms to match the client's Date.now() math. Mirrors estate_job_row.
create or replace function public.guild_estate_job_row(r public.guild_estate_jobs)
returns jsonb language sql stable as $$
  select case when r.user_id is null then null else jsonb_build_object(
    'kind',           r.kind,
    'x',              r.x,
    'y',              r.y,
    'payload',        r.payload,
    'owner',          r.user_id,
    'ownerName',      r.username,
    -- assist bookkeeping the client renders: who's speeding this job, and (for an assist job) whose it helps.
    'assistedBy',     r.assisted_by,
    'assistedByName', (select gm.username from public.guild_members gm where gm.user_id = r.assisted_by),
    'assistOf',       r.payload->>'assistOf',
    'assistOfName',   r.payload->>'assistOfName',
    'startAt',        (extract(epoch from r.started_at) * 1000)::bigint,
    'readyAt',        (extract(epoch from r.ready_at)   * 1000)::bigint
  ) end;
$$;

-- The caller's guild (from membership; never a client arg). Null if not in a guild.
create or replace function public.guild_estate_my_guild()
returns uuid language sql stable security definer set search_path = public as $$
  select guild_id from public.guild_members where user_id = auth.uid();
$$;

-- Every active job for the caller's guild (all members), for the shared-grid view.
create or replace function public.guild_estate_job_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g uuid; v_jobs jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  g := public.guild_estate_my_guild();
  if g is null then return jsonb_build_object('ok', false, 'error', 'noguild'); end if;
  select coalesce(jsonb_agg(public.guild_estate_job_row(j)), '[]'::jsonb) into v_jobs
    from public.guild_estate_jobs j where j.guild_id = g;
  return jsonb_build_object('ok', true, 'jobs', v_jobs);
end $$;

-- Atomic claim for the caller in their guild. Sentinel: an existing job is authoritative and untouchable
-- (finished -> 'pending'; still running -> handed back unchanged, claimed=false) so a refire can neither
-- restart the clock nor start a second task. ready_at is server-clocked from the canonical duration table.
-- ('assist' is NOT started here -- it goes through guild_estate_job_assist below, which also speeds the
-- helped job.)
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

-- Assist: the caller (who must be free) speeds a teammate's still-running job -- halves its remaining time
-- ONCE (a job can only be assisted by one member), and gives the caller a matching 'assist' job that ends
-- when the helped job does. Both the target update and the assist insert happen in one transaction, and
-- the row lock on the target serialises concurrent assisters so only the first wins.
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

-- Release the caller's job once the SERVER clock passes ready_at (the actual cooldown gate).
create or replace function public.guild_estate_job_complete()
returns jsonb language plpgsql security definer set search_path = public as $$
declare done public.guild_estate_jobs; cur public.guild_estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  delete from public.guild_estate_jobs where user_id = auth.uid() and ready_at <= now() returning * into done;
  if done.user_id is not null then
    return jsonb_build_object('ok', true, 'job', public.guild_estate_job_row(done));
  end if;
  select * into cur from public.guild_estate_jobs where user_id = auth.uid();
  if cur.user_id is null then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  return jsonb_build_object('ok', false, 'error', 'early', 'job', public.guild_estate_job_row(cur));
end $$;

create or replace function public.guild_estate_job_cancel()
returns jsonb language plpgsql security definer set search_path = public as $$
declare gone public.guild_estate_jobs;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  delete from public.guild_estate_jobs where user_id = auth.uid() returning * into gone;
  if gone.user_id is null then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  -- Cancelling an ASSIST releases the helped job so it can be assisted again (its already-halved time
  -- stands, matching the client). Compare as text to avoid a bad-uuid cast on a tampered payload.
  if gone.kind = 'assist' then
    update public.guild_estate_jobs set assisted_by = null
      where guild_id = gone.guild_id and user_id::text = (gone.payload->>'assistOf') and assisted_by = auth.uid();
  end if;
  return jsonb_build_object('ok', true, 'job', public.guild_estate_job_row(gone));
end $$;

-- Client-callable (identity from auth.uid(), no caller-supplied identity), like the personal estate RPCs.
revoke execute on function public.guild_estate_job_get()                     from public, anon;
revoke execute on function public.guild_estate_job_start(text,int,int,jsonb) from public, anon;
revoke execute on function public.guild_estate_job_assist(uuid)              from public, anon;
revoke execute on function public.guild_estate_job_complete()                from public, anon;
revoke execute on function public.guild_estate_job_cancel()                  from public, anon;
grant  execute on function public.guild_estate_job_get()                     to authenticated;
grant  execute on function public.guild_estate_job_start(text,int,int,jsonb) to authenticated;
grant  execute on function public.guild_estate_job_assist(uuid)              to authenticated;
grant  execute on function public.guild_estate_job_complete()                to authenticated;
grant  execute on function public.guild_estate_job_cancel()                  to authenticated;
-- Internal helpers: never called directly by a client.
revoke execute on function public.guild_estate_my_guild()                       from public, anon, authenticated;
revoke execute on function public.guild_estate_job_row(public.guild_estate_jobs) from public, anon, authenticated;

-- Orphan reaper: when a member leaves or is kicked (their guild_members row is deleted), drop any
-- landscaping job they had so it can't linger on the shared grid (the server-side equivalent of the
-- client's reapOrphanGuildEstateJobs). A finished-but-uncollected orphan simply clears.
create or replace function public.guild_estate_jobs_reap_on_leave()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.guild_estate_jobs where user_id = old.user_id;
  return old;
end $$;
drop trigger if exists guild_estate_jobs_reap on public.guild_members;
create trigger guild_estate_jobs_reap after delete on public.guild_members
  for each row execute function public.guild_estate_jobs_reap_on_leave();
