-- ============================================================================
-- UNEXPLAINED-RARITY SWEEP: H2 STOPS SUPPRESSING THE LEGENDARY-ACCESSORY FAMILIES (2026-08-05).
--
-- THE LIVE FALSE NEGATIVE. AndJustice4All's authorized probe injected ONE fake fantastic Signet of the
-- Wyrm at 10:38 AM and the 11:07 sweep flagged nothing. Two stacked causes:
--
--   1. THE WITNESS HOLE (client, fixed in v0.0.86.21): the probe signet was EQUIPPED ("installed").
--      equipLegRing decrements state.inventory, and item_sync's payload carries only qty>0 HELD keys --
--      so an accessory equipped within one 60-second sync window never appears in any snapshot, no
--      earned_total ever accrues, and the sweep has literally nothing to judge. The client now folds
--      WORN legendary accessories into every sync payload (wornLegendaryAccessoryKeys), so worn stock
--      is witnessed like held stock. (The same client patch fixed unequip minting phantom item ids for
--      D2-D4 accessories -- 'legring_d1_d4_wyrm_fantastic' -- which had been silently destroying them.)
--
--   2. THE SUPPRESSOR OVERREACH (this migration): even once witnessed, the zero rule would NOT have
--      fired. 20260804140000's H2 gates the zero arm on the whole ACCOUNT showing zero non-fantastic
--      growth in the window -- calibrated for high-velocity craftables, where an honest mass-crafter's
--      vendor-chaff loop erases same-family evidence between syncs. But any ACTIVE account (idle tasks
--      running, ordinary play) shows non-fantastic growth somewhere every window, so H2 blinds the
--      zero rule to a single injected fantastic on every account that is not completely idle. The
--      2026-08-04 claim that "the single-Signet shape still flags on sight" was only true of an
--      account doing nothing else -- the probe disproved it on sight.
--
-- THE SCOPE FIX. The legendary-accessory families (legring_/legamulet_/legcloak_, aggregated per layer:
-- legring_d4, ...) are FORGE output: a Mastercraft is a deliberate, expensive action yielding a random
-- item from the layer's set on the ordinary mostly-normal rarity roll. There is no 7-second craft loop
-- here, so the depletion mechanism H2 exists for (chaff vendored between syncs) cannot erase an honest
-- forger's same-family evidence: honest fantastic growth in a leg family arrives amid normal/rare
-- siblings in THAT family (H1's evidence), at forge cadence. So for leg* families ONLY, the zero arm
-- reverts to family-scoped evidence: fantastic growth with zero non-fantastic growth in the SAME layer
-- family flags regardless of what the rest of the account crafted. Every other family keeps H1+H2
-- unchanged -- the Valuren depletion false positive stays fixed.
--
-- ACCEPTED REVIEW NOISE, STATED PLAINLY -- THE WORN-ADOPTION WAVE. Client v0.0.86.21 makes every
-- veteran's first sync on the new build witness their WORN accessories at once. For an account whose
-- leg families are already under watch, a worn fantastic Signet appears as +1 fantastic with zero
-- non-fantastic family growth -- exactly this rule's shape -- so expect ONE wave of zero_base rows as
-- players pick up the build (typically 1-2 rows per veteran across legring/legamulet/legcloak, once,
-- then silence; the 24h per-user-per-family dedupe caps repeats). Wave rows are identifiable: rule
-- zero_base, a leg* family, fantastic count matching a full worn loadout, landing in the days after
-- the client deploy. The probe's fake signet will surface INSIDE AndJustice4All's wave row -- that is
-- the detection working, not noise. Accounts whose leg families were never watched baseline silently
-- (the watermark design), same as 20260803270000's coverage join.
--
-- The function body below is verbatim from 20260804140000 except the zero arm (both the projected
-- zero_hit and the WHERE clause) becomes:
--     (a.fant_cr >= 1 and a.nonf_cr = 0 and (ac.acct_nonf = 0 or a.fam like 'leg%'))
-- The return shape is unchanged; the hourly cron picks the body up by name, no job change.
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
        -- tool_ and workshop_ stay OUT; legring_/legamulet_/legcloak_ joined in 20260803270000 (they are
        -- the STACKABLE legendary accessories with ordinary rarity rolls -- see that migration's header).
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
             sum(case when cr.rar <> 'fantastic'             then cr.client_reported else 0 end)::bigint as nonf_cr
      from cr group by cr.user_id, cr.fam
    ),
    acct as (
      -- H2: the account's non-fantastic growth across EVERY swept family this window. An honest crafter
      -- is nearly always caught holding chaff somewhere at some sync instant; a pure injector is not.
      -- SCOPE (this migration): H2 corroborates high-velocity craftable families only. The leg*
      -- accessory families are forge output -- no chaff loop exists to erase their family evidence --
      -- so for them the family-scoped zero test stands alone (the 2026-08-05 probe's false negative).
      select a.user_id, sum(a.nonf_cr)::bigint as acct_nonf from agg a group by a.user_id
    )
    select a.user_id as u, pr.username as uname, a.fam as f, a.top_cr as t, a.base_cr as b,
           a.fant_cr as fc, a.nonf_cr as nfc, ac.acct_nonf as anf,
           (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio) as ratio_hit,
           (a.fant_cr >= 1 and a.nonf_cr = 0 and (ac.acct_nonf = 0 or a.fam like 'leg%')) as zero_hit
    from agg a
    join acct ac on ac.user_id = a.user_id
    left join public.profiles pr on pr.id = a.user_id
    where (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio)
       or (a.fant_cr >= 1 and a.nonf_cr = 0 and (ac.acct_nonf = 0 or a.fam like 'leg%'))
    order by a.top_cr desc
  loop
    v_detail := jsonb_build_object(
      'family', v_row.f, 'top_client_reported', v_row.t,
      'base_client_reported', v_row.b, 'required_ratio', v_cfg.ratio,
      'fantastic_client_reported', v_row.fc,
      'nonfantastic_family', v_row.nfc,          -- H4: the corroborating figures ride every signal
      'nonfantastic_account', v_row.anf,
      'rule', case when v_row.ratio_hit and v_row.zero_hit then 'ratio+zero_base'
                   when v_row.zero_hit then 'zero_base' else 'ratio' end);
    -- One signal per user per family per day, so a repeated sweep does not spam the table -- and so it
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
              then format('client-reported fantastic: **%s** with ZERO non-fantastic growth — family %s · account-wide %s (single-fantastic rule%s)',
                          v_row.fc, v_row.nfc, v_row.anf,
                          case when v_row.f like 'leg%' then '; forge family, account corroboration not required' else ', depletion-hardened' end)
              else format('client-reported top rarity: **%s**%sbase rarity: %s (honest crafting needs %s+) · account non-fantastic growth: %s',
                          v_row.t, chr(10), v_row.b, v_row.t * v_cfg.ratio, v_row.anf) end),
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
-- Three scenarios. B is the prove-the-guard-fails one: run it BEFORE applying and the OLD body returns
-- no row (the live false negative this migration answers); run it AFTER and it flags. A pins the
-- Valuren depletion fix still holding on ordinary families; C pins honest forge evidence still passing.
--
-- pg_net caveat (as every sweep verify): each sweep that inserts signals posts a Discord embed from a
-- background worker that SURVIVES the rollback. Run in a quiet hour.
--
--   begin;
--   -- Pick a victim holding a fantastic LEG-accessory key (worn ones appear after client v0.0.86.21).
--   select p.user_id as vu, p.item_key as vleg
--     from public.player_items p
--    where p.item_key ~ '^leg(ring|amulet|cloak)_d[0-9]+_.*_fantastic$' and p.earned_total >= 1
--    limit 1 \gset
--   -- Neutralize: every watermark for the account snaps to current, so the window holds only our fakes.
--   insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
--     select user_id, item_key, earned_total, now() from public.player_items where user_id = :'vu'
--     on conflict (user_id, item_key) do update set earned_seen = excluded.earned_seen, checked_at = excluded.checked_at;
--
--   -- B (THE PROBE SHAPE): +1 fantastic in the leg family, +5 normal in some ORDINARY family (an
--   -- active account). OLD body: zero rows (H2 suppressed -- the false negative). NEW body: one
--   -- zero_base row for the leg family.
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 1) where user_id = :'vu' and item_key = :'vleg';
--   update public.item_earn_watch w set earned_seen = greatest(0, w.earned_seen - 5)
--     where (w.user_id, w.item_key) = (
--       select user_id, item_key from public.player_items
--        where user_id = :'vu' and item_key ~ '_normal$' and item_key !~ '^leg' and earned_total >= 5 limit 1);
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--
--   -- A (Valuren regression): same +5 normal elsewhere, +1 fantastic in an ORDINARY family (not leg*).
--   -- BOTH bodies: zero rows -- H2 still suppresses depletion shapes off the forge families.
--
--   -- C (honest forge): +1 fantastic AND +3 normal in the SAME leg family. BOTH bodies: zero rows (H1).
--   rollback;
--
-- Quick is-it-applied probe (no side effects):
--   select prosrc like '%forge family, account corroboration not required%' as migration_applied
--     from pg_proc where proname = 'item_unexplained_sweep';
--
-- The hourly cron picks this body up by name. Signals from the worn-adoption wave (see header) are
-- expected in the first days after client v0.0.86.21 -- one-time rows per veteran; the probe's fake
-- Signet of the Wyrm will surface inside AndJustice4All's wave row.
