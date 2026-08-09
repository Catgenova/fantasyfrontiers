-- ============================================================================
-- THE GUILD HALL (v0.0.97.0) — the guild's first progression axis, and a treasury gold SINK.
--
-- guilds.hall_level (0..15). Each level adds ONE roster slot on top of the base 10, so a
-- fully raised Hall holds 25 members. The leader raises it from the shared treasury; costs
-- run a fixed 15-step ladder from 1,000,000 gold (Level 1) to 15,000,000,000 gold (Level 15),
-- geometric at ~x1.99 per step (1e6 * 15000^((n-1)/14), prettied to 3 significant figures).
--
-- THE LADDER IS DUPLICATED ON THE CLIENT (GUILD_HALL_COSTS in index.html) and pinned by the
-- selftest suite — the estate_job_duration_ms rule applies: CHANGE BOTH SIDES OR NEITHER.
-- A hardcoded table on each side, not a shared formula, because SQL numeric power and JS
-- doubles round differently and the two sides must agree to the gold piece.
--
-- The member CAP is enforced server-side in the guild_action edge function's accept path
-- (base 10 + hall_level) — which previously had NO cap check at all: the 10-member limit
-- was client-only, so a modified client could accept members without bound. Deploy the
-- edge function together with this migration.
--
-- Self-sufficient: table change, cost function, leader-gated upgrade RPC, verify block.
-- ============================================================================

alter table public.guilds
  add column if not exists hall_level int not null default 0
  check (hall_level >= 0 and hall_level <= 15);

-- Cost of raising the Hall TO level p_level (1..15). Anything else returns null.
create or replace function public.guild_hall_cost(p_level int)
returns bigint language sql immutable as $$
  select case p_level
    when 1  then 1000000::bigint
    when 2  then 1990000::bigint
    when 3  then 3950000::bigint
    when 4  then 7850000::bigint
    when 5  then 15600000::bigint
    when 6  then 31000000::bigint
    when 7  then 61600000::bigint
    when 8  then 122000000::bigint
    when 9  then 243000000::bigint
    when 10 then 484000000::bigint
    when 11 then 961000000::bigint
    when 12 then 1910000000::bigint
    when 13 then 3800000000::bigint
    when 14 then 7550000000::bigint
    when 15 then 15000000000::bigint
    else null end;
$$;

-- Raise the Hall one level: leader-only, paid atomically from the treasury (locked row, no
-- races with donations/withdrawals/estate expansion). Self-authenticating via auth.uid(),
-- so it is safe to expose to authenticated directly — it takes no guild argument at all.
create or replace function public.guild_hall_upgrade()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_guild uuid; v_rank text; v_level int; v_treasury bigint; v_cost bigint;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'error','auth'); end if;
  select guild_id, rank into v_guild, v_rank from public.guild_members where user_id = v_uid;
  if v_guild is null then return jsonb_build_object('ok',false,'error','no_guild'); end if;
  if v_rank is distinct from 'leader' then return jsonb_build_object('ok',false,'error','leader_only'); end if;
  select coalesce(hall_level, 0), treasury into v_level, v_treasury
    from public.guilds where id = v_guild for update;
  if v_treasury is null then return jsonb_build_object('ok',false,'error','no_guild'); end if;
  if v_level >= 15 then return jsonb_build_object('ok',false,'error','max','hall_level',v_level); end if;
  v_cost := public.guild_hall_cost(v_level + 1);
  if v_treasury < v_cost then
    return jsonb_build_object('ok',false,'error','poor','cost',v_cost,'treasury',v_treasury,'hall_level',v_level);
  end if;
  update public.guilds set treasury = treasury - v_cost, hall_level = v_level + 1 where id = v_guild;
  return jsonb_build_object('ok',true,'hall_level',v_level + 1,'treasury',v_treasury - v_cost,'cost',v_cost);
end $$;

revoke all on function public.guild_hall_upgrade() from public;
grant execute on function public.guild_hall_upgrade() to authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY (one paste, read-only): the ladder's pinned endpoints and shape.
-- ---------------------------------------------------------------------------
-- select public.guild_hall_cost(1)  = 1000000        as l1_is_1m,
--        public.guild_hall_cost(15) = 15000000000    as l15_is_15b,
--        public.guild_hall_cost(0)  is null           as l0_null,
--        public.guild_hall_cost(16) is null           as l16_null,
--        (select bool_and(public.guild_hall_cost(n+1) > public.guild_hall_cost(n))
--           from generate_series(1,14) n)              as monotonic;
