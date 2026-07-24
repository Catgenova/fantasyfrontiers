-- ============================================================================
-- CHAT MODERATION — server-authoritative roles + muting for GLOBAL chat.
--
-- Adds the game's first cross-player privilege tier: a chat OWNER can appoint MODERATORS, and mods can
-- silence (timed mute / permanent chat-ban), unmute, and delete messages. Enforcement lives in the
-- DATABASE, not the client: a muted user physically cannot insert into public.messages (RLS), and message
-- deletes / role changes only happen through SECURITY DEFINER RPCs that re-check the caller's role from
-- auth.uid() (tamper-proof, mirrors the guild_action model). A hacked client can't grant itself powers.
--
-- Policy (per the owner's chosen scope):
--   * Only the OWNER appoints/removes moderators, and only the OWNER may mute/unmute or delete the message
--     of another moderator. Moderators handle regular players; they can't touch each other or the owner.
--   * "Ban" = a permanent chat mute (the player can still play, just can't post). No login/auth ban.
--
-- Deploy-safe: the client swallows "table missing" until this lands (mod UI simply stays inert), so shipping
-- the client before or after this migration is fine. After applying, run the BOOTSTRAP block at the bottom
-- (edit in your username) to make yourself the owner.
-- ============================================================================

-- ---- Role table: who is a chat owner / moderator. Publicly readable so clients can draw badges and show
-- ---- mod controls; ALL writes go through chat_set_role (no client insert/update/delete). ----
create table if not exists public.chat_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','moderator')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);
alter table public.chat_roles enable row level security;
drop policy if exists chat_roles_read on public.chat_roles;
create policy chat_roles_read on public.chat_roles for select using (true);
grant select on public.chat_roles to anon, authenticated;
revoke insert, update, delete on public.chat_roles from anon, authenticated;

-- ---- Mute table: an active row (muted_until > now) silences the user in global chat. A permanent
-- ---- chat-ban is just a mute with muted_until far in the future. Publicly readable (badge + the muted
-- ---- user sees their own status); writes only via chat_mute / chat_unmute. ----
create table if not exists public.chat_mutes (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  muted_until timestamptz not null,
  reason      text,
  muted_by    uuid references auth.users(id) on delete set null,
  muted_at    timestamptz not null default now()
);
alter table public.chat_mutes enable row level security;
drop policy if exists chat_mutes_read on public.chat_mutes;
create policy chat_mutes_read on public.chat_mutes for select using (true);
grant select on public.chat_mutes to anon, authenticated;
revoke insert, update, delete on public.chat_mutes from anon, authenticated;

-- Live role/mute changes so every client updates badges + a muted player's send box without a reload.
do $$ begin alter publication supabase_realtime add table public.chat_roles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.chat_mutes; exception when duplicate_object then null; end $$;

-- Role checks used INSIDE the definer RPCs below (executed with the function owner's rights, so they stay
-- revoked from client roles). Not referenced by any RLS policy.
create or replace function public.is_chat_owner(uid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.chat_roles where user_id = uid and role = 'owner');
$$;
create or replace function public.is_chat_mod(uid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.chat_roles where user_id = uid and role in ('owner','moderator'));
$$;

-- ---- THE TEETH: a muted user cannot post. Re-create the (trusted-username) insert policy from
-- ---- 20260708120000 with an extra clause rejecting an active mute. Everything else is unchanged, so a
-- ---- normal send is unaffected; a muted send fails at the database no matter what client is used. ----
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and lower(username) = split_part(auth.jwt() ->> 'email', '@', 1)
    and not exists (select 1 from public.chat_mutes m where m.user_id = auth.uid() and m.muted_until > now())
  );

-- ---- Owner-only: appoint / remove a moderator. Owner role itself is never assignable here (bootstrap it
-- ---- with the block at the bottom); you can't demote an owner or change your own role. ----
create or replace function public.chat_set_role(p_target uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_target is null or p_target = auth.uid() then return jsonb_build_object('ok', false, 'error', 'target'); end if;
  if public.is_chat_owner(p_target) then return jsonb_build_object('ok', false, 'error', 'owner'); end if;
  if p_role = 'moderator' then
    insert into public.chat_roles (user_id, role, granted_by) values (p_target, 'moderator', auth.uid())
      on conflict (user_id) do update set role = 'moderator', granted_by = auth.uid(), granted_at = now();
    return jsonb_build_object('ok', true, 'role', 'moderator');
  elsif p_role is null or p_role in ('', 'none', 'member') then
    delete from public.chat_roles where user_id = p_target and role = 'moderator';
    return jsonb_build_object('ok', true, 'role', null);
  end if;
  return jsonb_build_object('ok', false, 'error', 'role');
end $$;

-- ---- Mod/owner: mute a user for p_minutes (a huge value = a permanent chat-ban). A mod can't mute a mod
-- ---- or the owner; only the owner can mute a moderator. Idempotent (re-mute updates the window). ----
create or replace function public.chat_mute(p_target uuid, p_minutes bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_mod(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_target is null or p_target = auth.uid() then return jsonb_build_object('ok', false, 'error', 'target'); end if;
  if public.is_chat_owner(p_target) then return jsonb_build_object('ok', false, 'error', 'owner'); end if;
  if public.is_chat_mod(p_target) and not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'protected'); end if;
  if p_minutes is null or p_minutes <= 0 then return jsonb_build_object('ok', false, 'error', 'duration'); end if;
  v_until := now() + (least(p_minutes, 5256000) || ' minutes')::interval;   -- cap ~10 years (permanent chat-ban)
  insert into public.chat_mutes (user_id, muted_until, reason, muted_by)
    values (p_target, v_until, nullif(left(coalesce(p_reason, ''), 200), ''), auth.uid())
    on conflict (user_id) do update set muted_until = excluded.muted_until, reason = excluded.reason, muted_by = auth.uid(), muted_at = now();
  return jsonb_build_object('ok', true, 'until', (extract(epoch from v_until) * 1000)::bigint);
end $$;

-- ---- Mod/owner: lift a mute. Same protection: only the owner can unmute a moderator. ----
create or replace function public.chat_unmute(p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_mod(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_target is null then return jsonb_build_object('ok', false, 'error', 'target'); end if;
  if public.is_chat_mod(p_target) and not public.is_chat_owner(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'protected'); end if;
  delete from public.chat_mutes where user_id = p_target;
  return jsonb_build_object('ok', true);
end $$;

-- ---- Mod/owner: delete a chat message by id. RLS blocks all client deletes; this definer removes the row
-- ---- (the DELETE rides the messages realtime publication, so it vanishes for everyone live). A mod can't
-- ---- delete an owner's or (unless owner) another mod's message. ----
create or replace function public.chat_delete_message(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  if not public.is_chat_mod(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select user_id into v_owner from public.messages where id = p_id;
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if v_owner <> auth.uid() and public.is_chat_mod(v_owner) and not public.is_chat_owner(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'protected');
  end if;
  delete from public.messages where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- Client-callable (each self-authorizes from auth.uid()); internal helpers stay off every client role.
do $$
declare fn text; fns text[] := array[
  'public.chat_set_role(uuid, text)',
  'public.chat_mute(uuid, bigint, text)',
  'public.chat_unmute(uuid)',
  'public.chat_delete_message(bigint)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant  execute on function %s to authenticated', fn);
  end loop;
end $$;
revoke execute on function public.is_chat_owner(uuid) from public, anon, authenticated;
revoke execute on function public.is_chat_mod(uuid)   from public, anon, authenticated;

-- ============================================================================
-- BOOTSTRAP — make yourself the chat OWNER (run ONCE, after applying the above).
-- Replace 'YourUsername' with your exact registered in-game name, then uncomment and run:
--
-- insert into public.chat_roles (user_id, role)
--   select id, 'owner' from public.profiles where lower(username) = lower('YourUsername')
--   on conflict (user_id) do update set role = 'owner', granted_at = now();
-- ============================================================================
