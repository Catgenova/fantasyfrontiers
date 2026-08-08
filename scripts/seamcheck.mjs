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

// ---- CHECK 3: offline catch-up must precede the item sync -------------------------------------------
// applyOfflineProgress credits the away window; itemSync reports inventory to the ledger, whose rate clock
// reads the account's own synced_at. Sync first and a returning player's allowance is computed against a
// clock that has just been reset, which throttles them for the rest of the window. The ordering is enforced
// today only by an `await` that reads like a formality, and the failure is invisible in play (a slow drip,
// not an error). The browser suite cannot cover it either: boot is async, and suite() is synchronous and
// discards its return value, so an assertion inside a .then() runs after the report is written. Hence here.
{
  const at = script.indexOf("async function startGameOnline()");
  if (at === -1) {
    fail("startGameOnline() not found -- the boot-order check cannot run.");
  } else {
    const fn = script.slice(at);
    const body = fn.slice(0, fn.indexOf("\n  }") + 4);
    const awaitInit = body.indexOf("await initGame()");
    const sync = body.search(/\bitemSync\s*\(/);
    if (awaitInit === -1) {
      fail("startGameOnline no longer awaits initGame().\n"
         + "       initGame runs applyOfflineProgress. Without the await, the item sync can land first and\n"
         + "       throttle every returning player's allowance against a freshly reset synced_at clock.");
    } else if (sync !== -1 && sync < awaitInit) {
      fail("startGameOnline calls itemSync() BEFORE `await initGame()`.\n"
         + "       initGame runs applyOfflineProgress. The ledger's rate clock reads synced_at, so syncing\n"
         + "       first throttles every returning player's item allowance. Move the sync after the await.");
    }
  }
}
console.log("seamcheck: boot order (offline catch-up before item sync) intact.");

// ---- CHECK 4: no damage source may be invisible in the combat log ----------------------------------
// The standing rule is that every damage source shows in the Combat log. It was broken in eight places at
// once, and the reason it stayed broken is that the breakage is SILENT: `act.monsterHp -= x` deals damage
// perfectly and simply never writes a row. The Firebomb sat at 210 damage against best-in-slot hits of ~1e11
// for as long as it did precisely because nobody could see what it did.
//
// So the rule is enforced structurally: raw damage application is allowed at exactly two sites, and every
// other source must route through applyEffectDamage or applyEffectDot (which log), or push its own row.
// A new mechanic that subtracts monsterHp directly now fails CI instead of shipping invisible.
{
  // Site 1: the main weapon hit, which writes its own dir:'out' row a few lines above.
  // Site 2: applyChipDamage itself, the primitive both logging helpers are built on.
  // The rule is uniform: a raw subtraction is fine ONLY if a combat-log row is pushed nearby. That covers
  // the main hit (its dir:'out' row) and the Assassin's Fang Strike (a dir:'out' row tagged echo:'Fang
  // Strike'), and it rejects anything that just quietly removes health.
  const rawLines = L.map((l, i) => ({ l, i })).filter((r) => /\b[a-z]+\.monsterHp\s*-=/.test(r.l));
  for (const { l, i } of rawLines) {
    // applyChipDamage IS the primitive both logging helpers are built on, so its own subtraction is the
    // one place raw damage belongs. Everything else has to explain itself.
    if (/function applyChipDamage/.test(L.slice(Math.max(0, i - 4), i).join("\n"))) continue;
    const window = L.slice(Math.max(0, i - 4), i + 14).join("\n");
    if (!/combatLogPush\(/.test(window)) {
      fail(`raw monsterHp subtraction with no combatLogPush nearby, line ${i + 1}:\n`
         + `       ${l.trim().slice(0, 110)}\n`
         + "       Damage applied this way lands perfectly and writes NO combat-log row, which is how the\n"
         + "       Firebomb's dead scaling went unnoticed. Route it through applyEffectDamage(dmg, 'Name')\n"
         + "       for a discrete hit, or applyEffectDot(dmg, 'Name') for a per-frame slice.");
    }
  }
  // Raw applyChipDamage callers are allowed only where a dir:'fam' or dir:'out' row is pushed nearby, which
  // is how the familiar spells, the Skeletal Wraith and the Assassin's Fang Strike already log. Anything
  // else is silent damage wearing a different hat.
  const chipLines = L.map((l, i) => ({ l, i }))
    .filter((r) => /(?<!function )applyChipDamage\s*\(/.test(r.l) && !/var killed = applyChipDamage/.test(r.l));
  for (const { l, i } of chipLines) {
    const window = L.slice(Math.max(0, i - 2), i + 30).join("\n");
    if (!/combatLogPush\(/.test(window)) {
      fail(`applyChipDamage at line ${i + 1} has no combatLogPush within 30 lines -- silent damage.\n`
         + `       ${l.trim().slice(0, 100)}\n`
         + "       Use applyEffectDamage / applyEffectDot, or push a row of its own.");
    }
  }
}
console.log("seamcheck: every damage source reaches the combat log.");

// ---- CHECK 5: every class-capstone Combat quest must read a counter something writes -----------------
// The nine capstone quests (Deep Freeze, Draw-Cut, the Big One, Doom, Bare, the Fall, Bloom, the pour, Cuts)
// each read cb_cap_<key>, and each key is written by exactly one cbClassEvent call inside that class's engine.
// Delete the call and the quest becomes quietly unachievable: no error, no failing assertion, just a bar that
// never moves. The browser suite cannot catch it either without a full best-in-slot fixture per class, so the
// coupling is enforced structurally instead.
{
  const read = new Set([...script.matchAll(/cbStat\('cb_cap_([a-z]+)'\)/g)].map((m) => m[1]));
  // Line-based and comment-aware: a regex over the raw text matched `// cbClassEvent('drawcut');` and
  // reported the counter as written when it had just been commented out. Same mistake the sqlcheck DO-block
  // scan made against a commented-out `-- do $$`.
  const written = new Set();
  for (const line of L) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const m = /cbClassEvent\('([a-z]+)'/.exec(line);
    if (m) written.add(m[1]);
  }
  const orphans = [...read].filter((k) => !written.has(k)).sort();
  if (orphans.length) {
    fail(`${orphans.length} capstone quest counter(s) nothing writes: ${orphans.join(", ")}\n`
       + "       A Combat quest reads cb_cap_<key> but no cbClassEvent('<key>') call exists, so its progress\n"
       + "       bar can never move. Restore the call inside that class's engine.");
  }
  const unread = [...written].filter((k) => !read.has(k)).sort();
  if (unread.length) {
    console.log(`seamcheck: note - capstone counters written but no quest reads them yet: ${unread.join(", ")}`);
  }
  console.log(`seamcheck: ${read.size} capstone quest counter(s), all written.`);
}

// ---- CHECK 6: every estate quest counter a quest reads must be written somewhere -----------------------
// Same failure mode as the capstone counters, one system over: unhook estNote from a job-completion site and
// the quest's bar simply never moves. No error, nothing to see. The browser suite cannot cover it without
// driving the whole estate job pipeline, and calling bumpStat directly in a test proves only that bumpStat
// works -- which is exactly how the first version of these guards passed with the hooks commented out.
//
// estNote(key, isGuild) writes BOTH est_<key> and est_g_<key>, so the guild-scoped keys are covered by the
// same rule: drop the guild half and every Act V counter loses its writer.
{
  const read = new Set([...script.matchAll(/estStat\('(est_[a-z_]+)'\)/g)].map((m) => m[1]));
  const written = new Set();
  for (const line of L) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    for (const m of line.matchAll(/bumpStat\('(est_[a-z_]+)'/g)) written.add(m[1]);
    // cbBest is the high-water helper (est_height is a maximum reached, not a running total).
    for (const m of line.matchAll(/cbBest\('(est_[a-z_]+)'/g)) written.add(m[1]);
    for (const m of line.matchAll(/estNote\('([a-z_]+)'/g)) { written.add('est_' + m[1]); written.add('est_g_' + m[1]); }
    // The helper itself declares the guild half; if that line goes, so does every est_g_ key.
    if (/function estNote\(/.test(line) && !/est_g_/.test(line)) written.add('__NO_GUILD_HALF__');
  }
  if (written.has('__NO_GUILD_HALF__')) {
    fail("estNote no longer writes the est_g_ guild-scoped half.\n"
       + "       Every Act V Estate quest reads est_g_*, so all of them would stall at zero.");
  }
  const orphans = [...read].filter((k) => !written.has(k)).sort();
  if (orphans.length) {
    fail(`${orphans.length} estate quest counter(s) nothing writes: ${orphans.join(", ")}\n`
       + "       An Estate quest reads the key but no bumpStat/estNote call writes it, so its progress bar\n"
       + "       can never move. Restore the hook at the job-completion site.");
  }
  console.log(`seamcheck: ${read.size} estate quest counter(s), all written.`);
}

// ---- CHECK 7: the peon LOAD clamp must use the CEILING, never the live cap ------------------------------
// This one exists because the browser suite cannot reach it. state.peons is truncated inside loadGame, which
// runs BEFORE the estate grid is validated, so a clamp computed from the live per-scope cap reads a
// half-loaded grid, comes back as the base five, and SILENTLY DELETES the sixth through tenth tasks of any
// player who built Bunkhouses. There is no assertion that can catch that from inside a running game (the
// tasks are already gone by the time the seam exists), so it is checked as source structure instead.
{
  const clampLines = L
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /state\.(peons|guildPeons)\s*=\s*state\.(peons|guildPeons)\.slice\(/.test(line));
  if (clampLines.length !== 2) {
    fail(`expected exactly 2 peon load clamps, found ${clampLines.length}.\n`
       + "       state.peons and state.guildPeons are each truncated once at load. If that changed, re-check\n"
       + "       that the new shape still cannot delete tasks a Bunkhouse legitimately allows.");
  }
  const bad = clampLines.filter(({ line }) => !/PEON_SLOT_CEILING/.test(line));
  if (bad.length) {
    fail(`${bad.length} peon load clamp(s) do not use PEON_SLOT_CEILING (line(s) ${bad.map((b) => b.n).join(", ")}).\n`
       + "       The clamp runs before the estate grid is validated, so a live cap reads as the base 5 and\n"
       + "       deletes the extra Peon tasks of anyone who built Bunkhouses. Clamp to the ceiling.");
  } else if (clampLines.length === 2) {
    console.log("seamcheck: both peon load clamps use the slot ceiling.");
  }
}

// ---- CHECK 8: every reconstructed border cell must carry the Trellis flag ------------------------------
// The estate expansion re-grid rebuilds each carried border as a FRESH OBJECT LITERAL naming the fields it
// keeps, so any field not listed is silently dropped. A Trellis is a flag on the edge cell, which means
// expanding the estate would have quietly stripped every Trellis a player had raised. No in-game assertion
// reaches that (the flag is gone before any seam exists, and only on the expansion path), so like the peon
// clamp above it is checked as source structure.
{
  const edgeLiterals = L
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /newEdges\.edges[XY]\[[^\]]+\]\[[^\]]+\]\s*=\s*\{/.test(line));
  if (edgeLiterals.length !== 2) {
    fail(`expected exactly 2 expansion border-carry literals, found ${edgeLiterals.length}.\n`
       + "       The expansion re-grid carries edgesY and edgesX once each. If that changed, re-check that\n"
       + "       every field on an edge cell (type, masonryTileId, trellis) still survives an expansion.");
  }
  const missing = edgeLiterals.filter(({ line }) => !/trellis/.test(line));
  if (missing.length) {
    fail(`${missing.length} expansion border-carry literal(s) drop the trellis flag (line(s) ${missing.map((b) => b.n).join(", ")}).\n`
       + "       Expanding the estate would strip every Flowering Trellis. Carry the flag explicitly.");
  } else if (edgeLiterals.length === 2) {
    console.log("seamcheck: both expansion border-carry literals keep the trellis flag.");
  }
}

// ---- CHECK 9: the live and offline harvests accumulate the same yield bonuses ---------------------------
// harvestPlot and the offline catch-up are two separate accumulation sites, and a bonus added to one and not
// the other is invisible in play: the number is simply lower after an absence, with nothing to notice. The
// Apiary carries a comment warning about exactly this. So the two are pinned to each other by count.
{
  const yieldAdds = L.filter((line) => /yieldQty\s*\+=/.test(line));
  const apiary = yieldAdds.filter((line) => /apiary/i.test(line)).length;
  const trellis = yieldAdds.filter((line) => /trellis/i.test(line)).length;
  if (apiary < 2) {
    fail(`expected the apiary yield bonus to be accumulated in at least 2 places, found ${apiary}.\n`
       + "       The live harvest and the offline catch-up each add it. If that changed, re-check that every\n"
       + "       yield bonus still reaches BOTH paths.");
  } else if (trellis !== apiary) {
    fail(`the trellis yield reaches ${trellis} accumulation site(s) but the apiary reaches ${apiary}.\n`
       + "       A bonus wired into the live harvest but not the offline one silently pays less to a player\n"
       + "       who was away. Add it to both.");
  } else {
    console.log(`seamcheck: the live and offline harvests both accumulate every yield bonus (${apiary} sites).`);
  }
}

// ---- CHECK 10: the service worker must never be able to pin an old build --------------------------------
// The game updates itself by polling version.json and reloading when the deployed build id changes. A
// service worker sits IN FRONT of that: cache-first navigations would serve the old index.html forever and
// the "update" reload would reload the stale copy -- the classic PWA one-release-behind bug, invisible in
// any test that runs a single load. So the worker's shape is pinned structurally:
//   * navigations are NETWORK-FIRST (fetch() appears before caches.open in the navigate branch),
//   * version.json is never named in sw.js at all (it must fall through untouched),
//   * exactly two respondWith branches exist (navigations + static art), so nothing else can be intercepted,
//   * the page links the manifest and registers the worker, and the build ships all four PWA statics.
{
  // Comment-stripped, because the worker's header comment NAMES the invariants it protects ("never touch
  // version.json", "never calling respondWith") and a guard that reads comments fails on its own
  // documentation -- the authRender precedent from v0.0.72, repeated here within the hour.
  const swSrc = readFileSync("sw.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const navAt = swSrc.indexOf("req.mode === 'navigate'");
  if (navAt === -1) {
    fail("sw.js has no navigation branch (req.mode === 'navigate'). Navigations must be network-first.");
  } else {
    const navBlock = swSrc.slice(navAt, swSrc.indexOf("// 2.", navAt) === -1 ? swSrc.length : swSrc.indexOf("// 2.", navAt));
    const fetchAt = navBlock.indexOf("fetch(req)");
    const cacheAt = navBlock.indexOf("caches.open");
    if (fetchAt === -1 || cacheAt === -1 || fetchAt > cacheAt) {
      fail("sw.js navigations are not network-first: fetch(req) must come before any cache read in the\n"
         + "       navigate branch. Cache-first here pins every player one release behind forever.");
    }
  }
  if (/version\.json/.test(swSrc)) {
    fail("sw.js mentions version.json. The updater's poll must fall through the worker untouched --\n"
       + "       any special-casing (even well-meant) risks serving a stale build id.");
  }
  const intercepts = (swSrc.match(/respondWith/g) || []).length;
  if (intercepts !== 2) {
    fail(`sw.js has ${intercepts} respondWith call(s), expected exactly 2 (navigations + static art).\n`
       + "       A third interception path must be argued for here and in the worker's header comment.");
  }
  const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
  const sizes = (manifest.icons || []).map((i) => i.sizes);
  if (manifest.display !== "standalone" || !sizes.includes("192x192") || !sizes.includes("512x512")) {
    fail("manifest.webmanifest must declare display:standalone and 192x192 + 512x512 icons (installability).");
  }
  if (!(manifest.icons || []).some((i) => i.purpose === "maskable")) {
    fail("manifest.webmanifest has no maskable icon; Android renders the fallback icon shrunken in a white disc.");
  }
  for (const f of ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png", ".well-known/assetlinks.json"]) {
    if (!existsSync(f)) fail(`${f} is missing but the manifest or the TWA path expects it.`);
  }
  if (!/rel="manifest"/.test(html) || !/serviceWorker' in navigator/.test(html)) {
    fail("index.html must link the manifest and register sw.js (both were present at v0.0.96.0).");
  }
  const build = readFileSync("scripts/build.mjs", "utf8");
  for (const name of ["manifest.webmanifest", "sw.js", '"icons"', '".well-known"']) {
    if (!build.includes(name)) {
      fail(`scripts/build.mjs no longer copies ${name} to dist -- the deployed site would silently lose it\n`
         + "       while the repo copy keeps working, which no browser test of the source tree can see.");
    }
  }
  if (!failures) console.log("seamcheck: the service worker is network-first, leaves version.json alone, and the PWA statics ship.");
}

console.log(failures ? `seamcheck: ${failures} failure(s).` : "seamcheck: clean.");
process.exit(failures ? 1 : 0);
