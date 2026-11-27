-- ============================================================================
-- CATALOGUE THE MINTED ARMOUR SET PIECES. A live false positive, firing hourly on honest players.
--
-- THE SIGNAL. shadow_signal_digest has been posting "unique_forged: Valuren, 4 of 76 uniques failed
-- validation, reasons: base_not_in_catalog x4, first: bodyarmor_chain_helmet_t21_rare" every hour. Those
-- four are a legitimately forged Masterwork armour set. Nothing was clamped and nothing was removed
-- (UNIQUE_VALIDATE_ENFORCE is false in save_game, which is the only reason this cost noise instead of
-- somebody's gear), but the signal is wrong and it would have deleted the set the moment enforcement
-- was flipped on.
--
-- THE CAUSE, and it is ours, not a rarity rule. index.html generates the set-tier body armour
-- (t21 D1 / t22 D2 / t23 D3 / t24 D4) AFTER `Object.assign(ALL_SELLABLE, BODY_ARMOR_ITEMS)` has already
-- run, so buildItemCatalog() -- which reads ALL_SELLABLE -- never saw the family. Every rarity was
-- missing, normal included; the "rare" in the reported key is incidental. A probe that mints all 1,488
-- (layer x class x slot x rarity) set pieces through the real mintSetPiece path found 100% of them
-- outside the catalogue, and every one of the 560 legendary weapon/shield/ward bases already inside it.
--
-- WHY THESE KEYS ARE NOT IN INVENTORY AND STILL NEED A ROW. A set piece exists only as the `base` of a
-- unique in state.uniqueItems; nobody ever holds one as a stack. But save_game's forged-unique audit reads
-- item_catalog as the allowlist for a unique's base key, so an uncatalogued base reads as invented.
--
-- tradeable = FALSE, deliberately. Same treatment as legendary equipment: catalogued so the audit and the
-- ledger accept it, refused by the marketplace gate (which requires tradeable). These are minted uniques
-- and must never become listable.
--
-- IDEMPOTENT and additive: `on conflict do nothing`, no truncate. The repo's generated seed
-- (supabase/seeds/item_catalog_seed.sql, 14,519 rows, CI-checked against the client) now contains these
-- 256 keys too, so re-running the full seed later is equivalent; this file is the small paste that fixes a
-- live table without rewriting 14.5k rows on it.
--
-- The cross product below is the client's own generation loop, and it was verified key-for-key against the
-- regenerated seed's diff: exactly 256 added, zero removed, zero tradeable-flag changes.
-- ============================================================================

begin;

insert into public.item_catalog (item_key, tradeable)
select 'bodyarmor_' || m || '_' || s || '_t' || t || '_' || r, false
from   unnest(array['tailoring','leather','chain','plate'])            as m
cross join unnest(array['helmet','chest','gauntlets','boots'])         as s
cross join unnest(array[21,22,23,24])                                  as t
cross join unnest(array['normal','rare','supreme','fantastic'])        as r
on conflict (item_key) do nothing;

commit;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY. I cannot run any of this here (no database in the build environment).
--
-- STEP 1 -- the family is present, all four layers, all four rarities:
--     select substring(item_key from '_t(\d+)_') as tier, count(*), bool_and(not tradeable) as all_untradeable
--     from public.item_catalog
--     where item_key like 'bodyarmor%' and substring(item_key from '_t(\d+)_')::int between 21 and 24
--     group by 1 order by 1;
--     -- EXPECT: four rows (21,22,23,24), count 64 each, all_untradeable = true.
--
-- STEP 2 -- the reported key specifically, the one in the digest:
--     select * from public.item_catalog where item_key = 'bodyarmor_chain_helmet_t21_rare';
--     -- EXPECT: one row, tradeable = false.
--
-- STEP 3 -- nobody's uniques are outside the allowlist any more. This is the query from
--     20260807140000's runbook, and it is the real pass/fail for this migration:
--     select pr.username, k.value->>'base' as base, count(*)
--     from public.saves s
--     left join public.profiles pr on pr.id = s.user_id
--     cross join lateral jsonb_each(s.data->'uniqueItems') k
--     where jsonb_typeof(s.data->'uniqueItems') = 'object'
--       and not exists (select 1 from public.item_catalog c where c.item_key = k.value->>'base')
--     group by 1,2 order by 3 desc;
--     -- EXPECT: zero rows. Anything left here is a real candidate, not this false positive.
--
-- STEP 4 -- the digest goes quiet on its own at the next :35, because save_game stops finding anything.
--     The already-recorded rows stay as evidence; they are the ones reading base_not_in_catalog:
--     select count(*), min(created_at), max(created_at) from public.clamp_signals
--     where kind = 'unique_forged' and detail->>'reasons' like '%base_not_in_catalog%';
--
-- BEFORE EVER SETTING UNIQUE_VALIDATE_ENFORCE = true: re-run the catalogue seed first and confirm STEP 3
-- returns zero rows. Enforcement DELETES the offending uniques, and this incident is what that looks like
-- when the allowlist is behind the client.
