-- ============================================================================
-- THE MUTE LOST ITS TEETH WHEN chat_mutes STOPPED BEING WORLD-READABLE.
--
-- Found from a Supabase linter finding (security_definer_view on public.chat_mutes_public) while looking at
-- what 20260807120000 actually changed. The linter's complaint is cosmetic and is dealt with at the bottom.
-- The real finding is that the same migration silently disarmed chat moderation.
--
-- WHAT BROKE. The messages_insert policy has carried the mute check since 20260724190000:
--
--     and not exists (select 1 from public.chat_mutes m
--                     where m.user_id = auth.uid() and m.muted_until > now())
--
-- A policy expression is evaluated AS THE QUERYING USER, so that subquery reads chat_mutes through
-- chat_mutes' own RLS. 20260807120000 dropped chat_mutes_read and deliberately added no replacement, which
-- was the right instinct for the leak (reason and muted_by were world-readable) but has a second effect
-- nobody wanted: RLS enabled with no policy denies every non-service-role read, so for an ordinary player
-- that subquery returns ZERO ROWS, `not exists (...)` is TRUE, and the clause is dead. A muted player can
-- post again, from the ordinary game client, with the database agreeing.
--
-- THE TELL WAS IN THE SAME POLICY ALL ALONG. Look at the two clauses side by side:
--
--     and not exists (select 1 from public.chat_mutes ...)     -- bare subquery, needs a read policy
--     and not public.is_clamped(auth.uid(), 'chat')            -- SECURITY DEFINER helper
--
-- account_clamps is private, so its check was written as a definer helper from the start, with the comment
-- "uses the definer helper, so the private clamp table stays private". The mute check did not need one
-- because chat_mutes was public. Making the table private without moving its check to a definer helper is
-- what removed the teeth. So the durable fix is not "give the read back" -- it is that ENFORCEMENT MUST
-- NEVER DEPEND ON A PUBLIC READ POLICY, because the next person to tighten a read surface will disarm it
-- again and no test will notice.
--
-- Also broken by the same drop, and fixed here as a side effect: the client's own mute lookup
-- (chatModLoad reads chat_mutes directly, select('user_id,muted_until')) returns nothing, so no player sees
-- a mute badge and no muted player is told why they cannot talk; and realtime honours RLS, so the
-- postgres_changes subscription on chat_mutes delivers no events either.
--
-- WHAT THIS DOES NOT DO. It does not put reason or muted_by back within reach of the publishable key.
-- Finding 6 stays fixed, by a STRONGER mechanism than a row policy: column-level privileges. A row policy
-- decides which ROWS you see, never which COLUMNS, so the only reason the original leak existed is that
-- select was granted on the whole table. It now is not.
-- ============================================================================

begin;

-- ---- 1. The teeth, as a definer helper (mirrors is_clamped exactly) -------------------------------
create or replace function public.is_chat_muted(p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_mutes m
    where m.user_id = p_user
      and m.muted_until > now()
  );
$$;

comment on function public.is_chat_muted(uuid) is
  'Is this account under an active chat mute? SECURITY DEFINER on purpose, mirroring is_clamped: the '
  'messages_insert policy must be able to see a mute even when the caller cannot read chat_mutes at all. '
  'A bare subquery there was silently disarmed when the table stopped being world-readable.';

-- The policy may call it, and only in that capacity. Nothing here leaks: it answers one boolean about one
-- account and exposes neither the reason nor the acting moderator.
grant execute on function public.is_chat_muted(uuid) to anon, authenticated;

-- ---- 2. Re-create messages_insert -----------------------------------------------------------------
-- Copied VERBATIM from 20260724210000 (the latest definition, not the one in 20260724190000) with the bare
-- mute subquery swapped for the helper. Every other clause is byte-identical: identity, trusted username,
-- and the clamp check. A normal send is unaffected.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
    and not public.is_chat_muted(auth.uid())
    and not public.is_clamped(auth.uid(), 'chat')
  );

