-- Fantasy Frontiers — multiplayer backend
-- Tables: public.messages (global chat) and public.profiles (leaderboard).
-- Security model: the game is client-authoritative, so leaderboard numbers are
-- self-reported. RLS still ensures a player can only write their OWN rows and
-- can't post chat under someone else's name.

-- ========================= CHAT =========================
create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  username    text        not null,
  body        text        not null check (char_length(body) between 1 and 240)
);

create index if not exists messages_created_at_idx on public.messages (created_at desc);

alter table public.messages enable row level security;

-- Anyone (even signed-out) can read chat history.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select using (true);

-- Only signed-in users may post, only as themselves, and only under the
-- username baked into their auth token (set at registration) — no impersonation.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and username = (auth.jwt() -> 'user_metadata' ->> 'username')
  );

-- Push new rows to subscribed clients over Realtime.
alter publication supabase_realtime add table public.messages;

-- ====================== LEADERBOARD ======================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text        not null,
  total_level  int         not null default 0,
  gold         bigint      not null default 0,
  skills       jsonb       not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_total_level_idx on public.profiles (total_level desc);

alter table public.profiles enable row level security;

-- Anyone can read the leaderboard / view a profile.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (true);

-- A player may only create/update their own profile row.
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
