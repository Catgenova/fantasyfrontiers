-- Leaderboard class icon: store each profile's currently-equipped Class id (a bounded slug like
-- 'herald', or NULL when no Class is active). Client-authoritative, written only by submit_profile;
-- the client maps it to an SVG icon (unknown/NULL -> a neutral figure). No RLS change needed.
alter table public.profiles add column if not exists class text;
