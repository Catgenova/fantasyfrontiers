-- Clears the rls_enabled_no_policy (0008) INFO lints. These tables are FUNCTION-ONLY: they're read
-- and written exclusively by the edge functions / SECURITY DEFINER RPCs (service_role), never by the
-- client directly. With RLS enabled and zero policies they already deny all anon/authenticated access
-- -- which is the intended, secure state -- but the linter can't distinguish "intentionally locked"
-- from "forgot to add policies". So we make the intent explicit with an always-false deny-all policy.
--
-- Behaviour is unchanged: anon/authenticated were denied before and are denied now; service_role has
-- BYPASSRLS, so the edge functions/RPCs are unaffected.

do $$
declare
  t text;
  tables text[] := array[
    'account_recovery', 'guild_bank', 'guild_boss_damage',
    'guild_bosses', 'market_orders', 'market_proceeds', 'server_buffs'
  ];
begin
  foreach t in array tables loop
    begin
      execute format('drop policy if exists %I on public.%I', t || '_no_client_access', t);
      execute format(
        'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
        t || '_no_client_access', t);
    exception when undefined_table then
      raise notice 'skipping (table not found): %', t;
    end;
  end loop;
end $$;
