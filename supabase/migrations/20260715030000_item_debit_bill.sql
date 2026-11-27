-- ============================================================================
-- SERVER-AUTHORITATIVE INVENTORY, Stage A: batch debit + recipe-input manifest.
--
-- Foundation for routing crafting/consumption through the item ledger ("items = gold", parallel to the
-- gold wallet). ADDITIVE ONLY -- nothing calls these yet, so deploying this changes no behavior. The
-- client cutover (adopt the ledger) and the consume-debit wiring land in later stages.
-- ============================================================================

-- Atomic ALL-OR-NOTHING batch debit of a {item_key: qty} bill. Returns true only if EVERY line was
-- covered and debited; any shortfall rolls back the whole bill (the inner subtransaction) and returns
-- false, so a craft/consume can never partially consume. The multi-item analog of item_debit.
create or replace function public.item_debit_bill(p_user uuid, p_bill jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare k text; need bigint;
begin
  if p_bill is null or jsonb_typeof(p_bill) <> 'object' then return false; end if;
  begin
    for k, need in select key, greatest(0, floor((value)::text::numeric))::bigint from jsonb_each(p_bill) loop
      if need > 0 then
        update public.player_items set qty = qty - need, updated_at = updated_at
          where user_id = p_user and item_key = k and qty >= need;
        if not found then
          raise exception 'ff_insufficient';  -- roll back every debit done in this subtransaction
        end if;
      end if;
    end loop;
  exception when others then
    return false;  -- fail closed: any shortfall / row-miss -> nothing debited
  end;
  return true;
end $$;

-- Recipe input manifest: the server-canonical bill for each craftable output. Populated by a generated
-- seed migration (dumped from the client's recipe tables) in Stage A3. Reference data, function-only
-- access: RLS on with NO client policy, so only the SECURITY DEFINER craft_debit (service role) reads it.
create table if not exists public.recipe_inputs (
  recipe_key text   not null,
  item_key   text   not null,
  qty        bigint not null check (qty > 0),
  primary key (recipe_key, item_key)
);
alter table public.recipe_inputs enable row level security;

-- Authorize a craft: resolve the canonical bill for p_recipe_key from recipe_inputs (scaled by the batch
-- multiplier), then debit it atomically. Returns false for an unknown/empty recipe (can't authorize what
-- we don't have a manifest for) or when the ledger can't cover it. The client only calls this for
-- recipes that HAVE inputs; a free recipe needs no debit. p_mult is clamped to a sane batch range.
create or replace function public.craft_debit(p_user uuid, p_recipe_key text, p_mult int)
returns boolean language plpgsql security definer set search_path = public as $$
declare bill jsonb; m bigint;
begin
  if p_recipe_key is null then return false; end if;
  m := least(1000000, greatest(1, coalesce(p_mult, 1)));
  select jsonb_object_agg(item_key, qty * m) into bill
    from public.recipe_inputs where recipe_key = p_recipe_key;
  if bill is null then return false; end if;  -- unknown recipe -> not authorized
  return public.item_debit_bill(p_user, bill);
end $$;

-- Function-only access (service role only; revoke from client roles) -- matches item_debit/credit.
do $$
declare fn text; fns text[] := array[
  'public.item_debit_bill(uuid, jsonb)',
  'public.craft_debit(uuid, text, int)'
];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
