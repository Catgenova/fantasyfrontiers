-- ============================================================================
-- SERVER-WIDE BUFFS — players spend gold to activate a buff that helps EVERY player.
--
-- One row per buff kind holding a shared `active_until`. Buying extends that timer by a fixed
-- duration (stacking, so purchases while it's live keep it going). All clients read the current
-- expiry and apply the effect locally while it's in the future. First shipped buff: 'exp' (+50%
-- XP for all players); the client charges the gold (client-authoritative, like the rest of the
-- economy) and this only guarantees the shared timer's integrity (atomic, race-free extend).
-- ============================================================================

create table if not exists public.server_buffs (
  kind         text primary key,
  active_until timestamptz not null default now()
);

-- Function-only: RLS on, no client policies (the server_buff edge function + this RPC are the
-- only accessors).
alter table public.server_buffs enable row level security;

-- Atomically extend a buff by p_seconds from the later of now / its current expiry (so a purchase
-- while it's already active adds on top). Capped at 30 days out so a runaway can't set it forever.
-- Returns the new active_until. p_seconds is bounded to at most one day per call.
create or replace function public.server_buff_extend(p_kind text, p_seconds int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if p_kind is null or char_length(p_kind) < 1 or char_length(p_kind) > 32 then return null; end if;
  if p_seconds is null or p_seconds <= 0 or p_seconds > 86400 then return null; end if;
  insert into public.server_buffs(kind, active_until)
    values (p_kind, now() + make_interval(secs => p_seconds))
  on conflict (kind) do update
    set active_until = least(now() + interval '30 days',
                             greatest(public.server_buffs.active_until, now()) + make_interval(secs => p_seconds));
  select active_until into v_until from public.server_buffs where kind = p_kind;
  return v_until;
end $$;
