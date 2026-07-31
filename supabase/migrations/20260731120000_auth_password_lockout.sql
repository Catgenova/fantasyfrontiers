-- ============================================================================
-- PASSWORD SPRAYING DEFENCE — per-account lockout with exponential backoff, at the auth layer.
--
-- Ticket (ITxToxic, 28-29 Jul): password spraying against the token endpoint. Rapid-fire is throttled by
-- Supabase's own limiter, but a lucky credential pair still yields a JWT immediately, with no second
-- protection and no lockout. This adds the missing layer.
--
-- WHY A HOOK AND NOT A RATE LIMITER. Login does NOT go through our Edge Functions -- the client calls
-- GoTrue's token endpoint directly (index.html: chatClient.auth.signInWithPassword). So public.rl_hit(),
-- which guards every custom function we own (wallet, items, marketplace, guild_bank, save_game, register),
-- cannot see login at all. It is the one entry point our own limiter is blind to.
--
-- WHY NOT THE AUDIT LOG. The obvious alternative -- watch auth.audit_log_entries for failures -- does not
-- work: GoTrue's audit actions are login / logout / token_refreshed / user_modified and friends. There is
-- NO failed-login action, so failures are never written anywhere queryable from SQL. A lockout built on the
-- audit log would silently never fire.
--
-- WHAT THIS IS. Supabase's "Password Verification Attempt" auth hook: GoTrue calls this function on every
-- password sign-in attempt with {user_id, valid} and honours our {decision} reply. That gives us the one
-- thing we could not otherwise get -- knowledge of a FAILED attempt -- and the authority to refuse.
--
-- IMPORTANT SCOPE LIMIT, stated so nobody mistakes this for a complete fix: this is lockout and
-- visibility, NOT a second factor. A correct password on an unlocked account still yields a JWT in one
-- step. It raises the cost of spraying enormously (5 wrong guesses buys a lockout that doubles each time)
-- and it makes an attack loud, but the ticket's core objection -- single-factor auth -- is only answered by
-- TOTP MFA. Treat this as the first of two changes.
--
-- AFTER APPLYING, register the hook (Dashboard -> Authentication -> Hooks -> Password Verification
-- Attempt -> Postgres -> public.hook_password_verification_attempt). Until it is registered this migration
-- is inert.
-- ============================================================================

