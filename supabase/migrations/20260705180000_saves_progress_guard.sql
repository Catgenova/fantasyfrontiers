-- Cloud-save v2: guard writes by a monotonic PROGRESS score instead of wall-clock time.
-- The v1 timestamp guard let an empty newGame() (whose lastSaved=now was "newest")
-- overwrite real cloud saves. progress = total XP; save_game now rejects any write whose
-- progress is LESS than what's stored (unless force), so an empty/regressed state can
-- never clobber real progress.
alter table public.saves add column if not exists progress bigint not null default 0;

-- Backfill progress for existing rows from their stored data (sum of xp + physique),
-- mirroring the client's saveProgressScore(). Without this, a real cloud save left at
-- progress=0 could be overwritten by a smaller local save. Defensive against non-object
-- xp/physique blobs.
update public.saves set progress = coalesce((
  select floor(sum(v::numeric))::bigint
  from (
    select value as v from jsonb_each_text(case when jsonb_typeof(data->'xp')='object' then data->'xp' else '{}'::jsonb end)
    union all
    select value from jsonb_each_text(case when jsonb_typeof(data->'physique')='object' then data->'physique' else '{}'::jsonb end)
  ) q
  where v ~ '^-?[0-9]+(\.[0-9]+)?$'
), 0);
