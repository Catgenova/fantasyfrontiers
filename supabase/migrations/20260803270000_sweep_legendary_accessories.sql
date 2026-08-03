-- ============================================================================
-- UNEXPLAINED-RARITY SWEEP, COVERAGE FIX: LEGENDARY ACCESSORIES (owner order, 2026-08-03).
--
-- AndJustice4All's authorized probe: one Fantastic Signet of the Wyrm injected at 1:36 PM, and the sweep
-- stayed silent while a real player's lucky ward-craft pinged minutes later. The blind spot is the sweep's
-- own exclusion: "every leg* prefix is OUT: mastercrafted legendaries legitimately arrive at top rarity one
-- at a time, with no sibling crafting". That reasoning is TRUE for legendary GEAR and SET PIECES -- but
-- those are minted as UNIQUES (state.uniqueItems, floored at Rare) and never enter player_items at all, so
-- excluding them by prefix excluded nothing... except the one leg* group that IS in the ledger: the
-- stackable legendary ACCESSORIES (legring_/legamulet_/legcloak_, rarity-suffixed), which Blueprint forges
-- add to the ordinary inventory. The exclusion swept the Signets out with the ghosts.
--
-- Accessories fit the sweep's discriminator fine: rollMastercraftRarity uses the unified per-rarity
-- chances, so an honest forge is overwhelmingly Normal (fantastic <= 0.16% at cap) -- sibling growth
-- exists, exactly like ordinary crafting. ONE WRINKLE: each Blueprint forge yields a RANDOM accessory from
-- its dungeon layer's set, so an honest fantastic's specific item usually has no same-item siblings in the
-- window. Hence accessories aggregate per LAYER FAMILY (legring_d4, legamulet_d2, ...) rather than per
-- item: an honest forging streak banks Normal growth across the layer's set and stays clean, while an
-- injector who mints only the valuable rarity still has a zero-Normal family and trips the zero-base rule
-- -- precisely the probe's shape.
--
-- BASELINE CAVEAT, stated up front: newly-covered keys are BASELINED on their first sweep (first delta
-- zero, flags nothing) -- the watermark design. The already-injected probe Signet is therefore out of
-- scope for the sweep and should be cleaned up by hand; only growth AFTER this migration is judged.
--
-- Everything else is verbatim from 20260803230000 (zero-base rule, per-rarity buckets, dedupe, digest,
-- watermark-before-webhook ordering). Changes: the key-prefix regex gains the three accessory prefixes
-- (BOTH in the scan and the watermark advance -- they must stay identical or unscanned keys never
-- baseline), and fam groups accessories per layer.
-- ============================================================================

