-- ============================================================================
-- UNEXPLAINED TOP-RARITY ACQUISITION: a SHADOW-ONLY sweep. It clamps nothing until someone
-- deliberately flips it on after reviewing real signals.
--
-- WHY THE OBVIOUS SIGNALS DO NOT WORK. Three were tried against live data and every one would have
-- punished the most active players:
--
--   1. Per-item-class caps on item_sync. An endgame account (MAX_TASK_SLOTS = 15, weapons at
--      tierTime(7,0.3,i), 50% action time, workshop double) legitimately produces ~370,000 of ONE key in a
--      12-hour offline window. Small equipment caps would have taken years to catch up, and the ledger
--      gates the marketplace, so a mass-crafter could not have sold their own output.
--   2. An absolute count of top-rarity items. The fantastic craft chance caps at 0.0016 (base 0.0001 +
--      miracle 0.0005 + masterwork 0.0005 + server buff 0.0005), so that same 370,000-key crafter earns
--      ~590 fantastic of it legitimately. Any count threshold low enough to catch injection catches them.
--   3. Fantastic SHARE of a family's lifetime earned_total. Ran it live: it flagged the real injection
--      (Test17, share 1.00) AND two rows belonging to Valuren, an active player and bug reporter. Cause:
--      public.item_credit accrues earned_total too, so earned_total means ACQUIRED BY ANY ROUTE -- a player
--      who BUYS fantastic gear looks identical to one who mints it. Compounded by a rarity-rate nerf:
--      earned_total is LIFETIME and monotonic, so it mixes rate eras and pre-nerf holdings would keep
--      tripping any current-rate threshold forever.
--
-- WHAT THIS DOES INSTEAD. Two corrections follow directly from those failures:
--
--   * MEASURE A DELTA, NOT HISTORY. A snapshot table (item_earn_watch) records earned_total per key at each
--     sweep; only growth since the last sweep is judged. Lifetime totals -- and therefore every pre-nerf
--     holding -- are structurally out of scope. The FIRST run establishes the baseline and flags NOTHING.
--   * SUBTRACT WHAT THE SERVER WITNESSED. There was no durable record of completed acquisitions:
--     market_orders is the live book, market_proceeds a consumable inbox, guild_bank current holdings.
--     item_credit is the single server-side credit path (item_sync is the only other writer that raises
--     qty, and it is the client-reported one), so it now writes item_credit_log. Growth minus logged
--     credits = what the CLIENT claimed, which is the only part worth judging.
--
-- THE DISCRIMINATOR. To earn F top-rarity items by crafting you must roll the family ~F/0.0016 = 625F
-- times, so a real crafter's normal-rarity growth dwarfs their fantastic growth. An injector mints only the
-- valuable rarity and has no sibling growth at all. Flag when client-reported top-rarity growth is at least
-- ITEM_UNEXPLAINED_MIN and the family's base-rarity growth is under 100x it -- a 6.25x margin under the
-- legitimate ratio.
--
-- STILL NOT PROOF, and this is why it ships shadow-only: legitimate crafting is also "client-reported", and
-- a patient injector who also crafts normals would pass. This narrows review, it does not adjudicate.
-- Precedent: CLAMP_AUTOENFORCE sat in shadow until a review "confirmed the threshold has a ~1000x margin".
-- ============================================================================

-- ---- 1. Durable receipts for server-witnessed credits --------------------------------------------
-- Starts EMPTY, which is deliberate: the sweep is forward-looking, so nothing from before this migration
-- can be judged (and nothing from the pre-nerf era can false-positive).
create table if not exists public.item_credit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  item_key   text not null,
  qty        bigint not null,
  source     text not null default 'credit',
  created_at timestamptz not null default now()
);
create index if not exists item_credit_log_user_key_idx on public.item_credit_log (user_id, item_key, created_at);
alter table public.item_credit_log enable row level security;
revoke all on public.item_credit_log from anon, authenticated;

