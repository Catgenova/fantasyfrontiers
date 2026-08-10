-- ============================================================================
-- SUPABASE LINTER HARDENING (v0.0.97.5) — two advisory classes, one of them a REAL hole.
--
-- The database linter surfaced three warning families. This migration closes the ones that matter and
-- explains the ones deliberately left alone. Nothing here changes behaviour for a legitimate client or
-- edge function: every function revoked below is either called ONLY through the service role (the edge
-- functions authenticate with the service key, which is unaffected by anon/authenticated grants) or is a
-- TRIGGER function (a trigger fires regardless of the invoking role's EXECUTE privilege).
--
-- WHY `revoke ... from public` WAS NOT ENOUGH. Supabase's default privileges grant EXECUTE on every new
-- public function to `anon` AND `authenticated` explicitly, not via PUBLIC. So a `revoke ... from public`
-- (as guild_hall_upgrade's own migration did) leaves the anon/authenticated grants in place -- which is
-- exactly why the linter still flagged guild_hall_upgrade. The revokes below name the roles directly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE REAL HOLE: SECURITY DEFINER functions that TRUST a `p_user`/`p_reward` argument.
--
-- These do not self-authenticate (no auth.uid() check) -- they were written to be called ONLY by the
-- edge functions (service role), which pass a server-derived user id. But Supabase's default grants made
-- them callable by any signed-in account straight at /rest/v1/rpc/<name>, so a player could:
--   * guild_boss_clear(...)         -> pass an arbitrary p_reward and mint Barrier Shards for a whole guild
--   * guild_boss_enter/claim_pending -> act as, or drain the pending shards of, ANOTHER user_id
--   * guild_bank_deposit_unique(...) -> forge an arbitrary unique item into a guild bank
--   * dungeon_requeue(...)          -> drive another user's dungeon session
-- Revoke both roles; the edge functions keep working through the service role.
revoke all on function public.guild_boss_clear(uuid, text, uuid, date, integer, integer) from anon, authenticated;
revoke all on function public.guild_boss_enter(uuid, uuid, date, integer)                 from anon, authenticated;
revoke all on function public.guild_boss_claim_pending(uuid)                              from anon, authenticated;
revoke all on function public.guild_bank_deposit_unique(uuid, text, text, integer, text, integer, jsonb, text, text, text) from anon, authenticated;
revoke all on function public.dungeon_requeue(uuid, uuid, integer, integer)               from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. TRIGGER + owner/cron functions that never need a direct caller. A trigger runs its function on the
-- table event regardless of the acting role's EXECUTE grant, and the sweeps run under pg_cron / the owner,
-- so revoking the client roles removes the RPC surface with zero behavioural cost. (unique_provenance_*
-- were revoked at creation in 20260807140000; re-asserted here idempotently in case a later re-create of
-- the sweep reset its grants to the anon/authenticated default.)
revoke all on function public.notify_clamp_discord()             from anon, authenticated;
revoke all on function public.guild_estate_jobs_reap_on_leave()  from anon, authenticated;
revoke all on function public.unique_provenance_sweep(boolean)   from anon, authenticated;
revoke all on function public.unique_provenance_config()         from anon, authenticated;
revoke all on function public.shadow_digest_kinds()              from anon, authenticated;
revoke all on function public.shadow_digest_line(text, jsonb)    from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. guild_hall_upgrade IS meant for signed-in players (it self-authenticates via auth.uid() -> leader of
-- own guild, and takes no arguments), so `authenticated` STAYS. It just never needs `anon`.
revoke all on function public.guild_hall_upgrade() from anon;

-- ----------------------------------------------------------------------------
-- DELIBERATELY LEFT GRANTED (documented false positives, not fixed):
--   * public.is_clamped(uuid, text) and public.is_chat_muted(uuid) are RLS-POLICY helpers. The
--     messages_insert policy and the anon-readable leaderboard view call them from inside RLS, so they
--     MUST stay executable by anon/authenticated (20260724210000 / 20260807200000 grant them on purpose).
--     Each returns only a boolean about one account and a probe needs a uid you already hold.
--   * The estate_job_* / guild_estate_job_* / clamp_* / chat_* RPCs the linter flags under 0029 are
--     called directly by the signed-in client and self-authorize via auth.uid() (guild rank / chat role /
--     ownership). Their `authenticated` grant is intentional; revoking it would break the game.
--   * The pg_net "extension in public" warning is NOT addressed here: pg_net is Supabase-managed and
--     relocating an in-use extension is an owner-run, downtime-sensitive operation, not a code migration.

-- ----------------------------------------------------------------------------
-- 4. search_path pinned on the 12 flagged functions (lint 0011). A SECURITY DEFINER or shared function
-- with a role-mutable search_path can be tricked into resolving an unqualified name against an attacker's
-- schema; pinning it to `public` (the schema every one of these already reads unqualified) removes that.
-- ALTER touches only this one setting, leaving each function's body, volatility and grants intact.
alter function public.unique_provenance_config()                set search_path = public;
alter function public.shadow_digest_kinds()                     set search_path = public;
alter function public.shadow_digest_line(text, jsonb)           set search_path = public;
alter function public.guild_hall_cost(integer)                  set search_path = public;
alter function public.estate_job_tier_from_id(text)             set search_path = public;
alter function public.estate_job_row(public.estate_jobs)        set search_path = public;
alter function public.estate_job_duration_ms(text, jsonb)       set search_path = public;
alter function public.guild_estate_job_row(public.guild_estate_jobs) set search_path = public;
alter function public.auth_lockout_config()                     set search_path = public;
alter function public.dungeon_layer_index(text)                 set search_path = public;
alter function public.item_new_keys_per_sync()                  set search_path = public;
alter function public.item_unexplained_config()                 set search_path = public;

-- ----------------------------------------------------------------------------
-- VERIFY (one paste, read-only): every function above should now be absent from anon/authenticated grants
-- (except the two intentional RLS helpers) and carry a pinned search_path.
-- ----------------------------------------------------------------------------
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--        p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('guild_boss_clear','guild_boss_enter','guild_boss_claim_pending',
--                      'guild_bank_deposit_unique','dungeon_requeue','notify_clamp_discord',
--                      'guild_estate_jobs_reap_on_leave','unique_provenance_sweep','guild_hall_upgrade',
--                      'guild_hall_cost','estate_job_duration_ms','item_unexplained_config')
--  order by p.proname;
