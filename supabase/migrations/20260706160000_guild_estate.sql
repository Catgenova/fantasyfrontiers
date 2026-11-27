-- ============================================================================
-- GUILDS — Phase 3: shared Guild Estate (5 concurrent task slots).
--
-- Members run estate-crafting jobs (stonecutting/masonry/paving) on 5 shared slots —
-- one task per member. A member funds the recipe's inputs from their own inventory
-- (client-authoritative, like any craft) and earns the skill XP; the produced items go
-- into the GUILD BANK when the task is collected. The server owns the shared-slot
-- mechanics: slot allocation, one-task-per-member, real-time completion, and an atomic
-- collect→bank hand-off (no double-collect / double-deposit).
--
-- The two UNIQUE constraints do the heavy lifting: (guild_id,slot) caps at 5 occupied
-- slots and blocks two people grabbing the same slot; (guild_id,user_id) enforces one
-- active task per member. Both are checked atomically by the INSERT.
-- ============================================================================

create table if not exists public.guild_estate_tasks (
  id         bigint generated always as identity primary key,
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  slot       int  not null check (slot between 0 and 4),
  user_id    uuid not null references auth.users(id) on delete cascade,
  username   text not null,
  skill_id   text not null check (char_length(skill_id) <= 24),
  output_key text not null check (char_length(output_key) between 1 and 64),
  output_qty bigint not null check (output_qty > 0),
  batches    int  not null check (batches > 0),
  started_at timestamptz not null default now(),
  finish_at  timestamptz not null,
  unique (guild_id, slot),
  unique (guild_id, user_id)
);
create index if not exists guild_estate_guild_idx on public.guild_estate_tasks (guild_id);

alter table public.guild_estate_tasks enable row level security;
drop policy if exists guild_estate_read on public.guild_estate_tasks;
create policy guild_estate_read on public.guild_estate_tasks
  for select using (guild_id = public.current_guild_id());
-- (no client writes — the guild_estate edge function is the only writer)

-- Atomic collect: lock the slot's task, and only if it's finished deposit its output into
-- the guild bank (via the Phase 2 RPC), free the slot, and credit the owner's contribution.
-- The row lock makes concurrent collectors serialize — the loser finds the row gone.
create or replace function public.guild_estate_collect(p_guild uuid, p_slot int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_key text; v_qty bigint; v_owner uuid; v_skill text; v_batches int; v_fin timestamptz; v_dep text;
begin
  select id, output_key, output_qty, user_id, skill_id, batches, finish_at
    into v_id, v_key, v_qty, v_owner, v_skill, v_batches, v_fin
    from public.guild_estate_tasks where guild_id = p_guild and slot = p_slot for update;
  if v_id is null then return jsonb_build_object('status','empty'); end if;
  if v_fin > now() then return jsonb_build_object('status','notready'); end if;
  select public.guild_bank_deposit(p_guild, v_key, v_qty) into v_dep;
  if v_dep <> 'ok' then return jsonb_build_object('status','bankfull'); end if;
  delete from public.guild_estate_tasks where id = v_id;
  update public.guild_members set contribution = contribution + v_qty where user_id = v_owner;
  return jsonb_build_object('status','ok','owner',v_owner,'skill',v_skill,'output_key',v_key,'qty',v_qty,'batches',v_batches);
end $$;