-- Rebuild item_credit to write a receipt. THE SIGNATURE MUST NOT CHANGE. Adding a p_source parameter --
-- even with a DEFAULT -- would create an OVERLOAD rather than a replacement, and a 3-argument call from the
-- marketplace / guild_bank edge functions would then be ambiguous between the two ("function is not
-- unique"), breaking every market settlement and bank withdrawal. So the source is hardcoded and the three
-- arguments stay exactly as they were; no edge function needs redeploying.
-- Body is otherwise verbatim from 20260715050000_item_earned_total.
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
  -- The receipt. Best-effort: a logging failure must never fail a market settlement or bank withdrawal.
  begin
    insert into public.item_credit_log(user_id, item_key, qty, source)
      values (p_user, p_key, v_add, 'credit');
  exception when others then null;
  end;
  return v_qty;
end $$;

-- ---- 2. The delta snapshot -----------------------------------------------------------------------
create table if not exists public.item_earn_watch (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_key    text not null,
  earned_seen bigint not null,
  checked_at  timestamptz not null default now(),
  primary key (user_id, item_key)
);
alter table public.item_earn_watch enable row level security;
revoke all on public.item_earn_watch from anon, authenticated;

-- ---- 3. Tunables ---------------------------------------------------------------------------------
-- min_top: ignore small numbers, where a lucky roll looks like a ratio spike.
-- ratio  : required base-rarity growth per unit of top-rarity growth. 625 is the legitimate figure at the
--          0.0016 cap; 100 leaves a 6.25x margin so an unlucky-but-honest crafter is never flagged.
create or replace function public.item_unexplained_config()
returns table (min_top bigint, ratio bigint)
language sql immutable as $$ select 10::bigint, 100::bigint $$;

-- ---- 4. The sweep --------------------------------------------------------------------------------
-- Returns one row per flagged (user, family) so a human can read the output directly. p_enforce defaults
-- to FALSE and should stay false until a review of accumulated signals says otherwise.
--
-- Output columns are deliberately named flagged_* / item_family rather than user_id / family: a
-- RETURNS TABLE column becomes a plpgsql variable, and one sharing a name with a column in the query below
-- raises an ambiguous-reference error at runtime. Results are streamed with RETURN NEXT inside the loop, so
-- no temp table is involved -- ON COMMIT semantics inside a function are a trap not worth stepping in.
create or replace function public.item_unexplained_sweep(p_enforce boolean default false)
returns table (flagged_user uuid, flagged_username text, item_family text,
               top_client_reported bigint, base_client_reported bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_cfg record;
  v_row record;
  v_detail jsonb;
begin
  select * into v_cfg from public.item_unexplained_config();

  for v_row in
    with w as (
      -- Every equipment-family key, with its last-seen earned figure. A key never seen before is baselined
      -- at its CURRENT value, so its first delta is zero -- this is what makes the first run flag nothing.
      select p.user_id, p.item_key, p.earned_total,
             coalesce(v.earned_seen, p.earned_total) as seen,
             coalesce(v.checked_at, now()) as since
      from public.player_items p
      left join public.item_earn_watch v on v.user_id = p.user_id and v.item_key = p.item_key
      where p.item_key ~ '^(stweapon|bodyarmor|stshield|stward|stquiver|ring|amulet|relic|belt)_'
        and p.item_key ~ '_(normal|rare|supreme|fantastic)$'
        -- tool_, workshop_ and every leg* prefix are OUT: mastercrafted legendaries legitimately arrive at
        -- top rarity one at a time, with no sibling crafting, and would flag on sight.
    ),
    d as (
      select w.user_id, w.item_key, w.since,
             greatest(0, w.earned_total - w.seen) as delta,
             regexp_replace(w.item_key, '_(normal|rare|supreme|fantastic)$', '') as fam,
             (w.item_key ~ '_(supreme|fantastic)$') as is_top
      from w
    ),
    srv as (
      -- What the SERVER granted for this key since the last sweep: market settlements, bank withdrawals,
      -- cancelled-sell refunds. Anything above this was claimed by the client.
      select d.user_id, d.item_key, coalesce(sum(l.qty), 0)::bigint as credited
      from d
      left join public.item_credit_log l
        on l.user_id = d.user_id and l.item_key = d.item_key and l.created_at > d.since
      group by d.user_id, d.item_key
    ),
    cr as (
      select d.user_id, d.fam, d.is_top,
             greatest(0, d.delta - s.credited)::bigint as client_reported
      from d join srv s on s.user_id = d.user_id and s.item_key = d.item_key
    ),
    agg as (
      select cr.user_id, cr.fam,
             sum(case when cr.is_top then cr.client_reported else 0 end)::bigint as top_cr,
             sum(case when cr.is_top then 0 else cr.client_reported end)::bigint as base_cr
      from cr group by cr.user_id, cr.fam
    )
    select a.user_id as u, pr.username as uname, a.fam as f, a.top_cr as t, a.base_cr as b
    from agg a
    left join public.profiles pr on pr.id = a.user_id
    where a.top_cr >= v_cfg.min_top
      and a.base_cr < a.top_cr * v_cfg.ratio
    order by a.top_cr desc
  loop
    v_detail := jsonb_build_object(
      'family', v_row.f, 'top_client_reported', v_row.t,
      'base_client_reported', v_row.b, 'required_ratio', v_cfg.ratio);
    -- One signal per user per family per day, so a repeated sweep does not spam the table.
    if not exists (
      select 1 from public.clamp_signals s
      where s.user_id = v_row.u and s.kind = 'unexplained_rarity'
        and s.detail->>'family' = v_row.f
        and s.created_at > now() - interval '1 day'
    ) then
      insert into public.clamp_signals(user_id, kind, detail, would_clamp)
        values (v_row.u, 'unexplained_rarity', v_detail, true);
    end if;
    if p_enforce then
      insert into public.account_clamps(user_id, surfaces, clamped_until, auto, signal, clamped_by)
        values (v_row.u, array['marketplace','leaderboard','guild','chat'],
                now() + interval '10 years', true, v_detail, null)
        on conflict (user_id) do update
          set clamped_until = excluded.clamped_until, auto = true, signal = excluded.signal;
    end if;
    flagged_user := v_row.u; flagged_username := v_row.uname; item_family := v_row.f;
    top_client_reported := v_row.t; base_client_reported := v_row.b;
    return next;
  end loop;

  -- Advance the watermark for EVERY key examined, flagged or not, so the next sweep judges only new growth.
  insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
  select p.user_id, p.item_key, p.earned_total, now()
  from public.player_items p
  where p.item_key ~ '^(stweapon|bodyarmor|stshield|stward|stquiver|ring|amulet|relic|belt)_'
    and p.item_key ~ '_(normal|rare|supreme|fantastic)$'
  on conflict (user_id, item_key) do update
    set earned_seen = excluded.earned_seen, checked_at = excluded.checked_at;
end $$;

revoke execute on function public.item_unexplained_sweep(boolean) from anon, authenticated, public;
revoke execute on function public.item_unexplained_config() from anon, authenticated, public;

-- ---- HOW TO RUN IT ------------------------------------------------------------------------------
-- I cannot execute any of this here (no database in the build environment). Run in this order.
--
-- STEP 1 -- baseline. Flags nothing by design; it only records where everyone currently stands.
--     select * from public.item_unexplained_sweep(false);
--     -- EXPECT: zero rows. Any row here is a bug in the baselining, not a cheater.
--     select count(*) from public.item_earn_watch;   -- EXPECT: > 0, one row per equipment key held
--
-- STEP 2 -- let it run. Schedule it hourly (Database > Cron, or pg_cron directly):
--     select cron.schedule('item-unexplained-sweep', '7 * * * *',
--                          $job$ select public.item_unexplained_sweep(false) $job$);
--
-- STEP 3 -- review after a week. Every row is a candidate, NOT a verdict:
--     select s.created_at, pr.username, s.detail->>'family' as family,
--            s.detail->>'top_client_reported' as top, s.detail->>'base_client_reported' as base
--     from public.clamp_signals s left join public.profiles pr on pr.id = s.user_id
--     where s.kind = 'unexplained_rarity' order by s.created_at desc;
--
-- STEP 4 -- only if that review is clean (no real players in it), consider enforcing. Do it as a
--     deliberate, separate change -- edit the cron job to pass true -- never as a side effect of this
--     migration. A wrong clamp locks a player out of the marketplace, leaderboard, guild and chat.
--
-- TO STOP: select cron.unschedule('item-unexplained-sweep');
-- TO UNDO an enforced clamp: select public.clamp_clear('<user-uuid>');
