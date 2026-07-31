-- ============================================================================
-- DUNGEON PROGRESSION GATES, SERVER SIDE (pentest finding, 2026-07-31).
--
-- REPORTED: the gates existed only in the browser. dungeonEntryBlock()/dungeonJoinBlock() check Total Level
-- 5,000 and "cleared the previous layer", but the `dungeon` edge function's `create` validated only that the
-- layer EXISTS, and `join` validated only the session's state (gone/started/full). So an authenticated
-- player calling the function directly could open a D4 party at Total Level 1 with no clears at all, or join
-- someone else's higher-layer party by session id. Confirmed by reading the function; the report is exact.
--
-- WHAT THIS FIXES, AND WHAT IT HONESTLY DOES NOT.
--
-- Fully authoritative after this migration:
--   * the Total Level gate -- profiles.total_level is server-held and already rate-limited + activity-checked
--     by submit_profile, so it cannot simply be asserted.
--   * PARTY clears -- the server owns dungeon_sessions.status, so "this user was a member of a session the
--     server marked cleared" is hard evidence. Recorded from the edge function on any snapshot where the
--     caller's own session reads 'cleared'.
--   * ORDERING -- dungeon_clear_record refuses a layer whose predecessor is not already recorded, so no
--     path can register d4 first. This is the half that kills "create a D4 party without clearing anything".
--
-- NOT authoritative, stated plainly rather than implied away:
--   * a SOLO clear. Solo runs are simulated entirely in the browser (no session row exists), so the server
--     cannot verify one happened -- verifying it would mean running the combat engine server-side, which
--     this codebase deliberately does not do (see submit_profile's header). A determined cheater can still
--     walk the chain by asserting d1, then d2, and so on.
--   * BUT they must do it IN ORDER, one layer at a time, and they must still pass the Total Level gate,
--     which they cannot assert. "Jump straight to D4 at level 1" -- the actual reported exploit -- is closed.
--
-- GRANDFATHERING: every existing player's clears live only in their save blob (state.dungeonsCleared), so
-- this table starts empty for everyone. The client reports its known clears in order on boot, which fills
-- the ledger for legitimate players. That first sync trusts the client once -- the same shape as item_sync's
-- account-age grandfather -- and is the price of not resetting the whole playerbase's progression.
-- ============================================================================

-- Canonical layer order, in one place, so the chain rule cannot drift from the client's DUNGEON_ORDER.
create or replace function public.dungeon_layer_index(p_layer text)
returns int language sql immutable as $$
  select case p_layer when 'd1' then 1 when 'd2' then 2 when 'd3' then 3 when 'd4' then 4 else null end;
$$;

create table if not exists public.dungeon_clears (
  user_id          uuid not null references auth.users(id) on delete cascade,
  layer            text not null,
  first_cleared_at timestamptz not null default now(),
  source           text not null default 'solo' check (source in ('solo','party')),
  primary key (user_id, layer)
);
-- Function-only table: the edge function (service role) and the definer functions below are the only
-- readers/writers. A client must not be able to insert its own unlock.
alter table public.dungeon_clears enable row level security;
revoke all on public.dungeon_clears from anon, authenticated;

-- ---- Record a clear, enforcing the CHAIN ----------------------------------------------------------
-- Returns true if the ledger now contains the layer (including when it already did -- idempotent, because
-- every member of a cleared party calls this from their own client).
create or replace function public.dungeon_clear_record(p_user uuid, p_layer text, p_source text default 'solo')
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_idx  int := public.dungeon_layer_index(p_layer);
  v_prev text;
begin
  if p_user is null or v_idx is null then return false; end if;
  -- Already recorded: keep the EARLIER record and the stronger source. A party clear is evidence; a solo
  -- claim is not, so party must never be downgraded to solo by a later re-report.
  if exists (select 1 from public.dungeon_clears where user_id = p_user and layer = p_layer) then
    if p_source = 'party' then
      update public.dungeon_clears set source = 'party' where user_id = p_user and layer = p_layer and source <> 'party';
    end if;
    return true;
  end if;
  -- The chain: anything past the first layer needs its predecessor already on the ledger. This is what
  -- stops a caller registering d4 directly, whatever it claims.
  if v_idx > 1 then
    v_prev := 'd' || (v_idx - 1);
    if not exists (select 1 from public.dungeon_clears where user_id = p_user and layer = v_prev) then
      return false;
    end if;
  end if;
  insert into public.dungeon_clears (user_id, layer, source)
    values (p_user, p_layer, case when p_source = 'party' then 'party' else 'solo' end)
    on conflict (user_id, layer) do nothing;
  return true;
end $$;

-- ---- The gate the edge function asks before create/join -------------------------------------------
-- Returns {ok:true} or {ok:false, error:'<player-facing reason>'}. Mirrors dungeonEntryBlock's wording so
-- the client can show the server's answer verbatim instead of inventing its own.
create or replace function public.dungeon_gate_check(p_user uuid, p_layer text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_idx   int := public.dungeon_layer_index(p_layer);
  v_prev  text;
  v_total bigint;
  -- Mirrors DUNGEON_DEFS[*].category in index.html. Only used for the refusal message, so drift here is
  -- cosmetic -- but keep it in step, since the client shows this text verbatim.
  v_names jsonb := '{"d1":"Cave","d2":"Tunnel","d3":"Underground Chamber","d4":"Nest of the Depths"}'::jsonb;
begin
  if v_idx is null then return jsonb_build_object('ok', false, 'error', 'Unknown dungeon.'); end if;

  -- Total Level 5,000. profiles.total_level is written only by submit_profile, which token-buckets the
  -- climb rate and holds submissions whose implied XP the account's activity cannot support -- so this is a
  -- real gate, not a client assertion. A missing profile row reads as 0 and is refused.
  select coalesce(total_level, 0) into v_total from public.profiles where id = p_user;
  if coalesce(v_total, 0) < 5000 then
    return jsonb_build_object('ok', false, 'error', 'Total Level 5,000 required.');
  end if;

  if v_idx > 1 then
    v_prev := 'd' || (v_idx - 1);
    if not exists (select 1 from public.dungeon_clears where user_id = p_user and layer = v_prev) then
      return jsonb_build_object('ok', false,
        'error', 'Clear the ' || coalesce(v_names->>v_prev, v_prev) || ' first.');
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Service role only -- these are called from the dungeon edge function, never by a client.
revoke execute on function public.dungeon_clear_record(uuid, text, text) from anon, authenticated, public;
revoke execute on function public.dungeon_gate_check(uuid, text) from anon, authenticated, public;

-- ---- Owner tooling -------------------------------------------------------------------------------
-- Inspect or repair one account's progression by hand (support path: a legitimate player whose grandfather
-- sync did not land). Service-role only.
create or replace function public.dungeon_clears_of(p_user uuid)
returns table (layer text, source text, first_cleared_at timestamptz)
language sql security definer set search_path = public as $$
  select layer, source, first_cleared_at from public.dungeon_clears
  where user_id = p_user order by public.dungeon_layer_index(layer);
$$;
revoke execute on function public.dungeon_clears_of(uuid) from anon, authenticated, public;
