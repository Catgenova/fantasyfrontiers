-- ============================================================================
-- ACCOUNT CLAMPS — quarantine an exploiting account from the SHARED surfaces (marketplace, leaderboard,
-- guild, chat) while leaving its private single-player sandbox untouched. This is the "contain the blast
-- radius" answer to an inherently un-verifiable client save: we don't try to prove the save honest, we
-- make sure a dishonest one can never touch another player. A clamped account keeps playing; it just can't
-- reach anything that crosses into someone else's experience.
--
-- Enforcement lives in the DATABASE + the surface edge functions, never the client:
--   * chat        -> RLS teeth on messages_insert (mirrors the chat-mute clause)
--   * leaderboard -> the public view filters clamped players out of every ranking read
--   * marketplace -> a 403 gate in the marketplace edge function        (PHASE 2, separate deploy)
--   * guild       -> a 403 gate in the guild_* edge functions           (PHASE 2, separate deploy)
-- All four read the single SECURITY DEFINER helper is_clamped(uid, surface).
--
-- The clamp list is OWNER-ONLY and PRIVATE (unlike chat_mutes, which is public for badges): nobody can
-- scrape "who's flagged", and it leaves room for a silent/shadow mode later. The owner reads + reverses it
-- from Settings > Moderation (clamp_list / clamp_set / clamp_clear); auto-detection (PHASE 4) writes rows
-- with the service role.
--
-- Deploy-safe & additive: the client swallows a missing clamp_list RPC (the Moderation section just stays
-- empty), and nothing here revokes an existing grant. After PHASE 1 lands, the chat + leaderboard gates are
-- live; marketplace + guild gates arrive with the PHASE 2 edge-function deploy.
-- ============================================================================

-- ---- The clamp table. PRIVATE: no select to anon/authenticated. Reads go through the definer helper /
-- ---- the owner-only RPCs below. Writes are owner RPCs (manual) or the service role (auto-detection). ----
create table if not exists public.account_clamps (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  surfaces      text[]      not null default '{marketplace,leaderboard,guild,chat}',
  clamped_until timestamptz not null,          -- far-future = indefinite (a ~10y cap, same as chat_mutes)
  reason        text,                          -- owner's note (manual clamps)
  auto          boolean     not null default false,   -- true = tripped by a detector, false = owner did it by hand
  signal        jsonb,                         -- detector evidence (what invariant broke), for auto clamps
  clamped_by    uuid references auth.users(id) on delete set null,  -- null = system / auto
  clamped_at    timestamptz not null default now()
);
alter table public.account_clamps enable row level security;
-- No policies + no grants = only the service role (and the definer functions below) can touch it.
revoke all on public.account_clamps from anon, authenticated;

-- ---- The single point of truth every gate calls. SECURITY DEFINER so it can read the private table from
-- ---- inside RLS policies and the leaderboard view without exposing the table itself. ----
create or replace function public.is_clamped(p_user uuid, p_surface text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.account_clamps c
    where c.user_id = p_user
      and p_surface = any(c.surfaces)
      and c.clamped_until > now()
  );
$$;
-- Callable by anon + authenticated: the leaderboard view (anon-readable) and the chat RLS (authenticated)
-- both reference it. It only ever returns a boolean, and a probe needs a uid you already have.
grant execute on function public.is_clamped(uuid, text) to anon, authenticated;

-- ---- CHAT teeth: re-create the messages_insert policy (from 20260708120000 / 20260724190000) with an
-- ---- extra clamp clause. Everything else -- the identity + trusted-username + mute checks -- is unchanged,
-- ---- so a normal send is unaffected; a clamped send fails at the database no matter what client is used. ----
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
    and not exists (select 1 from public.chat_mutes m where m.user_id = auth.uid() and m.muted_until > now())
    and not public.is_clamped(auth.uid(), 'chat')
  );

