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
-- ORDER-INDEPENDENT BY CONSTRUCTION. The first attempt at this migration granted EXECUTE on
-- public.discord_notify(jsonb) unconditionally and died with 42883 "function does not exist" on a database
-- where 20260731120000 had not been applied yet -- turning a grants-only migration into a hard stop, and
-- leaving the operator unsure how much of it had taken effect. Every function grant below is therefore
-- guarded on the function actually existing. Consequences:
--   * running this BEFORE the lockout migration grants the schema usage and skips the rest, harmlessly
--   * running it AFTER grants everything
--   * running it TWICE is a no-op
-- The schema grant itself is unconditional -- `public` always exists, and it is the grant that matters.
--
-- Note the asymmetry with the table grants in the original migration: the hook is SECURITY DEFINER, so its
-- reads/writes of auth_login_failures and profiles run with the DEFINER's rights, not the caller's. The
-- grants that actually matter to `supabase_auth_admin` are therefore schema USAGE + function EXECUTE, which
-- is exactly the pair Supabase's own hook documentation specifies. The table grants are harmless.
-- ============================================================================

grant usage on schema public to supabase_auth_admin;

-- Guarded grants: skip (with a notice) anything 20260731120000 has not created yet.
do $$
declare
  v_sig text;
  v_sigs text[] := array[
    'public.hook_password_verification_attempt(jsonb)',
    'public.auth_lockout_config()',
    'public.discord_notify(jsonb)'
  ];
begin
  foreach v_sig in array v_sigs loop
    if to_regprocedure(v_sig) is null then
      raise notice 'skipping grant: % does not exist yet (apply 20260731120000_auth_password_lockout.sql first)', v_sig;
    else
      execute format('grant execute on function %s to supabase_auth_admin', v_sig);
      -- Only the hook itself needs locking away from clients: calling it would let a player lock OTHER
      -- accounts. The other two are internal helpers the original migration already revoked.
      if v_sig like 'public.hook_password_verification_attempt%' then
        execute format('revoke execute on function %s from anon, authenticated, public', v_sig);
      end if;
    end if;
  end loop;
end $$;

-- ---- Verification ---------------------------------------------------------------------------------
-- 1. What actually exists? All three rows should read `true` before you enable the hook. Any `false` means
--    20260731120000_auth_password_lockout.sql has not been applied (or only partly) -- apply it, then
--    re-run THIS migration to pick up the grants it skipped.
--
--   select 'hook'   as obj, to_regprocedure('public.hook_password_verification_attempt(jsonb)') is not null as exists
--   union all select 'config', to_regprocedure('public.auth_lockout_config()')    is not null
--   union all select 'notify', to_regprocedure('public.discord_notify(jsonb)')    is not null;
--
-- 2. Is the hook callable by GoTrue? Must be true. If false, do NOT enable the hook.
--
--   select has_schema_privilege('supabase_auth_admin', 'public', 'usage')
--      and has_function_privilege('supabase_auth_admin',
--            'public.hook_password_verification_attempt(jsonb)', 'execute') as hook_callable;
--
-- 3. Dry run (a nonexistent user id short-circuits to "continue", writing nothing):
--
--   select public.hook_password_verification_attempt(
--     jsonb_build_object('user_id', '00000000-0000-0000-0000-000000000000', 'valid', false));
--   -- expected: {"decision": "continue"}
