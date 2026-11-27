-- ============================================================================
-- CLAMP -> DISCORD — post a message to a Discord webhook whenever an account is CLAMPED.
--
-- Fires from a trigger on account_clamps so it catches EVERY clamp path with one hook: the item_inject
-- auto-clamp (items edge fn), a future save_game enforce, the owner's manual clamp_set RPC, and any direct
-- SQL insert. AFTER INSERT only -- a fresh clamp notifies once; a re-affirmation of an existing clamp is an
-- UPDATE (upsert-on-conflict), so it does NOT re-notify. Uses pg_net so delivery is async and a webhook
-- outage can never block or roll back a clamp.
--
-- SECRET HYGIENE: the webhook URL is NOT committed here (a webhook in git can be pulled from history and
-- abused to spam the channel). Set it once, out of band, in the private app_config row -- see the block at
-- the bottom. If it's unset, the trigger simply no-ops.
-- ============================================================================

create extension if not exists pg_net;   -- async HTTP from Postgres (schema: net). Pre-enabled on Supabase.

-- Private key/value config (webhook URL lives here, not in git). Service-role only; no client access.
create table if not exists public.app_config (
  key   text primary key,
  value text
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

-- Trigger fn: build a Discord embed for the new clamp and POST it. Best-effort -- any failure is swallowed
-- so a notification problem can never block the clamp itself.
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

  v_name     := coalesce((select username from public.profiles where id = new.user_id), new.user_id::text);
  v_kind     := case when new.auto then 'Auto-detected' else 'Manual' end;
  v_surfaces := coalesce(nullif(array_to_string(new.surfaces, ', '), ''), '—');
  v_reason   := left(coalesce(new.reason, new.signal::text, '—'), 1000);

  v_body := jsonb_build_object(
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

drop trigger if exists account_clamp_notify on public.account_clamps;
create trigger account_clamp_notify
  after insert on public.account_clamps
  for each row execute function public.notify_clamp_discord();

-- ============================================================================
-- SET THE WEBHOOK — run this ONCE, separately (NOT part of the tracked migration), so the secret never
-- lives in git. Re-run to rotate. Delete the row to disable notifications.
--
--   insert into public.app_config (key, value)
--     values ('clamp_webhook', 'https://discord.com/api/webhooks/XXXX/YYYY')
--     on conflict (key) do update set value = excluded.value;
-- ============================================================================
