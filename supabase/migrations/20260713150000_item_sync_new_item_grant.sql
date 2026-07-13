-- ============================================================================
-- FIX: newly-crafted item types were credited 0 in the item ledger on their first sync.
--
-- item_sync rate-limits each item's per-sync INCREASE with a token bucket keyed on the row's
-- updated_at. But a brand-new item type (one first owned AFTER the account's initial "seeding" sync)
-- had no row, so it started at prev_at = now() -> zero elapsed time -> allowed = 0 -> it was stored at
-- qty 0. Since SELL (marketplace) and guild-bank DEPOSIT hard-enforce ownership via item_debit against
-- this ledger, a freshly-crafted item (e.g. a rare Birch Staff) could NOT be sold or banked -- the
-- server saw 0 of it -- until a later background sync happened to run after real time had elapsed since
-- the 0-row was created. The deposit's own forced itemSync(true) didn't help: it created the 0-row in
-- the same call, right before item_debit checked it.
--
-- Fix: a new item type is granted the full burst allowance up front (its clock has no history to
-- accrue from), so it's ledgered immediately. Anti-mint is preserved: the initial grant is capped at
-- p_burst, and any further growth is rate-limited exactly as before. Only new rows change; existing
-- ledger rows follow the unchanged elapsed-time path.
-- ============================================================================
create or replace function public.item_sync(p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded into is_seeded from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    if not is_seeded then
      newq := least(reported, 1000000000000);                 -- first sync: grandfather as-is
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      if prev is null then
        prev := 0; allowed := p_burst;                        -- NEW item type after seeding: grant the burst up front (no accrual history)
      else
        allowed := least(p_burst, floor(p_per_hour * (extract(epoch from (now() - prev_at)) / 3600.0))::bigint);
        if allowed < 0 then allowed := 0; end if;
      end if;
      newq := least(reported, least(prev + allowed, 1000000000000));
      if newq < 0 then newq := 0; end if;
    end if;
    insert into public.player_items(user_id, item_key, qty, updated_at)
      values (p_user, k, newq, now())
      on conflict (user_id, item_key) do update
        -- advance the accrual clock only when we actually credited more (so idle syncs keep filling)
        set qty = excluded.qty,
            updated_at = case when excluded.qty > public.player_items.qty then now() else public.player_items.updated_at end;
    result := result || jsonb_build_object(k, newq);
  end loop;

  -- Anything the ledger holds that the client no longer reports was spent/dropped -> zero it so stale
  -- stock can't linger and be listed later.
  update public.player_items set qty = 0, updated_at = now()
    where user_id = p_user and qty > 0 and not (p_items ? item_key);

  insert into public.player_item_meta(user_id, seeded, synced_at) values (p_user, true, now())
    on conflict (user_id) do update set seeded = true, synced_at = now();
  return result;
end $$;
