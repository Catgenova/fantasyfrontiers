-- ============================================================================
-- LEADERBOARD VIEW: tower + classes columns, WITH the clamp filter (v0.1.4.19 era, 2026-10-08).
--
-- Why this exists. 20260724210000_account_clamps.sql gave the public `leaderboard` view a WHERE clause
-- (`not public.is_clamped(id, 'leaderboard')`) so a clamped account drops off every board. The later
-- 20260831120000_profile_tower.sql recreated the view to append `tower` and was drafted from the
-- 20260724200000 shape, so it DROPPED that clause: applied as written, every clamped account comes back
-- onto the boards. This migration is the one to apply for the Tower / Class Tower boards; it carries the
-- filter and appends `classes` as well (the Firsts boards' column, 20260917120000) so the projection is
-- complete in one place. `create or replace view` may only APPEND columns, so the order is the historical
-- one plus `tower`, then `classes`; the client selects by name.
--
-- Idempotent: every statement is add-if-missing or replace. Safe to run on a project that already has
-- some of these pieces. The Tower boards need THREE things to show numbers:
--   1. this migration (columns + view),
--   2. the `submit_profile` edge function from the repo (it writes `tower` and `classes`, and retries
--      WITHOUT them on a project that lacks the columns, which is why a missing column reads as empty
--      boards rather than a broken profile push),
--   3. players republishing their profile (any login / profile submit after 1 and 2 land).
-- ============================================================================

alter table public.profiles add column if not exists tower   jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists classes jsonb not null default '{}'::jsonb;

create or replace view public.leaderboard with (security_invoker = on) as
  select id, username, total_level, gold, skills, mastery, equipment, stats, mortal, class, has_estate,
         updated_at, title, tower, classes
  from public.profiles
  where not public.is_clamped(id, 'leaderboard');

grant select on public.leaderboard to anon, authenticated;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='profiles' and column_name in ('tower','classes');  -- expect 2 rows
--   select tower, classes from public.leaderboard limit 1;                                             -- selects without error
--   select pg_get_viewdef('public.leaderboard'::regclass, true);                                        -- shows the is_clamped clause
--   select username, tower from public.profiles where tower <> '{}'::jsonb order by updated_at desc limit 5;
--     -- rows appear as players republish; empty means step 2 or 3 above has not happened yet
-- ----------------------------------------------------------------------------
