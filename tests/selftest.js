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
  function near(a, b, msg){ ok(Math.abs(a - b) <= 1e-9, msg + ' (got ' + a + ', want ~' + b + ')'); }
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
    eq(FF.recipeTier({}, 'metallurgy_glass'), 0, 'recipeTier no-tier -> 0');
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
    // The raws still have consumers (no orphans): Hide feeds Tanning + jewelry Twine.
    ok(FF.ALL_CRAFT_RECIPES['twine_t5'].inputs['butchering_t5'], 'Hide still feeds jewelry Twine');
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
    var am5 = FF.getAmuletTierData(5).inputs;
    eq(am5['goldsmithing_t5'], 1, 'amulets now require a matching Setting');
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
    var am5 = FF.getAmuletTierData(5).inputs;
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
    // Frostwarden Frostbite +25%; chill chance rises Lv20->Lv60; Absolute Zero stacks vs chilled.
    eq(FF.frostwardenDmgMult(stFor('frostwarden',1)), 1.25, 'Frostwarden Frostbite +25%');
    ok(Math.abs(FF.frostwardenChillChance(stFor('frostwarden',20)) - 0.15) < 1e-9, 'Chilling Touch 15% at Lv20');
    ok(Math.abs(FF.frostwardenChillChance(stFor('frostwarden',60)) - 0.30) < 1e-9, 'Deep Freeze 30% at Lv60');
    var chilled = stFor('frostwarden',80); chilled.activity.enemyChillUntil = FF.now ? FF.now()+4000 : Date.now()+4000; chilled.activity.enemyChillPct = 0.5;
    ok(FF.enemyChilled(chilled) && Math.abs(FF.frostwardenDmgMult(chilled) - 1.75) < 1e-6, 'Absolute Zero: +40% vs Chilled stacks on Frostbite (x1.75)');
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
    eq(FF.frostwardenDmgMult(none), 1, 'no class -> Frostbite neutral');
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
      if(id==='pyromancer'){ st.equippedMainhand='wandFire'; st.equippedOffhand='wardLight'; st.bodyArmor={helmet:armor('tailoring'),chest:armor('tailoring'),boots:armor('tailoring')}; }
      if(id==='sharpshooter'){ st.equippedMainhand='bowLong'; st.equippedOffhand='quiver'; st.bodyArmor={helmet:armor('leather'),chest:armor('leather'),boots:armor('leather')}; }
      if(id==='juggernaut'){ st.equippedMainhand='sledge'; st.bodyArmor={helmet:armor('plate'),chest:armor('plate'),gauntlets:armor('plate'),boots:armor('plate')}; }
      if(id==='nightblade'){ st.equippedMainhand='wandDark'; st.equippedOffhand='wardLight'; st.bodyArmor={helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather')}; }
      if(id==='executioner'){ st.equippedMainhand='fullmoonaxe'; st.bodyArmor={chest:armor('chain'),gauntlets:armor('chain'),boots:armor('leather')}; } // no helmet = bare head
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    // gating: each mock activates exactly its class (unique unused weapon disambiguates)
    eq(FF.activeClassId(stFor('pyromancer',80)), 'pyromancer', 'fire wand + ward + cloth => Pyromancer');
    eq(FF.activeClassId(stFor('sharpshooter',80)), 'sharpshooter', 'long bow + quiver + leather => Sharpshooter');
    eq(FF.activeClassId(stFor('juggernaut',80)), 'juggernaut', 'sledge + full plate => Juggernaut');
    eq(FF.activeClassId(stFor('nightblade',80)), 'nightblade', 'dark wand + ward + leather => Nightblade');
    eq(FF.activeClassId(stFor('executioner',80)), 'executioner', 'full-moon axe + bare head + chain => Executioner');

    var monFull = {hp:100}, monLow = {hp:100};
    // Pyromancer: Kindle x1.30; Meltdown +50% vs healthy enemy stacks at Lv80; crit/block perks.
    ok(Math.abs(FF.newClassDmgMult(monFull, stFor('pyromancer',1)) - 1.30) < 1e-9, 'Pyromancer Kindle +30%');
    var pyroFull = stFor('pyromancer',80); // enemy at full HP (monsterHp 100)
    ok(Math.abs(FF.newClassDmgMult(monFull, pyroFull) - 1.95) < 1e-9, 'Pyromancer Meltdown stacks on Kindle vs healthy foe (x1.95)');
    var pyroLow = stFor('pyromancer',80,{activity:{type:'combat',monsterHp:10}});
    ok(Math.abs(FF.newClassDmgMult(monLow, pyroLow) - 1.30) < 1e-9, 'Pyromancer Meltdown falls off below half HP (x1.30)');
    ok(Math.abs(FF.newClassCritChance(stFor('pyromancer',80)) - 0.12) < 1e-9, 'Pyromancer Combustion +12% crit chance');
    ok(Math.abs(FF.newClassCritDmg(stFor('pyromancer',80)) - 0.75) < 1e-9, 'Pyromancer Conflagration +75% crit dmg');
    eq(FF.classBlockBonus(stFor('pyromancer',80)), 0.15, 'Pyromancer Ember Ward +15% Block');
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
    // Executioner: Reap +30% vs wounded; Bloodthirst 8%; Grisly +50% crit dmg; Cleave +12% crit; Decapitate exists.
    ok(Math.abs(FF.newClassDmgMult(monLow, stFor('executioner',80,{activity:{type:'combat',monsterHp:10}})) - 1.30) < 1e-9, 'Executioner Reap the Weak +30% vs wounded foe');
    eq(FF.newClassDmgMult(monFull, stFor('executioner',80)), 1, 'Executioner Reap is neutral vs a healthy foe');
    ok(Math.abs(FF.executionerLifestealPct(stFor('executioner',80)) - 0.08) < 1e-9, 'Executioner Bloodthirst 8%');
    ok(Math.abs(FF.newClassCritDmg(stFor('executioner',80)) - 0.50) < 1e-9, 'Executioner Grisly Resolve +50% crit dmg');
    ok(Math.abs(FF.newClassCritChance(stFor('executioner',80)) - 0.12) < 1e-9, 'Executioner Cleave +12% crit chance');
    ok(/Decapitate/.test(FF.CLASS_DEFS_BY_ID.executioner.passives[4].name), 'Executioner Lv80 is Decapitate');
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
    // every alchemy recipe requires a glass bottle + covers its 4 types x tiers (enchant is a separate Enchanting line)
    var alc = FF.CRAFTING_SKILLS_ALCHEMY.recipes;
    ok(alc.every(function(r){ return r.inputs['metallurgy_glass'] === 1; }), 'every alchemy recipe needs 1 glass bottle');
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

    // Familiar accuracy: concave curve — fast early gains, small gains near the cap.
    var early = FF.familiarAccuracy(10) - FF.familiarAccuracy(1);
    var late = FF.familiarAccuracy(100) - FF.familiarAccuracy(90);
    ok(FF.familiarAccuracy(100) > FF.familiarAccuracy(1), 'familiar accuracy rises with level');
    ok(early > late, 'familiar gains accuracy faster early than lv90->100 (' + early + ' vs ' + late + ')');
    ok(late < 20, 'lv90->100 familiar accuracy gain is small (' + late + ')');

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

    // Ward recipe: 3 logs + 3 ingots + 3 element glyphs (no upgrade chain).
    var d3 = FF.getWardTierData('wardWater', 3);
    eq(d3.inputs['forestry_t3'], 3, 'ward needs 3 logs of its tier');
    eq(d3.inputs['metallurgy_t3'], 3, 'ward needs 3 ingots of its tier');
    eq(d3.inputs['glyph_water'], 3, 'water ward needs 3 water glyphs');
    ok(d3.inputs['stward_wardWater_t2_normal'] === undefined, 'no previous-tier-ward requirement anymore');
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

    // Recipe: 2 logs + 3 element glyphs (no metal, no upgrade chain).
    var d5 = FF.getStackableWeaponTierData('wandFire', 5);
    eq(d5.inputs['forestry_t5'], 2, 'wand needs 2 logs of its tier');
    eq(d5.inputs['glyph_fire'], 3, 'fire wand needs 3 fire glyphs');
    ok(d5.inputs['metallurgy_t5'] === undefined, 'wands need no metal');
    ok(d5.inputs['stweapon_wandFire_t4_normal'] === undefined, 'no upgrade chain');
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

    // Recipe: 4 logs + 8 dark glyphs.
    var d = FF.getStackableWeaponTierData('staff', 7);
    eq(d.inputs['forestry_t7'], 4, 'staff needs 4 logs');
    eq(d.inputs['glyph_dark'], 8, 'staff needs 8 dark glyphs');
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

    // Recipe: 4 ingots + 8 light glyphs (named after the metal).
    var d = FF.getStackableWeaponTierData('scepter', 7);
    eq(d.inputs['metallurgy_t7'], 4, 'scepter needs 4 ingots of its tier');
    eq(d.inputs['glyph_light'], 8, 'scepter needs 8 light glyphs');
    ok(d.inputs['forestry_t7'] === undefined, 'scepter uses no logs');
    ok(d.inputs['stweapon_scepter_t6_normal'] === undefined, 'no upgrade chain');
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

    // Lv 60 passive: +15% block, but only while the class is actually equipped/active.
    eq(FF.classBlockBonus(full), 0, 'Lv 1 summoner: no block bonus yet');
    eq(FF.classBlockBonus(leveled), 0.15, 'Lv 60 summoner (equipped): +15% block');
    var leveledNoGear = { xp:{summoner:FF.xpFloorForLevel(60)}, equippedMainhand:'greatsword', bodyArmor:{ helmet:bare(),chest:bare(),gauntlets:bare(),boots:bare(),back:bare() } };
    eq(FF.classBlockBonus(leveledNoGear), 0, 'high-level summoner with gear off: no block bonus');

    // The class has its own familiar with a damaging kit that carries its element.
    var fam = FF.FAMILIAR_DATA.summoner;
    ok(fam && fam.spells && fam.spells.length === 4, 'summoner familiar has 4 spells');
    var dmgSpells = fam.spells.filter(function(s){ return s.type==='hit' || s.type==='siphon'; });
    ok(dmgSpells.length >= 2, 'summoner familiar has damaging spells (for the double-damage passive)');
    ok(fam.spells.some(function(s){ return s.element==='light'; }), 'summoner familiar spells carry the light element');
  });

  // ---- Classes: Duelist (rapier fencer with speed/precision/riposte passives) -----------
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

    // Lv 20 Flashing Steel: -10% attack time per rarity rank on the rapier (only from Lv 20).
    var lvHi = FF.xpFloorForLevel(60); // ~Lv 60
    function leveled(rarity){ var s = base(rarity); s.xp.duelist = lvHi; return s; }
    eq(FF.classAttackSpeedMult(full), 1, 'Lv 1 duelist: no attack-speed bonus yet');
    near(FF.classAttackSpeedMult(leveled('normal')), 1, 'normal rapier: no reduction');
    near(FF.classAttackSpeedMult(leveled('rare')), 0.9, 'rare rapier: -10%');
    near(FF.classAttackSpeedMult(leveled('supreme')), 0.8, 'supreme rapier: -20%');
    near(FF.classAttackSpeedMult(leveled('fantastic')), 0.7, 'fantastic rapier: -30%');
    var fastButOff = leveled('fantastic'); fastButOff.equippedOffhand='shieldSmall';
    eq(FF.classAttackSpeedMult(fastButOff), 1, 'attack-speed bonus is gated on the class being active');

    // Lv 40 Perfect Form: +30% accuracy, folded into playerAccuracy.
    eq(FF.classAccuracyMult(full), 1, 'Lv 1 duelist: no accuracy bonus');
    eq(FF.classAccuracyMult(leveled('normal')), 1.3, 'Lv >= 40 duelist: +30% accuracy');
    var accOn = leveled('normal'); accOn.physique = {}; FF.ACCURACY_PHYSIQUES.forEach(function(id){ accOn.physique[id] = FF.xpFloorForLevel(21); });
    var accOff = { xp:accOn.xp, equippedMainhand:'rapier', equippedMainhandRarity:'normal', equippedOffhand:'shieldSmall', bodyArmor:accOn.bodyArmor, physique:accOn.physique };
    ok(FF.playerAccuracy(accOn) > FF.playerAccuracy(accOff), 'active Duelist gets higher accuracy than the same build with the class off');
    ok(Math.abs(FF.playerAccuracy(accOn) - Math.round(FF.playerAccuracy(accOff)*1.3)) <= 2, 'accuracy scales by the +30% class multiplier');

    // Class familiar.
    var fam = FF.FAMILIAR_DATA.duelist;
    ok(fam && fam.spells && fam.spells.length === 4, 'duelist familiar has 4 spells');
    ok(fam.spells.some(function(s){ return s.element==='fire'; }), 'duelist familiar damaging spells carry the fire element');
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

    // Lv 1 Mortal Edge: +50% crit damage (only while active).
    eq(FF.reaperCritDmgBonus(full), 0.5, 'Lv 1 reaper (active): +0.5 crit damage');
    var lowNoGear = { xp:{reaper:lvHi}, equippedMainhand:'greatsword', bodyArmor:{helmet:bare(),chest:bare(),gauntlets:bare(),boots:bare(),back:bare()} };
    eq(FF.reaperCritDmgBonus(lowNoGear), 0, 'reaper crit bonus gated on the class being active');

    // Lv 40 / Lv 80 lifesteal: 5% then 10% (replaces, not stacks).
    eq(FF.reaperLifestealPct(full), 0, 'Lv 1 reaper: no lifesteal yet');
    var lv40 = base(); lv40.xp.reaper = FF.xpFloorForLevel(46); // ~Lv 46
    eq(FF.reaperLifestealPct(lv40), 0.05, 'Lv 40-79 reaper: 5% lifesteal');
    eq(FF.reaperLifestealPct(leveled()), 0.10, 'Lv 80 reaper: 10% lifesteal (replaces the 5%)');

    // Lv 60 Exposed Flesh: +50% damage vs enemies with no slashing resistance.
    var noSlashArmor = { armorTypes:{slashing:0, piercing:0.65, blunt:0.35} };
    var slashArmor   = { armorTypes:{slashing:0.65, piercing:0.35, blunt:0} };
    eq(FF.reaperNoSlashResistMult(noSlashArmor, leveled()), 1.5, 'no slashing resistance => +50% damage');
    eq(FF.reaperNoSlashResistMult(slashArmor, leveled()), 1, 'some slashing resistance => no bonus');
    eq(FF.reaperNoSlashResistMult(noSlashArmor, full), 1, 'Lv 1 reaper: no Exposed Flesh yet');

    // Class familiar leans on life-drain (siphon) spells for the Lv 20 triple-damage passive.
    var fam = FF.FAMILIAR_DATA.reaper;
    ok(fam && fam.spells && fam.spells.length === 4, 'reaper familiar has 4 spells');
    ok(fam.spells.filter(function(s){ return s.type==='siphon'; }).length >= 2, 'reaper familiar has multiple siphon (life-drain) spells');
    ok(fam.spells.some(function(s){ return s.element==='dark'; }), 'reaper familiar damaging spells carry the dark element');
  });

  // ---- Classes: Herald (plate + mace + large shield; block-into-offense tank) -----------
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

    // Lv 1 Bulwark: +15% block, folded into classBlockBonus and playerBlockChance.
    eq(FF.classBlockBonus(full), 0.15, 'Herald Lv 1: +15% block');
    var off = base(); off.equippedOffhand=null;
    eq(FF.classBlockBonus(off), 0, 'herald block bonus gated on the class being active');
    ok(FF.playerBlockChance(full) - FF.playerBlockChance(off) >= 0.15 - 1e-9, 'the Herald +15% is folded into total block chance');

    // Lv 20 Shield Breaker: outgoing damage x(1 + block chance).
    eq(FF.heraldBlockDmgMult(full), 1, 'Lv 1 herald: no damage bonus yet');
    near(FF.heraldBlockDmgMult(leveled()), 1 + FF.playerBlockChance(leveled()), 'Lv 20+: +damage equal to block chance');
    // Lv 40 Aegis: armor x(1 + block chance).
    eq(FF.heraldBlockArmorMult(full), 1, 'Lv 1 herald: no armor bonus yet');
    near(FF.heraldBlockArmorMult(leveled()), 1 + FF.playerBlockChance(leveled()), 'Lv 40+: +armor equal to block chance');

    // Lv 60 Tidewall: -60% incoming water damage.
    eq(FF.heraldWaterResistMult({element:'water'}, leveled()), 0.4, 'water enemy => damage x0.4 (60% less)');
    eq(FF.heraldWaterResistMult({element:'fire'}, leveled()), 1, 'non-water enemy => no reduction');
    eq(FF.heraldWaterResistMult({element:'water'}, full), 1, 'Lv 1 herald: no water resist yet');

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
    ok(byId.blunt && !byId.blunt.kind, 'physical rings still have no kind');

    var TC = FF.TIER_COUNT;
    // Tier ladder scales min->max at Normal; rarity multiplies 2x/4x/8x (wand ladder).
    var fireTop = FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_normal'];
    near(fireTop.bonus, 0.20, 'top-tier Normal Ring of Fire = +20% fire dmg');
    eq(fireTop.kind, 'elementDamage', 'ring item carries kind');
    eq(fireTop.element, 'fire', 'ring item carries element');
    near(FF.RING_ITEMS['ring_fire_t0_normal'].bonus, 0.01, 't0 Normal Ring of Fire = +1%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_rare'].bonus, 0.40, 'Rare doubles to +40%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_supreme'].bonus, 0.80, 'Supreme x4 = +80%');
    near(FF.RING_ITEMS['ring_fire_t'+(TC-1)+'_fantastic'].bonus, 1.60, 'Fantastic x8 = +160%');
    near(FF.RING_ITEMS['ring_precision_t'+(TC-1)+'_normal'].bonus, 0.30, 'top Precision Normal = +30% acc');
    near(FF.RING_ITEMS['ring_precision_t0_normal'].bonus, 0.05, 't0 Precision = +5% acc');
    near(FF.RING_ITEMS['ring_warding_t'+(TC-1)+'_normal'].bonus, 0.20, 'top Warding Normal = +20% resist');

    // Physical rings unchanged.
    var bluntTop = FF.RING_ITEMS['ring_blunt_t'+(TC-1)+'_normal'];
    ok(bluntTop.dmgBonus > 0 && bluntTop.damageType === 'blunt', 'physical rings keep dmgBonus/damageType');
    ok(bluntTop.bonus === undefined, 'physical rings have no kind bonus field');

    function sl(typeId, tier, rarity){ return {typeId:typeId, tier:tier, rarity:rarity||'normal'}; }
    function empty(){ return {typeId:null, tier:0, rarity:'normal'}; }
    function st(rings){
      var js = { ring1:empty(), ring2:empty(), ring3:empty(), ring4:empty(), ring5:empty(), amulet:{tier:0,rarity:'normal'} };
      (rings||[]).forEach(function(r,i){ js['ring'+(i+1)] = r; });
      return { jewelrySlots: js, physique:{}, xp:{} };
    }

    // Element ring bonus sums across slots.
    var oneFire = st([sl('fire', TC, 'normal')]); // +20%
    near(FF.getRingElementDamageBonus(oneFire, 'fire'), 0.20, 'one top fire ring => +20%');
    eq(FF.getRingElementDamageBonus(oneFire, 'water'), 0, 'no water rings => 0');
    var twoFire = st([sl('fire', TC, 'normal'), sl('fire', TC, 'normal')]);
    near(FF.getRingElementDamageBonus(twoFire, 'fire'), 0.40, 'two fire rings stack to +40%');

    // Folds into elementDmgMult on top of attunement.
    var baseMult = FF.elementDmgMult(st([]), 'fire');
    near(FF.elementDmgMult(oneFire, 'fire') - baseMult, 0.20, 'fire ring adds +0.20 to the fire damage multiplier');

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

    // Kind rings do not add physical (damage-type) multiplier; physical rings do.
    eq(FF.getRingDamageMultiplier(oneFire, {blunt:1}), 1, 'element rings add no physical damage multiplier');
    ok(FF.getRingDamageMultiplier(st([sl('blunt', TC, 'normal')]), {blunt:1}) > 1, 'blunt ring boosts blunt weapons');
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

    var lv1 = base(); // fresh -> Lv 1 (Chain Lightning on)
    var lv20 = base(); lv20.xp.thunderfury = FF.xpFloorForLevel(21); // ~Lv 21 (Storm Focus on)

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

    // Lv 20 Storm Focus: crit stacks grant +20% accuracy/stack.
    eq(FF.classAccuracyMult(lv1), 1, 'Lv 1: no accuracy stacking yet');
    var a3 = base(); a3.xp.thunderfury = FF.xpFloorForLevel(21); a3.thunderStacks=3;
    near(FF.classAccuracyMult(a3), 1.60, 'Lv 20+, 3 stacks => +60% accuracy');

    // Lv 60 Storm's Wrath: +100% crit damage while below 50% HP (reads global state).
    var s = FF._state;
    var snap = { xpT:s.xp.thunderfury, main:s.equippedMainhand, off:s.equippedOffhand, hp:s.playerHp,
      helm:s.bodyArmor.helmet, chest:s.bodyArmor.chest, gaunt:s.bodyArmor.gauntlets, boots:s.bodyArmor.boots };
    s.equippedMainhand='wandEarth'; s.equippedOffhand='wardEarth';
    s.bodyArmor.helmet=cloth(); s.bodyArmor.chest=cloth(); s.bodyArmor.gauntlets=cloth(); s.bodyArmor.boots=cloth();
    s.xp.thunderfury = FF.xpFloorForLevel(65); // ~Lv 65
    s.playerHp = 999999; // full-ish (above 50%)
    eq(FF.thunderLowHpCritDmg(), 0, 'above 50% HP: no crit-damage bonus');
    s.playerHp = 1; // below 50%
    near(FF.thunderLowHpCritDmg(), 1.0, 'below 50% HP: +100% crit damage');
    s.xp.thunderfury = snap.xpT; s.equippedMainhand = snap.main; s.equippedOffhand = snap.off; s.playerHp = snap.hp;
    s.bodyArmor.helmet = snap.helm; s.bodyArmor.chest = snap.chest; s.bodyArmor.gauntlets = snap.gaunt; s.bodyArmor.boots = snap.boots;

    // Lv 40 Concussive Bolt: stun window helper.
    eq(FF.enemyStunned({ activity:{ enemyStunUntil: Date.now()+2000 } }), true, 'active stun window => stunned');
    eq(FF.enemyStunned({ activity:{ enemyStunUntil: Date.now()-1 } }), false, 'expired stun window => not stunned');
    eq(FF.enemyStunned({ activity:{} }), false, 'no stun => not stunned');

    // Class familiar (lightning caster).
    var fam = FF.FAMILIAR_DATA.thunderfury;
    ok(fam && fam.spells && fam.spells.length === 4, 'thunderfury familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'thunderfury familiar has a damaging spell');
  });

  // ---- Classes: Assassin (dual-claw dodge/armor-pen killer) -----------------------------
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

    // Lv 1 Bloodletting: double Claws proficiency XP.
    eq(FF.assassinClawXpMult(full), 2, 'Lv 1 assassin: double claw XP');
    eq(FF.assassinClawXpMult(off), 1, 'claw XP bonus gated on the class being active');

    // Lv 20 (+10%) and Lv 60 (+15%) Dodge, stacking to +25%.
    eq(FF.assassinDodgeBonus(full), 0, 'Lv 1: no dodge bonus yet');
    var lv20 = base(); lv20.xp.assassin = FF.xpFloorForLevel(21); // ~Lv 21
    near(FF.assassinDodgeBonus(lv20), 0.10, 'Lv 20: +10% dodge');
    near(FF.assassinDodgeBonus(leveled()), 0.25, 'Lv 60+: +25% dodge (10 + 15)');
    ok(FF.playerDodgeChance(leveled()) - FF.playerDodgeChance(full) >= 0.25 - 1e-9, 'assassin dodge is folded into total dodge chance');

    // Lv 40 Exploit Weakness: +20% damage (ignore 20% armor).
    eq(FF.assassinArmorPenMult(full), 1, 'Lv 1: no armor pen');
    near(FF.assassinArmorPenMult(leveled()), 1.20, 'Lv 40+: +20% damage');

    // Lv 80 Perfect Killer: outgoing damage x(1 + dodge chance).
    eq(FF.assassinDodgeDmgMult(full), 1, 'Lv 1: no dodge-to-damage');
    near(FF.assassinDodgeDmgMult(leveled()), 1 + FF.playerDodgeChance(leveled()), 'Lv 80: +damage equal to dodge chance');

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
  });

  // ---- Improvement system: enhance (Stage 2) --------------------------------------------
  suite('improvement: enhance', function(){
    ok(typeof FF.enhanceItem === 'function' && typeof FF.enhanceSuccessChance === 'function', 'enhance exported');
    near(FF.enhanceSuccessChance(0), 0.95, 'first enhance is 95%');
    near(FF.enhanceSuccessChance(1), 0.90, 'second is 90%');
    near(FF.enhanceSuccessChance(5), 0.70, '+5 -> 70%');
    eq(FF.enhanceSuccessChance(20) >= 0.05, true, 'success chance floors at 5%');
    // inscription planning (throwaway selftest inventory)
    var s = FF._state, savedInv = s.inventory;
    s.inventory = { inscription_t2:1, inscription_t4:5 };
    ok(FF.planInscriptions(5, 1) === null, 'cannot plan when no inscription is tier5+');
    var pl = FF.planInscriptions(2, 3);
    ok(pl && pl.plan.inscription_t2===1 && pl.plan.inscription_t4===2 && pl.maxTier===4, 'plans tier2 first then higher');
    s.inventory = savedInv;
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
