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
-- PHASE 2 (run only AFTER the new client has fully rolled out -- see the revoke block shipped separately):
--   revoke select on public.profiles from anon, authenticated;   -- locks the base table to the service role
-- Until then, set Dashboard -> Settings -> API -> Max Rows to a small cap (~100) for immediate mitigation.

-- Bounded public projection. A SECURITY DEFINER view (the default): it reads profiles as the view owner,
-- so it keeps serving the leaderboard after the base table is later locked to the service role, while
-- exposing ONLY these columns -- never the estate blob.
create or replace view public.leaderboard as
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
