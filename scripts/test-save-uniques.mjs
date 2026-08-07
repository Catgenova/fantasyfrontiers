// Unit test for save_game's forged-unique audit (ticket-0163, AndJustice4All).
//
// The edge functions have no test harness -- typecheck-functions.mjs is the only thing that looks at them,
// and it only fails the build on a handful of high-signal codes (proven: a type mismatch passes, an
// undefined name exits 1). That is far too thin for code whose ENFORCEMENT PATH DELETES PLAYER ITEMS, so
// this exercises the real functions out of the real file rather than a copy that could drift.
//
// Method: the module is Deno-flavoured (a remote import plus Deno.serve), so we slice off the import line
// and everything from Deno.serve onward, append an export block, and import the remainder. What runs here
// IS the shipped source above that cut point.
//
// The types are stripped with the TYPESCRIPT COMPILER, not by letting node import the .ts directly. Node's
// own type-stripping needs 22.6+, and CI pins Node 20 -- so the first version of this test passed locally
// on 22.22 and failed the deploy instantly on 20 with an unknown-file-extension error. Transpiling makes
// the test independent of the runtime's TS support, which is the property a CI gate actually needs.
//
// Run: node scripts/test-save-uniques.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SRC = 'supabase/functions/save_game/index.ts';
const src = readFileSync(SRC, 'utf8');

const cut = src.indexOf('Deno.serve(');
if (cut < 0) { console.error('FAIL: could not find Deno.serve in ' + SRC); process.exit(1); }
let head = src.slice(0, cut).replace(/^import .*$/m, '// (import stripped for the test harness)');
// VACUITY GUARD on the harness itself: if the slice ever stops containing the audit, this test would pass
// by testing nothing at all.
for (const needle of ['function auditUniques', 'function stripFindings', 'UNIQUE_ENCHANT_SLOTS']) {
  if (head.indexOf(needle) < 0) { console.error('FAIL: harness sliced away ' + needle); process.exit(1); }
}
head += '\nexport { auditUniques, stripFindings, UNIQUE_ENHANCE_MAX, UNIQUE_VALIDATE_ENFORCE };\n';
const js = ts.transpileModule(head, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  fileName: 'save_game_head.ts',
}).outputText;
const dir = mkdtempSync(join(tmpdir(), 'ffsave-'));
const modPath = join(dir, 'save_game_head.mjs');
writeFileSync(modPath, js);
const M = await import(pathToFileURL(modPath).href);

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// A fake catalogue: only these keys are real items.
const REAL = new Set([
  'stweapon_greatsword_t20_fantastic',
  'ring_fire_t20_fantastic',
  'relic_t20_normal',
  'bodyarmor_plate_chest_t14_rare',
]);
function fakeAdmin(opts = {}) {
  return {
    from(table) {
      if (table !== 'item_catalog') throw new Error('unexpected table ' + table);
      return {
        select() { return this; },
        in(_col, keys) {
          if (opts.error) return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: keys.filter((k) => REAL.has(k)).map((k) => ({ item_key: k })), error: null });
        },
      };
    },
  };
}
const whys = (f) => f.findings.map((x) => x.why.split(':')[0]).sort();

