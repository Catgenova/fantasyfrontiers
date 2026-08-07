-- Fantasy Frontiers -- SHADOW sweep: uniques that appear without a plausible origin (ticket-0163).
--
-- NOT APPLIED YET. Migrations are the owner's to deploy; this is a DRAFT to review, baseline and schedule.
-- It records signals and clamps NOTHING, by design, and must stay that way until a week of output has been
-- read by a human. Precedent for that caution is written all over this directory: the progress-jump
-- detector clamped the game's strongest account twice in one day, and the unexplained-rarity sweep flagged
-- an active bug reporter. Assume this one will misfire too until the evidence says otherwise.
--
-- WHAT IT IS FOR. The structural validator now in save_game rejects uniques that are not real catalogue
-- items, whose tier/rarity contradict their own key, whose enhance exceeds 15, or which carry more enchant
-- slots than their rarity allows. What it cannot see is a CATALOGUE-VALID item that was never earned: a
-- genuine fantastic +15 with four maximum rolls, simply inserted. That is a provenance question, and the
-- server has no crafting simulation to answer it with -- the same gap public.player_items closes for
-- stackables and the same reason item_sync is client-reported.
--
-- THE SIGNAL. Uniques are only minted by paths that take REAL TIME and REAL MATERIALS: a craft, an enhance
-- (one level per attempt, 5%-95% chance, destroys the item on failure at high levels), a mastercraft, a
-- market or guild-bank collection. So the honest way to arrive at a fantastic +15 with four maxed lines is
-- a long series of saves in which it exists at +0, then +1, then +2. What cannot happen honestly is for it
-- to appear FULLY FORMED between two consecutive saves. This sweep compares each account's uniques against
-- a snapshot of what it held last time and flags top-end items that arrived out of nowhere.
--
-- WHY A SWEEP AND NOT A CHECK IN save_game. The comparison needs the PREVIOUS save blob, and save_game does
-- not read it (it selects only progress/version/active_session/updated_at). A client pushes every 8 seconds,
-- so reading a second ~500KB jsonb on that hot path would roughly double the function's read volume for a
-- detector that does not need to be real-time. The item-earn sweep is out-of-band for the same reason.
--
-- ACCEPTED BLIND SPOTS, stated so nobody mistakes this for coverage:
--   * an editor who inserts the item at +0 and walks it up over many saves defeats this entirely. That is
--     the same "patient editor" limit the progress detector has, and the durable answer is the same:
--     server-witnessed minting, i.e. the batch-validated crafting project.
--   * a legitimate GUILD BANK withdrawal or market collection is a real fully-formed arrival. Both are
--     server-witnessed, so the honest fix is to log them and subtract, exactly as item_credit_log does for
--     stackables. Until that log exists this sweep WILL flag real withdrawals, which is a large part of why
--     it ships shadow-only. Do not enforce before that subtraction exists.
--   * saves are only sampled when the sweep runs, so anything crafted and traded away between two runs is
--     invisible. Same held-at-sample limitation the depletion hardening documented for item_sync.

begin;

-- ---- 1. Snapshot table ---------------------------------------------------------------------------
-- One row per (account, unique uid) that the sweep has already seen. Mirrors item_earn_watch.
create table if not exists public.unique_watch (
  user_id     uuid not null references auth.users(id) on delete cascade,
  uid         text not null,
  base        text not null,
  enhance     int  not null default 0,
  enchants    int  not null default 0,
  first_seen  timestamptz not null default now(),
  primary key (user_id, uid)
);
alter table public.unique_watch enable row level security;
revoke all on public.unique_watch from anon, authenticated;
create index if not exists unique_watch_user_idx on public.unique_watch (user_id);

-- ---- 2. Tunables ---------------------------------------------------------------------------------
-- min_enhance / min_enchants: only TOP-END arrivals are interesting. A fresh +0 normal appearing is just
--   crafting; a +12 with 4 lines appearing fully formed is not. These two numbers are what keep the signal
--   off ordinary play, so they are the first thing to revisit if the shadow week is noisy.
-- rarities: which rarities to watch at all. Normal and rare uniques are cheap and constantly minted.
create or replace function public.unique_provenance_config()
returns table (min_enhance int, min_enchants int, rarities text[])
language sql immutable as $$ select 12::int, 3::int, array['supreme','fantastic']::text[] $$;

-- ---- 3. The sweep --------------------------------------------------------------------------------
-- Returns one row per flagged (user, uid) so a human can read the output directly. p_enforce exists only
-- to match the shape of the other sweeps; it is IGNORED here on purpose -- this detector has no clamp path
-- until the bank/market subtraction described above exists. Passing true does not clamp anyone.
create or replace function public.unique_provenance_sweep(p_enforce boolean default false)
returns table (user_id uuid, uid text, base text, enhance int, enchants int)
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  r   record;
  v_first_run boolean;
