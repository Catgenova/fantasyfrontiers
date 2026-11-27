-- ============================================================================
-- SHADOW SIGNALS -> DISCORD. One hourly digest for every detector that writes clamp_signals but has no
-- notification of its own (ticket-0163 follow-up).
--
-- WHY THIS EXISTS. Two detectors shipped this week and both are silent:
--   * save_game's forged-unique validator inserts kind 'unique_forged' from the edge function.
--   * unique_provenance_sweep inserts kind 'unique_provenance' from pg_cron.
-- Neither reaches Discord. The account_clamps trigger (20260724240000) fires on real CLAMPS, and the digest
-- in 20260731220000 is written inside item_unexplained_sweep's own body, so it covers that sweep only. A
-- shadow-only detector that nobody hears about is indistinguishable from a detector that is not running,
-- which is the lesson that migration opened with: nobody reads a table.
--
-- WHY A SEPARATE DIGEST RATHER THAN A COPY IN EACH DETECTOR. Two of the three signal writers are not SQL:
-- 'unique_forged' comes from a Deno edge function, which has no access to app_config (RLS-locked,
-- service-role only, and the function would have to hold the webhook itself -- exactly what we do not want
-- in more places than necessary). Reading clamp_signals after the fact covers SQL and edge writers with one
-- mechanism, and a future shadow kind is one array entry rather than another copy of a POST block.
--
-- THE FOUR THINGS THAT WOULD MAKE THIS USELESS, and what is done instead. The first three are inherited
-- verbatim from 20260731220000 because they were learned the hard way there:
--
--   1. ONE POST PER ROW rate-limits itself away (Discord caps ~5/sec, 30/min). One embed per run, field list
--      truncated at 20, with a "+N more" pointer at the runbook query.
--   2. A POST EVERY HOUR REGARDLESS is how a channel becomes wallpaper. Nothing is sent on a clean hour.
--      Silence is therefore ambiguous BY DESIGN: to confirm the job is alive, read pg_cron's log, not the
--      channel. The runbook at the bottom has the query.
--   3. USERNAMES ARE PLAYER-CHOSEN and go straight into the payload. allowed_mentions is pinned to
--      {parse: []} and backticks are stripped, matching both existing notifiers and the public feed.
--   4. NEW-KIND BACKLOG. A kind added to this digest later must not dump its entire history into the channel
--      on the first run. Each kind carries its own watermark row, and a kind with no row BASELINES at now()
--      and reports nothing that run -- the same first-run rule the item and provenance sweeps use.
--
-- ORDERING, and an honest limit. The watermark advances AFTER the POST is enqueued, so a run that throws
-- before enqueuing retries next hour. But pg_net is FIRE AND FORGET: net.http_post queues the request and
-- returns immediately, so a webhook that answers 404 or 429 is not visible here and that hour's digest is
-- simply lost. The rows themselves are never lost -- clamp_signals is the durable record and the runbook
-- query below is the real source of truth. Treat Discord as a tap on the shoulder, never as the ledger.
--
-- WEBHOOK: reuses public.item_sweep_webhook() (the 'sweep_webhook' override, falling back to
-- app_config.clamp_webhook). Unset -> this runs and posts nothing, and still advances the watermarks so
-- configuring it later does not replay weeks of history. It posts usernames beside cheat signals, so that
-- webhook must point at a PRIVATE channel. It is NOT the community feed webhook.
-- ============================================================================

begin;

-- ---- 1. Per-kind watermark ------------------------------------------------------------------------
-- One row per signal kind this digest covers. Mirrors item_earn_watch / unique_watch: a kind with no row
-- has never been digested, so its first run baselines instead of reporting.
create table if not exists public.shadow_digest_watch (
  kind      text primary key,
  last_sent timestamptz not null default now()
);
alter table public.shadow_digest_watch enable row level security;
revoke all on public.shadow_digest_watch from anon, authenticated;

