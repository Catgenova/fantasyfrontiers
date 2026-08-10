-- Widen the Chronicle `kind` CHECK for the Mortal-death blast (v0.0.97.2).
--
-- mortalDeath() now broadcasts kind 'mortal_death' so every online player sees a Mortal's final
-- death in their Chronicle and as a global-chat system blast (and chatInit reloads persisted rows
-- on refresh). The constraint MUST be widened first: a kind missing from this CHECK is inserted
-- and silently rejected (the client fires and swallows the error), so only the dying player would
-- ever see the event locally -- the exact bug 'buff' and 'enhance' had before 20260710180000.
-- Re-create the column CHECK with the full, current set of kinds.
alter table public.chronicle drop constraint if exists chronicle_kind_check;
alter table public.chronicle
  add constraint chronicle_kind_check
  check (kind in ('craft','level','familiar','buff','enhance','mortal_death'));

-- ---------------------------------------------------------------------------
-- VERIFY (one paste, read-only): the constraint's definition names all six kinds.
-- ---------------------------------------------------------------------------
-- select pg_get_constraintdef(oid) like '%mortal_death%' as has_mortal_death
--   from pg_constraint where conname = 'chronicle_kind_check';
