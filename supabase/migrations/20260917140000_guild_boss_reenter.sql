-- ============================================================================
-- GUILD BOSS: re-enter the boss your entry is already on (v0.1.4.3, owner list item 5, 2026-09-17).
--
-- ticket-0228: the kill is client-side and only the clear REPORT tells the guild. When that report failed
-- (a network blip, a closed tab in the second between kill and report), the day's single entry was burned
-- with nothing to show for it, and there was no honest way to refund it: the server cannot tell "the report
-- failed" from "the player lost". What it CAN do is let the same member re-enter the SAME boss on the same
-- day: the entry is already spent on that boss, a second fight against it costs the guild nothing, and if
-- the boss is meanwhile cleared by anyone the existing 'cleared' branch still refuses. So guild_boss_enter
-- now returns 'ok' (with reentered = true) for the boss the member already holds today, and 'used' only for
-- a DIFFERENT boss. Everything else is unchanged.
-- ============================================================================

create or replace function public.guild_boss_enter(p_user uuid, p_guild uuid, p_day date, p_boss int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int; v_held int;
begin
  if exists (select 1 from public.guild_boss_clears where guild_id = p_guild and day = p_day and boss_idx = p_boss) then
    return jsonb_build_object('status','cleared');
  end if;
  insert into public.guild_boss_entries(user_id, day, guild_id, boss_idx)
    values (p_user, p_day, p_guild, p_boss)
    on conflict (user_id, day) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then
    select boss_idx into v_held from public.guild_boss_entries where user_id = p_user and day = p_day;
    if v_held = p_boss then return jsonb_build_object('status','ok','reentered',true); end if;   -- same boss: fight it again
    return jsonb_build_object('status','used');
  end if;
  return jsonb_build_object('status','ok');
end $$;

-- The function keeps its signature, so the 20260810140000 grants/revokes still apply (service role only).

-- ----------------------------------------------------------------------------
-- VERIFY (read-only, run by hand after apply):
--   select public.guild_boss_enter('<uid>'::uuid, '<gid>'::uuid, current_date, 2);   -- first call: {"status":"ok"}
--   select public.guild_boss_enter('<uid>'::uuid, '<gid>'::uuid, current_date, 2);   -- again: {"status":"ok","reentered":true}
--   select public.guild_boss_enter('<uid>'::uuid, '<gid>'::uuid, current_date, 3);   -- other boss: {"status":"used"}
-- ----------------------------------------------------------------------------
