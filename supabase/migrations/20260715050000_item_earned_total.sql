-- ============================================================================
-- SERVER-AUTHORITATIVE INVENTORY, Stage B-1: per-item lifetime-earned anchor.
--
-- The client-adoption reconcile (itemReconcile, the item analog of walletReconcileGold) needs, per item
-- type, how much the server has legitimately CREDITED over the account's lifetime -- so it can tell
-- "legit gathered items the rate cap hasn't credited to the ledger yet" (preserve them) from "spoofed
-- items" (collapse to the ledger). This adds that anchor (player_items.earned_total, the item analog of
-- player_wallet.earned_total) and maintains it on EVERY credit path:
--   * item_sync earning-reconcile: += each item's credited increase (grandfather = the whole seed).
--   * item_credit (market buy / bank withdraw / refunds): += the credited qty.
-- Debits (item_debit / item_debit_bill / craft_debit) leave it alone -- it's monotonic lifetime-credited.
--
-- ADDITIVE: the edge fn returns the earned map alongside items; older clients ignore it. Nothing adopts
-- the ledger yet (that's Stage B-2, gated behind a client kill switch).
-- ============================================================================

alter table public.player_items add column if not exists earned_total bigint not null default 0;

-- Rebuild item_sync (5-arg) to also accrue earned_total. Preserves the account-age grandfather cap
-- (20260715020000) and the prev=0 burst grant (20260713170000); the ONLY new behavior is tracking the
-- credited delta into earned_total.
create or replace function public.item_sync(
  p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint, p_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint; credited bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb; grandfather_cap bigint; age_hours numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded into is_seeded from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  age_hours := greatest(0, extract(epoch from (now() - coalesce(p_created_at, now()))) / 3600.0);
  grandfather_cap := least(1000000000000, greatest(p_burst, floor(p_per_hour * age_hours)::bigint));

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    if not is_seeded then
      newq := least(reported, grandfather_cap);                 -- first sync: grandfather, capped by account age
      credited := newq;                                         -- the whole grandfathered stock counts as earned
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      if prev is null then prev := 0; end if;
      if prev = 0 then
        allowed := p_burst;                                     -- new OR depleted-to-0: grant the burst up front
      else
        allowed := least(p_burst, floor(p_per_hour * (extract(epoch from (now() - prev_at)) / 3600.0))::bigint);
        if allowed < 0 then allowed := 0; end if;
      end if;
      newq := least(reported, least(prev + allowed, 1000000000000));
      if newq < 0 then newq := 0; end if;
      credited := greatest(0, newq - prev);                     -- only an INCREASE counts as newly earned
    end if;
    insert into public.player_items(user_id, item_key, qty, earned_total, updated_at)
      values (p_user, k, newq, credited, now())
      on conflict (user_id, item_key) do update
        set qty = excluded.qty,
            earned_total = public.player_items.earned_total + excluded.earned_total, -- excluded.earned_total == credited
            -- advance the accrual clock only when we actually credited more (so idle syncs keep filling)
            updated_at = case when excluded.qty > public.player_items.qty then now() else public.player_items.updated_at end;
    result := result || jsonb_build_object(k, newq);
  end loop;

  -- Anything the ledger holds that the client no longer reports was spent/dropped -> zero the QTY (but
  -- NOT earned_total, which is monotonic lifetime-credited).
  update public.player_items set qty = 0, updated_at = now()
    where user_id = p_user and qty > 0 and not (p_items ? item_key);

  insert into public.player_item_meta(user_id, seeded, synced_at) values (p_user, true, now())
    on conflict (user_id) do update set seeded = true, synced_at = now();
  return result;
end $$;

-- item_credit also accrues earned_total (market buy / bank withdraw / cancelled-sell refunds), so the
-- server's lifetime-credited stays in step with the client's per-item earned anchor for every credit
-- path -- otherwise a bought/withdrawn item would look "un-earned" and inflate the reconcile's pending.
create or replace function public.item_credit(p_user uuid, p_key text, p_qty bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_qty bigint; v_add bigint;
begin
  if p_qty is null or p_qty <= 0 then
    select qty into v_qty from public.player_items where user_id = p_user and item_key = p_key;
    return coalesce(v_qty, 0);
  end if;
  v_add := least(p_qty, 1000000000000);
  insert into public.player_items(user_id, item_key, qty, earned_total)
    values (p_user, p_key, v_add, v_add)
    on conflict (user_id, item_key) do update
      set qty = least(public.player_items.qty + excluded.qty, 1000000000000),
          earned_total = public.player_items.earned_total + excluded.earned_total,
          updated_at = now()
    returning qty into v_qty;
  return v_qty;
end $$;
