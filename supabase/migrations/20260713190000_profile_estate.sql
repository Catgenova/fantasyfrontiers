-- Visitable estates: store each profile's public, render-only estate snapshot so other players can
-- view it read-only from the leaderboard ("Visit Estate"). Client-authoritative, written only by
-- submit_profile (size-capped there); the viewer reads grid geometry + placements to draw the canvas.
-- No RLS change needed -- profiles is already publicly readable for the leaderboard.
alter table public.profiles add column if not exists estate jsonb;

-- Lightweight presence flag so the leaderboard list can decide whether to show the "Visit Estate"
-- button WITHOUT pulling the full (tens-of-KB) estate blob for every ranked row. Generated + stored,
-- so it stays in sync automatically and costs one boolean per row to select.
alter table public.profiles
  add column if not exists has_estate boolean generated always as (estate is not null) stored;
