-- ============================================================================
-- SCAPELIKES VOTE WEBHOOK — idempotency ledger (v0.0.101.0).
--
-- Scapelikes (the game-listing/voting site) POSTs a signed webhook to our `scapelikes_vote` edge
-- function every time a player casts a vote for Fantasy Frontiers with an identifier supplied. On a
-- verified vote we extend the SHARED server-wide 'exp' buff (+50% XP) by 10 minutes for EVERY player
-- via the existing `server_buff_extend('exp', 600)` (migration 20260707060000). There is no per-player
-- payout: the reward is the server buff, so this table exists only to make the grant IDEMPOTENT.
--
-- Scapelikes guidance: "Store webhook_id in a unique column or idempotency table. Grant at most one
-- reward per webhook_id." webhook_id is the primary key; the record RPC inserts-if-new and reports
-- whether this call was the first to see it, so a retry (Scapelikes retries on any non-2xx / timeout)
-- extends the buff exactly once. identifier + voted_at are kept for auditing and the optional
-- secondary (identifier, voted_at) guard; identifier is an opaque server-owned player id (our auth
-- uid), never personal data.
--
-- Function-only, like server_buffs: RLS on with no client policies; the edge function (service_role)
-- is the only accessor. Execute is locked to service_role to satisfy the linter-hardening rule
-- (20260810160000): the default `public` execute grant is revoked so no client role can reach it.
-- ============================================================================

create table if not exists public.scapelikes_votes (
  webhook_id  text primary key,
  identifier  text,
  voted_at    timestamptz,
  seen_at     timestamptz not null default now()
);

alter table public.scapelikes_votes enable row level security;

-- Prune helper index: old rows are dead weight once well past any cooldown; a maintenance job can
-- delete by seen_at. (No automatic prune here — the table grows one small row per vote.)
create index if not exists scapelikes_votes_seen_at_idx on public.scapelikes_votes (seen_at);

-- Insert this webhook_id if unseen; return TRUE only when THIS call inserted it (i.e. the reward
-- should be granted now). A duplicate delivery hits the on-conflict no-op and returns FALSE, so the
-- edge function acks 2xx without re-extending the buff. p_voted_at is the vote's last_voted_at_utc.
create or replace function public.scapelikes_vote_record(p_webhook_id text, p_identifier text, p_voted_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_inserted int;
begin
  if p_webhook_id is null or char_length(p_webhook_id) < 1 or char_length(p_webhook_id) > 200 then
    return false;
  end if;
  insert into public.scapelikes_votes(webhook_id, identifier, voted_at)
    values (p_webhook_id, left(coalesce(p_identifier, ''), 128), p_voted_at)
  on conflict (webhook_id) do nothing;
  get diagnostics v_inserted = row_count;   -- 1 when inserted (first delivery), 0 on conflict (retry)
  return v_inserted = 1;
end $$;

-- Undo a record when the downstream buff extend fails, so a Scapelikes retry can re-process the same
-- webhook_id instead of the vote being silently dropped. Only the edge function calls this (service role).
create or replace function public.scapelikes_vote_unrecord(p_webhook_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.scapelikes_votes where webhook_id = p_webhook_id;
end $$;

-- Lock both RPCs to service_role only (edge function calls them with the service key). Revoke the
-- default public grant that anon/authenticated inherit; see 20260810160000 for the reasoning.
revoke execute on function public.scapelikes_vote_record(text, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.scapelikes_vote_record(text, text, timestamptz) to service_role;
revoke execute on function public.scapelikes_vote_unrecord(text) from public, anon, authenticated;
grant  execute on function public.scapelikes_vote_unrecord(text) to service_role;

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   -- first delivery grants, retry does not:
--   select public.scapelikes_vote_record('wh_test_1', 'player-uid', now());      -- expect true
--   select public.scapelikes_vote_record('wh_test_1', 'player-uid', now());      -- expect false (dup)
--   select public.scapelikes_vote_unrecord('wh_test_1');
--   select public.scapelikes_vote_record('wh_test_1', 'player-uid', now());      -- expect true again
--   delete from public.scapelikes_votes where webhook_id = 'wh_test_1';
--   -- execute locked to service_role:
--   select has_function_privilege('anon','public.scapelikes_vote_record(text,text,timestamptz)','execute'),
--          has_function_privilege('service_role','public.scapelikes_vote_record(text,text,timestamptz)','execute');
--   -- expect: false, true
-- ----------------------------------------------------------------------------
