-- ============================================================================
-- UNEXPLAINED-RARITY SWEEP, HARDENING: THE DEPLETION FALSE POSITIVE (owner order, 2026-08-04).
--
-- THE FALSE POSITIVE, MECHANICALLY. The zero-base rule (20260803230000) assumed "zero normal growth in
-- the family means no crafting happened there". That is only true of crafting WITNESSED AT SYNC INSTANTS:
-- item_sync credits earned_total as greatest(0, reported_qty - ledger_qty), and the client payload only
-- carries keys with qty > 0 -- so a normal item crafted and vendored BETWEEN two 60-second syncs never
-- advances earned_total at all. A mass-crafter's honest loop is exactly that: keep the fantastics (their
-- qty rises across syncs, earned_total advances faithfully), vendor the normal chaff continuously (qty is
-- back at-or-below the ledger's figure by the next sync, credited = 0 forever). Result: "fantastic +N with
-- ZERO normal crafted" on ordinary play. Live evidence 2026-08-04: SEVEN zero_base rows in one sweep on
-- Valuren -- the same active account the progress-jump detector false-positived twice (v0.0.75). The rows
-- were shadow-only, but alarm fatigue in the review channel is its own failure.
--
-- THE HARDENING, TWO SUPPRESSORS ON THE ZERO RULE ONLY (the ratio rule is untouched -- it guards volume
-- and min_top = 10 already insulates it from single-roll noise):
--   H1  The family's crafting evidence broadens from ZERO NORMAL to ZERO NON-FANTASTIC growth
--       (normal + rare + supreme). Rares and supremes survive depletion far longer than normals
--       (enhance fodder, worth selling), so sibling evidence persists for honest crafters.
--   H2  Account-level corroboration: the zero rule fires only when the ACCOUNT shows zero non-fantastic
--       growth across ALL swept families in the window. An active honest crafter is nearly always caught
--       holding chaff somewhere at some sync instant; a pure injector mints top rarities only.
--   H4  The signal detail and the Discord digest carry the corroborating figures
--       (nonfantastic_family / nonfantastic_account), so surviving rows are one-glance reviewable.
-- (H3 -- lifetime family history as a suppressor -- was proposed and NOT taken: the owner chose H1+H2+H4.)
--
-- WHAT THIS KEEPS: the single-fantastic catch against a pure injection into an account showing no other
-- crafting -- the AndJustice4All probe shape (one fantastic Signet, nothing else) still flags on sight.
-- WHAT IT ACCEPTS, STATED PLAINLY: an injector who also holds a few honestly-crafted non-fantastic items
-- at sync time now evades the zero rule. That is the SAME documented evasion as before (faking base
-- growth), and base growth is exactly what the ratio rule then counts against them at volume.
--
-- Everything else -- the delta watermark, the server-credit subtraction, the one-signal-per-user-family-day
-- dedupe, the single-embed digest, the watermark-before-webhook ordering -- is unchanged from
-- 20260803230000 / 20260803270000. The function body below is verbatim from 20260803270000 except:
--   1. `agg` adds a nonf_cr bucket (everything but fantastic);
--   2. a new `acct` CTE sums nonf_cr per user across families;
--   3. the zero arm becomes (fant_cr >= 1 and nonf_cr = 0 and acct_nonf = 0);
--   4. the signal detail + digest line carry both corroborating figures (H4).
-- The return shape is unchanged (create or replace cannot alter it; the cron job keeps working untouched).
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
      select a.user_id, sum(a.nonf_cr)::bigint as acct_nonf from agg a group by a.user_id
    )
    select a.user_id as u, pr.username as uname, a.fam as f, a.top_cr as t, a.base_cr as b,
           a.fant_cr as fc, a.nonf_cr as nfc, ac.acct_nonf as anf,
           (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio) as ratio_hit,
           (a.fant_cr >= 1 and a.nonf_cr = 0 and ac.acct_nonf = 0) as zero_hit
    from agg a
    join acct ac on ac.user_id = a.user_id
    left join public.profiles pr on pr.id = a.user_id
    where (a.top_cr >= v_cfg.min_top and a.base_cr < a.top_cr * v_cfg.ratio)
       or (a.fant_cr >= 1 and a.nonf_cr = 0 and ac.acct_nonf = 0)
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
              then format('client-reported fantastic: **%s** with ZERO non-fantastic growth — family %s · account-wide %s (single-fantastic rule, depletion-hardened)',
                          v_row.fc, v_row.nfc, v_row.anf)
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
-- Three scenarios against one real account, each preceded by neutralizing that account's watermarks so
-- only the faked growth is in the window. A and B are the prove-the-guard-fails pair: run them BEFORE
-- applying and the OLD body flags both (false positives); run them AFTER and both come back clean.
-- C is the regression catch: a pure injection must STILL flag on a single fantastic.
--
-- pg_net caveat (as every sweep verify): each sweep that inserts signals posts a Discord embed from a
-- background worker that SURVIVES the rollback -- expect up to three amber digests (other accounts'
-- real pending growth is swept too; all their rows roll back). Run in a quiet hour.
--
--   begin;
--   -- Pick a victim account that owns a fantastic key whose family also has a rare sibling row.
--   -- (\gset needs psql; substitute literals if running elsewhere.)
--   select p.user_id as vu, p.item_key as vfant,
--          regexp_replace(p.item_key, '_fantastic$', '_rare') as vrare
--     from public.player_items p
--    where p.item_key ~ '_fantastic$' and p.earned_total >= 1
--      and exists (select 1 from public.player_items r
--                   where r.user_id = p.user_id
--                     and r.item_key = regexp_replace(p.item_key, '_fantastic$', '_rare')
--                     and r.earned_total >= 5)
--    limit 1 \gset
--   -- Neutralize: every watermark for the account snaps to current, so the window holds only our fakes.
--   insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
--     select user_id, item_key, earned_total, now() from public.player_items where user_id = :'vu'
--     on conflict (user_id, item_key) do update set earned_seen = excluded.earned_seen, checked_at = excluded.checked_at;
--
--   -- A (H1): +1 fantastic AND +5 rare in the SAME family -> the rare siblings are the crafting evidence.
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 1) where user_id = :'vu' and item_key = :'vfant';
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 5) where user_id = :'vu' and item_key = :'vrare';
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--   -- OLD body: one zero_base row (rares did not count as normal). NEW body: ZERO rows for the account.
--
--   -- B (H2): +1 fantastic in this family, +5 normal in a DIFFERENT family -> account corroboration.
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 1) where user_id = :'vu' and item_key = :'vfant';
--   update public.item_earn_watch w set earned_seen = greatest(0, w.earned_seen - 5)
--     where (w.user_id, w.item_key) = (
--       select user_id, item_key from public.player_items
--        where user_id = :'vu' and item_key ~ '_normal$' and earned_total >= 5
--          and regexp_replace(item_key, '_normal$', '') <> regexp_replace(:'vfant', '_fantastic$', '')
--        limit 1);
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--   -- OLD body: one zero_base row (the rule was family-scoped). NEW body: ZERO rows for the account.
--
--   -- C (regression -- the AndJustice4All probe shape): +1 fantastic and NOTHING else, anywhere.
--   update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 1) where user_id = :'vu' and item_key = :'vfant';
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--   -- BOTH bodies: exactly one row, detail {"rule":"zero_base","fantastic_client_reported":1,
--   -- "nonfantastic_family":0,"nonfantastic_account":0,...}. NOTE the 24h per-user-per-family dedupe:
--   -- scenario C reuses the family from A/B, but A and B inserted NO signal for this account under the
--   -- new body, so C's insert is not suppressed. (Under the OLD body, A's signal WOULD dedupe B and C --
--   -- expect the old-body run to show the row in A only.)
--   rollback;
--
-- Quick is-it-applied probe (no side effects):
--   select prosrc like '%acct_nonf%' as migration_applied from pg_proc where proname = 'item_unexplained_sweep';
--
-- The cron job needs no change; it calls item_unexplained_sweep(false) by name and picks this body up on
-- its next hourly run. Old signal rows are identifiable by `not (detail ? 'nonfantastic_account')` --
-- keep them, they are the false-positive evidence this hardening answers.
