-- Lock the SECURITY DEFINER RPCs that are the INTERNAL implementation of edge functions (Supabase advisor
-- 0028/0029: "anon/authenticated can execute SECURITY DEFINER function").
--
-- These take p_user / p_guild / p_power / etc. as TRUSTED parameters and run SECURITY DEFINER (bypassing
-- RLS), because they're called by the `dungeon` / `guild_bank` edge functions AS service_role, AFTER those
-- functions derive the caller's identity from the auth token and validate. If a client can call them
-- directly via /rest/v1/rpc/<fn>, it can forge p_user/p_power and bypass every check (claim another
-- player's dungeon rewards, inflate power, move guild-bank items, ...). The wallet_*/item_*/rl_hit RPCs
-- were already locked this way; the dungeon + guild_bank_unique ones missed it.
--
-- SAFE TO RUN ANYTIME: the client only ever hits the edge functions (functions.invoke) -- verified there are
-- NO direct client rpc() calls to any of these -- and the edge functions run as service_role, which keeps
-- EXECUTE below. So this is transparent to players (no client change, no edge-fn redeploy needed).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'dungeon_assault','dungeon_claim','dungeon_create','dungeon_engaged',
        'dungeon_join','dungeon_leave','dungeon_start',
        'guild_bank_deposit_unique','guild_bank_withdraw_unique'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant  execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- rl_chat_guard is a TRIGGER function (fires on messages / guild_messages insert); it must never be a
-- client-callable RPC. Revoke its default EXECUTE -- the trigger still fires regardless of role grants.
revoke execute on function public.rl_chat_guard() from public, anon, authenticated;

-- get_profile_estate stays client-callable (the "Visit Estate" button reads PUBLIC estate data), but only
-- for signed-in users -- the game requires login, so `anon` never needs it. `authenticated` keeps it.
revoke execute on function public.get_profile_estate(uuid) from anon;
