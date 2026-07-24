-- ============================================================================
-- CLAMP SIGNALS — the auto-detection audit log for the account-clamp system (migration 20260724210000).
--
-- save_game computes cheap "impossible, not just suspicious" invariants on each write and records a row
-- here when one trips. In SHADOW mode (save_game's CLAMP_AUTOENFORCE=false, the default) it ONLY records --
-- it does not clamp -- so the owner can watch what WOULD have tripped and validate the thresholds before
-- enabling enforcement. When enforcement is later turned on, the same trip also writes an account_clamps
-- row (auto=true) with the signal as evidence.
--
-- PRIVATE like account_clamps: no client select; the owner reads recent signals through clamp_signals_list()
-- and acts on them from Settings > Moderation. Deploy-safe & additive.
-- ============================================================================

create table if not exists public.clamp_signals (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  kind        text not null,                 -- e.g. 'progress_jump'
  detail      jsonb,                         -- the evidence (deltas, elapsed, before/after)
  would_clamp boolean not null default true, -- true = a hard signal that would auto-clamp once enforcement is on
  created_at  timestamptz not null default now()
);
alter table public.clamp_signals enable row level security;
-- No policies + no grants: only the service role (save_game) writes, and the owner reads via the RPC below.
revoke all on public.clamp_signals from anon, authenticated;
create index if not exists clamp_signals_recent on public.clamp_signals (created_at desc);

-- Owner-only: the recent detection signals, newest first, with usernames joined and a flag for whether the
-- flagged account is already clamped (so acted-on signals read as handled). Private table -> definer read.
create or replace function public.clamp_signals_list(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_arr jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'username', p.username,
      'kind', s.kind,
      'detail', s.detail,
      'would_clamp', s.would_clamp,
      'clamped', public.is_clamped(s.user_id, 'marketplace'),
      'created_at', (extract(epoch from s.created_at) * 1000)::bigint
    ) order by s.created_at desc), '[]'::jsonb)
    into v_arr
    from (select * from public.clamp_signals order by created_at desc limit least(coalesce(p_limit, 100), 500)) s
    left join public.profiles p on p.id = s.user_id;
  return jsonb_build_object('ok', true, 'signals', v_arr);
end $$;

revoke execute on function public.clamp_signals_list(integer) from public, anon;
grant  execute on function public.clamp_signals_list(integer) to authenticated;
