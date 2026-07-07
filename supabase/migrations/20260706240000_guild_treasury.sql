-- ============================================================================
-- GUILDS — shared Gold Treasury on the Guild Bank.
--
-- A single running gold total per guild (guilds.treasury). Members donate gold into it;
-- withdrawing is gated by the same bank_min_withdraw_rank as item withdrawals. Gold, like
-- the rest of the economy, is client-authoritative (deducted/credited on the client, just
-- like item deposits and bank-slot buys) — what the server guarantees here is the shared
-- total's integrity: atomic add/subtract with no races and no over-withdraw. All access
-- goes through the `guild_bank` edge function + the SECURITY DEFINER RPCs below.
-- ============================================================================

alter table public.guilds
  add column if not exists treasury bigint not null default 0 check (treasury >= 0);

-- Atomic donate: grow the shared treasury (gold was already deducted client-side).
create or replace function public.guild_treasury_donate(p_guild uuid, p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_new bigint;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000000 then return jsonb_build_object('status','bad'); end if;
  update public.guilds set treasury = treasury + p_amount where id = p_guild returning treasury into v_new;
  if v_new is null then return jsonb_build_object('status','bad'); end if;
  return jsonb_build_object('status','ok','treasury',v_new);
end $$;

-- Atomic withdraw: subtract from the treasury if enough is on hand (locked row -> no races).
create or replace function public.guild_treasury_withdraw(p_guild uuid, p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cur bigint; v_new bigint;
begin
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('status','bad'); end if;
  select treasury into v_cur from public.guilds where id = p_guild for update;
  if v_cur is null then return jsonb_build_object('status','bad'); end if;
  if v_cur < p_amount then return jsonb_build_object('status','short'); end if;
  update public.guilds set treasury = treasury - p_amount where id = p_guild returning treasury into v_new;
  return jsonb_build_object('status','ok','treasury',v_new,'granted',p_amount);
end $$;