// ---- A clean, entirely legitimate save must produce NOTHING. This is the assertion that protects real
// players: a false finding here becomes a deleted item the moment enforcement is switched on.
{
  const data = {
    uniqueItems: {
      u1: { uid: 'u1', base: 'stweapon_greatsword_t20_fantastic', kind: 'weapon', tier: 20, rarity: 'fantastic',
            enhance: 15, enchants: [{ mod: 'critDamage', roll: 30 }, { mod: 'critChance', roll: 12 },
                                    { mod: 'weaponDamage', roll: 25 }, { mod: 'flatDamage', roll: 999999 }] },
      u2: { uid: 'u2', base: 'ring_fire_t20_fantastic', kind: 'ring', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] },
      u3: { uid: 'u3', base: 'relic_t20_normal', kind: 'relic', tier: 20, rarity: 'normal', enhance: 3, enchants: [{ mod: 'maxHp', roll: 20 }] },
      u4: { uid: 'u4', base: 'bodyarmor_plate_chest_t14_rare', kind: 'bodyarmor', tier: 14, rarity: 'rare', enhance: 7,
            enchants: [{ mod: 'defense', roll: 5 }, { mod: 'maxHp', roll: 9 }] },
    },
    equippedMainhandUid: 'u1', equippedRelicUid: 'u3',
  };
  const f = await M.auditUniques(fakeAdmin(), data);
  eq(f.checked, 4, 'a clean save is fully checked');
  eq(f.findings.length, 0, 'a clean save yields NO findings');
  // A raw damage line legitimately rolls into the tens of thousands and must not be bounded here (phase 2).
  ok(true, 'a tier-scaled raw enchant roll is accepted');
}

