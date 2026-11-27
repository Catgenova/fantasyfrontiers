-- ============================================================================
-- GUILDS — guild upgrades are paid from the shared treasury (coffers), not personal gold.
--
-- Buying a bank slot now deducts its cost from guilds.treasury atomically (and fails if the
-- coffers are short). A generic guild_treasury_spend RPC backs other guild-funded expenses
-- (e.g. expanding the shared guild estate). Both run on the locked guilds row so concurrent
-- spends can't overdraw. Rank gating lives in the guild_bank edge function.
-- ============================================================================

-- Bank slot purchase: cost now comes out of the treasury instead of the buyer's gold.
create or replace function public.guild_bank_buy_slot(p_guild uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_slots int; v_treasury bigint; v_costn numeric; v_cost bigint;
begin
  select bank_slots, treasury into v_slots, v_treasury from public.guilds where id = p_guild for update;
  if v_slots is null then return jsonb_build_object('status','bad'); end if;
  if v_slots >= 500 then return jsonb_build_object('status','max'); end if;
  v_costn := round(10000 * power(1.25::numeric, (v_slots - 5)::numeric));
  if v_costn > 9000000000000000000 then return jsonb_build_object('status','toohigh'); end if;
  v_cost := v_costn::bigint;
  if v_treasury < v_cost then return jsonb_build_object('status','poor','cost',v_cost,'treasury',v_treasury); end if;
  update public.guilds set bank_slots = bank_slots + 1, treasury = treasury - v_cost where id = p_guild;
  return jsonb_build_object('status','ok','cost',v_cost,'slots',v_slots + 1,'treasury',v_treasury - v_cost);
end $$;

-- Generic atomic spend from the treasury for guild-funded expenses. Deducts (burns) the amount;
-- returns 'poor' if the coffers can't cover it.
create or replace function public.guild_treasury_spend(p_guild uuid, p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cur bigint; v_new bigint;
begin
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('status','bad'); end if;
  select treasury into v_cur from public.guilds where id = p_guild for update;
  if v_cur is null then return jsonb_build_object('status','bad'); end if;
  if v_cur < p_amount then return jsonb_build_object('status','poor','treasury',v_cur); end if;
  update public.guilds set treasury = treasury - p_amount where id = p_guild returning treasury into v_new;
  return jsonb_build_object('status','ok','treasury',v_new,'spent',p_amount);
end $$;
