-- ============================================================================
-- Item ledger (player_items / item_sync): grant the burst allowance whenever the ledger holds ZERO of
-- an item -- a never-seen row OR one sitting at qty 0.
--
-- item_sync rate-limits each item's per-sync INCREASE with a token bucket keyed on the row's
-- updated_at. Two failure modes this addresses:
--   * A brand-new item type (first owned after the account's seeding sync) had no row, so it started
--     at prev_at = now() -> zero elapsed -> allowed = 0 -> it was stored at qty 0.
--   * An item already stuck at a 0-row: its updated_at only advances when qty actually increases (it
--     never did), so retrying keeps the clock near "now", allowed stays ~0, and the ledger stays 0.
-- In both cases item_debit then rejected SELL (marketplace) / guild-bank DEPOSIT of the item -- the
-- server saw 0 of it (e.g. a rare Birch Staff you'd just crafted).
--
-- Fix: prev = 0 grants the full burst up front, so a freshly-owned or previously-depleted item is
-- ledgered immediately. Anti-mint holds: the instant grant is capped at p_burst, and sustained growth
-- beyond that is still rate-limited exactly as before. create-or-replace -> the `items` edge function
-- picks it up automatically (SQL only, no redeploy).
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
      if prev is null then prev := 0; end if;
      if prev = 0 then
        allowed := p_burst;                                   -- new OR depleted-to-0: grant the burst up front
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
