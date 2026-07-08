-- Security fix: the chat/chronicle/guild-message INSERT policies validated the row's `username`
-- against `auth.jwt() -> 'user_metadata' ->> 'username'`. user_metadata is END-USER EDITABLE
-- (supabase.auth.updateUser({ data: {...} })), so a signed-in user could spoof the DISPLAY name on
-- their own messages (impersonation). auth.uid() = user_id was still enforced, so this was display-
-- name spoofing only -- no cross-user writes, no data exposure -- but it's still not something to
-- trust in a security context (Supabase's "RLS references user metadata" lint).
--
-- Trusted source instead: registration mints a synthetic email `lower(username)@<domain>`, and the
-- email claim is NOT user-editable. So the email's local part is a tamper-proof copy of the username.
-- Compare case-insensitively (the email is lowercased; the stored username keeps its original case),
-- which still binds each user to their own registered name.

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
  );

drop policy if exists chronicle_insert on public.chronicle;
create policy chronicle_insert on public.chronicle
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
  );

drop policy if exists guild_msgs_insert on public.guild_messages;
create policy guild_msgs_insert on public.guild_messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
    and guild_id = public.current_guild_id()
  );
