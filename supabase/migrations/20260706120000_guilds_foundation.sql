-- ============================================================================
-- GUILDS — Phase 1 foundation: guilds, membership, applications, guild chat.
--
-- Architecture (per project rule): guild shared state is SERVER-AUTHORITATIVE.
-- The client never writes these tables directly except guild_messages (chat),
-- which is protected exactly like public.messages (insert-as-yourself + you must
-- be a member of the guild you post to). All other mutations go through the
-- `guild_action` edge function using the service role. Reads are public where the
-- data isn't sensitive (guild list + roster), restricted where it is (applications,
-- guild chat).
--
-- NOTE on the 50,000g creation cost: gold lives in the client-authoritative save
-- blob, so the server can't verify or deduct it. The client deducts locally before
-- calling create and refunds if the call fails. This is a soft sink, consistent with
-- the rest of the game's client-authoritative economy — not a server ledger.
-- ============================================================================

create table if not exists public.guilds (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 3 and 24),
  tag             text not null check (char_length(tag) between 2 and 5),
  description     text not null default '' check (char_length(description) <= 240),
  leader_id       uuid not null references auth.users(id) on delete cascade,
  member_count    int  not null default 1,
  bank_slots      int  not null default 5,   -- purchasable up to 500 (Phase 2)
  treasury        bigint not null default 0, -- guild gold for upgrades (Phase 3)
  open            boolean not null default true, -- accepting applications
  min_total_level int  not null default 0,
  created_at      timestamptz not null default now()
);
create unique index if not exists guilds_name_key on public.guilds (lower(name));
create unique index if not exists guilds_tag_key  on public.guilds (lower(tag));

-- One guild per player (user_id is the PK).
create table if not exists public.guild_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  guild_id     uuid not null references public.guilds(id) on delete cascade,
  username     text not null,
  rank         text not null default 'member' check (rank in ('leader','officer','member')),
  contribution bigint not null default 0,
  joined_at    timestamptz not null default now()
);
create index if not exists guild_members_guild_idx on public.guild_members (guild_id);

create table if not exists public.guild_applications (
  id         bigint generated always as identity primary key,
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  username   text not null,
  message    text not null default '' check (char_length(message) <= 200),
  created_at timestamptz not null default now(),
  unique (guild_id, user_id)
);
create index if not exists guild_applications_guild_idx on public.guild_applications (guild_id);

create table if not exists public.guild_messages (
  id         bigint generated always as identity primary key,
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  created_at timestamptz not null default now(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  username   text not null,
  body       text not null check (char_length(body) between 1 and 500)
);
create index if not exists guild_messages_guild_created_idx on public.guild_messages (guild_id, created_at desc);

-- Caller's current guild id — used by RLS below. SECURITY DEFINER so the policy can
-- read guild_members regardless of the caller's own RLS on that table.
create or replace function public.current_guild_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select guild_id from public.guild_members where user_id = auth.uid() $$;

-- Caller's rank in their guild (null if not in one).
create or replace function public.current_guild_rank()
returns text
language sql stable security definer set search_path = public
as $$ select rank from public.guild_members where user_id = auth.uid() $$;

-- ---- RLS ----
alter table public.guilds enable row level security;
drop policy if exists guilds_read on public.guilds;
create policy guilds_read on public.guilds for select using (true);
-- (no client insert/update/delete — all writes via guild_action)

alter table public.guild_members enable row level security;
drop policy if exists guild_members_read on public.guild_members;
create policy guild_members_read on public.guild_members for select using (true);
-- (no client writes)

alter table public.guild_applications enable row level security;
drop policy if exists guild_apps_read on public.guild_applications;
create policy guild_apps_read on public.guild_applications for select using (
  user_id = auth.uid()
  or (guild_id = public.current_guild_id() and public.current_guild_rank() in ('leader','officer'))
);
-- (no client writes)

alter table public.guild_messages enable row level security;
drop policy if exists guild_msgs_read on public.guild_messages;
create policy guild_msgs_read on public.guild_messages for select using (
  guild_id = public.current_guild_id()
);
drop policy if exists guild_msgs_insert on public.guild_messages;
create policy guild_msgs_insert on public.guild_messages for insert to authenticated
with check (
  auth.uid() = user_id
  and username = (auth.jwt() -> 'user_metadata' ->> 'username')
  and guild_id = public.current_guild_id()
);

-- Live guild chat (Realtime applies the SELECT policy above per-subscriber, so only
-- members of a given guild receive its messages).
alter publication supabase_realtime add table public.guild_messages;