-- ---- 2. Which kinds are digested ------------------------------------------------------------------
-- Shadow-only detectors. Deliberately NOT listed here:
--   * 'unexplained_rarity' -- item_unexplained_sweep posts its own digest; listing it would double-notify.
--   * anything that already writes account_clamps -- the account_clamp_notify trigger covers real clamps.
create or replace function public.shadow_digest_kinds()
returns text[] language sql immutable as $$
  select array['unique_forged', 'unique_provenance']::text[]
$$;

-- ---- 3. One-line summary per kind -----------------------------------------------------------------
-- The two detectors store different detail shapes, so the digest renders each on its own terms rather than
-- dumping raw jsonb into an embed field (which truncates at 1024 chars and reads as noise).
create or replace function public.shadow_digest_line(p_kind text, p_detail jsonb)
returns text language sql immutable as $$
  select case p_kind
    when 'unique_forged' then format(
      '**%s** of %s uniques failed validation%sreasons: %s%s%s',
      coalesce(p_detail->>'finding_count', '?'),
      coalesce(p_detail->>'uniques_checked', '?'),
      chr(10),
      coalesce((select string_agg(k || ' x' || v, ', ' order by k)
                  from jsonb_each_text(coalesce(p_detail->'by_reason', '{}'::jsonb)) as e(k, v)), 'none'),
      chr(10),
      coalesce('first: `' || replace((p_detail->'sample'->0->>'base'), '`', '') || '`', ''))
    when 'unique_provenance' then format(
      'appeared fully formed: `%s`%s+%s with %s enchant lines',
      replace(coalesce(p_detail->>'base', '?'), '`', ''), chr(10),
      coalesce(p_detail->>'enhance', '?'), coalesce(p_detail->>'enchants', '?'))
    else left(p_detail::text, 900)
  end
$$;

-- ---- 4. The digest -------------------------------------------------------------------------------
-- Returns the number of signals reported, so a manual run says something useful instead of nothing.
create or replace function public.shadow_signal_digest()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kinds  text[] := public.shadow_digest_kinds();
  v_kind   text;
  v_row    record;
  v_fields jsonb := '[]'::jsonb;
  v_count  int := 0;
  v_shown  int;
  v_url    text;
  v_live   text[] := array[]::text[];
