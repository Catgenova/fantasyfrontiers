// Two static checks over index.html that the in-browser suite cannot do for itself.
//
// Run: npm run seamcheck   (CI runs it before the build)
//
// ---- CHECK 1: the test seam is complete -------------------------------------------------------------
// window.__FF is 194 lines of ~1,861 hand-maintained keys and grows by roughly twenty per class rework.
// Forgetting one is invisible until a suite run blows up with "FF.x is not a function" -- which happened
// twice in a single day (classPortraitFor, LEG_EMBERDRAW_WEAKNESS), each costing a full build+smoke cycle to
// discover. This reads every FF.<name> the tests and the DPS sim actually reference and asserts the seam
// exports it, so the omission surfaces in a second instead of after a browser boot.
//
// ---- CHECK 2: new per-foe combat state must be reset ------------------------------------------------
// A fresh foe clears ~97 act.* fields in defeatMonster. Every class rework adds one to three, and forgetting
// one leaks state between foes -- a silent correctness bug with no symptom until a player notices their meter
// carrying over. Nothing enforced it.
//
// The rule is not "everything must be cleared", because a deliberate distinction already exists in the code:
//   * UNBOUNDED METERS (rvCuts, pyFuel, samuraiFocus, reaperRot, woundStacks...) are explicitly cleared.
//     These are the dangerous ones: nothing else ever brings them down, so a carried value is permanent.
//   * TIME-STAMPED DEBUFFS (enemyStunUntil, wyrdBrandUntil, scorchUntil...) are allowed to carry, because
//     they expire on their own clock. d2RunicStacks self-zeroes once its Until has passed, and so on.
// So this flags an assigned act.* field that is NEIGHBOUR to neither: not cleared on a foe swap, and not
// self-expiring by name. That is the shape of a real leak, and the allowlist below stays small because of it.
import { readFileSync, existsSync, readdirSync } from "node:fs";

const SRC = "index.html";
const html = readFileSync(SRC, "utf8");
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).reduce((a, b) => (b.length > a.length ? b : a));
const L = script.split("\n");

let failures = 0;
const fail = (msg) => { console.error("seamcheck: FAIL " + msg); failures++; };

// ---------- CHECK 1 ----------
const seamStart = L.findIndex((l) => /window\.__FF\s*=/.test(l));
if (seamStart < 0) { fail("could not find the window.__FF seam"); }
let seamEnd = seamStart, depth = 0, opened = false;
for (let j = seamStart; j < L.length && seamStart >= 0; j++) {
  for (const c of L[j]) { if (c === "{") { depth++; opened = true; } else if (c === "}") depth--; }
  if (opened && depth <= 0) { seamEnd = j; break; }
}
const seamBody = L.slice(seamStart, seamEnd + 1).join("\n");
// Keys are `name:value` pairs; capture the key side only.
const exported = new Set([...seamBody.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]));

const consumers = [];
for (const dir of ["tests", "scripts"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (/\.(js|mjs)$/.test(f)) consumers.push(`${dir}/${f}`);
}
const referenced = new Map();   // name -> first "file:line"
for (const file of consumers) {
  if (file === "scripts/seamcheck.mjs") continue;      // this file talks ABOUT the seam, never through it
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    [...line.matchAll(/\bFF\.([A-Za-z_$][\w$]*)/g)].forEach((m) => {
      // `typeof FF.x === 'undefined'` asserts a RETIRED helper is gone. Those references must NOT be
      // exported -- exporting one would break the very assertion. Six of them live in the suite.
      if (new RegExp("typeof\\s+FF\\." + m[1] + "\\b").test(line)) return;
      if (!referenced.has(m[1])) referenced.set(m[1], `${file}:${i + 1}`);
    });
  });
}
const missing = [...referenced.keys()].filter((n) => !exported.has(n)).sort();
for (const n of missing) fail(`FF.${n} is used at ${referenced.get(n)} but the seam does not export it`);
console.log(`seamcheck: seam exports ${exported.size} keys; ${referenced.size} referenced by tests/sim; ${missing.length} missing`);

