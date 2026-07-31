-- ============================================================================
-- ITEM LEDGER: put the first-seen grant on a CLOCK, and cap new keys per sync.
--
-- REPORTED (AndJustice4All, 29 Jul): a forged inventory snapshot posted to /functions/v1/items credits the
-- authoritative ledger. Confirmed, and the ceiling is far higher than the report shows.
--
-- THE DEFECT, exactly one line of the live item_sync (20260724120000):
--     if prev = 0 then allowed := p_burst;   -- 25,000, with NO elapsed-time requirement
-- A key the account has never held starts at prev = 0 and is granted the whole burst immediately. Nothing
-- makes the caller wait, so the same request can be repeated every second. With MAX_KEYS = 2000 distinct
-- keys per sync that is 2000 x 25,000 = FIFTY MILLION items in one call, and 10,900 of the 14,242
-- catalogued keys are equipment-class and market-tradeable.
-- It also slipped past the injection detector: that fires on the DENIED amount for a key
-- (ITEM_INJECT_MIN_OVER = 1e7), and a request of 25,000 against an allowance of 25,000 is denied zero, so
-- the sync looks perfectly clean. The detector only ever caught the crude "report 1e9 tarpon" case.
--
-- WHY NOT PER-CLASS CAPS (the first plan, discarded after doing the arithmetic). Small equipment caps look
-- obvious and would have broken legitimate play. An endgame account runs MAX_TASK_SLOTS = 15 concurrent
-- crafts; weapons and tools are tierTime(7,0.3,i) = 7s at t0; at 50% action time with the workshop
-- double-craft that is ~370,000 of a SINGLE key across one 12-hour offline window (and the
-- toolSpeedMultiplier floor of 0.1 allows ~2 million). A "burst 25 / 50-per-hour" equipment cap would have
-- taken years to catch up, and the ledger is the marketplace + guild-bank gate -- so a legitimate
-- mass-crafter could not have sold or banked their own output. The RATE was never the problem:
-- ITEM_PER_HOUR = 50,000 per key already sits above the legitimate ~16-30k/hour.
--
-- THE FIX. Two changes, nothing else touched:
--
--   1. The first-seen grant gets the same clock the normal path already uses, measured from the ACCOUNT's
--      previous sync (player_item_meta.synced_at, which already exists). A player returning from 12 hours
--      offline still gets the full burst, because 50,000/hour x 12 exceeds it. A caller looping the
--      endpoint on a 60-second client cadence gets 833. Same rule for everyone; no item classes, no
--      prefixes, nothing to misclassify.
--
--   2. A cap on how many FIRST-SEEN keys one sync may credit (ITEM_NEW_KEYS_PER_SYNC). A real client
--      discovers a handful of new item types in a sync; the exploit fans out across two thousand. Keys past
--      the cap are recorded at qty 0 so they are not lost -- the very next sync credits them normally.
--
-- Worst case moves from 50,000,000 items per request to ~41,000, and then becomes wall-clock bound.
--
-- BOOT ORDER, CHECKED, because it is what would have made this throttle real players: the first-seen clock
-- reads player_item_meta.synced_at, so a sync that fires BEFORE the offline catch-up would reset the clock
-- and leave the returning player's real haul throttled to a minute's worth. It does not happen --
-- startGameOnline awaits initGame() (which runs applyOfflineProgress) before chatInit(), and chatInit is
-- the only path to authRestore's itemSync. Any future change that syncs items earlier in boot MUST be
-- checked against this, or returning players get clamped.
--
-- Which 50 first-seen keys win is arbitrary (jsonb_each has no defined order). That is fine: nothing is
-- lost, the remainder is credited on the following sync a minute later.
--
-- NOT CLOSED BY THIS, deliberately: earning is still client-reported, because the server does not simulate
-- crafting (see submit_profile's header). This makes the ledger rate-honest, it does not make it
-- event-authoritative. Batch-validated server-side crafting is the real fix and is a separate project.
--
-- Everything else is preserved verbatim from 20260724120000: the catalog allowlist gate, the account-age
-- grandfather, the earned_total accrual (already the CREDITED delta, not the claim -- the report's
-- "cumulative earned is calculated from untrusted values" is only true via this burst), and the
-- zero-what-is-no-longer-reported pass.
-- ============================================================================

-- How many never-before-held item keys a single sync may credit. A legitimate client reports a few; the
-- forged payload in the report fanned out across the whole catalog.
create or replace function public.item_new_keys_per_sync()
returns int language sql immutable as $$ select 50 $$;

create or replace function public.item_sync(
  p_user uuid, p_items jsonb, p_per_hour bigint, p_burst bigint, p_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k text; reported bigint; prev bigint; prev_at timestamptz; allowed bigint; newq bigint; credited bigint;
  is_seeded boolean; result jsonb := '{}'::jsonb; grandfather_cap bigint; age_hours numeric;
  catalog_ready boolean;
  row_exists boolean;
  last_sync timestamptz;
  first_seen_hours numeric;
  new_keys int := 0;
  new_key_cap int := public.item_new_keys_per_sync();
begin
  if p_items is null or jsonb_typeof(p_items) <> 'object' then return '{}'::jsonb; end if;

  select seeded, synced_at into is_seeded, last_sync from public.player_item_meta where user_id = p_user;
  if is_seeded is null then is_seeded := false; end if;

  -- Enforce the allowlist ONLY once it's been seeded; an empty catalog gates nothing (safe deploy window).
  select exists (select 1 from public.item_catalog) into catalog_ready;

  age_hours := greatest(0, extract(epoch from (now() - coalesce(p_created_at, now()))) / 3600.0);
  grandfather_cap := least(1000000000000, greatest(p_burst, floor(p_per_hour * age_hours)::bigint));

  -- Elapsed since this ACCOUNT last synced -- the clock for keys with no row of their own. Falling back to
  -- the account's age (not to 0) keeps a legitimate first-ever sync unthrottled; is_seeded already routes
  -- that case through the grandfather branch, so this only matters for an account whose meta row is
  -- missing for some other reason. Never negative.
  first_seen_hours := greatest(0, extract(epoch from (now() - coalesce(last_sync, coalesce(p_created_at, now())))) / 3600.0);

  for k, reported in
    select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_items)
  loop
    -- Unknown item key (not in the populated catalog) -> not a real item; never enters the ledger.
    if catalog_ready and not exists (select 1 from public.item_catalog c where c.item_key = k) then
      continue;
    end if;
    if not is_seeded then
      newq := least(reported, grandfather_cap);                 -- first sync: grandfather, capped by account age
      credited := newq;                                         -- the whole grandfathered stock counts as earned
    else
      select qty, updated_at into prev, prev_at
        from public.player_items where user_id = p_user and item_key = k;
      row_exists := prev is not null;
      if prev is null then prev := 0; end if;
      if not row_exists then
        -- FIRST-SEEN KEY. Was an unconditional p_burst -- the exploit. Now bounded by real elapsed time
        -- since the account's last sync, so returning from 12h offline still grants the full burst while a
        -- caller re-firing the endpoint gets a minute's worth.
        if new_keys >= new_key_cap then
          -- Over the per-sync new-key budget: record the key at 0 so nothing is lost, and let the next
          -- sync credit it under the normal (row-exists) path.
          allowed := 0;
        else
          new_keys := new_keys + 1;
          allowed := least(p_burst, floor(p_per_hour * first_seen_hours)::bigint);
        end if;
      else
        -- The row exists, so it has its own clock -- use it, whether the balance is positive or was spent
        -- down to zero. A depleted key no longer gets a fresh unconditional burst: that was half of the
        -- exploit's surface, and re-earning at 50,000/hour is not a constraint on real play.
        allowed := least(p_burst, floor(p_per_hour * (extract(epoch from (now() - prev_at)) / 3600.0))::bigint);
      end if;
      if allowed < 0 then allowed := 0; end if;
      newq := least(reported, least(prev + allowed, 1000000000000));
      if newq < 0 then newq := 0; end if;
      credited := greatest(0, newq - prev);                     -- only an INCREASE counts as newly earned
    end if;
    insert into public.player_items(user_id, item_key, qty, earned_total, updated_at)
      values (p_user, k, newq, credited, now())
      on conflict (user_id, item_key) do update
        set qty = excluded.qty,
            earned_total = public.player_items.earned_total + excluded.earned_total,
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

-- ---- VERIFICATION -------------------------------------------------------------------------------
-- I cannot execute these here (no database in the build environment), so run them after applying. Each
-- states the number it must produce; a guard nobody has watched fail is not a guard.
--
-- 1. A RETURNING PLAYER IS NOT THROTTLED. Backdate the account's sync clock 12 hours, present a
--    never-held key, and confirm the full burst is still granted. THIS IS THE REGRESSION THAT MATTERS --
--    the 15-slot endgame case this fix was rejected once for breaking.
--
--    -- pick a disposable test account first:  select id from auth.users limit 1;
--    update public.player_item_meta set synced_at = now() - interval '12 hours' where user_id = '<uuid>';
--    delete from public.player_items where user_id = '<uuid>' and item_key = 'fletching_arrow_t0';
--    select public.item_sync('<uuid>', '{"fletching_arrow_t0": 999999}'::jsonb, 50000, 25000, now() - interval '30 days');
--    -- EXPECT {"fletching_arrow_t0": 25000}  (50,000/hr x 12h exceeds the burst, so the burst applies in full)
--
-- 2. THE EXPLOIT IS BOUNDED. Same key, but the account synced a minute ago.
--    update public.player_item_meta set synced_at = now() - interval '1 minute' where user_id = '<uuid>';
--    delete from public.player_items where user_id = '<uuid>' and item_key = 'stweapon_scimitar_t0_fantastic';
--    select public.item_sync('<uuid>', '{"stweapon_scimitar_t0_fantastic": 25000}'::jsonb, 50000, 25000, now() - interval '30 days');
--    -- EXPECT {"stweapon_scimitar_t0_fantastic": 833}  (50,000 x 1/60), NOT 25000
--
-- 3. THE FAN-OUT IS CAPPED. Post 60 never-held keys in one call with a 12h clock; only the first 50 may be
--    credited, the rest come back 0 and are credited on the following sync.
--    select count(*) filter (where value::bigint > 0) as credited,
--           count(*) filter (where value::bigint = 0) as deferred
--    from jsonb_each(public.item_sync('<uuid>', (
--      select jsonb_object_agg('fletching_arrow_t' || g, 10) from generate_series(0,20) g
--    ), 50000, 25000, now() - interval '30 days'));
--    -- EXPECT credited <= 50 (21 keys here, so all 21), deferred = 0. Repeat with >50 distinct keys to see
--    -- the cap bite; there are only 21 arrow tiers, so build the set from another family for that test.
--
-- 4. Existing accounts are untouched by applying this -- it replaces a function, writes no rows.
