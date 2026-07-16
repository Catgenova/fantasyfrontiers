-- Wallet hardening (support-ticket follow-up): audit trail for spoof-shaped wallet requests.
--
-- The wallet edge function already neutralizes spoofed earn/sync payloads (token bucket + min() clamp;
-- see supabase/functions/wallet/index.ts), but silently -- there was no visibility into who is probing.
-- The function now inserts a row here when a request looks like a spoof rather than normal throttled
-- play: an earn/sync claiming >1B new earnings at once ("earn_delta_huge"), or a sync reporting a gold
-- balance more than 2x AND 1M+ above the server's ("gold_spoof_clamped").
--
-- Service-role only: RLS is enabled with NO policies, so anon/authenticated clients can neither read
-- nor write it. Query it from the dashboard SQL editor, e.g.:
--   select user_id, note, count(*), max(created_at) from wallet_audit group by 1,2 order by 3 desc;
create table if not exists public.wallet_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  action text,
  note text not null,
  reported_earned numeric,
  reported_gold numeric,
  credited bigint,
  server_gold bigint,
  created_at timestamptz not null default now()
);
create index if not exists wallet_audit_user_idx on public.wallet_audit (user_id, created_at desc);
alter table public.wallet_audit enable row level security;
