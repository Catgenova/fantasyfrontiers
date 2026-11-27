-- Over-100 Mastery on the leaderboard: store each profile's DISPLAY-ONLY map of gathering/crafting
-- skills that have leveled past 100 ({ skill_id: extended_level }). Kept SEPARATE from `skills` so
-- total_level / ranking / the dungeon gate stay on the capped 1..100 values -- this column only lets the
-- profile view SHOW the true over-100 level. Client-authoritative + cosmetic, written only by
-- submit_profile. No RLS change (profiles is already publicly readable for the leaderboard).
alter table public.profiles add column if not exists mastery jsonb;
