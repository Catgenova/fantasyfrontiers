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

async function setup(leg) {
  return await page.evaluate((leg) => {
    const FF = window.__FF, st = FF._state;
    const diag = { leg };
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
    slots.forEach(slot => {
      const uid = FF.mintSetPiece("summoner", slot, "fantastic", "d2");
      const u = st.uniqueItems[uid];
      st.bodyArmor[slot] = { uid: uid, material: u.material, tier: (u.tier || 21) + 1, rarity: "fantastic" };
    });
    st.bodyArmor.back = { tier: 21, rarity: "fantastic", material: "tailoring" };
    // 3) Legendary fantastic t20 staff with max damage enchant lines.
    const pool = FF.ENCHANT_MODS.weapon;
    const pick = [];
    pool.forEach(m => {
      if (/damage/i.test(m.id) || m.raw) {
        const r = FF.enchantModRange(m, 20);
        pick.push({ mod: m.id, roll: r && r.max != null ? r.max : (m.max || 10) });
      }
    });
    const enchants = pick.slice(0, 5);
    st.uniqueItems.SIMW = { uid: "SIMW", leg: leg, kind: "weapon", base: "stweapon_staff_t20_fantastic",
      tier: 20, rarity: "fantastic", enchants: enchants, enhance: 0 };
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
  }, leg);
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

for (const cfg of CONFIGS) {
  const diag = await setup(cfg.leg);
  await page.evaluate(() => window.__FF._startLoop());
  if (diag.activeClass !== "summoner") { console.log(cfg.name, "SETUP FAILED — active class:", diag.activeClass, JSON.stringify(diag)); continue; }
  let last = null, peak = { stacks: 0, cres: 0, wraiths: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < DURATION_MS) {
    await new Promise(r => setTimeout(r, 500));
    last = await sample();
    if (last.dead) break;
    peak.stacks = Math.max(peak.stacks, last.stacks || 0);
    peak.cres = Math.max(peak.cres, last.cres || 0);
    peak.wraiths = Math.max(peak.wraiths, last.wraiths || 0);
  }
  const dps = last.total / (last.elapsed / 1000);
  console.log(JSON.stringify({ config: cfg.name, leg: cfg.leg, seconds: Math.round(last.elapsed / 1000),
    totalDamage: Math.round(last.total), dps: Math.round(dps),
    peakDownbeatStacks: peak.stacks, peakCrescendo: peak.cres, peakWraiths: peak.wraiths,
    downbeatPowerPerStack: last.dbPower, hitPct: last.hitPct, target: diag.target.name, roster: diag.roster.join(",") }));
}
await browser.close(); server.close();
