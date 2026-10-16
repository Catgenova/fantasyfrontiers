-- ============================================================================
-- FIRSTS BOARDS, read filter (2026-10-16, ticket-0250 retest: "only classes are working").
--
-- After 20261016120000 landed, the Classes board filled and Total Level, Tower and Skills stayed
-- "Unclaimed". The cause is volume, not stamping: the profile's `skills` map carries EVERY xp key the client
-- tracks (gathering and crafting skills, but also weapon proficiencies, styles, physiques, attunements),
-- so a maxed account stamps hundreds of skill_* marks, and milestone_firsts(3) returned more rows than
-- PostgREST's 1,000-row reply cap. The reply is ordered by key, so class_* survived in full, the first
-- slice of skill_* followed, and total_* / tower_* never arrived. (Verify: the count below exceeds 1000.)
--
-- Fix: the RPC takes the exact keys the panel lists (p_keys) and filters BEFORE ranking, so the reply is
-- bounded by the client's own threshold tables (~280 keys x 3 holders). The one-argument signature is
-- DROPPED rather than overloaded: two candidates with defaults make PostgREST's named-argument resolution
-- ambiguous. A client that still calls with p_limit alone resolves to this function with p_keys null,
-- which is the old unfiltered behaviour (the client also reads the reply in pages now).
-- Paste the whole file into the Supabase SQL editor and run it once.
-- ============================================================================

drop function if exists public.milestone_firsts(int);

create or replace function public.milestone_firsts(p_limit int default 3, p_keys text[] default null)
returns table (key text, rank int, user_id uuid, username text, reached_at timestamptz, backfilled boolean)
language sql stable security definer set search_path = public as $$
  select x.key, x.rank::int, x.user_id, x.username, x.reached_at, x.backfilled
    from (
      select m.*, row_number() over (partition by m.key order by m.reached_at, m.user_id) as rank
        from public.milestones m
       where (p_keys is null or m.key = any(p_keys))
         and not public.is_clamped(m.user_id, 'leaderboard')
    ) x
   where x.rank <= greatest(1, least(coalesce(p_limit, 3), 10))
   order by x.key, x.rank
$$;
revoke execute on function public.milestone_firsts(int, text[]) from public;
grant execute on function public.milestone_firsts(int, text[]) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select count(*) from public.milestone_firsts(3);                                   -- the unfiltered size; > 1000 is the bug
--   select count(*) from public.milestone_firsts(3, array['total_500','tower_all_25','skill_mining_100']);
--     -- at most 9 rows, and > 0 on a live project where anyone has crossed those marks
--   select key, username from public.milestone_firsts(3, array['total_500']);         -- the first three past Total Level 500
-- ----------------------------------------------------------------------------