create or replace function public.item_unexplained_sweep(p_enforce boolean default false)
returns table (flagged_user uuid, flagged_username text, item_family text,
               top_client_reported bigint, base_client_reported bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_cfg record;
  v_row record;
  v_detail jsonb;
  v_new boolean;
  v_fields jsonb := '[]'::jsonb;
  v_count int := 0;
  v_shown int;
  v_url text;
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
      where p.item_key ~ '^(stweapon|bodyarmor|stshield|stward|stquiver|ring|amulet|relic|belt|legring|legamulet|legcloak)_'
        and p.item_key ~ '_(normal|rare|supreme|fantastic)$'
        -- tool_ and workshop_ stay OUT. Legendary GEAR and set pieces are uniques and never appear in
        -- player_items; the legring_/legamulet_/legcloak_ ACCESSORIES do, and are now covered.
    ),
    d as (
      select w.user_id, w.item_key, w.since,
             greatest(0, w.earned_total - w.seen) as delta,
             -- Accessories aggregate per LAYER family (legring_d4, ...): a Blueprint forge yields a random
             -- item from the layer's set, so same-item siblings are structurally absent for honest forges.
             case when w.item_key ~ '^leg(ring|amulet|cloak)_d[0-9]+_'
                  then substring(w.item_key from '^(leg(?:ring|amulet|cloak)_d[0-9]+)_')
                  else regexp_replace(w.item_key, '_(normal|rare|supreme|fantastic)$', '') end as fam,
             substring(w.item_key from '_(normal|rare|supreme|fantastic)$') as rar
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
      select d.user_id, d.fam, d.rar,
             greatest(0, d.delta - s.credited)::bigint as client_reported
      from d join srv s on s.user_id = d.user_id and s.item_key = d.item_key
    ),
    agg as (
      select cr.user_id, cr.fam,
             sum(case when cr.rar in ('supreme','fantastic') then cr.client_reported else 0 end)::bigint as top_cr,
             sum(case when cr.rar in ('normal','rare')       then cr.client_reported else 0 end)::bigint as base_cr,
             sum(case when cr.rar = 'fantastic'              then cr.client_reported else 0 end)::bigint as fant_cr,
             sum(case when cr.rar = 'normal'                 then cr.client_reported else 0 end)::bigint as norm_cr
      from cr group by cr.user_id, cr.fam
    )
    select a.user_id as u, pr.username as uname, a.fam as f, a.top_cr as t, a.base_cr as b,
           a.fant_cr as fc, a.norm_cr as nc,
           (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio) as ratio_hit,
           (a.fant_cr >= 1 and a.norm_cr = 0) as zero_hit
    from agg a
    left join public.profiles pr on pr.id = a.user_id
    where (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio)
       or (a.fant_cr >= 1 and a.norm_cr = 0)
    order by a.top_cr desc
  loop
    v_detail := jsonb_build_object(
      'family', v_row.f, 'top_client_reported', v_row.t,
      'base_client_reported', v_row.b, 'required_ratio', v_cfg.ratio,
      'fantastic_client_reported', v_row.fc, 'normal_client_reported', v_row.nc,
      'rule', case when v_row.ratio_hit and v_row.zero_hit then 'ratio+zero_base'
                   when v_row.zero_hit then 'zero_base' else 'ratio' end);
    -- One signal per user per family per day, so a repeated sweep does not spam the table -- and, now, so it
    -- does not re-ping Discord either. The digest below reports exactly the signals inserted by THIS run.
    v_new := not exists (
      select 1 from public.clamp_signals s
      where s.user_id = v_row.u and s.kind = 'unexplained_rarity'
        and s.detail->>'family' = v_row.f
        and s.created_at > now() - interval '1 day'
    );
    if v_new then
      insert into public.clamp_signals(user_id, kind, detail, would_clamp)
        values (v_row.u, 'unexplained_rarity', v_detail, true);
      v_count := v_count + 1;
      if jsonb_array_length(v_fields) < 20 then
        v_fields := v_fields || jsonb_build_array(jsonb_build_object(
          'name', left(coalesce(replace(v_row.uname, '`', ''), v_row.u::text), 250),
          'value', format('`%s`%s%s', v_row.f, chr(10),
            case when v_row.zero_hit and not v_row.ratio_hit
              then format('client-reported fantastic: **%s** with ZERO normal crafted in the family (single-fantastic rule)', v_row.fc)
              else format('client-reported top rarity: **%s**%sbase rarity: %s (honest crafting needs %s+)',
                          v_row.t, chr(10), v_row.b, v_row.t * v_cfg.ratio) end),
          'inline', false));
      end if;
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
  -- The regex here MUST match the scan's exactly -- a key scanned but not watermarked would re-flag its
  -- whole history every hour; one watermarked but not scanned would never be judged at all.
  insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
  select p.user_id, p.item_key, p.earned_total, now()
  from public.player_items p
  where p.item_key ~ '^(stweapon|bodyarmor|stshield|stward|stquiver|ring|amulet|relic|belt|legring|legamulet|legcloak)_'
    and p.item_key ~ '_(normal|rare|supreme|fantastic)$'
  on conflict (user_id, item_key) do update
    set earned_seen = excluded.earned_seen, checked_at = excluded.checked_at;

  -- The digest. LAST, and swallowed: the watermarks above are already written, and a webhook outage must not
  -- roll them back. Nothing is sent on a clean sweep.
  if v_count > 0 then
    begin
      v_url := public.item_sweep_webhook();
      if v_url is not null and v_url <> '' then
        v_shown := jsonb_array_length(v_fields);
        if v_count > v_shown then
          v_fields := v_fields || jsonb_build_array(jsonb_build_object(
            'name', format('+ %s more not shown', v_count - v_shown),
            'value', 'select * from public.clamp_signals where kind = ''unexplained_rarity'' order by created_at desc',
            'inline', false));
        end if;
        perform net.http_post(
          url  := v_url,
          body := jsonb_build_object(
            'username', 'Fantasy Frontiers Moderation',
            -- Player-chosen usernames go into this payload; never let one ping the channel.
            'allowed_mentions', jsonb_build_object('parse', jsonb_build_array()),
            'embeds', jsonb_build_array(jsonb_build_object(
              'title', format('🔎 %s unexplained top-rarity signal%s',
                              v_count, case when v_count = 1 then '' else 's' end),
              'description', case when p_enforce
                then '**ENFORCING** - the accounts below have been clamped by this sweep.'
                else 'Shadow mode - nothing has been clamped. These are candidates for review, not verdicts: legitimate crafting is also client-reported.' end,
              'color', case when p_enforce then 15158332 else 15844367 end,   -- red / amber
              'fields', v_fields,
              'footer', jsonb_build_object(
                'text', 'item_unexplained_sweep - growth since the last sweep, minus server-witnessed credits'),
              'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ))
          ),
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
      end if;
    exception when others then null;
    end;
  end if;
end $$;

revoke execute on function public.item_unexplained_sweep(boolean) from anon, authenticated, public;

-- ---- HOW TO VERIFY (run after applying; rolls back, writes nothing durable) ------------------------
-- Re-run the exact probe that exposed the gap. FIRST let one scheduled sweep pass (or run
-- select * from public.item_unexplained_sweep(false) once) so the new accessory keys are baselined --
-- during that same run AndJustice4All's already-injected Signet gets absorbed into the baseline, which
-- is expected (see the caveat above). THEN:
--
--   begin;
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 1)
--     where (user_id, item_key) = (
--       select user_id, item_key from public.player_items
--        where item_key ~ '^legring_.*_fantastic$' and earned_total >= 1 limit 1);
--   select * from public.item_unexplained_sweep(false);
--   -- EXPECT: one zero_base row whose family reads like 'legring_d4', plus one amber Discord embed.
--   -- BEFORE this migration the same probe returns nothing: leg* keys were not scanned at all.
--   rollback;
