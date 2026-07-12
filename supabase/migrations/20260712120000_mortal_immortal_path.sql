-- ============================================================================
-- MORTAL / IMMORTAL PATH
--
-- Players choose a path once, right after registration:
--   * Immortal (default) — standard play; death only sends you back to recover.
--   * Mortal — a single life. On death the profile reverts to Immortal, the player
--     leaves any Mortal guild, and their leaderboard styling drops back to normal.
--
-- The path is CLIENT-AUTHORITATIVE, consistent with the rest of the game's progress
-- model (XP, gold, etc. are all computed client-side). These columns just persist the
-- self-declared value so the leaderboard can style/filter it and guilds can segregate
-- Mortal vs Immortal membership. Both columns are written only by the service-role edge
-- functions (submit_profile, guild_action); no new RLS policy is needed because the
-- existing public-read policies already expose whole rows.
-- ============================================================================

-- Leaderboard: bold-maroon Mortal names + a "Mortals only" filter read this flag.
alter table public.profiles
  add column if not exists mortal boolean not null default false;

-- Guilds: a Mortal guild accepts only Mortal members and keeps no shared bank.
alter table public.guilds
  add column if not exists mortal boolean not null default false;

-- Browsing the guild list filters by this flag, so index it for the equality scan.
create index if not exists guilds_mortal_open_idx on public.guilds (mortal, open);
