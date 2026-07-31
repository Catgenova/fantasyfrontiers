// Max-ceiling DPS simulation: boots the REAL game headless (?selftest seam + __FF._startLoop), seeds a
// fully maxed best-in-slot state, and measures live damage vs a zero-offense Archdemon (real defenses).
//
// Usage: SIM_CLASS=assassin SIM_MS=45000 node scripts/dpssim.mjs
//        PW_CHROMIUM=/path/to/chromium for a custom browser binary.
//
// Owner-approved ceiling rules (see CLAUDE.md "Max-ceiling DPS simulation"):
//  - every slot filled fantastic; each unique gets its 4 max enchant lines FIRST, then +15
//    (enchant-then-enhance is the intended min-max order: +15 scales base AND enchant stats x6)
//  - NO consumables / Faith actives / server buffs
//  - all st.xp keys Lv100 + the per-style weapon key (accuracy!) + every physique
// Phases per class: set-layer A/B -> cloak A/B -> final matrix over the class's weapon legendaries.
// This harness caught the assassin-gated Downbeat bug (v0.0.57.10): trust a 0-stat anomaly.
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

const DURATION_MS = Number(process.env.SIM_MS || 45000);
const SIM_CLASS = process.env.SIM_CLASS || "assassin";

// Per-class build definitions. weapon: base/tier + the per-style xp keys accuracy reads; legs: mainhand
// legendary keys for the final matrix; setLayers: D-set layers to A/B; signets: 3 legendary ring keys;
// uniqueRingType: the crafted ring for the last two slots (the class's scaling stat).
const BUILDS = {
  summoner: {
    weapon: { typeId: "staff", styleXp: ["staff", "staves", "arcanism"] },
    legs: ["packbrand", "rapidconjuring", "necrocaller", "broodwyrm"],
    weaponLines: leg => leg === "broodwyrm"
      ? ["weaponDamage", "critDamage", "critChance", "earthDamage"]
      : ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["famhaste", "d2_fury", "d4_wyrm"], uniqueRingType: "communion",
  },
  assassin: {
    weapon: { typeId: "claw", styleXp: ["claw"] },
    legs: ["phantomassault", "throatripper", "wraithclaw", "shadowwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "slash",
    offhandClaw: true,
  },
  duelist: {
    // Rapier + EMPTY offhand. The Sidestep clock self-drives the whole dodge kit, so the sim measures
    // it honestly with no priming; the zero-offense dummy means no REAL dodges (En Garde's clock
    // advance and Untouchable's hit-halving never trigger -- both strictly favor the player anyway).
    weapon: { typeId: "rapier", styleXp: ["rapier"] },
    legs: ["engarde", "bloodwaltz", "phantomthrust", "wyrmdancer"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "pierce",
  },
  thunderfury: {
    // Earth Wand + Earth Ward, full cloth. The wand is a FULL-elemental swing (the scepter double-dip at
    // double strength) — expect the chassis fight; per the owner rule any correction lands in class perk
    // variables, never wand raw damage stats. Ward fixed to Stormscale (Galvanize cap 15) — Stormcoil/
    // Voltveil key off reflects the zero-offense dummy never throws, Stormveil needs hits taken.
    // 45s window (1s bolts, no macro-cycle); unique rings are Rings of Earth (wands skip physical rings).
    weapon: { typeId: "wandEarth", styleXp: ["wandEarth", "wands", "earth"] },
    legs: ["tempest", "stormbrand", "stormtomb", "stormwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "earth",
    offhandWard: "stormscale",
  },
  templar: {
    // Scepter + Ward. 90s runs: the 24s Litany needs several Amens per window. The ward slot is fixed to
    // Sunscale (Doxology cap 8) — the only ward whose effect fires against the zero-offense dummy
    // (Hallowlight/Sanctveil key off ward reflects, which never happen; Aegisveil deepens a defensive bank).
    weapon: { typeId: "scepter", styleXp: ["scepter", "scepters", "runesmithing", "light"] },
    legs: ["retribution", "sunbrand", "lichbane", "sunwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "blunt",
    offhandWard: "sunscale",
  },
  quickdraw: {
    // Short bow + quiver + plate boots + leather. First ranged build: the quiver offhand and a mountain
    // of top-tier arrows (Fletcher's Economy doubles their base damage, so arrow tier is a real stat).
    // The cycle is deterministic, so these are the cleanest runs of any class so far.
    weapon: { typeId: "bowShort", styleXp: ["bowShort"] },
    legs: ["chainshot", "serpentcoil", "cryptvenom", "breathfang"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "pierce",
    offhandQuiver: true,
  },
  reaper: {
    // Scythe + BARE head + cloth. Rot ticks are the damage engine (weapon-scaled, so they ride the same
    // BiS multipliers as the swings). Sim caveats: the zero-offense dummy keeps the Siphon Shield
    // permanently full once banked (flatters Wraithguard's faster ticks and Spectral Edge's full-shield
    // lash), and the refilled HP pool means no kills — Contagion (D1 full) measures dead here.
    weapon: { typeId: "scythe", styleXp: ["scythe"] },
    legs: ["spectralaegis", "soulflay", "deathshepherd", "soulflame"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "slash",
  },
  herald: {
    // Mace + large shield, full plate. The FIRST tank simmed, and the first shield offhand. His whole kit
    // used to key off being hit; the Bastion's self-driven Brace clock (every 5s, counting as a Block for
    // every effect) is what makes him measurable against a zero-offense dummy at all. Ironclad converts the
    // LIVE Armor rating into damage, so the BiS plate + Fortress ramp are offense here -- expect the armour
    // number itself to be the balance surface. Owner target: ~60B (a tank band, below the 70-90B dps classes).
    // Sim-dead: Bastion's hit cap, Unbreakable's mitigation, real Blocks (the dummy never swings).
    weapon: { typeId: "mace", styleXp: ["mace"] },
    legs: ["shieldbash", "wallbreaker", "tombshatter", "bastionbreaker"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "blunt",
    offhandShield: { type: "shieldLarge", leg: "bulwarkbreach" }, // the biggest wall = the biggest Breach
  },
  treasureHunter: {
    // Scimitar + SMALL shield, chain helm/boots + plate chest + cloth gloves. The Reliquary fires BROKEN
    // RELICS as ammunition, so the pack is seeded EMPTY (relics are consumables -- owner rule) and the class
    // bootstraps itself: a full Grave Charge with no ammo DIGS a relic instead of striking, then Grave Dowsing
    // (35%, 70% with the D2 full) keeps it fed. That bootstrap is the only reason this is measurable at all.
    // KILL-gated lines all read DEAD here, because the harness refills the dummy instead of killing it:
    // Cryptreaver's guaranteed drop, Gravepilfer's second relic + double Gravecoin, and the Lv80 kill-refund.
    // So expect Cryptreaver/Gravepilfer to UNDER-read and Greedwyrm (hold-based) to read true. Hoardwall
    // needs a 100-relic hoard, unreachable in 45s from empty, so the shield slot is fixed to Luckshell --
    // the only TH shield whose trigger (a Grave Strike) fires on a zero-offense dummy.
    weapon: { typeId: "scimitar", styleXp: ["scimitar"] },
    legs: ["relicreaver", "goldgorge", "gravepilfer", "greedwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "slash",
    offhandShield: { type: "shieldSmall", leg: "fortunesriposte" },
  },
  frostwarden: {
    // Water Wand + MEDIUM shield, chain helm/chest + cloth gloves/shoes. Third wand class, so the x49 element
    // stack applies -- but budgeted PER-KIT after the Pyromancer read 820B uncorrected rather than trillions:
    // the stack only explodes when a kit's own damage feeds back THROUGH the element multiplier, and Frostbite
    // and the Shatter both scale off a plain channelled hit. This engine CYCLES (a full meter freezes and
    // shatters), so per the law the Plaguebearer established, RATE bonuses should win and CAP bonuses be inert
    // -- D1's 2pc was moved onto build rate for exactly that reason. That is a falsifiable prediction: check it.
    // Sim-dead: the Deep Freeze's LOCKOUT (a zero-offense dummy has no turns to deny, which is why the payoff
    // lives in the Shatter), Hoarfrost (reduces the foe's outgoing damage), and Cold Snap's stun.
    weapon: { typeId: "wandWater", styleXp: ["wandWater", "wands", "water"] },
    legs: ["deepfreeze", "rimefang", "gravefrost", "rimewyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "water",
    offhandShield: { type: "shieldMedium", leg: "rimeshell" },
  },
  plaguebearer: {
    // Hatchet (fast 1h) + small shield, leather helm/chest/boots + cloth gloves. The Plague is a SUSTAINED
    // engine: severity climbs to its cap and STAYS there (Pandemic erupts without spending it), which is why
    // a cap raise (Blightfang) is strong here where caps were dead weight on the Reaver and Pyromancer -- both
    // of those CYCLE through their capstone. Ward/shield fixed to Venomscale, the only shield whose effect is
    // purely offensive on a zero-offense dummy. Sim-dead: Immunize's mitigation, Toxic Blood's and the old
    // heal legendaries' healing (full HP bar), and Pestilence/Rot Spread (kill-gated; the harness refills).
    // No per-event coin flips in the core loop, so runs should be quiet -- severity, ticks and the eruption
    // cadence are all deterministic.
    weapon: { typeId: "hatchet", styleXp: ["hatchet"] },
    legs: ["wastingcurse", "blightfang", "rotmaw", "blightwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "slash",
    offhandShield: { type: "shieldSmall", leg: "venomscale" },
  },
  ranger: {
    // Medium bow + quiver, leather helm/chest/gloves + cloth boots. The Beastmaster's engine is a CLASS
    // attack, not a familiar cast: a crit commands a companion strike scaling off dotBase. The general
    // familiar system is untouched, so this measures nothing the Summoner shares. At BiS crit is ~100%, so
    // the pack fires nearly every swing -- deliberately deterministic, which is why runs should be quiet
    // (the old Apex Predator x3 fired on four random rolls aligning and would have been unbandable).
    // Bow chassis already corrected in the Quiverlord rework, so no new chassis ground here.
    weapon: { typeId: "bowMedium", styleXp: ["bowMedium"] },
    legs: ["compoundarrows", "trapmaster", "bonevolley", "wyrmstalker"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "pierce",
    offhandQuiver: true,
  },
  pyromancer: {
    // Fire Wand + Fire Ward, full cloth. The SECOND class on the x49 wand chassis (two Fantastic +15 Rings of
    // Fire alone are +4,800% elemental damage) -- the Stormlord opened at 4.4-6.5T before TF_STORM_SWING_MULT
    // 0.32, so expect a pre-correction read in the TRILLIONS here and correct it in PY_SWING_MULT, never in the
    // wand's damage stats. Ward fixed to Everburning: it is the only Fire ward that is purely offensive uptime
    // (the Blaze never burns down), whereas Emberveil/Ashveil bank Barriers that a zero-offense dummy gives
    // nothing to absorb. Sim-dead: Heat Haze's Dodge, and both Barrier wards' defensive value.
    // The Blaze is a deterministic fuel bar, so runs should be quiet (Reaver-like) rather than Stormlord-noisy.
    weapon: { typeId: "wandFire", styleXp: ["wandFire", "wands", "fire"] },
    legs: ["emberstorm", "cindermaw", "pyresoul", "cinderwyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "fire",
    offhandWard: "everburning",
  },
  reaver: {
    // Half-moon axe (fast 1h) + small shield, chain helm/chest + leather gloves/boots. The Butcher's Count is
    // a RAMP: every stack-second of bleeding carves a Cut and the Cut tally is a fight-long damage multiplier,
    // so this class is more measurement-window sensitive than any other -- always report 45s AND 90s, and never
    // compare a 90s Reaver read against a 45s class. The ledger is per FOE, and the harness refills the dummy
    // rather than killing it, so the ramp runs uninterrupted (which is the honest read for a boss fight, the
    // niche this class is built for). Sim-dead: Bloodfrenzy (D2 full) scales with MISSING health and the dummy
    // never swings, so that half of the layer reads zero and the D2 A/B understates it -- its "two Cuts per
    // stack-second" half is what the sim actually sees. Bonereaver's tally carry is kill-gated (under-reads),
    // and every heal (Bloodsupper, Goreshell, Cauterize) is inert on a full HP bar.
    weapon: { typeId: "halfmoonaxe", styleXp: ["halfmoonaxe"] },
    legs: ["crimsonharvest", "marrowsplitter", "bonereaver", "gorewyrm"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "slash",
    offhandShield: { type: "shieldSmall", leg: "frenziedguard" },
  },
  knight: {
    // Claymore (6s two-hander) -- 90s window: compare vs Berserker 82B / Warpriest 89B @90s, never the
    // 45s classes. The zero-offense dummy never triggers Rally, and Shieldwall/Under One Banner are
    // defense/party-side, so the sim measures the Steel/Pace/Decree core -- which is where the knob
    // (KN_DECREE_PCT) lives. The Banner never lowers, so runs ramp once and hold.
    weapon: { typeId: "claymore", styleXp: ["claymore"] },
    legs: ["relentlessassault", "breachblade", "gravewarden", "drakelance"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "pierce",
  },
  samurai: {
    // Katana (falchion, 5s two-hander) -- 90s window, like the Knight and Berserker: 45s is only nine swings,
    // which badly misreads a cycling engine. "The Ronin" builds a Focus stance on every landed hit AND on a
    // per-second clock, then spends the stance as a Draw-Cut; the Cut, its Bleed and Crimson Edge all scale
    // off the recent-hit EMA, so SM_SWING_MULT drives the whole kit from one number. Cycling engine, so by
    // the rate/cap law expect the RATE layer (D1 Unbroken Focus / Flowing Strikes) to lead and per-Cut VALUE
    // to follow -- and note nothing raises the stance CAP any more, because that axis is dead here.
    // Unusually clean to measure: the kit needs neither kills nor incoming damage, so almost nothing is
    // sim-dead. The exception is Kindled Focus (D4 2pc), which scales with stance HELD -- and a cycling
    // stance spends itself, so it reads on the low side of what a real fight sees.
    weapon: { typeId: "falchion", styleXp: ["falchion"] },
    legs: ["flowingblade", "ironwind", "ghostblade", "emberdraw"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "pierce",
  },
  berserker: {
    // Max Health IS the weapon (Titan's Heft/Deepquake/Wrathscale scale off it), so jewelry lines trade
    // lifesteal for Max HP. primeLedger holds the Blood Ledger inked at cap (owner rule: simulate the
    // ledger filling as the kit would in a real fight -- a zero-offense dummy never inks damage taken).
    weapon: { typeId: "warhammer", styleXp: ["warhammer"] },
    legs: ["titaniccrits", "skullcleaver", "gravewrath", "wrathscale"],
    weaponLines: () => ["weaponDamage", "critDamage", "critChance", "flatDamage"],
    setLayers: ["d1", "d2", "d3", "d4"], signets: ["ignorearmor", "d2_fury", "d4_wyrm"], uniqueRingType: "blunt",
    jewelLines: ["allDamage", "critDamage", "critChance", "maxHp"],
    primeLedger: true,
  },
};
const BUILD = BUILDS[SIM_CLASS];
if (!BUILD) { console.error("unknown SIM_CLASS", SIM_CLASS, "— known:", Object.keys(BUILDS).join(", ")); process.exit(1); }

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html?selftest`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__FF_SELFTEST && (window.__FF_SELFTEST.passed > 0 || window.__FF_SELFTEST.error), null, { timeout: 60000 });

async function setup(cfg) {
  return await page.evaluate(([cls, cfg]) => {
    const FF = window.__FF, st = FF._state;
    const diag = { cls };
    // Hard-reset the combat session FIRST: persistent class buffs (Wrath!) refresh continuously and
    // otherwise leak from the previous config, inflating later phases in the same browser session.
    FF.companionCastsOnCombatEntry(null);
    FF.d4WrathReset(st);
    const lv100 = FF.xpFloorForLevel(100);
    Object.keys(st.xp).forEach(k => { st.xp[k] = lv100; });
    [cls].concat(cfg.styleXp).forEach(k => { st.xp[k] = lv100; }); // class + per-style accuracy keys
    st.physique = st.physique || {};
    (FF.PHYSIQUE_SKILLS || []).forEach(ph => { st.physique[ph.id] = lv100; });

    const maxLine = (pool, id) => { const m = FF.ENCHANT_MODS[pool].filter(x => x.id === id)[0]; const r = FF.enchantModRange(m, 20); return { mod: id, roll: r && r.max != null ? r.max : m.max }; };
    const aLines = () => ["defense", "maxHp", "dmgReduction", "blockChance"].map(id => maxLine("armor", id));
    const jLines = () => (cfg.jewelLines || ["allDamage", "critDamage", "critChance", "lifesteal"]).map(id => maxLine("jewelry", id));

    // Armor: full class set of the configured layer, each piece enchanted then +15.
    st.bodyArmor = {}; st.uniqueItems = st.uniqueItems || {};
    // Piece layout (incl. bareHead) is shared across D-layers and lives on the D1 def.
    const d1def = FF.D1_SET_DEFS[cls];
    const slots = d1def && d1def.bareHead ? ["chest", "gauntlets", "boots"] : ["helmet", "chest", "gauntlets", "boots"];
    slots.forEach(slot => {
      const uid = FF.mintSetPiece(cls, slot, "fantastic", cfg.setLayer);
      const u = st.uniqueItems[uid];
      u.enchants = aLines(); u.enhance = 15;
      st.bodyArmor[slot] = { uid: uid, material: u.material, tier: (u.tier || 21) + 1, rarity: "fantastic" };
    });
    st.bodyArmor.back = { leg: cfg.cloakLeg, rarity: "fantastic" }; // legendary Shroud

    // Weapon: legendary fantastic top-tier, 4 max lines then +15.
    // TOP TIER, derived: never hardcode it -- gear families have differed (melee 20 tiers vs arcane 21),
    // and a stale literal silently sims a one-below-BiS weapon.
    const _wTop = FF.legGearBaseTopTier(cfg.weapon.typeId);
    st.uniqueItems.SIMW = { uid: "SIMW", leg: cfg.leg, kind: "weapon", base: `stweapon_${cfg.weapon.typeId}_t${_wTop}_fantastic`,
      tier: _wTop, rarity: "fantastic", enchants: cfg.weaponLines.map(id => maxLine("weapon", id)), enhance: 15 };
    st.equippedMainhand = cfg.weapon.typeId; st.equippedMainhandTier = _wTop + 1; st.equippedMainhandRarity = "fantastic";
    st.equippedMainhandUid = "SIMW";
    if (cfg.offhandClaw) {
      const _cTop = FF.legGearBaseTopTier("claw");
      st.uniqueItems.SIMO = { uid: "SIMO", kind: "weapon", base: `stweapon_claw_t${_cTop}_fantastic`,
        tier: _cTop, rarity: "fantastic", enchants: cfg.weaponLines.map(id => maxLine("weapon", id)), enhance: 15 };
      st.equippedOffhand = "claw"; st.equippedOffhandTier = _cTop + 1; st.equippedOffhandRarity = "fantastic"; st.equippedOffhandUid = "SIMO";
    } else if (cfg.offhandWard) {
      const _dTop = FF.legGearBaseTopTier("wardLight");
      st.uniqueItems.SIMWD = { uid: "SIMWD", leg: cfg.offhandWard, kind: "offhand", base: `stward_wardLight_t${_dTop}_fantastic`,
        tier: _dTop, rarity: "fantastic", enchants: [], enhance: 15 };
      st.equippedOffhand = "wardLight"; st.equippedOffhandTier = _dTop + 1; st.equippedOffhandRarity = "fantastic"; st.equippedOffhandUid = "SIMWD";
    } else if (cfg.offhandShield) {
      // A large/small shield offhand (Herald, Sentinel, Treasure Hunter). Its legendary sits on the shield,
      // and its Block chance matters only against a foe that swings -- the dummy doesn't, so the Bastion is
      // measured on its self-driven Braces, exactly as designed.
      const _sTop = FF.legGearBaseTopTier(cfg.offhandShield.type);
      st.uniqueItems.SIMSH = { uid: "SIMSH", leg: cfg.offhandShield.leg, kind: "offhand",
        base: `stshield_${cfg.offhandShield.type}_t${_sTop}_fantastic`, tier: _sTop, rarity: "fantastic", enchants: [], enhance: 15 };
      st.equippedOffhand = cfg.offhandShield.type; st.equippedOffhandTier = _sTop + 1; st.equippedOffhandRarity = "fantastic";
      st.equippedOffhandUid = "SIMSH";
    } else if (cfg.offhandQuiver) {
      st.equippedOffhand = "quiver"; st.equippedOffhandTier = 20; st.equippedOffhandRarity = "fantastic"; st.equippedOffhandUid = null;
      st.inventory = st.inventory || {};
      st.inventory.fletching_arrow_t19 = 1e9; // top-tier ammo, never runs dry
      st.equippedArrow = "fletching_arrow_t19";
      st.lockedItems = {};
    } else {
      st.equippedOffhand = null; st.equippedOffhandTier = 0; st.equippedOffhandUid = null;
    }

    // Jewelry: 3 legendary Signets + 2 unique rings + amulet; relic & belt — every unique enchanted then +15.
    st.jewelrySlots = {};
    cfg.signets.forEach((key, i) => { st.jewelrySlots["ring" + (i + 1)] = { leg: key, rarity: "fantastic" }; });
    ["ring4", "ring5"].forEach((sid, i) => {
      const uid = "SIMR" + i;
      st.uniqueItems[uid] = { uid, kind: "ring", base: "ring_" + cfg.uniqueRingType + "_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
      st.jewelrySlots[sid] = { typeId: cfg.uniqueRingType, tier: 20, rarity: "fantastic", uid };
    });
    st.uniqueItems.SIMA = { uid: "SIMA", kind: "amulet", base: "amulet_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
    st.jewelrySlots.amulet = { typeId: "warding", tier: 20, rarity: "fantastic", uid: "SIMA" };
    st.uniqueItems.SIMREL = { uid: "SIMREL", kind: "relic", base: "relic_t19_fantastic", tier: 19, rarity: "fantastic", enchants: jLines(), enhance: 15 };
    st.equippedRelicTier = 20; st.equippedRelicRarity = "fantastic"; st.equippedRelicUid = "SIMREL";
    st.uniqueItems.SIMB = { uid: "SIMB", kind: "belt", base: "belt_t19_fantastic", tier: 19, rarity: "fantastic", enchants: aLines(), enhance: 15 };
    st.equippedBeltTier = 20; st.equippedBeltRarity = "fantastic"; st.equippedBeltUid = "SIMB";

    // Companions: best damage familiars, Lv100 + 3 stars, up to the build's slot count.
    const famScore = id => { const f = FF.FAMILIAR_DATA[id]; if (!f || !f.spells) return 0;
      return f.spells.reduce((n, s) => n + ((s.type === "hit" || s.type === "siphon") ? (s.amount || 0) : 0), 0); };
    const famIds = Object.keys(FF.FAMILIAR_DATA).sort((a, b) => famScore(b) - famScore(a));
    st.familiars = {};
    const roster = famIds.slice(0, FF.activeCompanionSlots(st));
    roster.forEach(id => { st.familiars[id] = { owned: true, level: 100, stars: 3 }; });
    st.activeCompanions = roster.slice(); st.companionCast = {};
    roster.forEach(id => { st.companionCast[id] = { accum: 0, index: 0 }; });
    diag.roster = roster;

    // Fresh combat buffs, then the fight: zero-offense Archdemon with real dodge/armor, huge HP pool.
    st.staffDownbeats = []; st.staffLastDownbeatAt = 0; st.summonerCrescendo = 0; st.summonerWraiths = [];
    st.familiarBuffs = st.familiarBuffs || {};
    st.assassinVigor = null; st.assassinBloodrushUntil = 0;
    // The Reliquary's ammunition lives in the INVENTORY, so it survives a config change unless cleared --
    // a later A/B would otherwise open with a stocked pack (and top-tier relics) and read far too high.
    st.inventory = st.inventory || {};
    (FF.BROKEN_RELIC_ITEMS || []).forEach(r => { st.inventory[r.id] = 0; });
    st.lockedItems = st.lockedItems || {};
    st.thCharge = 0; st.thHitAvg = 0; st.thMarks = 0; st.thMarksUntil = 0;
    let top = FF.MONSTERS.filter(m => /archdemon/i.test(m.id) || /Archdemon/.test(m.name))[0];
    if (!top) { FF.MONSTERS.forEach(m => { if (!top || (m.tierIndex || 0) > (top.tierIndex || 0)) top = m; }); }
    top.atkMin = 0; top.atkMax = 0; top.attackSpeed = 99999; top.special = null;
    st.activity = { type: "combat", monsterId: top.id, monsterHp: 1e15, tickAccum: 0, monsterTickAccum: 0,
      offhandTickAccum: 0, duelStartedAt: Date.now(), samuraiFirstStrike: true, lastDamagedAt: 0 };
    st.playerHp = FF.maxHp(st);
    if (cfg.primeLedger) st.activity.bloodLedger = FF.maxHp(st) * 4; // hold the Blood Ledger at cap
    diag.target = top.name; diag.activeClass = FF.activeClassId(st);
    diag.foeTier = top.tierIndex; diag.relicTiers = (FF.BROKEN_RELIC_ITEMS || []).length;
    window.__SIM = { lastHp: 1e15, total: 0, t0: performance.now(), primeLedger: !!cfg.primeLedger };
    return diag;
  }, [SIM_CLASS, cfg]);
}

async function sample() {
  return await page.evaluate(() => {
    const FF = window.__FF, st = FF._state, s = window.__SIM;
    const a = st.activity;
    if (!a || a.type !== "combat") return { dead: true, total: s.total, elapsed: performance.now() - s.t0 };
    s.total += Math.max(0, s.lastHp - a.monsterHp);
    if (a.monsterHp < 1e14) { a.monsterHp = 1e15; }
    s.lastHp = a.monsterHp;
    if (s.primeLedger) a.bloodLedger = FF.maxHp(st) * 4; // keep the Ledger inked at cap through the run
    return { total: s.total, elapsed: performance.now() - s.t0 };
  });
}

async function runOne(name, cfg, ms) {
  const full = { ...cfg, weapon: BUILD.weapon, styleXp: BUILD.weapon.styleXp, offhandClaw: !!BUILD.offhandClaw,
    offhandQuiver: !!BUILD.offhandQuiver, offhandWard: BUILD.offhandWard || null, offhandShield: BUILD.offhandShield || null, signets: BUILD.signets,
    uniqueRingType: BUILD.uniqueRingType, weaponLines: BUILD.weaponLines(cfg.leg), jewelLines: BUILD.jewelLines || null, primeLedger: !!BUILD.primeLedger };
  const diag = await setup(full);
  await page.evaluate(() => window.__FF._startLoop());
  if (diag.activeClass !== SIM_CLASS) { console.log(name, "SETUP FAILED — active class:", diag.activeClass); return null; }
  let last = null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 500));
    last = await sample();
    if (last.dead) break;
  }
  const out = { config: name, leg: cfg.leg, set: cfg.setLayer, cloak: cfg.cloakLeg,
    seconds: Math.round(last.elapsed / 1000), dps: Math.round(last.total / (last.elapsed / 1000)),
    totalDamage: Math.round(last.total), target: diag.target };
  console.log(JSON.stringify(out));
  return out;
}

// Phase 1: set-layer A/B on the last-listed legendary (usually the capstone-synergy one).
const probeLeg = BUILD.legs[BUILD.legs.length - 1];
let bestSet = BUILD.setLayers[0], bestDps = -1;
if (BUILD.setLayers.length > 1) {
  for (const layer of BUILD.setLayers) {
    const r = await runOne("set A/B: " + layer, { leg: probeLeg, setLayer: layer, cloakLeg: "d2_ruin" }, Math.min(DURATION_MS, 45000));
    if (r && r.dps > bestDps) { bestDps = r.dps; bestSet = layer; }
  }
  console.log("WINNING SET LAYER:", bestSet);
}
// Phase 2: cloak A/B (Ruin all-dmg / Warpack elemental / Widow crit-dmg).
let bestCloak = "d2_ruin"; bestDps = -1;
for (const c of ["d2_ruin", "d2_warpack", "critdmg"]) {
  const r = await runOne("cloak A/B: " + c, { leg: probeLeg, setLayer: bestSet, cloakLeg: c }, Math.min(DURATION_MS, 45000));
  if (r && r.dps > bestDps) { bestDps = r.dps; bestCloak = c; }
}
console.log("WINNING CLOAK:", bestCloak);
// Phase 3: final matrix over the class's weapon legendaries.
for (const leg of BUILD.legs) await runOne(SIM_CLASS + ": " + leg, { leg, setLayer: bestSet, cloakLeg: bestCloak }, DURATION_MS);
await browser.close(); server.close();
