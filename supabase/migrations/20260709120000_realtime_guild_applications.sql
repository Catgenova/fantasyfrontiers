-- The client subscribes to postgres_changes on public.guild_applications (the "guild-apps-" and
-- "guild-myapp-" realtime channels) so guild applications and their acceptance/rejection update live.
-- guild_applications was created + RLS'd in guilds_foundation, but never added to the supabase_realtime
-- publication -- so those subscriptions silently never receive events. Add it now.
--
-- Idempotent: adding a table already in the publication raises duplicate_object, which we swallow so
-- re-running (e.g. after a manual dashboard add) is safe.
do $$
begin
  alter publication supabase_realtime add table public.guild_applications;
exception
  when duplicate_object then null; -- already a member of the publication
end $$;
