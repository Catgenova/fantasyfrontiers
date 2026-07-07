-- ============================================================================
-- ACCOUNT RECOVERY — user-authored security questions for password reset.
--
-- We intentionally collect no email / PII, so a self-service recovery path needs a secondary
-- secret. Each user authors N question/answer pairs; recovery requires answering a threshold of
-- them correctly, after which the server resets their password (service role). Answers are a
-- secondary credential, so:
--   * Answers are HASHED (bcrypt via pgcrypto) -- never stored or returned in plaintext.
--   * The table is function-only (RLS on, no client policies): only the account_recovery Edge
--     Function (service role) + these SECURITY DEFINER RPCs touch it, so hashes never reach a client.
--   * Verification is server-side and rate-limited with a lockout counter to blunt brute force.
-- The client normalizes answers (trim + lowercase + collapse whitespace) identically on set and
-- verify, so matching is forgiving of casing/spacing.
-- ============================================================================
create extension if not exists pgcrypto;

create table if not exists public.account_recovery (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique,
  questions    jsonb not null,           -- [{ "q": "<question text>", "h": "<bcrypt hash of normalized answer>" }, ...]
  fail_count   int  not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.account_recovery enable row level security;
-- No policies on purpose: service role + SECURITY DEFINER are the only accessors.

-- Store (or replace) a user's questions, hashing each already-normalized answer with bcrypt.
create or replace function public.recovery_set(p_user uuid, p_username text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_out jsonb := '[]'::jsonb; it jsonb;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    v_out := v_out || jsonb_build_object('q', it->>'q', 'h', crypt(it->>'a', gen_salt('bf')));
  end loop;
  insert into public.account_recovery(user_id, username, questions, fail_count, locked_until, updated_at)
    values (p_user, p_username, v_out, 0, null, now())
  on conflict (user_id) do update
    set username = excluded.username, questions = excluded.questions, fail_count = 0, locked_until = null, updated_at = now();
end $$;

-- Verify normalized answers (jsonb array, index-aligned with the stored questions; entries may be
-- null/empty for unanswered) against the stored hashes. Applies lockout after too many failures.
-- Returns { status: ok | fail | locked | none, ... }.
create or replace function public.recovery_verify(p_user uuid, p_answers jsonb, p_needed int, p_max_fail int, p_lock_minutes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_q jsonb; v_lock timestamptz; v_fail int; n int; correct int := 0; i int; ans text; h text;
begin
  select questions, locked_until, fail_count into v_q, v_lock, v_fail
    from public.account_recovery where user_id = p_user for update;
  if v_q is null then return jsonb_build_object('status','none'); end if;
  if v_lock is not null and v_lock > now() then return jsonb_build_object('status','locked','until', v_lock); end if;
  n := jsonb_array_length(v_q);
  for i in 0 .. n - 1 loop
    ans := p_answers ->> i;
    h   := v_q -> i ->> 'h';
    if ans is not null and length(ans) > 0 and h is not null and crypt(ans, h) = h then
      correct := correct + 1;
    end if;
  end loop;
  if correct >= p_needed then
    update public.account_recovery set fail_count = 0, locked_until = null where user_id = p_user;
    return jsonb_build_object('status','ok');
  end if;
  v_fail := coalesce(v_fail, 0) + 1;
  if v_fail >= p_max_fail then
    update public.account_recovery set fail_count = 0, locked_until = now() + make_interval(mins => p_lock_minutes) where user_id = p_user;
    return jsonb_build_object('status','locked','until', now() + make_interval(mins => p_lock_minutes));
  end if;
  update public.account_recovery set fail_count = v_fail where user_id = p_user;
  return jsonb_build_object('status','fail','remaining', p_max_fail - v_fail);
end $$;
