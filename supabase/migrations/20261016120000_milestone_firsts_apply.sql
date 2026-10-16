-- ============================================================================
-- FIRSTS BOARDS: the complete, re-runnable apply (2026-10-16, ticket-0250).
--
-- The Firsts panel ("who got there first") read "Checking who got there first" for everyone because the
-- RPC it calls, public.milestone_firsts, was never on the project: 20260917120000_milestone_firsts.sql
-- had not been applied. This file is that migration's whole body, made safe to paste over a project in
-- ANY state (nothing here fails if it already ran), with two additions:
--   1. the `tower` column alongside `classes` (20260831120000 / 20261008120000 add it; the stamp trigger
--      reads BOTH, so a project that skipped those would otherwise fail on the first profile write);
--   2. the clamp clause: a clamped account drops off the Firsts exactly as it drops off the ranked view
--      (20260724210000's rule), filtered BEFORE ranking so it does not hold a place either.
-- Thresholds are the client's FIRSTS_* tables verbatim (index.html); change both sides or neither.
--
-- Paste the whole file into the Supabase SQL editor and run it once. Then run the VERIFY block.
-- The client needs nothing else: it reads milestone_firsts(3) and lists the unclaimed marks itself.
-- ============================================================================

-- The two profile columns the stamp reads (cosmetic, bounded by submit_profile).
alter table public.profiles add column if not exists tower   jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists classes jsonb not null default '{}'::jsonb;

-- Write-once stamps: the first time a profile crosses a mark is the time that counts.
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
-- (FIRSTS_* in index.html). Keys are charset-checked: an id that is not [A-Za-z0-9_] never becomes a key.
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

-- Backfill: what already stands past a mark is HELD, not won (shown as "held before the board opened").
-- Re-running this is harmless: the conflict clause leaves every existing stamp alone.
insert into public.milestones (user_id, key, username, reached_at, backfilled)
  select p.id, mk, p.username, p.updated_at, true
    from public.profiles p,
         lateral public.milestone_keys_for(p.total_level, p.skills, p.mastery, p.tower, p.classes) as mk
on conflict (user_id, key) do nothing;

-- The read: the first N holders of every key, in the order they got there, clamped accounts excluded
-- before ranking. One call fills the whole Firsts panel.
create or replace function public.milestone_firsts(p_limit int default 3)
returns table (key text, rank int, user_id uuid, username text, reached_at timestamptz, backfilled boolean)
language sql stable security definer set search_path = public as $$
  select x.key, x.rank::int, x.user_id, x.username, x.reached_at, x.backfilled
    from (
      select m.*, row_number() over (partition by m.key order by m.reached_at, m.user_id) as rank
        from public.milestones m
       where not public.is_clamped(m.user_id, 'leaderboard')
    ) x
   where x.rank <= greatest(1, least(coalesce(p_limit, 3), 10))
   order by x.key, x.rank
$$;
revoke execute on function public.milestone_firsts(int) from public;
grant execute on function public.milestone_firsts(int) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select count(*) from public.milestones;                                  -- the backfill landed (> 0 on a live project)
--   select * from public.milestone_firsts(3) limit 10;                      -- selects without error, rows per key
--   select public.milestone_keys_for(1000, '{"mining":100}', '{"mining":120}', '{"all":100}', '{"knight":50}');
--     -- expect: total_500, total_1000, skill_mining_100, skill_mining_120, tower_all_25 ... tower_all_100, class_knight_50
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='profiles' and column_name in ('tower','classes');   -- expect 2 rows
--   select tgname from pg_trigger where tgname = 'profiles_milestones';                                -- expect 1 row
-- If count(*) is 0 on a live project, profiles exist but none has crossed a mark yet; the board shows
-- every line as "Unclaimed" until the next profile publish crosses one.
-- ----------------------------------------------------------------------------