-- ---- LEADERBOARD gate: re-create the public view (unchanged column list -> safe replace, no 42P16) with a
-- ---- filter that drops clamped players from every ranking read. Uses the definer helper, so the private
-- ---- clamp table stays private. submit_profile additionally skips the public write for a clamped player
-- ---- (PHASE 2), so their tampered stats never even land -- this view filter is the belt to that suspenders. ----
create or replace view public.leaderboard with (security_invoker = on) as
  select id, username, total_level, gold, skills, mastery, equipment, stats, mortal, class, has_estate, updated_at, title
  from public.profiles
  where not public.is_clamped(id, 'leaderboard');
grant select on public.leaderboard to anon, authenticated;

-- ---- Owner-only: apply a clamp. Mirrors chat_mute -- caller must be the chat owner, target can't be the
-- ---- owner or self. p_minutes null/huge = indefinite. Unknown surfaces are dropped; empty = error. ----
create or replace function public.clamp_set(p_target uuid, p_surfaces text[], p_minutes bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_until timestamptz; v_surf text[];
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_target is null or p_target = auth.uid() then return jsonb_build_object('ok', false, 'error', 'target'); end if;
  if public.is_chat_owner(p_target) then return jsonb_build_object('ok', false, 'error', 'owner'); end if;
  -- Keep only known surfaces; default to all four when none/blank supplied.
  select array_agg(s) into v_surf
    from unnest(coalesce(p_surfaces, array['marketplace','leaderboard','guild','chat'])) s
    where s in ('marketplace','leaderboard','guild','chat');
  if v_surf is null then return jsonb_build_object('ok', false, 'error', 'surface'); end if;
  if p_minutes is null or p_minutes <= 0 then p_minutes := 5256000; end if;   -- default indefinite
  v_until := now() + (least(p_minutes, 5256000) || ' minutes')::interval;      -- cap ~10 years
  insert into public.account_clamps (user_id, surfaces, clamped_until, reason, auto, signal, clamped_by)
    values (p_target, v_surf, v_until, nullif(left(coalesce(p_reason, ''), 200), ''), false, null, auth.uid())
    on conflict (user_id) do update set
      surfaces = excluded.surfaces, clamped_until = excluded.clamped_until, reason = excluded.reason,
      auto = false, signal = null, clamped_by = auth.uid(), clamped_at = now();
  return jsonb_build_object('ok', true, 'until', (extract(epoch from v_until) * 1000)::bigint);
end $$;

-- ---- Owner-only: lift a clamp (the panel's one-click "Unclamp"). Restores all four surfaces at once. ----
create or replace function public.clamp_clear(p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_target is null then return jsonb_build_object('ok', false, 'error', 'target'); end if;
  delete from public.account_clamps where user_id = p_target;
  return jsonb_build_object('ok', true);
end $$;

-- ---- Owner-only: the clamp roster for the Moderation panel, with usernames joined in (the table is
-- ---- private, so this definer read is the only way the client sees it). Active clamps only. ----
create or replace function public.clamp_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_arr jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', c.user_id,
      'username', p.username,
      'surfaces', to_jsonb(c.surfaces),
      'reason', c.reason,
      'auto', c.auto,
      'signal', c.signal,
      'clamped_until', (extract(epoch from c.clamped_until) * 1000)::bigint,
      'clamped_at', (extract(epoch from c.clamped_at) * 1000)::bigint
    ) order by c.clamped_at desc), '[]'::jsonb)
    into v_arr
    from public.account_clamps c
    left join public.profiles p on p.id = c.user_id
    where c.clamped_until > now();
  return jsonb_build_object('ok', true, 'clamps', v_arr);
end $$;

-- Client-callable owner RPCs self-authorize from auth.uid(); the internal helper stays off client roles
-- except the anon/authenticated execute it needs for the view + RLS references above.
do $$
declare fn text; fns text[] := array[
  'public.clamp_set(uuid, text[], bigint, text)',
  'public.clamp_clear(uuid)',
  'public.clamp_list()'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant  execute on function %s to authenticated', fn);
  end loop;
end $$;
