-- ============================================================================
-- UNEXPLAINED-RARITY SWEEP: A FIRST-TIME KEY IS GROWTH, NOT A BASELINE (2026-08-07).
--
-- THE LIVE FALSE NEGATIVE, third in this series. AndJustice4All injected exactly ONE Fantastic Signet of
-- the Wyrm into Test28 and the sweep flagged nothing again -- and this time H2 is not the cause. The
-- previous fix (20260805150000) is correct as far as it goes; the probe walks past it through a different
-- hole entirely.
--
-- THE MECHANISM. Growth is measured against public.item_earn_watch, and the `w` CTE read:
--     coalesce(v.earned_seen, p.earned_total) as seen      -- no watch row -> baseline at CURRENT value
-- so a key with NO watch row was baselined at whatever it currently holds and its first delta was ZERO.
-- The comment even said so ("this is what makes the first run flag nothing"). Injecting one unit of a key
-- the account has NEVER HELD therefore produces: item_sync creates the player_items row with
-- earned_total 1, the next sweep finds no watch row, baselines it at 1, computes growth 0, and has
-- nothing to judge. The watch row is then written at 1, so the injection is laundered into the baseline
-- and can never be flagged afterwards. No rarity rule, ratio or zero, can fire on a delta of zero.
--
-- WHY THIS SURVIVED TWO FIXES: THE VERIFICATION COULD NOT REPRODUCE THE PROBE. Both 20260804140000 and
-- 20260805150000 verify by picking an account that ALREADY HOLDS the fantastic key, snapping every
-- watermark to current, and then DECREMENTING earned_seen to simulate growth:
--     insert into item_earn_watch select user_id, item_key, earned_total ...   -- manufactures a baseline
--     update item_earn_watch set earned_seen = earned_seen - 1 ...             -- fakes the growth
-- That shape has a watch row by construction, which is precisely the condition the real probe lacks. The
-- test proved the rule arithmetic and never touched the path the injection actually takes. A verification
-- that cannot express the reported case is not evidence about it.
--
-- THE FIX: baseline PER ACCOUNT, not per key. "Do not flag an entire established inventory on the first
-- run" is an account-level concern, and it is satisfied by baselining only accounts with no watch rows at
-- all. Once an account is under watch, a key appearing for the first time did not exist at the last
-- sweep, so its full earned_total IS growth -- which is what makes a one-off injection of a fresh key
-- visible. (The unique-provenance sweep drafted the same day already draws the line this way; the two
-- detectors now agree on what "first run" means.)
--
-- ONE SUBTLETY THAT WOULD OTHERWISE CREATE A FALSE POSITIVE. For a first-time key, `since` must be the
-- ACCOUNT's last sweep, never now(). The server-credit subtraction joins item_credit_log on
-- created_at > since, so a since of now() would exclude the credit for a legitimate MARKET BUY or bank
-- withdrawal of a key the account never held, and an honest purchase of a fantastic Signet would flag.
-- With the account's last sweep, that credit is subtracted and the buy nets to zero client-reported.
--
-- ENFORCEMENT UNCHANGED: still called with p_enforce false by the cron job. This widens what the shadow
-- log SEES; it does not clamp anyone. Expect the first run after this to surface a genuine backlog --
-- every account's newly-appearing keys since its last sweep -- so read the first output as a population
-- snapshot, not as a list of cheaters.
-- ============================================================================

