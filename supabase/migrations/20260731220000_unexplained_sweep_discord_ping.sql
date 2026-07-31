-- ============================================================================
-- UNEXPLAINED-RARITY SWEEP -> DISCORD. The hourly sweep (20260731200000) writes rows to clamp_signals and
-- nobody reads a table, so it now posts a DIGEST to the moderation webhook. Still shadow-only: this changes
-- who hears about a signal, not what happens to the account.
--
-- THREE THINGS THAT WOULD HAVE MADE THIS USELESS, and what is done instead:
--
--   1. ONE POST PER FLAGGED ROW would rate-limit itself away. Discord webhooks cap around 5 requests/sec and
--      30/min; the first sweep after a rarity-rate change could flag dozens of (user, family) pairs and most
--      posts would 429 and vanish. So the sweep accumulates the run's flags and posts ONE embed, with the
--      field list truncated at 20 (Discord allows 25 fields / 6000 chars per embed) and a "+N more" pointer.
--
--   2. A POST EVERY HOUR REGARDLESS would be 24 pings/day of "nothing found", which is how a channel becomes
--      wallpaper. Nothing is posted on a clean sweep. Silence is therefore ambiguous by design -- to confirm
--      the job is alive, read pg_cron's own log (see the runbook at the bottom), not the Discord channel.
--
--   3. RE-POSTING A STANDING FLAG. The ping is tied to the clamp_signals INSERT, which is already deduped to
--      one row per user per family per day, so a player can generate at most one ping per family per day.
--      That dedupe is also why re-running the sweep by hand does not re-notify. And because the watermark
--      advances on EVERY sweep, a flag that appears again tomorrow is new growth, not the same growth
--      re-measured -- worth a second ping.
--
-- ORDERING, which matters: the POST happens AFTER the watermark advance and inside its own exception block.
-- If it ran before, or unguarded, a webhook outage would abort the function and roll back the watermarks --
-- losing the whole run's baseline and re-flagging everyone next hour. A notification problem must never cost
-- us the measurement.
--
-- WEBHOOK: reuses app_config.clamp_webhook (same audience -- it posts usernames beside cheat signals, so it
-- belongs in a private channel), with an optional 'sweep_webhook' override if you want the shadow signals
-- separated from real clamps. Unset -> the sweep runs and posts nothing, exactly as before.
--
-- Also fixed here, in notify_clamp_discord: allowed_mentions was not pinned. Usernames are player-chosen and
-- go straight into the payload, so a name containing @everyone could have been used to ping the channel. Both
-- notifiers now send allowed_mentions {parse: []} and strip backticks from names, matching what the
-- discord_feed edge function already does for the public feed.
-- ============================================================================

-- Which webhook the sweep digest goes to. Override key first, clamp webhook as the default.
create or replace function public.item_sweep_webhook()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value from public.app_config where key = 'sweep_webhook' and coalesce(value, '') <> ''),
    (select value from public.app_config where key = 'clamp_webhook')
  )
$$;
revoke execute on function public.item_sweep_webhook() from anon, authenticated, public;

-- ---- The sweep, re-issued with the digest ---------------------------------------------------------
-- Body is verbatim from 20260731200000 except for the v_new / v_fields / v_count accumulation in the loop
-- and the POST block at the end. Return type is unchanged (create or replace cannot alter it).
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
          'value', format('`%s`%sclient-reported top rarity: **%s**%sbase rarity: %s (honest crafting needs %s+)',
                          v_row.f, chr(10), v_row.t, chr(10), v_row.b, v_row.t * v_cfg.ratio),
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
  insert into public.item_earn_watch(user_id, item_key, earned_seen, checked_at)
  select p.user_id, p.item_key, p.earned_total, now()
  from public.player_items p
  where p.item_key ~ '^(stweapon|bodyarmor|stshield|stward|stquiver|ring|amulet|relic|belt)_'
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

