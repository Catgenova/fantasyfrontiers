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
    eq(FF.getLevel(0), 1, 'getLevel(0)');
    eq(FF.getLevel(99), 1, 'getLevel(99) still level 1');
    eq(FF.getLevel(100), 2, 'getLevel(100)');
    eq(FF.getLevel(400), 3, 'getLevel(400)');
    eq(FF.getLevel(980100), 100, 'getLevel(980100) = 100');
    var prev = 0;
    for(var xp = 0; xp <= 1000000; xp += 5000){ var L = FF.getLevel(xp); ok(L >= prev, 'getLevel monotonic @' + xp); prev = L; }
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
    eq(outfitting.join(','), 'weaponsmithing,armorsmithing,tailoring,shieldsmithing,runesmithing,fletching,bowyer,leatherworking,jewelrycrafting', 'outfitting holds the gear skills');
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
    // every alchemy recipe requires a glass bottle + covers all 4 types x tiers
    var alc = FF.CRAFTING_SKILLS_ALCHEMY.recipes;
    ok(alc.every(function(r){ return r.inputs['metallurgy_glass'] === 1; }), 'every alchemy recipe needs 1 glass bottle');
    ok(FF.POTION_TYPE_IDS.every(function(t){ return alc.some(function(r){ return r.id===t+'_t0'; }) && alc.some(function(r){ return r.id===t+'_t20'; }); }), 'all 4 potion lines span t0..t20');
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

    // playerAccuracy is driven by the 5 chosen physiques + weapon proficiency (heavier on physiques).
    var base = { physique:{}, xp:{}, equippedMainhand:null, accuracyPhysiques:['agility','reflexes'] };
    FF.DEFAULT_ACCURACY_PHYSIQUES.forEach(function(id){ base.physique[id] = 0; });
    base.physique.agility = 100*100;   // getLevel(xp)=~101; large so the weighting is visible
    var accWith = FF.playerAccuracy(base);
    var base2 = { physique:{}, xp:{}, equippedMainhand:null, accuracyPhysiques:['reflexes'] };
    var accWithout = FF.playerAccuracy(base2);
    ok(accWith > accWithout, 'a leveled chosen physique raises accuracy');
    // accuracyPhysiques caps at the slot count.
    ok(FF.accuracyPhysiques({ accuracyPhysiques:['a','b','c','d','e','f','g'] }).length === FF.ACCURACY_PHYS_SLOTS, 'accuracy physiques capped at slot count');
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

  // ---- Warding proficiency (extra reflection from reflected-damage XP) ------------------
  suite('warding proficiency', function(){
    eq(FF.WARDING_SKILL_ID, 'warding', 'warding skill id');
    // Bonus: +1% at Lv1 -> +20% at Lv100, and clamped beyond.
    function st(lvl){ var xp = lvl<=1 ? 0 : Math.pow(lvl-1,2)*100; var o={xp:{}}; o.xp.warding = xp; return o; }
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
