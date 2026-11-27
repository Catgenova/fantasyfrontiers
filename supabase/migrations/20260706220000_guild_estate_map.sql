-- ============================================================================
-- GUILDS: shared editable guild estate.
--
-- One row per guild holding the whole shared estate as a jsonb blob (terrain grid +
-- placed workshops, and later the concurrent activity jobs). Members of the guild can
-- read and write their guild's row directly (client-authoritative, like the personal
-- estate and the rest of the economy). Concurrent edits are reconciled with an optimistic
-- `version` guard: a write only succeeds when the caller's version matches, otherwise the
-- client refetches and reapplies. Realtime is enabled so members see each other's changes.
-- ============================================================================

create table if not exists public.guild_estate (
  guild_id   uuid primary key references public.guilds(id) on delete cascade,
  data       jsonb not null,
  version    int   not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.guild_estate enable row level security;

drop policy if exists guild_estate_read on public.guild_estate;
create policy guild_estate_read on public.guild_estate
  for select using (guild_id = public.current_guild_id());

drop policy if exists guild_estate_insert on public.guild_estate;
create policy guild_estate_insert on public.guild_estate
  for insert to authenticated with check (guild_id = public.current_guild_id());

drop policy if exists guild_estate_update on public.guild_estate;
create policy guild_estate_update on public.guild_estate
  for update using (guild_id = public.current_guild_id()) with check (guild_id = public.current_guild_id());

alter publication supabase_realtime add table public.guild_estate;
