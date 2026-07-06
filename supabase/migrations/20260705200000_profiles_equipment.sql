-- Store each player's currently-equipped weapons + armor (not tools) on their public
-- profile, so the leaderboard's "view player" panel can show their loadout. Written only
-- by the submit_profile function (which sanitizes it); read publicly like the rest of the
-- profile. Display-side escapes all strings, so this never becomes trusted HTML.
alter table public.profiles add column if not exists equipment jsonb;
