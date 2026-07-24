-- ============================================================================
-- MARKETPLACE SETTLEMENT — make proceeds COLLECT atomic (drain + credit in one transaction).
--
-- Reported (pentest): after a fill the seller's proceeds looked missing. That specific observation is a
-- display artifact — the client auto-collects proceeds into the wallet the instant the Auction House opens,
-- so the "My Orders" inbox is already empty when it renders (the seller WAS paid). market_place itself
-- already credits the resting seller atomically with the fill.
--
-- The real gap the remediation flags is in COLLECT: the old flow drained the proceeds inbox in ONE rpc
-- (market_collect) and then the edge function credited the wallet / item ledger in SEPARATE rpc calls. If a
-- credit call failed (or the function died) after the drain, the proceeds were gone but never landed —
-- a genuine settlement-loss window.
--
-- Fix: market_collect_tx drains the inbox AND credits the wallet + item ledger inside the SAME function
-- (one transaction) — all-or-nothing, so a failure rolls the drain back too. The edge function calls this
-- and no longer credits separately.
--
-- DEPLOY-SAFE (no double-credit window, either order):
--   * NEW rpc name, so the OLD edge function keeps using the OLD market_collect (drain-only) + its own
--     external credit — still exactly one credit — during the rollout.
--   * The NEW edge function calls market_collect_tx and does NOT credit externally — still exactly one.
--   * If the new edge function ships before this migration, market_collect_tx just doesn't exist yet ->
--     collect returns an error and nothing is drained (proceeds stay safe), until the migration lands.
-- Recommended order: apply this migration, then redeploy the marketplace function.
-- ============================================================================

-- Atomic collect: drain the caller's proceeds inbox AND credit the results to the server-authoritative
-- wallet + item ledger in one transaction. Returns the same shape as the old market_collect
-- ({status, gold, items}) so the client keeps mirroring the settlement locally, unchanged.
create or replace function public.market_collect_tx(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        record;
  v_gold   bigint := 0;
  v_items  jsonb  := '[]'::jsonb;
begin
  -- Drain the inbox and settle each row in the SAME transaction. A data-modifying FOR loop keeps the
  -- delete and the crediting atomic: any error below rolls the whole thing back, so proceeds can never be
  -- drained-but-uncredited.
  for r in
    delete from public.market_proceeds where user_id = p_user
      returning kind, item_key, amount
  loop
    if r.kind = 'gold' then
      v_gold := v_gold + r.amount;                                   -- summed, credited once below
    elsif r.kind = 'item' and r.amount > 0 and r.item_key ~ '^[A-Za-z0-9_]{1,64}$' then
      perform public.item_credit(p_user, r.item_key, r.amount);      -- real ledger stock
      v_items := v_items || jsonb_build_object('item_key', r.item_key, 'amount', r.amount);
    end if;
  end loop;

  if v_gold > 0 then perform public.wallet_credit(p_user, v_gold); end if;  -- real spendable balance

  return jsonb_build_object('status', 'ok', 'gold', v_gold, 'items', v_items);
end $$;

-- Function-only access (service role only; revoke from client roles) -- matches the other market RPCs.
do $$
begin
  execute 'revoke execute on function public.market_collect_tx(uuid) from public, anon, authenticated';
  execute 'grant execute on function public.market_collect_tx(uuid) to service_role';
end $$;

-- NOTE: the old public.market_collect(uuid) (drain-only) is intentionally left in place for the rollout
-- window (the not-yet-redeployed edge function still calls it). It can be dropped in a later cleanup once
-- the marketplace function is confirmed on market_collect_tx everywhere.
