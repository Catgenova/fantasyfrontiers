-- Leaderboard: move to server-side validation.
-- Previously the client wrote public.profiles directly (trust-based). Now writes go
-- through the `submit_profile` Edge Function (service role), which validates the payload
-- and rate-limits growth. So we REMOVE the client's direct insert/update permission —
-- authenticated users can no longer write the table at all. Public read stays; the
-- service role used by the Edge Function bypasses RLS, so the function can still write.

drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

-- (RLS stays enabled; profiles_read — "for select using (true)" — remains in place.)
