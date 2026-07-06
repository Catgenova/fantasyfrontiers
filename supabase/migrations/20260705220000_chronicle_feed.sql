-- Global Chronicle feed: broadcasts notable cross-player events (rare/supreme/fantastic
-- crafts, skill-level milestones, familiar summons). Same shape/security as chat messages:
-- anyone can read; a signed-in player can only post as themselves (username must match
-- their auth token, so no impersonation). Events are self-reported/cosmetic.
create table if not exists public.chronicle (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  username   text        not null,
  kind       text        not null check (kind in ('craft','level','familiar')),
  body       text        not null check (char_length(body) between 1 and 120)
);

create index if not exists chronicle_created_at_idx on public.chronicle (created_at desc);

alter table public.chronicle enable row level security;

drop policy if exists chronicle_read on public.chronicle;
create policy chronicle_read on public.chronicle
  for select using (true);

drop policy if exists chronicle_insert on public.chronicle;
create policy chronicle_insert on public.chronicle
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and username = (auth.jwt() -> 'user_metadata' ->> 'username')
  );

alter publication supabase_realtime add table public.chronicle;