begin
  -- Baseline any kind we have never digested, and collect the ones that are live this run.
  foreach v_kind in array v_kinds loop
    if not exists (select 1 from public.shadow_digest_watch w where w.kind = v_kind) then
      insert into public.shadow_digest_watch(kind, last_sent) values (v_kind, now())
        on conflict (kind) do nothing;
    else
      v_live := v_live || v_kind;
    end if;
  end loop;
  if array_length(v_live, 1) is null then return 0; end if;

  for v_row in
    select s.kind, s.created_at, s.detail, s.would_clamp,
           coalesce(pr.username, s.user_id::text) as uname
    from public.clamp_signals s
    join public.shadow_digest_watch w on w.kind = s.kind
    left join public.profiles pr on pr.id = s.user_id
    where s.kind = any(v_live)
      and s.created_at > w.last_sent
    order by s.created_at
  loop
    v_count := v_count + 1;
    if jsonb_array_length(v_fields) < 20 then
      v_fields := v_fields || jsonb_build_array(jsonb_build_object(
        'name', left(replace(v_row.uname, '`', ''), 250) || '  (' || v_row.kind || ')',
        'value', left(public.shadow_digest_line(v_row.kind, v_row.detail), 1000),
        'inline', false));
    end if;
  end loop;

  if v_count = 0 then
    -- Clean hour. Advance anyway (there is nothing to carry) and stay silent.
    update public.shadow_digest_watch set last_sent = now() where kind = any(v_live);
    return 0;
  end if;

  v_url := public.item_sweep_webhook();
  if v_url is not null and v_url <> '' then
    v_shown := jsonb_array_length(v_fields);
    if v_count > v_shown then
      v_fields := v_fields || jsonb_build_array(jsonb_build_object(
        'name', format('+ %s more not shown', v_count - v_shown),
        'value', 'select * from public.clamp_signals where kind = any(public.shadow_digest_kinds()) order by created_at desc',
        'inline', false));
    end if;
    perform net.http_post(
      url  := v_url,
      body := jsonb_build_object(
        'username', 'Fantasy Frontiers Moderation',
        -- Player-chosen usernames go into this payload; never let one ping the channel.
        'allowed_mentions', jsonb_build_object('parse', jsonb_build_array()),
        'embeds', jsonb_build_array(jsonb_build_object(
          'title', format('%s shadow item signal%s', v_count, case when v_count = 1 then '' else 's' end),
          'description', 'Shadow mode. Nothing has been clamped and nothing has been removed from any save. '
                      || 'These are candidates for review, not verdicts: a guild-bank withdrawal and a market '
                      || 'collection both look like a fully formed arrival until those transfers are logged.',
          'color', 15844367,   -- amber, matching the other shadow digest
          'fields', v_fields,
          'footer', jsonb_build_object('text', 'shadow_signal_digest - clamp_signals since the last digest'),
          'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ))
      ),
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  end if;

  -- After the enqueue, so a run that throws earlier retries next hour. See the fire-and-forget note above:
  -- an HTTP-level failure is NOT visible here, and clamp_signals remains the durable record either way.
  update public.shadow_digest_watch set last_sent = now() where kind = any(v_live);
  return v_count;
end $$;

revoke execute on function public.shadow_signal_digest() from anon, authenticated, public;
revoke execute on function public.shadow_digest_kinds() from anon, authenticated, public;
revoke execute on function public.shadow_digest_line(text, jsonb) from anon, authenticated, public;

commit;

-- ---------------------------------------------------------------------------------------------------
-- RUNBOOK. I cannot execute any of this here (no database in the build environment).
--
-- STEP 1 -- baseline. Reports nothing by design; it only records where each kind currently stands, so the
--     backlog of signals already in the table is not replayed into the channel.
--     select public.shadow_signal_digest();       -- EXPECT: 0
--     select * from public.shadow_digest_watch;   -- EXPECT: one row per kind, last_sent = now()
--
-- STEP 2 -- prove the pipe. This is the part that has been missed twice: a guard must be shown to FIRE
--     before it is trusted to stay quiet. Insert one fake signal against your own test account, run the
--     digest, and confirm the embed lands in the private channel. Then delete the row.
--     insert into public.clamp_signals(user_id, kind, detail, would_clamp)
--     select id, 'unique_provenance',
--            jsonb_build_object('uid','u999','base','stweapon_greatsword_t20_fantastic',
--                               'enhance',15,'enchants',4,'note','digest pipe test'),
--            false
--     from public.profiles where username = 'Test28';
--     select public.shadow_signal_digest();   -- EXPECT: 1, and one embed in the channel
--     delete from public.clamp_signals where detail->>'note' = 'digest pipe test';
--     -- If the count is 1 but no embed arrives, the webhook is the problem, not the detector:
--     select coalesce(nullif(public.item_sweep_webhook(), ''), '(unset)') is not null as webhook_configured;
--
-- STEP 3 -- schedule hourly, offset from the sweeps so a webhook burst is not three jobs deep. The item
--     sweep runs at :00 and the provenance sweep at :23, so the digest reads them both at :35.
--     select cron.schedule('shadow-signal-digest', '35 * * * *',
--                          $job$ select public.shadow_signal_digest() $job$);
--
-- STEP 4 -- confirm the job is alive on a quiet week (silence is ambiguous by design):
--     select j.jobname, d.start_time, d.status, d.return_message
--     from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--     where j.jobname in ('shadow-signal-digest','unique-provenance-sweep')
--     order by d.start_time desc limit 20;
--
-- STEP 5 -- the durable record, which does not depend on Discord at all:
--     select s.created_at, pr.username, s.kind, s.detail
--     from public.clamp_signals s left join public.profiles pr on pr.id = s.user_id
--     where s.kind = any(public.shadow_digest_kinds())
--     order by s.created_at desc limit 50;