-- ---- 3. Give the client its two columns back, and ONLY those two ----------------------------------
-- Column-level privileges, so `select *` and `select reason` are refused by the grant system before RLS is
-- even consulted. The table-wide grant from 20260724190000 is revoked first; a column grant does not
-- narrow an existing table grant.
revoke select on public.chat_mutes from anon, authenticated;
grant select (user_id, muted_until) on public.chat_mutes to anon, authenticated;

-- Rows: active mutes only. An expired mute is nobody's business, and the client filters on muted_until
-- anyway, so this costs nothing.
drop policy if exists chat_mutes_read on public.chat_mutes;
drop policy if exists chat_mutes_read_active on public.chat_mutes;
create policy chat_mutes_read_active on public.chat_mutes
  for select to anon, authenticated
  using (muted_until > now());

-- Insert/update/delete stay revoked (20260724190000); mutes are set through chat_set_mute, a definer RPC.

-- ---- 4. The linter finding ------------------------------------------------------------------------
-- security_definer_view on public.chat_mutes_public. It was written that way ON PURPOSE, because with no
-- read policy on the base table an invoker-rights view returns zero rows to every player -- so simply
-- flipping the flag, which is what the lint's own remediation link suggests, would have broken mute badges
-- for everyone and not been noticed either.
--
-- With step 3 in place the definer rights are no longer doing any work: the invoker can read exactly the
-- two columns the view selects. So the flag can be turned off honestly rather than suppressed, and the
-- view keeps working. This is the only reason the lint is safe to satisfy here.
alter view public.chat_mutes_public set (security_invoker = true);

commit;

-- ---------------------------------------------------------------------------------------------------
-- HOW TO VERIFY. A guard must be proven to fail before it is trusted to pass, and this one was found
-- DISARMED in production, so do not skip the first probe. I cannot run any of it here (no database).
--
-- STEP 1 -- confirm the bug was real, and that it is now fixed. Substitute a currently-muted account's id
--     (or mute a test account first via the Moderation panel). Run all three in one go:
--
--     select public.is_chat_muted('<muted-uuid>'::uuid) as helper_sees_the_mute;   -- EXPECT: true
--
--     -- and what the POLICY used to see, as the player rather than as the service role:
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<muted-uuid>"}';
--     select exists (select 1 from public.chat_mutes m
--                    where m.user_id = auth.uid() and m.muted_until > now()) as bare_subquery_sees_it;
--     select public.is_chat_muted(auth.uid()) as helper_sees_it;
--     reset role;
--
--     BEFORE this migration: bare_subquery_sees_it is FALSE. That false is the whole bug -- it is the value
--     the old policy was reading. AFTER: both are TRUE (the bare form because step 3 restored a row policy,
--     the helper because it never depended on one). The policy now uses the helper either way, so it stays
--     armed even if a future migration tightens the read surface again.
--
-- STEP 2 -- the teeth, end to end. Log in AS a muted test account in the real client and try to send a
--     chat message. EXPECT: the insert is refused by the database. This is the only check that proves the
--     policy itself, rather than the helper it calls.
--
-- STEP 3 -- the leak stays closed. With the PUBLISHABLE (anon) key, not the service role:
--     select * from chat_mutes;                             -- EXPECT: permission denied for column reason
--     select reason, muted_by from chat_mutes;               -- EXPECT: permission denied
--     select user_id, muted_until from chat_mutes;           -- EXPECT: active mutes only
--     select * from chat_mutes_public;                       -- EXPECT: the same rows, two columns
--     Then load the game and confirm mute badges render in chat again and the Moderation panel still lists
--     active mutes (that panel uses the service role, so it was never affected).
--
-- STEP 4 -- the linter. Re-run the advisor; security_definer_view on chat_mutes_public should be gone.
--
-- WHAT TO WATCH FOR ELSEWHERE, since this class of bug is not specific to mutes: any RLS policy containing
-- a bare subquery against a table the caller cannot read is already disarmed, silently. Enumerate them:
--     select schemaname, tablename, policyname, qual, with_check
--     from pg_policies
--     where schemaname = 'public'
--       and coalesce(qual, '') || coalesce(with_check, '') ~ 'from public\.'
--     order by tablename, policyname;
--     Then for each referenced table ask one question: can an ordinary authenticated user select from it?
--     If not, that clause evaluates to "nothing found" and the policy is weaker than it reads.
