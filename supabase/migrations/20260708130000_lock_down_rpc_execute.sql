-- Security hardening: these SECURITY DEFINER RPCs are meant to be called ONLY by the edge functions
-- (which authenticate the caller via the bearer token and pass the *verified* uid as p_user). But
-- Postgres grants EXECUTE to PUBLIC by default, so PostgREST exposed them at /rest/v1/rpc/<name> to
-- the anon + authenticated roles -- letting anyone with the (public) anon key bypass the edge function
-- and call them directly with arbitrary parameters. Several trust their args with no auth.uid() check,
-- e.g. market_credit_gold(p_user, p_amount) mints gold into any account's proceeds inbox. That's an
-- economy-integrity / account-abuse hole (Supabase lints 0028/0029).
--
-- Fix: revoke EXECUTE from public/anon/authenticated and grant only to service_role (the role the edge
-- functions use). The edge functions keep working unchanged; direct REST access is closed.
--
-- NOTE: current_guild_id() and current_guild_rank() are intentionally NOT locked down -- they are
-- parameterless, derive everything from auth.uid() (so they only ever reveal the caller's own guild),
-- and are referenced by RLS policies that run as the `authenticated` role, which therefore needs
-- EXECUTE on them.

do $$
declare
  fn text;
  fns text[] := array[
    'public.guild_bank_buy_slot(uuid)',
    'public.guild_bank_deposit(uuid, text, bigint)',
    'public.guild_bank_withdraw(uuid, text, bigint)',
    'public.guild_boss_assault(bigint, uuid, text, bigint, integer)',
    'public.guild_boss_claim(bigint, uuid)',
    'public.guild_estate_collect(uuid, integer)',
    'public.guild_treasury_donate(uuid, bigint)',
    'public.guild_treasury_spend(uuid, bigint)',
    'public.guild_treasury_withdraw(uuid, bigint)',
    'public.market_cancel(uuid, bigint)',
    'public.market_collect(uuid)',
    'public.market_credit_gold(uuid, bigint)',
    'public.market_credit_item(uuid, text, bigint)',
    'public.market_place(uuid, text, text, text, bigint, bigint)',
    'public.recovery_set(uuid, text, jsonb)',
    'public.recovery_verify(uuid, jsonb, integer, integer, integer)',
    'public.rls_auto_enable()',
    'public.server_buff_extend(text, integer)'
  ];
begin
  foreach fn in array fns loop
    -- Guard each one so a missing/renamed function doesn't abort the whole migration.
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
      execute format('grant execute on function %s to service_role', fn);
    exception when undefined_function then
      raise notice 'skipping (not found): %', fn;
    end;
  end loop;
end $$;
