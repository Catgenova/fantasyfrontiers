-- Session fencing for cloud saves: one simulating session per account.
--
-- The reported multi-session bugs (estate cooldown bypassed across two browsers; combat drops collected
-- twice from two windows) share one root cause: the whole game state is a client-simulated blob, and
-- save_game accepts a full-blob overwrite guarded only by forward-only total XP. Two browsers are two
-- independent simulations fighting over one row every 8 seconds, and the higher-XP blob wins wholesale.
--
-- The estate fix (20260720120000) moved ONE mechanic's cooldown server-side. This closes the class: each
-- tab claims the save with a random session id, and a save from a session that no longer holds the claim
-- is refused. The losing tab stops simulating and asks the player to reload.
--
-- `version` already existed and is incremented per write, but the client never sent an expected value, so
-- it was a counter rather than a fence. This adds the claim it was missing.
--
-- ADDITIVE AND ORDER-SAFE: a null active_session means nobody has claimed, and save_game treats that as
-- "do not fence". Safe to run before the function is redeployed and before the client ships.

alter table public.saves add column if not exists active_session text;

comment on column public.saves.active_session is
  'Session id of the tab currently allowed to write this save. Set by save_game action:"claim" and on '
  'each accepted write. NULL = unclaimed (no fencing). A save whose session_id differs is refused with '
  '{fenced:true} so the losing tab can freeze instead of silently losing progress.';
