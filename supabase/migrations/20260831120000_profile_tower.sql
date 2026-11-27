-- ============================================================================
-- TOWER LEADERBOARDS (v0.0.102.12).
--
-- The Tower has one All-Classes entrance plus one entrance per Class, and each player's save tracks the
-- deepest floor they've reached per entrance (state.tower[<id>].best). This exposes those figures so the
-- leaderboard can rank a Tower climb: an "All Classes" board and one board per Class tower.
--
-- Storage: a single compact `tower` jsonb map { "<entranceId>": <bestFloor>, ... } on the profile, keyed by
-- 'all' or a class-id slug. submit_profile writes it (bounded, cosmetic + client-authoritative like stats);
-- the client reads it from the `leaderboard` view and ranks client-side, exactly like the skill/stat boards.
--
-- Deploy-safe: adds a nullable-with-default column and WIDENS the public leaderboard projection (never
-- revokes). The client selects `tower` by name with a fallback that omits it, so deploy order can't break the
-- board -- Tower boards simply read empty until this lands and clients republish their profiles.
-- ============================================================================

alter table public.profiles add column if not exists tower jsonb not null default '{}'::jsonb;

-- Recreate the public leaderboard view WITH the tower column. `create or replace view` can only APPEND a
-- column at the END of the select list (reordering/renaming raises 42P16), so tower goes last after title.
-- The client selects by name, so column order is irrelevant. security_invoker stays on (respects RLS; no
-- "Security Definer View" advisor warning). Mirrors 20260724200000_profile_title.sql's widen.
create or replace view public.leaderboard with (security_invoker = on) as
  select id, username, total_level, gold, skills, mastery, equipment, stats, mortal, class, has_estate, updated_at, title, tower
  from public.profiles;

grant select on public.leaderboard to anon, authenticated;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='profiles' and column_name='tower';   -- expect 1 row
--   select tower from public.leaderboard limit 1;                                        -- selects without error
-- ----------------------------------------------------------------------------
