-- Cloud saves: preserve each player's full game state server-side so progress
-- survives cleared browsers and follows them across devices.
--
-- This is the player's OWN private data (their save blob), so plain RLS — "you can
-- only touch your own row" — is the right guard; no validating function is needed for
-- reads. WRITES go through the `save_game` Edge Function, which adds a freshness guard
-- (a stale device can't overwrite a newer cloud save). Note: the blob is
-- client-authoritative (a player can edit their own save), so authoritative multiplayer
-- state must live in separate server-validated tables, not be read out of here.

create table if not exists public.saves (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  data            jsonb  not null,
  version         bigint not null default 1,
  client_saved_at bigint not null default 0,   -- state.lastSaved (ms since epoch)
  updated_at      timestamptz not null default now()
);

alter table public.saves enable row level security;

-- Own-row access only. (The service role used by save_game bypasses RLS to write.)
drop policy if exists saves_select_own on public.saves;
create policy saves_select_own on public.saves
  for select to authenticated using (auth.uid() = user_id);

-- Direct client writes are intentionally NOT granted — writes go through save_game.
-- (No insert/update policy => authenticated clients cannot write this table directly.)

-- Guard against oversized blobs (~512 KB of compressed jsonb).
alter table public.saves drop constraint if exists saves_size_chk;
alter table public.saves add constraint saves_size_chk check (pg_column_size(data) < 524288);
