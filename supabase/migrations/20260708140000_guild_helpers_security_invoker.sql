-- Clear the last two SECURITY DEFINER lints (0028/0029) for the guild RLS helpers.
--
-- current_guild_id() / current_guild_rank() are parameterless, derive everything from auth.uid(), and
-- are used only inside RLS policies -- so they were never a real risk. But they were SECURITY DEFINER
-- purely so they could read guild_members. guild_members is world-readable (RLS enabled, single
-- `select using (true)` policy), so the caller can read their own membership row perfectly well as
-- themselves. Switching to SECURITY INVOKER therefore preserves behaviour AND clears the lint (the
-- linter only flags SECURITY DEFINER functions exposed to anon/authenticated).
--
-- The explicit table grant guarantees the invoker (anon/authenticated) has the underlying SELECT
-- privilege the functions rely on -- normally already granted by Supabase defaults; this makes it
-- non-negotiable so the flip can't break guild RLS.

grant select on public.guild_members to anon, authenticated;

alter function public.current_guild_id()   security invoker;
alter function public.current_guild_rank() security invoker;
