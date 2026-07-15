-- ============================================================================
-- HARDEN the item ledger's first-sync GRANDFATHER against save/inventory tampering.
--
-- Reported exploit: the client-authoritative save (and the items.sync body) can be tampered to inject
-- an arbitrary inventory (e.g. 100,000,000 sand). For an ESTABLISHED (already-seeded) account this is
-- contained -- item_sync rate-caps each item's increase and market-sell / bank-deposit debit the
-- ledger, so spoofed stock can't be sold or banked beyond the rate cap. But the ONE-TIME grandfather
-- on a player's FIRST sync trusted the reported inventory verbatim, so a freshly-created or
-- never-synced account could seed the ledger with a spoofed inventory that IS then fully sellable.
--
-- Fix: bound the grandfather by ACCOUNT AGE (the same anchor submit_profile uses for a first
-- submission). An established player still keeps a generous, realistic stock (per_hour * age, e.g. a
-- 30-day account = ~36M headroom per item); a brand-new / age~0 account is held to the burst floor,
-- so a spoofed 100M collapses to the burst (25k) and can't be minted into the sellable ledger.
--
-- Adds a 5-arg overload taking the account's created_at; the previous 4-arg version is kept as a
-- backward-compat shim (so a not-yet-redeployed items edge function keeps working) that routes through
-- the hardened path with a strict now() anchor -- i.e. the old UNBOUNDED grandfather no longer exists.
-- ============================================================================

create or replace function public.item_sync(
  p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint, p_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb; grandfather_cap bigint; age_hours numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded into is_seeded from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  -- Grandfather headroom, bounded by how old the account is. greatest(now - created, 0) so a null or
  -- future created_at can never WIDEN it; the burst floor keeps a legit tiny new player unaffected.
  age_hours := greatest(0, extract(epoch from (now() - coalesce(p_created_at, now()))) / 3600.0);
  grandfather_cap := least(1000000000000, greatest(p_burst, floor(p_per_hour * age_hours)::bigint));

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    if not is_seeded then
      newq := least(reported, grandfather_cap);                 -- first sync: grandfather, capped by account age
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      if prev is null then prev := 0; end if;
      if prev = 0 then
        allowed := p_burst;                                     -- new OR depleted-to-0: grant the burst up front (preserves 20260713170000_item_sync_zero_row_grant)
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

-- Backward-compat shim for the previously-deployed edge function (4-arg call). Routes through the
-- hardened path with a strict now() anchor: during the deploy window a first-ever sync is held to the
-- burst floor (safe, never unbounded). Once the items function is redeployed, only the 5-arg is used.
create or replace function public.item_sync(p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint)
returns jsonb language sql security definer set search_path = public as $$
  select public.item_sync(p_user, p_items, p_per_hour, p_burst, now());
$$;

-- Function-only access on both overloads (service role only; revoke from client roles).
do $$
declare fn text; fns text[] := array[
  'public.item_sync(uuid, jsonb, bigint, bigint)',
  'public.item_sync(uuid, jsonb, bigint, bigint, timestamptz)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
