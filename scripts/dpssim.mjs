// Max-ceiling DPS simulation: boots the REAL game headless (?selftest seam + __FF._startLoop), seeds a
// fully maxed state, fights a zero-offense Archdemon, and measures live damage over a fixed window.
// Usage: node scripts/dpssim.mjs            (60s per config; SIM_MS=20000 for a quick pass)
//        PW_CHROMIUM=/path/to/chromium node scripts/dpssim.mjs   (custom browser binary)
// Currently configured for the Summoner (Conductor) across its four staff legendaries; adapt CONFIGS
// and setup() for other classes. This harness caught the assassin-gated Downbeat hook (v0.0.57.10).
import { chromium } from "playwright";
import http from "http";
import { readFile } from "fs/promises";
import path from "path";

import { fileURLToPath } from "url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME = { ".html": "text/html", ".js": "text/javascript" };
const server = http.createServer(async (req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  try { const b = await readFile(p); res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("nope"); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const DURATION_MS = Number(process.env.SIM_MS || 60000);
const CONFIGS = [
  { name: "Packbrand (pack-scaled Downbeat)", leg: "packbrand" },
  { name: "Baton of the First Chair (4s swing)", leg: "rapidconjuring" },
  { name: "Necrocaller (Finale wraiths)", leg: "necrocaller" },
  { name: "Broodwyrm (double Earth enchants)", leg: "broodwyrm" },
];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html?selftest`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__FF_SELFTEST && (window.__FF_SELFTEST.passed > 0 || window.__FF_SELFTEST.error), null, { timeout: 60000 });

async function setup(leg, cloakLeg) {
  return await page.evaluate(([leg, cloakLeg]) => {
    const FF = window.__FF, st = FF._state;
    const diag = { leg, cloakLeg };
    // 1) Max every skill the sim touches: class, proficiencies, crafting gates, attunement, physiques.
    const lv100 = FF.xpFloorForLevel(100);
    Object.keys(st.xp).forEach(k => { st.xp[k] = lv100; });
    ["summoner", "staves", "arcanism", "staff"].forEach(k => { st.xp[k] = lv100; }); // 'staff' = the per-style accuracy key
    // Physiques are their own xp map (accuracy, damage, crit all read them).
    st.physique = st.physique || {};
    (FF.PHYSIQUE_SKILLS || []).forEach(ph => { st.physique[ph.id] = lv100; });
    // 2) Full D2 Chorus of Fangs set (Pack Tactics + Kindred Fury crits), fantastic pieces.
    st.bodyArmor = {}; st.uniqueItems = st.uniqueItems || {};
    const d2 = FF.D2_SET_DEFS && FF.D2_SET_DEFS.summoner;
    const slots = d2 && d2.bareHead ? ["chest", "gauntlets", "boots"] : ["helmet", "chest", "gauntlets", "boots"];
    const apool = FF.ENCHANT_MODS.armor;
    const aMax = id => { const m = apool.filter(x => x.id === id)[0]; const r = FF.enchantModRange(m, 20); return { mod: id, roll: r && r.max != null ? r.max : m.max }; };
    slots.forEach(slot => {
      const uid = FF.mintSetPiece("summoner", slot, "fantastic", "d2");
      const u = st.uniqueItems[uid];
      u.enchants = [aMax("defense"), aMax("maxHp"), aMax("dmgReduction"), aMax("blockChance")];
      u.enhance = 15; // armor pool is defensive; enchant-then-+15 is still the per-item ceiling
      st.bodyArmor[slot] = { uid: uid, material: u.material, tier: (u.tier || 21) + 1, rarity: "fantastic" };
    });
    // Back slot: legendary Shroud (bodyArmor.back.leg is the real storage; A/B'd -- Ruin all-dmg /
    // Warpack elemental / Widow crit-dmg).
    st.bodyArmor.back = { leg: cloakLeg, rarity: "fantastic" };
    // 3b) Jewelry: 3 legendary Signets (Brood famhaste / Fury attack speed / Wyrm elemental) +
    // 2 unique t20 fantastic Communion rings and 1 amulet, each 4 jewelry lines then +15. Relic & belt:
    // unique fantastic t20, enchanted then +15 (relic = +dmg%/armor%, scaled x6 by its enhance).
    const jpool = FF.ENCHANT_MODS.jewelry;
    const jMax = id => { const m = jpool.filter(x => x.id === id)[0]; const r = FF.enchantModRange(m, 20); return { mod: id, roll: r && r.max != null ? r.max : m.max }; };
    const jLines = () => [jMax("allDamage"), jMax("critDamage"), jMax("critChance"), jMax("lifesteal")];
    st.jewelrySlots = {};
    st.jewelrySlots.ring1 = { leg: "famhaste", rarity: "fantastic" };
    st.jewelrySlots.ring2 = { leg: "d2_fury", rarity: "fantastic" };
    st.jewelrySlots.ring3 = { leg: "d4_wyrm", rarity: "fantastic" };
    ["ring4", "ring5"].forEach((sid, i) => {
      const uid = "SIMR" + i;
      st.uniqueItems[uid] = { uid, kind: "ring", base: "ring_communion_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
      st.jewelrySlots[sid] = { typeId: "communion", tier: 20, rarity: "fantastic", uid };
    });
    st.uniqueItems.SIMA = { uid: "SIMA", kind: "amulet", base: "amulet_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
    st.jewelrySlots.amulet = { typeId: "warding", tier: 20, rarity: "fantastic", uid: "SIMA" };
    st.uniqueItems.SIMREL = { uid: "SIMREL", kind: "relic", base: "relic_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
    st.equippedRelicTier = 20; st.equippedRelicRarity = "fantastic"; st.equippedRelicUid = "SIMREL";
    const bpool = FF.ENCHANT_MODS.armor;
    st.uniqueItems.SIMB = { uid: "SIMB", kind: "belt", base: "belt_t19_fantastic", tier: 19, rarity: "fantastic",
      enchants: [aMax("defense"), aMax("maxHp"), aMax("dmgReduction"), aMax("blockChance")], enhance: 15 };
    st.equippedBeltTier = 20; st.equippedBeltRarity = "fantastic"; st.equippedBeltUid = "SIMB";
    // 3) Legendary fantastic t20 staff: 4 max enchant lines FIRST, then +15 (legal order in-game; the
    // enhance multiplier scales base AND enchant stats x6). Broodwyrm swaps a line to Earth for its double.
    const wpool = FF.ENCHANT_MODS.weapon;
    const maxRoll = id => { const m = wpool.filter(x => x.id === id)[0]; const r = FF.enchantModRange(m, 20); return { mod: id, roll: r && r.max != null ? r.max : m.max }; };
    const enchants = leg === "broodwyrm"
      ? [maxRoll("weaponDamage"), maxRoll("critDamage"), maxRoll("critChance"), maxRoll("earthDamage")]
      : [maxRoll("weaponDamage"), maxRoll("critDamage"), maxRoll("critChance"), maxRoll("flatDamage")];
    st.uniqueItems.SIMW = { uid: "SIMW", leg: leg, kind: "weapon", base: "stweapon_staff_t20_fantastic",
      tier: 20, rarity: "fantastic", enchants: enchants, enhance: 15 };
    st.equippedMainhand = "staff"; st.equippedMainhandTier = 21; st.equippedMainhandRarity = "fantastic";
    st.equippedMainhandUid = "SIMW";
    st.equippedOffhand = null; st.equippedOffhandTier = 0; st.equippedOffhandUid = null;
    diag.enchants = enchants;
    // 4) Six best damage familiars, Lv100 + 3 stars each.
    const famScore = id => {
      const f = FF.FAMILIAR_DATA[id]; if (!f || !f.spells) return 0;
      return f.spells.reduce((n, s) => n + ((s.type === "hit" || s.type === "siphon") ? (s.amount || 0) : 0), 0);
    };
    const famIds = Object.keys(FF.FAMILIAR_DATA).sort((a, b) => famScore(b) - famScore(a));
    st.familiars = {};
    const nSlots = FF.activeCompanionSlots(st);
    const roster = famIds.slice(0, nSlots);
    roster.forEach(id => { st.familiars[id] = { owned: true, level: 100, stars: 3 }; });
    st.activeCompanions = roster.slice();
    st.companionCast = {};
    roster.forEach(id => { st.companionCast[id] = { accum: 0, index: 0 }; });
    diag.roster = roster; diag.slots = nSlots;
    // 5) Fresh rhythm state.
    st.staffDownbeats = []; st.staffLastDownbeatAt = 0; st.summonerCrescendo = 0; st.summonerWraiths = [];
    st.familiarBuffs = st.familiarBuffs || {};
    // 6) Target: highest-tier monster, offense zeroed (pure training dummy with real defenses).
    let top = FF.MONSTERS.filter(m => /archdemon/i.test(m.id) || /Archdemon/.test(m.name))[0];
    if (!top) { FF.MONSTERS.forEach(m => { if (!top || (m.tierIndex || 0) > (top.tierIndex || 0)) top = m; }); }
    top.atkMin = 0; top.atkMax = 0; top.attackSpeed = 99999; top.special = null;
    st.activity = { type: "combat", monsterId: top.id, monsterHp: 1e12, tickAccum: 0, monsterTickAccum: 0,
      duelStartedAt: Date.now(), samuraiFirstStrike: true };
    st.playerHp = FF.maxHp(st);
    diag.target = { id: top.id, name: top.name, tierIndex: top.tierIndex, dodge: top.dodge, element: top.element };
    diag.activeClass = FF.activeClassId(st);
    diag.maxHp = FF.maxHp(st);
    window.__SIM = { lastHp: 1e12, total: 0, t0: performance.now(), refills: 0 };
    return diag;
  }, [leg, cloakLeg]);
}

async function sample() {
  return await page.evaluate(() => {
    const FF = window.__FF, st = FF._state, s = window.__SIM;
    const a = st.activity;
    if (!a || a.type !== "combat") return { dead: true, total: s.total, elapsed: performance.now() - s.t0 };
    s.total += Math.max(0, s.lastHp - a.monsterHp);
    if (a.monsterHp < 1e11) { a.monsterHp = 1e12; s.refills++; }
    s.lastHp = a.monsterHp;
    return { total: s.total, elapsed: performance.now() - s.t0,
      stacks: FF.staffDownbeatStacks(st), cres: FF.summonerCrescendo(st),
      wraiths: (st.summonerWraiths || []).length, dbPower: FF.staffDownbeatPower(st),
      hitPct: Math.round(FF.playerHitChance(FF.MONSTERS.filter(m => m.id === a.monsterId)[0]) * 100) };
  });
}

async function runOne(name, leg, cloakLeg, ms) {
  const diag = await setup(leg, cloakLeg);
  await page.evaluate(() => window.__FF._startLoop());
  if (diag.activeClass !== "summoner") { console.log(name, "SETUP FAILED:", JSON.stringify(diag)); return null; }
  let last = null, peak = { stacks: 0, cres: 0, wraiths: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 500));
    last = await sample();
    if (last.dead) break;
    peak.stacks = Math.max(peak.stacks, last.stacks || 0);
    peak.cres = Math.max(peak.cres, last.cres || 0);
    peak.wraiths = Math.max(peak.wraiths, last.wraiths || 0);
  }
  const out = { config: name, leg, cloak: cloakLeg, seconds: Math.round(last.elapsed / 1000),
    dps: Math.round(last.total / (last.elapsed / 1000)), totalDamage: Math.round(last.total),
    peakDownbeatStacks: peak.stacks, peakCrescendo: peak.cres, peakWraiths: peak.wraiths,
    downbeatPowerPerStack: last.dbPower, hitPct: last.hitPct, target: diag.target.name };
  console.log(JSON.stringify(out));
  return out;
}

// Phase 1: cloak A/B on the Baton build (short windows).
const CLOAKS = ["d2_ruin", "d2_warpack", "critdmg"];
let bestCloak = CLOAKS[0], bestDps = -1;
for (const c of CLOAKS) {
  const r = await runOne("cloak A/B: " + c, "rapidconjuring", c, Math.min(DURATION_MS, 45000));
  if (r && r.dps > bestDps) { bestDps = r.dps; bestCloak = c; }
}
console.log("WINNING CLOAK:", bestCloak);
// Phase 2: full matrix with the winning cloak.
for (const cfg of CONFIGS) await runOne(cfg.name, cfg.leg, bestCloak, DURATION_MS);
await browser.close(); server.close();
