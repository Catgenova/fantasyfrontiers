-- ============================================================================
-- PUBLISH TITLES — expose each player's equipped Title so it shows on their public profile card and next
-- to their name in global chat. Cosmetic + client-authoritative (like `class`): a bounded slug or null.
--
-- Deploy-safe: adds a nullable column and widens the public leaderboard projection (never revokes). Titles
-- are written by the submit_profile edge function (validated) on the player's next profile sync, so existing
-- players' titles simply populate over time; nothing breaks before the function redeploys.
-- ============================================================================

alter table public.profiles add column if not exists title text;

-- Recreate the public leaderboard view WITH the title column (mirrors 20260716210000_leaderboard_view.sql,
-- same security_invoker projection, plus `title`). Still never exposes the heavy `estate` blob.
create or replace view public.leaderboard with (security_invoker = on) as
  select id, username, total_level, gold, skills, mastery, equipment, stats, mortal, class, has_estate, title, updated_at
  from public.profiles;
grant select on public.leaderboard to anon, authenticated;