-- ---- Pin allowed_mentions on the clamp notifier too ----------------------------------------------
-- Verbatim from 20260724240000 apart from allowed_mentions and the backtick strip on the username.
create or replace function public.notify_clamp_discord()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_url      text;
  v_name     text;
  v_kind     text;
  v_surfaces text;
  v_reason   text;
  v_body     jsonb;
begin
  select value into v_url from public.app_config where key = 'clamp_webhook';
  if v_url is null or v_url = '' then return new; end if;   -- not configured -> no-op

  v_name     := replace(coalesce((select username from public.profiles where id = new.user_id),
                                 new.user_id::text), '`', '');
  v_kind     := case when new.auto then 'Auto-detected' else 'Manual' end;
  v_surfaces := coalesce(nullif(array_to_string(new.surfaces, ', '), ''), '—');
  v_reason   := left(coalesce(new.reason, new.signal::text, '—'), 1000);

  v_body := jsonb_build_object(
    'username', 'Fantasy Frontiers Moderation',
    'allowed_mentions', jsonb_build_object('parse', jsonb_build_array()),
    'embeds', jsonb_build_array(jsonb_build_object(
      'title', '⛔ Account clamped',
      'color', 15158332,   -- red (0xE74C3C)
      'fields', jsonb_build_array(
        jsonb_build_object('name', 'Player',   'value', v_name,     'inline', true),
        jsonb_build_object('name', 'Type',     'value', v_kind,     'inline', true),
        jsonb_build_object('name', 'Surfaces', 'value', v_surfaces, 'inline', false),
        jsonb_build_object('name', 'Reason',   'value', v_reason,   'inline', false)
      ),
      'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ))
  );

  perform net.http_post(
    url     := v_url,
    body    := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
exception when others then
  return new;   -- never let a webhook problem block a clamp
end $$;

-- ============================================================================
-- RUNBOOK
--
-- 1. OPTIONAL, only if you want the shadow signals in a different channel from real clamps. Run it
--    SEPARATELY, never as part of a tracked migration, so the URL never enters git:
--      insert into public.app_config (key, value)
--        values ('sweep_webhook', 'https://discord.com/api/webhooks/XXXX/YYYY')
--        on conflict (key) do update set value = excluded.value;
--    Skip it and the digest goes to clamp_webhook.
--
-- 2. PROVE THE PING FIRES BEFORE TRUSTING THE SILENCE. A notifier nobody has watched deliver is not a
--    notifier -- and this one is deliberately silent on a clean sweep, so "no message" proves nothing.
--    Rewind one account's watermark to fake growth, sweep, and watch the channel. Rolls back, writes nothing:
--
--      begin;
--      update public.item_earn_watch set earned_seen = greatest(0, earned_seen - 500)
--        where (user_id, item_key) = (
--          select user_id, item_key from public.player_items
--           where item_key ~ '_(supreme|fantastic)$' and earned_total >= 500 limit 1);
--      select * from public.item_unexplained_sweep(false);   -- EXPECT: 1 row, and one Discord message
--      rollback;
--
--    The message is sent by pg_net from a background worker, so it survives the rollback -- that is the
--    point of the test. The clamp_signals row and the watermark change do not.
--
-- 3. SCHEDULE IT (pg_cron is now enabled). Minute 7 keeps it off the top-of-hour crowd:
--      select cron.schedule('item-unexplained-sweep', '7 * * * *',
--                           $job$ select public.item_unexplained_sweep(false) $job$);
--
-- 4. CONFIRM IT IS ALIVE -- from pg_cron's log, NOT from the Discord channel, which stays quiet when clean:
--      select jobid, runid, status, return_message, start_time
--      from cron.job_run_details
--      where jobid = (select jobid from cron.job where jobname = 'item-unexplained-sweep')
--      order by start_time desc limit 10;
--    EXPECT: status 'succeeded' once an hour.
--
-- 5. ENFORCEMENT stays a separate, deliberate decision after a week of clean review -- edit the cron job to
--    pass true. Until then every ping is amber and says so.
--      TO STOP:  select cron.unschedule('item-unexplained-sweep');
--      TO UNDO:  select public.clamp_clear('<user-uuid>');
-- ============================================================================
