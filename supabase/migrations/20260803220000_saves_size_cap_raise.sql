-- SAVES SIZE CAP: 512KB -> 2MB (v0.0.77.40) ----------------------------------------------------------
--
-- Live report, surfaced by the save watchdog banner: "Progress not saving -- save too large". A real
-- player's save crossed saves_size_chk (pg_column_size(data) < 524288, set 20260705160000) and every
-- push 413'd. The actual bloat was CLIENT-side and is fixed in the same release: state.popupQueue had
-- no cap, drains one click at a time, and each entry stores its item's inline SVG icon -- an offline
-- mass-craft batch with rarity popups enabled queued thousands of entries. The client now hard-caps
-- the queue at 60 (push-time and load-time), which shrinks the bloated save the moment it next loads.
--
-- This raise is the other half: legitimate endgame saves (full inventory, unique-item table, estate
-- grid) sit far above a fresh save's ~133KB raw and deserve headroom, and the affected player's LIVE
-- session cannot save at all until either the cap rises or they reload into the pruning client. 2MB
-- keeps a real ceiling (the guard exists so a runaway blob cannot pin the row -- see the progress-
-- ceiling lesson in save_game) while ending the false positives.
alter table public.saves drop constraint if exists saves_size_chk;
alter table public.saves add  constraint saves_size_chk check (pg_column_size(data) < 2097152);