begin;

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
      -- Every equipment-family key, with its last-seen earned figure.
      -- SUPERSEDED (kept because it names the bug): "a key never seen before is baselined at its CURRENT
      -- value, so its first delta is zero". That was per-KEY, and it is what made a single injected
      -- fantastic invisible -- the injection became its own baseline.
      -- 20260807160000: baselining is PER-ACCOUNT, not per-key. A key with no watch row on an account
      -- that is ALREADY under watch did not exist at the last sweep, so its whole earned_total is growth
      -- and `seen` is 0. Only an account with no watch rows at all still baselines (its first sweep must
      -- flag nothing). `since` for such a key is the ACCOUNT's last sweep, never now() -- otherwise the
      -- server-credit subtraction window below would be empty and an honest market BUY of a first-time
      -- key would read as client-reported.
      select p.user_id, p.item_key, p.earned_total,
             coalesce(v.earned_seen,
                      case when aw.last_sweep is not null then 0 else p.earned_total end) as seen,
             coalesce(v.checked_at, aw.last_sweep, now()) as since
      from public.player_items p
      left join public.item_earn_watch v on v.user_id = p.user_id and v.item_key = p.item_key
      left join (select w2.user_id, max(w2.checked_at) as last_sweep
                   from public.item_earn_watch w2 group by w2.user_id) aw on aw.user_id = p.user_id
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
commit;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY. I cannot execute any of this here (no database in the build environment). The point of this
-- block is to reproduce THE PROBE'S ACTUAL SHAPE -- a key with NO watch row -- which is what the previous
-- two verifications could not express. Run it in a transaction you ROLL BACK.
--
--   begin;
--   -- Pick any account that is already under watch (i.e. not its first sweep).
--   select w.user_id as vu from public.item_earn_watch w group by w.user_id limit 1 \gset
--
--   -- Neutralize the window: every EXISTING watermark snaps to current, so only our injection is new.
--   insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
--     select user_id, item_key, earned_total, now() from public.player_items where user_id = :'vu'
--     on conflict (user_id, item_key) do update set earned_seen = excluded.earned_seen, checked_at = excluded.checked_at;
--
--   -- THE PROBE: one fantastic leg-accessory key the account has NEVER held, and deliberately NO watch
--   -- row for it. Pick a key that is absent from player_items for this user.
--   -- Columns are (user_id, item_key, qty, updated_at, earned_total) -- there is NO synced_at here, that
--   -- lives on player_item_meta. The key's doubled d4_d4_ is real: layer prefix + the item's own key.
--   insert into public.player_items(user_id, item_key, qty, earned_total)
--     values (:'vu', 'legring_d4_d4_wyrm_fantastic', 1, 1)
--     on conflict (user_id, item_key) do update set qty = 1, earned_total = 1;
--   delete from public.item_earn_watch where user_id = :'vu' and item_key = 'legring_d4_d4_wyrm_fantastic';
--
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--   -- OLD body: ZERO rows -- the reported false negative, baselined at 1 so growth reads 0.
--   -- NEW body: ONE row, family legring_d4, rule zero_base, fantastic 1 with zero non-fantastic growth.
--   -- NOTE: the 24h per-user-per-family dedupe means the sweep RETURNS the row but only POSTS to Discord
--   -- when the signal is new -- clear recent clamp_signals for this user+family first if you want the ping.
--   rollback;
--
-- SECOND CASE -- the honest buyer must NOT flag. Same fresh key, but with a server credit recorded, which
-- is what a marketplace purchase or bank withdrawal leaves behind:
--
--   begin;
--   -- ... same neutralize + insert as above, then:
--   insert into public.item_credit_log(user_id, item_key, qty, created_at)
--     values (:'vu', 'legring_d4_d4_wyrm_fantastic', 1, now());
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vu';
--   -- EXPECT: zero rows. The credit is subtracted, so client_reported is 0. If this flags, the `since`
--   -- fallback is wrong and honest buyers are being caught -- do not leave it in that state.
--   rollback;
--
-- THIRD CASE -- an account's genuine FIRST sweep must still flag nothing:
--
--   begin;
--   select w.user_id as vf from public.item_earn_watch w group by w.user_id limit 1 \gset
--   delete from public.item_earn_watch where user_id = :'vf';   -- no watch rows at all
--   select * from public.item_unexplained_sweep(false) where flagged_user = :'vf';
--   -- EXPECT: zero rows. Baselining an established inventory must remain silent.
--   rollback;
--
-- AFTER APPLYING. The cron job already calls this function by name, so nothing needs rescheduling.
-- Re-run AndJustice4All's probe against a fresh key and confirm the 07-past-the-hour sweep flags it.