// ---------- CHECK 2 ----------
// Fields cleared by the foe swap: clearEnemySpecialState's body, plus the reset run in defeatMonster.
const cleared = new Set();
const csIdx = L.findIndex((l) => /^\s*function clearEnemySpecialState/.test(l));
if (csIdx >= 0) {
  let d = 0, o = false;
  for (let j = csIdx; j < L.length; j++) {
    for (const c of L[j]) { if (c === "{") { d++; o = true; } else if (c === "}") d--; }
    [...L[j].matchAll(/\bact\.(\w+)\s*=(?!=)/g)].forEach((m) => cleared.add(m[1]));
    if (o && d <= 0) break;
  }
}
const swapIdx = L.findIndex((l) => /clearEnemySpecialState\(act\);/.test(l));
if (swapIdx < 0) fail("could not find the foe-swap reset block");
for (let j = swapIdx; j < Math.min(swapIdx + 80, L.length); j++) {
  [...L[j].matchAll(/\bact\.(\w+)\s*=(?!=)/g)].forEach((m) => cleared.add(m[1]));
}

// Deliberately NOT per-foe. Each entry is a decision, not an oversight -- keep the reason with it.
const PERSIST_OK = new Set([
  "type", "monsterId", "monsterHp", "monsterTickAccum", "tickAccum", "offhandTickAccum", // the activity itself
  "duelStartedAt", "fightTarget", "fightsWon",      // a limited run spans foes by definition
  "floor", "guildBoss", "idx",                      // dungeon / tower context, per activity not per foe
  "guardianBondUsed", "cheatDeathUsed", "d3RevenantUsed", // once-per-fight lifelines
  "goldEarned",                                     // fight-scoped tally (Greedwyrm reads it)
  "thCoffer", "thGoldCharges",                      // Treasure Hunter: fight-scoped, not foe-scoped
  "d3BurnDecayAccum", "d3PoisonDecayAccum", "d4BurnScorchAccum", "d4PoisonScorchAccum", // sub-tick remainders
  "breathCharge",                                   // has its own d4BreathReset
  "enemyMightPer", "enemyRallyMult", "siphonFrac",  // enemy special modifiers, re-derived per foe
  "lastDamagedAt",                                  // a clock, re-stamped on the swap
  // Non-combat activities share the `act` name (crafting, estate, gathering).
  "material", "skillId", "slot", "typeId", "producedQty", "logTierIndex", "progress", "itemId", "craftKind",
]);
// A field whose name says it is a deadline expires on its own clock, so carrying it is bounded and safe.
// So is a field PAIRED with one: scorchStacks is meaningless once scorchUntil passes, wyrdBrandElems once
// wyrdBrandUntil does, and d2RunicStacks literally self-zeroes past its own Until. That pairing is the real
// rule -- it generalises to the next class, where a hard-coded allowlist would not.
const DEADLINE = /(Until|At)$/;
const bounded = (f, all) => {
  if (/(Until|At|Accum)$/.test(f)) return true;
  const base = f.replace(/(Stacks|Elems|Dps|Charges|Count|Mult)$/, "");
  return base !== f && [...all].some((o) => DEADLINE.test(o) && o.replace(DEADLINE, "") === base);
};

const assigned = new Map();
L.forEach((l, i) => {
  [...l.matchAll(/\bact\.(\w+)\s*=(?!=)/g)].forEach((m) => {
    if (!assigned.has(m[1])) assigned.set(m[1], i + 1);
  });
});
const leaks = [...assigned.keys()]
  .filter((f) => !cleared.has(f) && !PERSIST_OK.has(f) && !bounded(f, assigned.keys()))
  .sort();
for (const f of leaks) {
  fail(`act.${f} (first written line ${assigned.get(f)}) is combat state that a foe swap never clears.\n`
     + `       If it is an unbounded meter, reset it in defeatMonster beside the others. If it is meant to\n`
     + `       persist across foes, add it to PERSIST_OK in scripts/seamcheck.mjs with the reason.`);
}
console.log(`seamcheck: ${assigned.size} act.* fields assigned, ${cleared.size} cleared on a foe swap, ${leaks.length} unexplained`);

console.log(failures ? `seamcheck: ${failures} failure(s).` : "seamcheck: clean.");
process.exit(failures ? 1 : 0);
