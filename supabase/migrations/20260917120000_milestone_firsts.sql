-- ============================================================================
-- FIRSTS: the milestone race boards (v0.1.4.0, owner order 2026-09-17).
--
-- "Leaderboard showing first to get 100 or 120 or some number to set a goal for creeps like me."
-- A Firsts board is a MILESTONE, not a ranking: who reached it first, second, third, and an Unclaimed line for
-- the marks nobody has hit yet. Four families, all chosen by the owner: Total Level marks, Tower floors (the
-- All-Classes climb and each Class tower), skill Level 100 / 120 / 150 / 200 (mastery past 100 counts), and
-- Class levels 50 / 100.
--
-- TRUST: stamps are made HERE, by a trigger on public.profiles, from the row submit_profile has already
-- validated and rate-clamped. Nothing the client sends names a milestone; it can only move its profile, and
-- the profile is exactly as trustworthy as the ranked leaderboard already is. A stamp is write-once per
-- (user, key): the first time the row crosses a mark is the time that counts, and a later drop (a Mortal
-- death, a rollback) never un-stamps it.
--
-- BACKFILL: profiles that already stand past a mark when this lands are stamped with backfilled = true and
-- their profile's updated_at. Those rows are shown as "held before the board opened", not as a race won:
-- there is no honest way to order who got there first before anyone was counting.
--
-- CLASS LEVELS are not in the submitted skills map (that map is the ranked total), so profiles gains a
-- compact, cosmetic `classes` jsonb { classId: level } written by submit_profile, bounded like `tower`.
--
-- Deploy-safe: adds a nullable-with-default column, a new table, a trigger and a read RPC. Nothing is
-- revoked. The client reads the RPC and falls back to an empty board if it is absent.
-- ============================================================================

alter table public.profiles add column if not exists classes jsonb not null default '{}'::jsonb;

create table if not exists public.milestones (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  username   text        not null,
  reached_at timestamptz not null default now(),
  backfilled boolean     not null default false,
  primary key (user_id, key)
);
create index if not exists milestones_key_reached_idx on public.milestones (key, reached_at);

alter table public.milestones enable row level security;
drop policy if exists milestones_read on public.milestones;
create policy milestones_read on public.milestones for select using (true);
grant select on public.milestones to anon, authenticated;

-- Every milestone key a profile row currently satisfies. Pure; the SAME thresholds the client lists
-- (FIRSTS_* in index.html), so the two cannot disagree about what a board is. Keys are charset-checked:
-- a skill/class/entrance id that is not [A-Za-z0-9_] never becomes a key.
create or replace function public.milestone_keys_for(
  p_total int, p_skills jsonb, p_mastery jsonb, p_tower jsonb, p_classes jsonb
) returns setof text language plpgsql immutable as $$
declare
  k text; v numeric; t int; lvl int;
begin
  foreach t in array array[500,1000,2000,3000,5000,7500,10000,12500,15000] loop
    if coalesce(p_total, 0) >= t then return next 'total_' || t; end if;
  end loop;
  if p_skills is not null and jsonb_typeof(p_skills) = 'object' then
    for k, v in select key, (value)::text::numeric from jsonb_each(p_skills) where jsonb_typeof(value) = 'number' loop
      if k !~ '^[A-Za-z0-9_]{1,40}$' then continue; end if;
      lvl := greatest(v, coalesce(nullif(p_mastery->>k, '')::numeric, 0))::int;   -- mastery past 100 rides along
      foreach t in array array[100,120,150,200] loop
        if lvl >= t then return next 'skill_' || k || '_' || t; end if;
      end loop;
    end loop;
  end if;
  if p_tower is not null and jsonb_typeof(p_tower) = 'object' then
    for k, v in select key, (value)::text::numeric from jsonb_each(p_tower) where jsonb_typeof(value) = 'number' loop
      if k !~ '^[A-Za-z0-9_]{1,40}$' then continue; end if;
      foreach t in array array[25,50,75,100,120,150,200,250,300,400,500] loop
        if v >= t then return next 'tower_' || k || '_' || t; end if;
      end loop;
    end loop;
  end if;
  if p_classes is not null and jsonb_typeof(p_classes) = 'object' then
    for k, v in select key, (value)::text::numeric from jsonb_each(p_classes) where jsonb_typeof(value) = 'number' loop
      if k !~ '^[A-Za-z0-9_]{1,40}$' then continue; end if;
      foreach t in array array[50,100] loop
        if v >= t then return next 'class_' || k || '_' || t; end if;
      end loop;
    end loop;
  end if;
  return;
end $$;

-- Stamp on every accepted profile write. Write-once per (user, key); the username is kept current so a
-- rename shows on the board.
create or replace function public.milestones_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.milestones (user_id, key, username, reached_at)
    select new.id, mk, new.username, now()
      from public.milestone_keys_for(new.total_level, new.skills, new.mastery, new.tower, new.classes) as mk
  on conflict (user_id, key) do nothing;
  update public.milestones set username = new.username
    where user_id = new.id and username is distinct from new.username;
  return new;
end $$;
drop trigger if exists profiles_milestones on public.profiles;
create trigger profiles_milestones
  after insert or update on public.profiles
  for each row execute function public.milestones_stamp();

-- Backfill: what already stands past a mark is HELD, not won (see the header).
insert into public.milestones (user_id, key, username, reached_at, backfilled)
  select p.id, mk, p.username, p.updated_at, true
    from public.profiles p,
         lateral public.milestone_keys_for(p.total_level, p.skills, p.mastery, p.tower, p.classes) as mk
on conflict (user_id, key) do nothing;

-- The read: the first N holders of every key, in the order they got there. One call fills the whole
-- Firsts panel; the client lists the unclaimed marks itself from the same threshold tables.
create or replace function public.milestone_firsts(p_limit int default 3)
returns table (key text, rank int, user_id uuid, username text, reached_at timestamptz, backfilled boolean)
language sql stable security definer set search_path = public as $$
  select x.key, x.rank::int, x.user_id, x.username, x.reached_at, x.backfilled
    from (
      select m.*, row_number() over (partition by m.key order by m.reached_at, m.user_id) as rank
        from public.milestones m
    ) x
   where x.rank <= greatest(1, least(coalesce(p_limit, 3), 10))
   order by x.key, x.rank
$$;
revoke execute on function public.milestone_firsts(int) from public;
grant execute on function public.milestone_firsts(int) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select count(*) from public.milestones;                                  -- the backfill landed (>= 0)
--   select * from public.milestone_firsts(3) limit 10;                      -- selects without error
--   select public.milestone_keys_for(1000, '{"mining":100}', '{"mining":120}', '{"all":100}', '{"knight":50}');
--     -- expect: total_500, total_1000, skill_mining_100, skill_mining_120, tower_all_25 ... tower_all_100, class_knight_50
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='profiles' and column_name='classes';   -- expect 1 row
-- ----------------------------------------------------------------------------
