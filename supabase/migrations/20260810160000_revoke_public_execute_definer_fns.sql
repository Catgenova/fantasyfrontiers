-- ============================================================================
-- REVOKE THE DEFAULT PUBLIC EXECUTE ON SERVICE-ONLY DEFINER FUNCTIONS (v0.0.97.7).
--
-- Follow-up to 20260810140000. That migration revoked EXECUTE from `anon` and `authenticated`, but the
-- Supabase linter still flags these functions as anon/authenticated-callable. The reason: PostgreSQL
-- grants EXECUTE to the PSEUDO-ROLE `public` on every function at creation, and `anon`/`authenticated`
-- (like every role) inherit it. `revoke ... from anon, authenticated` does NOT remove the `public`
-- grant, so has_function_privilege() still resolves true through it. (My earlier note had this backwards:
-- for THESE functions the default `public` grant was the live path, not an explicit anon/authenticated
-- one. guild_hall_upgrade cleared because ITS original migration already revoked `public`; these never did.)
--
-- Fix: revoke EXECUTE from `public` (and anon/authenticated, belt-and-suspenders) so no client role can
-- reach them, then grant it back to `service_role` ONLY for the five the edge functions actually invoke.
-- The edge functions authenticate with the service key (role `service_role`), which also loses its
-- `public`-inherited execute here -- hence the explicit grant, in the same transaction so there is no gap.
-- Trigger and cron functions need no grant: a trigger runs regardless of the acting role's privilege, and
-- the provenance sweep runs under pg_cron as the function owner, which always retains execute.
-- ============================================================================

-- ---- Service-role-only (edge functions call these; trust a server-derived p_user). Lock to service_role.
revoke execute on function public.guild_boss_clear(uuid, text, uuid, date, integer, integer) from public, anon, authenticated;
grant  execute on function public.guild_boss_clear(uuid, text, uuid, date, integer, integer) to service_role;

revoke execute on function public.guild_boss_enter(uuid, uuid, date, integer) from public, anon, authenticated;
grant  execute on function public.guild_boss_enter(uuid, uuid, date, integer) to service_role;

revoke execute on function public.guild_boss_claim_pending(uuid) from public, anon, authenticated;
grant  execute on function public.guild_boss_claim_pending(uuid) to service_role;

revoke execute on function public.guild_bank_deposit_unique(uuid, text, text, integer, text, integer, jsonb, text, text, text) from public, anon, authenticated;
grant  execute on function public.guild_bank_deposit_unique(uuid, text, text, integer, text, integer, jsonb, text, text, text) to service_role;

revoke execute on function public.dungeon_requeue(uuid, uuid, integer, integer) from public, anon, authenticated;
grant  execute on function public.dungeon_requeue(uuid, uuid, integer, integer) to service_role;

-- ---- Trigger + cron functions: no caller role needed at all (owner + trigger context retain execute).
revoke execute on function public.notify_clamp_discord()            from public, anon, authenticated;
revoke execute on function public.guild_estate_jobs_reap_on_leave() from public, anon, authenticated;
revoke execute on function public.unique_provenance_sweep(boolean)  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- STILL DELIBERATELY LEFT EXECUTABLE (documented false positives, unchanged):
--   * is_clamped(uuid, text) / is_chat_muted(uuid): RLS-policy helpers the messages_insert policy and the
--     anon leaderboard view call from inside RLS. They MUST keep public/anon/authenticated execute or a
--     normal chat insert and the leaderboard read break. SECURITY DEFINER is required (they read private
--     tables the caller can't); each returns only a boolean. These keep their 0028/0029 WARN by design.
--   * The estate_job_* / guild_estate_job_* / clamp_* / chat_* / wake_peek / guild_hall_upgrade RPCs the
--     linter lists under 0029 are called directly by the signed-in client and self-authorize via auth.uid()
--     (guild rank / chat role / ownership). Their `authenticated` grant is intentional; anon already cannot
--     reach them. They keep their 0029 WARN by design.
--   * pg_net's "extension in public" (0014) is an owner-run relocation, not a code migration.

-- ----------------------------------------------------------------------------
-- VERIFY (read-only): the eight locked functions should be false for BOTH client roles; service_role true
-- for the five it invokes and false for the three trigger/cron ones.
-- ----------------------------------------------------------------------------
-- select p.proname,
--        has_function_privilege('anon',          p.oid, 'execute') as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--        has_function_privilege('service_role',  p.oid, 'execute') as svc_exec
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('guild_boss_clear','guild_boss_enter','guild_boss_claim_pending',
--                      'guild_bank_deposit_unique','dungeon_requeue','notify_clamp_discord',
--                      'guild_estate_jobs_reap_on_leave','unique_provenance_sweep')
--  order by p.proname;
