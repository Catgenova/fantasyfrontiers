-- Widen the Chronicle `kind` CHECK so newer broadcast kinds persist and relay to other players.
-- The original constraint (chronicle_feed.sql) only allowed ('craft','level','familiar'). Two kinds
-- were added client-side afterward but never made it into the constraint, so their inserts have been
-- silently rejected (the client fires them and swallows the error), meaning only the acting player
-- saw them locally:
--   'buff'    -- server-wide EXP buff purchases/registration/familiar events
--   'enhance' -- an item Enhanced to +10 or higher (Improvement tab)
-- Re-create the column CHECK with the full, current set of kinds.
alter table public.chronicle drop constraint if exists chronicle_kind_check;
alter table public.chronicle
  add constraint chronicle_kind_check
  check (kind in ('craft','level','familiar','buff','enhance'));
