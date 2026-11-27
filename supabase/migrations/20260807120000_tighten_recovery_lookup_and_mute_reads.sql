-- ============================================================================
-- Two read-surface tightenings found in the comprehensive code review (2026-08-07).
--
-- OWNER-DEPLOYED. This file is NOT applied by CI; nothing under supabase/ ships through the Pages
-- workflow. Apply it yourself, and read the account_recovery half before you do: it changes what
-- get_questions returns to an unauthenticated caller only in RATE, not in content, so the recovery
-- UI keeps working unchanged.
-- ============================================================================


-- ---- FINDING 6: chat_mutes was world-readable, including moderator notes ---------------------------
-- The policy was `for select using (true)` with no `to authenticated`, so anyone holding the
-- publishable key (which is public by design) could read the entire table. That table carries
-- `reason`, free text a moderator wrote, and `muted_by`, the acting moderator's id. Neither is
-- anything a player needs and both were readable by the whole internet.
--
-- The client only ever asks for two columns:
--     chatClient.from('chat_mutes').select('user_id,muted_until').gt('muted_until', ...)
-- so a two-column view closes this with NO client change at all. The base table drops its public
-- policy and stays reachable by the service role (which bypasses RLS) for the moderation panel.

create or replace view public.chat_mutes_public
with (security_invoker = false) as
  select user_id, muted_until
  from public.chat_mutes
  where muted_until > now();

comment on view public.chat_mutes_public is
  'Public projection of chat_mutes: who is muted and until when, nothing else. The base table keeps '
  'reason and muted_by, which are moderator notes and must never be world-readable (review finding 6).';

grant select on public.chat_mutes_public to anon, authenticated;

drop policy if exists chat_mutes_read on public.chat_mutes;

-- Deliberately NO replacement select policy on the base table. RLS is already enabled on it, so with
-- no policy it denies every non-service-role read, which is exactly the intent. The moderation panel
-- and the edge functions use the service role and are unaffected.


-- ---- FINDING 13: account_recovery.get_questions had no rate limit ----------------------------------
-- Guessing recovery ANSWERS is properly defended: account_recovery carries fail_count and
-- locked_until, and recovery_verify takes p_max_fail / p_lock_minutes and returns a 'locked' status.
-- Asking what someone's QUESTIONS are was not defended at all and needs no auth, which gave free
-- unlimited username enumeration plus disclosure of the user-authored questions themselves. Those
-- questions are the input half of the one credential path that bypasses the password.
--
-- This adds a caller-keyed limiter the edge function calls before it answers. Keyed on the CALLER,
-- not the username, so an attacker cannot spread a sweep across many names to stay under the limit.

create or replace function public.recovery_lookup_allowed(p_caller text, p_max int default 10, p_window_minutes int default 15)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if p_caller is null or length(p_caller) = 0 then
    return false;   -- fail CLOSED: an unidentifiable caller gets nothing. This path guards a
                    -- credential surface, so it follows register's fail-closed rule, not rl_hit's
                    -- fail-open one.
  end if;

  delete from public.recovery_lookup_log where seen_at < now() - (p_window_minutes || ' minutes')::interval;

  select count(*) into v_count
  from public.recovery_lookup_log
  where caller = p_caller and seen_at > now() - (p_window_minutes || ' minutes')::interval;

  if v_count >= p_max then
    return false;
  end if;

  insert into public.recovery_lookup_log(caller, seen_at) values (p_caller, now());
  return true;
end;
$$;

create table if not exists public.recovery_lookup_log (
  id      bigserial primary key,
  caller  text        not null,
  seen_at timestamptz not null default now()
);
create index if not exists recovery_lookup_log_caller_idx on public.recovery_lookup_log(caller, seen_at desc);

alter table public.recovery_lookup_log enable row level security;
-- No policy: service-role only, like every other limiter table. RLS on with no policy denies all
-- non-service-role access, which is the intent.

revoke all on function public.recovery_lookup_allowed(text, int, int) from public, anon, authenticated;

comment on function public.recovery_lookup_allowed(text, int, int) is
  'Caller-keyed rate limit for account_recovery get_questions (review finding 13). Fails CLOSED: it '
  'guards a credential surface, so a broken limiter must refuse rather than wave callers through.';


-- ---- HOW TO VERIFY, before trusting either of these ------------------------------------------------
-- A guard must be proven to fail before it is trusted to pass.
--
-- Finding 6, with the publishable (anon) key:
--   select * from chat_mutes;          -- expect: permission denied / zero rows
--   select * from chat_mutes_public;   -- expect: user_id + muted_until only
--   Then load the game and confirm mute state still renders in chat.
--
-- Finding 13:
--   select public.recovery_lookup_allowed('probe');   -- run 11 times
--   Expect true for the first 10 and false on the 11th, then true again after 15 minutes.
--   select public.recovery_lookup_allowed(null);      -- expect false (fails closed)
--
-- ---- DEPLOY ORDER MATTERS: MIGRATION FIRST, THEN THE FUNCTION ---------------------------------------
-- account_recovery's get_questions branch ALREADY calls recovery_lookup_allowed() and returns 429 when
-- it is false or errors (that shipped with this review; the function is not waiting on anything).
--
-- Because that call FAILS CLOSED, the order is not optional:
--   1. Apply THIS MIGRATION first.
--   2. Then deploy the account_recovery edge function.
-- Deploy the function against a database without recovery_lookup_allowed() and every get_questions
-- call takes the error branch and returns 429, which breaks password recovery lookups for everyone
-- until the migration lands. Applying the migration first is harmless in the other direction: the
-- limiter simply sits unused until the new function is live.