begin
  select * into cfg from public.unique_provenance_config();

  for r in
    select s.user_id as uid_user,
           k.key     as u_uid,
           k.value->>'base'                                as u_base,
           coalesce((k.value->>'enhance')::int, 0)         as u_enh,
           coalesce(jsonb_array_length(
             case when jsonb_typeof(k.value->'enchants') = 'array'
                  then k.value->'enchants' else '[]'::jsonb end), 0) as u_ench
    from public.saves s
    cross join lateral jsonb_each(
      case when jsonb_typeof(s.data->'uniqueItems') = 'object'
           then s.data->'uniqueItems' else '{}'::jsonb end) as k
    where jsonb_typeof(s.data->'uniqueItems') = 'object'
  loop
    -- Is this account being seen for the first time? If so every one of its uniques is "new", and flagging
    -- an entire established inventory would be pure noise -- so a first run BASELINES and reports nothing.
    -- Newly covered accounts baseline on their first sweep, exactly as the legendary-accessory sweep does;
    -- pre-existing forgeries are therefore out of scope BY DESIGN and need the one-off review query below.
    select not exists (select 1 from public.unique_watch w where w.user_id = r.uid_user)
      into v_first_run;

    if not exists (select 1 from public.unique_watch w
                   where w.user_id = r.uid_user and w.uid = r.u_uid) then
      insert into public.unique_watch (user_id, uid, base, enhance, enchants)
      values (r.uid_user, r.u_uid, coalesce(r.u_base, ''), r.u_enh, r.u_ench)
      on conflict (user_id, uid) do nothing;

      -- A fully formed top-end arrival on an account we already had a baseline for.
      if not v_first_run
         and r.u_enh >= cfg.min_enhance
         and r.u_ench >= cfg.min_enchants
         and split_part(coalesce(r.u_base, ''), '_', array_length(string_to_array(coalesce(r.u_base,''), '_'), 1)) = any(cfg.rarities)
      then
        -- Rate-limit to one row per account per hour, like every other detector: an account re-saving
        -- every 8 seconds must not be able to flood the audit log.
        if not exists (select 1 from public.clamp_signals c
                       where c.user_id = r.uid_user and c.kind = 'unique_provenance'
                         and c.created_at > now() - interval '1 hour') then
          insert into public.clamp_signals (user_id, kind, detail, would_clamp)
          values (r.uid_user, 'unique_provenance',
                  jsonb_build_object(
                    'uid', r.u_uid, 'base', r.u_base,
                    'enhance', r.u_enh, 'enchants', r.u_ench,
                    'note', 'appeared fully formed between sweeps; a guild-bank withdrawal or market collection looks identical until those are logged'),
                  false);
        end if;
        return query select r.uid_user, r.u_uid, r.u_base, r.u_enh, r.u_ench;
      end if;
    else
      -- Already known. Keep the row current so a later enhance does not read as a new arrival.
      update public.unique_watch w
         set enhance = greatest(w.enhance, r.u_enh),
             enchants = greatest(w.enchants, r.u_ench)
       where w.user_id = r.uid_user and w.uid = r.u_uid;
    end if;
  end loop;

  -- Drop watch rows for uniques the account no longer holds, so a uid that is spent and later REUSED by the
  -- client's uidSeq counter cannot masquerade as an item we have already vouched for.
  delete from public.unique_watch w
   where not exists (
     select 1 from public.saves s
     where s.user_id = w.user_id
       and jsonb_typeof(s.data->'uniqueItems') = 'object'
       and s.data->'uniqueItems' ? w.uid);
  return;
end $$;

revoke all on function public.unique_provenance_sweep(boolean) from anon, authenticated;
revoke all on function public.unique_provenance_config() from anon, authenticated;

commit;

-- ---------------------------------------------------------------------------------------------------
-- DEPLOY ORDER. I cannot execute any of this here (no database in the build environment).
--
-- STEP 1 -- baseline. Reports nothing by design; it only records where every account currently stands.
--     select * from public.unique_provenance_sweep(false);
--     -- EXPECT: zero rows. Any row on the FIRST run is a bug in the baselining, not a cheater.
--     select count(*) from public.unique_watch;   -- EXPECT: > 0, one row per unique held
--
-- STEP 2 -- the one-off question this sweep cannot answer. Pre-existing forgeries baseline as legitimate,
--     so look for them ONCE by hand. Top-end uniques whose base is not a real catalogue item:
--     select s.user_id, pr.username, k.key as uid, k.value->>'base' as base
--     from public.saves s
--     left join public.profiles pr on pr.id = s.user_id
--     cross join lateral jsonb_each(s.data->'uniqueItems') k
--     where jsonb_typeof(s.data->'uniqueItems') = 'object'
--       and not exists (select 1 from public.item_catalog c where c.item_key = k.value->>'base');
--     -- EXPECT: zero rows on an honest population. Anything here is the reported exploit, already landed.
--
-- STEP 3 -- schedule it hourly, offset from the other sweeps so they do not pile up:
--     select cron.schedule('unique-provenance-sweep', '23 * * * *',
--                          $job$ select public.unique_provenance_sweep(false) $job$);
--
-- STEP 4 -- review after a week. Every row is a candidate, NOT a verdict:
--     select s.created_at, pr.username, s.detail->>'base' as base,
--            s.detail->>'enhance' as enh, s.detail->>'enchants' as lines
--     from public.clamp_signals s left join public.profiles pr on pr.id = s.user_id
--     where s.kind = 'unique_provenance' order by s.created_at desc;
--     -- Expect guild-bank withdrawals and market collections in here. They are the known false positives,
--     -- and they are the reason there is no enforcement path in this function at all.
--
-- STEP 5 -- before this could ever enforce, two things must exist first: a server-side log of unique
--     bank/market transfers to subtract (the item_credit_log equivalent), and a week of signals whose
--     remainder is unexplained. Enforcement would be a separate, deliberate change with its own review.
