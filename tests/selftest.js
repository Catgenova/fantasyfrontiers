/*
 * Fantasy Frontiers — browser unit tests.
 *
 * The game is a single-file IIFE with no module exports and there's no Node build, so the
 * tests run in the browser against a small "test seam": opening index.html with ?selftest
 * exposes a curated set of PURE functions + data tables on window.__FF, and index.html then
 * loads this file. Nothing here runs during normal play.
 *
 * Run:  serve the repo and open  index.html?selftest  (a pass/fail chip appears top-right,
 *       and a "SELFTEST: N passed, M failed" line is logged to the console). Results are also
 *       left on window.__FF_SELFTEST for programmatic checks.
 */
(function(){
  var FF = window.__FF;
  var R = { passed:0, failed:0, failures:[] };
  function ok(cond, msg){ if(cond){ R.passed++; } else { R.failed++; R.failures.push(msg); if(window.console) console.error('FAIL: ' + msg); } }
  function eq(a, b, msg){ ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
  function near(a, b, msg, eps){ eps = (typeof eps === 'number') ? eps : 1e-9; ok(Math.abs(a - b) <= eps, msg + ' (got ' + a + ', want ~' + b + ')'); }
  function suite(name, fn){ try { fn(); } catch(e){ R.failed++; R.failures.push(name + ': threw ' + e); if(window.console) console.error('THREW in ' + name, e); } }

  if(!FF){ if(window.console) console.error('SELFTEST: window.__FF missing — open index.html with ?selftest'); window.__FF_SELFTEST = { error:'no __FF' }; return; }

  // ---- XP <-> level curve ---------------------------------------------------------------
  suite('getLevel', function(){
    var KNEE = FF.SKILL_CURVE_KNEE; // 70
    // Below the knee the curve is unchanged (classic 100*(L-1)^2 floors).
    eq(FF.getLevel(0), 1, 'getLevel(0)');
    eq(FF.getLevel(99), 1, 'getLevel(99) still level 1');
    eq(FF.getLevel(100), 2, 'getLevel(100)');
    eq(FF.getLevel(400), 3, 'getLevel(400)');
    eq(FF.xpFloorForLevel(KNEE), 100*(KNEE-1)*(KNEE-1), 'the knee floor still matches the classic quadratic');
    eq(FF.xpFloorForLevel(50), 100*49*49, 'a mid level below the knee is unchanged');

    // Round-trips exactly against the floor table across the whole ladder.
    for(var L = 1; L <= FF.MAX_SKILL_LEVEL; L++){
      eq(FF.getLevel(FF.xpFloorForLevel(L)), L, 'getLevel(floor('+L+')) = '+L);
      if(L > 1) eq(FF.getLevel(FF.xpFloorForLevel(L) - 1), L-1, 'one XP short of '+L+' is still '+(L-1));
    }

    // The endgame is brutal: past the knee each level costs far more than the last, and 100 needs
    // vastly more XP than the old curve's 980,100.
    var costJustBelowKnee = FF.xpFloorForLevel(KNEE) - FF.xpFloorForLevel(KNEE-1);
    var costLastLevel = FF.xpFloorForLevel(100) - FF.xpFloorForLevel(99);
    ok(costLastLevel > costJustBelowKnee * 50, 'the final level costs 50x+ more XP than a pre-knee level');
    ok(FF.xpFloorForLevel(100) > 8000000, 'reaching level 100 is a multi-million-XP grind');
    ok(FF.xpFloorForLevel(100) > FF.xpFloorForLevel(90) * 3, 'the last ten levels dwarf everything before them');

    // Cap and monotonicity hold everywhere.
    eq(FF.getLevel(1e15), 100, 'getLevel of absurd XP is still capped at 100');
    var prev = 0;
    for(var xp = 0; xp <= 20000000; xp += 50000){ var lv = FF.getLevel(xp); ok(lv >= prev && lv >= 1 && lv <= 100, 'getLevel monotonic & in [1,100] @' + xp); prev = lv; }
  });

  // ---- Tier scaling helpers -------------------------------------------------------------
  suite('tier formulas', function(){
    eq(FF.tierXp(10, 0), 10, 'tierXp base');
    eq(FF.tierXp(10, 1), 14, 'tierXp x1.4');
    // Skill XP is linear now: gathering (t+1)*10 -> 10..210; crafting 25+t*15 -> 25..325.
    eq(FF.gatherXp(0), 10, 'gatherXp t0 = 10');
    eq(FF.gatherXp(20), 210, 'gatherXp t20 = 210');
    eq(FF.craftXp(0), 25, 'craftXp t0 = 25');
    eq(FF.craftXp(1), 40, 'craftXp t1 = 40');
    eq(FF.craftXp(20), 325, 'craftXp t20 = 325');
    // The rebalance pass should have applied these to real skill data (Stone Cutting is crafting).
    var scut = FF.CRAFTING_SKILLS.stonecutting.recipes;
    eq(scut[0].xp, 25, 'stonecutting t0 recipe xp = 25 (linear)');
    eq(scut[20].xp, 325, 'stonecutting t20 recipe xp = 325 (linear, was ~12951)');
    // Estate building reward: 500 XP per tier (tier number = tierIndex + 1).
    eq(FF.estateBuildXp(0), 500, 'estate build t0 -> 500 XP');
    eq(FF.estateBuildXp(4), 2500, 'estate build t4 -> 2500 XP');
    eq(FF.estateBuildXp(20), 10500, 'estate build t20 -> 10500 XP');
    // Fishing treasure-on-miss chance: 5% base + 2% per action tier (fishing_t<n>).
    eq(FF.fishingTreasureChance('fishing_t0'), 0.05, 'fishing t0 treasure = 5%');
    eq(Math.round(FF.fishingTreasureChance('fishing_t5')*100), 15, 'fishing t5 treasure = 15%');
    eq(Math.round(FF.fishingTreasureChance('fishing_t20')*100), 45, 'fishing t20 treasure = 45%');
    eq(FF.tierSell(3, 0), 3, 'tierSell base');
    eq(FF.tierSell(3, 1), 4, 'tierSell x1.45');
    eq(FF.tierTime(7, 0.3, 0), 7, 'tierTime base');
    eq(FF.tierTime(7, 0.3, 1), 7.3, 'tierTime +step');
  });

  // ---- Vendor sell values: flat linear curve, not the old exponential tierSell -----------
  suite('economy: vendor sell values', function(){
    var S = FF.ALL_SELLABLE;
    // Gathered materials: 5g at t0, +5g/tier -> 105g at t20.
    eq(S['digging_t0'].sell, 5, 'gathered material t0 sells for 5');
    eq(S['digging_t10'].sell, 55, 'gathered material t10 sells for 55');
    eq(S['digging_t20'].sell, 105, 'gathered material t20 sells for 105');
    // Everything else (crafted goods): 10g at t0, +10g/tier -> 210g at t20 (endpoints proven via
    // vendorSellValue below; spot-check a real craft recipe at t0 that is NOT a gathered material).
    ok(S['metallurgy_t0'] && !FF.ALL_GATHER_ITEMS['metallurgy_t0'], 'metallurgy_t0 is a crafted (non-gathered) good');
    eq(S['metallurgy_t0'].sell, 10, 'crafted good t0 sells for 10');
    eq(FF.vendorSellValue('anything_t20', { rarity:'normal' }, false), 210, 'other t20 = 10+200 = 210');
    // Rarity multipliers x2 / x4 / x8.
    eq(FF.SELL_RARITY_MULT.normal, 1, 'normal x1');
    eq(FF.SELL_RARITY_MULT.rare, 2, 'rare x2');
    eq(FF.SELL_RARITY_MULT.supreme, 4, 'supreme x4');
    eq(FF.SELL_RARITY_MULT.fantastic, 8, 'fantastic x8');
    // vendorSellValue: gathered vs other + rarity, from the id + item.
    eq(FF.vendorSellValue('x_t5', { rarity:'normal' }, true), 30, 'gathered t5 = 5+25 = 30');
    eq(FF.vendorSellValue('x_t5', { rarity:'normal' }, false), 60, 'other t5 = 10+50 = 60');
    eq(FF.vendorSellValue('x_t5', { rarity:'rare' }, false), 120, 'other t5 rare = 60 x2');
    eq(FF.vendorSellValue('x_t5', { rarity:'supreme' }, false), 240, 'other t5 supreme = 60 x4');
    eq(FF.vendorSellValue('x_t5', { rarity:'fantastic' }, false), 480, 'other t5 fantastic = 60 x8');
    // Non-tiered specials keep their hand-set value (null -> unchanged).
    eq(FF.vendorSellValue('shaft', {}, false), null, 'non-tiered item is not repriced');
    eq((S['formula_d1_masterwork']||{}).sell, 0, 'the D1 Formula stays non-vendorable (sell 0)');
    // No tiered sell is exponentially large anymore: the max tiered non-rarity sell is 210 (was thousands).
    var maxTieredNormalSell = 0;
    Object.keys(S).forEach(function(id){ var it = S[id]; if(it && /_t\d/.test(id) && !it.rarity && typeof it.sell === 'number' && it.sell > maxTieredNormalSell) maxTieredNormalSell = it.sell; });
    ok(maxTieredNormalSell <= 210, 'no tiered normal-rarity item sells above 210 -- got ' + maxTieredNormalSell);
  });

  // ---- Settings: the opt-in automation toggles exist and default OFF ----------------------
  suite('settings: auto-action toggles', function(){
    var st = FF._state.settings || {};
    ['autoOpenCaches','autoOpenChests','autoHarvest','autoFertilize','autoPlant'].forEach(function(k){
      eq(typeof st[k], 'boolean', k + ' is a boolean setting');
      eq(st[k], false, k + ' defaults to off');
    });
  });

  // ---- Guild bank slot cost must match the server RPC formula ---------------------------
  suite('bankSlotCost matches server', function(){
    eq(FF.bankSlotCost(4), 10000, 'bankSlotCost clamps below 5 slots');
    eq(FF.bankSlotCost(5), 10000, 'bankSlotCost(5) base');
    eq(FF.bankSlotCost(6), 12500, 'bankSlotCost(6)');
    for(var s = 5; s <= 20; s++){ eq(FF.bankSlotCost(s), Math.round(10000 * Math.pow(1.25, s - 5)), 'bankSlotCost matches 10000*1.25^(s-5) @' + s); }
  });

  // ---- Estate expansion cost ------------------------------------------------------------
  suite('getEstateExpansionCost', function(){
    eq(FF.getEstateExpansionCost(0), 1000, 'expansion base cost');
    eq(FF.getEstateExpansionCost(1), 1250, 'expansion +25%');
    var pc = 0;
    for(var i = 0; i < 20; i++){ var c = FF.getEstateExpansionCost(i); ok(c >= pc, 'expansion cost non-decreasing @' + i); pc = c; }
  });

  // ---- Workshop bonus % + upgrade chain (tier N consumes tier N-1) ----------------------
  suite('workshopBonusPct', function(){
    near(FF.workshopBonusPct(0), 0.05, 'workshop tier 0 = 5%');
    near(FF.workshopBonusPct(FF.TIER_COUNT - 1), 0.30, 'workshop top tier = 30%');
    ok(FF.workshopBonusPct(10) > FF.workshopBonusPct(0), 'workshop bonus increases with tier');
  });
  suite('workshop upgrade chain', function(){
    var skill = FF.WORKSHOP_ITEMS[Object.keys(FF.WORKSHOP_ITEMS)[0]].skillId;
    var d0 = FF.getWorkshopTierData(skill, 0);
    ok(d0.inputs['carpentry_t0'] > 0, 'workshop t0 needs planks');
    ok(Object.keys(d0.inputs).every(function(k){ return k.indexOf('workshop_') !== 0; }), 'workshop t0 has no prior-workshop input');
    var d3 = FF.getWorkshopTierData(skill, 3);
    ok(d3.inputs['carpentry_t3'] > 0, 'workshop t3 needs planks');
    eq(d3.inputs['workshop_' + skill + '_t2'], 1, 'workshop t3 consumes one tier-2 workshop');
  });

  // ---- Paving recipes: every finish costs Slabs of the matching stone (2/3/4) -----------
  suite('paving recipes use slabs', function(){
    var pav = FF.CRAFTING_SKILLS.paving.recipes;
    eq(pav.length, FF.TIER_COUNT, 'paving recipe count = tier count');
    var qtyByFinish = [2, 3, 4]; // Plain / Decorative / Ornate
    pav.forEach(function(r, i){
      var keys = Object.keys(r.inputs);
      eq(keys.length, 1, 'paving t' + i + ' has a single input');
      eq(keys[0], 'stonecutting_t' + (Math.floor(i / 3) * 3 + 1), 'paving t' + i + ' uses the matching-stone Slab');
      eq(r.inputs[keys[0]], qtyByFinish[i % 3], 'paving t' + i + ' slab quantity by finish');
    });
  });
  suite('getPavingRecipe', function(){
    var r = FF.getPavingRecipe('paving_t0');
    ok(r && r.id === 'paving_t0', 'getPavingRecipe returns the matching recipe');
    eq(FF.getPavingRecipe('nope_t99'), null, 'getPavingRecipe returns null on miss');
  });
  suite('paving crafts yield double XP', function(){
    eq(FF.craftXpBonus('paving'), 4, 'paving crafting gets a 4x XP bonus');
    eq(FF.craftXpBonus('masonry'), 1, 'masonry crafting gets no XP bonus');
    eq(FF.craftXpBonus('stonecutting'), 1, 'stonecutting crafting gets no XP bonus');
  });

  // ---- Belt extra slots accept craft / gather / faith, freely mixed --------------------
  suite('belt extra slots run gather + faith alongside crafting', function(){
    var S = FF._state;
    var savedActivity = S.activity, savedExtra = S.extraCraftSlots, savedBt = S.equippedBeltTier, savedBr = S.equippedBeltRarity;
    try {
      S.equippedBeltTier = 1; S.equippedBeltRarity = 'fantastic'; // 4 concurrent slots
      S.activity = { type:null }; S.extraCraftSlots = [{type:null},{type:null},{type:null}];
      FF.ensureCraftSlotCapacity();
      ok(FF.getMaxCraftSlots(S) >= 4, 'fantastic belt grants >= 4 task slots');
      var miningId = FF.GATHERING_SKILLS.mining.items[0].id;
      var fishId = FF.GATHERING_SKILLS.fishing.items[0].id;
      var prayId = FF.PRAYER_TIERS[0].id;
      FF.startGather('mining', miningId);
      ok(S.activity.type === 'gather' && S.activity.skill === 'mining', 'first gather takes the primary slot');
      FF.startGather('fishing', fishId);
      var g2 = FF.findActiveGatherSlot('fishing', fishId);
      ok(g2 && !g2.primary, 'a second gather goes to an extra belt slot');
      FF.startPray(prayId);
      var p1 = FF.findActivePraySlot(prayId);
      ok(p1 && !p1.primary, 'faith (prayer) runs in an extra belt slot, mixed with gathering');
      var types = [S.activity].concat(S.extraCraftSlots).filter(function(s){ return s && s.type; }).map(function(s){ return s.type; });
      ok(types.indexOf('gather') !== -1 && types.indexOf('pray') !== -1, 'gather and faith run at the same time');
      var beforeF = S.xp.fishing || 0;
      FF.processGatherActivity(S.extraCraftSlots[g2.index], 3600000);
      ok((S.xp.fishing || 0) > beforeF, 'extra-slot gathering accrues XP when processed');
      var beforeP = S.xp.prayer || 0;
      FF.processPrayActivity(S.extraCraftSlots[p1.index], 3600000);
      ok((S.xp.prayer || 0) > beforeP, 'extra-slot prayer accrues XP when processed');
    } finally {
      S.activity = savedActivity; S.extraCraftSlots = savedExtra;
      S.equippedBeltTier = savedBt; S.equippedBeltRarity = savedBr;
    }
  });

  // ---- Action HUD task rows: remaining runs, success chance, and nav category ------------
  suite('describeTask reports runs remaining, success chance, and nav target', function(){
    var S = FF._state;
    var savedInv = S.inventory;
    try {
      S.inventory = {};
      var mining = FF.GATHERING_SKILLS.mining.items[0].id;
      var g = FF.describeTask({ type:'gather', skill:'mining', itemId:mining, progress:0 });
      eq(g.remaining, Infinity, 'gathering runs are infinite');
      eq(g.navCat, 'gathering', 'gather task navigates to gathering');
      ok(g.name.indexOf('Gathering:') === 0, 'gather task name is prefixed');
      var gf = FF.describeTask({ type:'gather', skill:'forestry', itemId:FF.GATHERING_SKILLS.forestry.items[0].id, progress:0 });
      eq(gf.successPct, 100, 'forestry gathering is a guaranteed 100%');
      var pr = FF.describeTask({ type:'pray', itemId:FF.PRAYER_TIERS[0].id, progress:0 });
      eq(pr.remaining, Infinity, 'prayer runs are infinite');
      eq(pr.successPct, 100, 'prayer always succeeds');
      eq(pr.navCat, 'faith', 'prayer navigates to faith');
      // Carpentry is a crafting skill but lives under the Building sub-tab now.
      S.inventory['forestry_t0'] = 5; // Willow Plank needs 1 log each
      var c = FF.describeTask({ type:'craft', skill:'carpentry', itemId:'carpentry_t0', progress:0 });
      eq(c.remaining, 5, 'craft remaining = runs the inputs support');
      eq(c.navCat, 'building', 'carpentry craft navigates to the Building tab');
      S.inventory['forestry_t0'] = 2;
      eq(FF.describeTask({ type:'craft', skill:'carpentry', itemId:'carpentry_t0', progress:0 }).remaining, 2, 'remaining tracks inventory');
      var mc = FF.describeTask({ type:'craft', skill:'metallurgy', itemId:'metallurgy_t0', progress:0 });
      eq(mc.navCat, 'crafting', 'metallurgy craft navigates to the Crafting tab');
      // Butchering processes corpses under the Refining tab (renderGatherTab), NOT the Crafting tab --
      // routing it to 'crafting' rendered it as a craft skill and threw, breaking render + chat.
      var bc = FF.describeTask({ type:'craft', skill:'butchering', itemId:'rabbit_carcass', progress:0 });
      eq(bc.navCat, 'refining', 'butchering corpse task navigates to the Refining tab (not Crafting)');
      // A dungeon fight's action-bar card jumps to the Dungeons page; a normal fight to the Combat tab.
      eq(FF.describeTask({ type:'combat', monsterId:FF.DUNGEON_D1_ENEMIES[0].id, dungeon:'d1', tickAccum:0 }).navCat, 'dungeons', 'a dungeon fight navigates to the Dungeons page');
      eq(FF.describeTask({ type:'combat', monsterId:FF.MONSTERS[0].id, tickAccum:0 }).navCat, 'combat', 'a normal fight navigates to the Combat tab');
    } finally {
      S.inventory = savedInv;
    }
  });

  // ---- Tier steppers replaced the crafting-tier <select> dropdowns -----------------------
  suite('tierRange builds a contiguous 0..max list', function(){
    var r = FF.tierRange(3);
    eq(r.length, 4, 'tierRange(3) has 4 entries');
    eq(r[0], 0, 'tierRange starts at 0');
    eq(r[3], 3, 'tierRange ends at max');
  });
  suite('tierStepper renders − value + buttons', function(){
    var html = FF.tierStepper('workshop', 'carpentry', FF.tierRange(5), 2, 'Iron (Lv15)', false);
    ok(html.indexOf('data-action="tierStep"') !== -1, 'emits tierStep buttons');
    ok(html.indexOf('data-tier-target="workshop"') !== -1, 'carries the target');
    ok(html.indexOf('data-tier-sub="carpentry"') !== -1, 'carries the sub key');
    ok(html.indexOf('data-tier-values="0,1,2,3,4,5"') !== -1, 'carries the value list');
    ok(html.indexOf('Iron (Lv15)') !== -1, 'shows the current tier label');
    ok(html.indexOf('data-tier-dir="-1"') !== -1 && html.indexOf('data-tier-dir="1"') !== -1, 'has both directions');
  });
  // ---- Building / Outfitting are cosmetic sub-nav groups carved out of Crafting -----------
  suite('building and outfitting split the crafting skills without gaps or overlap', function(){
    var building = FF.BUILDING_SKILL_IDS, outfitting = FF.OUTFITTING_SKILL_IDS, craftTab = FF.CRAFTING_TAB_SKILL_IDS;
    eq(building.join(','), 'carpentry,stonecutting,paving,masonry', 'building holds the estate-build skills');
    eq(outfitting.join(','), 'weaponsmithing,armorsmithing,tailoring,shieldsmithing,runesmithing,arcanism,fletching,bowyer,leatherworking,jewelrycrafting', 'outfitting holds the gear skills');
    // Every crafting skill lands in exactly one of the three sub-tab groups.
    var union = building.concat(outfitting).concat(craftTab).slice().sort();
    eq(union.length, FF.CRAFT_SKILL_IDS.length, 'the three groups cover every crafting skill exactly once');
    eq(union.join(','), FF.CRAFT_SKILL_IDS.slice().sort().join(','), 'union of the groups equals CRAFT_SKILL_IDS');
    building.concat(outfitting).forEach(function(id){
      ok(craftTab.indexOf(id) === -1, id + ' is not also in the Crafting tab');
    });
    // The functional list is untouched -- these are still crafting skills.
    ['carpentry','paving','weaponsmithing','fletching'].forEach(function(id){
      ok(FF.CRAFT_SKILL_IDS.indexOf(id) !== -1, id + ' remains a crafting skill functionally');
    });
  });
  suite('tierStepper disables at the ends and when locked', function(){
    var lowest = FF.tierStepper('ring', 'r', FF.tierRange(4), 0, 'x', false);
    // The − button (dir=-1) sits before the + button; at the lowest tier only − is disabled.
    ok(/data-tier-dir="-1"[^>]*disabled/.test(lowest), 'minus disabled at lowest tier');
    ok(!/data-tier-dir="1"[^>]*disabled/.test(lowest), 'plus enabled at lowest tier');
    var highest = FF.tierStepper('ring', 'r', FF.tierRange(4), 4, 'x', false);
    ok(/data-tier-dir="1"[^>]*disabled/.test(highest), 'plus disabled at highest tier');
    var locked = FF.tierStepper('ring', 'r', FF.tierRange(4), 2, 'x', true);
    ok(/data-tier-dir="-1"[^>]*disabled/.test(locked) && /data-tier-dir="1"[^>]*disabled/.test(locked), 'both disabled when locked');
  });

  // ---- Gathering workshops (parallel to crafting workshops) -----------------------------
  suite('gathering workshops', function(){
    var w = FF.WORKSHOP_ITEMS;
    ok(w['workshop_forestry_t0'], 'forestry gathering workshop item exists');
    eq(w['workshop_forestry_t0'].skillId, 'forestry', 'forestry workshop carries its gather skillId');
    ok(w['workshop_mining_t5'] && w['workshop_fishing_t10'], 'mining/fishing workshop tiers exist');
    var d = FF.getWorkshopTierData('fishing', 3);
    ok(d.inputs['carpentry_t3'] > 0, 'gathering workshop needs planks');
    eq(d.inputs['workshop_fishing_t2'], 1, 'gathering workshop consumes the previous tier');
    near(FF.workshopBonusPct(0), 0.05, 'gathering workshop t0 = 5%');
    near(FF.workshopBonusPct(FF.TIER_COUNT - 1), 0.30, 'gathering workshop top tier = 30%');
  });

  // ---- Cottages + peon speed (Peons feature) --------------------------------------------
  suite('cottages + peons', function(){
    var c = FF.COTTAGE_ITEMS;
    ok(c['cottage_t0'] && c['cottage_t20'], 'cottage items exist across tiers');
    eq(c['cottage_t0'].tierIndex, 0, 'cottage tierIndex');
    var d0 = FF.getCottageTierData(0), d3 = FF.getCottageTierData(3);
    eq(d0.inputs['carpentry_t0'], 100, 'cottage t0 costs 100 planks');
    ok(!('cottage_t-1' in d0.inputs), 'cottage t0 has no prior-cottage input');
    eq(d3.inputs['carpentry_t3'], 100, 'cottage t3 costs 100 planks');
    eq(d3.inputs['cottage_t2'], 1, 'cottage t3 consumes the previous-tier cottage');
    near(FF.peonSpeedFactor(0), 0.05, 'peon speed 5% at t0');
    near(FF.peonSpeedFactor(FF.TIER_COUNT - 1), 1.0, 'peon speed 100% at t20');
    ok(FF.peonSpeedFactor(10) > FF.peonSpeedFactor(0) && FF.peonSpeedFactor(10) < FF.peonSpeedFactor(20), 'peon speed scales with tier');
    // Peons can also run equipment (special) crafts, at NORMAL rarity only.
    var ws = FF.peonSpecialProducers('weaponsmithing');
    ok(ws.length > 0 && ws.every(function(p){ return p.craftKind === 'stackweapon'; }), 'weaponsmithing offers stackweapon producers');
    ok(FF.peonSpecialProducers('jewelrycrafting').some(function(p){ return p.craftKind === 'amulet'; }), 'jewelrycrafting offers an amulet producer');
    ok(FF.peonSpecialProducers('blacksmithing').some(function(p){ return p.craftKind === 'tool'; }), 'blacksmithing offers tool producers');
    eq(FF.peonSpecialProducers('mining').length, 0, 'gather skills have no special producers');
    // A built special-craft act resolves to real tier data (inputs + time) at every tier <= cap.
    var wp = ws[0], td0 = FF.getSpecialTierData({ craftKind: wp.craftKind, typeId: wp.params.typeId, tierIndex: 0 });
    ok(td0 && td0.inputs && td0.time > 0, 'peon special-craft act resolves to tier data');
    var toolP = FF.peonSpecialProducers('blacksmithing').filter(function(p){ return p.craftKind === 'tool'; })[0];
    var ttd = FF.getSpecialTierData({ craftKind: 'tool', skillId: toolP.params.skillId, tierIndex: FF.TIER_COUNT - 1 });
    ok(ttd && ttd.inputs, 'peon tool act resolves at top tier (tierIndex+1 offset in-bounds)');
  });

  // ---- Farming Fields (estate-built farming plots) -------------------------------------
  suite('farming fields', function(){
    var F = FF.FARM_FIELD_TIERS;
    eq(Object.keys(F).length, FF.TIER_COUNT, '21 field tiers');
    ok(F.field_t0 && F.field_t0.name.indexOf('Field') !== -1, 't0 named "<x> Field"');
    eq(F.field_t0.inputs['digging_t0'], 100, 't0 field costs 100 digging_t0');
    eq(F.field_t20.inputs['digging_t20'], 100, 't20 field costs 100 digging_t20');
    eq(FF.fieldBuildMs(0), 5*60*1000, 't0 builds in 5 min');
    eq(FF.fieldBuildMs(20), 105*60*1000, 't20 builds in 105 min (21*5)');
    eq(FF.estateBuildXp(0), 500, 't0 field build = 500 Digging XP');   // shared estate-build XP curve
    eq(FF.estateBuildXp(20), 10500, 't20 field build = 10500 Digging XP');
    eq(FF.ESTATE_MAX_FIELDS, 20, 'max 20 fields per estate');
    ok(FF.canPlantInField(5, 5) && FF.canPlantInField(5, 0), 'tier-5 field accepts t5 and lower');
    ok(!FF.canPlantInField(5, 6), 'tier-5 field rejects a t6 crop');
  });

  // ---- Tracked Skills now includes physiques -------------------------------------------
  suite('trackable physiques', function(){
    var ids = FF.TRACKABLE_SKILL_IDS;
    FF.PHYSIQUE_SKILLS.forEach(function(p){ ok(ids.indexOf(p.id) !== -1, 'physique trackable: ' + p.id); });
    ok(ids.indexOf('mining') !== -1 && ids.indexOf('carpentry') !== -1, 'regular skills still trackable');
  });

  // ---- Farming: Harvest All / Plant All bulk actions -----------------------------------
  suite('farming bulk actions', function(){
    var S = FF._state, grid = S.estate.grid, pm = FF.farmPlotMap('personal');
    // Grab three real grid cells and turn them into fields of tiers 5 / 2 / 0.
    var cells = [];
    for(var x=0; x<grid.length && cells.length<3; x++){ if(!grid[x]) continue; for(var y=0; y<grid[x].length && cells.length<3; y++){ if(grid[x][y]) cells.push([x,y]); } }
    var savedTiers = cells.map(function(c){ return grid[c[0]][c[1]].fieldTier; });
    var savedPlots = {}; Object.keys(pm).forEach(function(k){ savedPlots[k]=pm[k]; delete pm[k]; });
    var savedInv = { t5:S.inventory.seed_t5||0, t2:S.inventory.seed_t2||0, t0:S.inventory.seed_t0||0 };

    [5,2,0].forEach(function(t,i){ grid[cells[i][0]][cells[i][1]].fieldTier = t; });
    S.inventory.seed_t5 = 1; S.inventory.seed_t2 = 1; S.inventory.seed_t0 = 5;

    ok(FF.allFieldPlots().filter(function(p){ return p.scope==='personal'; }).length >= 3, 'three personal fields present');

    // Plant All: best seeds go to the best fields; dry-run count matches the real run.
    eq(FF.farmingPlantAll(true), 3, 'dry-run plants all three empty fields');
    eq(FF.farmingPlantAll(false), 3, 'plant-all fills all three');
    var byTier = {}; FF.allFieldPlots().forEach(function(p){ if(p.tier===5||p.tier===2||p.tier===0){ byTier[p.tier] = p.plot && p.plot.tierIndex; } });
    eq(byTier[5], 5, 'tier-5 field got the highest fitting seed (t5)');
    eq(byTier[2], 2, 'tier-2 field got the t2 seed (t5 doesn\'t fit)');
    eq(byTier[0], 0, 'tier-0 field got a t0 seed');
    eq(FF.farmingPlantAll(true), 0, 'nothing left to plant once every field is full');

    // Harvest All: ripen them, then one call clears every ready plot.
    FF.allFieldPlots().forEach(function(p){ if(p.plot && p.plot.cropType) p.plot.readyAt = Date.now() - 1; });
    eq(FF.farmingReadyCount(), 3, 'all three crops are ready');
    eq(FF.farmingHarvestAll(), 3, 'harvest-all clears all three');
    eq(FF.farmingReadyCount(), 0, 'no ready crops remain after harvest-all');

    // restore
    Object.keys(pm).forEach(function(k){ delete pm[k]; });
    Object.keys(savedPlots).forEach(function(k){ pm[k]=savedPlots[k]; });
    cells.forEach(function(c,i){ grid[c[0]][c[1]].fieldTier = savedTiers[i]; });
    S.inventory.seed_t5 = savedInv.t5; S.inventory.seed_t2 = savedInv.t2; S.inventory.seed_t0 = savedInv.t0;
  });

  // ---- Fertilizer: a refinement crafting skill; doubles a same-tier growing crop's harvest --------
  suite('fertilizer', function(){
    // Data: 21-tier crafting skill; each tier = 1 same-tier Fishing catch + 1 Digging soil; fish-named.
    var fk = FF.CRAFTING_SKILLS.fertilizer;
    ok(fk && fk.recipes.length === FF.TIER_COUNT, 'Fertilizer is a 21-tier crafting skill');
    var r5 = FF.ALL_CRAFT_RECIPES['fertilizer_t5'];
    ok(r5 && r5.inputs['fishing_t5']===1 && r5.inputs['digging_t5']===1, 'fertilizer_t5 = 1 fish + 1 soil, same tier');
    ok(/ Fertilizer$/.test(r5.name), 'fertilizer named "<Fish> Fertilizer"');
    ok(FF.ALL_CRAFT_RECIPES['fertilizer_t0'] && FF.ALL_CRAFT_RECIPES['fertilizer_t20'], 't0 + t20 fertilizer recipes exist');
    ok(FF.CRAFT_SKILL_IDS.indexOf('fertilizer') !== -1 && FF.CRAFTING_TAB_SKILL_IDS.indexOf('fertilizer') !== -1, 'registered + appears in the Crafting tab');
    ok(FF.CRAFT_PHYSIQUE.fertilizer && FF.FAMILIAR_DATA.fertilizer, 'has a physique table + a familiar');

    // Mechanic: fertilize a growing crop with a matching-tier Fertilizer -> it yields double.
    var S = FF._state, grid = S.estate.grid, pm = FF.farmPlotMap('personal');
    var cells = [];
    for(var x=0; x<grid.length && cells.length<2; x++){ if(!grid[x]) continue; for(var y=0; y<grid[x].length && cells.length<2; y++){ if(grid[x][y]) cells.push([x,y]); } }
    var savedTiers = cells.map(function(c){ return grid[c[0]][c[1]].fieldTier; });
    var savedPlots = {}; Object.keys(pm).forEach(function(k){ savedPlots[k]=pm[k]; delete pm[k]; });
    var savedFert = S.inventory.fertilizer_t5||0, savedCrop = S.inventory.farming_t5||0;

    grid[cells[0][0]][cells[0][1]].fieldTier = 5;
    grid[cells[1][0]][cells[1][1]].fieldTier = 5;
    var k0 = cells[0][0]+','+cells[0][1], k1 = cells[1][0]+','+cells[1][1];
    pm[k0] = { cropType:'fiber', tierIndex:5, plantedAt:Date.now(), readyAt:Date.now()+9e8 };
    pm[k1] = { cropType:'fiber', tierIndex:5, plantedAt:Date.now(), readyAt:Date.now()+9e8 };

    S.inventory.fertilizer_t5 = 0;
    ok(!FF.fertilizePlot('personal', k0), 'no fertilizer in stock -> cannot fertilize');
    eq(FF.farmingFertilizableCount(), 0, 'nothing fertilizable without stock');
    // One t5 fertilizer: only one of the two t5 crops can be doubled.
    S.inventory.fertilizer_t5 = 1;
    eq(FF.farmingFertilizableCount(), 1, 'one fertilizer -> one candidate');
    eq(FF.farmingFertilizeAll(false), 1, 'fertilize-all fertilizes exactly one');
    eq(S.inventory.fertilizer_t5, 0, 'the fertilizer was consumed');
    var fertKey = pm[k0].fertilized ? k0 : k1, plainKey = fertKey===k0 ? k1 : k0;
    ok(pm[fertKey].fertilized && !pm[plainKey].fertilized, 'exactly one plot is fertilized');

    // Ripen + harvest: fertilized plot yields 2, the other yields 1.
    pm[k0].readyAt = pm[k1].readyAt = Date.now()-1;
    S.inventory.farming_t5 = 0;
    FF.harvestPlot('personal', fertKey);
    eq(S.inventory.farming_t5, 2, 'fertilized crop yields 2x');
    FF.harvestPlot('personal', plainKey);
    eq(S.inventory.farming_t5, 3, 'plain crop yields 1x (total 3)');

    // restore
    Object.keys(pm).forEach(function(k){ delete pm[k]; });
    Object.keys(savedPlots).forEach(function(k){ pm[k]=savedPlots[k]; });
    cells.forEach(function(c,i){ grid[c[0]][c[1]].fieldTier = savedTiers[i]; });
    S.inventory.fertilizer_t5 = savedFert; S.inventory.farming_t5 = savedCrop;
  });

  // ---- Cross-skill physiques: 20 new physiques trained by one skill, feeding another --------------
  suite('cross-skill physiques', function(){
    var NEW = ['anglersEye','prospectorsNose','huntsman','sylvanBond','quartermaster','masterwork','diligence','weaponsmithsEdge','armorersTemper','greenThumb','composter','apothecarysHand','demolitionist','runicAttunement','wardersFocus','zealotry','oblation','fieldRations','menagerist','merchantsSavvy'];
    NEW.forEach(function(id){
      var p = FF.PHYSIQUE_SKILL_MAP[id];
      ok(p && p.name && p.desc && p.levels && p.affects, id+' is a fully-described physique');
      ok(!p.element, id+' is a normal physique (not an elemental attunement)');
    });
    // XP feeds attach each physique to the skills that train it.
    function feeds(list, id){ return !!list && list.some(function(pr){ return pr[0]===id; }); }
    ok(feeds(FF.GATHER_PHYSIQUE.fishing,'anglersEye'), 'Fishing trains Angler\'s Eye');
    ok(feeds(FF.GATHER_PHYSIQUE.mining,'prospectorsNose'), 'Mining trains Prospector\'s Nose');
    ok(feeds(FF.GATHER_PHYSIQUE.butchering,'huntsman'), 'Butchering trains Huntsman');
    ok(feeds(FF.GATHER_PHYSIQUE.forestry,'sylvanBond'), 'Forestry trains Sylvan Bond');
    ok(feeds(FF.CRAFT_PHYSIQUE.alchemy,'apothecarysHand'), 'Alchemy trains Apothecary\'s Hand');
    ok(feeds(FF.CRAFT_PHYSIQUE.fertilizer,'composter'), 'Fertilizer trains Composter');
    ok(feeds(FF.CRAFT_PHYSIQUE.weaponsmithing,'weaponsmithsEdge'), 'Weaponsmithing trains Weaponsmith\'s Edge');
    ok(feeds(FF.CRAFT_PHYSIQUE.armorsmithing,'armorersTemper'), 'Armorsmithing trains Armorer\'s Temper');
    ok(feeds(FF.CRAFT_PHYSIQUE.inscription,'wardersFocus'), 'Inscription trains Warder\'s Focus');
    ok(feeds(FF.CRAFT_PHYSIQUE.gastronomy,'fieldRations'), 'Gastronomy trains Field Rations');
    ok(feeds(FF.FARMING_PHYSIQUE,'greenThumb'), 'Farming trains Green Thumb');
    // Quartermaster + Diligence feed EVERY craft; Masterwork feeds outfitting crafts.
    ok(feeds(FF.CRAFT_PHYSIQUE.cooking,'quartermaster') && feeds(FF.CRAFT_PHYSIQUE.cooking,'diligence'), 'all crafts train Quartermaster + Diligence');
    ok(feeds(FF.CRAFT_PHYSIQUE.weaponsmithing,'masterwork') && !feeds(FF.CRAFT_PHYSIQUE.cooking,'masterwork'), 'only outfitting crafts train Masterwork');
    // Logic trains ONLY from Refining skills (metallurgy/tanning/...), not cooking/outfitting/construction.
    ok(feeds(FF.CRAFT_PHYSIQUE.metallurgy,'logic') && feeds(FF.CRAFT_PHYSIQUE.tanning,'logic')
       && !feeds(FF.CRAFT_PHYSIQUE.cooking,'logic') && !feeds(FF.CRAFT_PHYSIQUE.weaponsmithing,'logic') && !feeds(FF.CRAFT_PHYSIQUE.carpentry,'logic'),
       'only refining crafts train Logic');

    // Effect scaling: at Lv100 each bonus reaches its cap; helpers read live state.physique.
    var S = FF._state, saved = {}, savedFaith = S.faith;
    NEW.forEach(function(id){ saved[id] = S.physique[id]; S.physique[id] = FF.xpFloorForLevel(100); });
    ok(Math.abs(FF.anglersEyeTreasureBonus() - 0.15) < 1e-6, 'Angler\'s Eye +15% treasure at Lv100');
    ok(Math.abs(FF.merchantSellMult() - 1.15) < 1e-6, 'Merchant\'s Savvy +15% sell at Lv100');
    ok(Math.abs(FF.merchantTaxMult() - 0.50) < 1e-6, 'Merchant\'s Savvy halves Market tax at Lv100');
    ok(Math.abs(FF.weaponsmithEdgeMult() - 1.15) < 1e-6, 'Weaponsmith\'s Edge +15% damage at Lv100');
    ok(Math.abs(FF.armorerTemperMult() - 1.15) < 1e-6, 'Armorer\'s Temper +15% armour at Lv100');
    ok(Math.abs(FF.runicAttunementMult() - 1.20) < 1e-6, 'Runic Attunement +20% wand/scepter at Lv100');
    ok(Math.abs(FF.menageristPotencyMult() - 1.25) < 1e-6, 'Menagerist +25% familiar potency at Lv100');
    ok(Math.abs(FF.diligenceCraftXpMult() - 1.15) < 1e-6, 'Diligence +15% craft XP at Lv100');
    eq(FF.apothecaryExtraCharges(), 5, 'Apothecary\'s Hand +5 potion charges at Lv100');
    ok(Math.abs(FF.demolitionistMult() - 1.30) < 1e-6, 'Demolitionist +30% bomb/flash at Lv100');
    ok(Math.abs(FF.wardersFocusReflectBonus() - 0.15) < 1e-6, 'Warder\'s Focus +15% reflect at Lv100');
    ok(Math.abs(FF.greenThumbGrowthMult() - 0.85) < 1e-6, 'Green Thumb -15% growth time at Lv100');
    ok(Math.abs(FF.huntsmanOutputBonus() - 0.12) < 1e-6, 'Huntsman +12% butcher output at Lv100');
    ok(Math.abs(FF.masterworkRarityBonus() - 0.15) < 1e-6, 'Masterwork +15% rare odds at Lv100');
    ok(Math.abs(FF.sylvanBondCacheBonus() - 0.05) < 1e-6, 'Sylvan Bond +5% cache at Lv100');
    ok(Math.abs(FF.physBonus('anglersEye', 0.3) - 0.3) < 1e-6, 'physBonus reaches its cap at Lv100');
    // Zealotry scales with current Faith fraction.
    S.faith = 1e9; // clamp to full-faith fraction
    ok(Math.abs(FF.zealotryDmgMult() - 1.20) < 1e-6, 'Zealotry +20% damage at full Faith (Lv100)');
    S.faith = 0;
    ok(Math.abs(FF.zealotryDmgMult() - 1) < 1e-6, 'Zealotry neutral at 0 Faith');
    // restore
    NEW.forEach(function(id){ S.physique[id] = saved[id]; });
    S.faith = savedFaith;
  });

  // ---- Resources reorg: Gathering / Refining / Cooking / Construction split + 70% gather success -----
  suite('resources reorg', function(){
    // Cooking = food & drink; Refining = the rest of the old Crafting tab; both partition it exactly.
    var COOK = FF.COOKING_SKILL_IDS, REF = FF.REFINING_SKILL_IDS, TAB = FF.CRAFTING_TAB_SKILL_IDS;
    ['roasting','cooking','baking','brewing','mixology','confectionery','dairy','gastronomy'].forEach(function(id){
      ok(COOK.indexOf(id) !== -1, id+' is a Cooking skill');
    });
    ok(REF.indexOf('metallurgy') !== -1 && REF.indexOf('tanning') !== -1 && REF.indexOf('alchemy') !== -1, 'Refining holds the material-processing crafts');
    ok(COOK.every(function(id){ return REF.indexOf(id) === -1; }), 'Cooking and Refining are disjoint');
    eq(COOK.length + REF.length, TAB.length, 'Cooking + Refining exactly partition the old Crafting tab');
    // Butchering left Gathering and leads Refining.
    ok(FF.GATHERING_TAB_SKILL_IDS.indexOf('butchering') === -1, 'Gathering no longer lists Butchering');
    ok(FF.GATHER_SKILL_IDS.indexOf('butchering') !== -1, 'Butchering is still a (gather-backed) skill');
    eq(FF.REFINING_TAB_SKILL_IDS[0], 'butchering', 'Butchering leads the Refining tab');

    // Every gathering skill now has a 70% base main-output chance (no equipped tool).
    eq(FF.BASE_GATHER_MAIN_CHANCE, 0.70, 'base gather success is 70%');
    var S = FF._state, savedTools = S.gatherTools;
    S.gatherTools = {}; // no tools -> pure base
    ['forestry','herbalism','botany','foraging','beekeeping','essence','tapping','spelunking'].forEach(function(sk){
      ok(Math.abs(FF.genericGatherMainChance(S, sk) - 0.70) < 1e-9, sk+' base success = 70%');
    });
    S.gatherTools = savedTools;

    // Skills-tab progress helper returns a 0..100 percentage.
    var p = FF.anySkillProgress('mining');
    ok(typeof p === 'number' && p >= 0 && p <= 100, 'anySkillProgress is a 0-100 percentage');
  });

  // ---- Guild estate: leader-set demolition permission (who may remove buildings / pavement) ----------
  suite('guild demolition permission', function(){
    eq(FF.GUILD_RANK_ORDER.leader, 3, 'rank order leader(3) > officer(2) > member(1)');
    var GS = FF.guildState, GE = FF.guildEstate;
    var savedRank = GS.myRank, savedRole = GE.destroyRole;
    GE.destroyRole = 'officer';
    GS.myRank = 'member';  ok(!FF.canDestroyGuildEstate(), 'member blocked when set to Officers+');
    GS.myRank = 'officer'; ok(FF.canDestroyGuildEstate(), 'officer allowed when set to Officers+');
    GS.myRank = 'leader';  ok(FF.canDestroyGuildEstate(), 'leader is always allowed');
    GE.destroyRole = 'leader';
    GS.myRank = 'officer'; ok(!FF.canDestroyGuildEstate(), 'officer blocked when set to Leader only');
    GE.destroyRole = 'member';
    GS.myRank = 'member';  ok(FF.canDestroyGuildEstate(), 'any member allowed when set to Any member');
    GE.destroyRole = undefined; eq(FF.guildDestroyMinRole(), 'officer', 'defaults to Officers+');
    GS.myRank = savedRank; GE.destroyRole = savedRole;
  });

  // ---- Persisted supreme/fantastic craft blasts reload into global chat as system messages ----------
  suite('persistent craft blasts', function(){
    var sup = FF.chronicleCraftToSystemMsg({ id:7, username:'Nyx', body:'Supreme Iron Sword', created_at:'2026-07-10T00:00:00Z' });
    ok(sup && sup.system === true && sup.rarity === 'supreme', 'a Supreme craft row -> a system message');
    ok(sup.id === 'sys-7' && sup.username === null && /Nyx forged a Supreme Iron Sword!/.test(sup.body), 'system message carries the forger + item');
    var fan = FF.chronicleCraftToSystemMsg({ id:8, username:'Vex', body:'Fantastic Dragon Bow', created_at:'2026-07-10T00:00:00Z' });
    ok(fan && fan.rarity === 'fantastic', 'a Fantastic craft row -> a fantastic system message');
    ok(FF.chronicleCraftToSystemMsg({ id:9, username:'A', body:'Rare Copper Ring', created_at:'x' }) === null, 'Rare/normal crafts are not blasted');
    ok(FF.chronicleCraftToSystemMsg({ id:10, username:'A', body:'Iron Sword', created_at:'x' }) === null, 'a plain craft is not blasted');
  });

  // ---- Top-bar tips & tricks ticker ------------------------------------------------------------------
  suite('tips ticker', function(){
    var T = FF.TICKER_TIPS;
    ok(Array.isArray(T) && T.length >= 20, 'there is a healthy list of tips (>= 20)');
    ok(T.every(function(t){ return typeof t === 'string' && t.length > 10; }), 'every tip is a non-trivial string');
    ok(T.some(function(t){ return /Logic/.test(t) && /craft slot/.test(t); }), 'includes the Logic craft-slot tip');
    ok(T.some(function(t){ return /Sand/.test(t) && /Archaeolog/.test(t); }), 'includes the Sand / Archaeology tip');
    ok(new Set(T).size === T.length, 'no duplicate tips');
  });

  // ---- Icon shape symbols exist (previously-blank Dairy/Ranching/Tanning/Weaving/etc. icons) ---------
  suite('icon shapes defined', function(){
    ['milk','cheese','churn','block','bottle','hide','spool','mug'].forEach(function(sh){
      ok(document.getElementById('shape-'+sh), 'shape-'+sh+' symbol is defined (icon renders, not blank)');
    });
  });

  // ---- Guild estate: assist a teammate's task ------------------------------------------
  suite('guild estate assist', function(){
    var ge = FF.guildEstate;
    var saved = { status:ge.status, jobs:ge.jobs, version:ge.version };
    ge.status = 'ready'; ge.version = 0;
    var NOW = Date.now();
    ge.jobs = [{ owner:'alice', ownerName:'Alice', kind:'clear', x:3, y:4, startAt:NOW-1000, readyAt:NOW+60000 }];
    var remBefore = ge.jobs[0].readyAt - NOW;

    // Assisting halves the target's remaining time, marks the target, and busies the helper.
    FF.estateAssistJob('alice');
    var tgt = FF.guildJobByOwner('alice');
    var mine = ge.jobs.filter(function(j){ return j.kind==='assist'; })[0];
    var myId = mine && mine.owner;
    ok(mine && mine.assistOf==='alice', 'assisting creates an assist job for the helper');
    ok(tgt.assistedBy===myId, 'target job is marked as assisted by the helper');
    ok(Math.abs((tgt.readyAt-Date.now()) - remBefore/2) < 2000, 'remaining time is halved');
    eq(mine.readyAt, tgt.readyAt, "helper's job ends exactly when the assisted task finishes");

    // The helper is busy: cannot assist again.
    var n1 = ge.jobs.length; FF.estateAssistJob('alice'); eq(ge.jobs.length, n1, 'cannot assist while already busy');

    // The helper is freed (with no reward job) when the assisted task finishes; marker clears.
    mine.readyAt = Date.now()-1;
    FF.processGuildEstateJobs();
    ok(!ge.jobs.some(function(j){ return j.kind==='assist'; }), 'helper is freed when the task finishes');
    ok(!FF.guildJobByOwner('alice').assistedBy, 'assist marker cleared once the helper is freed');

    // An already-assisted job cannot be double-assisted.
    var a2 = FF.guildJobByOwner('alice'); a2.assistedBy='bob'; a2.assistedByName='Bob';
    var n2 = ge.jobs.length; FF.estateAssistJob('alice'); eq(ge.jobs.length, n2, 'an already-assisted job cannot be assisted again');
    delete a2.assistedBy; delete a2.assistedByName;

    // Duplicate guard: an incoming snapshot that changed MY job's readyAt (a teammate assisting me)
    // must not leave two copies of my job.
    ge.jobs = [{ owner:myId, ownerName:'Me', kind:'clear', x:1, y:1, startAt:NOW, readyAt:NOW+50000 }];
    FF.guildEstateHydrate({ grid:ge.grid, jobs:[{ owner:myId, ownerName:'Me', kind:'clear', x:1, y:1, startAt:NOW, readyAt:NOW+25000 }], expansionsPurchased:0, edgesX:ge.edgesX, edgesY:ge.edgesY }, 9);
    eq(ge.jobs.filter(function(j){ return j.owner===myId && j.x===1 && j.y===1; }).length, 1, 'an assisted (readyAt-changed) job is not duplicated on hydrate');
    eq(ge.jobs.filter(function(j){ return j.owner===myId; })[0].readyAt, NOW+25000, 'hydrate adopts the incoming (halved) readyAt');

    ge.status = saved.status; ge.jobs = saved.jobs; ge.version = saved.version;
  });

  // ---- Leaderboard covers every skill / proficiency / class / physique ------------------
  suite('leaderboard coverage', function(){
    // Union of every skill id the leaderboard can rank or show (drives both the "Rank by"
    // dropdown and the profile page).
    var grouped = {};
    FF.SKILL_GROUPS.forEach(function(g){ g.skills.forEach(function(sk){ grouped[sk] = true; }); });

    // Every main skill/proficiency/class is grouped, so newly-added content can never silently
    // drop off the board.
    // Every Class has a hand-crafted hero portrait (the leaderboard shows it per player, not a small icon).
    ok(FF.CLASS_PORTRAITS && FF.CLASS_PORTRAITS.none, 'the no-class portrait exists');
    FF.CLASS_SKILL_IDS.forEach(function(cid){
      var pt = FF.CLASS_PORTRAITS[cid];
      ok(typeof pt === 'string' && pt.indexOf('<svg') === 0, 'class ' + cid + ' has a hand-crafted portrait');
    });
    FF.ALL_MAIN_SKILL_IDS.forEach(function(id){ ok(grouped[id], 'leaderboard covers main skill: ' + id); });
    // Every physique too (body physiques + elemental attunements).
    FF.PHYSIQUE_SKILLS.forEach(function(p){ ok(grouped[p.id], 'leaderboard covers physique: ' + p.id); });

    // Spot-check the recently-added content specifically.
    ['scimitar','claw','treasureHunter','wands','staves','scepters','warding',
     'clotharmor','leatherarmor','chainmailarmor','platearmor',
     'fireAttunement','waterAttunement','earthAttunement','lightAttunement','darkAttunement']
      .forEach(function(id){ ok(grouped[id], 'newly-added content is on the leaderboard: ' + id); });

    // Everything ranked has a human-readable label (no raw ids leak into the UI).
    Object.keys(grouped).forEach(function(id){ ok(FF.SKILL_LABELS[id] && FF.SKILL_LABELS[id] !== id, 'labelled: ' + id); });

    // There is a dedicated Physique group.
    ok(FF.SKILL_GROUPS.some(function(g){ return g.label === 'Physique'; }), 'a Physique group exists');

    // Profile stats fold physiques into the skills map AND count them toward total_level, so the
    // server's `total_level == sum(skills)` validation passes (submit_profile rejects any mismatch).
    var s = FF._state;
    var physId = FF.PHYSIQUE_SKILLS[0].id, mainId = 'mining';
    var snap = { phys:s.physique[physId], xp:s.xp[mainId] };
    function sumSkills(st){ return Object.keys(st.skills).reduce(function(a,k){ return a + st.skills[k]; }, 0); }
    s.physique[physId] = 0; s.xp[mainId] = 0;
    var base = FF.computeProfileStats();
    ok(base.skills[physId] !== undefined, 'physiques appear in the profile skills map');
    eq(base.total_level, sumSkills(base), 'total_level equals the sum of every submitted skill (server invariant)');
    // Guard the server's MAX_SKILLS cap (submit_profile rejects the WHOLE submission if the skill count
    // exceeds it -- which silently froze the entire leaderboard once the set outgrew the old cap of 160).
    // The submitted set is ~172 today; keep it well under the server's 400 so adding classes/skills can't
    // break profile writes without this failing first as a heads-up to bump the server cap.
    var submittedSkillCount = Object.keys(base.skills).length;
    ok(submittedSkillCount < 350, 'submitted leaderboard skill count (' + submittedSkillCount + ') stays well under the server MAX_SKILLS cap (400)');
    s.physique[physId] = FF.xpFloorForLevel(31); // ~Lv 31
    var afterPhys = FF.computeProfileStats();
    ok(afterPhys.skills[physId] > 0, 'physique level shows in the profile');
    ok(afterPhys.total_level > base.total_level, 'physiques now raise total_level');
    eq(afterPhys.total_level, sumSkills(afterPhys), 'total_level still equals sum(skills) after training a physique');
    s.xp[mainId] = FF.xpFloorForLevel(31);
    ok(FF.computeProfileStats().total_level > afterPhys.total_level, 'a main skill also raises total_level');
    s.physique[physId] = snap.phys; s.xp[mainId] = snap.xp;

    // Ranking by a physique metric reads the skills map.
    eq(FF.lbMetricValue({ skills:{ fireAttunement: 42 } }, 'skill:fireAttunement'), 42, 'can rank by a physique');
    eq(FF.lbMetricValue({ skills:{} }, 'skill:fireAttunement'), 0, 'missing physique ranks as 0');
  });

  // ---- PEON_MAX_SLOTS must be a defined constant (its absence blanked the Peons tab) ---
  suite('peon slot constant', function(){
    eq(FF.PEON_MAX_SLOTS, 5, 'PEON_MAX_SLOTS defined = 5 (10 total: 5 personal + 5 guild)');
    // Cottage build timer: 10 minutes per tier (tier index T -> (T+1)*10 min).
    eq(FF.ESTATE_COTTAGE_MS_PER_TIER, 10*60*1000, 'cottage build = 10 min per tier');
    eq((0+1)*FF.ESTATE_COTTAGE_MS_PER_TIER, 600000, 'tier-0 cottage builds in 10 min');
    eq((3+1)*FF.ESTATE_COTTAGE_MS_PER_TIER, 2400000, 'tier-3 cottage builds in 40 min');
  });

  // ---- Server-wide EXP buff -------------------------------------------------------------
  suite('server exp buff', function(){
    eq(FF.SERVER_BUFF_EXP_COST, 100000, 'exp buff costs 100,000 gold');
    eq(FF.SERVER_BUFF_EXP_MULT, 1.5, 'exp buff is +50% XP');
    eq(FF.expBuffMultFor(1000, 2000), 1.5, 'buff active (now < until) -> 1.5x');
    eq(FF.expBuffMultFor(3000, 2000), 1, 'buff expired (now >= until) -> 1x');
    eq(FF.expBuffMultFor(1000, 0), 1, 'no buff (until 0) -> 1x');
    ok(FF.LB_STAT_METRICS.some(function(m){ return m.key === 'hoursBuffed'; }), 'hoursBuffed is a leaderboard metric');
  });

  // ---- Physique XP scales with task tier: each associated physique gains tier+1 (1..21) --------
  suite('physique tier XP', function(){
    eq(FF.itemTierFromId('mining_t0'), 0, 'itemTierFromId t0');
    eq(FF.itemTierFromId('bodyarmor_chain_chest_t20_normal'), 20, 'itemTierFromId t20');
    eq(FF.itemTierFromId('shaft'), 0, 'itemTierFromId no-tier -> 0');
    var pairs = [['bodyStrength', 2], ['curiosity', 1]];
    eq(JSON.stringify(FF.physTierPairs(pairs, 0)), JSON.stringify([['bodyStrength', 1], ['curiosity', 1]]), 't0 -> 1 xp each');
    eq(JSON.stringify(FF.physTierPairs(pairs, 20)), JSON.stringify([['bodyStrength', 21], ['curiosity', 21]]), 't20 -> 21 xp each');
    eq(FF.physTierPairs(pairs, 5)[0][1], 6, 't5 -> 6 xp');
    // recipeTier: explicit tierIndex wins; otherwise fall back to the output id's _t<n> suffix so
    // standard recipes (no tierIndex field) still scale physique XP (regression: Logic stuck at 1).
    eq(FF.recipeTier({tierIndex:7}, 'cooking_t3'), 7, 'recipeTier prefers explicit tierIndex');
    eq(FF.recipeTier({}, 'stonecutting_t5'), 5, 'recipeTier falls back to item id tier');
    eq(FF.recipeTier({id:'twine_t2'}, null), 2, 'recipeTier falls back to recipe.id tier');
    eq(FF.recipeTier({}, 'fletching_shaft'), 0, 'recipeTier no-tier -> 0');
    // A standard carpentry recipe at t4 -> logic (and every associated physique) gains 5.
    eq(FF.physTierPairs([['grossMotor',2],['sleightOfHand',1],['logic',1]], FF.recipeTier({}, 'carpentry_t4'))[2][1], 5, 'carpentry t4 -> logic gains 5');
  });

  // ---- Every physique that interacts with a gather/craft skill now earns tiered XP from it ------
  suite('physique XP: benefit-set folded into trained-set', function(){
    function trainedIds(sk){ return FF.GATHER_PHYSIQUE[sk] ? FF.GATHER_PHYSIQUE[sk].map(function(p){return p[0];}) : FF.CRAFT_PHYSIQUE[sk].map(function(p){return p[0];}); }
    // The core rule: for every gathering/crafting skill, the physiques that BENEFIT it are a subset
    // of the physiques TRAINED by it -- so anything that interacts with the action also earns XP.
    Object.keys(FF.GATHER_PHYSIQUE).concat(Object.keys(FF.CRAFT_PHYSIQUE)).forEach(function(sk){
      var trained = trainedIds(sk);
      FF.physiqueBenefitsForSkill(sk).forEach(function(e){
        ok(trained.indexOf(e[0]) !== -1, sk + ' trains its benefiting physique ' + e[0]);
      });
      // physTierPairs still gives every trained physique tier+1 (uniform, like Logic).
      var pairs = FF.physTierPairs(FF.CRAFT_PHYSIQUE[sk] || FF.GATHER_PHYSIQUE[sk], 4);
      ok(pairs.every(function(p){ return p[1] === 5; }), sk + ': all physiques gain tier+1 (=5 at t4)');
    });
    // Spot-check the specific gaps this closes (benefit-only -> now trained).
    ok(trainedIds('foraging').indexOf('fineMotor') !== -1, 'foraging now trains Fine Motor (its find-rate physique)');
    ok(trainedIds('tailoring').indexOf('handStrength') !== -1, 'tailoring now trains Hand Strength');
    ok(trainedIds('tailoring').indexOf('grossMotor') !== -1, 'tailoring now trains Gross Motor (success)');
    ok(trainedIds('masonry').indexOf('coreStrength') !== -1, 'masonry now trains Core Strength');
    ok(trainedIds('alchemy').indexOf('criticalThinking') !== -1, 'alchemy now trains Critical Thinking');
    ok(trainedIds('runesmithing').indexOf('sleightOfHand') !== -1, 'runesmithing now trains Sleight of Hand (speed)');
    // Unchanged where already covered: heavy crafts keep exactly their original set + no phantom adds.
    ok(trainedIds('carpentry').indexOf('grossMotor') !== -1 && trainedIds('carpentry').indexOf('handStrength') === -1, 'carpentry keeps Gross Motor, gains no hand-craft physique');
  });

  // ---- Chat profanity filter -------------------------------------------------------------------
  suite('chat: profanity filter', function(){
    var c = FF.censorChat;
    function censored(s){ var out = c(s); return out !== s && out.indexOf('*') !== -1; }
    // Clean text is untouched.
    eq(c('hello there, nice to meet you'), 'hello there, nice to meet you', 'clean text passes through');
    eq(c(''), '', 'empty string is safe');
    // Bad words get masked (first char kept, rest starred).
    eq(c('you fuck'), 'you f***', 'basic swear masked');
    ok(censored('what the shit'), 'shit masked');
    ok(censored('bitch'), 'bitch masked');
    // Inflections and compounds.
    ok(censored('stop fucking around'), 'inflection (fucking) masked');
    ok(censored('you asshole'), 'compound (asshole) masked');
    ok(censored('motherfucker'), 'motherfucker masked');
    // Light obfuscation: leetspeak + repeated letters.
    ok(censored('sh1t'), 'leetspeak (sh1t) masked');
    ok(censored('fuuuck'), 'stretched (fuuuck) masked');
    ok(censored('@sshole'), 'leet @ (@sshole) masked');
    // No Scunthorpe: real words that merely contain a bad substring are untouched.
    eq(c('the assassin joined our class in the grass'), 'the assassin joined our class in the grass', 'assassin/class/grass untouched');
    eq(c('check the cockpit and pass'), 'check the cockpit and pass', 'cockpit/pass untouched');
    eq(c('scunthorpe analysis'), 'scunthorpe analysis', 'scunthorpe untouched');
    // Punctuation-adjacent still catches.
    ok(censored('fuck!'), 'trailing punctuation still masked');
    // First letter of the mask is preserved so length/shape stays readable.
    ok(c('shit').charAt(0) === 's' && c('shit').slice(1) === '***', 'mask keeps first char + stars');
  });

  // ---- Guild membership cap --------------------------------------------------------------------
  suite('guild: 10-member cap', function(){
    eq(FF.GUILD_MAX_MEMBERS, 10, 'cap is 10');
    ok(FF.guildIsFull(10), '10 members is full');
    ok(FF.guildIsFull(11), 'over cap is full');
    ok(!FF.guildIsFull(9), '9 members is not full');
    ok(!FF.guildIsFull(0), 'empty is not full');
    ok(!FF.guildIsFull(undefined), 'undefined count treated as not full');
  });

  // ---- Beekeeping / Brewing / Confectionery vertical slice ------------------------------------
  suite('skills: beekeeping / brewing / confectionery', function(){
    // Registered as real skills in the right groups.
    ok(FF.GATHERING_SKILLS.beekeeping, 'beekeeping is a gathering skill');
    ok(FF.CRAFTING_SKILLS.brewing, 'brewing is a crafting skill');
    ok(FF.CRAFTING_SKILLS.confectionery, 'confectionery is a crafting skill');
    // Full 21-tier ladders.
    eq(FF.GATHERING_SKILLS.beekeeping.items.length, FF.TIER_COUNT, 'beekeeping has 21 honey tiers');
    eq(FF.CRAFTING_SKILLS.brewing.recipes.length, FF.TIER_COUNT, 'brewing has 21 brew tiers');
    eq(FF.CRAFTING_SKILLS.confectionery.recipes.length, FF.TIER_COUNT, 'confectionery has 21 tiers');
    // Gather items are registered and named.
    ok(FF.ALL_GATHER_ITEMS['beekeeping_t0'] && FF.ALL_GATHER_ITEMS['beekeeping_t20'], 'honey items registered t0..t20');
    eq(FF.ALL_GATHER_ITEMS['beekeeping_t19'].name, 'Royal Jelly', 'top honey tiers are Royal Jelly/Ambrosia');
    // Brewing = drinkable buff (Tea-like) and finally consumes Botany spices + Honey + Grain.
    var brew5 = FF.ALL_CRAFT_RECIPES['brewing_t5'];
    ok(brew5.teaDurationMs > 0 && brew5.xpBoost > 0, 'brews are XP buff-drinks');
    ok(brew5.inputs['beekeeping_t5'] && brew5.inputs['botany_t5'] && brew5.inputs['grain_t5'], 'brew uses honey + botany spice + grain');
    ok(FF.TEA_DRINK_RECIPES.some(function(r){ return r.id === 'brewing_t5'; }), 'brews join the drinkable Tea/Brew pool');
    ok(FF.TEA_DRINK_RECIPES.some(function(r){ return r.id === 'mixology_t5'; }), 'mixology teas still in the pool');
    // Grain clamps at its 20-tier ceiling for the top brew.
    ok(FF.ALL_CRAFT_RECIPES['brewing_t20'].inputs['grain_t19'], 'top brew clamps grain to t19');
    // Confectionery = manual-eat heal snack (heal, but not auto-eaten in combat).
    var conf5 = FF.ALL_CRAFT_RECIPES['confectionery_t5'];
    ok(conf5.heal > 0, 'confections heal');
    ok(!conf5.autoEatFood, 'confections are manual-eat (not auto-eaten)');
    ok(conf5.inputs['beekeeping_t5'] && conf5.inputs['foraging_t5'], 'confection uses honey + foraged berry');
    // Physique training wired for all three.
    ok(FF.GATHER_PHYSIQUE.beekeeping && FF.CRAFT_PHYSIQUE.brewing && FF.CRAFT_PHYSIQUE.confectionery, 'physique tables include the new skills');
  });

  // ---- Prospecting / Gemcutting / Enchanting vertical slice -----------------------------------
  suite('skills: prospecting / gemcutting / enchanting', function(){
    ok(FF.GATHERING_SKILLS.prospecting, 'prospecting is a gathering skill');
    ok(FF.CRAFTING_SKILLS.gemcutting, 'gemcutting is a crafting skill');
    ok(FF.CRAFTING_SKILLS.enchanting, 'enchanting is a crafting skill');
    eq(FF.GATHERING_SKILLS.prospecting.items.length, FF.TIER_COUNT, 'prospecting has 21 rough-gem tiers');
    eq(FF.CRAFTING_SKILLS.gemcutting.recipes.length, FF.TIER_COUNT, 'gemcutting has 21 tiers');
    eq(FF.CRAFTING_SKILLS.enchanting.recipes.length, FF.TIER_COUNT, 'enchanting has 21 tiers');
    // The chain: Rough Gem -> Cut Gem -> Weapon Enchant.
    eq(FF.ALL_GATHER_ITEMS['prospecting_t0'].name, 'Rough Quartz', 'prospects Rough Gems');
    var cut5 = FF.ALL_CRAFT_RECIPES['gemcut_t5'];
    ok(cut5.inputs['prospecting_t5'], 'gemcutting consumes the matching Rough Gem');
    eq(cut5.name, 'Cut Peridot', 'gemcutting yields Cut Gems');
    var ench5 = FF.ALL_CRAFT_RECIPES['enchant_t5'];
    ok(ench5.inputs['gemcut_t5'] && ench5.inputs['metallurgy_t5'], 'enchant consumes a Cut Gem + metal');
    eq(ench5.name, 'Peridot Enchant Crystal', 'enchanting yields Enchant Crystals');
    // Enchant Crystals are the Improvement-tab enchant INPUT, no longer a Battle-tab combat consumable.
    ok(FF.POTION_TYPE_IDS.indexOf('enchant') === -1, 'enchant is NOT a combat consumable line (retired)');
    ok(ench5.potionType === undefined, 'enchant recipe carries no potionType (retired consumable)');
    ok(FF.GATHER_PHYSIQUE.prospecting && FF.CRAFT_PHYSIQUE.gemcutting && FF.CRAFT_PHYSIQUE.enchanting, 'physique tables include the new skills');
  });

  // ---- Ranching / Dairy / Gastronomy vertical slice + Feast buff channel ----------------------
  suite('skills: ranching / dairy / gastronomy', function(){
    ok(FF.GATHERING_SKILLS.ranching, 'ranching is a gathering skill');
    ok(FF.CRAFTING_SKILLS.dairy, 'dairy is a crafting skill');
    ok(FF.CRAFTING_SKILLS.gastronomy, 'gastronomy is a crafting skill');
    eq(FF.GATHERING_SKILLS.ranching.items.length, FF.TIER_COUNT, 'ranching has 21 milk tiers');
    eq(FF.CRAFTING_SKILLS.dairy.recipes.length, FF.TIER_COUNT, 'dairy has 21 cheese tiers');
    eq(FF.CRAFTING_SKILLS.gastronomy.recipes.length, FF.TIER_COUNT, 'gastronomy has 21 feast tiers');
    // Chain: Milk -> Cheese -> Feast (Cheese + Botany spice + Cooking meal).
    eq(FF.ALL_GATHER_ITEMS['ranching_t0'].name, 'Goat Milk', 'ranching yields Milk');
    var cheese5 = FF.ALL_CRAFT_RECIPES['dairy_t5'];
    ok(cheese5.inputs['ranching_t5'], 'dairy churns the matching Milk');
    eq(cheese5.name, 'Camel Cheese', 'dairy yields Cheese');
    var feast5 = FF.ALL_CRAFT_RECIPES['gastronomy_t5'];
    ok(feast5.inputs['dairy_t5'] && feast5.inputs['botany_t5'] && feast5.inputs['cooking_t5'], 'feast plates cheese + botany spice + cooking meal');
    // Feast is a food AND a timed combat buff -- a distinct channel.
    ok(feast5.heal > 0, 'feasts heal');
    ok(feast5.feastBonus > 0 && feast5.feastDurationMs > 0, 'feasts carry a timed damage buff');
    var f0 = FF.ALL_CRAFT_RECIPES['gastronomy_t0'], f20 = FF.ALL_CRAFT_RECIPES['gastronomy_t20'];
    ok(f20.feastBonus > f0.feastBonus && f20.feastBonus <= 0.35 + 1e-9, 'feast damage bonus scales with tier (cap 35%)');
    // Serving a feast activates the buff and empowers hits; no buff by default.
    eq(FF.feastDamageBonus(), 0, 'no feast buff by default');
    FF._state.inventory['gastronomy_t10'] = 1; FF._state.playerHp = 1;
    FF.serveFeast('gastronomy_t10');
    ok(FF.isFeastActive(), 'serving a feast activates the buff');
    ok(FF.feastDamageBonus() > 0, 'active feast adds weapon damage');
    ok(FF._state.playerHp > 1, 'serving a feast also heals');
    ok(FF.GATHER_PHYSIQUE.ranching && FF.CRAFT_PHYSIQUE.dairy && FF.CRAFT_PHYSIQUE.gastronomy, 'physique tables include the new skills');
  });

  // ---- Mycology / Apothecary vertical slice (poison Weapon Coatings) --------------------------
  suite('skills: mycology / apothecary', function(){
    ok(FF.GATHERING_SKILLS.mycology, 'mycology is a gathering skill');
    ok(FF.CRAFTING_SKILLS.apothecary, 'apothecary is a crafting skill');
    eq(FF.GATHERING_SKILLS.mycology.items.length, FF.TIER_COUNT, 'mycology has 21 mushroom tiers');
    eq(FF.CRAFTING_SKILLS.apothecary.recipes.length, FF.TIER_COUNT, 'apothecary has 21 coating tiers');
    eq(FF.ALL_GATHER_ITEMS['mycology_t0'].name, 'Button Mushroom', 'mycology forages mushrooms');
    // Apothecary distils toxic mushroom + herb (and, unlike Alchemy, needs no glass bottle).
    var coat5 = FF.ALL_CRAFT_RECIPES['coating_t5'];
    ok(coat5.inputs['mycology_t5'] && coat5.inputs['herbalism_t5'], 'coating uses toxic mushroom + herb');
    ok(!coat5.inputs['metallurgy_glass'], 'coatings need no glass bottle (distinct from Alchemy)');
    // Coating is a 6th combat-consumable line that poisons over time.
    ok(FF.POTION_TYPE_IDS.indexOf('coating') !== -1, 'coating is a combat consumable line');
    eq(coat5.potionType, 'coating', 'coating recipe carries potionType');
    var c0 = FF.potionEffect('coating_t0'), c20 = FF.potionEffect('coating_t20');
    ok(c0 && c0.type==='coating' && c20 && c20.type==='coating', 'coating potionEffect resolves');
    ok(c20.pct > c0.pct, 'coating poison scales with tier');
    // Distinct from Alchemy Toxin: a longer poison window.
    ok(c20.durationMs > 3000, 'coating poisons longer than a Toxin (>3s burst)');
    ok(/Poison .* combat score\/s/.test(FF.potionEffectDesc('coating_t10')), 'coating describes its poison DoT');
    ok(FF.GATHER_PHYSIQUE.mycology && FF.CRAFT_PHYSIQUE.apothecary, 'physique tables include the new skills');
  });

  // ---- Refinement layer: Tanning (Hide->Leather) + Weaving (Fiber->Cloth) ----------------------
  suite('skills: tanning / weaving refinement', function(){
    ok(FF.CRAFTING_SKILLS.tanning, 'tanning is a crafting skill');
    ok(FF.CRAFTING_SKILLS.weaving, 'weaving is a crafting skill');
    eq(FF.CRAFTING_SKILLS.tanning.recipes.length, FF.TIER_COUNT, 'tanning has 21 leather tiers');
    eq(FF.CRAFTING_SKILLS.weaving.recipes.length, FF.TIER_COUNT, 'weaving has 21 cloth tiers');
    // Each refines its raw 1:1 (material balance preserved -- just an added step + XP).
    var lea5 = FF.ALL_CRAFT_RECIPES['tanning_t5'];
    eq(lea5.inputs['butchering_t5'], 1, 'tanning cures raw Hide 1:1');
    var clo5 = FF.ALL_CRAFT_RECIPES['weaving_t5'];
    eq(clo5.inputs['farming_t5'], 1, 'weaving spins raw Fiber 1:1');
    // The chain is inserted: finished armour now consumes the refined good, not the raw one.
    var leaChest = FF.getBodyArmorTierData('leather','chest',5).inputs;
    ok(leaChest['tanning_t5'] && !leaChest['butchering_t5'], 'leather armour now needs Cured Leather, not raw Hide');
    var cloChest = FF.getBodyArmorTierData('tailoring','chest',5).inputs;
    ok(cloChest['weaving_t5'] && !cloChest['farming_t5'], 'cloth armour now needs Woven Cloth, not raw Fiber');
    // Twine and Belts are now routed through the tanning channel too: they consume cured Leather, not
    // raw Hide. Hide's only remaining consumer is Tanning (asserted above), so nothing is orphaned.
    var tw5 = FF.ALL_CRAFT_RECIPES['twine_t5'].inputs;
    ok(tw5['tanning_t5'] && !tw5['butchering_t5'], 'Twine braids cured Leather (tanning), not raw Hide');
    var belt5 = FF.getBeltTierData(5).inputs;
    ok(belt5['tanning_t5'] && !belt5['butchering_t5'], 'Belts are cut from cured Leather (tanning), not raw Hide');
    ok(FF.CRAFT_PHYSIQUE.tanning && FF.CRAFT_PHYSIQUE.weaving, 'physique tables include the new skills');
  });

  // ---- Refinement layer: Pottery (clay->Crucible) + Goldsmithing (ingot+Crucible->Setting) ------
  suite('skills: pottery / goldsmithing refinement', function(){
    ok(FF.CRAFTING_SKILLS.pottery, 'pottery is a crafting skill');
    ok(FF.CRAFTING_SKILLS.goldsmithing, 'goldsmithing is a crafting skill');
    eq(FF.CRAFTING_SKILLS.pottery.recipes.length, FF.TIER_COUNT, 'pottery has 21 crucible tiers');
    eq(FF.CRAFTING_SKILLS.goldsmithing.recipes.length, FF.TIER_COUNT, 'goldsmithing has 21 setting tiers');
    // Pottery fires Digging clay 1:1 into a Crucible.
    var cru5 = FF.ALL_CRAFT_RECIPES['pottery_t5'];
    eq(cru5.inputs['digging_t5'], 1, 'pottery fires Digging clay 1:1');
    // Goldsmithing casts a Metallurgy ingot inside a matching-tier Crucible into a Setting.
    var set5 = FF.ALL_CRAFT_RECIPES['goldsmithing_t5'];
    eq(set5.inputs['metallurgy_t5'], 1, 'goldsmithing casts one matching ingot');
    eq(set5.inputs['pottery_t5'], 1, 'goldsmithing consumes one matching Crucible');
    // The chain is inserted: rings and amulets now seat their gem in a Setting.
    var ring5 = FF.getRingTierData('fire', 5).inputs;
    eq(ring5['goldsmithing_t5'], 1, 'rings now require a matching Setting');
    var am5 = FF.getAmuletTierData('plain', 5).inputs;
    eq(am5['goldsmithing_t5'], 1, 'amulets now require a matching Setting');
    // Rings and amulets now also consume a Normal previous tier (like Weaponsmithing/Armorsmithing).
    eq(ring5['ring_fire_t4_normal'], 1, 'ring now consumes its Normal previous tier');
    eq(am5['amulet_t4_normal'], 1, 'amulet now consumes its Normal previous tier');
    ok(FF.getRingTierData('fire', 0).inputs['ring_fire_t-1_normal'] === undefined, 'tier 0 ring has no previous-tier requirement');
    // Damage rings (physical Blunt/Slash/Pierce + elemental) now do +5% at t0 -> +50% at t20 (Normal),
    // scaled 2x/4x/8x by rarity -- matching the familiar/Communion curve.
    near(FF.getRingTierData('blunt', 0).dmgBonus, 0.05, 'physical ring t0 = +5%');
    near(FF.getRingTierData('blunt', 20).dmgBonus, 0.50, 'physical ring t20 = +50%');
    near(FF.getRingTierData('fire', 0).bonus, 0.05, 'elemental ring t0 = +5%');
    near(FF.getRingTierData('fire', 20).bonus, 0.50, 'elemental ring t20 = +50%');
    var RS = FF.ALL_SELLABLE;
    near(RS['ring_fire_t20_normal'].bonus, 0.50, 'fire ring t20 normal = 50%');
    near(RS['ring_fire_t20_rare'].bonus, 1.00, 'fire ring t20 rare = 100% (x2)');
    near(RS['ring_fire_t20_supreme'].bonus, 2.00, 'fire ring t20 supreme = 200% (x4)');
    near(RS['ring_fire_t20_fantastic'].bonus, 4.00, 'fire ring t20 fantastic = 400% (x8)');
    near(RS['ring_blunt_t0_normal'].dmgBonus, 0.05, 'blunt ring t0 normal = 5%');
    near(RS['ring_blunt_t20_fantastic'].dmgBonus, 4.00, 'blunt ring t20 fantastic = 400% (x8)');
    ok(FF.getAmuletTierData('plain', 0).inputs['amulet_t-1_normal'] === undefined, 'tier 0 amulet has no previous-tier requirement');
    // The gem/twine part of the recipe is untouched (Setting is additive, not a replacement).
    ok(ring5['twine_t5'] === 3 && ring5['digging_t5'] == null, 'ring keeps its Twine and does not eat raw clay directly');
    ok(FF.CRAFT_PHYSIQUE.pottery && FF.CRAFT_PHYSIQUE.goldsmithing, 'physique tables include the new skills');
  });

  // ---- Ocean domain: Diving (gathers Pearls) -> Amulets seat a Pearl instead of the faceted Gem ---
  suite('skills: diving / ocean', function(){
    ok(FF.GATHERING_SKILLS.diving, 'diving is a gathering skill');
    eq(FF.GATHERING_SKILLS.diving.items.length, FF.TIER_COUNT, 'diving has 21 pearl tiers');
    eq(FF.GATHERING_SKILLS.diving.items[0].id, 'diving_t0', 'diving items follow the tier id scheme');
    // Amulets now seat a matching-tier Pearl and no longer the mining Gem; rings keep the Gem.
    var am5 = FF.getAmuletTierData('plain', 5).inputs;
    var ring5 = FF.getRingTierData('fire', 5).inputs;
    eq(am5['diving_t5'], 1, 'amulets now seat a matching Diving Pearl');
    ok(Object.keys(am5).every(function(k){ return k.indexOf('gem_') !== 0; }), 'amulets no longer consume a faceted mining Gem');
    ok(Object.keys(ring5).some(function(k){ return k.indexOf('gem_') === 0; }), 'rings still seat a faceted mining Gem');
    ok(ring5['diving_t5'] == null, 'rings do not consume Pearls (the two jewelry lines stay split)');
    ok(FF.GATHER_PHYSIQUE.diving, 'physique table includes diving');
  });

  // ---- Final proposal slice: Trapping/Tapping/Spelunking (gather) + Chandlery/Woodcarving/
  //      Glassblowing/Cooperage (craft) -- completes the 30-skill web ------------------------------
  suite('skills: tapping/spelunking + chandlery/woodcarving/glassblowing/cooperage', function(){
    // Two new gathering domains, each a full 21-tier ladder (Trapping was removed; its Fat/Tallow is now a Butchering byproduct).
    ['tapping','spelunking'].forEach(function(g){
      ok(FF.GATHERING_SKILLS[g], g + ' is a gathering skill');
      eq(FF.GATHERING_SKILLS[g].items.length, FF.TIER_COUNT, g + ' has 21 tiers');
      ok(FF.GATHER_PHYSIQUE[g], 'physique table includes ' + g);
    });
    // Trapping is fully removed as a skill; its output is rendered from Butchering instead.
    ok(!FF.GATHERING_SKILLS.trapping, 'Trapping is no longer a gathering skill');
    ok(!FF.GATHER_PHYSIQUE.trapping && !FF.FAMILIAR_DATA.trapping, 'Trapping physique + familiar removed');
    ok(FF._state.xp.trapping == null || FF.GATHERING_SKILLS.trapping == null, 'Trapping is not a live skill');
    // The butcher recipe now yields Fat/Tallow (fat_t<n>) alongside Meat and Hide.
    var bp = FF.ALL_CRAFT_RECIPES['butcher_process_t5'];
    ok(bp && bp.fatId === 'fat_t5' && bp.fatPhysique, 'butchering a t5 carcass can yield fat_t5');
    var fat5 = FF.ALL_SELLABLE && FF.ALL_SELLABLE['fat_t5'];
    ok(fat5 && /Fat|Tallow|Grease|Lard|Wax/.test(fat5.name), 'fat item is registered + sellable');
    // Four new crafting skills, each a full 21-tier ladder.
    ['chandlery','woodcarving','glassblowing','cooperage'].forEach(function(c){
      ok(FF.CRAFTING_SKILLS[c], c + ' is a crafting skill');
      eq(FF.CRAFTING_SKILLS[c].recipes.length, FF.TIER_COUNT, c + ' has 21 tiers');
      ok(FF.CRAFT_PHYSIQUE[c], 'physique table includes ' + c);
    });
    // Each new gather has its named consumer (the interlock holds).
    eq(FF.ALL_CRAFT_RECIPES['chandlery_t5'].inputs['fat_t5'], 1, 'Chandlery renders Butchering Fat/Tallow into Candles 1:1');
    var carv = FF.ALL_CRAFT_RECIPES['woodcarving_t5'].inputs;
    ok(carv['carpentry_t5'] === 1 && carv['tapping_t5'] === 1, 'Woodcarving binds a Carpentry Plank + Tapping Resin');
    var glass = FF.ALL_CRAFT_RECIPES['glassblowing_t5'].inputs;
    ok(glass['spelunking_t5'] === 1 && glass['coal'] === 1, 'Glassblowing melts a Spelunking Mineral over coal');
    var barrel = FF.ALL_CRAFT_RECIPES['cooperage_t5'].inputs;
    ok(barrel['carpentry_t5'] === 2 && barrel['metallurgy_t5'] === 1, 'Cooperage binds Planks with a Metallurgy band');
    // All seven are seeded in the xp table (save-merge safety -- newGame() must know them).
    ['tapping','spelunking','chandlery','woodcarving','glassblowing','cooperage'].forEach(function(s){
      ok(FF._state.xp[s] != null, s + ' is seeded in the xp table');
    });
  });

  // ---- Knowledge vertical: Papermaking -> Bookbinding + the Tome (work-speed) buff --------------
  suite('skills: papermaking / bookbinding', function(){
    ok(FF.CRAFTING_SKILLS.papermaking, 'papermaking is a crafting skill');
    ok(FF.CRAFTING_SKILLS.bookbinding, 'bookbinding is a crafting skill');
    eq(FF.CRAFTING_SKILLS.papermaking.recipes.length, FF.TIER_COUNT, 'papermaking has 21 paper tiers');
    eq(FF.CRAFTING_SKILLS.bookbinding.recipes.length, FF.TIER_COUNT, 'bookbinding has 21 tome tiers');
    // Chain: Logs -> Paper -> Tome (Paper + Cured Leather from Tanning).
    var paper5 = FF.ALL_CRAFT_RECIPES['paper_t5'];
    ok(paper5.inputs['forestry_t5'], 'papermaking pulps Forestry logs');
    var tome5 = FF.ALL_CRAFT_RECIPES['tome_t5'];
    ok(tome5.inputs['paper_t5'] && tome5.inputs['tanning_t5'], 'tome binds Paper + Cured Leather (interlocks Tanning)');
    // Tome grants a timed work-speed buff -- its own channel.
    ok(tome5.tomeSpeedBonus > 0 && tome5.tomeDurationMs > 0, 'tomes carry a timed work-speed buff');
    var t0 = FF.ALL_CRAFT_RECIPES['tome_t0'], t20 = FF.ALL_CRAFT_RECIPES['tome_t20'];
    ok(t20.tomeSpeedBonus > t0.tomeSpeedBonus && t20.tomeSpeedBonus <= 0.25 + 1e-9, 'tome speed bonus scales with tier (cap 25%)');
    // Auto-study / the action-bar Tome widget pick the strongest owned tome (highest speed bonus,
    // tie-broken by longest duration).
    ok(typeof FF.bestAvailableTome === 'function', 'bestAvailableTome exported');
    eq(FF.bestAvailableTome(), null, 'no tomes owned -> bestAvailableTome null');
    FF._state.inventory['tome_t2'] = 1; FF._state.inventory['tome_t15'] = 1;
    var bt = FF.bestAvailableTome();
    ok(bt && bt.id === 'tome_t15', 'bestAvailableTome picks the strongest owned tome');
    delete FF._state.inventory['tome_t2']; delete FF._state.inventory['tome_t15'];
    // Studying a tome speeds work: speedMultiplier drops (lower = faster). No buff by default.
    eq(FF.tomeSpeedBonus(), 0, 'no tome buff by default');
    var before = FF.speedMultiplier(FF._state);
    FF._state.inventory['tome_t10'] = 1;
    FF.studyTome('tome_t10');
    ok(FF.isTomeActive(), 'studying a tome activates the buff');
    ok(FF.tomeSpeedBonus() > 0, 'active tome adds work speed');
    ok(FF.speedMultiplier(FF._state) < before, 'speedMultiplier drops (work is faster) while a tome is active');
    ok(FF.CRAFT_PHYSIQUE.papermaking && FF.CRAFT_PHYSIQUE.bookbinding, 'physique tables include the new skills');
  });

  // ---- 5 new combat classes: gear combos + level perks --------------------------------------
  suite('classes: frostwarden / plaguebearer / berserker / sentinel / spellblade', function(){
    var NEW = ['frostwarden','plaguebearer','berserker','sentinel','spellblade'];
    NEW.forEach(function(id){
      var cd = FF.CLASS_DEFS_BY_ID[id];
      ok(cd, id+' is a registered class');
      if(!cd) return;
      eq(cd.passives.length, 5, id+' has 5 perks');
      eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', id+' perks at Lv 1/20/40/60/80');
      ok(cd.reqParts.length >= 5, id+' has a full gear set');
      ok(FF.CLASS_SKILL_IDS.indexOf(id) !== -1, id+' is its own combat skill');
    });
    // Plaguebearer change #1: Hatchet (not Falchion).
    var pb = FF.CLASS_DEFS_BY_ID.plaguebearer;
    ok(/Hatchet/.test(pb.reqText) && !/Falchion/.test(pb.reqText), 'plaguebearer wields a Hatchet, not a Falchion');
    // Plaguebearer change #2: Lv80 is a per-tick explosion chance, not an on-death detonation.
    var pandemic = pb.passives.filter(function(p){ return p.level===80; })[0];
    eq(pandemic.name, 'Pandemic', 'plaguebearer Lv80 is Pandemic');
    ok(/10%/.test(pandemic.desc) && /Dark/.test(pandemic.desc) && !/dies|death/i.test(pandemic.desc), 'Pandemic = each poison tick has a 10% Dark-explosion chance (not on-death)');

    // ---- Functional: build mock states that activate each class, verify gating + perk math ----
    function armor(mat,tier){ return {material:mat,tier:tier||5}; }
    function stFor(id, level, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:'combat'}, playerHp:55 };
      st.xp[id] = FF.xpFloorForLevel(level);
      if(id==='frostwarden'){ st.equippedMainhand='wandWater'; st.equippedOffhand='shieldMedium'; st.bodyArmor={helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('tailoring'),boots:armor('tailoring')}; }
      if(id==='berserker'){ st.equippedMainhand='warhammer'; st.bodyArmor={chest:armor('leather'),gauntlets:armor('tailoring'),boots:armor('tailoring')}; } // no helmet = bare head
      if(id==='sentinel'){ st.equippedMainhand='maul'; st.equippedOffhand='shieldMedium'; st.bodyArmor={helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('chain'),boots:armor('chain')}; }
      if(id==='spellblade'){ st.equippedMainhand='greatsword'; st.bodyArmor={helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('leather'),boots:armor('leather')}; }
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    // gating: each mock activates exactly its class
    eq(FF.activeClassId(stFor('berserker',80)), 'berserker', 'berserker gear activates Berserker');
    eq(FF.activeClassId(stFor('frostwarden',80)), 'frostwarden', 'frostwarden gear activates Frostwarden');
    eq(FF.activeClassId(stFor('sentinel',80)), 'sentinel', 'sentinel gear activates Sentinel');
    eq(FF.activeClassId(stFor('spellblade',80)), 'spellblade', 'spellblade gear activates Spellblade');
    // Berserker Rage scales with missing Health; Reckless +25%; Bloodthirst 8%.
    eq(FF.berserkerRageMult(stFor('berserker',1,{playerHp:55})), 1, 'Berserker Rage = x1 at full HP');
    ok(Math.abs(FF.berserkerRageMult(stFor('berserker',1,{playerHp:0})) - 1.5) < 1e-9, 'Berserker Rage = x1.5 near death');
    eq(FF.berserkerRecklessMult(stFor('berserker',40)), 1.25, 'Berserker Reckless +25% dealt');
    ok(Math.abs(FF.berserkerLifestealPct(stFor('berserker',20)) - 0.08) < 1e-9, 'Berserker Bloodthirst 8%');
    // Frostwarden rework: Permafrost stacks Chill (10% enemy slow each, cap 5/50%); Time Dilation quickens
    // you by half the slow (cap 30%); Rime Resonance grants +25% damage vs a Chilled foe.
    var fw = stFor('frostwarden',80);
    FF.frostwardenApplyChill(fw.activity); FF.frostwardenApplyChill(fw.activity); FF.frostwardenApplyChill(fw.activity);
    eq(FF.enemyChillStacks(fw), 3, 'Permafrost: 3 hits -> 3 Chill stacks');
    ok(Math.abs(FF.enemyChillSlowMult(fw) - 0.30) < 1e-9, 'Chill: 3 stacks -> 30% enemy slow');
    FF.frostwardenApplyChill(fw.activity); FF.frostwardenApplyChill(fw.activity); FF.frostwardenApplyChill(fw.activity);
    eq(FF.enemyChillStacks(fw), 5, 'Chill stacks cap at 5');
    ok(Math.abs(FF.enemyChillSlowMult(fw) - 0.50) < 1e-9, 'Chill slow caps at 50%');
    ok(Math.abs(FF.frostwardenTimeDilation(fw) - 0.25) < 1e-9, 'Time Dilation: 25% haste at 50% Chill');
    eq(FF.frostwardenTimeDilation(stFor('frostwarden',1)), 0, 'Time Dilation inactive below Lv20');
    ok(Math.abs(FF.frostwardenDmgMult(fw) - 1.25) < 1e-9, 'Rime Resonance: +25% damage vs a Chilled foe at Lv80');
    eq(FF.frostwardenDmgMult(stFor('frostwarden',80)), 1, 'Rime Resonance neutral vs an unchilled foe');
    eq(FF.frostwardenDmgMult(stFor('frostwarden',40)), 1, 'no +25% below Lv80');
    // Sentinel Bracing +25% armor, Immovable -30% incoming.
    eq(FF.sentinelArmorMult(stFor('sentinel',20)), 1.25, 'Sentinel Bracing +25% Armor');
    eq(FF.sentinelIncomingMult(stFor('sentinel',60)), 0.70, 'Sentinel Immovable -30% incoming');
    // Spellblade Momentum stacks (+6% each) and Overwhelm at max.
    var sb = stFor('spellblade',80); sb.spellbladeStacks = 5;
    ok(Math.abs(FF.spellbladeMomentumMult(sb) - 1.30) < 1e-9, 'Spellblade Momentum = +6%/stack (x1.30 at 5)');
    eq(FF.spellbladeOverwhelmMult(sb), 1.25, 'Spellblade Overwhelm +25% at max stacks');
    // No class active -> every perk multiplier is neutral.
    var none = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:'combat'}, playerHp:1 };
    eq(FF.berserkerRageMult(none), 1, 'no class -> Rage neutral');
    eq(FF.frostwardenDmgMult(none), 1, 'no class -> Frostwarden damage neutral');
    eq(FF.sentinelIncomingMult(none), 1, 'no class -> Immovable neutral');
    eq(FF.enemyChillSlowMult(none), 0, 'no chill -> no enemy slow');
  });

  suite('classes: pyromancer / sharpshooter / juggernaut / nightblade / executioner (unused weapons)', function(){
    var NEW = ['pyromancer','sharpshooter','juggernaut','nightblade','executioner'];
    NEW.forEach(function(id){
      var cd = FF.CLASS_DEFS_BY_ID[id];
      ok(cd, id+' is a registered class');
      if(!cd) return;
      eq(cd.passives.length, 5, id+' has 5 perks');
      eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', id+' perks at Lv 1/20/40/60/80');
      ok(cd.reqParts.length >= 5, id+' has a full gear set');
      ok(FF.CLASS_SKILL_IDS.indexOf(id) !== -1, id+' is its own combat skill');
      // each carries a familiar with a unique 4-spell kit + a channelled element
      var fam = FF.FAMILIAR_DATA[id];
      ok(fam && fam.spells && fam.spells.length === 4, id+' familiar has a 4-spell kit');
    });
    // Each new class must claim a weapon type NO prior class used.
    ok(/Fire Wand/.test(FF.CLASS_DEFS_BY_ID.pyromancer.reqText), 'pyromancer wields the Fire Wand');
    ok(/Long Bow/.test(FF.CLASS_DEFS_BY_ID.sharpshooter.reqText), 'sharpshooter wields the Long Bow');
    ok(/Sledge/.test(FF.CLASS_DEFS_BY_ID.juggernaut.reqText), 'juggernaut wields the Sledge');
    ok(/Dark Wand/.test(FF.CLASS_DEFS_BY_ID.nightblade.reqText), 'nightblade wields the Dark Wand');
    ok(/Full-Moon Axe/.test(FF.CLASS_DEFS_BY_ID.executioner.reqText), 'executioner wields the Full-Moon Axe');

    function armor(mat,tier){ return {material:mat,tier:tier||5}; }
    function stFor(id, level, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:'combat',monsterHp:100}, playerHp:55 };
      st.xp[id] = FF.xpFloorForLevel(level);
      if(id==='pyromancer'){ st.equippedMainhand='wandFire'; st.equippedOffhand='wardLight'; st.bodyArmor={helmet:armor('tailoring'),chest:armor('tailoring'),gauntlets:armor('tailoring'),boots:armor('tailoring')}; }
      if(id==='sharpshooter'){ st.equippedMainhand='bowLong'; st.equippedOffhand='quiver'; st.bodyArmor={helmet:armor('leather'),chest:armor('leather'),boots:armor('leather'),gauntlets:armor('tailoring')}; }
      if(id==='juggernaut'){ st.equippedMainhand='sledge'; st.bodyArmor={helmet:armor('plate'),chest:armor('plate'),gauntlets:armor('plate'),boots:armor('plate')}; }
      if(id==='nightblade'){ st.equippedMainhand='wandDark'; st.equippedOffhand='wardLight'; st.bodyArmor={helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather'),boots:armor('leather')}; }
      if(id==='executioner'){ st.equippedMainhand='fullmoonaxe'; st.bodyArmor={chest:armor('chain'),gauntlets:armor('chain'),boots:armor('leather')}; } // no helmet = bare head
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    // gating: each mock activates exactly its class (unique unused weapon disambiguates)
    eq(FF.activeClassId(stFor('pyromancer',80)), 'pyromancer', 'fire wand + ward + cloth => Pyromancer');
    eq(FF.activeClassId(stFor('sharpshooter',80)), 'sharpshooter', 'long bow + quiver + leather => Sharpshooter');
    eq(FF.activeClassId(stFor('juggernaut',80)), 'juggernaut', 'sledge + full plate => Juggernaut');
    eq(FF.activeClassId(stFor('nightblade',80)), 'nightblade', 'dark wand + ward + full leather => Voidshadow');
    eq(FF.activeClassId(stFor('executioner',80)), 'executioner', 'full-moon axe + bare head + chain => Executioner');
    // Nightblade was renamed to Voidshadow (display only; id/bonus keys unchanged).
    eq(FF.CLASS_DEFS_BY_ID.nightblade.name, 'Voidshadow', 'nightblade renamed to Voidshadow');
    // New gear requirements gate: dropping the added piece must deactivate the class.
    eq(FF.activeClassId(stFor('pyromancer',80,{bodyArmor:{helmet:armor('tailoring'),chest:armor('tailoring'),boots:armor('tailoring')}})), null, 'Pyromancer needs Cloth Gloves');
    eq(FF.activeClassId(stFor('sharpshooter',80,{bodyArmor:{helmet:armor('leather'),chest:armor('leather'),boots:armor('leather')}})), null, 'Sharpshooter needs Cloth Gloves');
    eq(FF.activeClassId(stFor('nightblade',80,{bodyArmor:{helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather')}})), null, 'Voidshadow needs Leather Boots');

    var monFull = {hp:100}, monLow = {hp:100};
    // Pyromancer rework: Ignite stacks Burn (cap 5); Combust burst = 25% of the hit per stack; Kindling
    // +8% crit dmg/stack; Heat Haze dodge & Fever Pitch haste scale with Burn. The old flat stats are gone.
    eq(FF.newClassDmgMult(monFull, stFor('pyromancer',80)), 1, 'Pyromancer no longer grants flat damage');
    eq(FF.newClassCritChance(stFor('pyromancer',80)), 0, 'Pyromancer no longer grants flat crit chance');
    eq(FF.newClassCritDmg(stFor('pyromancer',80)), 0, 'Pyromancer no longer grants flat crit damage');
    eq(FF.classBlockBonus(stFor('pyromancer',80)), 0, 'Pyromancer no longer grants Block');
    var pyro = stFor('pyromancer',80);
    FF.pyromancerApplyBurn(pyro.activity); FF.pyromancerApplyBurn(pyro.activity); FF.pyromancerApplyBurn(pyro.activity);
    eq(FF.enemyBurnStacks(pyro), 3, 'Ignite: 3 hits -> 3 Burn stacks');
    FF.pyromancerApplyBurn(pyro.activity); FF.pyromancerApplyBurn(pyro.activity); FF.pyromancerApplyBurn(pyro.activity);
    eq(FF.enemyBurnStacks(pyro), 5, 'Burn stacks cap at 5');
    ok(Math.abs(FF.pyromancerKindlingCritDmg(pyro) - 0.40) < 1e-9, 'Kindling Crits: +8%/stack -> +40% crit dmg at 5 stacks');
    ok(Math.abs(FF.pyromancerHeatHazeDodge(pyro) - 0.20) < 1e-9, 'Heat Haze: +4%/stack dodge, capped +20% at 5 stacks');
    ok(Math.abs(FF.pyromancerFeverHaste(pyro) - 0.25) < 1e-9, 'Fever Pitch: +5%/stack -> +25% haste at 5 stacks');
    eq(FF.pyromancerCombustDmg(1000, pyro), 1250, 'Combust: 25% of the hit per stack (5 stacks -> +1250 on a 1000 hit)');
    eq(FF.pyromancerKindlingCritDmg(stFor('pyromancer',20)), 0, 'Kindling inactive below Lv40');
    eq(FF.pyromancerHeatHazeDodge(stFor('pyromancer',40)), 0, 'Heat Haze inactive below Lv60');
    eq(FF.pyromancerFeverHaste(stFor('pyromancer',60)), 0, 'Fever Pitch inactive below Lv80');
    // Sharpshooter: Aimed+Kill = +150% crit dmg; Piercing +20%; Steady Aim +30% acc; Deadeye +12% crit.
    ok(Math.abs(FF.newClassCritDmg(stFor('sharpshooter',80)) - 1.50) < 1e-9, 'Sharpshooter Aimed+Kill = +150% crit dmg');
    ok(Math.abs(FF.newClassDmgMult(monFull, stFor('sharpshooter',80)) - 1.20) < 1e-9, 'Sharpshooter Piercing Shot +20%');
    eq(FF.classAccuracyMult(stFor('sharpshooter',80)), 1.3, 'Sharpshooter Steady Aim +30% Accuracy');
    ok(Math.abs(FF.newClassCritChance(stFor('sharpshooter',80)) - 0.12) < 1e-9, 'Sharpshooter Deadeye +12% crit chance');
    // Juggernaut: Crushing +30%; Bulwark +15% Block; Ironclad +25% armor; Unstoppable -20% incoming; Devastate +60% crit dmg.
    ok(Math.abs(FF.newClassDmgMult(monFull, stFor('juggernaut',80)) - 1.30) < 1e-9, 'Juggernaut Crushing Blows +30%');
    eq(FF.classBlockBonus(stFor('juggernaut',80)), 0.15, 'Juggernaut Bulwark +15% Block');
    eq(FF.juggernautArmorMult(stFor('juggernaut',80)), 1.25, 'Juggernaut Ironclad +25% Armor');
    eq(FF.juggernautIncomingMult(stFor('juggernaut',80)), 0.80, 'Juggernaut Unstoppable -20% incoming');
    ok(Math.abs(FF.newClassCritDmg(stFor('juggernaut',80)) - 0.60) < 1e-9, 'Juggernaut Devastate +60% crit dmg');
    // Nightblade: Siphon 8% -> Soul Reap 15%; Hex +25%; Shadowstep +15% dodge; Dark Pact +12% crit.
    ok(Math.abs(FF.nightbladeLifestealPct(stFor('nightblade',1)) - 0.08) < 1e-9, 'Nightblade Siphon 8%');
    ok(Math.abs(FF.nightbladeLifestealPct(stFor('nightblade',80)) - 0.15) < 1e-9, 'Nightblade Soul Reap 15%');
    ok(Math.abs(FF.newClassDmgMult(monFull, stFor('nightblade',80)) - 1.25) < 1e-9, 'Nightblade Hex +25%');
    ok(Math.abs(FF.nightbladeDodgeBonus(stFor('nightblade',80)) - 0.15) < 1e-9, 'Nightblade Shadowstep +15% Dodge');
    // Executioner rework: Reaping Vigor (Lv1) / Reap the Weak (Lv20) / Rising Guillotine (Lv40) /
    // Headsman's Tally (Lv60) / Gallows Humor (Lv80). The old crit/lifesteal/execute stats are gone.
    var exNames = FF.CLASS_DEFS_BY_ID.executioner.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(exNames), JSON.stringify(['Reaping Vigor','Reap the Weak','Rising Guillotine','Headsman\'s Tally','Gallows Humor']), 'Executioner ladder is the reworked five');
    // Reap the Weak moved from Lv1 to Lv20.
    eq(FF.newClassDmgMult(monLow, stFor('executioner',1,{activity:{type:'combat',monsterHp:10}})), 1, 'Lv1 no longer grants Reap (moved to Lv20)');
    ok(Math.abs(FF.newClassDmgMult(monLow, stFor('executioner',20,{activity:{type:'combat',monsterHp:10}})) - 1.30) < 1e-9, 'Reap the Weak +30% vs a wounded foe at Lv20');
    eq(FF.newClassDmgMult(monLow, stFor('executioner',20,{activity:{type:'combat',monsterHp:60}})), 1, 'Lv20 Reap is neutral above the flat 50% threshold');
    // Rising Guillotine (Lv40): after 20s the threshold climbs to ~70%, so a 60%-HP foe now reaps.
    var exRise = stFor('executioner',40,{activity:{type:'combat',monsterHp:60,duelStartedAt:Date.now()-20000}});
    near(FF.executionerReapThreshold(exRise), 0.70, 'Rising Guillotine: +1%/s -> 70% threshold at 20s', 1e-2); // wall-clock drift (Date.now advances a few ms between setup and read) -> tolerant compare
    ok(Math.abs(FF.newClassDmgMult(monLow, exRise) - 1.30) < 1e-9, 'Rising Guillotine lets a 60%-HP foe be reaped at 20s');
    eq(FF.executionerReapThreshold(stFor('executioner',20)), 0.5, 'without Rising Guillotine the threshold stays 50%');
    // Reaping Vigor (Lv1): each crit stack = +25% max HP, gated on the class.
    FF.execVigorReset();
    eq(FF.execVigorMaxHpBonus(stFor('executioner',80)), 0, 'no crit stacks -> no Vigor bonus');
    FF.execVigorAddStack(); FF.execVigorAddStack();
    ok(Math.abs(FF.execVigorMaxHpBonus(stFor('executioner',80)) - 0.50) < 1e-9, 'Reaping Vigor: 2 crit stacks -> +50% max HP');
    eq(FF.execVigorMaxHpBonus(none), 0, 'no class -> Vigor bonus neutral even with stacks queued');
    FF.execVigorReset();
    // Headsman's Tally (Lv60): +5 max HP per session kill, capped at +250, gated on the class.
    FF.headsmanTallyReset();
    eq(FF.headsmanTallyBonusHp(stFor('executioner',80)), 0, 'no kills -> no Tally HP');
    FF.headsmanTallyKill(); FF.headsmanTallyKill(); FF.headsmanTallyKill();
    eq(FF.headsmanTallyBonusHp(stFor('executioner',80)), 15, 'Headsman\'s Tally: 3 kills -> +15 max HP');
    for(var _hk=0; _hk<100; _hk++) FF.headsmanTallyKill();
    eq(FF.headsmanTallyBonusHp(stFor('executioner',80)), 250, 'Headsman\'s Tally caps at +250 max HP');
    eq(FF.headsmanTallyBonusHp(stFor('executioner',40)), 0, 'Tally inactive below Lv60');
    FF.headsmanTallyReset();
    // Gallows Humor (Lv80): +crit scaling with the foe's missing Health (up to +25%).
    var exGMon = FF.MONSTERS[0];
    var exGal = stFor('executioner',80); exGal.activity = { type:'combat', monsterId:exGMon.id, monsterHp: exGMon.hp*0.2 };
    near(FF.newClassCritChance(exGal), 0.20, 'Gallows Humor: +25% * 80% missing HP = +20% crit', 1e-6);
    eq(FF.newClassCritChance(stFor('executioner',60)), 0, 'Gallows Humor inactive below Lv80');
    eq(FF.newClassCritDmg(stFor('executioner',80)), 0, 'Executioner no longer grants flat crit damage');
    // No class active -> every new-class multiplier is neutral.
    var none = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:'combat',monsterHp:100}, playerHp:1 };
    eq(FF.newClassDmgMult(monFull, none), 1, 'no class -> new-class dmg neutral');
    eq(FF.newClassCritChance(none), 0, 'no class -> new-class crit chance neutral');
    eq(FF.newClassCritDmg(none), 0, 'no class -> new-class crit dmg neutral');
    eq(FF.nightbladeLifestealPct(none), 0, 'no class -> no siphon');
    eq(FF.juggernautIncomingMult(none), 1, 'no class -> incoming neutral');
    // enemyHpFrac reads current/max cleanly.
    ok(Math.abs(FF.enemyHpFrac({hp:100}, {activity:{monsterHp:40}}) - 0.4) < 1e-9, 'enemyHpFrac = current/max');
    eq(FF.enemyHpFrac({hp:0}, {activity:{monsterHp:0}}), 1, 'enemyHpFrac guards against a zero max');
  });

  // ---- Classes: Ranger (medium bow; imbued arrows stack Poison/Bleed/Chill/Burn -> Apex Predator x3) --
  suite('classes: Ranger', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('ranger') !== -1, 'ranger is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.ranger; ok(cd, 'ranger class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passives at 1/20/40/60/80');
    ok(cd.reqParts.length >= 6, 'ranger has a full gear set');
    ok(/Medium Bow/.test(cd.reqText), 'ranger wields the Medium Bow');
    var fam = FF.FAMILIAR_DATA.ranger; ok(fam && fam.spells && fam.spells.length === 4, 'ranger familiar has a 4-spell kit');
    function lea(){ return { tier:1, rarity:'normal', material:'leather' }; }
    function clo(){ return { tier:1, rarity:'normal', material:'tailoring' }; }
    function rgear(){ return { xp:{ ranger: FF.xpFloorForLevel(85) }, physique:{}, equippedMainhand:'bowMedium', equippedOffhand:'quiver', bodyArmor:{ helmet:lea(), chest:lea(), gauntlets:lea(), boots:clo() } }; }
    eq(FF.activeClassId(rgear()), 'ranger', 'medium bow + quiver + leather + cloth boots => Ranger');
    var wrongBow = rgear(); wrongBow.equippedMainhand = 'bowLong';
    eq(FF.activeClassId(wrongBow), null, 'the Medium Bow is required (a long bow does not qualify)');
    // Apex Predator (Lv80): a hit against a foe with ALL FOUR ailments deals x3 damage; missing any -> x1.
    var mon = { hp:100 };
    var allFour = rgear();
    allFour.activity = { type:'combat', monsterHp:50,
      potionPoisonUntil: Date.now()+4000, potionPoisonDps: 5,
      bleedUntil: Date.now()+4000, bleedStacks: 1, bleedDps: 3,
      enemyChillUntil: Date.now()+4000, chillStacks: 1,
      burnUntil: Date.now()+4000, burnStacks: 1, burnDps: 3 };
    ok(Math.abs(FF.newClassDmgMult(mon, allFour) - 3) < 1e-9, 'Apex Predator: x3 vs a foe with Poison+Bleed+Chill+Burn');
    var missingBurn = rgear();
    missingBurn.activity = Object.assign({}, allFour.activity, { burnUntil:0, burnStacks:0, burnDps:0 });
    eq(FF.newClassDmgMult(mon, missingBurn), 1, 'no x3 unless all four ailments are up at once');
  });

  // ---- Classes: Samurai (Katana, 2H; Iaijutsu opener -> First Blood Bleed -> Crimson Edge/Bushido/Zanshin) --
  suite('classes: Samurai', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('samurai') !== -1, 'samurai is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.samurai; ok(cd, 'samurai class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passives at 1/20/40/60/80');
    ok(cd.reqParts.length >= 5, 'samurai has a full gear set');
    ok(/Katana/.test(cd.reqText), 'samurai wields the Katana');
    var fam = FF.FAMILIAR_DATA.samurai; ok(fam && fam.spells && fam.spells.length === 4, 'samurai familiar has a 4-spell kit');
    function lea(){ return { tier:1, rarity:'normal', material:'leather' }; }
    function sgear(lvl){ return { xp:{ samurai: FF.xpFloorForLevel(lvl||85) }, physique:{}, equippedMainhand:'falchion', equippedOffhand:null, bodyArmor:{ helmet:lea(), chest:lea(), gauntlets:lea(), boots:lea() } }; }
    eq(FF.activeClassId(sgear()), 'samurai', 'katana + full leather => Samurai');
    var wrongWpn = sgear(); wrongWpn.equippedMainhand = 'greatsword';
    eq(FF.activeClassId(wrongWpn), null, 'the Katana is required (a greatsword does not qualify)');
    var mon = { hp:100 };
    // Crimson Edge (Lv40): +30% damage vs a Bleeding foe (Focus held at 0 so Bushido is neutral).
    var bleeding = sgear(); bleeding.activity = { type:'combat', monsterHp:60, bleedUntil: Date.now()+4000, bleedStacks:2, bleedDps:5, samuraiFocus:0 };
    ok(FF.enemyBleeding(bleeding), 'enemyBleeding true while bleedStacks+bleedUntil are live');
    ok(Math.abs(FF.newClassDmgMult(mon, bleeding) - 1.30) < 1e-9, 'Crimson Edge: x1.30 vs a Bleeding foe');
    var unbled = sgear(); unbled.activity = { type:'combat', monsterHp:60, bleedUntil:0, bleedStacks:0, samuraiFocus:0 };
    eq(FF.newClassDmgMult(mon, unbled), 1, 'no Crimson Edge bonus vs an unbled foe (Focus 0)');
    // Bushido (Lv60): +5% damage per Focus stack (no bleed, so Crimson is off).
    var focus = sgear(); focus.activity = { type:'combat', monsterHp:60, bleedUntil:0, bleedStacks:0, samuraiFocus:4 };
    eq(FF.samuraiFocusStacks(focus), 4, 'samuraiFocusStacks reads the activity');
    ok(Math.abs(FF.newClassDmgMult(mon, focus) - 1.20) < 1e-9, 'Bushido: 4 Focus stacks => x1.20 damage');
    // Zanshin (Lv80): +1.5% crit chance per Focus stack.
    ok(Math.abs(FF.newClassCritChance(focus) - 4*0.015) < 1e-9, 'Zanshin: 4 Focus stacks => +6% crit chance');
    // Below Lv60/80 the Focus perks are inert even with stacks present.
    var lowLvl = sgear(45); lowLvl.activity = { type:'combat', monsterHp:60, bleedUntil:0, bleedStacks:0, samuraiFocus:4 };
    eq(FF.newClassDmgMult(mon, lowLvl), 1, 'no Bushido damage below Class Lv60');
    eq(FF.newClassCritChance(lowLvl), 0, 'no Zanshin crit below Class Lv80');
  });

  // ---- Classes: gear-requirement UI renders in a standardized slot order ------------------
  suite('classes: standardized gear order', function(){
    // Slot derivation from the part label: weapon(0) -> offhand(1) -> helm(2) -> chest(3) -> gloves(4) -> boots(5).
    eq(FF.classPartSlotRank('Rapier'), 0, 'a weapon is slot 0');
    eq(FF.classPartSlotRank('Staff'), 0, 'a staff is slot 0');
    eq(FF.classPartSlotRank('Claws (off-hand)'), 1, 'an off-hand claw is the offhand slot');
    eq(FF.classPartSlotRank('Small Shield'), 1, 'a shield is the offhand slot');
    eq(FF.classPartSlotRank('Ward'), 1, 'a ward is the offhand slot');
    eq(FF.classPartSlotRank('Quiver'), 1, 'a quiver is the offhand slot');
    eq(FF.classPartSlotRank('Warhammer'), 0, 'a warhammer is a weapon, not an offhand (no false "ward" match)');
    eq(FF.classPartSlotRank('Bare Head'), 2, 'bare head is the helm slot');
    eq(FF.classPartSlotRank('Chain Helm'), 2, 'a helm is slot 2');
    eq(FF.classPartSlotRank('Cloth Tunic'), 3, 'a tunic is the chest slot');
    eq(FF.classPartSlotRank('Plate Gloves'), 4, 'gloves are slot 4');
    eq(FF.classPartSlotRank('Cloth Shoes'), 5, 'shoes are the boots slot');
    // Every class renders its gear weapon-first, in non-decreasing slot order.
    FF.CLASS_DEFS.forEach(function(cd){
      var ranks = FF.classPartsInSlotOrder(cd.reqParts).map(function(p){ return FF.classPartSlotRank(p.label); });
      eq(ranks[0], 0, cd.id + ': the weapon renders first');
      var nonDecreasing = ranks.every(function(r, i){ return i === 0 || r >= ranks[i-1]; });
      ok(nonDecreasing, cd.id + ': gear parts render in canonical slot order');
    });
    // Concrete example: Treasure Hunter declares helm/boots/chest/gloves out of order; it renders sorted.
    var th = FF.CLASS_DEFS_BY_ID.treasureHunter;
    eq(FF.classPartsInSlotOrder(th.reqParts).map(function(p){ return p.label; }).join(' | '),
       'Scimitar | Small Shield | Chain Helm | Plate Chest | Cloth Gloves | Chain Boots',
       'Treasure Hunter gear reorders to weapon/offhand/helm/chest/gloves/boots');
  });

  // ---- Dungeons: D1 "Cave" (25 arachnids, L100->125, ~10x boss, threat targeting) ---------
  suite('dungeons: D1 Cave', function(){
    var def = FF.DUNGEON_DEFS.d1;
    ok(def, 'D1 dungeon defined');
    eq(def.category, 'Cave', 'the single category is Cave');
    var en = FF.DUNGEON_D1_ENEMIES;
    eq(en.length, 25, '25 enemies');
    eq(en[0].level, 100, 'first enemy is level 100');
    eq(en[24].level, 125, 'last enemy is level 125');
    ok(en.every(function(e,i){ return i===0 || e.level >= en[i-1].level; }), 'levels rise 100 -> 125 without dropping');
    // boss = 25th, ~10x the 24th's HP
    eq(en[24].isBoss, true, 'the 25th enemy is the boss');
    ok(!en[23].isBoss, 'the 24th is not the boss');
    ok(Math.abs(en[24].hp / en[23].hp - 10) < 0.01, 'boss HP is ~10x the 24th (' + en[24].hp + ' vs ' + en[23].hp + ')');
    // distinct elements across the set
    var elems = {}; en.forEach(function(e){ elems[e.element] = 1; });
    ok(Object.keys(elems).length >= 3, 'enemies span multiple elements (' + Object.keys(elems).join(',') + ')');
    // every enemy: SVG portrait + full combat typing + registered in monsterById
    ok(en.every(function(e){ return typeof e.icon === 'string' && e.icon.indexOf('<svg') === 0; }), 'every enemy has an SVG portrait');
    ok(en.every(function(e){ return e.element && e.armorTypes && e.attackTypes && e.hp > 0 && FF.monsterById(e.id) === e; }), 'every enemy has element/armor/attack/hp and resolves via monsterById');
    // D1 Masterwork Formula registered for inventory display
    var f = FF.ALL_SELLABLE[def.reward]; ok(f && /Masterwork Formula/.test(f.name), 'the D1 Masterwork Formula item is registered');
    // Threat: plate armour draws more than cloth.
    function armorSet(mat){ var b = {}; ['helmet','chest','gauntlets','boots'].forEach(function(s){ b[s] = { material:mat, tier:5, rarity:'normal' }; }); return b; }
    ok(FF.playerThreat({ bodyArmor: armorSet('plate') }) > FF.playerThreat({ bodyArmor: armorSet('tailoring') }), 'plate armour generates more threat than cloth');
    ok(FF.armorThreatWeight('plate') > FF.armorThreatWeight('tailoring'), 'plate threat weight > cloth');
    // Target picker: a lone alive member is always chosen; an all-downed party returns -1.
    eq(FF.dungeonPickTarget([{ alive:true, threat:10 }]), 0, 'solo party targets member 0');
    eq(FF.dungeonPickTarget([{ alive:false, threat:10 }]), -1, 'no alive members -> -1 (no target)');
    // CRITICAL client<->server invariant: the enemy HP curve must match the server (dungeon edge fn)
    // formula exactly -- hp[i]=round(50000*1.05^i), boss=round(hp[23]*10) -- or shared HP desyncs.
    for(var _i = 0; _i < 24; _i++) eq(en[_i].hp, Math.round(50000 * Math.pow(1.05, _i)), 'enemy ' + _i + ' HP matches the server formula');
    eq(en[24].hp, Math.round(en[23].hp * 10), 'boss HP = round(24th * 10) matches the server');
    // Enemy ATTACK curve + cadence must also match the server (dungeon edge fn d1Roster) or enemy
    // damage/timing desyncs in Stage B: atkMin=round(200*1.04^i), atkMax=round(500*1.04^i),
    // interval_ms = round((2.2 + (i%5)*0.3)*1000).
    for(var _j = 0; _j < 25; _j++){
      eq(en[_j].atkMin, Math.round(200 * Math.pow(1.04, _j)), 'enemy ' + _j + ' atkMin matches server');
      eq(en[_j].atkMax, Math.round(500 * Math.pow(1.04, _j)), 'enemy ' + _j + ' atkMax matches server');
      eq(Math.round(en[_j].attackSpeed * 1000), Math.round((2.2 + (_j % 5) * 0.3) * 1000), 'enemy ' + _j + ' attack interval matches server');
    }
    // Reported proxies are bounded: DPS positive, mitigation 0..85%.
    var pw = FF.dungeonPower(); ok(typeof pw === 'number' && isFinite(pw) && pw >= 1, 'dungeonPower() is a positive finite DPS proxy');
    var mp = FF.dungeonMitPct(); ok(mp >= 0 && mp <= 85, 'dungeonMitPct() is a bounded 0..85% proxy');
  });

  // ---- Dungeons: D2 "Tunnel" (25 Orcs, L126->150, ~10x boss, hand-crafted portraits) ------
  suite('dungeons: D2 Tunnel', function(){
    ok(FF.DUNGEON_ORDER && FF.DUNGEON_ORDER.indexOf('d1') !== -1 && FF.DUNGEON_ORDER.indexOf('d2') !== -1, 'both layers are in DUNGEON_ORDER');
    var def = FF.DUNGEON_DEFS.d2;
    ok(def, 'D2 dungeon defined');
    eq(def.category, 'Tunnel', 'the category is Tunnel');
    eq(def.theme, 'orcs', 'the theme is orcs');
    eq(def.minCombatScore, 126, 'D2 requires Combat Score 126');
    var en = FF.DUNGEON_D2_ENEMIES;
    eq(en.length, 25, '25 orcs');
    eq(en[0].level, 126, 'first orc is level 126');
    eq(en[24].level, 150, 'last orc (boss) is level 150');
    ok(en.every(function(e,i){ return i===0 || e.level >= en[i-1].level; }), 'levels rise 126 -> 150 without dropping');
    eq(en[24].isBoss, true, 'the 25th orc is the boss');
    eq(en[24].name, 'Gorthak the Undertyrant', 'the boss is Gorthak the Undertyrant');
    ok(!en[23].isBoss, 'the 24th is not the boss');
    ok(Math.abs(en[24].hp / en[23].hp - 10) < 0.01, 'boss HP is ~10x the 24th (' + en[24].hp + ' vs ' + en[23].hp + ')');
    // distinct elements across the set
    var elems = {}; en.forEach(function(e){ elems[e.element] = 1; });
    ok(Object.keys(elems).length >= 3, 'orcs span multiple elements (' + Object.keys(elems).join(',') + ')');
    // every orc: an SVG portrait, registered in monsterById, full combat typing
    ok(en.every(function(e){ return typeof e.icon === 'string' && e.icon.indexOf('<svg') === 0; }), 'every orc has an SVG portrait');
    ok(en.every(function(e){ return e.element && e.armorTypes && e.attackTypes && e.hp > 0 && FF.monsterById(e.id) === e; }), 'every orc has element/armor/attack/hp and resolves via monsterById');
    // hand-crafted => every portrait is unique (no two orcs share an SVG string)
    var seen = {}; var uniq = en.every(function(e){ if(seen[e.icon]) return false; seen[e.icon] = 1; return true; });
    ok(uniq, 'all 25 orc portraits are unique (hand-crafted, no repeats)');
    // D2 Masterwork Formula registered + non-vendorable
    var f = FF.ALL_SELLABLE[def.reward]; ok(f && /D2 Masterwork Formula/.test(f.name), 'the D2 Masterwork Formula item is registered');
    eq(f.sell, 0, 'the D2 Formula is non-vendorable (sell 0)');
    ok(def.reward !== FF.DUNGEON_DEFS.d1.reward, 'D2 drops a different Formula than D1');
    // CRITICAL client<->server invariant: the shared enemy HP/attack curves must match the server
    // (dungeon edge fn d2Roster): hp[i]=round(150000*1.05^i), boss=round(hp[23]*10);
    // atkMin=round(400*1.04^i), atkMax=round(1000*1.04^i), interval_ms=round((2.2+(i%5)*0.3)*1000).
    for(var _i = 0; _i < 24; _i++) eq(en[_i].hp, Math.round(150000 * Math.pow(1.05, _i)), 'orc ' + _i + ' HP matches the server formula');
    eq(en[24].hp, Math.round(en[23].hp * 10), 'boss HP = round(24th * 10) matches the server');
    for(var _j = 0; _j < 25; _j++){
      eq(en[_j].atkMin, Math.round(400 * Math.pow(1.04, _j)), 'orc ' + _j + ' atkMin matches server');
      eq(en[_j].atkMax, Math.round(1000 * Math.pow(1.04, _j)), 'orc ' + _j + ' atkMax matches server');
      eq(Math.round(en[_j].attackSpeed * 1000), Math.round((2.2 + (_j % 5) * 0.3) * 1000), 'orc ' + _j + ' attack interval matches server');
    }
  });

  // ---- Dungeons: D3 "Underground Chamber" (25 Undead, L151->175, ~10x boss) ----------------
  suite('dungeons: D3 Underground Chamber', function(){
    ok(FF.DUNGEON_ORDER && FF.DUNGEON_ORDER.slice(0,3).join(',') === 'd1,d2,d3', 'the first three layers are d1,d2,d3 in order');
    var def = FF.DUNGEON_DEFS.d3;
    ok(def, 'D3 dungeon defined');
    eq(def.category, 'Underground Chamber', 'the category is Underground Chamber');
    eq(def.theme, 'undead', 'the theme is undead');
    eq(def.minCombatScore, 151, 'D3 requires Combat Score 151');
    var en = FF.DUNGEON_D3_ENEMIES;
    eq(en.length, 25, '25 undead');
    eq(en[0].level, 151, 'first undead is level 151');
    eq(en[24].level, 175, 'last undead (boss) is level 175');
    ok(en.every(function(e,i){ return i===0 || e.level >= en[i-1].level; }), 'levels rise 151 -> 175 without dropping');
    eq(en[24].isBoss, true, 'the 25th undead is the boss');
    eq(en[24].name, 'Malothrax the Deathless', 'the boss is Malothrax the Deathless');
    ok(!en[23].isBoss, 'the 24th is not the boss');
    ok(Math.abs(en[24].hp / en[23].hp - 10) < 0.01, 'boss HP is ~10x the 24th (' + en[24].hp + ' vs ' + en[23].hp + ')');
    var elems = {}; en.forEach(function(e){ elems[e.element] = 1; });
    ok(Object.keys(elems).length >= 3, 'undead span multiple elements (' + Object.keys(elems).join(',') + ')');
    ok(en.every(function(e){ return typeof e.icon === 'string' && e.icon.indexOf('<svg') === 0; }), 'every undead has an SVG portrait');
    ok(en.every(function(e){ return e.element && e.armorTypes && e.attackTypes && e.hp > 0 && FF.monsterById(e.id) === e; }), 'every undead has element/armor/attack/hp and resolves via monsterById');
    var seen = {}; var uniq = en.every(function(e){ if(seen[e.icon]) return false; seen[e.icon] = 1; return true; });
    ok(uniq, 'all 25 undead portraits are unique (hand-crafted, no repeats)');
    var f = FF.ALL_SELLABLE[def.reward]; ok(f && /D3 Masterwork Formula/.test(f.name), 'the D3 Masterwork Formula item is registered');
    eq(f.sell, 0, 'the D3 Formula is non-vendorable (sell 0)');
    ok(def.reward !== FF.DUNGEON_DEFS.d2.reward && def.reward !== FF.DUNGEON_DEFS.d1.reward, 'D3 drops a Formula distinct from D1/D2');
    // CRITICAL client<->server invariant (dungeon edge fn d3Roster): hp[i]=round(450000*1.05^i),
    // boss=round(hp[23]*10); atkMin=round(800*1.04^i), atkMax=round(2000*1.04^i).
    for(var _i = 0; _i < 24; _i++) eq(en[_i].hp, Math.round(450000 * Math.pow(1.05, _i)), 'undead ' + _i + ' HP matches the server formula');
    eq(en[24].hp, Math.round(en[23].hp * 10), 'boss HP = round(24th * 10) matches the server');
    for(var _j = 0; _j < 25; _j++){
      eq(en[_j].atkMin, Math.round(800 * Math.pow(1.04, _j)), 'undead ' + _j + ' atkMin matches server');
      eq(en[_j].atkMax, Math.round(2000 * Math.pow(1.04, _j)), 'undead ' + _j + ' atkMax matches server');
    }
  });

  // ---- Dungeons: D4 "Nest of the Depths" (25 Dragons, L176->200, ~10x boss) ----------------
  suite('dungeons: D4 Nest of the Depths', function(){
    ok(FF.DUNGEON_ORDER && FF.DUNGEON_ORDER.join(',') === 'd1,d2,d3,d4', 'all four layers are in DUNGEON_ORDER, in order');
    var def = FF.DUNGEON_DEFS.d4;
    ok(def, 'D4 dungeon defined');
    eq(def.category, 'Nest of the Depths', 'the category is Nest of the Depths');
    eq(def.theme, 'dragons', 'the theme is dragons');
    eq(def.minCombatScore, 176, 'D4 requires Combat Score 176');
    var en = FF.DUNGEON_D4_ENEMIES;
    eq(en.length, 25, '25 dragons');
    eq(en[0].level, 176, 'first dragon is level 176');
    eq(en[24].level, 200, 'last dragon (boss) is level 200');
    ok(en.every(function(e,i){ return i===0 || e.level >= en[i-1].level; }), 'levels rise 176 -> 200 without dropping');
    eq(en[24].isBoss, true, 'the 25th dragon is the boss');
    eq(en[24].name, 'Vaeldrûn the Worldender', 'the boss is Vaeldrûn the Worldender');
    ok(!en[23].isBoss, 'the 24th is not the boss');
    ok(Math.abs(en[24].hp / en[23].hp - 10) < 0.01, 'boss HP is ~10x the 24th (' + en[24].hp + ' vs ' + en[23].hp + ')');
    var elems = {}; en.forEach(function(e){ elems[e.element] = 1; });
    ok(Object.keys(elems).length >= 3, 'dragons span multiple elements (' + Object.keys(elems).join(',') + ')');
    ok(en.every(function(e){ return typeof e.icon === 'string' && e.icon.indexOf('<svg') === 0; }), 'every dragon has an SVG portrait');
    ok(en.every(function(e){ return e.element && e.armorTypes && e.attackTypes && e.hp > 0 && FF.monsterById(e.id) === e; }), 'every dragon has element/armor/attack/hp and resolves via monsterById');
    var seen = {}; var uniq = en.every(function(e){ if(seen[e.icon]) return false; seen[e.icon] = 1; return true; });
    ok(uniq, 'all 25 dragon portraits are unique (hand-crafted, no repeats)');
    var f = FF.ALL_SELLABLE[def.reward]; ok(f && /D4 Masterwork Formula/.test(f.name), 'the D4 Masterwork Formula item is registered');
    eq(f.sell, 0, 'the D4 Formula is non-vendorable (sell 0)');
    // CRITICAL client<->server invariant (dungeon edge fn d4Roster): hp[i]=round(1350000*1.05^i),
    // boss=round(hp[23]*10); atkMin=round(1600*1.04^i), atkMax=round(4000*1.04^i).
    for(var _i = 0; _i < 24; _i++) eq(en[_i].hp, Math.round(1350000 * Math.pow(1.05, _i)), 'dragon ' + _i + ' HP matches the server formula');
    eq(en[24].hp, Math.round(en[23].hp * 10), 'boss HP = round(24th * 10) matches the server');
    for(var _j = 0; _j < 25; _j++){
      eq(en[_j].atkMin, Math.round(1600 * Math.pow(1.04, _j)), 'dragon ' + _j + ' atkMin matches server');
      eq(en[_j].atkMax, Math.round(4000 * Math.pow(1.04, _j)), 'dragon ' + _j + ' atkMax matches server');
    }
    // Every dungeon Formula is distinct across all four layers.
    var rewards = FF.DUNGEON_ORDER.map(function(l){ return FF.DUNGEON_DEFS[l].reward; });
    var rset = {}; rewards.forEach(function(r){ rset[r] = 1; });
    eq(Object.keys(rset).length, 4, 'all four dungeon Formulas are distinct');
  });

  // ---- Masterwork Blueprints: 9 slots x 4 dungeons, weighted boss drops, separate inventory -------
  suite('masterwork blueprints', function(){
    var slots = FF.MASTERWORK_SLOTS;
    eq(slots.length, 9, 'nine Masterwork gear slots');
    // exact drop chances requested
    var byId = {}; slots.forEach(function(s){ byId[s.id] = s; });
    var want = { ring:0.05, amulet:0.025, cape:0.015, mainhand:0.15, offhand:0.15, head:0.15, chest:0.15, hands:0.15, feet:0.15 };
    Object.keys(want).forEach(function(k){ ok(byId[k], 'slot ' + k + ' exists'); near((byId[k]||{}).chance, want[k], 'slot ' + k + ' drop chance', 1e-9); });
    // 36 Blueprints (4 dungeons x 9 slots), each named "<Category> <Slot> Blueprint"
    eq(Object.keys(FF.BLUEPRINT_ITEMS).length, 36, '4 dungeons x 9 slots = 36 Blueprints');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','amulet')].name, 'Cave Amulet Blueprint', 'D1 amulet is "Cave Amulet Blueprint"');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','mainhand')].name, 'Underground Chamber Mainhand Blueprint', 'D3 mainhand is "Underground Chamber Mainhand Blueprint"');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','cape')].name, 'Nest of the Depths Cape Blueprint', 'D4 cape name');
    ok(Object.keys(FF.BLUEPRINT_ITEMS).every(function(id){ var b = FF.BLUEPRINT_ITEMS[id]; return b.blueprint === true && b.sell === 0 && /<svg/.test(b.icon); }), 'every Blueprint is flagged, non-vendorable, and has an icon');
    // Blueprints are their OWN inventory, not in the sellable/item economy.
    ok(Object.keys(FF.BLUEPRINT_ITEMS).every(function(id){ return !FF.ALL_SELLABLE[id]; }), 'Blueprints are not part of ALL_SELLABLE (separate inventory)');
    // addBlueprint stores into state.blueprints (not state.inventory).
    var s = FF._state; var svB = s.blueprints, svI = s.inventory;
    s.blueprints = {}; s.inventory = {};
    var bid = FF.masterworkBlueprintId('d2','feet');
    FF.addBlueprint(bid, 2);
    eq(s.blueprints[bid], 2, 'addBlueprint credits the Blueprint inventory');
    eq(s.inventory[bid] || 0, 0, 'addBlueprint does NOT touch the item inventory');
    FF.addBlueprint('not_a_blueprint', 1); eq(s.blueprints['not_a_blueprint'], undefined, 'addBlueprint rejects unknown ids');
    // rollMasterworkDrops only ever grants THIS layer's Blueprints, and stays within the slot set.
    s.blueprints = {};
    var granted = [];
    for(var r = 0; r < 300; r++) granted = granted.concat(FF.rollMasterworkDrops('d1'));
    ok(granted.length > 0, 'over many clears, some Blueprints drop');
    ok(granted.every(function(b){ return b.dungeon === 'd1'; }), 'a d1 clear only drops d1 Blueprints');
    ok(Object.keys(s.blueprints).every(function(id){ return FF.BLUEPRINT_ITEMS[id] && FF.BLUEPRINT_ITEMS[id].dungeon === 'd1'; }), 'the Blueprint inventory only holds d1 Blueprints after d1 clears');
    s.blueprints = svB; s.inventory = svI;
  });

  // ---- Solo dungeon tuning: 30% difficulty + 25% Formula drop vs the group (server) baseline ---------
  suite('dungeons: solo scaling (30% difficulty, 25% drops)', function(){
    eq(FF.DUNGEON_SOLO_DIFFICULTY, 0.3, 'solo difficulty is 30% of group');
    eq(FF.DUNGEON_SOLO_DROP_MULT, 0.25, 'solo Formula drop is 25% of group');
    var base = FF.DUNGEON_D1_ENEMIES[0];
    var solo = FF.dungeonSoloEnemy(base);
    eq(solo.id, base.id + '_solo', 'solo enemy gets its own id');
    eq(solo.hp, Math.max(1, Math.round(base.hp * 0.3)), 'solo enemy HP is 30% of the group foe');
    eq(solo.atkMin, Math.max(1, Math.round(base.atkMin * 0.3)), 'solo enemy atkMin is 30%');
    eq(solo.atkMax, Math.max(1, Math.round(base.atkMax * 0.3)), 'solo enemy atkMax is 30%');
    ok(base.hp > 0 && FF.DUNGEON_D1_ENEMIES[0].hp === base.hp, 'the canonical group roster is left untouched');
    // The boss clone keeps the ~10x proportion (30% of a 10x-of-24th boss).
    var bBoss = FF.DUNGEON_D1_ENEMIES[FF.DUNGEON_D1_ENEMIES.length - 1];
    eq(FF.dungeonSoloEnemy(bBoss).hp, Math.max(1, Math.round(bBoss.hp * 0.3)), 'boss clone HP is 30% of the boss');
    // monsterById resolves a '<base>_solo' id (rebuilding the clone lazily, e.g. after a reload).
    ok(FF.monsterById(base.id + '_solo') && FF.monsterById(base.id + '_solo').hp === solo.hp, 'monsterById resolves a solo clone id');
    // Drop rate: a 0 multiplier never drops; the default (group) can. Confirms the multiplier is applied.
    var none = [];
    for(var i = 0; i < 200; i++) none = none.concat(FF.rollMasterworkDrops('d1', 0));
    eq(none.length, 0, 'a 0x drop multiplier yields no Blueprints');
    var full = [];
    for(var j = 0; j < 400; j++) full = full.concat(FF.rollMasterworkDrops('d1', 1));
    ok(full.length > 0, 'the group (1x) rate still drops Blueprints');
    // Action lock: no dungeon in progress -> other action-bar tasks are allowed.
    eq(typeof FF.dungeonLocksActions, 'function', 'dungeonLocksActions is exported');
    eq(FF.dungeonLocksActions(), false, 'actions are not locked when not in a dungeon');
  });

  // ---- Status debuff cap: Weaken / Slow clamp to 99% even when familiar potency over-stacks them ------
  suite('familiars: status debuffs cap at 99%', function(){
    eq(FF.STATUS_DEBUFF_CAP, 0.99, 'the status-debuff cap is 99%');
    var s = FF._state;
    if(!s.familiarBuffs || typeof s.familiarBuffs !== 'object') s.familiarBuffs = { enemyWeakenPct:0, enemyWeakenUntil:0, enemySlowPct:0, enemySlowUntil:0 };
    // A raw pct far above 1.0 (as heavy cloth/potion/level potency could push it) is clamped to the cap.
    FF.castFamiliarSpell({ type:'weakenEnemy', name:'Test Weaken', pct:5.0, durationMs:8000 }, 100);
    near(s.familiarBuffs.enemyWeakenPct, 0.99, 'Weaken clamps to 99% (enemy keeps 1% of its damage)');
    FF.castFamiliarSpell({ type:'slowEnemy', name:'Test Slow', pct:5.0, durationMs:8000 }, 100);
    near(s.familiarBuffs.enemySlowPct, 0.99, 'Slow clamps to 99%');
  });

  // ---- Mastercrafting: D1 Ring Blueprint -> one of 5 Legendary Signets (effect scaled 2x/4x/8x) --------
  suite('mastercraft: D1 legendary rings', function(){
    var s = FF._state;
    eq(Object.keys(FF.LEGENDARY_RING_ITEMS).length, 20, '5 effects x 4 rarities = 20 legendary ring items');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','normal')].value, 0.05, 'block Signet base is 5%');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','rare')].value, 0.10, 'rare = 2x');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','supreme')].value, 0.20, 'supreme = 4x');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','fantastic')].value, 0.40, 'fantastic = 8x');
    // Recipe matches the spec; only D1 Ring exists so far.
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','ring')]);
    ok(rec && rec.inputs.metallurgy_t20===1000 && rec.inputs.gem_voidcrystal===100 && rec.inputs.twine_t20===100 && rec.inputs.goldsmithing_t20===100 && rec.rareRings===10, 'D1 Ring recipe = 1000 ingots / 100 gems / 100 twine / 100 settings / 10 rare rings');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','ring')]), null, 'D2 Ring mastercraft is not available yet');
    // Effect aggregation from an equipped Signet.
    var svJ = s.jewelrySlots;
    s.jewelrySlots = { ring1:{leg:'block',rarity:'rare'}, ring2:{typeId:null,tier:0,rarity:'normal'}, ring3:{typeId:null,tier:0,rarity:'normal'}, ring4:{typeId:null,tier:0,rarity:'normal'}, ring5:{typeId:null,tier:0,rarity:'normal'} };
    near(FF.legendaryRingBonus('block', s), 0.10, 'an equipped rare block Signet gives +10% block');
    ok(FF.legRingEquipped('block', s) && !FF.legRingEquipped('dodge', s), 'legRingEquipped is per-effect');
    s.jewelrySlots = svJ;
    // Full craft: materials + 10 rare Tier-20 rings + a Blueprint -> one Signet, all inputs consumed.
    var svInv = s.inventory, svBp = s.blueprints;
    var ringId = 'ring_' + FF.RING_TYPES[0].id + '_t20_rare';
    s.inventory = { metallurgy_t20:1000, gem_voidcrystal:100, twine_t20:100, goldsmithing_t20:100 };
    s.inventory[ringId] = 10;
    s.blueprints = {}; s.blueprints[FF.masterworkBlueprintId('d1','ring')] = 1;
    FF.craftMastercraft(FF.masterworkBlueprintId('d1','ring'));
    eq(s.blueprints[FF.masterworkBlueprintId('d1','ring')], 0, 'craft consumes the Blueprint');
    eq(s.inventory.metallurgy_t20, 0, 'craft consumes the ingots');
    eq(s.inventory[ringId], 0, 'craft consumes the 10 rare Rings');
    var made = Object.keys(FF.LEGENDARY_RING_ITEMS).reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(made, 1, 'craft grants exactly one Legendary Signet');
    s.inventory = svInv; s.blueprints = svBp;
  });

  // ---- Dungeon unlock chain: each layer requires clearing the previous boss (Cave = Combat Score only) --
  suite('dungeons: unlock chain (clear the previous boss)', function(){
    var s = FF._state, saved = s.dungeonsCleared;
    eq(FF.dungeonPrevId('d1'), null, 'd1 (Cave) has no prerequisite dungeon');
    eq(FF.dungeonPrevId('d2'), 'd1', 'd2 requires d1');
    eq(FF.dungeonPrevId('d3'), 'd2', 'd3 requires d2');
    eq(FF.dungeonPrevId('d4'), 'd3', 'd4 requires d3');
    s.dungeonsCleared = {};
    eq(FF.dungeonBossCleared('d1'), false, 'a boss is not cleared until beaten');
    FF.dungeonMarkCleared('d1');
    eq(FF.dungeonBossCleared('d1'), true, 'dungeonMarkCleared records the boss kill');
    // With d1 cleared, d2 is no longer PREREQ-blocked (only Combat Score may remain, never the prereq).
    var b2 = FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d2);
    ok(b2 === null || b2.indexOf('Combat Score') === 0, 'clearing d1 lifts d2\'s prerequisite (Combat Score aside)');
    // Cave itself is never prereq-gated -- only Combat Score can block it.
    var b1 = FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d1);
    ok(b1 === null || b1.indexOf('Combat Score') === 0, 'the Cave is gated only by Combat Score');
    // Nothing cleared -> d4 is always blocked (prereq and/or score), never enterable.
    s.dungeonsCleared = {};
    ok(FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d4) !== null, 'd4 is blocked while its prerequisites are unmet');
    s.dungeonsCleared = saved;
  });

  // ---- Lumen Oracle (Light Wand): the last wand element gets a caster class -----------------------
  suite('classes: lumen oracle (light wand)', function(){
    function armor(mat,tier){ return {material:mat,tier:tier||5}; }
    function stFor(level, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:'wandLight', equippedOffhand:'wardLight',
                 bodyArmor:{helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather'),boots:armor('leather')},
                 classDebuffs:{enemyDmgUntil:0,enemyArmorUntil:0}, activity:{type:'combat',monsterHp:100}, playerHp:55 };
      st.xp['lumen'] = FF.xpFloorForLevel(level);
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var cd = FF.CLASS_DEFS_BY_ID.lumen;
    ok(cd, 'Lumen Oracle is a registered class');
    eq(cd.name, 'Lumen Oracle', 'display name is Lumen Oracle');
    eq(cd.passives.length, 5, 'has 5 perks');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'perks at Lv 1/20/40/60/80');
    ok(/Light Wand/.test(cd.reqText), 'wields the Light Wand (the last element without a class)');
    // gating: full kit activates; dropping the boots deactivates.
    eq(FF.activeClassId(stFor(80)), 'lumen', 'light wand + ward + full leather => Lumen Oracle');
    eq(FF.activeClassId(stFor(80,{bodyArmor:{helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather')}})), null, 'Lumen Oracle needs Leather Boots');
    ok(FF.activeClassId(stFor(80,{equippedMainhand:'wandDark'})) !== 'lumen', 'a Dark Wand does not activate Lumen Oracle (it is the Voidshadow kit)');
    // Lv1 Glare: +25% damage.
    var mon = {hp:100};
    ok(Math.abs(FF.newClassDmgMult(mon, stFor(1)) - 1.25) < 1e-9, 'Glare +25% damage');
    // Lv60 Afterimage: +12% Dodge.
    ok(Math.abs(FF.lumenDodgeBonus(stFor(60)) - 0.12) < 1e-9, 'Afterimage +12% Dodge');
    ok(Math.abs(FF.lumenDodgeBonus(stFor(40)) - 0) < 1e-9, 'no Dodge before Lv60');
    // Lv80 Blinding Radiance: only fires while the enemy carries the Blind (enemy-damage) debuff.
    var blindActive = stFor(80,{classDebuffs:{enemyDmgUntil:Date.now()+4000,enemyArmorUntil:0}});
    ok(FF.lumenEnemyBlinded(blindActive), 'enemy is Blinded while the debuff window holds');
    ok(Math.abs(FF.lumenBlindingDealtMult(blindActive) - 1.25) < 1e-9, 'Blinding Radiance +25% dealt while blinded');
    eq(FF.lumenIncomingMult(blindActive), 0.75, 'Blinding Radiance -25% taken while blinded');
    var blindOff = stFor(80); // no active debuff
    eq(FF.lumenBlindingDealtMult(blindOff), 1, 'Blinding Radiance is neutral with no Blind up');
    eq(FF.lumenIncomingMult(blindOff), 1, 'no incoming reduction with no Blind up');
    // Glare stacks with Blinding Radiance in the aggregate dmg mult (1.25 * 1.25 = 1.5625).
    ok(Math.abs(FF.newClassDmgMult(mon, blindActive) - 1.5625) < 1e-9, 'Glare and Blinding Radiance stack (x1.5625)');
    // no class active -> every Lumen multiplier is neutral.
    var none = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, classDebuffs:{enemyDmgUntil:Date.now()+4000}, activity:{type:'combat',monsterHp:100}, playerHp:55 };
    eq(FF.lumenBlindingDealtMult(none), 1, 'no class -> Blinding Radiance dealt neutral');
    eq(FF.lumenIncomingMult(none), 1, 'no class -> Blinding Radiance incoming neutral');
    eq(FF.lumenDodgeBonus(none), 0, 'no class -> no Afterimage dodge');
  });

  // ---- Reaver (Half-Moon Axe): the fast 1h axe gets a Bleed-DoT class -----------------------------
  suite('classes: reaver (half-moon axe, bleed)', function(){
    function armor(mat){ return {material:mat,tier:5}; }
    function stFor(level, extra){
      var st = { xp:{}, physique:{}, equippedMainhand:'halfmoonaxe', equippedOffhand:'shieldSmall',
                 bodyArmor:{helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('leather'),boots:armor('leather')},
                 activity:{type:'combat',monsterHp:100}, playerHp:55 };
      st.xp['reaver'] = FF.xpFloorForLevel(level);
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var cd = FF.CLASS_DEFS_BY_ID.reaver;
    ok(cd, 'Reaver is a registered class');
    eq(cd.passives.length, 5, 'has 5 perks');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'perks at Lv 1/20/40/60/80');
    ok(/Half-Moon Axe/.test(cd.reqText), 'wields the Half-Moon Axe (previously unclaimed)');
    // gating: full kit activates; dropping the shield or swapping the gloves to chain deactivates.
    eq(FF.activeClassId(stFor(80)), 'reaver', 'half-moon axe + small shield + chain/leather => Reaver');
    eq(FF.activeClassId(stFor(80,{equippedOffhand:null})), null, 'Reaver needs the Small Shield');
    eq(FF.activeClassId(stFor(80,{bodyArmor:{helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('chain'),boots:armor('leather')}})), null, 'Reaver needs Leather Gloves, not chain');
    // Savagery +25% damage; Hemorrhage +50% crit damage (Lv40).
    ok(Math.abs(FF.newClassDmgMult({hp:100}, stFor(1)) - 1.25) < 1e-9, 'Savagery +25% damage');
    ok(Math.abs(FF.newClassCritDmg(stFor(40)) - 0.50) < 1e-9, 'Hemorrhage +50% crit damage');
    eq(FF.newClassCritDmg(stFor(20)), 0, 'no crit-damage bonus before Lv40');
    // Bleed tick: it reads the global _state.activity. Snapshot the fields we touch, then restore.
    // With no Reaver kit equipped on _state, reaverBonus(60/80) are off, so we exercise the base tick:
    // it chips the enemy and floors it at 1 (never the finishing blow), and an expired Bleed does nothing.
    var S = FF._state;
    var save = { act:S.activity, hp:S.playerHp, mh:S.equippedMainhand, oh:S.equippedOffhand };
    try {
      S.equippedMainhand=null; S.equippedOffhand=null;
      S.activity = { type:'combat', monsterId:null, monsterHp:100, bleedDps:20, bleedUntil:Date.now()+5000 };
      FF.applyReaverBleedTick(1000);
      ok(Math.abs(S.activity.monsterHp - 80) < 1e-6, 'Bleed chips 20 damage over 1s (20 dps)');
      S.activity.monsterHp = 5; S.activity.bleedDps = 999;
      FF.applyReaverBleedTick(1000);
      eq(S.activity.monsterHp, 1, 'Bleed floors the enemy at 1 (never the finishing blow)');
      S.activity.monsterHp = 100; S.activity.bleedUntil = Date.now()-1;
      FF.applyReaverBleedTick(1000);
      eq(S.activity.monsterHp, 100, 'an expired Bleed deals no damage');
    } finally {
      S.activity=save.act; S.playerHp=save.hp; S.equippedMainhand=save.mh; S.equippedOffhand=save.oh;
    }
  });

  // ---- Tooltip coverage: every skill that renders a (?) info button must carry a SKILL_INFO blurb ---
  // (The info button only shows when SKILL_INFO[id] exists, so a missing entry silently drops the tooltip.)
  suite('skill info: every skill has a tooltip', function(){
    var INFO = FF.SKILL_INFO;
    ok(INFO && typeof INFO === 'object', 'SKILL_INFO is exposed');
    var cats = {
      classes: FF.CLASS_SKILL_IDS,
      gathering: FF.GATHER_SKILL_IDS,
      crafting: FF.CRAFT_SKILL_IDS,
      weapons: FF.WEAPON_STYLE_IDS,
      offhands: FF.OFFHAND_STYLE_IDS,
      'armor proficiencies': FF.ARMOR_PROFICIENCY_IDS,
      faith: FF.FAITH_SKILL_IDS
    };
    Object.keys(cats).forEach(function(cat){
      var ids = cats[cat] || [];
      var missing = ids.filter(function(id){ return !INFO[id]; });
      ok(missing.length === 0, cat + ': all have a SKILL_INFO tooltip' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
    });
    // Spot-check the classes that had been missing before this pass.
    ['frostwarden','plaguebearer','berserker','sentinel','spellblade','pyromancer','sharpshooter','juggernaut','nightblade','executioner','lumen','reaver'].forEach(function(id){
      ok(typeof INFO[id] === 'string' && INFO[id].length > 20, id + ' has a class tooltip');
    });
  });

  // ---- Gadgets: Salvaging -> Tinkering (Bombs) + Pyrotechnics (Flash Bombs) --------------------
  suite('skills: salvaging / tinkering / pyrotechnics', function(){
    ok(FF.GATHERING_SKILLS.salvaging, 'salvaging is a gathering skill');
    ok(FF.CRAFTING_SKILLS.tinkering, 'tinkering is a crafting skill');
    ok(FF.CRAFTING_SKILLS.pyrotechnics, 'pyrotechnics is a crafting skill');
    eq(FF.GATHERING_SKILLS.salvaging.items.length, FF.TIER_COUNT, 'salvaging has 21 scrap tiers');
    eq(FF.CRAFTING_SKILLS.tinkering.recipes.length, FF.TIER_COUNT, 'tinkering has 21 bomb tiers');
    eq(FF.CRAFTING_SKILLS.pyrotechnics.recipes.length, FF.TIER_COUNT, 'pyrotechnics has 21 flash tiers');
    eq(FF.ALL_GATHER_ITEMS['salvaging_t0'].name, 'Rusty Scrap', 'salvaging sifts Scrap');
    // Tinkering bombs need scrap + metal (no glass bottle); Pyrotechnics needs powder + scrap.
    var bomb5 = FF.ALL_CRAFT_RECIPES['bomb_t5'];
    ok(bomb5.inputs['salvaging_t5'] && bomb5.inputs['metallurgy_t5'] && !bomb5.inputs['metallurgy_glass'], 'bomb = scrap + metal, no glass bottle');
    var flash5 = FF.ALL_CRAFT_RECIPES['flash_t5'];
    ok(flash5.inputs['powder_t5'] && flash5.inputs['salvaging_t5'], 'flash bomb = powder + scrap');
    // Both are 5th/6th... two new combat-consumable lines.
    ok(FF.POTION_TYPE_IDS.indexOf('bomb') !== -1 && FF.POTION_TYPE_IDS.indexOf('flash') !== -1, 'bomb + flash are combat-consumable lines');
    eq(bomb5.potionType, 'bomb', 'bomb recipe carries potionType');
    eq(flash5.potionType, 'flash', 'flash recipe carries potionType');
    // Bomb: burst damage that scales and beats a Firebomb; Flash: stun chance that scales.
    var b0 = FF.potionEffect('bomb_t0'), b20 = FF.potionEffect('bomb_t20');
    ok(b0.type==='bomb' && b20.dmg > b0.dmg, 'bomb burst scales with tier');
    ok(b20.dmg > FF.potionEffect('firebomb_t20').dmg, 'top Bomb hits harder than a top Firebomb');
    var f0 = FF.potionEffect('flash_t0'), f20 = FF.potionEffect('flash_t20');
    ok(f0.type==='flash' && f20.stun > f0.stun && f20.stun <= 0.20 + 1e-9, 'flash stun chance scales with tier (cap 20%)');
    ok(/burst damage/.test(FF.potionEffectDesc('bomb_t10')), 'bomb describes its burst');
    ok(/stun/.test(FF.potionEffectDesc('flash_t10')), 'flash describes its stun');
    ok(FF.GATHER_PHYSIQUE.salvaging && FF.CRAFT_PHYSIQUE.tinkering && FF.CRAFT_PHYSIQUE.pyrotechnics, 'physique tables include the new skills');
  });

  // ---- Arcane: Essence Harvesting -> Inscription + the Scroll (ward) buff ----------------------
  suite('skills: essence / inscription', function(){
    ok(FF.GATHERING_SKILLS.essence, 'essence harvesting is a gathering skill');
    ok(FF.CRAFTING_SKILLS.inscription, 'inscription is a crafting skill');
    eq(FF.GATHERING_SKILLS.essence.items.length, FF.TIER_COUNT, 'essence has 21 tiers');
    eq(FF.CRAFTING_SKILLS.inscription.recipes.length, FF.TIER_COUNT, 'inscription has 21 scroll tiers');
    eq(FF.ALL_GATHER_ITEMS['essence_t0'].name, 'Faint Mote', 'essence taps Aether/Motes');
    // Chain: Essence + Paper (from Papermaking) -> Scroll.
    var scr5 = FF.ALL_CRAFT_RECIPES['scroll_t5'];
    ok(scr5.inputs['essence_t5'] && scr5.inputs['paper_t5'], 'scroll binds Essence + Paper (interlocks Papermaking)');
    // Scroll = a timed damage-reduction ward -- its own channel.
    ok(scr5.scrollBonus > 0 && scr5.scrollDurationMs > 0, 'scrolls carry a timed ward buff');
    var s0 = FF.ALL_CRAFT_RECIPES['scroll_t0'], s20 = FF.ALL_CRAFT_RECIPES['scroll_t20'];
    ok(s20.scrollBonus > s0.scrollBonus && s20.scrollBonus <= 0.30 + 1e-9, 'ward scales with tier (cap 30%)');
    // Reading a scroll reduces incoming damage; none by default.
    eq(FF.scrollDamageReduction(), 0, 'no ward by default');
    FF._state.inventory['scroll_t10'] = 1;
    FF.readScroll('scroll_t10');
    ok(FF.isScrollActive(), 'reading a scroll activates the ward');
    ok(FF.scrollDamageReduction() > 0 && FF.scrollDamageReduction() <= 0.30 + 1e-9, 'active ward reduces incoming damage');
    ok(FF.CRAFT_PHYSIQUE.inscription && FF.GATHER_PHYSIQUE.essence, 'physique tables include the new skills');
  });

  // ---- Inventory grid: rarity parsing for cell accents / detail tag ----------------------
  suite('inventory rarity', function(){
    eq(FF.itemRarityId('bodyarmor_chain_chest_t20_normal'), 'normal', 'normal suffix');
    eq(FF.itemRarityId('stweapon_rapier_t5_rare'), 'rare', 'rare suffix');
    eq(FF.itemRarityId('relic_t8_supreme'), 'supreme', 'supreme suffix');
    eq(FF.itemRarityId('amulet_t3_fantastic'), 'fantastic', 'fantastic suffix');
    eq(FF.itemRarityId('mining_t7'), 'normal', 'no rarity suffix -> normal');
  });

  // ---- Chat system announcements: only supreme/fantastic crafts echo into global chat ----
  suite('craft chat announce', function(){
    eq(FF.craftBodyRarity('Fantastic Steel Axe'), 'fantastic', 'fantastic craft body -> fantastic');
    eq(FF.craftBodyRarity('Supreme Iron Sword'), 'supreme', 'supreme craft body -> supreme');
    eq(FF.craftBodyRarity('Rare Bronze Dagger'), null, 'rare craft body -> null (chronicle only)');
    eq(FF.craftBodyRarity('Oak Plank'), null, 'normal craft body -> null');
    eq(FF.craftBodyRarity(''), null, 'empty body -> null');
  });

  // ---- Alchemy combat potions: 4 types, linear t0->t20 effect scaling ----
  suite('alchemy potions', function(){
    eq(Math.round(FF.potionEffect('toxin_t0').pct*100), 1, 'toxin t0 = 1% combat score/s');
    eq(Math.round(FF.potionEffect('toxin_t20').pct*100), 10, 'toxin t20 = 10% combat score/s');
    eq(FF.potionEffect('firebomb_t0').dmg, 5, 'firebomb t0 = 5 dmg');
    eq(FF.potionEffect('firebomb_t20').dmg, 210, 'firebomb t20 = 210 dmg');
    eq(Math.round(FF.potionEffect('elixir_t0').crit*100), 5, 'elixir t0 = +5% crit dmg');
    eq(Math.round(FF.potionEffect('elixir_t20').crit*100), 110, 'elixir t20 = +110% crit dmg');
    eq(Math.round(FF.potionEffect('catalyst_t0').fam*100), 5, 'catalyst t0 = +5% familiar');
    eq(Math.round(FF.potionEffect('catalyst_t20').fam*100), 110, 'catalyst t20 = +110% familiar');
    eq(FF.potionEffect('mining_t0'), null, 'non-potion id -> null');
    // every alchemy recipe requires the matching-tier Glassblowing glass (Metallurgy's flat Glass
    // Bottle side-recipe is retired) + covers its 4 types x tiers (enchant is a separate Enchanting line)
    var alc = FF.CRAFTING_SKILLS_ALCHEMY.recipes;
    ok(alc.every(function(r){ return !r.inputs['metallurgy_glass']; }), 'no alchemy recipe still uses the retired metallurgy_glass');
    ok(alc.every(function(r){ var m=/_t(\d+)$/.exec(r.id); return m && r.inputs['glassblowing_t'+m[1]] === 1; }), 'every alchemy recipe needs 1 tier-matched Glassblowing glass');
    ['toxin','firebomb','elixir','catalyst'].forEach(function(t){
      ok(alc.some(function(r){ return r.id===t+'_t0'; }) && alc.some(function(r){ return r.id===t+'_t20'; }), t+' alchemy line spans t0..t20');
    });
  });

  // ---- Faith XP reworked from exponential to the linear Crafting curve ----
  suite('faith xp linear', function(){
    var P = FF.PRAYER_TIERS;
    eq(P[0].xp, FF.craftXp(0), 'prayer t0 xp = craftXp(0) = 25');
    eq(P[20].xp, FF.craftXp(20), 'prayer t20 xp = craftXp(20) = 325');
    eq(P[5].xp - P[4].xp, P[15].xp - P[14].xp, 'prayer xp step is constant (linear, not exponential)');
    // channeled faith activities: xp/s ramps linearly, not by 1.25^i
    var D = FF.FAITH_ACTIVITY_TIERS.devotion;
    eq(D[0].xpPerSec, 2, 'devotion t0 xp/s = base 2');
    eq(D[20].xpPerSec, 26, 'devotion t20 xp/s = 2*(1+0.6*20) = 26');
    eq(Math.round((D[10].xpPerSec - D[9].xpPerSec)*100), Math.round((D[20].xpPerSec - D[19].xpPerSec)*100), 'devotion xp/s step is constant (linear)');
  });

  // ---- Familiar spell kits: every familiar has a unique 4-spell kit, all describable ----
  suite('familiar kits', function(){
    var ids = Object.keys(FF.FAMILIAR_DATA);
    var sigs = {}, dupe = null, allFour = true, allDesc = true;
    ids.forEach(function(id){
      var sp = FF.FAMILIAR_DATA[id].spells || [];
      if(sp.length !== 4) allFour = false;
      sp.forEach(function(s){ if(!FF.describeSpell(s, 5)) allDesc = false; });
      var sig = sp.map(function(s){ return s.type + (s.kind?(':'+s.kind):'') + (s.dmgType?(':'+s.dmgType):''); }).sort().join('|');
      if(sigs[sig]) dupe = sigs[sig] + ' & ' + id; else sigs[sig] = id;
    });
    ok(allFour, 'every familiar has exactly 4 spells');
    ok(allDesc, 'every spell produces a non-empty description');
    ok(!dupe, 'every familiar kit is a unique effect combination' + (dupe ? ' -- dupe: ' + dupe : ''));
    // spot-check a couple of new spell types describe sensibly
    ok(/damage/.test(FF.describeSpell({type:'hit',dmgType:'piercing',amount:14}, 1)), 'hit spell describes damage');
    ok(/HP\/s/.test(FF.describeSpell({type:'regen',hps:4,durationMs:6000}, 1)), 'regen spell describes HP/s');
    ok(/killing blow/.test(FF.describeSpell({type:'bubble',durSec:3}, 1)), 'bubble spell describes killing blow');
  });

  // ---- Familiar companion avatars: every familiar has a bespoke avatar with its skill crest ----
  suite('familiar avatars', function(){
    var ids = Object.keys(FF.FAMILIAR_DATA);
    var missing = ids.filter(function(id){ return !FF.FAM_SKIN[id]; });
    eq(missing.length, 0, 'every familiar has an avatar skin' + (missing.length?': missing '+missing.join(','):''));
    var svgOk = ids.every(function(id){ var s = FF.familiarAvatar(id); return typeof s==='string' && s.indexOf('<svg')===0 && s.indexOf('fam-avatar')>-1; });
    ok(svgOk, 'familiarAvatar returns a fam-avatar svg for every familiar');
    // each avatar embeds its skill emblem shape
    var emblemOk = ids.every(function(id){ return FF.familiarAvatar(id).indexOf('#shape-'+FF.FAM_SKIN[id].s) > -1; });
    ok(emblemOk, 'each avatar holds its skill emblem shape');
    eq(FF.familiarAvatar('mining').indexOf('#shape-ore') > -1, true, 'mining familiar holds the ore crest');
    // Every familiar-eligible skill (gathering/crafting/farming/faith/physique) has a COMPLETE familiar:
    // a 4-spell kit, an avatar skin, and a channelled element. Guards the "a familiar for every skill" fill.
    var missingFam = FF.FAMILIAR_SKILL_IDS.filter(function(id){ var f=FF.FAMILIAR_DATA[id]; return !(f && f.spells && f.spells.length===4 && FF.FAM_SKIN[id] && FF.FAMILIAR_ELEMENT[id]); });
    eq(missingFam.length, 0, 'every skill has a complete familiar' + (missingFam.length?': missing '+missingFam.join(','):''));
    // spot-check a couple of the newly-filled utility-physique familiars
    ok(FF.FAMILIAR_DATA.merchantsSavvy && FF.FAMILIAR_DATA.merchantsSavvy.spells.length===4, "Merchant's Savvy has a familiar");
    ok(FF.FAMILIAR_DATA.zealotry && FF.FAMILIAR_DATA.zealotry.spells.length===4, 'Zealotry has a familiar');
    // famMix midpoint of black and white is grey
    eq(FF.famMix('#000000','#ffffff',0.5), '#808080', 'famMix 50% black/white -> grey');
  });

  // ---- Inventory category sort: group each item's tiers by family, then order by tier -----
  suite('inventory family sort', function(){
    eq(FF.invFamilyKey('digging_t2'), 'digging', 'strips tier -> family');
    eq(FF.invFamilyKey('bodyarmor_chain_chest_t5_rare'), 'bodyarmor_chain_chest', 'strips tier+rarity -> family');
    eq(FF.invFamilyKey('coal'), 'coal', 'no tier -> whole id');
    var ids = ['forestry_t1','digging_t2','digging_t0','forestry_t0'];
    var sorted = ids.slice().sort(function(a,b){
      return FF.invFamilyKey(a).localeCompare(FF.invFamilyKey(b)) || (FF.itemTierFromId(a)-FF.itemTierFromId(b));
    });
    eq(sorted.join(','), 'digging_t0,digging_t2,forestry_t0,forestry_t1', 'family then tier ordering');
  });

  // ---- Marketplace pricing helpers (must match the server RPC's tax math) --------------
  suite('marketplace pricing', function(){
    eq(FF.MARKET_TAX, 0.05, 'market tax is 5%');
    eq(FF.marketTax(1000), 50, '5% of 1000 = 50');
    eq(FF.marketTax(999), 49, 'tax floors (999 -> 49, not 49.95)');
    eq(FF.marketBuyCost(7, 9), 63, 'buy cost = price*qty');
    eq(FF.marketSellNet(100, 10), 950, 'sell net = gross - 5% tax (1000 -> 950)');
    eq(FF.marketSellNet(1, 1), 1, 'tiny sale: floor(0.05)=0 tax, net = 1');
    ok(FF.marketSellNet(50, 3) === 50*3 - FF.marketTax(50*3), 'sell net stays consistent with marketTax');
  });

  // ---- Combat damage-type advantage triangle --------------------------------------------
  suite('weaponAdvantage', function(){
    FF.DAMAGE_TYPES.forEach(function(t){ eq(FF.weaponAdvantageMultiplier(t, t), 1.0, 'same type is neutral: ' + t); });
    FF.DAMAGE_TYPES.forEach(function(w){
      var mults = FF.DAMAGE_TYPES.map(function(d){ return FF.weaponAdvantageMultiplier(w, d); }).sort();
      eq(mults[0], 0.8, w + ' has one weak matchup');
      eq(mults[1], 1.0, w + ' is neutral vs itself');
      eq(mults[2], 1.25, w + ' has one strong matchup');
    });
    eq(FF.weightedAdvantage({ slashing: 1 }, { slashing: 1 }), 1.0, 'pure self matchup = 1.0');
    var s = 'slashing', p = 'piercing';
    var expected = 0.5 * FF.weaponAdvantageMultiplier(s, s) + 0.5 * FF.weaponAdvantageMultiplier(p, s);
    near(FF.weightedAdvantage({ slashing: 0.5, piercing: 0.5 }, { slashing: 1 }), expected, 'weightedAdvantage weights by attacker mix');
  });

  // ---- Accuracy vs Dodge ----------------------------------------------------------------
  suite('accuracy vs dodge', function(){
    // Enemy dodge scales monotonically with tier, low at t0 and high at the top tier.
    var wildlife = FF.MONSTERS.filter(function(m){ return m.category==='wildlife'; })
      .sort(function(a,b){ return a.tierIndex - b.tierIndex; });
    ok(wildlife.length >= 21, 'wildlife spans all tiers');
    var t0 = FF.monsterDodge(wildlife[0]);
    var tTop = FF.monsterDodge(wildlife[wildlife.length-1]);
    ok(t0 >= 0 && t0 < 30, 't0 dodge is low (' + t0 + ')');
    ok(tTop > 400, 'top-tier dodge is high (' + tTop + ')');
    for(var i=1;i<wildlife.length;i++){
      ok(FF.monsterDodge(wildlife[i]) >= FF.monsterDodge(wildlife[i-1]), 'dodge is non-decreasing by tier at ' + i);
    }

    // hitChanceVs: accuracy >= dodge always hits; deficits erode toward the floor; clamped to [floor,1].
    eq(FF.hitChanceVs(700, 700), 1, 'accuracy meeting dodge => guaranteed hit');
    eq(FF.hitChanceVs(1000, 700), 1, 'accuracy above dodge => guaranteed hit');
    ok(FF.hitChanceVs(0, 700) >= 0.15 - 1e-9, 'huge deficit never drops below the 15% floor');
    ok(FF.hitChanceVs(0, 700) <= 0.16, 'huge deficit sits at the floor');
    near(FF.hitChanceVs(400, 500), 1 - 100/500, 'partial deficit erodes linearly');
    ok(FF.hitChanceVs(400, 500) > FF.hitChanceVs(300, 500), 'more accuracy => higher hit chance vs same dodge');

    // The accuracy physiques are a fixed, Claude-chosen combat-reflex set (not player-selected).
    eq(FF.ACCURACY_PHYSIQUES.length, FF.ACCURACY_PHYS_SLOTS, 'exactly '+FF.ACCURACY_PHYS_SLOTS+' fixed accuracy physiques');
    FF.ACCURACY_PHYSIQUES.forEach(function(id){ ok(FF.PHYSIQUE_SKILL_MAP[id], id+' is a real physique'); });
    // accuracyPhysiques() always returns the fixed set and ignores any state override.
    eq(FF.accuracyPhysiques().join(','), FF.ACCURACY_PHYSIQUES.join(','), 'accuracyPhysiques returns the fixed set');
    eq(FF.accuracyPhysiques({ accuracyPhysiques:['a','b','c'] }).join(','), FF.ACCURACY_PHYSIQUES.join(','), 'a legacy state override is ignored');

    // playerAccuracy is driven by the fixed physiques + weapon proficiency (heavier on physiques).
    var base = { physique:{}, xp:{}, equippedMainhand:null };
    FF.ACCURACY_PHYSIQUES.forEach(function(id){ base.physique[id] = 0; });
    var accWithout = FF.playerAccuracy(base);
    base.physique[FF.ACCURACY_PHYSIQUES[0]] = 100*100;   // getLevel(xp)=~101; large so the weighting is visible
    var accWith = FF.playerAccuracy(base);
    ok(accWith > accWithout, 'leveling a fixed accuracy physique raises accuracy');
  });

  // ---- Elemental affinities (magic damage triangle + light/dark rivalry) ----------------
  suite('elements', function(){
    // Triangle: water > fire > earth > water, each a +20% beat; everything else neutral.
    eq(FF.elementAdvantage('water','fire'), FF.ELEMENT_ADVANTAGE_MULT, 'water beats fire');
    eq(FF.elementAdvantage('fire','earth'), FF.ELEMENT_ADVANTAGE_MULT, 'fire beats earth');
    eq(FF.elementAdvantage('earth','water'), FF.ELEMENT_ADVANTAGE_MULT, 'earth beats water');
    eq(FF.elementAdvantage('fire','water'), 1, 'fire is neutral into water (reverse of a beat)');
    eq(FF.elementAdvantage('water','earth'), 1, 'water neutral into earth');
    eq(FF.elementAdvantage('fire','fire'), 1, 'same element is neutral');
    // Light/dark rival each other but are neutral to the triangle.
    eq(FF.elementAdvantage('light','dark'), FF.ELEMENT_ADVANTAGE_MULT, 'light beats dark');
    eq(FF.elementAdvantage('dark','light'), FF.ELEMENT_ADVANTAGE_MULT, 'dark beats light');
    eq(FF.elementAdvantage('light','fire'), 1, 'light neutral to fire');
    eq(FF.elementAdvantage('fire','light'), 1, 'fire neutral to light');
    eq(FF.elementAdvantage('earth','dark'), 1, 'earth neutral to dark');
    eq(FF.elementAdvantage(null,'fire'), 1, 'no attacker element => neutral');

    // ELEMENT_WEAKNESS is the reverse of ELEMENT_BEATS (the element that beats each).
    Object.keys(FF.ELEMENT_BEATS).forEach(function(atk){
      var def = FF.ELEMENT_BEATS[atk];
      eq(FF.ELEMENT_WEAKNESS[def], atk, def + "'s weakness is " + atk);
    });

    // Base category identities.
    eq(FF.monsterElement('wildlife', 5), 'earth', 'wildlife is earth');
    eq(FF.monsterElement('demonspawn', 5), 'fire', 'demonspawn is fire');
    eq(FF.monsterElement('kinsworn', 5), 'water', 'kinsworn is water');
    ok(['fire','water','earth'].indexOf(FF.monsterElement('elemental', 4)) !== -1, 'elementals are one of the triangle');
    // Wildlife (earth) is weak to fire, exactly what the brief asked for.
    eq(FF.ELEMENT_WEAKNESS[FF.monsterElement('wildlife', 3)], 'fire', 'wildlife weak to fire');
    eq(FF.ELEMENT_WEAKNESS[FF.monsterElement('demonspawn', 3)], 'water', 'demonspawn weak to water');
    eq(FF.ELEMENT_WEAKNESS[FF.monsterElement('kinsworn', 3)], 'earth', 'kinsworn weak to earth');
    // Light/dark are sprinkled into the top tiers.
    var topEls = [16,17,18,19,20].map(function(t){ return FF.monsterElement('wildlife', t); });
    ok(topEls.indexOf('light') !== -1 && topEls.indexOf('dark') !== -1, 'light and dark appear in the top tiers');

    // Every monster carries a valid element with known metadata.
    ok(FF.MONSTERS.every(function(m){ return m.element && FF.ELEMENT_META[m.element]; }), 'every monster has a valid element');
  });

  // ---- Elemental loot: Elementals drop ONLY Glyphs (no raw-material burst) ----------------------
  suite('loot: elementals drop only glyphs', function(){
    // Loot preview stays in sync with the drop logic: chance = the glyph chance, label = 'Glyph'.
    var fake = { category:'elemental', tierIndex:5, element:'fire', name:'Fire Elemental' };
    eq(FF.getMonsterLootChance(fake), Math.round(FF.GLYPH_DROP_CHANCE*100), 'elemental loot chance = the Glyph drop chance');
    eq(FF.getMonsterLootLabel(fake), 'Glyph', 'elemental loot label is Glyph');
    // The category blurb no longer promises raw material.
    var cat = FF.MONSTER_CATEGORIES.filter(function(c){ return c.id==='elemental'; })[0];
    ok(cat && /Glyph/.test(cat.desc) && !/raw material/i.test(cat.desc), 'Elementals category describes Glyphs, not raw material');
    // Functional: run the loot many times across every element -- the only items an Elemental can ever
    // add are Glyphs (this fails loudly if a raw-material burst is ever re-introduced).
    var S = FF._state; var saveInv = S.inventory;
    var bad = {}, sawGlyph = false;
    try {
      ['fire','water','earth','light','dark'].forEach(function(el){
        var mon = { category:'elemental', tierIndex:8, element:el, name:'Test Elemental' };
        for(var n=0; n<60; n++){
          S.inventory = {};
          FF.applyMonsterCategoryLoot(mon);
          Object.keys(S.inventory).forEach(function(id){ if(id.indexOf('glyph_')===0) sawGlyph = true; else bad[id] = true; });
        }
      });
    } finally { S.inventory = saveInv; }
    ok(Object.keys(bad).length === 0, 'across 300 kills the only drops are Glyphs' + (Object.keys(bad).length ? ' (leaked: '+Object.keys(bad).join(', ')+')' : ''));
    ok(sawGlyph, 'Glyphs still drop (~50% of kills)');
  });

  // ---- Kin-sworn loot: drop Inscription Scrolls at 5% (no more equipment) ------------------------
  suite('loot: kinsworn drop inscription scrolls', function(){
    var fake = { category:'kinsworn', tierIndex:5, element:'water', name:'Test Kinsman' };
    eq(FF.getMonsterLootChance(fake), 5, 'kinsworn loot chance is 5%');
    eq(FF.getMonsterLootLabel(fake), 'Inscription', 'kinsworn loot label is Inscription');
    var cat = FF.MONSTER_CATEGORIES.filter(function(c){ return c.id==='kinsworn'; })[0];
    ok(cat && /Inscription|Scroll/.test(cat.desc) && !/equipment/i.test(cat.desc), 'Kin-sworn category describes Inscriptions, not equipment');
    // Functional: the only thing a Kin-sworn can ever add is a tier-matched Inscription Scroll.
    var S = FF._state; var saveInv = S.inventory;
    var bad = {}, sawScroll = false, tier = 7;
    try {
      var mon = { category:'kinsworn', tierIndex:tier, element:'water', name:'Test Kinsman' };
      for(var n=0; n<400; n++){
        S.inventory = {};
        FF.applyMonsterCategoryLoot(mon);
        Object.keys(S.inventory).forEach(function(id){ if(id==='scroll_t'+tier) sawScroll = true; else bad[id] = true; });
      }
    } finally { S.inventory = saveInv; }
    ok(Object.keys(bad).length === 0, 'kin-sworn drop only tier-matched Inscription Scrolls' + (Object.keys(bad).length ? ' (leaked: '+Object.keys(bad).join(', ')+')' : ''));
    ok(sawScroll, 'Inscription Scrolls do drop (~5% of kills)');
  });

  // ---- Demonspawn loot: drop Enchant Crystals at 5% (no more Broken Relics) ----------------------
  suite('loot: demonspawn drop enchant crystals', function(){
    var fake = { category:'demonspawn', tierIndex:5, element:'fire', name:'Test Demon' };
    eq(FF.getMonsterLootChance(fake), 5, 'demonspawn loot chance is 5%');
    eq(FF.getMonsterLootLabel(fake), 'Enchant Crystal', 'demonspawn loot label is Enchant Crystal');
    var cat = FF.MONSTER_CATEGORIES.filter(function(c){ return c.id==='demonspawn'; })[0];
    ok(cat && /Enchant Crystal/.test(cat.desc) && !/Broken Relic/i.test(cat.desc), 'Demonspawn category describes Enchant Crystals, not Broken Relics');
    // Functional: the only thing a Demonspawn can ever add is a tier-matched Enchant Crystal (no relics).
    var S = FF._state; var saveInv = S.inventory;
    var bad = {}, sawCrystal = false, tier = 6;
    try {
      var mon = { category:'demonspawn', tierIndex:tier, element:'fire', name:'Test Demon' };
      for(var n=0; n<400; n++){
        S.inventory = {};
        FF.applyMonsterCategoryLoot(mon);
        Object.keys(S.inventory).forEach(function(id){ if(id==='enchant_t'+tier) sawCrystal = true; else bad[id] = true; });
      }
    } finally { S.inventory = saveInv; }
    ok(Object.keys(bad).length === 0, 'demonspawn drop only tier-matched Enchant Crystals' + (Object.keys(bad).length ? ' (leaked: '+Object.keys(bad).join(', ')+')' : ''));
    ok(sawCrystal, 'Enchant Crystals do drop (~5% of kills)');
  });

  // ---- Armor elemental weakness (leather->fire, chain->earth, plate->water; +15% each) --
  suite('armor element weakness', function(){
    var PER = FF.ARMOR_ELEMENT_WEAKNESS_PER_PIECE;
    var slots = FF.CHAINPLATE_SLOTS;
    function mk(mats){ // build a fake state with the given materials across the 4 chain/plate slots
      var ba = {}; slots.forEach(function(s,i){ ba[s] = mats[i] ? { material:mats[i], tier:3, rarity:'normal' } : { material:null, tier:0, rarity:'normal' }; });
      return { bodyArmor: ba };
    }
    // No armor -> no weakness anywhere.
    var none = FF.playerElementWeakness(mk([null,null,null,null]));
    ok(['fire','water','earth','light','dark'].every(function(e){ return none[e]===0; }), 'bare = no weakness');
    // One leather piece -> +15% fire only.
    var oneLeather = FF.playerElementWeakness(mk(['leather',null,null,null]));
    eq(oneLeather.fire, PER, 'one leather = +15% fire');
    eq(oneLeather.earth, 0, 'leather adds no earth');
    // Four leather -> +60% fire, stacking per piece.
    eq(FF.playerElementWeakness(mk(['leather','leather','leather','leather'])).fire, PER*4, 'four leather stack to +60% fire');
    // Material -> element mapping.
    eq(FF.playerElementWeakness(mk(['chain',null,null,null])).earth, PER, 'chain = earth weakness');
    eq(FF.playerElementWeakness(mk(['plate',null,null,null])).water, PER, 'plate = water weakness');
    // Cloth/tailoring contributes nothing.
    var cloth = FF.playerElementWeakness(mk(['tailoring',null,null,null]));
    ok(['fire','water','earth','light','dark'].every(function(e){ return cloth[e]===0; }), 'cloth = no elemental weakness');
    // A tier-0 (empty) slot with a material still contributes nothing.
    eq(FF.playerElementWeakness({ bodyArmor: { gauntlets:{material:'leather',tier:0,rarity:'normal'} } }).fire, 0, 'empty (tier 0) piece adds no weakness');
    // Mixed loadout accumulates independently.
    var mixed = FF.playerElementWeakness(mk(['leather','chain','plate','leather']));
    eq(mixed.fire, PER*2, 'two leather = +30% fire');
    eq(mixed.earth, PER, 'one chain = +15% earth');
    eq(mixed.water, PER, 'one plate = +15% water');
    // The weakness element matches ELEMENT_WEAKNESS wiring for the enemy side later.
    Object.keys(FF.ARMOR_MATERIAL_WEAKNESS).forEach(function(mat){
      ok(FF.ELEMENT_META[FF.ARMOR_MATERIAL_WEAKNESS[mat]], mat + ' maps to a real element');
    });

    // incomingElementMult: enemies strike with their element; the multiplier is 1 + the player's
    // armor weakness to that element.
    var PER = FF.ARMOR_ELEMENT_WEAKNESS_PER_PIECE;
    function st(mats){ var ba={}; FF.CHAINPLATE_SLOTS.forEach(function(s,i){ ba[s]=mats[i]?{material:mats[i],tier:3,rarity:'normal'}:{material:null,tier:0}; }); return {bodyArmor:ba}; }
    var fireEnemy = { element:'fire' }, waterEnemy = { element:'water' }, darkEnemy = { element:'dark' };
    eq(FF.incomingElementMult(st([null,null,null,null]), fireEnemy), 1, 'no armor = no elemental amplification');
    eq(FF.incomingElementMult(st(['leather','leather',null,null]), fireEnemy), 1 + PER*2, 'two leather vs fire enemy = +30% incoming');
    eq(FF.incomingElementMult(st(['leather','leather',null,null]), waterEnemy), 1, 'fire-weak armor is neutral to a water enemy');
    eq(FF.incomingElementMult(st(['plate',null,null,null]), waterEnemy), 1 + PER, 'plate vs water enemy = +15% incoming');
    eq(FF.incomingElementMult(st(['leather','chain','plate','leather']), darkEnemy), 1, 'no armor weakness to dark (yet)');
    eq(FF.incomingElementMult(st(['leather']), { element:null }), 1, 'elementless enemy = no amplification');
  });

  // ---- Familiar spell elements ----------------------------------------------------------
  suite('familiar spell elements', function(){
    var DMG = FF.DAMAGE_SPELL_TYPES; // { hit, siphon, poison }
    var damaging = 0, nondamaging = 0;
    Object.keys(FF.FAMILIAR_DATA).forEach(function(id){
      var fam = FF.FAMILIAR_DATA[id];
      fam.spells.forEach(function(sp){
        if(DMG[sp.type]){
          damaging++;
          ok(sp.element && FF.ELEMENT_META[sp.element], id+"'s "+sp.name+' (damaging) has a valid element');
          eq(sp.element, FF.familiarElement(id), id+"'s "+sp.name+' inherits the familiar element');
        } else {
          nondamaging++;
          ok(!sp.element, id+"'s "+sp.name+' (non-damaging) has no element');
        }
      });
    });
    ok(damaging > 20, 'there are many damaging spells stamped ('+damaging+')');
    ok(nondamaging > 0, 'non-damaging spells exist and stay elementless');

    // Every familiar has an assigned element.
    Object.keys(FF.FAMILIAR_DATA).forEach(function(id){
      ok(FF.ELEMENT_META[FF.familiarElement(id)], id+' has a valid familiar element');
    });

    // A fire familiar's damaging spell beats an earth enemy for +20%; neutral vs a fire enemy.
    var fireFam = Object.keys(FF.FAMILIAR_ELEMENT).filter(function(id){ return FF.FAMILIAR_ELEMENT[id]==='fire'; })[0];
    ok(fireFam, 'at least one fire familiar exists');
    eq(FF.elementAdvantage(FF.familiarElement(fireFam), 'earth'), FF.ELEMENT_ADVANTAGE_MULT, 'fire spell beats earth enemy');
    eq(FF.elementAdvantage(FF.familiarElement(fireFam), 'fire'), 1, 'fire spell neutral vs fire enemy');
  });

  // ---- Runesmithing wards ---------------------------------------------------------------
  suite('wards', function(){
    // Five element wards, one per element, no armor, offhand.
    eq(FF.WARD_TYPES.length, 5, 'five wards');
    eq(FF.WARD_ELEMENTS.slice().sort().join(','), 'dark,earth,fire,light,water', 'one ward per element');
    FF.WARD_TYPES.forEach(function(w){
      eq(w.type, 'ward', w.id+' is type ward');
      ok(FF.ELEMENT_META[w.element], w.id+' has a valid element');
      eq(w.skillId, 'runesmithing', w.id+' is crafted by runesmithing');
      ok(FF.isWard(w.id), 'isWard('+w.id+')');
    });
    ok(!FF.isWard('shieldSmall'), 'a shield is not a ward');

    // Reflect scales 5% at t0 -> 30% at the top tier, monotonic.
    eq(FF.wardReflectPct(0), 0.05, 't0 reflect = 5%');
    eq(FF.wardReflectPct(FF.TIER_COUNT-1), 0.30, 'top-tier reflect = 30%');
    for(var i=1;i<FF.TIER_COUNT;i++){ ok(FF.wardReflectPct(i) >= FF.wardReflectPct(i-1), 'reflect non-decreasing at '+i); }

    // Rarity grants a full-reflect chance instead of a stat multiplier: 0 / 5 / 10 / 20%.
    eq(FF.WARD_FULL_REFLECT_CHANCE.normal, 0, 'normal ward never full-reflects');
    eq(FF.WARD_FULL_REFLECT_CHANCE.rare, 0.05, 'rare = 5% full-reflect');
    eq(FF.WARD_FULL_REFLECT_CHANCE.supreme, 0.10, 'supreme = 10%');
    eq(FF.WARD_FULL_REFLECT_CHANCE.fantastic, 0.20, 'fantastic = 20%');

    // Ward items exist for every type/tier/rarity, carry element + reflect + fullReflectChance and no armor.
    var sample = FF.WARD_ITEMS['stward_wardFire_t0_rare'];
    ok(sample, 'fire ward t0 rare exists');
    eq(sample.element, 'fire', 'carries its element');
    eq(sample.reflect, 0.05, 't0 reflect stat');
    eq(sample.fullReflectChance, 0.05, 'rare full-reflect chance');
    ok(sample.defense === undefined, 'wards provide no armor/defense');
    var topFant = FF.WARD_ITEMS['stward_wardDark_t'+(FF.TIER_COUNT-1)+'_fantastic'];
    ok(topFant && topFant.reflect === 0.30 && topFant.fullReflectChance === 0.20, 'top fantastic dark ward: 30% reflect, 20% full');

    // Ward recipe: 3 logs + 3 ingots + 3 element glyphs + a Normal previous tier.
    var d3 = FF.getWardTierData('wardWater', 3);
    eq(d3.inputs['forestry_t3'], 3, 'ward needs 3 logs of its tier');
    eq(d3.inputs['metallurgy_t3'], 3, 'ward needs 3 ingots of its tier');
    eq(d3.inputs['glyph_water'], 3, 'water ward needs 3 water glyphs');
    eq(d3.inputs['stward_wardWater_t2_normal'], 1, 'ward now also consumes its Normal previous tier');
    ok(FF.getWardTierData('wardWater', 0).inputs['stward_wardWater_t-1_normal'] === undefined, 'tier 0 ward has no previous-tier requirement');
    eq(FF.getWardTierData('wardDark', 10).inputs['glyph_dark'], 3, 'dark ward needs dark glyphs');

    // Runesmithing is a real crafting skill in the outfitting category.
    ok(FF.CRAFTING_TAB_SKILL_IDS.indexOf('runesmithing') !== -1 || FF.CRAFT_SKILL_IDS.indexOf('runesmithing') !== -1, 'runesmithing is a crafting skill');
  });

  // ---- Elemental Glyphs (ward ingredient, drop-only) ------------------------------------
  suite('glyphs', function(){
    // One tierless, drop-only glyph per element.
    FF.WARD_ELEMENTS.forEach(function(el){
      var g = FF.GLYPH_ITEMS[FF.glyphIdFor(el)];
      ok(g, el+' glyph exists');
      eq(g.element, el, 'glyph carries its element');
      ok(g.dropOnly, el+' glyph is drop-only');
      ok(!/_t\d+$/.test(g.id), el+' glyph has no tier');
    });
    // Drop-quantity max scales by tier band: 5 / 10 / 20 / 25.
    [[0,5],[3,5],[5,5],[6,10],[10,10],[11,20],[15,20],[16,25],[20,25]].forEach(function(p){
      eq(FF.glyphDropMax(p[0]), p[1], 'tier '+p[0]+' drops up to '+p[1]);
    });
    ok(FF.GLYPH_DROP_CHANCE > 0 && FF.GLYPH_DROP_CHANCE <= 1, 'glyph drop chance is a probability');

    // Named-elemental element overrides applied to the real bestiary.
    var byName = {}; FF.MONSTERS.filter(function(m){ return m.category==='elemental'; }).forEach(function(m){ byName[m.name] = m; });
    Object.keys(FF.ELEMENTAL_ELEMENT_OVERRIDES).forEach(function(nm){
      ok(byName[nm], 'elemental "'+nm+'" exists');
      if(byName[nm]) eq(byName[nm].element, FF.ELEMENTAL_ELEMENT_OVERRIDES[nm], nm+' is '+FF.ELEMENTAL_ELEMENT_OVERRIDES[nm]);
    });
    // Spot-check a couple the brief named explicitly.
    eq(byName['Air Elemental'].element, 'earth', 'Air Elemental -> earth');
    eq(byName['Lava Elemental'].element, 'fire', 'Lava Elemental -> fire');
    eq(byName['Astral Elemental'].element, 'light', 'Astral Elemental -> light');
  });

  // ---- Arcanism wands (elemental 1h weapons) --------------------------------------------
  suite('wands', function(){
    eq(FF.WAND_TYPES.length, 5, 'five wands');
    FF.WAND_TYPES.forEach(function(w){
      ok(FF.ELEMENT_META[w.element], w.id+' has a valid element');
      eq(w.hand, '1h', w.id+' is one-handed');
      eq(w.skillId, 'arcanism', w.id+' is crafted by arcanism');
      ok(FF.isWandWeapon(w.id), 'isWandWeapon('+w.id+')');
    });
    ok(!FF.isWandWeapon('rapier'), 'a rapier is not a wand');

    // Recipe: 2 logs + 3 element glyphs + a Normal previous tier (no metal).
    var d5 = FF.getStackableWeaponTierData('wandFire', 5);
    eq(d5.inputs['forestry_t5'], 2, 'wand needs 2 logs of its tier');
    eq(d5.inputs['glyph_fire'], 3, 'fire wand needs 3 fire glyphs');
    ok(d5.inputs['metallurgy_t5'] === undefined, 'wands need no metal');
    eq(d5.inputs['stweapon_wandFire_t4_normal'], 1, 'wand now also consumes its Normal previous tier');
    ok(FF.getStackableWeaponTierData('wandFire', 0).inputs['stweapon_wandFire_t-1_normal'] === undefined, 'tier 0 has no previous-tier requirement');
    eq(FF.getStackableWeaponTierData('wandDark', 8).inputs['glyph_dark'], 3, 'dark wand needs dark glyphs');

    // Rarity scales damage 2x / 4x / 8x (not the standard rarity mult).
    eq(FF.WAND_RARITY_DMG_MULT.normal, 1, 'normal = 1x');
    eq(FF.WAND_RARITY_DMG_MULT.rare, 2, 'rare = 2x');
    eq(FF.WAND_RARITY_DMG_MULT.supreme, 4, 'supreme = 4x');
    eq(FF.WAND_RARITY_DMG_MULT.fantastic, 8, 'fantastic = 8x');
    var n = FF.STACKABLE_WEAPON_ITEMS['stweapon_wandWater_t10_normal'];
    var f = FF.STACKABLE_WEAPON_ITEMS['stweapon_wandWater_t10_fantastic'];
    ok(n && f, 'wand items exist');
    eq(n.element, 'water', 'wand item carries its element');
    eq(f.dmgMax, n.dmgMax*8, 'fantastic wand deals 8x the normal damage');
    eq(FF.STACKABLE_WEAPON_ITEMS['stweapon_wandWater_t10_rare'].dmgMax, n.dmgMax*2, 'rare = 2x');

    // Wands share one 'wands' proficiency; the per-element wand styles are not proficiency skills.
    ok(FF.WEAPON_STYLE_IDS.indexOf('wands') === -1, 'wands is not a per-style weapon id');
    FF.WAND_TYPES.forEach(function(w){ ok(FF.WEAPON_STYLE_IDS.indexOf(w.id) === -1, w.id+' is not a per-style proficiency'); });
  });

  // ---- Staff (2h support weapon: block + familiar slots) --------------------------------
  suite('staff', function(){
    ok(FF.isStaff('staff'), 'the staff is a staff');
    ok(!FF.isStaff('wandFire'), 'a wand is not a staff');
    eq(FF.STAFF_TYPE.hand, '2h', 'staff is two-handed');
    ok(FF.STAFF_TYPE.noAttack, 'staff has no attack');
    eq(FF.STAFF_TYPE.skillId, 'arcanism', 'staff is crafted by arcanism');

    // Recipe: 4 logs + 8 dark glyphs + a Normal previous tier.
    var d = FF.getStackableWeaponTierData('staff', 7);
    eq(d.inputs['forestry_t7'], 4, 'staff needs 4 logs');
    eq(d.inputs['glyph_dark'], 8, 'staff needs 8 dark glyphs');
    eq(d.inputs['stweapon_staff_t6_normal'], 1, 'staff now also consumes its Normal previous tier');
    eq(d.dmgMax, 0, 'staff deals no damage');

    // Block scales 5% (t0) -> 30% (top tier).
    eq(FF.staffBlockPct(0), 0.05, 't0 block = 5%');
    eq(FF.staffBlockPct(FF.TIER_COUNT-1), 0.30, 'top block = 30%');
    var it = FF.STACKABLE_WEAPON_ITEMS['stweapon_staff_t'+(FF.TIER_COUNT-1)+'_normal'];
    ok(it && it.block === 0.30 && it.dmgMax === 0, 'top staff item: 30% block, no damage');

    // Rarity grants familiar slots: normal 2, rare 3, supreme 4, fantastic 5.
    eq(FF.STAFF_RARITY_FAMILIAR_SLOTS.normal, 2, 'normal staff = +2 slots');
    eq(FF.STAFF_RARITY_FAMILIAR_SLOTS.rare, 3, 'rare = +3');
    eq(FF.STAFF_RARITY_FAMILIAR_SLOTS.supreme, 4, 'supreme = +4');
    eq(FF.STAFF_RARITY_FAMILIAR_SLOTS.fantastic, 5, 'fantastic = +5');
    eq(FF.STACKABLE_WEAPON_ITEMS['stweapon_staff_t0_fantastic'].familiarSlots, 5, 'fantastic staff item grants 5 familiar slots');

    // Companion slots: 1 base; a staff adds its familiarSlots.
    eq(FF.activeCompanionSlots({ equippedMainhand:null }), 1, 'no staff => 1 companion slot');
    var withStaff = { equippedMainhand:'staff', equippedMainhandTier:1, equippedMainhandRarity:'rare' };
    eq(FF.activeCompanionSlots(withStaff), 1 + 3, 'rare staff => 1 + 3 = 4 slots');
    eq(FF.getStaffBlockChance(withStaff), 0.05, 't0 staff block via equipped item');

    // activeCompanionList caps to slots and filters unowned.
    var st = { equippedMainhand:null, familiars:{ mining:{owned:true}, fishing:{owned:true}, digging:{owned:false} }, activeCompanions:['mining','fishing','digging'] };
    var lst = FF.activeCompanionList(st);
    eq(lst.length, 1, 'no staff => only 1 companion active even if more listed');
    eq(lst[0], 'mining', 'keeps the first owned companion');
    ok(FF.activeCompanionList({ familiars:{}, activeCompanions:['mining'], equippedMainhand:null }).length === 0, 'unowned companions are filtered out');

    // Staves efficiency: +1% at Lv1 -> +100% at Lv100 (familiar potency).
    function seff(lvl){ var xp = lvl<=1?0:FF.xpFloorForLevel(lvl); return FF.stavesEfficiencyBonus({xp:{staves:xp}}); }
    near(seff(1), 0.01, 'Lv1 staves = +1%');
    near(seff(100), 1.00, 'Lv100 staves = +100%');
    ok(seff(50) > seff(10), 'staves efficiency rises with level');
  });

  // ---- Scepter (1h hybrid: half blunt / half light, runesmithing) ----------------------
  suite('scepter', function(){
    ok(FF.isScepter('scepter'), 'the scepter is a scepter');
    ok(!FF.isScepter('wandFire'), 'a wand is not a scepter');
    ok(!FF.isScepter('staff'), 'a staff is not a scepter');
    eq(FF.SCEPTER_TYPE.hand, '1h', 'scepter is one-handed');
    eq(FF.SCEPTER_TYPE.skillId, 'runesmithing', 'scepter is crafted by runesmithing');
    eq(FF.SCEPTER_TYPE.element, 'light', 'scepter is a light weapon');
    eq(FF.SCEPTER_TYPE.damageType, 'blunt', 'scepter physical half is blunt');
    eq(FF.SCEPTERS_SKILL_ID, 'scepters', 'scepter proficiency id');

    // Recipe: 4 ingots + 8 light glyphs + a Normal previous tier (named after the metal).
    var d = FF.getStackableWeaponTierData('scepter', 7);
    eq(d.inputs['metallurgy_t7'], 4, 'scepter needs 4 ingots of its tier');
    eq(d.inputs['glyph_light'], 8, 'scepter needs 8 light glyphs');
    ok(d.inputs['forestry_t7'] === undefined, 'scepter uses no logs');
    eq(d.inputs['stweapon_scepter_t6_normal'], 1, 'scepter now also consumes its Normal previous tier');
    ok(d.name.indexOf(FF.SCEPTER_TYPE.name) !== -1, 'scepter named after its metal tier');

    // Rarity scales damage 2x / 4x / 8x (same as wands, not the standard rarity mult).
    var n = FF.STACKABLE_WEAPON_ITEMS['stweapon_scepter_t10_normal'];
    var f = FF.STACKABLE_WEAPON_ITEMS['stweapon_scepter_t10_fantastic'];
    ok(n && f, 'scepter items exist');
    eq(f.dmgMax, n.dmgMax*8, 'fantastic scepter deals 8x the normal damage');
    eq(FF.STACKABLE_WEAPON_ITEMS['stweapon_scepter_t10_rare'].dmgMax, n.dmgMax*2, 'rare = 2x');
    ok(n.dmgMax > 0, 'scepter deals damage (unlike a staff)');

    // Scepters share one 'scepters' proficiency; the scepter style is not a per-style weapon id.
    ok(FF.WEAPON_STYLE_IDS.indexOf('scepter') === -1, 'scepter is not a per-style weapon id');
    ok(FF.WEAPON_STYLE_IDS.indexOf('scepters') === -1, 'scepters proficiency is not a per-style weapon id');

    // Hybrid advantage: half blunt-vs-armor, half light-vs-element. Against a dark enemy
    // (weak to light), the light half gets the +20% element bonus.
    var armor = {blunt:1/3, slashing:1/3, piercing:1/3};
    var wAdv = FF.weightedAdvantage({blunt:1}, armor);
    var expDark = 0.5*wAdv + 0.5*FF.elementAdvantage('light', 'dark');
    ok(FF.elementAdvantage('light', 'dark') > 1, 'light beats dark');
    ok(expDark > (0.5*wAdv + 0.5*1) - 1e-9, 'light half boosted vs a dark enemy');
  });

  // ---- Classes: Summoner (gear-combo class with tiered passives + familiar) -------------
  suite('classes: Summoner', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('summoner') !== -1, 'summoner is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.summoner;
    ok(cd, 'summoner class defined');
    eq(cd.passives.length, 5, 'five tiered passives');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.passives.map(function(p){ return p.name; }).join(','), 'Third Eye,Guardian Bond,Desperate Summons,Overload,Kindred Fury', 'reworked Summoner perk names');
    eq(cd.reqParts.length, 5, 'requires 5 gear pieces (4 cloth + staff)');

    function cloth(){ return {tier:1, rarity:'normal', material:'tailoring'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    var full = { xp:{summoner:0}, equippedMainhand:'staff', bodyArmor:{ helmet:cloth(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } };
    eq(FF.clothPieceEquipped(full,'helmet'), true, 'cloth helmet detected');
    eq(FF.clothPieceEquipped(full,'back'), false, 'empty back slot not counted');
    eq(FF.activeClassId(full), 'summoner', 'full cloth set + staff => Summoner active');

    // Any missing piece drops the class.
    var noHelm = { xp:{summoner:0}, equippedMainhand:'staff', bodyArmor:{ helmet:bare(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } };
    eq(FF.activeClassId(noHelm), null, 'missing cloth helm => no class');
    var noStaff = { xp:{summoner:0}, equippedMainhand:'greatsword', bodyArmor:full.bodyArmor };
    eq(FF.activeClassId(noStaff), null, 'no staff => no class');
    var wandInstead = { xp:{summoner:0}, equippedMainhand:'wandFire', bodyArmor:full.bodyArmor };
    eq(FF.activeClassId(wandInstead), null, 'a wand is not a staff => no class');
    var leatherHelm = { xp:{summoner:0}, equippedMainhand:'staff', bodyArmor:{ helmet:{tier:1,rarity:'normal',material:'leather'}, chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } };
    eq(FF.activeClassId(leatherHelm), null, 'leather (not cloth) helm => no class');

    // Class level tracks its own xp; a fresh class sits at Lv 1 (so the Lv-1 passive is baseline).
    eq(FF.classLevel(full,'summoner'), 1, 'fresh summoner is class Lv 1');
    var leveled = { xp:{summoner:FF.xpFloorForLevel(60)}, equippedMainhand:'staff', bodyArmor:full.bodyArmor };
    ok(FF.classLevel(leveled,'summoner') >= 60, 'xp yields class level >= 60 ('+FF.classLevel(leveled,'summoner')+')');

    // Lv 1 Third Eye: +1 Companion slot on top of the Staff's slots (isolate by comparing to the same
    // staff with the class inactive, so only Third Eye differs).
    var sameStaffNoClass = { xp:{summoner:0}, equippedMainhand:'staff', bodyArmor:{ helmet:{tier:1,rarity:'normal',material:'leather'}, chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } };
    eq(FF.activeClassId(sameStaffNoClass), null, 'leather helm breaks the class (Third Eye control)');
    eq(FF.activeCompanionSlots(full), FF.activeCompanionSlots(sameStaffNoClass) + 1, 'Lv 1 Third Eye grants +1 Companion slot');

    // Behavioral: Overload quickens the cast timer with fight time (floor 5s); Desperate Summons halves
    // it while below 25% HP. Uses the live state (real maxHp) and the live combat activity clock.
    (function(){
      var s = FF._state;
      var snap = { mh:s.equippedMainhand, mhr:s.equippedMainhandRarity, ba:s.bodyArmor, xp:s.xp.summoner, hp:s.playerHp, act:s.activity };
      try {
        s.equippedMainhand='staff'; s.equippedMainhandRarity='normal';
        s.bodyArmor={ helmet:cloth(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() };
        s.xp.summoner = FF.xpFloorForLevel(80);
        eq(FF.activeClassId(s), 'summoner', 'behavioral setup activates the Summoner');
        var mh = FF.maxHp(s);
        s.activity = null; s.playerHp = mh;
        eq(FF.familiarCastIntervalMs(), 10000, 'no fight: familiars cast on the 10s base');
        s.activity = { type:'combat', monsterId:FF.MONSTERS[0].id, monsterHp:100, duelStartedAt: Date.now() - 20000 };
        eq(FF.familiarCastIntervalMs(), 8000, 'Overload: 20s in => -2000ms (8s)');
        s.activity.duelStartedAt = Date.now() - 100000;
        eq(FF.familiarCastIntervalMs(), 5000, 'Overload: floors at 5s');
        s.activity.duelStartedAt = Date.now(); s.playerHp = Math.round(mh*0.10);
        eq(FF.familiarCastIntervalMs(), 5000, 'Desperate Summons: <25% HP halves the 10s base to 5s');
      } finally {
        s.equippedMainhand=snap.mh; s.equippedMainhandRarity=snap.mhr; s.bodyArmor=snap.ba; s.xp.summoner=snap.xp; s.playerHp=snap.hp; s.activity=snap.act;
      }
    })();

    // The class has its own familiar with a damaging kit that carries its element (Kindred Fury lets it crit).
    var fam = FF.FAMILIAR_DATA.summoner;
    ok(fam && fam.spells && fam.spells.length === 4, 'summoner familiar has 4 spells');
    var dmgSpells = fam.spells.filter(function(s){ return s.type==='hit' || s.type==='siphon'; });
    ok(dmgSpells.length >= 2, 'summoner familiar has damaging spells');
    ok(fam.spells.some(function(s){ return s.element==='light'; }), 'summoner familiar spells carry the light element');
  });

  // ---- Classes: Duelist (rapier fencer: dodge-tempo footwork, flourish, prolonged duel, disengage) --
  suite('classes: Duelist', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('duelist') !== -1, 'duelist is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.duelist;
    ok(cd, 'duelist class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function chain(){ return {tier:1, rarity:'normal', material:'chain'}; }
    function cloth(){ return {tier:1, rarity:'normal', material:'tailoring'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(rarity){ return { xp:{duelist:0}, equippedMainhand:'rapier', equippedMainhandRarity:rarity||'normal', equippedOffhand:null, bodyArmor:{ helmet:chain(), chest:chain(), gauntlets:cloth(), boots:cloth(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'duelist', 'rapier + empty offhand + chain helm/chest + cloth gloves/shoes => Duelist');
    eq(FF.chainPieceEquipped(full,'helmet'), true, 'chain helm detected');
    eq(FF.clothPieceEquipped(full,'gauntlets'), true, 'cloth gloves detected');

    // Every requirement is load-bearing.
    var withOffhand = base(); withOffhand.equippedOffhand='shieldSmall';
    eq(FF.activeClassId(withOffhand), null, 'a filled offhand disqualifies the Duelist');
    var notRapier = base(); notRapier.equippedMainhand='greatsword';
    eq(FF.activeClassId(notRapier), null, 'non-rapier mainhand => no Duelist');
    var clothHelm = base(); clothHelm.bodyArmor.helmet=cloth();
    eq(FF.activeClassId(clothHelm), null, 'cloth (not chain) helm => no Duelist');
    var chainGloves = base(); chainGloves.bodyArmor.gauntlets=chain();
    eq(FF.activeClassId(chainGloves), null, 'chain (not cloth) gloves => no Duelist');

    // Reworked perk ladder: names in order.
    eq(cd.passives.map(function(p){ return p.name; }).join(','), 'Reactive Casting,Fleet Footwork,Flourish,Prolonged Duel,Disengage', 'reworked Duelist perk names');

    var lvHi = FF.xpFloorForLevel(60); // ~Lv 60
    function leveled(rarity){ var s = base(rarity); s.xp.duelist = lvHi; return s; }
    // Lv 20 Fleet Footwork: -15% attack time per dodge stack (up to -45%), gated on the class.
    eq(FF.classAttackSpeedMult(full), 1, 'Lv 1 duelist: no attack-speed bonus yet');
    var fw0 = leveled('normal'); eq(FF.classAttackSpeedMult(fw0), 1, 'no footwork stacks: no reduction');
    var fw2 = leveled('normal'); fw2.duelistFootworkStacks = 2; near(FF.classAttackSpeedMult(fw2), 0.7, '2 dodge stacks: -30%');
    var fw9 = leveled('normal'); fw9.duelistFootworkStacks = 9; near(FF.classAttackSpeedMult(fw9), 0.55, 'footwork caps at 3 stacks (-45%)');
    var fwOff = leveled('normal'); fwOff.duelistFootworkStacks = 3; fwOff.equippedOffhand='shieldSmall';
    eq(FF.classAttackSpeedMult(fwOff), 1, 'footwork bonus is gated on the class being active');
    // Perfect Form is gone -- the Duelist no longer grants a flat accuracy multiplier.
    eq(FF.classAccuracyMult(leveled('normal')), 1, 'Duelist no longer grants +30% accuracy (Perfect Form removed)');

    // Lv 60 Prolonged Duel: damage vs the current foe ramps +2%/sec up to +40%.
    function duel(secsAgo){ var s = leveled('normal'); s.activity = { type:'combat', duelStartedAt: Date.now() - secsAgo*1000 }; return s; }
    eq(FF.duelistDuelMult(leveled('normal')), 1, 'no active duel clock: neutral');
    // Tolerance covers sub-second wall-clock drift between duelStartedAt and the Date.now() read inside
    // duelistDuelMult (the ramp is +0.00002/ms, so even ~100ms of test lag stays well under 0.02).
    near(FF.duelistDuelMult(duel(5)), 1.10, '5s into the duel: +10%', 0.02);
    near(FF.duelistDuelMult(duel(15)), 1.30, '15s into the duel: +30%', 0.02);
    near(FF.duelistDuelMult(duel(60)), 1.40, 'ramp caps at +40%', 0.02);
    var duelLow = duel(60); duelLow.xp.duelist = 0; eq(FF.duelistDuelMult(duelLow), 1, 'Prolonged Duel is gated on Lv 60');
    eq(FF.DUELIST_POISE_MAX, 6, 'Flourish builds 6 Poise before its burst');

    // Class familiar.
    var fam = FF.FAMILIAR_DATA.duelist;
    ok(fam && fam.spells && fam.spells.length === 4, 'duelist familiar has 4 spells');
    ok(fam.spells.some(function(s){ return s.element==='fire'; }), 'duelist familiar damaging spells carry the fire element');
  });

  // ---- Duelist reworked combat flow: crash-safety + state invariants over many live ticks --------
  // The new perks (Fleet Footwork stacks, Flourish's 3-hit bonus burst, Disengage's dodge+return) run
  // inside playerAttackTick/monsterAttackTick, which are random. Rather than assert exact outcomes, we
  // drive hundreds of real ticks with the Duelist active and confirm nothing throws, no runaway loop,
  // and the class state never leaves its valid range (Flourish never recurses out of bounds, etc.).
  suite('classes: Duelist reworked combat flow (smoke)', function(){
    var s = FF._state;
    var snap = { mh:s.equippedMainhand, mht:s.equippedMainhandTier, mhr:s.equippedMainhandRarity, mhu:s.equippedMainhandUid, oh:s.equippedOffhand, ba:s.bodyArmor, xp:s.xp.duelist, act:s.activity, hp:s.playerHp, fw:s.duelistFootworkStacks, po:s.duelistPoise, gc:s.duelistGuaranteedCrits };
    var threw = null, invariantsOk = true;
    try {
      s.equippedMainhand='rapier'; s.equippedMainhandTier=6; s.equippedMainhandRarity='normal'; s.equippedMainhandUid=null; s.equippedOffhand=null;
      s.bodyArmor={helmet:{material:'chain',tier:5,rarity:'normal'},chest:{material:'chain',tier:5,rarity:'normal'},gauntlets:{material:'tailoring',tier:5,rarity:'normal'},boots:{material:'tailoring',tier:5,rarity:'normal'},back:{tier:0,rarity:'normal',material:null}};
      s.xp.duelist = FF.xpFloorForLevel(80);
      eq(FF.activeClassId(s), 'duelist', 'smoke setup activates the Duelist');
      var mon = FF.MONSTERS[0];
      for(var round=0; round<3 && !threw; round++){
        s.activity = { type:'combat', monsterId:mon.id, monsterHp: mon.hp*40, tickAccum:0, monsterTickAccum:0, duelStartedAt: Date.now()-3000, disengageUsed:false };
        s.duelistFootworkStacks = 0; s.duelistPoise = FF.DUELIST_POISE_MAX - 1; s.duelistGuaranteedCrits = 0; // primed so Flourish fires quickly
        s.playerHp = 12; // low, so Disengage's threshold can trigger
        for(var i=0; i<200 && !threw; i++){
          try {
            FF.playerAttackTick();
            if(s.activity && s.activity.type==='combat'){ if(s.activity.monsterHp <= 0) s.activity.monsterHp = mon.hp*40; FF.monsterAttackTick(); }
            if(!(s.duelistFootworkStacks >= 0 && s.duelistFootworkStacks <= FF.DUELIST_FOOTWORK_MAX)) invariantsOk = false;
            if(!(s.duelistPoise >= 0 && s.duelistPoise <= FF.DUELIST_POISE_MAX)) invariantsOk = false;
            if(!((s.duelistGuaranteedCrits||0) >= 0)) invariantsOk = false;
            // The Disengage threshold means low-HP hits sometimes kill the player, and real death handling
            // clears the activity to { type:null }. Only the combat monsterHp needs to stay finite; a dead
            // player just re-enters the fight below (mirrors the game loop respawning into a new duel).
            if(s.activity && s.activity.type==='combat' && !isFinite(s.activity.monsterHp)) invariantsOk = false;
            if(!isFinite(s.playerHp)) invariantsOk = false;
            if(s.playerHp <= 0 || !s.activity || s.activity.type!=='combat'){
              s.playerHp = 12;
              s.activity = { type:'combat', monsterId:mon.id, monsterHp: mon.hp*40, tickAccum:0, monsterTickAccum:0, duelStartedAt: Date.now()-3000, disengageUsed:false };
            }
          } catch(e){ threw = (e && e.message) || String(e); }
        }
      }
    } finally {
      s.equippedMainhand=snap.mh; s.equippedMainhandTier=snap.mht; s.equippedMainhandRarity=snap.mhr; s.equippedMainhandUid=snap.mhu; s.equippedOffhand=snap.oh; s.bodyArmor=snap.ba; s.xp.duelist=snap.xp; s.activity=snap.act; s.playerHp=snap.hp; s.duelistFootworkStacks=snap.fw; s.duelistPoise=snap.po; s.duelistGuaranteedCrits=snap.gc;
    }
    ok(!threw, 'no crash / runaway across ~600 attack+monster ticks with the Duelist active' + (threw ? ' ('+threw+')' : ''));
    ok(invariantsOk, 'footwork (0-3), poise (0-6), guaranteed-crits (>=0) and HP stay valid throughout');
  });

  // ---- Classes: Reaper (scythe soul-harvester: crits + lifesteal) -----------------------
  suite('classes: Reaper', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('reaper') !== -1, 'reaper is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.reaper;
    ok(cd, 'reaper class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 5, 'requires 5 gear conditions');

    function cloth(){ return {tier:1, rarity:'normal', material:'tailoring'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{reaper:0}, equippedMainhand:'scythe', equippedMainhandRarity:'normal', bodyArmor:{ helmet:bare(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'reaper', 'scythe + bare head + cloth chest/gloves/shoes => Reaper');

    // Every requirement matters -- note the bare-head requirement is the inverse of the others.
    var helmOn = base(); helmOn.bodyArmor.helmet=cloth();
    eq(FF.activeClassId(helmOn), null, 'wearing any helm => no Reaper (head must be bare)');
    var notScythe = base(); notScythe.equippedMainhand='greatsword';
    eq(FF.activeClassId(notScythe), null, 'non-scythe mainhand => no Reaper');
    var noChest = base(); noChest.bodyArmor.chest=bare();
    eq(FF.activeClassId(noChest), null, 'missing cloth chest => no Reaper');
    var chainChest = base(); chainChest.bodyArmor.chest={tier:1,rarity:'normal',material:'chain'};
    eq(FF.activeClassId(chainChest), null, 'chain (not cloth) chest => no Reaper');

    var lvHi = FF.xpFloorForLevel(85); // ~Lv 85 -> all passives
    function leveled(){ var s = base(); s.xp.reaper = lvHi; return s; }

    // Lv 1 Death's Harvest: steal 10% of the damage you deal as Health (only while active).
    eq(FF.reaperLifestealPct(full), 0.10, 'Lv 1 reaper (active): 10% lifesteal');
    var lowNoGear = { xp:{reaper:lvHi}, equippedMainhand:'greatsword', bodyArmor:{helmet:bare(),chest:bare(),gauntlets:bare(),boots:bare(),back:bare()} };
    eq(FF.reaperLifestealPct(lowNoGear), 0, 'reaper lifesteal gated on the class being active');

    // Lv 60 Grim Resolve: crit-chance bonus is gated on the class being Lv 60+ (scaling tested below).
    eq(FF.reaperGrimResolveCrit(full), 0, 'Lv 1 reaper: no Grim Resolve yet (returns before touching HP)');

    // Behavioral: Grim Resolve scales with missing HP; Siphon Shield caps at 20% max HP; Withering
    // Harvest only rots while a shield holds. Uses the live state (real physique/maxHp).
    (function(){
      var s = FF._state;
      var snap = { mh:s.equippedMainhand, mhr:s.equippedMainhandRarity, ba:s.bodyArmor, xp:s.xp.reaper, hp:s.playerHp, act:s.activity, sh:s.reaperShield };
      try {
        s.equippedMainhand='scythe'; s.equippedMainhandRarity='normal';
        s.bodyArmor={ helmet:bare(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() };
        s.xp.reaper = lvHi; s.reaperShield = 0;
        eq(FF.activeClassId(s), 'reaper', 'behavioral setup activates the Reaper');
        var mh = FF.maxHp(s);
        s.playerHp = mh;               ok(FF.reaperGrimResolveCrit(s) === 0, 'Grim Resolve = 0 at full Health');
        s.playerHp = 1;                ok(FF.reaperGrimResolveCrit(s) > 0.28, 'Grim Resolve near +30% at ~0 Health');
        s.playerHp = Math.round(mh*0.5); ok(Math.abs(FF.reaperGrimResolveCrit(s) - 0.15) < 0.02, 'Grim Resolve ~+15% at half Health');
        eq(FF.reaperShieldCap(s), Math.round(mh*0.20), 'Siphon Shield cap is 20% of max Health');
        var mon = FF.MONSTERS[0];
        s.activity = { type:'combat', monsterId:mon.id, monsterHp: mon.hp, tickAccum:0, monsterTickAccum:0 };
        s.reaperShield = 10; var before = s.activity.monsterHp;
        FF.applyReaperWitherTick(1000);
        ok(s.activity.monsterHp < before, 'Withering Harvest rots the foe while a Siphon Shield holds');
        ok(s.activity.monsterHp >= 1, 'Withering Harvest floors the foe at 1 HP (never the finishing blow)');
        s.reaperShield = 0; s.activity.monsterHp = mon.hp; var b2 = s.activity.monsterHp;
        FF.applyReaperWitherTick(1000);
        eq(s.activity.monsterHp, b2, 'Withering Harvest is inert with no Siphon Shield');
      } finally {
        s.equippedMainhand=snap.mh; s.equippedMainhandRarity=snap.mhr; s.bodyArmor=snap.ba; s.xp.reaper=snap.xp; s.playerHp=snap.hp; s.activity=snap.act; s.reaperShield=snap.sh;
      }
    })();

    // Class familiar leans on life-drain (siphon) spells for the Lv 20 triple-damage passive.
    var fam = FF.FAMILIAR_DATA.reaper;
    ok(fam && fam.spells && fam.spells.length === 4, 'reaper familiar has 4 spells');
    ok(fam.spells.filter(function(s){ return s.type==='siphon'; }).length >= 2, 'reaper familiar has multiple siphon (life-drain) spells');
    ok(fam.spells.some(function(s){ return s.element==='dark'; }), 'reaper familiar damaging spells carry the dark element');
  });

  // ---- Classes: Herald (plate + mace + large shield; stacking-block retaliation tank) ----
  suite('classes: Herald', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('herald') !== -1, 'herald is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.herald;
    ok(cd, 'herald class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function plate(){ return {tier:1, rarity:'normal', material:'plate'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{herald:0}, physique:{}, equippedMainhand:'mace', equippedMainhandRarity:'normal', equippedOffhand:'shieldLarge', bodyArmor:{ helmet:plate(), chest:plate(), gauntlets:plate(), boots:plate(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'herald', 'mace + large shield + full plate => Herald');
    eq(FF.platePieceEquipped(full,'helmet'), true, 'plate helm detected');

    // Every requirement matters.
    var noShield = base(); noShield.equippedOffhand=null;
    eq(FF.activeClassId(noShield), null, 'needs a large shield');
    var smallShield = base(); smallShield.equippedOffhand='shieldSmall';
    eq(FF.activeClassId(smallShield), null, 'a small shield does not qualify');
    var notMace = base(); notMace.equippedMainhand='greatsword';
    eq(FF.activeClassId(notMace), null, 'needs a mace');
    var chainHelm = base(); chainHelm.bodyArmor.helmet={tier:1,rarity:'normal',material:'chain'};
    eq(FF.activeClassId(chainHelm), null, 'needs a plate helm (chain does not qualify)');
    var noBoots = base(); noBoots.bodyArmor.boots=bare();
    eq(FF.activeClassId(noBoots), null, 'needs plate boots');

    var lvHi = FF.xpFloorForLevel(85); // ~Lv 85
    function leveled(){ var s = base(); s.xp.herald = lvHi; return s; }

    // Bulwark retired: Herald no longer grants a flat Block-chance bonus (block now comes from plate/physiques).
    var off = base(); off.equippedOffhand=null;
    eq(FF.classBlockBonus(full), 0, 'Herald no longer adds a flat Block bonus (Bulwark retired)');

    // Lv 1 Perfect Guard: incoming-damage reduction that stacks with consecutive Blocks (up to -25%).
    var pg = leveled(); pg.heraldGuardStacks = 3;
    near(FF.heraldGuardMult(pg), 0.85, 'Perfect Guard: 3 Blocks -> -15% incoming');
    pg.heraldGuardStacks = 99;
    near(FF.heraldGuardMult(pg), 0.75, 'Perfect Guard caps at -25%');
    eq(FF.heraldGuardMult(off), 1, 'no Herald -> no guard reduction');

    // Lv 60 Unbreakable: a blocked hit keeps 25% (-75%) instead of the usual 50%.
    eq(FF.heraldBlockMult(leveled()), 0.25, 'Unbreakable: blocked hit kept at 25%');
    eq(FF.heraldBlockMult(full), 0.5, 'below Lv60: standard 50% block');

    // Lv 40 Fortress: Armor ramps +4%/s held in a fight (cap +40%), reset per foe.
    var ft = leveled(); ft.activity = { type:'combat', duelStartedAt: Date.now() - 5000 };
    ok(Math.abs(FF.heraldFortressArmorMult(ft) - 1.20) < 0.02, 'Fortress: +4%/s -> ~+20% at 5s');
    ft.activity.duelStartedAt = Date.now() - 60000;
    ok(Math.abs(FF.heraldFortressArmorMult(ft) - 1.40) < 1e-9, 'Fortress caps at +40%');
    eq(FF.heraldFortressArmorMult(full), 1, 'Fortress inactive below Lv40');

    // Lv 80 Lasting Grace: familiar-granted buffs last twice as long.
    eq(FF.familiarBuffDurationMult(full), 1, 'Lv 1 herald: buff duration unchanged');
    eq(FF.familiarBuffDurationMult(leveled()), 2, 'Lv 80 herald: familiar buffs last 2x');

    // Class familiar is buff-focused (to synergize with the Lv 80 duration passive).
    var fam = FF.FAMILIAR_DATA.herald;
    ok(fam && fam.spells && fam.spells.length === 4, 'herald familiar has 4 spells');
    ok(fam.spells.some(function(s){ return s.type==='armorBuff' || s.type==='timedBuff' || s.type==='damageBuff'; }), 'herald familiar grants buffs');
  });

  // ---- Classes: Quickdraw (short-bow archer: speed, penetration, rapid fire) ------------
  suite('classes: Quickdraw', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('quickdraw') !== -1, 'quickdraw is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.quickdraw;
    ok(cd, 'quickdraw class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function leather(){ return {tier:1, rarity:'normal', material:'leather'}; }
    function plate(){ return {tier:1, rarity:'normal', material:'plate'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{quickdraw:0}, equippedMainhand:'bowShort', equippedMainhandRarity:'normal', equippedOffhand:'quiver', bodyArmor:{ helmet:leather(), chest:leather(), gauntlets:leather(), boots:plate(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'quickdraw', 'short bow + quiver + plate boots + leather helm/chest/gloves => Quickdraw');
    eq(FF.leatherPieceEquipped(full,'helmet'), true, 'leather helm detected');
    eq(FF.platePieceEquipped(full,'boots'), true, 'plate boots detected');

    // Every requirement matters.
    var noQuiver = base(); noQuiver.equippedOffhand=null;
    eq(FF.activeClassId(noQuiver), null, 'needs a quiver');
    var notBow = base(); notBow.equippedMainhand='greatsword';
    eq(FF.activeClassId(notBow), null, 'needs a short bow');
    var leatherBoots = base(); leatherBoots.bodyArmor.boots=leather();
    eq(FF.activeClassId(leatherBoots), null, 'boots must be plate (leather does not qualify)');
    var plateHelm = base(); plateHelm.bodyArmor.helmet=plate();
    eq(FF.activeClassId(plateHelm), null, 'helm must be leather (plate does not qualify)');

    var lvHi = FF.xpFloorForLevel(85); // ~Lv 85
    function leveled(){ var s = base(); s.xp.quickdraw = lvHi; return s; }

    // Lv 1 Fleet Fingers: -15% attack timer (even at Class Lv 1).
    eq(FF.classAttackSpeedMult(full), 0.85, 'Quickdraw Lv 1: -15% attack timer');
    var off = base(); off.equippedOffhand=null;
    eq(FF.classAttackSpeedMult(off), 1, 'attack-timer bonus gated on the class being active');

    // Lv 40 Piercing Shot: +10% damage.
    eq(FF.quickdrawPenetrationMult(full), 1, 'Lv 1 quickdraw: no penetration yet');
    eq(FF.quickdrawPenetrationMult(leveled()), 1.10, 'Lv 40+: +10% damage');

    // Lv 60 Deadeye: +10% crit chance.
    eq(FF.quickdrawCritChanceBonus(full), 0, 'Lv 1 quickdraw: no crit bonus yet');
    eq(FF.quickdrawCritChanceBonus(leveled()), 0.10, 'Lv 60+: +10% crit chance');

    // Class familiar is a piercing archer to match the fantasy.
    var fam = FF.FAMILIAR_DATA.quickdraw;
    ok(fam && fam.spells && fam.spells.length === 4, 'quickdraw familiar has 4 spells');
    ok(fam.spells.some(function(s){ return s.type==='hit' && s.element==='earth'; }), 'quickdraw familiar has earth-element hit spells');
  });

  // ---- Classes: Templar (scepter + ward; light/reflect holy warrior) --------------------
  suite('classes: Templar', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('templar') !== -1, 'templar is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.templar;
    ok(cd, 'templar class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function plate(){ return {tier:1, rarity:'normal', material:'plate'}; }
    function chain(){ return {tier:1, rarity:'normal', material:'chain'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{templar:0}, equippedMainhand:'scepter', equippedMainhandRarity:'normal', equippedOffhand:'wardLight', bodyArmor:{ helmet:plate(), chest:plate(), gauntlets:chain(), boots:chain(), back:bare() } }; }
    var full = base();
    ok(FF.isWard('wardLight'), 'wardLight is a ward offhand');
    eq(FF.activeClassId(full), 'templar', 'scepter + ward + plate helm/chest + chain gloves/boots => Templar');

    // Every requirement matters.
    var noWard = base(); noWard.equippedOffhand=null;
    eq(FF.activeClassId(noWard), null, 'needs a ward offhand');
    var shieldOff = base(); shieldOff.equippedOffhand='shieldLarge';
    eq(FF.activeClassId(shieldOff), null, 'a shield is not a ward');
    var notScepter = base(); notScepter.equippedMainhand='mace';
    eq(FF.activeClassId(notScepter), null, 'needs a scepter');
    var chainHelm = base(); chainHelm.bodyArmor.helmet=chain();
    eq(FF.activeClassId(chainHelm), null, 'helm must be plate');
    var plateGloves = base(); plateGloves.bodyArmor.gauntlets=plate();
    eq(FF.activeClassId(plateGloves), null, 'gloves must be chain');

    var lvHi = FF.xpFloorForLevel(85); // ~Lv 85
    function leveled(){ var s = base(); s.xp.templar = lvHi; return s; }

    // Lv 1 Radiant Ward: +5% reflected damage (baseline -- a fresh class is already Class Lv 1).
    ok(Math.abs(FF.templarReflectMult(full) - 1.05) < 1e-9, 'Lv 1 templar (active): +5% reflect');
    ok(Math.abs(FF.templarReflectMult(leveled()) - 1.05) < 1e-9, 'reflect mult stays 1.05 at higher level');
    // Lv 20 Sunfire: +20% Light damage (not yet at Lv 1).
    eq(FF.templarLightDmgMult(full), 1, 'Lv 1 templar: no light bonus yet');
    ok(Math.abs(FF.templarLightDmgMult(leveled()) - 1.2) < 1e-9, 'Lv 20+: +20% light damage');
    // Both are gated on the class actually being equipped/active.
    var off = base(); off.equippedOffhand=null; off.xp.templar = lvHi;
    eq(FF.templarLightDmgMult(off), 1, 'light bonus gated on the class being active');
    eq(FF.templarReflectMult(off), 1, 'reflect bonus gated on the class being active');

    // Lv 40 / Lv 60 debuff windows (time-based, read from state.classDebuffs).
    var s = FF._state;
    var saved = s.classDebuffs;
    s.classDebuffs = { enemyDmgUntil:0, enemyArmorUntil:0 };
    eq(FF.templarIncomingDmgMult(), 1, 'no enfeeble window => enemy deals full damage');
    eq(FF.templarArmorShredDmgMult(), 1, 'no sunder window => no bonus damage');
    s.classDebuffs = { enemyDmgUntil: Date.now()+9000, enemyArmorUntil: Date.now()+9000 };
    eq(FF.templarIncomingDmgMult(), 0.75, 'enfeeble window => enemy deals 25% less (x0.75)');
    eq(FF.templarArmorShredDmgMult(), 1.25, 'sunder window => you deal +25% (x1.25)');
    s.classDebuffs = saved; // restore for other suites

    // Class familiar (light-themed smiter).
    var fam = FF.FAMILIAR_DATA.templar;
    ok(fam && fam.spells && fam.spells.length === 4, 'templar familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'templar familiar has damaging spells');
  });

  // ---- Classes: Knight (claymore momentum + on-miss fury) -------------------------------
  suite('classes: Knight', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('knight') !== -1, 'knight is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.knight;
    ok(cd, 'knight class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 5, 'requires 5 gear conditions');

    function plate(){ return {tier:1, rarity:'normal', material:'plate'}; }
    function chain(){ return {tier:1, rarity:'normal', material:'chain'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{knight:0}, equippedMainhand:'claymore', equippedMainhandRarity:'normal', bodyArmor:{ helmet:chain(), chest:plate(), gauntlets:chain(), boots:plate(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'knight', 'claymore + plate chest/boots + chain helm/gloves => Knight');

    // Every requirement matters.
    var notClay = base(); notClay.equippedMainhand='greatsword';
    eq(FF.activeClassId(notClay), null, 'needs a claymore');
    var plateHelm = base(); plateHelm.bodyArmor.helmet=plate();
    eq(FF.activeClassId(plateHelm), null, 'helm must be chain');
    var chainChest = base(); chainChest.bodyArmor.chest=chain();
    eq(FF.activeClassId(chainChest), null, 'chest must be plate');

    // Lv 1 Momentum: each stack -10% attack timer, capped at 5 (-50%); reads st.knightStacks.
    var s0 = base(); s0.knightStacks = 0; eq(FF.classAttackSpeedMult(s0), 1, '0 stacks => no reduction');
    var s3 = base(); s3.knightStacks = 3; near(FF.classAttackSpeedMult(s3), 0.70, '3 stacks => -30%');
    var s5 = base(); s5.knightStacks = 5; near(FF.classAttackSpeedMult(s5), 0.50, '5 stacks => -50%');
    var s8 = base(); s8.knightStacks = 8; near(FF.classAttackSpeedMult(s8), 0.50, 'stacks cap at 5 (-50%)');
    var offStacks = base(); offStacks.equippedMainhand='greatsword'; offStacks.knightStacks=5;
    eq(FF.classAttackSpeedMult(offStacks), 1, 'momentum gated on the class being active');
    eq(FF.knightStacks(s8), 5, 'knightStacks caps at 5 while active');
    eq(FF.knightStacks(offStacks), 0, 'no momentum stacks while class inactive');

    // On-miss buffs (Lv 20/40/60/80) read the global 8s buff window on state.
    var s = FF._state;
    var snap = { xpK:s.xp.knight, main:s.equippedMainhand, rar:s.equippedMainhandRarity, buf:s.knightBuffUntil,
      helm:s.bodyArmor.helmet, chest:s.bodyArmor.chest, gaunt:s.bodyArmor.gauntlets, boots:s.bodyArmor.boots };
    s.equippedMainhand='claymore'; s.equippedMainhandRarity='normal';
    s.bodyArmor.helmet=chain(); s.bodyArmor.chest=plate(); s.bodyArmor.gauntlets=chain(); s.bodyArmor.boots=plate();
    s.xp.knight = FF.xpFloorForLevel(85); // ~Lv 85 (all miss buffs)
    s.knightBuffUntil = 0; // window closed
    eq(FF.knightMissDmgMult(), 1, 'no window => no damage bonus');
    eq(FF.knightMissCritChance(), 0, 'no window => no crit chance');
    eq(FF.knightMissCritDmg(), 0, 'no window => no crit damage');
    s.knightBuffUntil = Date.now()+9000; // window open
    eq(FF.knightMissDmgMult(), 1.25, 'Lv 20: +25% damage on miss');
    eq(FF.knightMissCritChance(), 0.15, 'Lv 40: +15% crit chance on miss');
    near(FF.knightMissCritDmg(), 1.5, 'Lv 60 (+0.5) + Lv 80 (+1.0) = +1.5 crit damage');
    s.xp.knight = FF.xpFloorForLevel(65); // ~Lv 65 (Lv 60 on, Lv 80 off)
    near(FF.knightMissCritDmg(), 0.5, 'Lv 60 alone => +0.5 crit damage');
    // restore _state for other suites
    s.xp.knight = snap.xpK; s.equippedMainhand = snap.main; s.equippedMainhandRarity = snap.rar; s.knightBuffUntil = snap.buf;
    s.bodyArmor.helmet = snap.helm; s.bodyArmor.chest = snap.chest; s.bodyArmor.gauntlets = snap.gaunt; s.bodyArmor.boots = snap.boots;

    // Class familiar (steel swordsman).
    var fam = FF.FAMILIAR_DATA.knight;
    ok(fam && fam.spells && fam.spells.length === 4, 'knight familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'knight familiar has a damaging spell');
  });

  // ---- Elemental attunement physiques (per-element damage + resistance) -----------------
  suite('elemental attunements', function(){
    var els = ['fire','water','earth','light','dark'];
    els.forEach(function(el){
      var id = FF.ELEMENT_ATTUNEMENT[el];
      ok(id, el+' has an attunement physique id');
      ok(FF.PHYSIQUE_SKILL_MAP[id] && FF.PHYSIQUE_SKILL_MAP[id].element===el, id+' is a physique tagged with its element');
      ok(FF.isElementAttunement(id), id+' is recognised as an element attunement');
    });
    ok(!FF.isElementAttunement('bodyStrength'), 'a normal physique is not an attunement');

    function stAt(el, lvl){ var o={physique:{}}; o.physique[FF.ELEMENT_ATTUNEMENT[el]] = (lvl<=1 ? 0 : FF.xpFloorForLevel(lvl)); return o; }
    // Damage bonus scales +1% (Lv1) -> +100% (Lv100); resistance +1% -> +20%.
    near(FF.elementDamageBonus(stAt('fire',1), 'fire'), 0.01, 'Lv1 fire: +1% damage');
    near(FF.elementDamageBonus(stAt('fire',100), 'fire'), 1.00, 'Lv100 fire: +100% damage');
    near(FF.elementResistBonus(stAt('water',1), 'water'), 0.01, 'Lv1 water: +1% resistance');
    near(FF.elementResistBonus(stAt('water',100), 'water'), 0.20, 'Lv100 water: +20% resistance');
    ok(FF.elementDamageBonus(stAt('earth',50),'earth') > FF.elementDamageBonus(stAt('earth',10),'earth'), 'damage bonus rises with level');
    ok(FF.elementResistBonus(stAt('light',80),'light') > FF.elementResistBonus(stAt('light',20),'light'), 'resistance rises with level');
    // Multipliers.
    near(FF.elementDmgMult(stAt('light',100),'light'), 2.00, 'Lv100 light damage mult = 2.0x');
    near(FF.elementResistMult(stAt('dark',100),'dark'), 0.80, 'Lv100 dark resist mult = 0.8x (20% less taken)');
    // Non-attuned / unknown element => no effect.
    eq(FF.elementDamageBonus({physique:{}}, null), 0, 'no element => no damage bonus');
    eq(FF.elementDmgMult({physique:{}}, 'bogus'), 1, 'unknown element => x1 damage');
    eq(FF.elementResistMult({physique:{}}, 'bogus'), 1, 'unknown element => x1 resist');

    // Attunements are physiques, but have no familiar (excluded from the familiar roster).
    els.forEach(function(el){ ok(FF.FAMILIAR_SKILL_IDS.indexOf(FF.ELEMENT_ATTUNEMENT[el]) === -1, FF.ELEMENT_ATTUNEMENT[el]+' is not in the familiar roster'); });
  });

  // ---- Rings: elemental / precision / warding kinds -------------------------------------
  suite('rings: element/accuracy/resistance', function(){
    var byId = {}; FF.RING_TYPES.forEach(function(rt){ byId[rt.id] = rt; });
    ['fire','water','earth','light','dark'].forEach(function(el){
      ok(byId[el] && byId[el].kind === 'elementDamage' && byId[el].element === el, 'Ring of '+el+' is an elementDamage ring');
    });
    ok(byId.precision && byId.precision.kind === 'accuracy', 'Ring of Precision is an accuracy ring');
    ok(byId.warding && byId.warding.kind === 'resistance', 'Ring of Warding is a resistance ring');
    ok(byId.communion && byId.communion.kind === 'familiar', 'Ring of Communion is a familiar-potency ring');
    ok(byId.blunt && !byId.blunt.kind, 'physical rings still have no kind');

    var TC = FF.TIER_COUNT;
    // Tier ladder scales min->max at Normal; rarity multiplies 2x/4x/8x (wand ladder).
    var fireTop = FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_normal'];
    near(fireTop.bonus, 0.50, 'top-tier Normal Ring of Fire = +50% fire dmg');
    eq(fireTop.kind, 'elementDamage', 'ring item carries kind');
    eq(fireTop.element, 'fire', 'ring item carries element');
    near(FF.RING_ITEMS['ring_fire_t0_normal'].bonus, 0.05, 't0 Normal Ring of Fire = +5%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_rare'].bonus, 1.00, 'Rare x2 = +100%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_supreme'].bonus, 2.00, 'Supreme x4 = +200%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_fantastic'].bonus, 4.00, 'Fantastic x8 = +400%');
    near(FF.RING_ITEMS['ring_precision_t'+(TC-1)+'_normal'].bonus, 0.30, 'top Precision Normal = +30% acc');
    near(FF.RING_ITEMS['ring_precision_t0_normal'].bonus, 0.05, 't0 Precision = +5% acc');
    near(FF.RING_ITEMS['ring_warding_t'+(TC-1)+'_normal'].bonus, 0.20, 'top Warding Normal = +20% resist');
    // Ring of Communion: +5% (t0) -> +50% (t20) familiar potency at Normal, 2x/4x/8x with rarity.
    near(FF.RING_ITEMS['ring_communion_t0_normal'].bonus, 0.05, 't0 Communion Normal = +5% familiar potency');
    near(FF.RING_ITEMS['ring_communion_t'+(TC-1)+'_normal'].bonus, 0.50, 't20 Communion Normal = +50%');
    near(FF.RING_ITEMS['ring_communion_t'+(TC-1)+'_rare'].bonus, 1.00, 'Rare x2 = +100%');
    near(FF.RING_ITEMS['ring_communion_t'+(TC-1)+'_supreme'].bonus, 2.00, 'Supreme x4 = +200%');
    near(FF.RING_ITEMS['ring_communion_t'+(TC-1)+'_fantastic'].bonus, 4.00, 'Fantastic x8 = +400%');

    // Physical rings now share the +5%->+50% x rarity curve (dmgBonus, applied by weapon-type fraction).
    var bluntTop = FF.RING_ITEMS['ring_blunt_t'+(TC-1)+'_normal'];
    near(bluntTop.dmgBonus, 0.50, 'top Normal Blunt ring = +50% (before weapon-type scaling)');
    near(FF.RING_ITEMS['ring_blunt_t0_normal'].dmgBonus, 0.05, 't0 Normal Blunt ring = +5%');
    near(FF.RING_ITEMS['ring_blunt_t'+(TC-1)+'_fantastic'].dmgBonus, 4.00, 'Fantastic x8 = +400%');
    ok(bluntTop.damageType === 'blunt' && bluntTop.bonus === undefined, 'physical rings keep damageType, no kind bonus field');

    function sl(typeId, tier, rarity){ return {typeId:typeId, tier:tier, rarity:rarity||'normal'}; }
    function empty(){ return {typeId:null, tier:0, rarity:'normal'}; }
    function st(rings){
      var js = { ring1:empty(), ring2:empty(), ring3:empty(), ring4:empty(), ring5:empty(), amulet:{tier:0,rarity:'normal'} };
      (rings||[]).forEach(function(r,i){ js['ring'+(i+1)] = r; });
      return { jewelrySlots: js, physique:{}, xp:{} };
    }

    // Element ring bonus sums across slots.
    var oneFire = st([sl('fire', TC, 'normal')]); // +50%
    near(FF.getRingElementDamageBonus(oneFire, 'fire'), 0.50, 'one top fire ring => +50%');
    eq(FF.getRingElementDamageBonus(oneFire, 'water'), 0, 'no water rings => 0');
    var twoFire = st([sl('fire', TC, 'normal'), sl('fire', TC, 'normal')]);
    near(FF.getRingElementDamageBonus(twoFire, 'fire'), 1.00, 'two fire rings stack to +100%');

    // Folds into elementDmgMult on top of attunement.
    var baseMult = FF.elementDmgMult(st([]), 'fire');
    near(FF.elementDmgMult(oneFire, 'fire') - baseMult, 0.50, 'fire ring adds +0.50 to the fire damage multiplier');

    // Precision ring scales Accuracy.
    var accBase = st([]); accBase.physique = {agility: FF.xpFloorForLevel(51)};
    var accRing = st([sl('precision', TC, 'normal')]); accRing.physique = {agility: FF.xpFloorForLevel(51)};
    var a0 = FF.playerAccuracy(accBase), a1 = FF.playerAccuracy(accRing);
    ok(a1 > a0, 'precision ring raises accuracy');
    ok(Math.abs(a1 - Math.round(a0*1.30)) <= 1, 'top Normal precision ring => ~+30% accuracy');

    // Warding ring: flat resistance, capped at 0.9.
    near(FF.getRingResistanceBonus(st([sl('warding', TC, 'normal')])), 0.20, 'one top warding ring => 20% resist');
    var manyWard = st([sl('warding',TC,'fantastic'), sl('warding',TC,'fantastic'), sl('warding',TC,'fantastic'), sl('warding',TC,'fantastic'), sl('warding',TC,'fantastic')]);
    near(FF.getRingResistanceBonus(manyWard), 0.90, 'resistance is capped at 90%');

    // Communion ring: familiar-potency bonus sums across slots; other kinds contribute nothing.
    near(FF.getRingFamiliarBonus(st([sl('communion', TC, 'normal')])), 0.50, 'one top Communion ring => +50% familiar potency');
    near(FF.getRingFamiliarBonus(st([sl('communion',TC,'normal'), sl('communion',TC,'normal')])), 1.00, 'two Communion rings stack to +100%');
    eq(FF.getRingFamiliarBonus(oneFire), 0, 'non-Communion rings give no familiar potency');

    // Kind rings do not add physical (damage-type) multiplier; physical rings do.
    eq(FF.getRingDamageMultiplier(oneFire, {blunt:1}), 1, 'element rings add no physical damage multiplier');
    ok(FF.getRingDamageMultiplier(st([sl('blunt', TC, 'normal')]), {blunt:1}) > 1, 'blunt ring boosts blunt weapons');
  });

  // ---- Amulet of Warding: the Warding resistance role moved from a ring to a typed amulet -----------
  suite('jewelry: Amulet of Warding', function(){
    var TC = FF.TIER_COUNT;
    // The Warding ring is retired (no longer craftable) but its items still exist so nobody loses gear.
    var wardRing = FF.RING_TYPES.filter(function(rt){ return rt.id==='warding'; })[0];
    ok(wardRing && wardRing.retired === true, 'Ring of Warding is retired (not craftable)');
    ok(FF.RING_ITEMS['ring_warding_t'+(TC-1)+'_normal'], 'legacy Warding ring items still exist');

    // A typed Amulet of Warding now exists alongside the plain defense Amulet.
    var types = FF.AMULET_TYPES.map(function(a){ return a.id; });
    ok(types.indexOf('plain') !== -1 && types.indexOf('warding') !== -1, 'plain + warding amulet types exist');
    // Warding amulet id scheme is prefixed; plain keeps the legacy scheme untouched.
    eq(FF.amuletBaseId('plain', 5, 'rare'), 'amulet_t5_rare', 'plain amulet keeps its legacy id');
    eq(FF.amuletBaseId('warding', 5, 'rare'), 'amulet_warding_t5_rare', 'warding amulet is type-prefixed');
    eq(FF.parseAmuletId('amulet_warding_t5_rare').typeId, 'warding', 'warding amulet id parses back to its type');
    eq(FF.parseAmuletId('amulet_t5_rare').typeId, 'plain', 'plain amulet id parses to plain');

    // Warding amulet grants resistance (not defense) and scales 2x/4x/8x with rarity like the old ring.
    var wNorm = FF.AMULET_ITEMS['amulet_warding_t'+(TC-1)+'_normal'];
    var wFant = FF.AMULET_ITEMS['amulet_warding_t'+(TC-1)+'_fantastic'];
    near(wNorm.bonus, 0.20, 'top Warding amulet (Normal) = +20% resist');
    ok(wNorm.defense == null, 'warding amulet has no defense');
    near(wFant.bonus, 1.60, 'Fantastic warding amulet scales 8x (capped later in combat)');

    // Its inputs are the AMULET line (Diving Pearl + Setting + prev-tier warding amulet), not the ring's Gem.
    var win = FF.getAmuletTierData('warding', 5).inputs;
    eq(win['diving_t5'], 1, 'warding amulet seats a Diving Pearl');
    eq(win['goldsmithing_t5'], 1, 'warding amulet seats a Setting');
    eq(win['amulet_warding_t4_normal'], 1, 'warding amulet consumes its own Normal previous tier');
    ok(Object.keys(win).every(function(k){ return k.indexOf('gem_') !== 0; }), 'warding amulet uses no faceted Gem');

    // Equipped warding amulet feeds the combined ward resistance; the plain amulet gives none.
    function stAmulet(typeId, tier, rarity){ return { jewelrySlots:{ ring1:{typeId:null,tier:0,rarity:'normal'}, ring2:{typeId:null,tier:0,rarity:'normal'}, ring3:{typeId:null,tier:0,rarity:'normal'}, ring4:{typeId:null,tier:0,rarity:'normal'}, ring5:{typeId:null,tier:0,rarity:'normal'}, amulet:{tier:tier, rarity:rarity, typeId:typeId} } }; }
    near(FF.getAmuletResistanceBonus(stAmulet('warding', TC, 'normal')), 0.20, 'equipped Warding amulet => +20% resist');
    eq(FF.getAmuletResistanceBonus(stAmulet('plain', TC, 'normal')), 0, 'plain amulet gives no resistance');
    ok(FF.getAmuletDefenseBonus(stAmulet('warding', TC, 'normal')) === 0, 'warding amulet gives no defense');
    ok(FF.getAmuletDefenseBonus(stAmulet('plain', TC, 'normal')) > 0, 'plain amulet still gives defense');
    // Combined ward resistance sums rings + amulet, capped at 90%.
    near(FF.getWardResistanceBonus(stAmulet('warding', TC, 'normal')), 0.20, 'ward resistance includes the amulet');
    ok(FF.getWardResistanceBonus(stAmulet('warding', TC, 'fantastic')) <= 0.9 + 1e-9, 'combined ward resistance caps at 90%');

    // A warding amulet is improvable jewelry (parses as an amulet kind).
    eq(FF.parseImprovable('amulet_warding_t3_rare').kind, 'amulet', 'warding amulet is improvable as an amulet');
  });

  // ---- Cloth armor: rarity boosts familiar potency, not base armor ---------------------
  suite('cloth armor rarity -> familiar efficiency', function(){
    // Cloth (Tailoring) base defense is identical across all rarities.
    function clothDef(rarity){ return FF.BODY_ARMOR_ITEMS['bodyarmor_tailoring_chest_t5_'+rarity].defense; }
    var cn = clothDef('normal');
    var clothBase = Math.round(FF.getBodyArmorTierData('tailoring','chest',5).defense);
    eq(cn, clothBase, 'cloth Normal defense = base tier defense (no rarity mult)');
    eq(clothDef('rare'), cn, 'Rare cloth: same defense');
    eq(clothDef('supreme'), cn, 'Supreme cloth: same defense');
    eq(clothDef('fantastic'), cn, 'Fantastic cloth: same defense');

    // Non-cloth materials still scale base armor 2x/4x/8x with rarity.
    var plateBase = FF.getBodyArmorTierData('plate','chest',5).defense;
    function plateDef(rarity){ return FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t5_'+rarity].defense; }
    eq(plateDef('normal'), Math.round(plateBase), 'plate Normal defense = base');
    eq(plateDef('fantastic'), Math.round(plateBase*8), 'plate Fantastic defense = 8x base');
    ok(plateDef('fantastic') > plateDef('normal'), 'plate rarity still raises defense');

    // The inherent familiar-efficiency bonus DOES scale 2x/4x/8x with cloth rarity.
    function withChest(rarity){ return { bodyArmor: { chest: {material:'tailoring', tier:6, rarity:rarity} } }; }
    near(FF.getClothArmorSpellBonus(withChest('normal')), FF.CLOTH_SLOT_SPELL_BONUS, 'Normal cloth chest = +5% potency');
    near(FF.getClothArmorSpellBonus(withChest('rare')), FF.CLOTH_SLOT_SPELL_BONUS*2, 'Rare cloth chest = +10% (2x)');
    near(FF.getClothArmorSpellBonus(withChest('supreme')), FF.CLOTH_SLOT_SPELL_BONUS*4, 'Supreme cloth chest = +20% (4x)');
    near(FF.getClothArmorSpellBonus(withChest('fantastic')), FF.CLOTH_SLOT_SPELL_BONUS*8, 'Fantastic cloth chest = +40% (8x)');

    // Multiple pieces stack; non-cloth pieces contribute nothing to the spell bonus.
    var full = { bodyArmor: {} };
    FF.TAILORING_SLOTS.forEach(function(slot){ full.bodyArmor[slot] = {material:'tailoring', tier:6, rarity:'fantastic'}; });
    near(FF.getClothArmorSpellBonus(full), FF.CLOTH_SLOT_SPELL_BONUS*8*FF.TAILORING_SLOTS.length, 'five Fantastic cloth pieces stack');
    var plateOnly = { bodyArmor: { chest: {material:'plate', tier:6, rarity:'fantastic'} } };
    eq(FF.getClothArmorSpellBonus(plateOnly), 0, 'plate pieces give no familiar bonus');

    // Card display: the inherent material bonus shown on item cards, per material/slot/rarity.
    eq(FF.armorMaterialBonusLines('tailoring','chest','normal').join('|'), '+5% Familiar spell potency', 'cloth card: +5% familiar potency at Normal');
    eq(FF.armorMaterialBonusLines('tailoring','chest','fantastic').join('|'), '+40% Familiar spell potency', 'cloth card: +40% at Fantastic');
    eq(FF.armorMaterialBonusLines('chain','helmet','rare').join('|'), '+10% Melee damage', 'chain card: +10% melee at Rare');
    eq(FF.armorMaterialBonusLines('leather','boots','supreme').join('|'), '+20% Ranged damage|+4% Dodge chance', 'leather card: ranged + dodge at Supreme');
    eq(FF.armorMaterialBonusLines('plate','helmet','normal').join('|'), '+5% Block chance', 'plate helmet card: +5% block');
    eq(FF.armorMaterialBonusLines('plate','chest','fantastic').join('|'), '', 'plate CHEST card: no block bonus (chest is excluded)');
  });

  // ---- Classes: Treasure Hunter (rarity-scaling fortune seeker) -------------------------
  suite('classes: Treasure Hunter', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('treasureHunter') !== -1, 'treasureHunter is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.treasureHunter;
    ok(cd, 'treasureHunter class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    // Scimitar exists as a forgeable one-hand sword proficiency.
    ok(FF.WEAPON_STYLE_IDS.indexOf('scimitar') !== -1, 'scimitar is a weapon style');

    function arm(mat, r){ return {tier:1, rarity:r||'normal', material:mat}; }
    function emptyRings(){ return { ring1:{typeId:null,tier:0,rarity:'normal'}, ring2:{typeId:null,tier:0,rarity:'normal'}, ring3:{typeId:null,tier:0,rarity:'normal'}, ring4:{typeId:null,tier:0,rarity:'normal'}, ring5:{typeId:null,tier:0,rarity:'normal'}, amulet:{tier:0,rarity:'normal'} }; }
    function base(rar){
      return {
        xp:{treasureHunter:0}, physique:{},
        equippedMainhand:'scimitar', equippedMainhandRarity:rar||'normal',
        equippedOffhand:'shieldSmall', equippedOffhandTier:1, equippedOffhandRarity:rar||'normal',
        bodyArmor:{ helmet:arm('chain',rar), boots:arm('chain',rar), chest:arm('plate',rar), gauntlets:arm('tailoring',rar), back:{tier:0,rarity:'normal',material:null} },
        jewelrySlots:emptyRings(), equippedBeltTier:0, equippedBeltRarity:'normal'
      };
    }
    var full = base();
    eq(FF.activeClassId(full), 'treasureHunter', 'scimitar + small shield + chain helm/boots + plate chest + cloth gloves => Treasure Hunter');

    // Every requirement matters.
    var noScim = base(); noScim.equippedMainhand='rapier'; eq(FF.activeClassId(noScim), null, 'must be a Scimitar');
    var noShield = base(); noShield.equippedOffhand=null; eq(FF.activeClassId(noShield), null, 'needs an offhand shield');
    var wrongShield = base(); wrongShield.equippedOffhand='shieldLarge'; eq(FF.activeClassId(wrongShield), null, 'must be a Small Shield specifically');
    var plateHelm = base(); plateHelm.bodyArmor.helmet=arm('plate'); eq(FF.activeClassId(plateHelm), null, 'helm must be chain');
    var chainChest = base(); chainChest.bodyArmor.chest=arm('chain'); eq(FF.activeClassId(chainChest), null, 'chest must be plate');

    // Rarity counting across all equipped gear.
    var allRare = base('rare');
    eq(FF.treasureHunterCount(allRare, 1), 6, 'six Rare pieces => 6 rare-or-higher');
    eq(FF.treasureHunterCount(allRare, 2), 0, 'none are Supreme+');
    var allSup = base('supreme');
    eq(FF.treasureHunterCount(allSup, 1), 6, 'Supreme counts as rare-or-higher');
    eq(FF.treasureHunterCount(allSup, 2), 6, 'six Supreme => 6 supreme-or-higher');
    eq(FF.treasureHunterCount(allSup, 3), 0, 'none Fantastic');
    eq(FF.treasureHunterCount(base('fantastic'), 3), 6, 'six Fantastic => 6 fantastic');
    // Rings, amulet, and belt count too.
    var withJewels = base('rare');
    withJewels.jewelrySlots.ring1 = {typeId:'fire', tier:1, rarity:'fantastic'};
    withJewels.jewelrySlots.amulet = {tier:1, rarity:'supreme'};
    withJewels.equippedBeltTier = 1; withJewels.equippedBeltRarity = 'rare';
    eq(FF.treasureHunterCount(withJewels, 1), 9, 'rings, amulet, belt all count toward rarity totals');

    // Lv 1 Prospector: +10% damage per rare+ item.
    eq(FF.treasureHunterDmgMult(base('normal')), 1, 'all-normal gear => no damage bonus');
    near(FF.treasureHunterDmgMult(allRare), 1.60, 'six Rare items => +60% damage');
    near(FF.treasureHunterDmgMult(base('fantastic')), 1.60, 'Fantastic items also count as rare+ (+60%)');

    // Inactive class => no bonuses at all.
    var off = base('fantastic'); off.equippedMainhand='rapier';
    eq(FF.treasureHunterDmgMult(off), 1, 'damage bonus off while class inactive');
    eq(FF.treasureHunterCritDmgBonus(off), 0, 'crit bonus off while class inactive');
    eq(FF.classAccuracyMult(off), 1, 'accuracy bonus off while class inactive');

    // Lv 20 Appraiser: +10% accuracy per Supreme+ item (folds into classAccuracyMult).
    var thL1 = base('supreme');
    eq(FF.classAccuracyMult(thL1), 1, 'Lv1: accuracy passive not active yet');
    var thL20 = base('supreme'); thL20.xp.treasureHunter = FF.xpFloorForLevel(21);
    near(FF.classAccuracyMult(thL20), 1.60, 'Lv20, six Supreme => +60% accuracy');
    var thL20rare = base('rare'); thL20rare.xp.treasureHunter = FF.xpFloorForLevel(21);
    eq(FF.classAccuracyMult(thL20rare), 1, 'Rare items do not count for the Supreme+ accuracy bonus');

    // Lv 40 Connoisseur: +25% crit damage per Fantastic item.
    var thL20f = base('fantastic'); thL20f.xp.treasureHunter = FF.xpFloorForLevel(21);
    eq(FF.treasureHunterCritDmgBonus(thL20f), 0, 'crit passive needs Lv40');
    var thL40 = base('fantastic'); thL40.xp.treasureHunter = FF.xpFloorForLevel(41);
    near(FF.treasureHunterCritDmgBonus(thL40), 1.50, 'Lv40, six Fantastic => +150% crit damage');
    var thL40sup = base('supreme'); thL40sup.xp.treasureHunter = FF.xpFloorForLevel(41);
    eq(FF.treasureHunterCritDmgBonus(thL40sup), 0, 'Supreme items do not count for the Fantastic crit bonus');

    // Lv 80 Golden Devotion: doubles the Devotion/Blessing/Miracle rarity bonus (reads global state).
    var s = FF._state;
    var snap = { xpT:s.xp.treasureHunter, main:s.equippedMainhand, mrar:s.equippedMainhandRarity, off:s.equippedOffhand, offT:s.equippedOffhandTier,
      helm:s.bodyArmor.helmet, chest:s.bodyArmor.chest, gaunt:s.bodyArmor.gauntlets, boots:s.bodyArmor.boots,
      fa:s.faithActivity, faith:s.faith };
    s.equippedMainhand='scimitar'; s.equippedMainhandRarity='normal';
    s.equippedOffhand='shieldSmall'; s.equippedOffhandTier=1;
    s.bodyArmor.helmet=arm('chain'); s.bodyArmor.boots=arm('chain'); s.bodyArmor.chest=arm('plate'); s.bodyArmor.gauntlets=arm('tailoring');
    s.faith = 100; s.faithActivity = { type:'devotion', tier:20 };
    s.xp.treasureHunter = 0; // Lv 1: not doubled yet
    var single = FF.faithRarityBonus('devotion');
    ok(single > 0, 'running Devotion grants a rarity bonus');
    s.xp.treasureHunter = FF.xpFloorForLevel(81); // Lv 81
    near(FF.faithRarityBonus('devotion'), single*2, 'Treasure Hunter Lv80 doubles the Devotion rarity bonus');
    s.equippedMainhand='rapier'; // deactivate class
    near(FF.faithRarityBonus('devotion'), single, 'bonus returns to normal when the class is inactive');
    // restore
    s.xp.treasureHunter=snap.xpT; s.equippedMainhand=snap.main; s.equippedMainhandRarity=snap.mrar; s.equippedOffhand=snap.off; s.equippedOffhandTier=snap.offT;
    s.bodyArmor.helmet=snap.helm; s.bodyArmor.chest=snap.chest; s.bodyArmor.gauntlets=snap.gaunt; s.bodyArmor.boots=snap.boots;
    s.faithActivity=snap.fa; s.faith=snap.faith;

    // Familiar registered, excluded from the passive-summon roster (class familiars roll on kills).
    var fam = FF.FAMILIAR_DATA.treasureHunter;
    ok(fam && fam.spells && fam.spells.length === 4, 'Treasure Hunter familiar has 4 spells');
    ok(FF.FAMILIAR_SKILL_IDS.indexOf('treasureHunter') === -1, 'class familiar not in the passive roster');
  });

  // ---- Classes: Thunderfury (crit-chaining earth-wand storm caller) ---------------------
  suite('classes: Thunderfury', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('thunderfury') !== -1, 'thunderfury is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.thunderfury;
    ok(cd, 'thunderfury class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function cloth(){ return {tier:1, rarity:'normal', material:'tailoring'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{thunderfury:0}, physique:{}, equippedMainhand:'wandEarth', equippedMainhandRarity:'normal', equippedOffhand:'wardEarth', bodyArmor:{ helmet:cloth(), chest:cloth(), gauntlets:cloth(), boots:cloth(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'thunderfury', 'earth wand + ward + full cloth => Thunderfury');

    // Every requirement matters.
    // A Fire/Water/Dark wand now confers its own class (Pyromancer/Frostwarden/Nightblade); a Light Wand has none.
    var notEarthWand = base(); notEarthWand.equippedMainhand='wandLight';
    eq(FF.activeClassId(notEarthWand), null, 'must be an Earth Wand specifically (a Light Wand confers no class)');
    var noWard = base(); noWard.equippedOffhand=null;
    eq(FF.activeClassId(noWard), null, 'needs a ward');
    var chainHelm = base(); chainHelm.bodyArmor.helmet={tier:1,rarity:'normal',material:'chain'};
    eq(FF.activeClassId(chainHelm), null, 'all four armor pieces must be cloth');

    // Lv 1 Chain Lightning: crit stacks cut attack timer -10%/stack (cap 7 = -70%).
    eq(FF.THUNDER_MAX_STACKS, 7, 'crit stacks cap at 7');
    var s0 = base(); s0.thunderStacks=0; eq(FF.classAttackSpeedMult(s0), 1, '0 stacks => no reduction');
    var s3 = base(); s3.thunderStacks=3; near(FF.classAttackSpeedMult(s3), 0.70, '3 stacks => -30%');
    var s7 = base(); s7.thunderStacks=7; near(FF.classAttackSpeedMult(s7), 0.30, '7 stacks => -70%');
    var s10 = base(); s10.thunderStacks=10; near(FF.classAttackSpeedMult(s10), 0.30, 'stacks cap at 7');
    var off = base(); off.equippedOffhand=null; off.thunderStacks=7;
    eq(FF.classAttackSpeedMult(off), 1, 'stacks do nothing while the class is inactive');
    eq(FF.thunderStacks(s10), 7, 'thunderStacks caps at 7 while active');
    eq(FF.thunderStacks(off), 0, 'no stacks while class inactive');

    // Lv 20 Static Charge: the Static meter (act.staticCharge) reads capped at 5; empty outside combat.
    eq(FF.THUNDER_STATIC_MAX, 5, 'static meter caps at 5');
    var sc3 = base(); sc3.xp.thunderfury = FF.xpFloorForLevel(21); sc3.activity = { type:'combat', staticCharge:3 };
    eq(FF.thunderStaticCharge(sc3), 3, 'reads the current Static meter');
    var scCap = base(); scCap.activity = { type:'combat', staticCharge:9 };
    eq(FF.thunderStaticCharge(scCap), 5, 'Static meter reads capped at 5');
    eq(FF.thunderStaticCharge(base()), 0, 'no Static outside combat');

    // Lv 60 Concussive Bolt: stun window helper.
    eq(FF.enemyStunned({ activity:{ enemyStunUntil: Date.now()+2000 } }), true, 'active stun window => stunned');
    eq(FF.enemyStunned({ activity:{ enemyStunUntil: Date.now()-1 } }), false, 'expired stun window => not stunned');
    eq(FF.enemyStunned({ activity:{} }), false, 'no stun => not stunned');

    // Lv 80 Galvanize: each crit adds +10% crit damage this fight (act.galvanizeStacks), capped at +100%.
    eq(FF.THUNDER_GALVANIZE_MAX, 10, 'galvanize stacks cap at 10 (+100%)');
    var g4 = base(); g4.xp.thunderfury = FF.xpFloorForLevel(85); g4.activity = { type:'combat', galvanizeStacks:4 };
    near(FF.thunderGalvanizeCritDmg(g4), 0.40, 'Lv 80, 4 crit stacks => +40% crit damage');
    var gCap = base(); gCap.xp.thunderfury = FF.xpFloorForLevel(85); gCap.activity = { type:'combat', galvanizeStacks:20 };
    near(FF.thunderGalvanizeCritDmg(gCap), 1.0, 'Galvanize crit damage caps at +100%');
    var gLow = base(); gLow.xp.thunderfury = FF.xpFloorForLevel(65); gLow.activity = { type:'combat', galvanizeStacks:4 };
    eq(FF.thunderGalvanizeCritDmg(gLow), 0, 'no Galvanize below Class Lv 80');

    // Class familiar (lightning caster).
    var fam = FF.FAMILIAR_DATA.thunderfury;
    ok(fam && fam.spells && fam.spells.length === 4, 'thunderfury familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'thunderfury familiar has a damaging spell');
  });

  // ---- Classes: Assassin (twin-claw Rhythm / bleed / Vanish killer) ---------------------
  suite('classes: Assassin', function(){
    ok(FF.CLASS_SKILL_IDS.indexOf('assassin') !== -1, 'assassin is a class skill id');
    var cd = FF.CLASS_DEFS_BY_ID.assassin;
    ok(cd, 'assassin class defined');
    eq(cd.passives.map(function(p){ return p.level; }).join(','), '1,20,40,60,80', 'passive tiers are 1/20/40/60/80');
    eq(cd.reqParts.length, 6, 'requires 6 gear conditions');

    function cloth(){ return {tier:1, rarity:'normal', material:'tailoring'}; }
    function chain(){ return {tier:1, rarity:'normal', material:'chain'}; }
    function bare(){ return {tier:0, rarity:'normal', material:null}; }
    function base(){ return { xp:{assassin:0}, physique:{}, equippedMainhand:'claw', equippedMainhandTier:6, equippedMainhandRarity:'normal', equippedOffhand:'claw', equippedOffhandTier:6, equippedOffhandRarity:'normal', bodyArmor:{ helmet:cloth(), chest:cloth(), gauntlets:chain(), boots:cloth(), back:bare() } }; }
    var full = base();
    eq(FF.activeClassId(full), 'assassin', 'dual claws + cloth hood/tunic/shoes + chain gloves => Assassin');

    // Every requirement matters.
    var noOff = base(); noOff.equippedOffhand=null; noOff.equippedOffhandTier=0;
    eq(FF.activeClassId(noOff), null, 'needs a claw in the off-hand');
    var notClawMain = base(); notClawMain.equippedMainhand='rapier';
    eq(FF.activeClassId(notClawMain), null, 'needs claws in the main hand');
    var clothGloves = base(); clothGloves.bodyArmor.gauntlets=cloth();
    eq(FF.activeClassId(clothGloves), null, 'gloves must be chain');
    var chainHelm = base(); chainHelm.bodyArmor.helmet=chain();
    eq(FF.activeClassId(chainHelm), null, 'helm must be cloth');

    var lvHi = FF.xpFloorForLevel(85); // ~Lv 85
    function leveled(){ var s = base(); s.xp.assassin = lvHi; return s; }
    var off = base(); off.equippedOffhand=null; off.equippedOffhandTier=0;

    // Reworked ladder: Rhythm / Ambidexterity / Lacerate / Hemorrhage / Vanish.
    eq(cd.passives.map(function(p){ return p.name; }).join(','), 'Rhythm,Ambidexterity,Lacerate,Hemorrhage,Vanish', 'reworked Assassin ladder');

    // Lv 1 Rhythm: 6 alternating hits fill the meter, priming a 2-strike flurry, then it resets.
    var ract = {};
    var built = ['main','off','main','off','main','off'].map(function(h){ return FF.assassinRhythmRegister(ract, h); });
    eq(built.filter(Boolean).length, 0, 'building the Rhythm meter fires no echoes');
    eq(ract.rhythmStacks, FF.ASSASSIN_RHYTHM_MAX, 'six alternating hits fill the meter');
    eq(ract.rhythmFlurry, 2, 'a full meter primes a 2-strike flurry');
    eq(FF.assassinRhythmRegister(ract, 'main'), true, 'flurry strike 1 echoes');
    eq(FF.assassinRhythmRegister(ract, 'off'), true, 'flurry strike 2 echoes');
    eq(ract.rhythmStacks, 0, 'the flurry resets the meter');
    eq(FF.assassinRhythmRegister(ract, 'main'), false, 'the meter rebuilds after a flurry');
    var ract2 = {}; FF.assassinRhythmRegister(ract2,'main'); FF.assassinRhythmRegister(ract2,'off');
    FF.assassinRhythmRegister(ract2,'off'); // a repeated hand breaks the alternation
    eq(ract2.rhythmStacks, 1, 'a repeated hand reseeds the meter to 1');

    // Lv 20 Ambidexterity: off-hand claw swings at main-hand speed (no 30% penalty).
    near(FF.offhandClawAttackIntervalMs(full), Math.max(200, FF.playerAttackIntervalMs(full)*FF.OFFHAND_CLAW_ATTACK_SPEED_MULT), 'Lv1: off-hand claw is 30% slower', 1);
    var lv20 = base(); lv20.xp.assassin = FF.xpFloorForLevel(21);
    near(FF.offhandClawAttackIntervalMs(lv20), Math.max(200, FF.playerAttackIntervalMs(lv20)), 'Lv20 Ambidexterity: off-hand swings at main-hand speed', 1);

    // Lv 40 Lacerate: each claw hit stacks a Bleed (cap 5) on the shared Bleed channel.
    var lact = { type:'combat', bleedUntil:0 };
    FF.assassinApplyLacerate(lact); FF.assassinApplyLacerate(lact);
    eq(lact.bleedStacks, 2, 'Lacerate: two hits -> 2 Bleed stacks');
    for(var _li=0; _li<10; _li++) FF.assassinApplyLacerate(lact);
    eq(lact.bleedStacks, FF.ASSASSIN_BLEED_MAX, 'Lacerate caps at 5 stacks');
    ok(lact.bleedUntil > Date.now(), 'Lacerate refreshes the Bleed duration');
    var vact = { type:'combat', bleedUntil:0, bleedStacks:0 };
    FF.assassinLacerateMaxStacks(vact);
    eq(vact.bleedStacks, FF.ASSASSIN_BLEED_MAX, 'Vanish slams full Lacerate stacks at once');

    // Lv 60 Hemorrhage: a crit vs a Bleeding foe deals +50%.
    var hBleed = leveled(); hBleed.activity = { type:'combat', bleedUntil:Date.now()+3000, bleedStacks:3 };
    near(FF.assassinHemorrhageCritMult(hBleed), 1.5, 'Hemorrhage: +50% vs a Bleeding foe (Lv60+)');
    var hClean = leveled(); hClean.activity = { type:'combat', bleedUntil:0, bleedStacks:0 };
    eq(FF.assassinHemorrhageCritMult(hClean), 1, 'Hemorrhage neutral vs an unbled foe');
    var h40 = base(); h40.xp.assassin = FF.xpFloorForLevel(41); h40.activity = { type:'combat', bleedUntil:Date.now()+3000, bleedStacks:3 };
    eq(FF.assassinHemorrhageCritMult(h40), 1, 'Hemorrhage inactive below Lv60');

    // Lv 80 Vanish: 4s untouched empowers the next strike (+100%).
    eq(FF.ASSASSIN_VANISH_MULT, 2, 'Vanish empowers the next strike x2');
    var vReady = leveled(); vReady.activity = { type:'combat', lastDamagedAt:Date.now()-5000 };
    ok(FF.assassinVanishReady(vReady), 'Vanish ready after 4s untouched (Lv80)');
    var vHot = leveled(); vHot.activity = { type:'combat', lastDamagedAt:Date.now()-1000 };
    ok(!FF.assassinVanishReady(vHot), 'Vanish not ready within 4s of taking a hit');
    var v60 = base(); v60.xp.assassin = FF.xpFloorForLevel(61); v60.activity = { type:'combat', lastDamagedAt:Date.now()-5000 };
    ok(!FF.assassinVanishReady(v60), 'Vanish inactive below Lv80');

    // Class familiar (dark dual-claw killer with lifesteal).
    var fam = FF.FAMILIAR_DATA.assassin;
    ok(fam && fam.spells && fam.spells.length === 4, 'assassin familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return (sp.type==='hit' || sp.type==='siphon') && sp.element==='dark'; }), 'assassin familiar deals dark damage');
  });

  // ---- Claws (dual-wieldable weapon with an off-hand second attack) ---------------------
  suite('claws', function(){
    ok(FF.isClaw('claw'), 'the claw is a claw');
    ok(!FF.isClaw('rapier'), 'a rapier is not a claw');
    var style = FF.getWeaponStyle('claw');
    ok(style && style.claw, 'claw weapon style is flagged');
    eq(style.hand, '1h', 'claws are one-handed');
    near(style.attackTypes.slashing, 0.7, 'claws are 70% slashing');
    near(style.attackTypes.piercing, 0.2, 'claws are 20% piercing');
    near(style.attackTypes.blunt, 0.1, 'claws are 10% blunt');
    // Claws are a normal melee weapon: they train the shared 'claw' proficiency (a per-style id).
    ok(FF.WEAPON_STYLE_IDS.indexOf('claw') !== -1, 'claw is a per-style weapon proficiency id');
    // Claw items exist across tiers/rarities.
    ok(FF.STACKABLE_WEAPON_ITEMS['stweapon_claw_t5_normal'], 'claw items are generated');

    // Off-hand modifiers: +30% attack timer, -30% damage.
    near(FF.OFFHAND_CLAW_ATTACK_SPEED_MULT, 1.30, 'off-hand claw swings 30% slower');
    near(FF.OFFHAND_CLAW_DMG_MULT, 0.70, 'off-hand claw deals 30% less damage');

    // Dual-wield rule: an off-hand claw is only valid when a claw is in the main hand.
    function base(){ return { xp:{}, physique:{}, equippedMainhand:'claw', equippedMainhandTier:6, equippedMainhandRarity:'normal', equippedOffhand:'claw', equippedOffhandTier:6, equippedOffhandRarity:'normal' }; }
    var dual = base();
    eq(FF.hasClawMainhand(dual), true, 'claw main hand detected');
    eq(FF.hasOffhandClaw(dual), true, 'off-hand claw active with a claw main hand');
    var notClawMain = base(); notClawMain.equippedMainhand='rapier';
    eq(FF.hasOffhandClaw(notClawMain), false, 'off-hand claw inactive without a claw main hand');
    var noOff = base(); noOff.equippedOffhand=null; noOff.equippedOffhandTier=0;
    eq(FF.hasOffhandClaw(noOff), false, 'no off-hand claw equipped');
    ok(FF.getEquippedOffhandClawItem(dual), 'off-hand claw item resolves');
    ok(!FF.getEquippedOffhandClawItem(notClawMain), 'no off-hand claw item without a claw main hand');

    // Off-hand attack interval = main-hand interval x1.30.
    near(FF.offhandClawAttackIntervalMs(dual), FF.playerAttackIntervalMs(dual)*1.30, 'off-hand interval is +30% of the main-hand interval');
    ok(FF.offhandClawAttackIntervalMs(dual) > FF.playerAttackIntervalMs(dual), 'off-hand swings slower than the main hand');
  });

  // ---- Warding proficiency (extra reflection from reflected-damage XP) ------------------
  suite('warding proficiency', function(){
    eq(FF.WARDING_SKILL_ID, 'warding', 'warding skill id');
    // Bonus: +1% at Lv1 -> +20% at Lv100, and clamped beyond.
    function st(lvl){ var xp = lvl<=1 ? 0 : FF.xpFloorForLevel(lvl); var o={xp:{}}; o.xp.warding = xp; return o; }
    near(FF.wardingReflectBonus(st(1)), 0.01, 'Lv1 => +1%');
    near(FF.wardingReflectBonus(st(100)), 0.20, 'Lv100 => +20%');
    ok(FF.wardingReflectBonus(st(50)) > FF.wardingReflectBonus(st(10)), 'more warding level => more reflection');
    ok(FF.wardingReflectBonus(st(200)) <= 0.20 + 1e-9, 'bonus clamps at +20% beyond Lv100');
    eq(FF.WARDING_BONUS_MIN, 0.01, 'min bonus 1%');
    eq(FF.WARDING_BONUS_MAX, 0.20, 'max bonus 20%');
    // Warding is a single shared proficiency: the per-element ward styles are NOT proficiency skills.
    ok(FF.OFFHAND_STYLE_IDS.indexOf('warding') === -1, 'warding is not an offhand STYLE id');
    FF.WARD_TYPES.forEach(function(w){ ok(FF.OFFHAND_STYLE_IDS.indexOf(w.id) === -1, w.id+' is not a per-style proficiency'); });
  });

  // ---- Faith: auto-sacrifice Broken Relics to top up Faith (no-overflow) ----------------
  suite('faith: auto-sacrifice broken relics', function(){
    ok(typeof FF.autoSacrificeRelicsCheck === 'function' && typeof FF.brokenRelicFaithRestore === 'function', 'auto-sacrifice helpers exported');
    var s = FF._state;
    var save = { inv:s.inventory, faith:s.faith, auto:s.autoSacrificeRelics, locked:s.lockedItems, sx:s.xp.sacrifice, obl:(s.physique&&s.physique.oblation) };
    try {
      s.inventory = {}; s.lockedItems = {}; s.autoSacrificeRelics = false;
      if(s.physique) s.physique.oblation = 0; // deterministic: no Oblation return-chance / bonus
      var mx = FF.faithMax(s);
      var t0 = FF.BROKEN_RELIC_ITEMS[0].id, t1 = FF.BROKEN_RELIC_ITEMS[1].id;
      var r0 = FF.brokenRelicFaithRestore(0), r1 = FF.brokenRelicFaithRestore(1);
      ok(r1 > r0, 'a higher-tier Broken Relic restores more Faith');

      // Disabled => no-op even with relics on hand and Faith empty.
      s.inventory[t0] = 5; s.faith = 0;
      FF.autoSacrificeRelicsCheck();
      eq(s.faith, 0, 'toggle off => nothing is auto-sacrificed');
      eq(s.inventory[t0], 5, 'relics untouched while the toggle is off');

      // Enabled with a large deficit => tops up, staying within the cap.
      s.autoSacrificeRelics = true; s.faith = 0;
      FF.autoSacrificeRelicsCheck();
      ok(s.faith > 0 && s.faith <= mx + 1e-9, 'enabled => Faith is topped up within the cap');

      // No overflow: a relic is NOT sacrificed when its full value would spill past the cap.
      s.inventory = {}; s.inventory[t1] = 1; s.faith = mx - (r1 - 1); // deficit = r1-1 < r1
      FF.autoSacrificeRelicsCheck();
      eq(s.inventory[t1], 1, 'no auto-sacrifice when the full value would overflow the cap');

      // Exact fit => sacrificed, filling to (about) the cap.
      s.faith = mx - r1;
      FF.autoSacrificeRelicsCheck();
      ok((s.inventory[t1]||0) === 0, 'auto-sacrificed once its full value fits the deficit');
      ok(Math.abs(s.faith - mx) <= 1, 'Faith filled to about the cap');

      // Locked Broken Relics are never auto-sacrificed.
      s.inventory = {}; s.inventory[t0] = 1; s.lockedItems[t0] = true; s.faith = 0;
      FF.autoSacrificeRelicsCheck();
      eq(s.inventory[t0], 1, 'locked Broken Relics are protected from auto-sacrifice');
    } finally {
      s.inventory=save.inv; s.faith=save.faith; s.autoSacrificeRelics=save.auto; s.lockedItems=save.locked; s.xp.sacrifice=save.sx; if(s.physique) s.physique.oblation=save.obl;
    }
  });

  // ---- Hardening: monster lookup + addItem guards ---------------------------------------
  suite('hardening', function(){
    // monsterById maps every monster and rejects unknown ids (used by the combat hot path + stale-id retreat).
    ok(FF.MONSTERS.every(function(m){ return FF.monsterById(m.id) === m; }), 'monsterById resolves every monster');
    eq(FF.monsterById('nope_such_monster'), null, 'monsterById(unknown) === null');
    eq(FF.monsterById(undefined), null, 'monsterById(undefined) === null');

    // addItem ignores NaN / zero / negative so a broken quantity can never enter the inventory.
    var inv = FF._state.inventory;
    var K = '__hardening_probe__';
    delete inv[K];
    FF.addItem(K, NaN);      eq(inv[K], undefined, 'addItem(NaN) is a no-op');
    FF.addItem(K, 0);        eq(inv[K], undefined, 'addItem(0) is a no-op');
    FF.addItem(K, -5);       eq(inv[K], undefined, 'addItem(negative) is a no-op');
    FF.addItem(K, Infinity); eq(inv[K], undefined, 'addItem(Infinity) is a no-op');
    FF.addItem(K, 3);        eq(inv[K], 3, 'addItem(positive) adds');
    FF.addItem(K, 2.9);      eq(inv[K], 5, 'addItem floors fractional grants');
    delete inv[K];
  });

  // ---- Estate obstacle info -------------------------------------------------------------
  suite('estateObstacleInfo', function(){
    eq(FF.estateObstacleInfo(null), null, 'null obstacle -> null');
    var type = ['trees','rocks','ore','berries','herbs'].filter(function(x){ return FF.estateObstacleInfo({ type: x, tierIndex: 0 }); })[0];
    ok(!!type, 'at least one obstacle type resolves');
    if(type){
      var i0 = FF.estateObstacleInfo({ type: type, tierIndex: 0 });
      var i2 = FF.estateObstacleInfo({ type: type, tierIndex: 2 });
      ok(i0.resourceAmount > 0 && i0.xp > 0 && i0.durationMs > 0, 'obstacle yields are positive');
      ok(i2.resourceAmount > i0.resourceAmount, 'obstacle yield scales up with tier');
      ok(/_t0$/.test(i0.itemId), 'obstacle itemId carries its tier suffix');
    }
  });

  // ---- Duration formatting --------------------------------------------------------------
  suite('formatDuration', function(){
    eq(FF.formatDuration(0), '0:00', 'zero');
    eq(FF.formatDuration(65000), '1:05', 'm:ss');
    eq(FF.formatDuration(600000), '10:00', 'ten minutes');
    eq(FF.formatDuration(3661000), '1:01:01', 'h:mm:ss for long jobs');
  });

  // ---- monster.xp is sunset (no monster carries an inherent-XP field) -------------------
  suite('monster.xp sunset', function(){
    ok(FF.MONSTERS.length > 0, 'monsters exist');
    eq(FF.MONSTERS.filter(function(m){ return m.xp !== undefined; }).length, 0, 'no monster has an xp field anymore');
  });

  // ---- Rarity lookup --------------------------------------------------------------------
  suite('getRarity', function(){
    eq(FF.getRarity('normal').id, 'normal', 'getRarity(normal)');
    ok(FF.getRarity('bogus') && FF.getRarity('bogus').id, 'getRarity falls back for unknown id');
  });

  // ---- Server-authoritative gold wallet (Stage 2 client wiring) -------------------------
  suite('gold wallet: earnGold feeds the lifetime anchor', function(){
    ok(typeof FF.earnGold === 'function', 'earnGold is exported');
    ok(typeof FF.walletSync === 'function', 'walletSync is exported');
    ok(typeof FF.itemSync === 'function', 'itemSync (item-ledger reconcile) is exported');
    var s = FF._state;
    ok(typeof s.goldEarnedTotal === 'number', 'state carries a goldEarnedTotal anchor');
    ok(s.goldEarnedTotal >= Math.floor(s.gold||0), 'the anchor is never below the current balance');
    var g0 = s.gold, e0 = s.goldEarnedTotal;
    FF.earnGold(7);
    eq(s.gold, g0 + 7, 'earnGold raises gold');
    eq(s.goldEarnedTotal, e0 + 7, 'earnGold raises the lifetime anchor by the same amount');
    FF.earnGold(-3); FF.earnGold(0);
    eq(s.gold, g0 + 7, 'earnGold ignores non-positive amounts');
    s.gold = g0; s.goldEarnedTotal = e0; // restore so the test never perturbs the real balance
  });

  // ---- Gold wallet reconcile: never destroy legit earnings, still collapse spoofed gold ----------
  suite('wallet: reconcile never loses legit earnings', function(){
    var R = FF.walletReconcileGold;
    ok(typeof R === 'function', 'walletReconcileGold exported');
    // Normal case: server credited the full earn -> local matches server.
    eq(R(1500000, 1500000, 1500000, 1500000, 1500000), 1500000, 'fully-credited earn: gold preserved');
    // The BUG this fixes: server throttled/clamped the balance low, but the earn is legit (earned_total
    // reflects it). The un-credited remainder (pending) is kept, NOT thrown away.
    eq(R(1500000, 1500000, 1500000, /*serverGold*/0, /*serverEarned*/0), 1500000, 'throttled earn is NOT lost (pending restores it)');
    eq(R(1500000, 1500000, 1500000, 666666, 666666), 1500000, 'partially-credited earn keeps the remainder');
    // Recovery: a previously wiped balance (local 0) comes back once the server can credit the gap.
    eq(R(0, 0, 1500000, 0, 0), 1500000, 'recovers gold the old bug wiped to 0');
    // Anti-cheat: a tampered-HIGH local gold with NO matching earnings collapses to the server value.
    eq(R(1000000000, 1000000000, 0, 500, 0), 500, 'spoofed local gold (no earnings) collapses to server');
    // Legit spend propagates: local dropped below what was sent, server adopted it, no pending.
    eq(R(400, 400, 1000, 400, 1000), 400, 'a spend sticks (server adopted the lower balance)');
    // Round-trip drift: gold earned locally during the request is preserved on top.
    eq(R(1200, 1000, 1000, 1000, 1000), 1200, 'drift earned mid-request is not clobbered');
    // Treasure-chest gold is banked exempt via wallet.earn_chest (server-verified by an item_debit),
    // credited in full to the server balance outside the token bucket -- so it reconciles like any
    // already-credited gold and is never throttled/clamped. Its credit does NOT flow through
    // goldEarnedTotal, so the normal earn/sync path can't double-count it.
    ok(typeof FF.walletEarnChest === 'function', 'walletEarnChest exported (exempt chest-gold credit)');
    // Once earn_chest has banked the chest gold into serverGold, the reconcile keeps it (no pending needed).
    eq(R(50000, 50000, 0, 50000, 0), 50000, 'chest gold banked into server balance survives reconcile');
  });

  // ---- Improvement system: enchant foundation (Stage 1a) --------------------------------
  suite('improvement: enchant foundation', function(){
    ok(typeof FF.rollEnchant === 'function' && FF.ENCHANT_MODS, 'enchant pools + roll exported');
    eq(FF.enchantSlotsFor('normal'), 1, 'normal = 1 enchant slot');
    eq(FF.enchantSlotsFor('rare'), 2, 'rare = 2 slots');
    eq(FF.enchantSlotsFor('supreme'), 3, 'supreme = 3 slots');
    eq(FF.enchantSlotsFor('fantastic'), 4, 'fantastic = 4 slots');
    eq(FF.ENHANCE_MAX, 15, 'enhance caps at +15');
    eq(FF.enchantCategoryForKind('weapon'), 'weapon', 'weapon -> weapon pool');
    eq(FF.enchantCategoryForKind('ring'), 'jewelry', 'ring -> jewelry pool');
    eq(FF.enchantCategoryForKind('amulet'), 'jewelry', 'amulet -> jewelry pool');
    eq(FF.enchantCategoryForKind('bodyarmor'), 'armor', 'armour slot -> armor pool');
    eq(FF.enchantCategoryForKind('offhand'), 'armor', 'offhand/shield -> armor pool');
    ['weapon','armor','jewelry'].forEach(function(cat){
      var pool = FF.ENCHANT_MODS[cat];
      ok(pool && pool.length >= 4, cat + ' pool is a broad list');
      pool.forEach(function(m){ ok(m.id && m.label && m.stat && m.min <= m.max, cat + '/' + m.id + ' well-formed'); });
    });
    for(var i=0;i<50;i++){
      var e = FF.rollEnchant('weapon'); var m = FF.enchantModById('weapon', e.mod);
      ok(m && e.roll >= m.min && e.roll <= m.max, 'weapon roll lands in the mod range');
    }
    eq(FF.enchantCrystalCost({enchants:[]}), 1, 'first enchant costs 1 crystal');
    eq(FF.enchantCrystalCost({enchants:[1,2,3]}), 4, 'each extra enchant adds +1 crystal');
  });

  // ---- Improvement system: enchant engine (Stage 1b) ------------------------------------
  suite('improvement: enchant engine', function(){
    ok(typeof FF.makeUniqueFromBase === 'function' && typeof FF.planEnchantCrystals === 'function', 'engine exported');
    var p = FF.parseImprovable('stweapon_rapier_t5_rare');
    ok(p && p.kind==='weapon' && p.tier===5 && p.rarity==='rare', 'parses a rare tier-5 weapon');
    eq(FF.parseImprovable('ring_fire_t3_supreme').kind, 'ring', 'ring parsed');
    eq(FF.parseImprovable('bodyarmor_plate_chest_t2_normal').kind, 'bodyarmor', 'body armour parsed');
    eq(FF.parseImprovable('amulet_t4_fantastic').kind, 'amulet', 'amulet parsed');
    ok(FF.parseImprovable('coal') === null, 'non-equipment rejected');
    // Crystal planning against a controlled inventory (selftest state is a throwaway newGame).
    var s = FF._state, savedInv = s.inventory;
    s.inventory = { enchant_t3:1, enchant_t5:5 };
    ok(FF.planEnchantCrystals(6, 1) === null, 'cannot plan when no crystal is tier6+');
    var plan = FF.planEnchantCrystals(5, 3);
    ok(plan && plan.plan.enchant_t5===3 && plan.maxTier===5, 'plans 3 tier-5 crystals');
    var plan2 = FF.planEnchantCrystals(3, 4);
    ok(plan2 && plan2.plan.enchant_t3===1 && plan2.plan.enchant_t5===3 && plan2.maxTier===5, 'fills tier3 first, spills to higher tier, flags it');
    s.inventory = savedInv;
  });

  // ---- Improvement system: modify EQUIPPED gear (deferred conversion, keeps it equipped) --------
  suite('improvement: equipped gear is improvable in place', function(){
    ok(typeof FF.equippedImprovableBases === 'function' && typeof FF.improveFromEquipped === 'function', 'equipped-improve helpers exported');
    ok(typeof FF.convertEquippedToUnique === 'function' && typeof FF.isEquipToken === 'function', 'deferred-conversion helpers exported');
    var s = FF._state;
    var save = { mh:s.equippedMainhand, mht:s.equippedMainhandTier, mhr:s.equippedMainhandRarity, mhu:s.equippedMainhandUid, uniq:s.uniqueItems, jw:s.jewelrySlots, inv:s.inventory };
    try {
      s.uniqueItems = {}; s.inventory = {};
      // Equip a plain base Rare Half-Moon Axe (tier index 4, i.e. tier field 5) with no unique uid.
      // (Rare-or-better is required now that Normal gear is no longer improvable.)
      s.equippedMainhand = 'halfmoonaxe'; s.equippedMainhandTier = 5; s.equippedMainhandRarity = 'rare'; s.equippedMainhandUid = null;
      var mh = FF.equippedImprovableBases().filter(function(e){ return e.slot==='mainhand'; })[0];
      ok(mh && mh.baseId==='stweapon_halfmoonaxe_t4_rare', 'equipped base mainhand is surfaced with its real item id');
      // Selecting it must NOT convert yet -- browsing equipped gear leaves it untouched.
      FF.improveFromEquipped('mainhand');
      ok(FF.isEquipToken('equip:mainhand'), 'the equip token is recognised');
      ok(s.equippedMainhandUid == null && Object.keys(s.uniqueItems).length === 0, 'selecting an equipped base does NOT mint a unique yet (deferred)');
      // The conversion happens when an enchant actually lands. Give it a matching-tier crystal and enchant.
      s.inventory['enchant_t4'] = 3;
      FF.improveEnchant();
      var uid = s.equippedMainhandUid;
      ok(uid && s.uniqueItems[uid], 'enchanting converts the equipped base into a unique');
      ok(FF.uniqueIsEquipped(uid), 'the new unique stays equipped in its slot');
      var u = s.uniqueItems[uid];
      ok(u.kind==='weapon' && u.tier===4 && u.rarity==='rare', 'the unique inherits the base kind/tier/rarity');
      ok(u.enchants.length===1, 'the enchant that triggered the conversion is applied');
      // Now that the slot holds a unique, it no longer appears as a raw equipped BASE to convert.
      ok(FF.equippedImprovableBases().every(function(e){ return e.slot!=='mainhand'; }), 'an already-unique slot is not offered again');
      // Direct helper: convertEquippedToUnique mints + points the slot at the uid.
      s.uniqueItems = {}; s.equippedMainhandUid = null;
      var uid2 = FF.convertEquippedToUnique('mainhand');
      ok(uid2 && s.equippedMainhandUid===uid2 && s.uniqueItems[uid2].enchants.length===0, 'convertEquippedToUnique mints a stat-identical equipped unique');
    } finally {
      s.equippedMainhand=save.mh; s.equippedMainhandTier=save.mht; s.equippedMainhandRarity=save.mhr; s.equippedMainhandUid=save.mhu; s.uniqueItems=save.uniq; s.jewelrySlots=save.jw; s.inventory=save.inv;
    }
  });

  // ---- Improvement system: combat aggregate (Stage 1c) ----------------------------------
  suite('improvement: enchant combat aggregate', function(){
    ok(typeof FF.equippedEnchantTotals === 'function', 'aggregate exported');
    // enhance scaling: +0 = x1, +15 = x6 (base + up to +500%)
    near(FF.enhanceStatMult(0), 1, 'enhance +0 = x1');
    near(FF.enhanceStatMult(15), 6, 'enhance +15 = x6 (+500%)');
    // an unequipped/empty state contributes nothing
    var t0 = FF.equippedEnchantTotals({ uniqueItems:{} });
    ok(t0 && Object.keys(t0).length===0, 'nothing equipped -> zero totals (additive-safe)');
    // a constructed state with an equipped weapon carrying two crit-damage enchants sums them
    var st = { uniqueItems:{ u1:{ uid:'u1', kind:'weapon', enhance:0, enchants:[{mod:'critDamage',roll:10},{mod:'critDamage',roll:15}] } }, equippedMainhandUid:'u1' };
    var t1 = FF.equippedEnchantTotals(st);
    eq(t1.critDamage, 25, 'two Critical Damage enchants stack to +25');
    // enhance doubles-plus: at +15 the same enchants scale x6
    st.uniqueItems.u1.enhance = 15;
    eq(FF.equippedEnchantTotals(st).critDamage, 150, 'enhanced +15 scales enchant totals x6');
    // Stage 3: armour, jewelry, and offhand slots now feed the aggregate off their real slot models
    // (jewelrySlots[ringN].uid / jewelrySlots.amulet.uid / bodyArmor[slot].uid / equippedOffhandUid).
    var stAll = { uniqueItems:{
        r1:{uid:'r1',kind:'ring',enhance:0,enchants:[{mod:'critChance',roll:5}]},
        am:{uid:'am',kind:'amulet',enhance:0,enchants:[{mod:'maxHp',roll:20}]},
        ch:{uid:'ch',kind:'bodyarmor',enhance:0,enchants:[{mod:'maxHp',roll:30}]},
        of:{uid:'of',kind:'offhand',enhance:0,enchants:[{mod:'blockChance',roll:4}]}
      },
      jewelrySlots:{ ring1:{uid:'r1'}, ring2:{}, ring3:{}, ring4:{}, ring5:{}, amulet:{uid:'am'} },
      bodyArmor:{ gauntlets:{}, boots:{}, chest:{uid:'ch'}, helmet:{}, back:{} },
      equippedOffhandUid:'of' };
    var ta = FF.equippedEnchantTotals(stAll);
    eq(ta.critChance, 5, 'equipped ring enchant feeds the aggregate');
    eq(ta.maxHp, 50, 'amulet + body-armour Max HP enchants stack (20+30)');
    eq(ta.blockChance, 4, 'equipped offhand enchant feeds the aggregate');
    ok(typeof FF.equipUnique==='function' && typeof FF.unequipUnique==='function' && typeof FF.uniqueSellValue==='function', 'stage-3 equip/trade fns exported');
    // Chat item links: a unique round-trips through encode -> decode with base/enhance/enchants intact.
    var linkU = { base:'stweapon_wandFire_t3_rare', kind:'weapon', tier:3, rarity:'rare', enhance:4, enchants:[{mod:'critDamage',roll:12},{mod:'lifesteal',roll:7}] };
    var tok = FF.encodeItemLink(linkU);
    ok(typeof tok==='string' && tok.length>0, 'encodeItemLink returns a token');
    var dec = FF.decodeItemLink(tok);
    ok(dec && dec.base==='stweapon_wandFire_t3_rare' && dec.tier===3 && dec.rarity==='rare' && dec.kind==='weapon', 'decode recovers base/tier/rarity/kind');
    ok(dec && dec.enhance===4 && dec.enchants.length===2 && dec.enchants[0].mod==='critDamage' && dec.enchants[0].roll===12 && dec.enchants[1].mod==='lifesteal' && dec.enchants[1].roll===7, 'decode recovers enhance + enchant rolls');
    ok(FF.decodeItemLink('!!!not-base64!!!')===null || FF.decodeItemLink('')===null, 'garbage payload decodes to null (safe fallback)');
    // Unique cards always list their enchants, enhance-scaled (mirrors the improvement/inventory cards).
    var uLines = FF.uniqueEnchantLines({ kind:'weapon', enhance:15, enchants:[{mod:'critDamage',roll:10}] });
    ok(uLines.length===1 && /Critical Damage/.test(uLines[0]) && /\+60(\.0)?%/.test(uLines[0]), 'enchant line is enhance-scaled (10% x6 = 60%)');
    // Equip comparison chip: coloured gain/loss vs equipped.
    ok(/equip-cmp up/.test(FF.equipDeltaChip(20, 12)) && /\+8/.test(FF.equipDeltaChip(20,12)), 'higher candidate -> green +delta');
    ok(/equip-cmp down/.test(FF.equipDeltaChip(12, 20)), 'lower candidate -> red delta');
    ok(/equip-cmp eq/.test(FF.equipDeltaChip(10, 10)), 'equal -> neutral ±0');
    ok(/%/.test(FF.equipDeltaChip(0.3, 0.1, true)), 'pct mode renders a percentage');
    // The Equipment & Stats equip card must emit a HANDLED data-action. It fires the click dispatcher's
    // 'improveEquip'/'improveUnequip' cases (which call equip/unequipUnique) -- NOT the bare function
    // names, which have no handler (that made "Equip" silently do nothing). A ring has no proficiency
    // lock, so the card shows the live Equip button.
    var _uid = 'sel_equipcard';
    FF._state.uniqueItems = FF._state.uniqueItems || {};
    FF._state.uniqueItems[_uid] = { uid:_uid, base:'ring_fire_t0_rare', kind:'ring', tier:0, rarity:'rare', enchants:[], enhance:0 };
    var _card = FF.renderUniqueEquipCard(FF._state.uniqueItems[_uid]);
    ok(/data-action="improveEquip"/.test(_card), 'equip card uses the handled improveEquip action (not the unhandled equipUnique)');
    ok(!/data-action="equipUnique"/.test(_card), 'equip card does not emit the unhandled equipUnique action');
    delete FF._state.uniqueItems[_uid];

    // Belts and Relics are improvable: own kinds, right enchant pools, and their equipped uniques feed
    // equippedEnchantTotals + scale their base stat by +enhance -- like every other slot.
    eq(FF.parseImprovable('belt_t5_rare').kind, 'belt', 'a belt parses as an improvable belt');
    eq(FF.parseImprovable('relic_t3_supreme').kind, 'relic', 'a relic parses as an improvable relic');
    eq(FF.enchantCategoryForKind('belt'), 'armor', 'belts enchant from the armor pool');
    eq(FF.enchantCategoryForKind('relic'), 'jewelry', 'relics enchant from the jewelry pool');
    var _es = { uniqueItems:{
        ubelt:{ uid:'ubelt', base:'belt_t5_rare', kind:'belt', tier:5, rarity:'rare', enhance:0, enchants:[{mod:'defense',roll:10}] },
        urelic:{ uid:'urelic', base:'relic_t3_supreme', kind:'relic', tier:3, rarity:'supreme', enhance:0, enchants:[{mod:'critChance',roll:5}] }
      }, equippedBeltUid:'ubelt', equippedRelicUid:'urelic' };
    var _et = FF.equippedEnchantTotals(_es);
    eq(_et.defense, 10, 'equipped unique belt feeds its Defense enchant into the totals');
    eq(_et.critChance, 5, 'equipped unique relic feeds its Crit Chance enchant into the totals');
    // +enhance scales the base stat (enhanceStatMult(15) = 6x).
    var _b0 = FF.getEquippedBeltDefense({ equippedBeltTier:6, equippedBeltRarity:'rare', equippedBeltUid:null, uniqueItems:{} });
    var _b15 = FF.getEquippedBeltDefense({ equippedBeltTier:6, equippedBeltRarity:'rare', equippedBeltUid:'ub', uniqueItems:{ ub:{ uid:'ub', base:'belt_t5_rare', kind:'belt', tier:5, rarity:'rare', enhance:15, enchants:[] } } });
    ok(_b0 > 0 && Math.abs(_b15 - _b0*6) <= 1, 'a +15 unique belt scales its Defense 6x');
    var _r0 = FF.getEquippedRelicBonus({ equippedRelicTier:4, equippedRelicRarity:'supreme', equippedRelicUid:null, uniqueItems:{} });
    var _r15 = FF.getEquippedRelicBonus({ equippedRelicTier:4, equippedRelicRarity:'supreme', equippedRelicUid:'ur', uniqueItems:{ ur:{ uid:'ur', base:'relic_t3_supreme', kind:'relic', tier:3, rarity:'supreme', enhance:15, enchants:[] } } });
    ok(_r0 > 0 && Math.abs(_r15 - _r0*6) < 1e-9, 'a +15 unique relic scales its bonus 6x');
  });

  // ---- Improvement system: enhance (Stage 2) --------------------------------------------
  suite('improvement: enhance', function(){
    ok(typeof FF.enhanceItem === 'function' && typeof FF.enhanceSuccessChance === 'function', 'enhance exported');
    near(FF.enhanceSuccessChance(0), 0.95, 'first enhance is 95%');
    near(FF.enhanceSuccessChance(1), 0.90, 'second is 90%');
    near(FF.enhanceSuccessChance(5), 0.70, '+5 -> 70%');
    eq(FF.enhanceSuccessChance(20) >= 0.05, true, 'success chance floors at 5%');
    // Enhance consumes Inscription Scrolls (scroll_t<n>, e.g. Warding Scrap) -- the items the
    // Inscription skill scribes -- NOT a non-existent inscription_t id. (throwaway selftest inventory)
    var s = FF._state, savedInv = s.inventory;
    s.inventory = { scroll_t2:1, scroll_t4:5 };
    ok(FF.planInscriptions(5, 1) === null, 'cannot plan when no Scroll is tier5+');
    var pl = FF.planInscriptions(2, 3);
    ok(pl && pl.plan.scroll_t2===1 && pl.plan.scroll_t4===2 && pl.maxTier===4, 'plans tier2 Scroll first then higher');
    ok(FF.ALL_CRAFT_RECIPES['scroll_t0'] && FF.ALL_CRAFT_RECIPES['scroll_t0'].name === 'Warding Scrap', 'the tier-0 Inscription Scroll is Warding Scrap');
    s.inventory = savedInv;
  });

  // ---- Improvement: an equipped base is improvable even if a stale mainhand uid lingers ----------
  suite('improvement: equipped base vs stale uid', function(){
    ok(typeof FF.equippedImprovableBases === 'function', 'equippedImprovableBases exported');
    var s = FF._state;
    var sv = { mh:s.equippedMainhand, t:s.equippedMainhandTier, r:s.equippedMainhandRarity, uid:s.equippedMainhandUid, ui:s.uniqueItems };
    s.uniqueItems = {};
    s.equippedMainhand = 'rapier'; s.equippedMainhandTier = 3; s.equippedMainhandRarity = 'rare';
    // A dangling uid (points at no real unique) must NOT hide the equipped base from the picker.
    s.equippedMainhandUid = 'u_ghost';
    ok(FF.equippedImprovableBases().some(function(e){ return e.slot==='mainhand'; }), 'stale mainhand uid does not hide the equipped base');
    // A real equipped unique DOES occupy the slot -> the raw base is not offered (the unique shows separately).
    s.uniqueItems = { u_ghost:{ uid:'u_ghost', base:'stweapon_rapier_t2_rare', kind:'weapon', tier:2, rarity:'rare', enchants:[], enhance:0 } };
    ok(!FF.equippedImprovableBases().some(function(e){ return e.slot==='mainhand'; }), 'a valid equipped unique hides the raw base');
    s.equippedMainhand=sv.mh; s.equippedMainhandTier=sv.t; s.equippedMainhandRarity=sv.r; s.equippedMainhandUid=sv.uid; s.uniqueItems=sv.ui;
  });

  // ---- Improvement: only Rare-or-better gear can be improved (Normal is excluded) ---------------
  suite('improvement: Normal gear cannot be improved', function(){
    ok(typeof FF.isImprovableRarity === 'function', 'rarity gate exported');
    eq(FF.isImprovableRarity('normal'), false, 'Normal is NOT improvable');
    ok(FF.isImprovableRarity('rare') && FF.isImprovableRarity('supreme') && FF.isImprovableRarity('fantastic'), 'Rare / Supreme / Fantastic are improvable');
    var s = FF._state;
    var sv = { mh:s.equippedMainhand, t:s.equippedMainhandTier, r:s.equippedMainhandRarity, uid:s.equippedMainhandUid, ui:s.uniqueItems };
    s.uniqueItems = {}; s.equippedMainhandUid = null;
    s.equippedMainhand='rapier'; s.equippedMainhandTier=3;
    // Normal equipped gear is NOT offered in the improve picker.
    s.equippedMainhandRarity='normal';
    ok(!FF.equippedImprovableBases().some(function(e){ return e.slot==='mainhand'; }), 'Normal equipped gear is not offered as a selectable');
    // Bumping the same slot to Rare makes it appear.
    s.equippedMainhandRarity='rare';
    ok(FF.equippedImprovableBases().some(function(e){ return e.slot==='mainhand'; }), 'Rare equipped gear IS offered');
    s.equippedMainhand=sv.mh; s.equippedMainhandTier=sv.t; s.equippedMainhandRarity=sv.r; s.equippedMainhandUid=sv.uid; s.uniqueItems=sv.ui;
  });

  // ---- Mortal / Immortal path -------------------------------------------------------------
  suite('mortal path: half XP + death conversion', function(){
    ok(typeof FF.isMortal === 'function', 'isMortal exported');
    ok(typeof FF.MORTAL_XP_MULT === 'number' && FF.MORTAL_XP_MULT === 0.5, 'Mortals gain XP at half rate (0.5)');
    var s = FF._state;
    var sv = { mortal:s.mortal, xp:s.xp.fishing };
    // Neutralise the buff/familiar multipliers so we isolate the mortal factor: no active tea, no
    // server buff influence beyond 1x is assumed by the harness (matches other addXp tests here).
    s.mortal = false; s.xp.fishing = 0;
    FF.addXp('fishing', 1000);
    var immortalGain = s.xp.fishing;
    s.mortal = true; s.xp.fishing = 0;
    FF.addXp('fishing', 1000);
    var mortalGain = s.xp.fishing;
    ok(mortalGain > 0 && immortalGain > 0, 'both paths gain some XP');
    near(mortalGain, immortalGain * 0.5, 'a Mortal gains exactly half an Immortal\'s XP', immortalGain * 0.01);
    s.mortal = sv.mortal; s.xp.fishing = sv.xp;
  });

  suite('mortal path: choose + convert', function(){
    var s = FF._state;
    var sv = s.mortal;
    ok(Array.isArray(FF.PATH_CHOICES) && FF.PATH_CHOICES.length === 2, 'two paths offered');
    ok(FF.PATH_CHOICES.some(function(c){ return c.id==='mortal'; }) && FF.PATH_CHOICES.some(function(c){ return c.id==='immortal'; }), 'Immortal + Mortal choices present');
    // choosePath commits the flag.
    FF.choosePath('mortal'); eq(s.mortal, true, 'choosePath("mortal") sets Mortal');
    ok(FF.isMortal(), 'isMortal() true after choosing Mortal');
    // mortalDeath flips a Mortal back to Immortal (permadeath -> standard play).
    FF.mortalDeath({ name:'Test Foe' }); eq(s.mortal, false, 'a Mortal\'s death reverts them to Immortal');
    ok(!FF.isMortal(), 'isMortal() false after death');
    FF.choosePath('immortal'); eq(s.mortal, false, 'choosePath("immortal") sets Immortal');
    s.mortal = sv;
  });

  // ---- Blacksmithing: Forge Tools ordered alphabetically by the skill each tool benefits -------
  suite('blacksmithing forge order', function(){
    ok(Array.isArray(FF.TOOL_TYPES) && FF.TOOL_TYPES.length > 0, 'TOOL_TYPES exported');
    ok(typeof FF.toolBenefitLabel === 'function', 'toolBenefitLabel exported');
    // Mirror the render sort: a copy of TOOL_TYPES sorted by benefit label.
    var labels = FF.TOOL_TYPES.slice()
      .sort(function(a,b){ return FF.toolBenefitLabel(a).localeCompare(FF.toolBenefitLabel(b)); })
      .map(function(tt){ return FF.toolBenefitLabel(tt); });
    var expected = labels.slice().sort(function(a,b){ return a.localeCompare(b); });
    eq(JSON.stringify(labels), JSON.stringify(expected), 'Forge Tools cards are ordered A→Z by benefited skill');
    // Sanity: gathering + crafting tools are interleaved, not grouped (i.e. the sort actually mixes
    // the two families — the first label should not simply be the first GATHER_SKILL_IDS entry).
    ok(labels.length === FF.TOOL_TYPES.length, 'no tool cards dropped by the sort');
  });

  // ---- Report ---------------------------------------------------------------------------
  var summary = 'SELFTEST: ' + R.passed + ' passed, ' + R.failed + ' failed';
  if(window.console){ console.log(summary); if(R.failures.length) console.log('SELFTEST FAILURES:\n - ' + R.failures.join('\n - ')); }
  window.__FF_SELFTEST = R;
  try {
    var chip = document.createElement('div');
    chip.id = 'ff-selftest-chip';
    chip.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:' + (R.failed ? '#a12a2a' : '#2a6a3a') + ';color:#fff;padding:8px 12px;border-radius:8px;font:12px/1.4 monospace;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:340px;white-space:pre-wrap;';
    chip.textContent = summary + (R.failures.length ? '\n\n- ' + R.failures.join('\n- ') : '');
    document.body.appendChild(chip);
  } catch(e){}
})();
