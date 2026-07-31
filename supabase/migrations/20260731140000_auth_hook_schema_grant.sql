-- ============================================================================
-- AUTH HOOK: the missing schema grant (follow-up to 20260731120000_auth_password_lockout).
--
-- GoTrue invokes a Postgres auth hook as the `supabase_auth_admin` role. That migration granted EXECUTE on
-- the function but never granted USAGE on the schema containing it, so `supabase_auth_admin` could not
-- resolve `public.hook_password_verification_attempt` at all.
--
-- WHY THIS IS URGENT AND NOT COSMETIC. The hook body is exception-safe (any error inside it returns
-- {"decision":"continue"}, i.e. fail-open, so a bug in the lockout can never lock out the playerbase). But
-- a permission failure happens BEFORE the body runs -- the role cannot enter the schema to call the
-- function -- so that handler never gets a chance. GoTrue would see the hook itself error, and a failing
-- auth hook fails the sign-in request. Enabling the hook without this grant risks breaking LOGIN for
-- everyone, which is far worse than the password-spraying it defends against.
--
-- Deploy this BEFORE enabling the hook in the Dashboard.
--
-- Note the asymmetry with the table grants in the original migration: the hook is SECURITY DEFINER, so its
-- reads/writes of auth_login_failures and profiles run with the DEFINER's rights, not the caller's. The
-- grants that actually matter to `supabase_auth_admin` are therefore schema USAGE + function EXECUTE, which
-- is exactly the pair Supabase's own hook documentation specifies. The table grants are harmless.
-- ============================================================================

grant usage on schema public to supabase_auth_admin;

-- Re-assert the function grants idempotently, so running this alone leaves a correct, working hook even if
-- the earlier migration is ever re-applied out of order.
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt(jsonb) from anon, authenticated, public;

-- The hook calls these two; both must be reachable by the same role.
grant execute on function public.auth_lockout_config() to supabase_auth_admin;
grant execute on function public.discord_notify(jsonb) to supabase_auth_admin;

-- ---- Verification ---------------------------------------------------------------------------------
-- After applying, this should return true. If it returns false, do NOT enable the hook.
--
--   select has_schema_privilege('supabase_auth_admin', 'public', 'usage')
--      and has_function_privilege('supabase_auth_admin',
--            'public.hook_password_verification_attempt(jsonb)', 'execute') as hook_callable;
--
-- And a dry run of the hook itself (a nonexistent user id short-circuits to "continue", writing nothing):
--
--   select public.hook_password_verification_attempt(
--     jsonb_build_object('user_id', '00000000-0000-0000-0000-000000000000', 'valid', false));
--   -- expected: {"decision": "continue"}
