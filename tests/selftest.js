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
    eq(FF.craftXpBonus('paving'), 2, 'paving crafting gets a 2x XP bonus');
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
    eq(building.join(','), 'carpentry,masonry,paving,stonecutting', 'building holds the estate-build skills');
    eq(outfitting.join(','), 'weaponsmithing,armorsmithing,tailoring,shieldsmithing,fletching,bowyer,leatherworking,jewelrycrafting', 'outfitting holds the gear skills');
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
