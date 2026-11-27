-- WAKE PEEK (v0.0.77.32, offline-catchup audit) -------------------------------------------------------
--
-- One round trip a waking or booting client uses to reconcile time and staleness. It returns the
-- caller's saves-row timestamps PLUS the server's own clock, so the client can bound its offline credit
-- by SERVER-WITNESSED absence:
--
--     witnessed_away = server_now - updated_at
--
-- updated_at was stamped BY THE SERVER at the client's own last accepted push, at or before the tab
-- went dark, so witnessed_away >= the true absence, always. The client takes
-- min(wall_clock_away, witnessed_away + slack), which can only strip INFLATION, never legitimate
-- credit. The inflation is real: a brand-new player was granted the full 12-hour catch-up cap off one
-- tab hide/show -- the client wall clock (the only clock the catch-up used) had jumped while the tab
-- was hidden, most plausibly NTP correcting a fresh device's slow clock. The same bound is applied on
-- the reload path, whose anchor (the blob's lastSaved) is a client stamp with the same weakness.
--
-- The client falls back to a plain `saves` row read when this function is missing, so it is safe to
-- deploy the client before or after this migration.
--
-- SECURITY: security definer, reads only the CALLER's row (auth.uid()); anon revoked. A caller with no
-- row still gets server_now_ms, which is not sensitive.

create or replace function public.wake_peek()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
        'ok', true,
        'client_saved_at', s.client_saved_at,
        'updated_at_ms',   (extract(epoch from s.updated_at) * 1000)::bigint,
        'server_now_ms',   (extract(epoch from now())        * 1000)::bigint)
       from public.saves s
      where s.user_id = auth.uid()),
    jsonb_build_object(
        'ok', true,
        'client_saved_at', null,
        'updated_at_ms',   null,
        'server_now_ms',   (extract(epoch from now()) * 1000)::bigint));
$$;

revoke execute on function public.wake_peek() from public, anon;
grant  execute on function public.wake_peek() to authenticated;
