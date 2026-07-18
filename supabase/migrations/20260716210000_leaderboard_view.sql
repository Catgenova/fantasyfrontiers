-- Least-privilege hardening of the public leaderboard read.
--
-- Context: a pentest flagged /rest/v1/profiles as "excessive data return / BOLA". The profiles row is
-- deliberately PUBLIC leaderboard data (username/level/skills/class/stats -- no PII, no credentials; email
-- + auth live in a non-readable table), so cross-player reads are the FEATURE, not a leak. But the base
-- table let any authenticated user bulk-read every column -- including the large per-player `estate` jsonb
-- -- which is a scraping / cost vector as the playerbase grows.
--
-- This migration adds the bounded read paths WITHOUT breaking the currently-deployed client (it adds, never
-- revokes):
--   * `leaderboard` view        -- the explicit public projection: all display columns EXCEPT the heavy estate.
--   * `get_profile_estate(id)`  -- one player's estate on demand (scalar => can't be bulk-scraped).
-- The client is repointed at these (with a fallback to the base table so deploy order doesn't matter).
--
-- PHASE 2 (run only AFTER the new client has fully rolled out):
--   revoke select (estate) on public.profiles from anon, authenticated;  -- hides the heavy estate blob from
--   direct/bulk reads. Leaderboard columns stay public BY DESIGN; the estate RPC still serves it one row at
--   a time. (Column-level, not a full-table revoke, so the security_invoker view below keeps working.)
-- Until then, set Dashboard -> Project Settings -> API -> Max Rows to a small cap (~100) for immediate mitigation.

-- Bounded public projection: the leaderboard/profile-card columns, never the estate blob. `security_invoker`
-- so it runs with the CALLER's privileges (respects RLS -> no "Security Definer View" advisor warning);
-- callers keep direct select on these public columns, so Phase 2 only needs to revoke the estate column.
create or replace view public.leaderboard with (security_invoker = on) as
  select id, username, total_level, gold, skills, mastery, equipment, stats, mortal, class, has_estate, updated_at
  from public.profiles;

-- One player's estate, on demand (the "Visit Estate" button), instead of a bulk-readable column. Scalar
-- return + SECURITY DEFINER so it still works once the estate column is locked down; one row per call.
create or replace function public.get_profile_estate(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select estate from public.profiles where id = p_id $$;

grant select on public.leaderboard to anon, authenticated;
grant execute on function public.get_profile_estate(uuid) to anon, authenticated;
