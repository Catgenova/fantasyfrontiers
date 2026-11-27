-- In-app request-rate limiter (Postgres-backed, works across all Edge Function instances because the DB
-- is the shared source of truth -- unlike anything in-memory/Deno-KV, which is per-instance + ephemeral).
--
-- This is a VOLUME limiter (429 after N requests / window). It is defence-in-depth + anti-spam, NOT the
-- anti-cheat layer: gold/items/levels are already replay-proof via the token-bucket + earned_total anchors.
-- What it adds: caps a Burp-Repeater/Intruder flood (cost / crude DoS) on the custom Edge Functions, and
-- throttles the DIRECT-INSERT chat tables (messages / guild_messages) that had no frequency cap at all.
--
-- Keyed by SUBJECT (the auth uid for our functions/triggers), so the table is bounded by users x buckets --
-- one reusable row per pair, no unbounded growth, no cleanup job needed.

create table if not exists public.api_rate_limits (
  subject      text        not null,           -- auth uid (or any stable caller id)
  bucket       text        not null,           -- logical endpoint, e.g. 'wallet', 'chat'
  window_start timestamptz not null default now(),
  count        int         not null default 0,
  primary key (subject, bucket)
);

-- Service-role only. RLS on with NO policies => authenticated/anon clients can't read or write it
-- (our Edge Functions use the service role; the triggers below are SECURITY DEFINER).
alter table public.api_rate_limits enable row level security;

-- Atomic fixed-window counter. Returns TRUE when the caller is OVER the limit (=> reject / 429).
-- The single INSERT ... ON CONFLICT DO UPDATE takes a row lock, so concurrent calls for the same
-- (subject,bucket) serialize -- no lost increments. When the window has elapsed the count resets to 1.
create or replace function public.rl_hit(
  p_subject text, p_bucket text, p_limit int, p_window_secs int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if p_subject is null or p_subject = '' then return false; end if; -- can't key it => don't block
  insert into public.api_rate_limits as r (subject, bucket, window_start, count)
    values (p_subject, p_bucket, now(), 1)
  on conflict (subject, bucket) do update
    set count = case when r.window_start < now() - make_interval(secs => p_window_secs) then 1
                     else r.count + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_secs) then now()
                            else r.window_start end
  returning r.count into v_count;
  return v_count > p_limit;
end;
$$;

-- Lock the RPC down to the service role (Edge Functions). Clients must never call it directly.
revoke all on function public.rl_hit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.rl_hit(text, text, int, int) to service_role;

-- ---- Direct-insert chat throttles (the real un-capped spam vector) ----------------------------------
-- BEFORE INSERT triggers on the RLS-inserted chat tables. auth.uid() is set by PostgREST from the caller's
-- JWT, so the limit is per authenticated user. Over the limit => the insert is rejected. Generous limits:
-- 10 messages / 10s (1/s avg, 10 burst) is far above human chat but shreds a Repeater flood.
create or replace function public.rl_chat_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.rl_hit(coalesce(auth.uid()::text, ''), tg_argv[0], (tg_argv[1])::int, (tg_argv[2])::int) then
    raise exception 'You''re sending messages too fast. Slow down a moment.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit before insert on public.messages
  for each row execute function public.rl_chat_guard('chat', '10', '10');

-- guild_messages exists once the guilds migration is applied; guard it the same way if present.
do $$
begin
  if to_regclass('public.guild_messages') is not null then
    execute 'drop trigger if exists guild_messages_rate_limit on public.guild_messages';
    execute 'create trigger guild_messages_rate_limit before insert on public.guild_messages
             for each row execute function public.rl_chat_guard(''guild_chat'', ''10'', ''10'')';
  end if;
end;
$$;
