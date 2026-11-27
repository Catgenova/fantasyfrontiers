-- ============================================================================
-- GUILD BANK — atomic withdraw settlement (same hardening as the marketplace collect fix).
--
-- Pentest parity with the marketplace: the guild bank's WITHDRAW paths drained the shared vault /
-- treasury in one RPC and then credited the withdrawer's item ledger / wallet in a SEPARATE edge-function
-- call. If the credit failed (or the function died) after the drain, the items/gold were removed from the
-- shared store but never delivered -- a settlement-loss window (worse than the marketplace's: it's the
-- GUILD's shared property that vanishes).
--
-- Fix: *_withdraw_tx RPCs drain the vault/treasury AND credit the withdrawer's ledger/wallet inside the
-- SAME transaction (all-or-nothing). The edge function calls these and no longer credits separately.
--
-- DEPLOY-SAFE (no double-credit, either order): NEW rpc names. The OLD edge function keeps using the OLD
-- guild_bank_withdraw / guild_treasury_withdraw (drain-only) + its own external credit -- still exactly one
-- credit -- during rollout. The NEW edge function calls the *_tx RPCs and does NOT credit externally. If the
-- new function ships before this migration, the *_tx RPCs just don't exist yet -> withdraw errors and
-- nothing is drained (vault/treasury stay safe), until the migration lands.
-- Recommended order: apply this migration, then redeploy the guild_bank function.
--
-- (The item-key allowlist half of the parity -- rejecting made-up keys on deposit / deposit_unique -- is
-- enforced in the guild_bank edge function against item_catalog, no migration needed here. Stackable
-- DEPOSIT and gold DONATE keep their existing escrow+refund shape, matching the marketplace `place`.)
-- ============================================================================

-- Atomic stackable withdraw: decrement/clear the vault row AND credit the withdrawer's item ledger in one
-- transaction. Mirrors guild_bank_withdraw (20260706140000) plus the internal item_credit.
create or replace function public.guild_bank_withdraw_tx(p_guild uuid, p_user uuid, p_key text, p_qty bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_qty bigint;
begin
  if p_qty is null or p_qty <= 0 then return 'bad'; end if;
  select qty into v_qty from public.guild_bank
    where guild_id = p_guild and item_key = p_key for update;
  if v_qty is null or v_qty < p_qty then return 'short'; end if;
  if v_qty = p_qty then
    delete from public.guild_bank where guild_id = p_guild and item_key = p_key;
  else
    update public.guild_bank set qty = qty - p_qty, updated_at = now()
      where guild_id = p_guild and item_key = p_key;
  end if;
  -- Credit the withdrawer's ledger IN THE SAME TRANSACTION as the vault decrement, so a failure can't
  -- leave the item removed-from-vault-but-uncredited.
  perform public.item_credit(p_user, p_key, p_qty);
  return 'ok';
end $$;

-- Atomic treasury withdraw: debit the treasury AND credit the withdrawer's wallet in one transaction.
-- Mirrors guild_treasury_withdraw (20260706240000) plus the internal wallet_credit.
create or replace function public.guild_treasury_withdraw_tx(p_guild uuid, p_user uuid, p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cur bigint; v_new bigint;
begin
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('status','bad'); end if;
  select treasury into v_cur from public.guilds where id = p_guild for update;
  if v_cur is null then return jsonb_build_object('status','bad'); end if;
  if v_cur < p_amount then return jsonb_build_object('status','short'); end if;
  update public.guilds set treasury = treasury - p_amount where id = p_guild returning treasury into v_new;
  perform public.wallet_credit(p_user, p_amount);  -- atomic with the treasury debit
  return jsonb_build_object('status','ok','treasury',v_new,'granted',p_amount);
end $$;

-- Function-only access (service role only; revoke from client roles) -- matches the other guild RPCs.
do $$
declare fn text; fns text[] := array[
  'public.guild_bank_withdraw_tx(uuid, uuid, text, bigint)',
  'public.guild_treasury_withdraw_tx(uuid, uuid, bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