-- ============================================================================
-- SHARED DISCORD NOTIFIER — extracted from notify_clamp_discord (20260724240000) so the clamp ping and the
-- lockout ping are the SAME path: one webhook read, one pg_net call site, one swallow-and-continue policy.
-- Rotating or disabling the webhook is a one-row change that moves both alerts together.
-- ============================================================================
create or replace function public.discord_notify(p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text;
begin
  select value into v_url from public.app_config where key = 'clamp_webhook';
  if v_url is null or v_url = '' then return; end if;   -- not configured -> no-op
  perform net.http_post(
    url     := v_url,
    body    := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
exception when others then
  null;   -- a webhook problem must never affect the caller
end $$;
revoke execute on function public.discord_notify(jsonb) from anon, authenticated, public;
grant execute on function public.discord_notify(jsonb) to supabase_auth_admin;

-- Re-point the existing clamp trigger at the shared notifier. The embed it produces is byte-for-byte what
-- it produced before -- this only moves the webhook lookup and the HTTP call into discord_notify().
create or replace function public.notify_clamp_discord()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name     text;
  v_kind     text;
  v_surfaces text;
  v_reason   text;
begin
  v_name     := coalesce((select username from public.profiles where id = new.user_id), new.user_id::text);
  v_kind     := case when new.auto then 'Auto-detected' else 'Manual' end;
  v_surfaces := coalesce(nullif(array_to_string(new.surfaces, ', '), ''), '—');
  v_reason   := left(coalesce(new.reason, new.signal::text, '—'), 1000);

  perform public.discord_notify(jsonb_build_object(
    'username', 'Fantasy Frontiers Moderation',
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
  ));
  return new;
exception when others then
  return new;   -- never let a webhook problem block a clamp
end $$;
-- (the account_clamp_notify trigger from 20260724240000 still points at this function -- unchanged)

-- Per-user failure ledger. One row per user who has ever failed, so it is bounded by users, not attempts.
create table if not exists public.auth_login_failures (
  user_id       uuid        primary key,
  fails         int         not null default 0,   -- consecutive failures in the CURRENT window
  first_fail_at timestamptz not null default now(),
  locked_until  timestamptz,                      -- null = not locked
  lock_count    int         not null default 0,   -- how many times this account has been locked (drives backoff)
  last_fail_at  timestamptz not null default now(),
  notified_at   timestamptz                       -- last Discord alert, so one attack is not a hundred pings
);

-- Service-role / auth-admin only. RLS on with NO policies => no client can read or write it. Critically,
-- this table must not be readable by players: it would otherwise confirm which usernames exist.
alter table public.auth_login_failures enable row level security;
revoke all on public.auth_login_failures from anon, authenticated;

-- Tunables. Deliberately generous on the first threshold: real players fat-finger passwords, and a lockout
-- that fires on 3 mistakes is a support burden. 5 failures inside 15 minutes is well clear of human error
-- and still cuts a spray to a crawl.
create or replace function public.auth_lockout_config()
returns table (max_fails int, window_secs int, base_lock_secs int, max_lock_secs int)
language sql immutable as $$ select 5, 900, 60, 86400 $$;

-- ============================================================================
-- The hook. GoTrue passes {"user_id": uuid, "valid": bool} and honours our reply:
--   {"decision":"continue"}  -> default Supabase behaviour
--   {"decision":"reject", "message": "..."} -> refuse this attempt
--
-- SECURITY DEFINER because it writes a table no caller can touch. Exception-safe throughout: if anything
-- in here raises, we return 'continue' rather than locking every player out of the game. A bug in the
-- lockout must never become an outage.
-- ============================================================================
create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid;
  v_valid  boolean;
  v_row    public.auth_login_failures;
  v_cfg    record;
  v_lock   int;
  v_name   text;
begin
  v_uid   := nullif(event->>'user_id', '')::uuid;
  v_valid := coalesce((event->>'valid')::boolean, false);
  if v_uid is null then return jsonb_build_object('decision', 'continue'); end if;

  select * into v_cfg from public.auth_lockout_config();
  select * into v_row from public.auth_login_failures where user_id = v_uid for update;

  -- ---- Already locked? Refuse, even if the password is CORRECT. -------------------------------------
  -- This is the point of a lockout: if an attacker sprays their way to the right password during a lock,
  -- the win is still denied. It also means a legitimate owner cannot log in while locked, which is the
  -- accepted cost -- the message tells them to wait rather than leaving them guessing.
  if v_row.user_id is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message',  'Too many failed sign-in attempts. Try again in '
                  || greatest(1, ceil(extract(epoch from (v_row.locked_until - now())) / 60))::text
                  || ' minute(s).'
    );
  end if;

  -- ---- Correct password: clear the ledger and let them in. -------------------------------------------
  if v_valid then
    if v_row.user_id is not null then
      delete from public.auth_login_failures where user_id = v_uid;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- ---- Wrong password: count it. --------------------------------------------------------------------
  if v_row.user_id is null then
    insert into public.auth_login_failures (user_id, fails, first_fail_at, last_fail_at)
      values (v_uid, 1, now(), now())
    on conflict (user_id) do update set fails = 1, first_fail_at = now(), last_fail_at = now()
    returning * into v_row;
  elsif v_row.first_fail_at < now() - make_interval(secs => v_cfg.window_secs) then
    -- the window elapsed: this is a fresh run of failures, not a continuation
    update public.auth_login_failures
       set fails = 1, first_fail_at = now(), last_fail_at = now(), locked_until = null
     where user_id = v_uid returning * into v_row;
  else
    update public.auth_login_failures
       set fails = fails + 1, last_fail_at = now()
     where user_id = v_uid returning * into v_row;
  end if;

  -- ---- Over the threshold: lock, with the lock length doubling each time. ---------------------------
  -- lock_count is NOT reset by the window elapsing, only by a successful login (which deletes the row),
  -- so an attacker grinding one account for hours walks the backoff up to the 24h ceiling instead of
  -- resetting to 60s every 15 minutes.
  if v_row.fails >= v_cfg.max_fails then
    v_lock := least(v_cfg.max_lock_secs, v_cfg.base_lock_secs * power(2, v_row.lock_count)::int);
    update public.auth_login_failures
       set locked_until = now() + make_interval(secs => v_lock),
           lock_count   = lock_count + 1,
           fails        = 0,
           first_fail_at= now()
     where user_id = v_uid returning * into v_row;

    -- Alert through the SAME notifier the clamp ping uses (public.discord_notify), so both land in the
    -- moderation channel and the webhook is configured/rotated in exactly one place. Throttled to one ping
    -- per account per hour: an attack is sustained, and we want a signal rather than a flood.
    begin
      if v_row.notified_at is null or v_row.notified_at < now() - interval '1 hour' then
        v_name := coalesce((select username from public.profiles where id = v_uid), v_uid::text);
        perform public.discord_notify(jsonb_build_object(
          'username', 'Fantasy Frontiers Moderation',
          'embeds', jsonb_build_array(jsonb_build_object(
            'title', '🔒 Account locked — failed sign-in attempts',
            'color', 15105570,   -- amber (0xE67E22)
            'fields', jsonb_build_array(
              jsonb_build_object('name', 'Player',     'value', v_name, 'inline', true),
              jsonb_build_object('name', 'Locked for', 'value', (v_lock / 60)::text || ' min', 'inline', true),
              jsonb_build_object('name', 'Lock #',     'value', v_row.lock_count::text, 'inline', true),
              jsonb_build_object('name', 'Note',       'value',
                'Repeated failed sign-ins against one account. A rising lock number across MANY accounts at once is credential stuffing, not a forgetful player.',
                'inline', false)
            ),
            'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ))
        ));
        update public.auth_login_failures set notified_at = now() where user_id = v_uid;
      end if;
    exception when others then
      null;   -- a webhook problem must never affect the auth decision
    end;

    return jsonb_build_object(
      'decision', 'reject',
      'message',  'Too many failed sign-in attempts. Try again in '
                  || greatest(1, (v_lock / 60))::text || ' minute(s).'
    );
  end if;

  -- Under the threshold: behave exactly as before, so a normal typo is indistinguishable from today.
  return jsonb_build_object('decision', 'continue');
exception when others then
  -- FAIL OPEN. A defect in the lockout must degrade to "no lockout", never to "nobody can log in".
  return jsonb_build_object('decision', 'continue');
end $$;

-- ============================================================================
-- Grants. GoTrue calls the hook as supabase_auth_admin, which needs execute on the function and access to
-- the table it writes. Everyone else is explicitly revoked -- a player must not be able to call the hook
-- (it would let them lock other accounts) or read the ledger (it would confirm which usernames exist).
-- ============================================================================
grant execute on function public.hook_password_verification_attempt to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt from anon, authenticated, public;

grant all on table public.auth_login_failures to supabase_auth_admin;
revoke all on table public.auth_login_failures from anon, authenticated;

grant execute on function public.auth_lockout_config to supabase_auth_admin;

-- Owner tooling: unlock an account by hand (support path -- a player who locked themselves out and cannot
-- wait). Service-role only; not callable by clients.
create or replace function public.auth_unlock_account(p_user uuid)
returns boolean language sql security definer set search_path = public as $$
  delete from public.auth_login_failures where user_id = p_user;
  select true;
$$;
revoke execute on function public.auth_unlock_account from anon, authenticated, public;

-- ============================================================================
-- REGISTER THE HOOK (required -- this migration does nothing until you do):
--   Dashboard -> Authentication -> Hooks -> "Password Verification Attempt"
--     -> type: Postgres -> schema: public -> function: hook_password_verification_attempt -> Enable
--
-- VERIFY, on a throwaway account:
--   1. Fail the password 5 times. The 5th should refuse with "Try again in 1 minute(s)."
--   2. Confirm the CORRECT password is also refused while the lock holds (that is the lockout working).
--   3. Wait it out, log in successfully, and confirm the row is gone:
--        select * from public.auth_login_failures where user_id = '<uuid>';
--   4. Repeat to see the backoff double (1 min -> 2 -> 4 ...), ceiling 24h.
--   5. Confirm the Discord alert lands in the moderation channel once, and not again within the hour.
--      It uses the SAME webhook as the clamp ping (app_config.clamp_webhook via public.discord_notify),
--      so if clamp pings work this works, and if the row is unset BOTH are silent.
--
-- ROLLBACK, if it ever misbehaves: disable the hook in the Dashboard. The function is fail-open, so even
-- leaving it registered while broken degrades to today's behaviour rather than blocking sign-in.
-- ============================================================================
