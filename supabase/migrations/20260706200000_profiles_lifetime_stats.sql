-- Leaderboard filters: store each player's lifetime stats on their public profile so the
-- board can be ranked by them (kills, deaths, items gathered/crafted, rarity crafts).
-- Written only by submit_profile (the profiles table isn't client-writable). Cosmetic /
-- self-reported like the rest of the profile, so it's bounded but not rate-limited.
alter table public.profiles add column if not exists stats jsonb not null default '{}'::jsonb;