// ---- The reported exploit: an item that simply does not exist.
{
  const data = { uniqueItems: { hax: { uid: 'hax', base: 'stweapon_excalibur_t99_mythic', tier: 99, rarity: 'mythic', enhance: 0, enchants: [] } } };
  const f = await M.auditUniques(fakeAdmin(), data);
  eq(f.findings.length, 1, 'a forged base is caught');
  eq(f.findings[0].why, 'base_not_tier_rarity_shaped', '...on its malformed key (mythic is not a rarity)');
}
{
  // A well-SHAPED key that is still not a real item -- this is the catalogue check doing the work.
  const data = { uniqueItems: { hax: { uid: 'hax', base: 'stweapon_excalibur_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] } } };
  const f = await M.auditUniques(fakeAdmin(), data);
  eq(f.findings.length, 1, 'a plausible but nonexistent base is caught');
  eq(f.findings[0].why, 'base_not_in_catalog', '...by the catalogue allowlist');
}

// ---- Relabelling a real item: the key encodes tier and rarity, so the fields cannot disagree with it.
{
  const data = { uniqueItems: { r: { uid: 'r', base: 'bodyarmor_plate_chest_t14_rare', tier: 14, rarity: 'fantastic', enhance: 0, enchants: [] } } };
  eq(whys(await M.auditUniques(fakeAdmin(), data)).join(), 'rarity_mismatch', 'a relabelled rarity is caught');
}
{
  const data = { uniqueItems: { r: { uid: 'r', base: 'bodyarmor_plate_chest_t14_rare', tier: 20, rarity: 'rare', enhance: 0, enchants: [] } } };
  eq(whys(await M.auditUniques(fakeAdmin(), data)).join(), 'tier_mismatch', 'a relabelled tier is caught');
}

// ---- Enhance beyond the real cap, and the boundary that must NOT trip.
{
  const mk = (enh) => ({ uniqueItems: { e: { uid: 'e', base: 'ring_fire_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: enh, enchants: [] } } });
  eq((await M.auditUniques(fakeAdmin(), mk(16))).findings.length, 1, 'enhance 16 is caught');
  eq((await M.auditUniques(fakeAdmin(), mk(15))).findings.length, 0, 'enhance 15 (the real cap) is fine');
  eq((await M.auditUniques(fakeAdmin(), mk(-1))).findings.length, 1, 'a negative enhance is caught');
  eq((await M.auditUniques(fakeAdmin(), mk(2.5))).findings.length, 1, 'a fractional enhance is caught');
  eq(M.UNIQUE_ENHANCE_MAX, 15, 'the cap matches the client ENHANCE_MAX');
}

// ---- More enchant slots than the rarity allows, and each rarity's own boundary.
{
  const line = { mod: 'critDamage', roll: 1 };
  const mk = (rarity, n) => ({ uniqueItems: { s: { uid: 's', base: 'relic_t20_' + rarity, tier: 20, rarity,
    enhance: 0, enchants: Array.from({ length: n }, () => line) } } });
  // relic_t20_normal is the only relic in the fake catalogue, so use it for the slot arithmetic.
  eq((await M.auditUniques(fakeAdmin(), mk('normal', 1))).findings.length, 0, 'normal may carry 1 enchant');
  eq(whys(await M.auditUniques(fakeAdmin(), mk('normal', 2))).join(), 'enchant_slots', 'normal may not carry 2');
  eq(whys(await M.auditUniques(fakeAdmin(), mk('normal', 5))).join(), 'enchant_slots', 'nor 5');
}
{
  const data = { uniqueItems: { s: { uid: 's', base: 'ring_fire_t20_fantastic', tier: 20, rarity: 'fantastic',
    enhance: 0, enchants: [{ mod: '', roll: 1 }] } } };
  eq(whys(await M.auditUniques(fakeAdmin(), data)).join(), 'enchant_line_malformed', 'a nameless enchant line is caught');
}

// ---- Dangling equip pointers: the signature of a hand-edited blob.
{
  const data = { uniqueItems: { u1: { uid: 'u1', base: 'ring_fire_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] } },
                 equippedMainhandUid: 'ghost' };
  eq(whys(await M.auditUniques(fakeAdmin(), data)).join(), 'dangling_pointer', 'a pointer at a nonexistent uid is caught');
}

// ---- A catalogue read FAILURE must invent nothing. Once enforcement is on, a findings-on-error audit
// would delete every legitimate item in the save the moment the database hiccuped.
{
  const data = { uniqueItems: { u1: { uid: 'u1', base: 'ring_fire_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] } } };
  eq((await M.auditUniques(fakeAdmin({ error: true }), data)).findings.length, 0, 'a catalogue read error fails OPEN');
}

// ---- Empty and absent shapes are not findings.
for (const [label, data] of [['no uniqueItems', {}], ['empty bag', { uniqueItems: {} }], ['an array', { uniqueItems: [] }]]) {
  const f = await M.auditUniques(fakeAdmin(), data);
  eq(f.findings.length, 0, label + ' yields no findings');
}

// ---- stripFindings: removes exactly the offenders, clears pointers, keeps the innocent.
{
  const data = {
    uniqueItems: {
      good: { uid: 'good', base: 'ring_fire_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] },
      bad:  { uid: 'bad', base: 'stweapon_excalibur_t20_fantastic', tier: 20, rarity: 'fantastic', enhance: 0, enchants: [] },
    },
    equippedMainhandUid: 'bad',
    equippedRelicUid: 'good',
    jewelrySlots: { ring1: { typeId: 'ringFire', tier: 21, rarity: 'fantastic', uid: 'bad' },
                    ring2: { typeId: 'ringFire', tier: 21, rarity: 'fantastic', uid: 'good' } },
  };
  const f = await M.auditUniques(fakeAdmin(), data);
  eq(f.findings.length, 1, 'one offender found before stripping');
  const removed = M.stripFindings(data, f.findings);
  eq(removed, 1, 'exactly one unique removed');
  ok(!!data.uniqueItems.good, 'the legitimate item SURVIVES');
  ok(!data.uniqueItems.bad, 'the forged item is gone');
  eq(data.equippedMainhandUid, null, 'the pointer at the forged item is cleared');
  eq(data.equippedRelicUid, 'good', 'the pointer at the legitimate item is untouched');
  eq(data.jewelrySlots.ring1.uid, null, 'the jewelry slot holding the forged item is cleared');
  eq(data.jewelrySlots.ring2.uid, 'good', 'the jewelry slot holding a real item is untouched');
}

// ---- Ship state: enforcement must be OFF. Flipping it on is a deliberate, separate decision.
eq(M.UNIQUE_VALIDATE_ENFORCE, false, 'enforcement ships OFF (warn-only)');

console.log('test-save-uniques: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
