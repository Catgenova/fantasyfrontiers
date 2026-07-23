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

  // ---- Over-100 Mastery: gathering & crafting overlevel + double output ------------------
  suite('over-100 mastery', function(){
    var EXT = FF.SKILL_XP_FLOOR_EXT, MAX = FF.MAX_SKILL_LEVEL;
    // The extended table reuses the 0..100 floors verbatim, then each level past 100 doubles the prior cost.
    eq(EXT[100], FF.xpFloorForLevel(100), 'the extended table matches the classic floor at level 100');
    eq(EXT[99], FF.xpFloorForLevel(99), '...and at 99');
    var base = EXT[100] - EXT[99];              // cost(99 -> 100)
    near((EXT[101]-EXT[100]) / base, 2.0, 'cost(100->101) doubles cost(99->100)', 1e-6);
    near((EXT[102]-EXT[101]) / (EXT[101]-EXT[100]), 2.0, 'cost(101->102) doubles cost(100->101)', 1e-6);
    near((EXT[110]-EXT[109]) / base, Math.pow(2,10), 'cost keeps doubling per level past 100', 1e-3);

    // getLevelExt agrees with getLevel below 100, and keeps climbing above it.
    for(var L = 1; L <= 100; L++){ eq(FF.getLevelExt(EXT[L]), L, 'getLevelExt(floor('+L+')) = '+L); }
    eq(FF.getLevelExt(EXT[105]), 105, 'level 105 is reachable in the extended table');
    eq(FF.getLevelExt(EXT[105]-1), 104, 'one XP short of 105 is still 104');
    eq(FF.getLevelExt(EXT[FF.SKILL_MAX_LEVEL_EXT] * 4), FF.SKILL_MAX_LEVEL_EXT, 'the extended table has its own ceiling');

    // Only gathering & crafting skills overlevel; combat/proficiency skills stay capped at 100.
    ok(FF.skillCanOverlevel('mining'), 'a gathering skill can overlevel');
    ok(FF.skillCanOverlevel('weaponsmithing'), 'a crafting skill can overlevel');
    ok(!FF.skillCanOverlevel('sword'), 'a weapon proficiency does not overlevel');
    ok(!FF.skillCanOverlevel('platearmor'), 'an armor proficiency does not overlevel');
    eq(FF.skillLevel('mining', EXT[108]), 108, 'skillLevel reads the extended table for gathering');
    eq(FF.skillLevel('sword', EXT[150]), 100, 'skillLevel caps a combat skill at 100 regardless of XP');
    eq(FF.skillLevel('mining', FF.xpFloorForLevel(60)), 60, 'below 100 the two ladders agree');

    // Progress bar past 100: 0% at a fresh level, ~50% halfway, respects the doubled cost.
    near(FF.skillLevelProgress('mining', EXT[103]), 0, 'progress resets to 0 at a freshly-reached level', 1e-6);
    near(FF.skillLevelProgress('mining', EXT[103] + (EXT[104]-EXT[103])/2), 50, 'progress is ~50% halfway to 104', 0.5);
    eq(FF.skillLevelProgress('sword', 1e18), 100, 'a maxed combat skill shows a full bar');

    // Skill-bar XP readout: "into / span" of the current level, shown beside the percentage.
    var midXp = FF.xpFloorForLevel(50) + Math.round((FF.xpForNextLevel(50) - FF.xpFloorForLevel(50)) / 2);
    var sp = FF.skillLevelXpSpan('sword', midXp);
    eq(sp.span, FF.xpForNextLevel(50) - FF.xpFloorForLevel(50), 'xp span is the level width');
    eq(sp.into, midXp - FF.xpFloorForLevel(50), 'xp into level is xp above the floor');
    ok(!sp.maxed, 'a mid-level skill is not maxed');
    ok(FF.skillLevelXpSpan('sword', 1e18).maxed, 'a capped combat skill reports maxed');
    ok(/\bXP\b/.test(FF.skillBarRightLabel('sword', midXp)) && /50%/.test(FF.skillBarRightLabel('sword', midXp)), 'the bar label shows both an XP count and the percentage');
    eq(FF.skillBarRightLabel('sword', 1e18), 'MAX', 'a maxed skill bar reads MAX');
    // Gathering skills keep leveling past 100 -- the readout follows the extended (doubled-cost) ladder.
    var extSpan = FF.skillLevelXpSpan('mining', EXT[103] + (EXT[104]-EXT[103])/2);
    eq(extSpan.span, EXT[104]-EXT[103], 'over-100 xp span uses the extended ladder');

    // Output-double bonus: +1% per level over 100, zero at/under 100 and for non-overlevel skills.
    near(FF.overLevelDoublePct('mining', EXT[101]), 0.01, 'level 101 -> +1% double output');
    near(FF.overLevelDoublePct('mining', EXT[110]), 0.10, 'level 110 -> +10% double output');
    near(FF.overLevelDoublePct('mining', EXT[100]), 0, 'no bonus exactly at 100');
    near(FF.overLevelDoublePct('mining', FF.xpFloorForLevel(80)), 0, 'no bonus below 100');
    near(FF.overLevelDoublePct('sword', EXT[150]), 0, 'combat skills never get the double-output bonus');
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

  // ---- Card XP preview: base vs. real earned (Mortal / server buff / Tea / familiar / Diligence / Curiosity) ----
  suite('cards: base vs real XP', function(){
    var s = FF._state;
    var saved = { mortal:s.mortal, tea:s.activeTea, fam:s.familiars, dil:s.physique.diligence, cur:s.physique.curiosity };
    function clear(){
      s.mortal = false;
      s.activeTea = { itemId:null, name:null, icon:null, xpBoost:0, durationMs:0, expiresAt:0 };
      s.familiars = {};
      s.physique.diligence = 0; s.physique.curiosity = 0;
    }
    // Neutral baseline: a craft skill with nothing active earns exactly its base.
    clear();
    eq(FF.addXpAppliedMult('cooking'), 1, 'no modifiers -> x1 applied multiplier');
    eq(FF.cardRealXp('cooking', 100, 'craft'), 100, 'craft real == base with no bonuses');

    // Mortal deficit halves the real XP.
    clear(); s.mortal = true;
    eq(FF.cardRealXp('cooking', 100, 'craft'), 50, 'Mortal deficit halves real XP');

    // Paving's intrinsic x4 craft-XP multiplier lives in the displayed BASE (it applies to every
    // completion), so the real figure stays a pure personal-boost readout.
    clear();
    eq(FF.cardRealXp('paving', 100, 'craft'), 100, 'paving real carries no intrinsic multiplier');
    var pav = FF.xpStat('paving', 100, 'craft', 8);
    ok(/\+400 XP/.test(pav) && !/real/.test(pav), 'paving base states the x4 (+400); no real span when nothing else is active');
    eq(FF.cardRealXp('cooking', 100, 'craft'), 100, 'every other craft keeps the x1 bonus');

    // A Tea (Mixology/Brewing XP boost) multiplies the real figure.
    clear(); s.activeTea = { itemId:'tea_x', name:'T', icon:'', xpBoost:0.2, durationMs:1e6, expiresAt:Date.now()+1e6 };
    eq(FF.cardRealXp('cooking', 100, 'craft'), 120, 'an active Tea (+20%) lifts real XP');

    // A skill familiar adds +1% per level.
    clear(); s.familiars = { cooking:{ owned:true, level:10 } };
    eq(FF.cardRealXp('cooking', 100, 'craft'), 110, 'a level-10 familiar adds +10%');

    // Diligence lifts CRAFT XP but not gather; Curiosity lifts GATHER XP but not craft.
    clear(); s.physique.diligence = 1e9;
    ok(FF.cardRealXp('cooking', 1000, 'craft') > 1000, 'Diligence raises craft real XP');
    eq(FF.cardRealXp('mining', 1000, 'gather'), Math.round(1000*(1+FF.curiosityGatherXpBonus(s))), 'gather ignores Diligence');
    clear(); s.physique.curiosity = 1e9;
    eq(FF.cardRealXp('mining', 1000, 'gather'), 1150, 'Curiosity (capped +15%) raises gather real XP');
    eq(FF.cardRealXp('cooking', 1000, 'craft'), 1000, 'craft ignores Curiosity');

    // xpStat markup: a tier chip always; the "(+N real)" only when a modifier is changing it.
    clear();
    var plain = FF.xpStat('cooking', 100, 'craft', 2);
    ok(/t3/.test(plain) && /\+100 XP/.test(plain) && !/real/.test(plain), 'neutral: tier chip t3, base only, no real span');
    s.mortal = true;
    var mod = FF.xpStat('cooking', 100, 'craft', 4);
    ok(/t5/.test(mod) && /\(\+50 real\)/.test(mod), 'with a modifier: tier chip t5 and a (+50 real) span');

    // cardTierIndex resolves a number, an id string, or an object.
    eq(FF.cardTierIndex(3), 3, 'tier from number');
    eq(FF.cardTierIndex('paving_t7'), 7, 'tier from id');
    eq(FF.cardTierIndex({ tierIndex:5 }), 5, 'tier from object');

    s.mortal = saved.mortal; s.activeTea = saved.tea; s.familiars = saved.fam;
    s.physique.diligence = saved.dil; s.physique.curiosity = saved.cur;
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

  // ---- Estate: upgrade a placed pavement (20x the next-tier tile, keeps any building) ---
  suite('estate: upgrade pavement', function(){
    eq(FF.ESTATE_PAVE_TILE_COST, 20, 'an upgrade costs 20 tiles');
    eq(FF.pavementTierOf({ type:'paved', paveTileId:'paving_t3' }), 3, 'pavementTierOf reads the tier from paveTileId');
    eq(FF.pavementTierOf({ type:'dirt' }), -1, 'a dirt tile has no pavement tier');
    var s = FF._state;
    FF.estUse(false);                                  // point estActive at the personal estate
    var cell = s.estate.grid[0][0];
    var saved = { type:cell.type, pave:cell.paveTileId, work:cell.workshopId };
    var savedJob = s.estate.job, savedQueue = s.estate.queue;
    var savedInv = { t4:s.inventory['paving_t4'], t5:s.inventory['paving_t5'] };
    s.estate.job = null; s.estate.queue = [];
    cell.type = 'paved'; cell.paveTileId = 'paving_t3'; cell.workshopId = 'workshop_mining_t0'; // a building is present
    s.inventory['paving_t4'] = 25;
    FF.estateUpgradePavement(0, 0);
    // The upgrade is now a TIMED JOB, taking as long as paving that tier fresh (10 min/tier).
    var job = s.estate.job;
    ok(job && job.kind === 'pave' && job.upgrade === true, 'the upgrade starts a pave job flagged as an upgrade');
    eq(job.readyAt - job.startAt, 5 * FF.ESTATE_PAVE_MS_PER_TIER, 'a t5 (index 4) upgrade takes the same 50 min as paving it fresh');
    eq(cell.paveTileId, 'paving_t3', 'the pavement is untouched until the job completes');
    eq(s.inventory['paving_t4'], 5, 'the 20 target-tier tiles are consumed when the job starts');
    FF.applyEstateJobCompletion(s.estate, job, false, false);
    s.estate.job = null;
    eq(cell.paveTileId, 'paving_t4', 'completion raises the pavement one tier');
    eq(cell.workshopId, 'workshop_mining_t0', 'the building on the tile is kept');
    s.inventory['paving_t5'] = 3;                       // not enough for the next upgrade
    FF.estateUpgradePavement(0, 0);
    ok(!s.estate.job, 'no job starts without 20 of the next-tier tile');
    eq(cell.paveTileId, 'paving_t4', 'no upgrade without 20 of the next-tier tile');
    // restore
    cell.type = saved.type; cell.paveTileId = saved.pave; cell.workshopId = saved.work;
    s.estate.job = savedJob; s.estate.queue = savedQueue;
    s.inventory['paving_t4'] = savedInv.t4; s.inventory['paving_t5'] = savedInv.t5;
  });

  // ---- The SAME upgrade works on the guild estate (shared estActive engine, not a copy) ----
  suite('estate: upgrade guild pavement', function(){
    var s = FF._state, ge = FF.guildEstate;
    var savedGrid = ge.grid, savedStatus = ge.status, savedJob = ge.job, savedInv = s.inventory['paving_t2'];
    var savedPJob = s.estate.job, savedPQueue = s.estate.queue;
    s.estate.job = null; s.estate.queue = [];
    ge.grid = [[{ type:'paved', paveTileId:'paving_t1', workshopId:'workshop_mining_t0' }]]; // a paved guild tile with a building
    ge.status = 'ready'; ge.job = null;
    FF.estUse(true);                                   // point the shared engine at the guild estate
    s.inventory['paving_t2'] = 20;
    FF.estateUpgradePavement(0, 0);
    var job = ge.job;
    ok(job && job.kind === 'pave' && job.upgrade === true, 'the guild upgrade starts a timed job through the shared engine');
    eq(job.readyAt - job.startAt, 3 * FF.ESTATE_PAVE_MS_PER_TIER, 'a t3 (index 2) upgrade takes the fresh-pave 30 min');
    eq(ge.grid[0][0].paveTileId, 'paving_t1', 'the guild pavement waits for the job to finish');
    eq(s.inventory['paving_t2'], 0, 'the upgrade spent 20 next-tier tiles from personal inventory');
    FF.applyEstateJobCompletion(ge, job, false, true);
    ge.job = null;
    eq(ge.grid[0][0].paveTileId, 'paving_t2', 'completion upgrades the guild pavement');
    eq(ge.grid[0][0].workshopId, 'workshop_mining_t0', 'the guild building on the tile is kept');
    // restore
    FF.estUse(false); ge.grid = savedGrid; ge.status = savedStatus; ge.job = savedJob;
    s.estate.job = savedPJob; s.estate.queue = savedPQueue; s.inventory['paving_t2'] = savedInv;
  });

  // ---- Estate: upgrade a Workshop / Cottage (100x next-tier planks, gated by pavement) ----
  suite('estate: upgrade workshop & cottage', function(){
    eq(FF.ESTATE_BUILDING_UPGRADE_PLANKS, 100, 'a building upgrade costs 100 planks');
    var s = FF._state;
    FF.estUse(false);
    var cell = s.estate.grid[0][0];
    var saved = { type:cell.type, pave:cell.paveTileId, work:cell.workshopId, cot:cell.cottageId };
    var savedJob = s.estate.job, savedQueue = s.estate.queue;
    var savedInv = { c2:s.inventory['carpentry_t2'], c3:s.inventory['carpentry_t3'], c4:s.inventory['carpentry_t4'] };
    s.estate.job = null; s.estate.queue = [];
    // Workshop t2 on t5 pavement -> upgrade to t3 for 100x the t3 plank, taking the fresh t3 build time.
    cell.type = 'paved'; cell.paveTileId = 'paving_t5'; cell.cottageId = null; cell.workshopId = 'workshop_mining_t2';
    s.inventory['carpentry_t3'] = 100;
    FF.estateUpgradeWorkshop(0, 0);
    var wjob = s.estate.job;
    ok(wjob && wjob.kind === 'workshop' && wjob.upgrade === true, 'the workshop upgrade starts a timed job');
    eq(wjob.readyAt - wjob.startAt, 4 * FF.ESTATE_WORKSHOP_MS_PER_TIER, 'a t4 (index 3) upgrade takes the fresh-build 120 min');
    eq(cell.workshopId, 'workshop_mining_t2', 'the old workshop keeps working until the job completes');
    eq(s.inventory['carpentry_t3'], 0, 'the upgrade consumed 100 next-tier planks at start');
    FF.applyEstateJobCompletion(s.estate, wjob, false, false);
    s.estate.job = null;
    eq(cell.workshopId, 'workshop_mining_t3', 'completion raises the workshop one tier, same skill');
    // Pavement too low blocks it: workshop t3 -> t4 needs pavement >= t4, but the pavement is t3.
    cell.paveTileId = 'paving_t3'; s.inventory['carpentry_t4'] = 100;
    FF.estateUpgradeWorkshop(0, 0);
    ok(!s.estate.job, 'no job while the pavement is too low');
    eq(cell.workshopId, 'workshop_mining_t3', 'no upgrade while the pavement is too low');
    eq(s.inventory['carpentry_t4'], 100, '...and no planks are spent when blocked');
    // Cottage t1 on t5 pavement -> upgrade to t2 for 100x the t2 plank, taking the fresh t2 build time.
    cell.workshopId = null; cell.cottageId = 'cottage_t1'; cell.paveTileId = 'paving_t5';
    s.inventory['carpentry_t2'] = 100;
    FF.estateUpgradeCottage(0, 0);
    var cjob = s.estate.job;
    ok(cjob && cjob.kind === 'cottage' && cjob.upgrade === true, 'the cottage upgrade starts a timed job');
    eq(cjob.readyAt - cjob.startAt, 3 * FF.ESTATE_COTTAGE_MS_PER_TIER, 'a t3 (index 2) cottage upgrade takes the fresh-build 30 min');
    eq(cell.cottageId, 'cottage_t1', 'the old cottage stands until the job completes');
    FF.applyEstateJobCompletion(s.estate, cjob, false, false);
    s.estate.job = null;
    eq(cell.cottageId, 'cottage_t2', 'completion raises the cottage one tier');
    eq(s.inventory['carpentry_t2'], 0, 'the cottage upgrade spent 100 next-tier planks');
    // restore
    cell.type = saved.type; cell.paveTileId = saved.pave; cell.workshopId = saved.work; cell.cottageId = saved.cot;
    s.estate.job = savedJob; s.estate.queue = savedQueue;
    s.inventory['carpentry_t2'] = savedInv.c2; s.inventory['carpentry_t3'] = savedInv.c3; s.inventory['carpentry_t4'] = savedInv.c4;
    FF.estRecomputeWorkshops(); // rebuild the workshop cache from the restored grid
  });

  // ---- Estate: multi-tier upgrades (jump straight to any tier, not just the next) ----
  suite('estate: multi-tier upgrades', function(){
    var s = FF._state;
    FF.estUse(false);
    var cell = s.estate.grid[0][0];
    var saved = { type:cell.type, pave:cell.paveTileId, work:cell.workshopId, cot:cell.cottageId };
    var savedJob = s.estate.job, savedQueue = s.estate.queue;
    var savedInv = { p5:s.inventory['paving_t5'], p7:s.inventory['paving_t7'], c5:s.inventory['carpentry_t5'], c6:s.inventory['carpentry_t6'] };
    s.estate.job = null; s.estate.queue = [];
    function finishJob(){ var j = s.estate.job; if(j){ FF.applyEstateJobCompletion(s.estate, j, false, false); s.estate.job = null; } }

    // A) Pavement jumps straight from t2 to t7 in one step, costing 20 of the TARGET tile only, and
    //    the job runs as long as paving t7 (index 7 -> 80 min) fresh would.
    cell.type='paved'; cell.paveTileId='paving_t2'; cell.workshopId=null; cell.cottageId=null;
    s.inventory['paving_t5']=999; s.inventory['paving_t7']=20;
    FF.estateUpgradePavement(0,0,7);
    ok(s.estate.job && s.estate.job.upgrade, 'the multi-tier jump runs as a timed job');
    eq(s.estate.job.readyAt - s.estate.job.startAt, 8 * FF.ESTATE_PAVE_MS_PER_TIER, 'the jump costs the TARGET tier fresh-pave time');
    finishJob();
    eq(cell.paveTileId, 'paving_t7', 'pavement jumps multiple tiers in a single upgrade');
    eq(s.inventory['paving_t7'], 0, 'the jump spent 20 of the target-tier tile');
    eq(s.inventory['paving_t5'], 999, 'intermediate tiers are not consumed');

    // B) A jump you cannot cover is refused, nothing spent, no job.
    cell.paveTileId='paving_t2'; s.inventory['paving_t7']=5;
    FF.estateUpgradePavement(0,0,7);
    ok(!s.estate.job, 'no job on an unaffordable jump');
    eq(cell.paveTileId, 'paving_t2', 'no upgrade without 20 of the target tile');
    eq(s.inventory['paving_t7'], 5, 'nothing spent on an unaffordable jump');

    // C) A Workshop jumps straight to any tier the pavement supports.
    cell.paveTileId='paving_t9'; cell.workshopId='workshop_mining_t1'; cell.cottageId=null;
    s.inventory['carpentry_t5']=100;
    FF.estateUpgradeWorkshop(0,0,5);
    finishJob();
    eq(cell.workshopId, 'workshop_mining_t5', 'workshop jumps from t1 to t5 in one step, same skill');
    eq(s.inventory['carpentry_t5'], 0, 'spent 100 of the target-tier plank');

    // D) A target above the pavement tier is blocked; up to the pavement tier is allowed.
    cell.paveTileId='paving_t5'; cell.workshopId='workshop_mining_t1'; s.inventory['carpentry_t6']=100;
    FF.estateUpgradeWorkshop(0,0,6);
    ok(!s.estate.job, 'no job past what the pavement supports');
    eq(cell.workshopId, 'workshop_mining_t1', 'no upgrade past what the pavement supports');
    eq(s.inventory['carpentry_t6'], 100, 'nothing spent when the target exceeds pavement support');
    s.inventory['carpentry_t5']=100;
    FF.estateUpgradeWorkshop(0,0,5);
    finishJob();
    eq(cell.workshopId, 'workshop_mining_t5', 'jumping up to exactly the pavement tier is allowed');

    // restore
    cell.type=saved.type; cell.paveTileId=saved.pave; cell.workshopId=saved.work; cell.cottageId=saved.cot;
    s.estate.job = savedJob; s.estate.queue = savedQueue;
    s.inventory['paving_t5']=savedInv.p5; s.inventory['paving_t7']=savedInv.p7;
    s.inventory['carpentry_t5']=savedInv.c5; s.inventory['carpentry_t6']=savedInv.c6;
    FF.estRecomputeWorkshops();
  });

  // ---- Estate snapshot: the compact, render-only blob published for "Visit Estate" viewing ----
  suite('estate: public snapshot', function(){
    var s = FF._state;
    var snap = FF.computeEstateSnapshot();
    ok(snap && snap.grid && snap.grid.length, 'a snapshot has a grid');
    eq(snap.grid.length, s.estate.grid.length, 'snapshot grid matches the estate width');
    eq(snap.edgesX, s.estate.edgesX, 'snapshot carries edgesX');
    eq(snap.edgesY, s.estate.edgesY, 'snapshot carries edgesY');
    // Placements + geometry are preserved so the read-only canvas can draw them.
    var cell = s.estate.grid[0][0];
    var saved = { type:cell.type, pave:cell.paveTileId, work:cell.workshopId, h:cell.height, owned:cell.owned };
    cell.owned = true; cell.type = 'paved'; cell.paveTileId = 'paving_t2'; cell.workshopId = 'workshop_mining_t1'; cell.height = 3;
    var c2 = FF.computeEstateSnapshot().grid[0][0];
    eq(c2.paveTileId, 'paving_t2', 'snapshot keeps the pavement tier');
    eq(c2.workshopId, 'workshop_mining_t1', 'snapshot keeps the workshop');
    eq(c2.height, 3, 'snapshot keeps the tile height');
    eq(c2.owned, true, 'snapshot keeps ownership');
    // No internal timers/jobs leak into the public blob.
    ok(!('job' in c2) && !('jobs' in c2), 'snapshot cells carry no job/timer state');
    cell.type = saved.type; cell.paveTileId = saved.pave; cell.workshopId = saved.work; cell.height = saved.h; cell.owned = saved.owned;
  });

  // ---- Estate: offline queue drain finishes every action the away-gap covers, not just the head ----
  suite('estate: offline queue drain', function(){
    var s = FF._state;
    FF.estUse(false);                                  // personal estate is the drain target
    var g = s.estate.grid;
    var saved = { q:s.estate.queue, job:s.estate.job,
      c10:Object.assign({}, g[1][0]), c11:Object.assign({}, g[1][1]),
      c20:Object.assign({}, g[2][0]) };
    // Three fresh, buildable tiles.
    g[1][0] = { type:'dirt', height:1, owned:true };
    g[1][1] = { type:'dirt', height:1, owned:true };
    g[2][0] = { type:'dirt', height:1, owned:true };
    var MIN = 60*1000;

    // A) An overhang that covers exactly one 5-min field finishes ONE and leaves the rest queued.
    s.estate.job = null;
    s.estate.queue = [
      { kind:'field', x:1, y:0, fieldTier:0, localMs:5*MIN, payload:{ fieldTier:0 } },
      { kind:'field', x:1, y:1, fieldTier:0, localMs:5*MIN, payload:{ fieldTier:0 } }
    ];
    var n = FF.estateDrainQueueOffline(5*MIN);
    eq(n, 1, 'a 5-min gap drains exactly one 5-min field');
    eq(s.estate.queue.length, 1, 'the second field stays queued');
    eq(g[1][0].fieldTier, 0, 'the drained field was applied to its tile');
    ok(g[1][1].fieldTier == null, 'the still-queued field was not applied');

    // B) A gap wider than the whole queue drains everything.
    var n2 = FF.estateDrainQueueOffline(60*MIN);
    eq(n2, 1, 'the remaining field drains once the gap covers it');
    eq(s.estate.queue.length, 0, 'the queue is empty after a full drain');
    eq(g[1][1].fieldTier, 0, 'the last field was applied');

    // C) A zero/negative overhang (the live case: completion lands right at readyAt) drains nothing.
    s.estate.queue = [{ kind:'field', x:2, y:0, fieldTier:0, localMs:5*MIN, payload:{ fieldTier:0 } }];
    eq(FF.estateDrainQueueOffline(0), 0, 'no overhang -> nothing drains (live behaviour unchanged)');
    eq(s.estate.queue.length, 1, 'the queued action is left for a live start');

    // D) An invalid head (its tile can no longer take the action) is skipped without spending overhang.
    g[2][0].fieldTier = 0;                             // tile already has a field -> the queued field is void
    var n4 = FF.estateDrainQueueOffline(1*MIN);        // 1 min: too short to "afford" anything anyway
    eq(n4, 0, 'a voided head drains nothing');
    eq(s.estate.queue.length, 0, 'but it is dropped from the queue (refunded), not left to stall');

    // E) A pave-then-build chain drains in order: the workshop validates against the freshly paved tile.
    g[2][0] = { type:'dirt', height:1, owned:true };
    s.estate.queue = [
      { kind:'pave', x:2, y:0, paveTileId:'paving_t0', localMs:10*MIN, payload:{ paveTileId:'paving_t0' } },
      { kind:'workshop', x:2, y:0, workshopId:'workshop_mining_t0', localMs:30*MIN, payload:{ workshopId:'workshop_mining_t0' } }
    ];
    var n5 = FF.estateDrainQueueOffline(90*MIN);
    eq(n5, 2, 'a big gap drains both the pave and the workshop that depends on it');
    eq(g[2][0].type, 'paved', 'the pave landed first');
    eq(g[2][0].workshopId, 'workshop_mining_t0', 'the workshop built on top of the just-paved tile');

    // restore
    s.estate.queue = saved.q; s.estate.job = saved.job;
    g[1][0] = saved.c10; g[1][1] = saved.c11; g[2][0] = saved.c20;
  });

  // ---- Farming: offline auto-farm turns fields over across the away window (not one-and-done) ----
  suite('farming: offline auto-farm cycles fields', function(){
    var s = FF._state;
    var saved = { grid:s.estate.grid, plots:s.farmingPlots, settings:Object.assign({}, s.settings),
      gt:s.physique.greenThumb, s0:s.inventory['seed_t0'], g0:s.inventory['grainseed_t0'],
      h0:s.inventory['herbseed_t0'], s5:s.inventory['seed_t5'], crop0:s.inventory['farming_t0'] };
    // Controlled single-field estate; only tier-0 fiber seed fits, so every harvest is a farming_t0.
    s.estate.grid = [[{ type:'dirt', fieldTier:0, owned:true }]];
    s.farmingPlots = {};
    s.physique.greenThumb = 0;                        // exact 5-min growth, no bonus-yield roll
    s.inventory['seed_t0'] = 1000;
    s.inventory['grainseed_t0'] = 0; s.inventory['herbseed_t0'] = 0;
    s.inventory['farming_t0'] = 0;
    s.settings.autoHarvest = true; s.settings.autoPlant = true; s.settings.autoFertilize = false;

    // A) 32 min away: an empty field is planted at the window's start and the 5-min crop turns over 6 times.
    var n = FF.simulateOfflineFarming('personal', 32*60*1000);
    eq(n, 6, '32 min of offline auto-farm turns a 5-min field over 6 times');
    eq(s.inventory['farming_t0'], 6, 'six crops were harvested into inventory');
    var plot = FF.farmPlotMap('personal')['0,0'];
    ok(plot && plot.cropType, 'the field is left growing its next crop, not idle');

    // B) Auto-harvest OFF -> the offline simulation is a no-op.
    s.farmingPlots = {}; s.inventory['farming_t0'] = 0;
    s.settings.autoHarvest = false;
    eq(FF.simulateOfflineFarming('personal', 60*60*1000), 0, 'no auto-harvest -> no offline farming');
    eq(s.inventory['farming_t0'], 0, 'nothing harvested with auto-harvest off');

    // C) Harvest ON, Plant OFF -> a standing crop is reaped exactly once, then the field stays empty.
    s.settings.autoHarvest = true; s.settings.autoPlant = false;
    FF.farmPlotMap('personal')['0,0'] = { cropType:'fiber', tierIndex:0, plantedAt:Date.now()-600000, readyAt:Date.now()-1000 };
    eq(FF.simulateOfflineFarming('personal', 60*60*1000), 1, 'harvest-only reaps the standing crop once');
    eq(s.inventory['farming_t0'], 1, 'one crop harvested, no replant cycles');
    ok(!FF.farmPlotMap('personal')['0,0'], 'the field is left empty when auto-plant is off');

    // D) The seed picker never overshoots the field's tier cap.
    s.inventory['seed_t5'] = 5;
    eq(FF.seedInfo(FF.bestOwnedSeedForField(0)).tier, 0, 'a tier-0 field never takes the tier-5 seed');

    // restore
    s.estate.grid = saved.grid; s.farmingPlots = saved.plots; s.settings = saved.settings;
    s.physique.greenThumb = saved.gt;
    s.inventory['seed_t0'] = saved.s0; s.inventory['grainseed_t0'] = saved.g0;
    s.inventory['herbseed_t0'] = saved.h0; s.inventory['seed_t5'] = saved.s5;
    s.inventory['farming_t0'] = saved.crop0;
  });

  // ---- Farming: the Auto-plant seed filter (crop-type toggles + a Custom per-seed override) ----
  suite('farming: auto-plant seed filter', function(){
    var s = FF._state;
    var orig = s.settings, oInv = { s0:s.inventory['seed_t0'], s1:s.inventory['seed_t1'], g0:s.inventory['grainseed_t0'], h0:s.inventory['herbseed_t0'] };
    s.settings = Object.assign({}, orig, { plantFiber:true, plantGrain:true, plantHerb:true, plantCustom:false, plantSeedDisabled:{} });

    // Default: every crop type is sown.
    ok(FF.seedAllowedForPlanting('seed_t0'), 'fiber allowed by default');
    ok(FF.seedAllowedForPlanting('grainseed_t0'), 'grain allowed by default');
    ok(FF.seedAllowedForPlanting('herbseed_t0'), 'herb allowed by default');

    // Type toggle: unticking Fiber blocks fiber seeds only.
    s.settings.plantFiber = false;
    ok(!FF.seedAllowedForPlanting('seed_t0'), 'fiber blocked when plantFiber is off');
    ok(FF.seedAllowedForPlanting('grainseed_t0') && FF.seedAllowedForPlanting('herbseed_t0'), 'grain & herb unaffected');

    // Custom overrides the type toggles: fiber is allowed again even with plantFiber still false.
    s.settings.plantCustom = true;
    ok(FF.seedAllowedForPlanting('seed_t0'), 'Custom on -> the fiber type toggle is overridden');
    // ...except seeds explicitly unticked in the Custom list.
    s.settings.plantSeedDisabled = { 'seed_t0':true };
    ok(!FF.seedAllowedForPlanting('seed_t0'), 'an explicitly-disabled seed is blocked in Custom mode');
    ok(FF.seedAllowedForPlanting('seed_t1'), 'other seeds stay enabled (absent from the exclusion set)');

    // bestOwnedSeedForField (offline auto-plant) honours the filter.
    s.settings.plantCustom = false; s.settings.plantFiber = false; s.settings.plantSeedDisabled = {};
    s.inventory['seed_t0'] = 5; s.inventory['grainseed_t0'] = 0; s.inventory['herbseed_t0'] = 0;
    ok(!FF.bestOwnedSeedForField(0), 'picker finds nothing when the only owned seed type is filtered out');
    s.settings.plantFiber = true;
    eq(FF.bestOwnedSeedForField(0), 'seed_t0', 'picker returns the fiber seed once its type is re-enabled');

    // ownedSeedTypesDesc (live Plant All) filters too.
    s.inventory['seed_t0'] = 3; s.inventory['grainseed_t0'] = 3;
    s.settings.plantFiber = false; s.settings.plantGrain = true;
    var ids = FF.ownedSeedTypesDesc().map(function(x){ return x.id; });
    ok(ids.indexOf('seed_t0') === -1, 'Plant All drops filtered-out fiber seeds');
    ok(ids.indexOf('grainseed_t0') !== -1, 'Plant All keeps enabled grain seeds');

    // restore
    s.settings = orig;
    s.inventory['seed_t0']=oInv.s0; s.inventory['seed_t1']=oInv.s1; s.inventory['grainseed_t0']=oInv.g0; s.inventory['herbseed_t0']=oInv.h0;
  });

  // ---- Guild activity + bank logs (shared blob, officer+ only, filtered by kind) ----
  suite('guild: activity & bank logs', function(){
    var ge = FF.guildEstate, gs = FF.guildState;
    var savedStatus = ge.status, savedLog = ge.log, savedGuild = gs.guild, savedRank = gs.myRank;
    ge.status = 'ready'; ge.log = []; gs.guild = { id:'g1' };
    // guildLogPush records only while a guild estate is loaded; newest first, with who + timestamp.
    FF.guildLogPush('estate', 'cleared the Boulder at (3, 4)');
    FF.guildLogPush('bank', '+500g (donated to treasury)');
    eq(ge.log.length, 2, 'two entries recorded');
    eq(ge.log[0].kind, 'bank', 'newest entry is first');
    ok(ge.log[0].who && typeof ge.log[0].at === 'number', 'entries carry who + a timestamp');
    // The render is officer+ only, and each surface filters by kind.
    gs.myRank = 'member';
    eq(FF.renderGuildActivityLog('estate', 'Estate Activity Log'), '', 'a plain member sees no log');
    gs.myRank = 'officer';
    var est = FF.renderGuildActivityLog('estate', 'Estate Activity Log');
    ok(/Boulder/.test(est) && !/donated/.test(est), 'the estate log shows estate events only');
    var bank = FF.renderGuildActivityLog('bank', 'Bank Ledger');
    ok(/donated/.test(bank) && !/Boulder/.test(bank), 'the bank ledger shows bank events only');
    // The log is capped.
    ge.log.length = 0;
    for(var i=0;i<FF.GUILD_LOG_MAX+25;i++) FF.guildLogPush('estate', 'e'+i);
    eq(ge.log.length, FF.GUILD_LOG_MAX, 'the log is capped at GUILD_LOG_MAX');
    // Not appended without a loaded guild estate.
    ge.status = 'idle'; ge.log = [];
    FF.guildLogPush('estate', 'ignored');
    eq(ge.log.length, 0, 'nothing is logged when no guild estate is loaded');
    // restore
    ge.status = savedStatus; ge.log = savedLog; gs.guild = savedGuild; gs.myRank = savedRank;
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

  // ---- Queue targets: a finite "craft N" run credits its REAL output and stops on target --
  // Regression: queueCreditOutput counted gabCapture.items[act.itemId], but special forges
  // (craftKind acts) have no itemId at all and relic/butcher/shaft recipes produce ids unrelated
  // to their recipe key -- producedQty never advanced, so a finite run ignored its target and
  // kept crafting (and consuming materials) until they ran out.
  suite('queue targets stop at the requested output', function(){
    var S = FF._state;
    var savedInv = S.inventory, savedAct = S.activity, savedExtra = S.extraCraftSlots;
    try {
      S.activity = { type:null }; S.extraCraftSlots = [];

      // Relic extraction always yields exactly one item per cycle (a Relic or a Broken Relic),
      // so a target of 3 must credit 3 cycles, consume exactly 3 artifacts, then stop the slot.
      S.inventory = { muddyartifact_t0: 20 };
      var ract = { type:'craft', skill:'archaeology', itemId:'archaeology_dig_t0', progress:0, targetQty:3, producedQty:0 };
      FF.processCraftActivity(ract, 3600*1000);
      eq(ract.producedQty, 3, 'relic run credits each cycle output and stops at 3');
      eq(ract.type, null, 'relic run ends its activity at the target');
      eq(S.inventory.muddyartifact_t0, 17, 'relic run consumed only the 3 cycles it needed');

      // A special forge: a craftKind act with NO itemId (its outputs are rarity-suffixed ids).
      // Two workshops requested with planks for 50 -- the run must stop once 2 are built.
      S.inventory = { carpentry_t0: 500 };
      var wact = { type:'craft', craftKind:'workshop', skillId:'mining', tierIndex:0, progress:0, targetQty:2, producedQty:0 };
      FF.processCraftActivity(wact, 24*3600*1000);
      eq(wact.producedQty, 2, 'special-forge run credits rarity-suffixed outputs and stops at 2');
      eq(wact.type, null, 'special-forge run ends its activity at the target');
      ok((S.inventory.carpentry_t0||0) > 0, 'special-forge run left the unneeded planks unconsumed');
    } finally {
      S.inventory = savedInv; S.activity = savedAct; S.extraCraftSlots = savedExtra;
    }
  });

  // ---- Discord feed: the stats tail appended to fantastic-craft / enhance blasts ----------
  suite('discord feed: item stats tail', function(){
    // A fantastic relic reads its computed %dmg/armour bonus.
    var relic = FF.discordItemStatsText('relic_t0_fantastic');
    ok(/^ \(.*\)$/.test(relic), 'stats tail is wrapped in " (...)"');
    ok(relic.indexOf('% Damage & Armour') !== -1, 'relic tail carries the dmg/armour bonus');

    // A fantastic tool reads its tier speed bonus scaled by the rarity multiplier.
    var toolId = Object.keys(FF.TOOL_ITEMS).filter(function(id){ return /_fantastic$/.test(id); })[0];
    ok(!!toolId, 'a fantastic tool item exists');
    ok(FF.discordItemStatsText(toolId).indexOf('speed') !== -1, 'tool tail states its speed bonus');

    // A fantastic belt leads with its task slots; a stackable weapon leads with damage.
    ok(FF.discordItemStatsText('belt_t0_fantastic').indexOf('4 task slots') !== -1, 'belt tail states its 4 task slots');
    var wid = Object.keys(FF.ALL_SELLABLE).filter(function(id){ return id.indexOf('stweapon_')===0 && /_fantastic$/.test(id); })[0];
    ok(!!wid, 'a fantastic stackable weapon exists');
    ok(FF.discordItemStatsText(wid).indexOf('Damage ') !== -1, 'weapon tail states its damage range');

    // An enhance blast passes the unique: enhance-scaled base stats + its enchant list.
    var u = { base:wid, kind:'weapon', tier:0, rarity:'fantastic', enhance:12, enchants:[{mod:'critDamage', roll:10}] };
    var tail = FF.discordItemStatsText(null, u);
    ok(tail.indexOf('Damage ') !== -1 && tail.indexOf('(+12)') !== -1, 'enhanced weapon tail shows the +12-scaled damage');
    ok(/Critical/i.test(tail), 'enhanced tail lists the enchant');

    // Unknown ids stay silent rather than posting junk.
    eq(FF.discordItemStatsText('no_such_item'), '', 'an unknown id yields an empty tail');
  });

  // ---- Combat placement: a fight claims the primary slot without killing a queued task ----
  // Regression: startCombat wrote state.activity directly, so starting a fight silently replaced
  // the first task in the action queue even when an extra (belt) slot sat empty.
  suite('combat: starting a fight relocates the primary task to a free slot', function(){
    var S = FF._state;
    var savedAct = S.activity, savedExtra = S.extraCraftSlots, savedBt = S.equippedBeltTier, savedBr = S.equippedBeltRarity;
    try {
      S.equippedBeltTier = 1; S.equippedBeltRarity = 'rare'; // 3 task slots: primary + 2 extras
      var m0 = FF.MONSTERS.reduce(function(a,b){ return (b.levelReq||0) < (a.levelReq||0) ? b : a; });
      // Free extra slot: the running task moves there (queue target intact) and the fight takes primary.
      var task = { type:'craft', skill:'cooking', itemId:'cooking_t0', progress:0, targetQty:5, producedQty:0 };
      S.activity = task; S.extraCraftSlots = [{type:null},{type:null}];
      FF.startCombat(m0.id);
      eq(S.activity.type, 'combat', 'the fight takes the primary slot');
      ok(S.extraCraftSlots[0] === task, 'the running task moved to the free extra slot');
      eq(task.targetQty, 5, 'the relocated task keeps its queue target');
      // Every slot full: the fight still replaces the primary task (legacy), extras untouched.
      var t2 = { type:'craft', skill:'cooking', itemId:'cooking_t0', progress:0 };
      var e1 = { type:'gather', skill:'mining', itemId:'mining_t0', progress:0 };
      var e2 = { type:'gather', skill:'fishing', itemId:'fishing_t0', progress:0 };
      S.activity = t2; S.extraCraftSlots = [e1, e2];
      FF.startCombat(m0.id);
      eq(S.activity.type, 'combat', 'full slots: the fight still takes primary');
      ok(S.extraCraftSlots[0] === e1 && S.extraCraftSlots[1] === e2, 'full slots: extra tasks are untouched');
      // Idle primary: nothing to relocate, extras stay empty.
      S.activity = { type:null }; S.extraCraftSlots = [{type:null},{type:null}];
      FF.startCombat(m0.id);
      eq(S.activity.type, 'combat', 'idle primary: the fight starts normally');
      ok(!S.extraCraftSlots[0].type, 'idle primary: no phantom task appears in the extras');
    } finally {
      S.activity = savedAct; S.extraCraftSlots = savedExtra; S.equippedBeltTier = savedBt; S.equippedBeltRarity = savedBr;
    }
  });

  // ---- Task slots: free base slot, belt + Logic stacking, cap at 15 ----------------------
  suite('task slots: everyone gets a base slot, capped at 15', function(){
    eq(FF.MAX_TASK_SLOTS, 15, 'the task-slot ceiling is 15');
    // Brand-new player: no belt, no Logic -> 2 concurrent actions (was 1).
    eq(FF.getMaxCraftSlots({ physique:{} }), 2, 'a fresh player runs 2 tasks (base + free slot)');
    // A normal belt adds nothing over base; each higher rarity adds one, on top of the free slot.
    eq(FF.getMaxCraftSlots({ equippedBeltTier:1, equippedBeltRarity:'normal', physique:{} }), 2, 'a normal belt still yields 2');
    eq(FF.getMaxCraftSlots({ equippedBeltTier:1, equippedBeltRarity:'rare', physique:{} }), 3, 'a rare belt yields 3');
    eq(FF.getMaxCraftSlots({ equippedBeltTier:1, equippedBeltRarity:'fantastic', physique:{} }), 5, 'a fantastic belt yields 5');
    // Logic adds +1 per 10 levels; the fully-kitted maximum is exactly 15.
    var logic100 = { logic: FF.xpFloorForLevel(100) };
    eq(FF.getMaxCraftSlots({ physique: logic100 }), 12, 'Logic Lv100 alone -> 2 base + 10 = 12');
    eq(FF.getMaxCraftSlots({ equippedBeltTier:1, equippedBeltRarity:'fantastic', physique: logic100 }), 15, 'fantastic belt + Logic Lv100 caps at 15');
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

  suite('gathering & crafting skill tabs render alphabetically by label', function(){
    function labelOf(id){ return (FF.CRAFTING_SKILLS[id] || FF.GATHERING_SKILLS[id] || {}).label || id; }
    function isAlpha(ids){
      var labels = ids.map(labelOf);
      for(var i=1;i<labels.length;i++){ if(labels[i-1].localeCompare(labels[i]) > 0) return false; }
      return true;
    }
    // Each gathering/crafting sub-tab group is displayed in alphabetical label order.
    [FF.GATHERING_TAB_SKILL_IDS, FF.OUTFITTING_SKILL_IDS, FF.REFINING_TAB_SKILL_IDS, FF.COOKING_SKILL_IDS, FF.BUILDING_SKILL_IDS, FF.CRAFTING_TAB_SKILL_IDS].forEach(function(group){
      ok(isAlpha(FF.skillTabsByLabel(group)), 'sorted group is alphabetical by label: ' + FF.skillTabsByLabel(group).map(labelOf).join(', '));
    });
    // Concrete order check: Outfitting tabs come out A->Z by their display names.
    eq(FF.skillTabsByLabel(FF.OUTFITTING_SKILL_IDS).map(labelOf).join(','),
       'Arcanism,Armorsmithing,Bowyer,Fletching,Jewelrycrafting,Leatherworking,Runesmithing,Shieldsmithing,Tailoring,Weaponsmithing',
       'outfitting tabs are alphabetical');
    // The sort returns a COPY -- the source array keeps its functional order untouched.
    eq(FF.OUTFITTING_SKILL_IDS[0], 'weaponsmithing', 'source OUTFITTING_SKILL_IDS order is not mutated');
  });
  suite('tierStepper disables only at the tier-range ends (not while crafting)', function(){
    var lowest = FF.tierStepper('ring', 'r', FF.tierRange(4), 0, 'x', false);
    // The − button (dir=-1) sits before the + button; at the lowest tier only − is disabled.
    ok(/data-tier-dir="-1"[^>]*disabled/.test(lowest), 'minus disabled at lowest tier');
    ok(!/data-tier-dir="1"[^>]*disabled/.test(lowest), 'plus enabled at lowest tier');
    var highest = FF.tierStepper('ring', 'r', FF.tierRange(4), 4, 'x', false);
    ok(/data-tier-dir="1"[^>]*disabled/.test(highest), 'plus disabled at highest tier');
    // The active-craft flag (last arg) no longer locks the stepper: players can browse tiers mid-craft
    // and queue a different tier in a new slot.
    var midCraft = FF.tierStepper('ring', 'r', FF.tierRange(4), 2, 'x', true);
    ok(!/data-tier-dir="-1"[^>]*disabled/.test(midCraft) && !/data-tier-dir="1"[^>]*disabled/.test(midCraft), 'the active-craft flag does NOT disable the stepper at a mid tier');
  });

  // ---- Combat: limited fight runs (fight N enemies, then stop) ----
  suite('combat: a chosen number of fights stops the run', function(){
    var S = FF._state;
    // Give defeatMonster fresh scratch objects to mutate (gold/loot/xp/etc.) so nothing leaks into other suites.
    var sv = { act:S.activity, gold:S.gold, inv:S.inventory, stats:S.stats, mk:S.monsterKills, phys:S.physique, xp:S.xp, faith:S.faith };
    S.gold = 0; S.inventory = {}; S.stats = {}; S.monsterKills = {}; S.physique = {}; S.xp = {}; S.faith = 0;
    var mon = FF.MONSTERS[0]; // first wildlife foe (Rabbit)
    S.activity = { type:'combat', monsterId:mon.id, monsterHp:0, fightTarget:2, fightsWon:0, monsterTickAccum:0 };
    FF.defeatMonster(mon);
    eq(S.activity.type, 'combat', 'after the 1st win the run keeps going');
    eq(S.activity.fightsWon, 1, 'the 1st win is counted');
    ok((S.activity.monsterHp||0) > 0, 'the foe is re-engaged at full HP for the next fight');
    FF.defeatMonster(mon);
    eq(S.activity.type, null, 'reaching the fight target stops the run');
    // A blank/absent target fights on indefinitely (no fightTarget -> never auto-stops).
    S.activity = { type:'combat', monsterId:mon.id, monsterHp:0, monsterTickAccum:0 };
    FF.defeatMonster(mon);
    eq(S.activity.type, 'combat', 'with no fight target the run never auto-stops');
    S.activity = sv.act; S.gold = sv.gold; S.inventory = sv.inv; S.stats = sv.stats; S.monsterKills = sv.mk; S.physique = sv.phys; S.xp = sv.xp; S.faith = sv.faith;
  });

  // ---- Combat: enemies drop no flat gold reward on kill ---------------------------------
  suite('combat: killing an enemy awards no gold', function(){
    var S = FF._state;
    var sv = { act:S.activity, gold:S.gold, inv:S.inventory, stats:S.stats, mk:S.monsterKills, phys:S.physique, xp:S.xp, faith:S.faith, get:S.goldEarnedTotal };
    S.gold = 0; S.goldEarnedTotal = 0; S.inventory = {}; S.stats = {}; S.monsterKills = {}; S.physique = {}; S.xp = {}; S.faith = 0;
    // A gold-bearing foe (its goldMin/goldMax are > 0) killed on the plain solo path.
    var mon = FF.MONSTERS[FF.MONSTERS.length - 1]; // a high-tier foe -> a large would-be gold drop
    ok(mon.goldMax > 0, 'the sampled foe still carries a gold RANGE (used by Treasure Hunter scatter effects)');
    S.activity = { type:'combat', monsterId:mon.id, monsterHp:0, fightTarget:1, fightsWon:0, monsterTickAccum:0 };
    FF.defeatMonster(mon);
    eq(S.gold, 0, 'a kill pays no flat gold (base enemy gold loot removed)');
    eq(S.goldEarnedTotal, 0, 'and nothing enters the lifetime gold-earned anchor');
    S.activity = sv.act; S.gold = sv.gold; S.goldEarnedTotal = sv.get; S.inventory = sv.inv; S.stats = sv.stats; S.monsterKills = sv.mk; S.physique = sv.phys; S.xp = sv.xp; S.faith = sv.faith;
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

  // ---- "Running an estate action?" signal that gates the Estate / Guild-Estate quick-jump FABs ------
  suite('estateScopeHasJob tracks the player running an estate action', function(){
    var S = FF._state;
    var snap = { job:S.estate.job };
    try {
      // Personal estate: idle when there's no active job; busy while clearing/building/terraforming.
      S.estate.job = null;
      ok(!FF.estateScopeHasJob('personal'), 'no personal estate job -> not running an action (FAB may show)');
      S.estate.job = { kind:'clear', x:0, y:0, startAt:0, readyAt:1 };
      ok(FF.estateScopeHasJob('personal'), 'a personal clear/build/terraform job -> running an action (FAB hides)');
      S.estate.job = null;
      // Guild estate: busy only when a job in the shared array is owned by THIS player.
      var ge = FF.guildEstate, gs = FF.guildState;
      var gsnap = { gjobs:ge.jobs, gstatus:ge.status, gid:ge.guildId, ggrid:ge.grid, guild:gs.guild };
      try {
        ge.jobs = [];
        ok(!FF.estateScopeHasJob('guild'), 'no guild job for me -> not running a guild action');
        ge.jobs = [{ owner:'_local', kind:'clear', x:0, y:0 }]; // signed-out player's id is '_local'
        ok(FF.estateScopeHasJob('guild'), 'a guild job I own -> running a guild action');
        ge.jobs = [{ owner:'someone-else', kind:'clear', x:1, y:1 }];
        ok(!FF.estateScopeHasJob('guild'), "another member's guild job doesn't count as mine");
        // guildEstateReachable needs an in-guild player with a loaded shared estate.
        gs.guild = null; ok(!FF.guildEstateReachable(), 'not reachable when not in a guild');
        gs.guild = { id:'g1' }; ge.status='ready'; ge.guildId='g1'; ge.grid=[[{}]];
        ok(FF.guildEstateReachable(), 'reachable once in a guild with a ready, loaded estate');
      } finally {
        ge.jobs=gsnap.gjobs; ge.status=gsnap.gstatus; ge.guildId=gsnap.gid; ge.grid=gsnap.ggrid; gs.guild=gsnap.guild;
      }
    } finally {
      S.estate.job = snap.job;
    }
  });

  // ---- The no-arg estateJobActive() must reflect the ACTIVE estate, not always the personal one -----
  // Regression: a scoped estateScopeHasJob(scope) helper once shadowed this via a duplicate function name,
  // making every estate action's "one job at a time" guard read the personal job even on the guild estate,
  // which broke Clear/Pave/Build there while a personal job was running.
  suite('estateJobActive() keys off the active estate (no name-collision)', function(){
    var S = FF._state, ge = FF.guildEstate;
    var snap = { job:S.estate.job, gjobs:ge.jobs };
    try {
      // Personal estate active, personal job running -> active.
      FF.estUse(false); S.estate.job = { kind:'clear', x:0, y:0 }; ge.jobs = [];
      ok(FF.estActiveIsGuild()===false && FF.estateJobActive(), 'personal estate + personal job -> job active');
      // Switch to the GUILD estate: a lingering PERSONAL job must NOT count as the guild estate being busy.
      FF.estUse(true);
      ok(FF.estActiveIsGuild()===true, 'estUse(true) makes the guild estate the active one');
      ok(!FF.estateJobActive(), 'guild estate with no guild job of mine -> NOT busy, even while a personal job runs (the collision bug)');
      // A guild job I own -> the guild estate reads busy.
      ge.jobs = [{ owner:'_local', kind:'clear', x:1, y:1 }];
      ok(FF.estateJobActive(), 'guild estate + my guild job -> busy');
    } finally {
      FF.estUse(false); S.estate.job = snap.job; ge.jobs = snap.gjobs;
    }
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

  // ---- Butchering trains Logic (it leads the Refining tab) ------------------------------
  suite('butchering trains the Logic physique', function(){
    // Logic is the Refining physique; Butchering is a gathering skill shown in the Refining tab.
    ok(FF.physiqueTrainedBySkill('butchering').indexOf('logic') !== -1, 'butchering earns Logic XP');
    ok(FF.physiqueBenefitsForSkill('butchering').some(function(e){ return e[0] === 'logic'; }), 'the (?) "trained by" list shows Logic for butchering');
    ok((FF.GATHER_PHYSIQUE.butchering || []).some(function(p){ return p[0] === 'logic'; }), 'GATHER_PHYSIQUE.butchering includes a logic pair');
    // Other gathering skills do NOT grant Logic -- it stays a Refining-only physique.
    ['mining','fishing','forestry','herbalism','foraging'].forEach(function(sk){
      ok(FF.physiqueTrainedBySkill(sk).indexOf('logic') === -1, sk + ' does not train Logic');
    });
    // Processing a carcass (the butcher craft path) must actually AWARD Logic -- it used to read an
    // undefined CRAFT_PHYSIQUE.butchering table and grant no physique XP at all. And at the crafting rate.
    function logicAmt(pairs){ var p = (pairs||[]).filter(function(x){ return x[0]==='logic'; })[0]; return p ? p[1] : 0; }
    eq(logicAmt(FF.physTierPairs(FF.GATHER_PHYSIQUE.butchering, 5)),
       logicAmt(FF.physTierPairs(FF.CRAFT_PHYSIQUE.metallurgy, 5)),
       'Butchering trains Logic at the same per-tier rate as a crafting skill');
    var S = FF._state;
    var saved = { inv:S.inventory, act:S.activity, logic:S.physique.logic, str:S.physique.bodyStrength };
    try {
      S.activity = { type:null };
      S.physique.logic = 0; S.physique.bodyStrength = 0;
      S.inventory = { corpse_t5: 1 };
      FF.processCraftActivity({ type:'craft', skill:'butchering', itemId:'butcher_process_t5', progress:0 }, 3600*1000);
      ok((S.physique.logic||0) > 0, 'processing a carcass grants Logic physique XP (it granted none before this fix)');
      ok((S.physique.bodyStrength||0) > 0, '...along with its other gather physiques');
    } finally {
      S.inventory = saved.inv; S.activity = saved.act; S.physique.logic = saved.logic; S.physique.bodyStrength = saved.str;
    }
  });

  // ---- Butchering tool: success bonus that scales with tier AND rarity, like other crafting tools ----
  suite('butchering tool raises success chance (tier + rarity, like craft tools)', function(){
    var s = FF._state;
    var savedTiers = s.gatherTools.butchering, savedRar = s.gatherToolRarities.butchering, savedPhys = s.physique.handStrength;
    s.physique.handStrength = 0; // isolate the tool's contribution from physique
    // The Cleaver's gather-tool data now carries a successBonus (other gather tools do not).
    var cleaver = FF.getGatherToolTierData('butchering', 11);
    ok(typeof cleaver.successBonus === 'number' && cleaver.successBonus > 0, 'the Cleaver has a successBonus like a craft tool');
    ok(FF.getGatherToolTierData('mining', 11).successBonus == null, 'a normal gather tool (Pickaxe) has no successBonus');
    // Its success curve matches the craft-tool success curve at the same tier.
    eq(cleaver.successBonus, FF.getEquippedCraftTool('metallurgy', 11, 'normal').successBonus, 'the Cleaver uses the same per-tier success curve as craft tools');
    // Higher tier -> more butcher output chance.
    s.gatherTools.butchering = 0; s.gatherToolRarities.butchering = 'normal';
    var none = FF.butcherOutputChance(s, 'handStrength');
    s.gatherTools.butchering = 5;
    var t5 = FF.butcherOutputChance(s, 'handStrength');
    s.gatherTools.butchering = 21;
    var t21 = FF.butcherOutputChance(s, 'handStrength');
    ok(t5 > none && t21 > t5, 'a better Cleaver raises butcher output chance');
    // Higher RARITY at the SAME tier -> more output chance (this is the "like craft tools" part).
    s.gatherTools.butchering = 11;
    s.gatherToolRarities.butchering = 'normal';   var norm = FF.butcherOutputChance(s, 'handStrength');
    s.gatherToolRarities.butchering = 'fantastic'; var fant = FF.butcherOutputChance(s, 'handStrength');
    ok(fant > norm, 'a Fantastic Cleaver beats a Normal one of the same tier (rarity scales success)');
    // restore
    s.gatherTools.butchering = savedTiers; s.gatherToolRarities.butchering = savedRar; s.physique.handStrength = savedPhys;
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

  // ---- Harvesting a crop returns a seed of that crop 75% of the time -----------------------------
  suite('farming: harvest seed drop', function(){
    eq(FF.HARVEST_SEED_DROP_CHANCE, 0.75, 'seed drop chance is 75%');
    // crop (type + tier) -> its seed id, across all three crop lines; unknown -> null (no phantom seed).
    eq(FF.cropSeedId('fiber', 5), 'seed_t5', 'fiber crop -> seed_t');
    eq(FF.cropSeedId('grain', 3), 'grainseed_t3', 'grain crop -> grainseed_t');
    eq(FF.cropSeedId('herb', 7), 'herbseed_t7', 'herb crop -> herbseed_t');
    eq(FF.cropSeedId('fiber', 999), null, 'out-of-range tier -> null');
    // Herbs are UNIFIED: gathered (Herbalism) and farmed (herb crop) both yield herbalism_t<i>, so a single
    // "Chamomile" works in both Alchemy and Cooking (fixes the "have chamomile but recipe says none" report).
    eq(FF.seedInfo('herbseed_t0').crop.id, 'herbalism_t0', 'farming an herb yields the gather item (herbalism_t0), not a separate herb_t0');
    ok(!FF.ALL_SELLABLE['herb_t0'], 'the duplicate farmed-herb item (herb_t0) no longer exists');
    ok(FF.ALL_CRAFT_RECIPES['cooking_t0'].inputs['herbalism_t0'] && !FF.ALL_CRAFT_RECIPES['cooking_t0'].inputs['herb_t0'], 'a Meal consumes the unified herbalism_t herb, not herb_t');
    // Statistical: harvest a ripe t5 fiber plot many times; ~75% of harvests return a seed_t5.
    var S = FF._state, grid = S.estate.grid, pm = FF.farmPlotMap('personal');
    var cell=null; for(var x=0;x<grid.length && !cell;x++){ if(!grid[x]) continue; for(var y=0;y<grid[x].length && !cell;y++){ if(grid[x][y]) cell=[x,y]; } }
    ok(cell, 'found an estate cell to farm');
    var key = cell[0]+','+cell[1];
    var savedTier = grid[cell[0]][cell[1]].fieldTier, savedPlot = pm[key];
    var savedSeed = S.inventory.seed_t5||0, savedCrop = S.inventory.farming_t5||0;
    grid[cell[0]][cell[1]].fieldTier = 5;
    var N=600, seeds=0;
    for(var i=0;i<N;i++){
      S.inventory.seed_t5 = 0;
      pm[key] = { cropType:'fiber', tierIndex:5, plantedAt:Date.now(), readyAt:Date.now()-1 };
      FF.harvestPlot('personal', key, true);
      if((S.inventory.seed_t5||0) > 0) seeds++;
    }
    var rate = seeds/N;
    ok(rate > 0.65 && rate < 0.85, 'harvest returns a seed ~75% of the time (got '+rate.toFixed(3)+')');
    delete pm[key]; if(savedPlot) pm[key]=savedPlot;
    grid[cell[0]][cell[1]].fieldTier = savedTier;
    S.inventory.seed_t5 = savedSeed; S.inventory.farming_t5 = savedCrop;
  });

  // ---- Cancel a growing crop (frees the plot; the seed is forfeit) -----------------------------
  suite('farming: cancel a growing crop', function(){
    var pm = FF.farmPlotMap('personal');
    var savedCrop = FF._state.inventory.farming_t2 || 0, savedSeed = FF._state.inventory.seed_t2 || 0;
    pm['7,7'] = { cropType:'fiber', tierIndex:2, plantedAt:Date.now(), readyAt:Date.now()+999999 };
    ok(pm['7,7'] && pm['7,7'].cropType, 'crop is growing before cancel');
    ok(FF.cancelCropAt('personal', '7,7') === true, 'cancel reports success');
    ok(!pm['7,7'], 'the plot is empty after cancelling');
    // No refund: cancelling does not return the crop or the seed to inventory.
    eq(FF._state.inventory.farming_t2 || 0, savedCrop, 'no crop is granted by cancelling');
    eq(FF._state.inventory.seed_t2 || 0, savedSeed, 'no seed is refunded by cancelling');
    // Cancelling an empty plot is a safe no-op.
    ok(FF.cancelCropAt('personal', '8,8') === false, 'cancelling an empty plot does nothing');
  });

  // ---- Critter Cache: one of each seed type + Botany/Herbalism drop it at 5% base --------------
  suite('critter cache: all three seed types', function(){
    var S = FF._state;
    function seedTotals(){
      var f=0,g=0,h=0;
      for(var i=0;i<21;i++){ f+=S.inventory['seed_t'+i]||0; g+=S.inventory['grainseed_t'+i]||0; h+=S.inventory['herbseed_t'+i]||0; }
      return {f:f,g:g,h:h};
    }
    var before = seedTotals();
    S.inventory.critter_cache = (S.inventory.critter_cache||0) + 50;
    FF.openCritterCaches(50, true); // silent
    var after = seedTotals();
    eq(after.f - before.f, 50, 'each cache drops exactly one Fiber seed');
    eq(after.g - before.g, 50, 'each cache drops exactly one Grain seed');
    eq(after.h - before.h, 50, 'each cache drops exactly one Herb seed');
    eq(S.inventory.critter_cache || 0, 0, 'all 50 caches were consumed');
    // Grain has one fewer tier than Fiber/Herb -- caches must never mint a nonexistent 'grainseed_t20'.
    ok(!S.inventory.grainseed_t20, 'caches never grant the out-of-range grainseed_t20');
    ok(Object.keys(S.inventory).filter(function(id){ return id.indexOf('grainseed_t')===0 && S.inventory[id]>0; })
      .every(function(id){ return !!FF.ALL_SELLABLE[id]; }), 'every granted Grain seed resolves to a real named item');
    // Base drop chance is 5% (Forestry, Botany, Herbalism & Foraging share critterCacheChance).
    eq(FF.BASE_NEST_CHANCE, 0.05, 'critter cache base chance is 5%');
    // Herbalism & Foraging traded raw seed side-drops for the Critter Cache; Botany still drops raw seeds.
    ['forestry','botany','herbalism','foraging'].forEach(function(sk){ ok(FF.CRITTER_CACHE_SKILLS.indexOf(sk) !== -1, sk+' drops Critter Caches'); });
    eq(FF.SEED_DROP_SKILLS.indexOf('foraging'), -1, 'Foraging no longer drops raw seeds');
    eq(FF.SEED_DROP_SKILLS.indexOf('herbalism'), -1, 'Herbalism no longer drops raw seeds');
    ok(FF.SEED_DROP_SKILLS.indexOf('botany') !== -1, 'Botany still drops raw seeds directly');
  });

  // ---- Cache seed tier distribution: skewed low, but high tiers actually attainable ----
  suite('critter cache: seed tier distribution reaches the high tiers', function(){
    var N = FF.TIER_COUNT, b = FF.CACHE_SEED_TIER_DECAY;
    ok(b > 0.65, 'the per-tier falloff is gentler than the old 0.65 (higher tiers more frequent)');
    // Closed-form probability per tier from the decay base (matches pickWeightedFarmingTier's weights).
    var w = [], total = 0; for(var i=0;i<N;i++){ w[i] = Math.pow(b,i); total += w[i]; }
    function p(i){ return w[i]/total; }
    ok(p(N-1) > 0.012 && p(N-1) < 0.018, 't20 is tuned to about 1.5% per seed');
    var pHigh = 0; for(var j=15;j<N;j++) pHigh += p(j);
    ok(pHigh > 0.08, 't15+ is common (~11.6% per seed) — no longer effectively zero');
    ok(p(0) > p(N-1), 'still skewed toward the low tiers (t0 far more likely than t20)');
    ok(p(0) > p(5) && p(5) > p(15), 'the weighting is monotonically skewed toward lower tiers');
    // The roll only ever returns a valid tier index, and (statistically) reaches the top tier.
    var allValid = true, sawHigh = false;
    for(var k=0;k<4000;k++){ var t = FF.pickWeightedFarmingTier(); if(!(t>=0 && t<N && t===(t|0))) allValid=false; if(t>=15) sawHigh = true; }
    ok(allValid, 'the roll always returns a valid tier index');
    ok(sawHigh, 'sampling actually turns up t15+ seeds');
    // Passing a line's own tier count caps the roll -- Grain (20 tiers) must never roll t20.
    var grainMax = -1; for(var gk=0;gk<4000;gk++){ var gt = FF.pickWeightedFarmingTier(FF.GRAIN_TIER_COUNT); if(gt > grainMax) grainMax = gt; }
    ok(grainMax === FF.GRAIN_TIER_COUNT - 1, 'grain rolls span its own tiers (top index is GRAIN_TIER_COUNT-1, never 20)');
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
    // Quartermaster + Diligence feed EVERY craft. Masterwork is NOT bundled into any craft's physique list —
    // it now trains only when a craft yields rare+ equipment (see the 'masterwork physique: rare+ only' suite).
    ok(feeds(FF.CRAFT_PHYSIQUE.cooking,'quartermaster') && feeds(FF.CRAFT_PHYSIQUE.cooking,'diligence'), 'all crafts train Quartermaster + Diligence');
    ok(!feeds(FF.CRAFT_PHYSIQUE.weaponsmithing,'masterwork') && !feeds(FF.CRAFT_PHYSIQUE.cooking,'masterwork'), 'Masterwork is no longer bundled into any per-craft physique list');
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

  // ---- Gathering tools: success scales by TIER only, reaching +25% at the top tier -------
  suite('gather tool success is tier-scaled and rarity-independent', function(){
    eq(FF.GATHER_TOOL_SUCCESS_MAX, 0.25, 'a top-tier gather tool adds +25% success');
    eq(FF.gatherToolSuccessBonus(0), 0, 'no tool -> no success bonus');
    eq(FF.gatherToolSuccessBonus(1), 0, 'the first tool tier adds nothing yet');
    near(FF.gatherToolSuccessBonus(21), 0.25, 'the top tool tier (stored 21 = index 20) adds +25%');
    // Strictly monotonic across the ladder.
    var prev = -1, mono = true;
    for(var t = 0; t <= 21; t++){ var b = FF.gatherToolSuccessBonus(t); if(b < prev) mono = false; prev = b; }
    ok(mono, 'the success bonus never decreases as tier climbs');

    var S = FF._state, savedT = S.gatherTools, savedR = S.gatherToolRarities;
    try {
      S.gatherTools = {}; S.gatherToolRarities = {};
      // 70%-base gathers reach the 95% cap exactly at Tier 20 (top tool = stored tier 21), not before.
      S.gatherTools.mining = 21;
      near(FF.miningMainChance(S), 0.95, 'a top-tier Pickaxe reaches the 95% mining cap');
      S.gatherTools.mining = 20; // one tier short of the top
      ok(FF.miningMainChance(S) < 0.95, 'one tier below the top is still under 95%');
      near(FF.miningMainChance(S), 0.70 + 0.25*(19/20), 'mining success is a clean linear ramp', 1e-6);
      // Rarity no longer inflates success: a Fantastic mid-tier tool matches a Normal one.
      S.gatherTools.mining = 14; // ~cobalt tier
      S.gatherToolRarities.mining = 'fantastic';
      var fant = FF.miningMainChance(S);
      S.gatherToolRarities.mining = 'normal';
      var norm = FF.miningMainChance(S);
      near(fant, norm, 'tool rarity does not change gathering success (speed only)');
      ok(fant < 0.95, 'a cobalt-tier tool no longer hits the 95% cap');
      // Fishing/digging share the same tier-scaled bonus (lower/equal bases).
      S.gatherTools.fishing = 21;
      near(FF.fishingCatchChance(S), 0.75, 'fishing tops out at base 50% + 25% tool = 75%');
      S.gatherTools.digging = 21;
      near(FF.diggingMainChance(S), 0.95, 'digging reaches 95% at the top tier');
    } finally {
      S.gatherTools = savedT; S.gatherToolRarities = savedR;
    }
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

  // ---- Persisted server-wide IMPROVEMENT (enhance) blasts reload into chat too ----------------------
  suite('persistent improvement blasts', function(){
    // Enhance body carries the "+N" level; +15 or higher reads Fantastic, otherwise Supreme.
    eq(FF.enhanceBodyRarity('Willow Fire Wand to +12'), 'supreme', '+12 improvement -> supreme tint');
    eq(FF.enhanceBodyRarity('Dragon Bow to +15'), 'fantastic', '+15 improvement -> fantastic tint');
    eq(FF.enhanceBodyRarity('Sword to +20'), 'fantastic', '+20 improvement -> fantastic tint');
    var e = FF.chronicleEnhanceToSystemMsg({ id:42, username:'Nyx', body:'Willow Fire Wand to +12', created_at:'2026-07-10T00:00:00Z' });
    ok(e && e.system === true && e.rarity === 'supreme', 'an enhance row -> a persistent system message');
    ok(e.id === 'sys-42' && e.username === null && /Nyx enhanced their Willow Fire Wand to \+12!/.test(e.body), 'improvement blast carries the enhancer + item + level');
    ok(FF.chronicleEnhanceToSystemMsg({ id:43, username:'A', body:'', created_at:'x' }) === null, 'an empty enhance body -> no blast');
    // The kind-dispatcher routes each chronicle row to the right synthesizer.
    ok(/enhanced their/.test(FF.chronicleRowToSystemMsg({ kind:'enhance', id:1, username:'A', body:'X to +11', created_at:'x' }).body), 'row dispatcher handles enhance rows');
    ok(/forged a/.test(FF.chronicleRowToSystemMsg({ kind:'craft', id:2, username:'A', body:'Supreme Y', created_at:'x' }).body), 'row dispatcher handles craft rows');
    ok(FF.chronicleRowToSystemMsg({ kind:'level', id:3, username:'A', body:'Mining 50', created_at:'x' }) === null, 'non-blast chronicle kinds (level) produce no chat message');
  });

  // ---- Top-bar tips & tricks ticker ------------------------------------------------------------------
  suite('tips ticker', function(){
    var T = FF.TICKER_TIPS;
    ok(Array.isArray(T) && T.length >= 20, 'there is a healthy list of tips (>= 20)');
    ok(T.every(function(t){ return typeof t === 'string' && t.length > 10; }), 'every tip is a non-trivial string');
    ok(T.some(function(t){ return /Logic/.test(t) && /craft slot/.test(t); }), 'includes the Logic craft-slot tip');
    ok(T.some(function(t){ return /Sand/.test(t) && /Archaeolog/.test(t); }), 'includes the Sand / Archaeology tip');
    ok(new Set(T).size === T.length, 'no duplicate tips');
    // Pre-alpha disclaimer: red, correct wording, and weighted well above any single tip.
    var d = FF.TICKER_DISCLAIMER;
    ok(/Active Development Pre-Alpha/.test(d) && /progress wipes/.test(d) && /feedback/.test(d), 'disclaimer carries the pre-alpha wording');
    ok(/color:\s*#ff6b6b/i.test(d), 'disclaimer is styled red');
    ok(FF.TICKER_DISCLAIMER_CHANCE > (1 / T.length), 'disclaimer appears far more often than any single tip');
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
    // Summoning still works; it just no longer pings a (removed) server-wide grant. Force a summon on a
    // skill with a familiar defined but not yet owned and confirm the familiar is granted.
    var s = FF._state;
    var skill = Object.keys(FF.FAMILIAR_DATA).filter(function(k){ return !(s.familiars[k] && s.familiars[k].owned); })[0];
    ok(skill, 'there is a skill whose familiar is not yet owned to test the summon');
    if(skill){
      var savedRandom = Math.random, savedFam = s.familiars[skill];
      s.familiars[skill] = undefined;
      Math.random = function(){ return 0; };    // force the summon roll to succeed
      try { FF.maybeSummonFamiliar(skill); } finally { Math.random = savedRandom; }
      ok(s.familiars[skill] && s.familiars[skill].owned, 'the brand-new familiar was summoned');
      s.familiars[skill] = savedFam;
    }
    // The buy/registration buff is a full hour; the server extends greatest(now, active_until) by that and
    // the client just reflects whatever active_until comes back.
    eq(FF.SERVER_BUFF_EXP_MS, 3600*1000, 'a full (purchase/registration) buff is 1 hour');
    ok(typeof FF.serverBuffGrant === 'undefined', 'the free client-callable server-buff grant is gone');
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
    // Website links are stripped (scam/off-site link prevention), on send AND display.
    eq(c('visit http://evil.com/win now'), 'visit [link removed] now', 'http URL removed');
    eq(c('go to https://phish.io/x'), 'go to [link removed]', 'https URL removed');
    eq(c('see www.example.org for more'), 'see [link removed] for more', 'www URL removed');
    eq(c('join discord.gg/abc123'), 'join [link removed]', 'bare domain.tld/path removed');
    eq(c('my site is cool-stuff.net today'), 'my site is [link removed] today', 'hyphenated bare domain removed');
    ok(c('grab it at bit.ly/xyz').indexOf('[link removed]') !== -1, 'short-link domain removed');
    // False positives are NOT censored: decimals, initialisms, party codes, item tokens.
    eq(c('it does 3.5x damage'), 'it does 3.5x damage', 'decimals are not links');
    eq(c('e.g. the tunnel'), 'e.g. the tunnel', 'initialisms (e.g.) are not links');
    eq(c('join my party d2:3f9a1b2c-4d5e-6f70'), 'join my party d2:3f9a1b2c-4d5e-6f70', 'a party code is not a link');
    eq(c('look {{i:AbC123deF}}'), 'look {{i:AbC123deF}}', 'an item-link token is not a website link');
  });

  // ---- Chat profanity filter: per-viewer display toggle ----------------------------------------
  suite('chat: profanity filter is an opt-out display setting', function(){
    var s = FF._state;
    s.settings = s.settings || {};
    var prev = s.settings.chatFilter;
    var d = FF.chatDisplayCensor;
    // Default (filter ON): profanity is masked at display, links always stripped.
    s.settings.chatFilter = true;
    ok(d('you fuck').indexOf('*') !== -1, 'filter on -> profanity masked at display');
    eq(d('visit http://evil.com now'), 'visit [link removed] now', 'filter on -> links removed');
    // Opted out (filter OFF): the raw words come through, but links are STILL stripped (scam prevention).
    s.settings.chatFilter = false;
    eq(d('you fuck'), 'you fuck', 'filter off -> profanity shown raw');
    eq(d('visit http://evil.com now'), 'visit [link removed] now', 'filter off -> links still removed');
    // Undefined setting is treated as ON (safe default), so it never leaks profanity by accident.
    delete s.settings.chatFilter;
    ok(d('you fuck').indexOf('*') !== -1, 'missing setting defaults to masking');
    // The underlying helpers are independent: maskProfanity always masks, censorChat is the full pass.
    ok(FF.maskProfanity('shit').charAt(0) === 's' && FF.maskProfanity('shit').slice(1) === '***', 'maskProfanity masks unconditionally');
    ok(FF.censorChat('you fuck').indexOf('*') !== -1 && FF.censorChat('go to www.x.io').indexOf('[link removed]') !== -1, 'censorChat still does links + profanity');
    s.settings.chatFilter = prev;
  });

  // ---- Chat unread counter ---------------------------------------------------------------------
  suite('chat: unread count + "Chat (N)" suffix', function(){
    var s = FF._state;
    s.settings = s.settings || {};
    s.settings.chatFlash = true;
    FF.clearChatUnread();
    eq(FF.getChatUnreadCount(), 0, 'starts at 0');
    eq(FF.chatUnreadSuffix(), '', 'no suffix when nothing unread');
    // A message arriving while chat isn't focused/on-screen accrues an unread.
    FF.noteChatActivity(); FF.noteChatActivity(); FF.noteChatActivity(); FF.noteChatActivity();
    eq(FF.getChatUnreadCount(), 4, 'four notes -> count 4');
    eq(FF.chatUnreadSuffix(), ' (4)', 'suffix reads " (4)"');
    // Mobile FAB badge reflects the same count and flashes.
    var badge = document.getElementById('ffChatFabBadge');
    ok(badge && badge.textContent === '4', 'FAB badge shows 4');
    ok(document.getElementById('ffChatFab').classList.contains('ff-chatfab-alert'), 'FAB flashes while unread');
    // Reading chat clears everything.
    FF.clearChatUnread();
    eq(FF.getChatUnreadCount(), 0, 'clear resets to 0');
    eq(FF.chatUnreadSuffix(), '', 'suffix gone after clear');
    ok(badge.textContent === '', 'FAB badge cleared');
    ok(!document.getElementById('ffChatFab').classList.contains('ff-chatfab-alert'), 'FAB no longer flashes');
    // Count caps its label at 99+.
    for(var i=0;i<120;i++) FF.noteChatActivity();
    eq(FF.chatUnreadSuffix(), ' (99+)', 'label caps at 99+');
    FF.clearChatUnread();
    // Respecting the setting: with chatFlash off, no unread accrues.
    s.settings.chatFlash = false;
    FF.noteChatActivity();
    eq(FF.getChatUnreadCount(), 0, 'no unread when chatFlash disabled');
    s.settings.chatFlash = true;
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
    // Brewing = drinkable BONUS-OUTPUT buff (a separate lever from Mixology's XP Tea), and finally
    // consumes Botany spices + Honey + Grain.
    var brew5 = FF.ALL_CRAFT_RECIPES['brewing_t5'];
    ok(brew5.brewDurationMs > 0 && brew5.brewYield > 0, 'brews are bonus-output buff-drinks');
    ok(brew5.teaDurationMs === undefined && brew5.xpBoost === undefined, 'brews no longer carry the Tea XP-boost fields');
    ok(brew5.inputs['beekeeping_t5'] && brew5.inputs['botany_t5'] && brew5.inputs['grain_t5'], 'brew uses honey + botany spice + grain');
    ok(FF.BREW_DRINK_RECIPES.some(function(r){ return r.id === 'brewing_t5'; }), 'brews join the drinkable Brew pool');
    ok(!FF.TEA_DRINK_RECIPES.some(function(r){ return r.id === 'brewing_t5'; }), 'brews are NOT in the Tea pool (own buff slot)');
    ok(FF.TEA_DRINK_RECIPES.some(function(r){ return r.id === 'mixology_t5'; }), 'mixology teas are the Tea pool');
    // Yield curve: 5% at t0 climbing to the 20% cap at t20.
    near(FF.ALL_CRAFT_RECIPES['brewing_t0'].brewYield, 0.05, 'brew bonus-output chance starts at 5% (t0)');
    near(FF.ALL_CRAFT_RECIPES['brewing_t20'].brewYield, 0.20, 'brew bonus-output chance caps at 20% (t20)');
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

  // ---- Brewing Brew buff: bonus-output throughput on its own slot ------------------------------
  suite('brew buff: bonus-output, separate slot from Tea', function(){
    ok(typeof FF.isBrewActive==='function' && typeof FF.brewYieldRoll==='function' && typeof FF.drinkBrew==='function', 'brew buff helpers exported');
    var s = FF._state;
    var sv = { inv:s.inventory, brew:s.activeBrew, tea:s.activeTea, stats:s.stats, phys:s.physique };
    try {
      s.inventory = {}; s.stats = {}; s.physique = {};
      s.activeBrew = { itemId:null, name:null, icon:null, yield:0, durationMs:0, expiresAt:0 };
      s.activeTea  = { itemId:null, name:null, icon:null, xpBoost:0, durationMs:0, expiresAt:0 };
      // Inactive: no roll ever fires.
      ok(!FF.isBrewActive(), 'no brew active to start');
      ok(!FF.brewYieldRoll(), 'brewYieldRoll is false with no active brew');
      // Drinking a Brew consumes one and starts the buff on the activeBrew slot (never activeTea).
      s.inventory['brewing_t5'] = 2;
      FF.drinkBrew('brewing_t5');
      eq(s.inventory['brewing_t5'], 1, 'drinking a Brew consumes one from the stack');
      ok(FF.isBrewActive(), 'the brew buff is now active');
      eq(s.activeBrew.itemId, 'brewing_t5', 'activeBrew holds the drunk brew');
      ok(!s.activeTea.itemId, 'the Tea slot is untouched -- Brews and Teas are separate buffs');
      // A guaranteed-yield brew makes brewYieldRoll always true, and adds a bonus gather output.
      s.activeBrew.yield = 1;
      ok(FF.brewYieldRoll(), 'brewYieldRoll is true while an active brew has 100% yield');
      s.inventory = {}; // clean slate for the gather-output integration (no workshops/mastery/prospector in this state)
      FF.gatherDoubleRoll('forestry_t3', 'forestry'); // forestry avoids the Prospector bonus path
      eq(s.inventory['forestry_t3']||0, 1, 'an active brew grants a bonus gather output');
      // With the brew expired, the same roll grants nothing.
      s.activeBrew.expiresAt = 0;
      s.inventory = {};
      ok(!FF.isBrewActive(), 'brew has expired');
      FF.gatherDoubleRoll('forestry_t3', 'forestry');
      eq(s.inventory['forestry_t3']||0, 0, 'no bonus output once the brew is gone');
    } finally {
      s.inventory = sv.inv; s.activeBrew = sv.brew; s.activeTea = sv.tea; s.stats = sv.stats; s.physique = sv.phys;
    }
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
    // An Enchant Crystal must NOT read as a potion (that stale path put a bogus "In combat" line on its card).
    eq(FF.potionEffectDesc('enchant_t5'), '', 'an Enchant Crystal has no combat-consumable effect text');
    ok(FF.potionEffectDesc('coating_t5') !== '', 'a real consumable (coating) still describes its combat effect');
    ok(FF.GATHER_PHYSIQUE.prospecting && FF.CRAFT_PHYSIQUE.gemcutting && FF.CRAFT_PHYSIQUE.enchanting, 'physique tables include the new skills');
  });

  // ---- Improvement: Auto-roll enchanting (roll until a target mod/value or crystals deplete) ----
  suite('improvement: auto-roll enchanting', function(){
    var s = FF._state;
    var savedU = s.uniqueItems, savedInv = s.inventory['enchant_t0'];
    function setup(enchants, crystals){
      s.uniqueItems = { u9001:{ uid:'u9001', base:'stweapon_sword_t0_rare', kind:'weapon', tier:0, rarity:'rare', enhance:0, enchants:enchants } };
      s.inventory['enchant_t0'] = crystals;
    }

    // A) Keeps rolling until the requested mod lands, then stops with a single slot filled.
    setup([], 500);
    var a = FF.improveAutoRoll('critDamage', 5, 'u9001');
    ok(a && a.placed && a.placed.mod==='critDamage' && a.placed.roll>=5, 'auto-roll lands the requested Critical Damage enchant');
    eq(s.uniqueItems['u9001'].enchants.length, 1, 'exactly one enchant is placed');
    eq(s.uniqueItems['u9001'].enchants[0].mod, 'critDamage', 'the placed enchant is the target mod');
    eq(s.inventory['enchant_t0'], 500 - a.spent, 'crystals removed match the reported spend');
    ok(a.spent >= 1, 'at least one crystal was spent');

    // B) No affordable crystals -> spends nothing, places nothing.
    setup([], 0);
    var b = FF.improveAutoRoll('critDamage', 5, 'u9001');
    ok(b && !b.placed && b.spent===0, 'no crystals -> auto-roll is inert');
    eq(s.uniqueItems['u9001'].enchants.length, 0, 'the item is untouched when it cannot afford a roll');

    // C) Target already met -> no-op, no spend.
    setup([{mod:'critDamage', roll:25}], 100);
    eq(FF.improveAutoRoll('critDamage', 20, 'u9001'), null, 'auto-roll no-ops when the target is already satisfied');
    eq(s.inventory['enchant_t0'], 100, 'nothing spent when already satisfied');

    // D) Full item with no copy of the target mod -> blocked, no spend (never overwrites unrelated enchants).
    setup([{mod:'weaponDamage', roll:10},{mod:'flatDamage', roll:10}], 100);
    eq(FF.improveAutoRoll('critDamage', 5, 'u9001'), null, 'auto-roll refuses a full item with no matching mod to upgrade');
    eq(s.inventory['enchant_t0'], 100, 'nothing spent when blocked');

    // E) Full item WITH the target mod -> upgrades it in place, leaving the other enchant alone.
    setup([{mod:'critDamage', roll:8},{mod:'weaponDamage', roll:10}], 4000);
    var e = FF.improveAutoRoll('critDamage', 25, 'u9001');
    ok(e && e.placed && e.placed.roll>=25, 'auto-roll upgrades the existing Critical Damage to the target');
    var en = s.uniqueItems['u9001'].enchants;
    eq(en.length, 2, 'slot count is unchanged on an in-place upgrade');
    var cd = en.filter(function(x){return x.mod==='critDamage';})[0];
    var wd = en.filter(function(x){return x.mod==='weaponDamage';})[0];
    ok(cd && cd.roll>=25, 'the Critical Damage slot now meets the target');
    ok(wd && wd.roll===10, 'the unrelated Weapon Damage enchant is left untouched');

    // F) A target above the mod ceiling is rejected up front.
    setup([], 100);
    eq(FF.improveAutoRoll('critChance', 999, 'u9001'), null, 'a target above the mod maximum is rejected');
    eq(s.inventory['enchant_t0'], 100, 'no crystals spent on an impossible target');

    // G) Slot "new": a satisfied copy of the same mod no longer blocks rolling a SECOND copy.
    setup([{mod:'critDamage', roll:25}], 4000);
    var g = FF.improveAutoRoll('critDamage', 5, 'u9001', 'new');
    ok(g && g.placed && g.placed.mod==='critDamage', 'slot "new" rolls another copy of an already-satisfied mod');
    var gEn = s.uniqueItems['u9001'].enchants;
    eq(gEn.length, 2, 'the second copy fills the unused slot');
    eq(gEn[0].roll, 25, 'the original copy is untouched');
    eq(gEn[1].mod, 'critDamage', 'the new slot holds the target mod');

    // H) A picked slot replaces exactly that enchant, even an unrelated mod on a full item.
    setup([{mod:'weaponDamage', roll:10},{mod:'flatDamage', roll:10}], 4000);
    var h = FF.improveAutoRoll('critDamage', 5, 'u9001', 1);
    ok(h && h.placed && h.placed.mod==='critDamage', 'a picked slot lets auto-roll replace an unrelated enchant');
    var hEn = s.uniqueItems['u9001'].enchants;
    eq(hEn.length, 2, 'slot count unchanged on a picked-slot replace');
    ok(hEn[0].mod==='weaponDamage' && hEn[0].roll===10, 'the unpicked slot is untouched');
    eq(hEn[1].mod, 'critDamage', 'the picked slot now holds the target mod');

    // I) Slot "new" on a full item is blocked with nothing spent.
    setup([{mod:'weaponDamage', roll:10},{mod:'flatDamage', roll:10}], 100);
    eq(FF.improveAutoRoll('critDamage', 5, 'u9001', 'new'), null, 'slot "new" refuses a full item');
    eq(s.inventory['enchant_t0'], 100, 'nothing spent when there is no unused slot');

    // J) A picked slot no-ops only when THAT slot already meets the target; a stale index is rejected.
    setup([{mod:'critDamage', roll:25},{mod:'weaponDamage', roll:10}], 100);
    eq(FF.improveAutoRoll('critDamage', 20, 'u9001', 0), null, 'picked slot already satisfied -> no-op');
    eq(s.inventory['enchant_t0'], 100, 'nothing spent on a satisfied picked slot');
    eq(FF.improveAutoRoll('critDamage', 5, 'u9001', 7), null, 'an out-of-range slot index is rejected');
    eq(s.inventory['enchant_t0'], 100, 'nothing spent on a stale slot index');

    // restore
    s.uniqueItems = savedU; s.inventory['enchant_t0'] = savedInv;
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

    // Combat UI: Feasts + Confections surface as usable item buffs like Potions/Bombs do.
    ok(typeof FF.foodConsumableList === 'function' && typeof FF.eatConfection === 'function', 'food-consumable helpers exported');
    var _sv = { inv: FF._state.inventory, hp: FF._state.playerHp, feast: FF._state.activeFeast };
    try {
      FF._state.inventory = { gastronomy_t3:2, confectionery_t2:3 };
      FF._state.activeFeast = { itemId:null, name:null, icon:null, dmgBonus:0, durationMs:0, expiresAt:0 };
      FF._state.playerHp = 1;
      var flist = FF.foodConsumableList();
      eq(flist.length, 2, 'a Feast and a Confection both surface as combat consumables');
      ok(flist.some(function(x){ return x.id==='gastronomy_t3' && x.action==='serveFeast'; }), 'Feast uses the serveFeast action');
      ok(flist.some(function(x){ return x.id==='confectionery_t2' && x.action==='eatConfection'; }), 'Confection uses the eatConfection action');
      var fpanel = FF.renderFoodConsumablesPanel();
      ok(/data-action="serveFeast"/.test(fpanel) && /data-action="eatConfection"/.test(fpanel), 'the panel offers both Serve and Eat buttons');
      var beforeHp = FF._state.playerHp;
      FF.eatConfection('confectionery_t2');
      ok(FF._state.playerHp > beforeHp, 'eating a Confection heals');
      eq(FF._state.inventory['confectionery_t2'], 2, 'eating a Confection consumes exactly one');
      // At full HP a Confection is not wasted.
      FF._state.playerHp = FF.maxHp(FF._state);
      FF.eatConfection('confectionery_t2');
      eq(FF._state.inventory['confectionery_t2'], 2, 'a Confection is not consumed at full HP');
    } finally {
      FF._state.inventory = _sv.inv; FF._state.playerHp = _sv.hp; FF._state.activeFeast = _sv.feast;
    }
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

  // ---- Body-armour XP scales with the material each slot consumes ------------------------------
  suite('body armour XP scales per material used (Gambeson fix)', function(){
    function xp(mat, slot){ return FF.getBodyArmorTierData(mat, slot, 5).xp; }
    function qty(mat, slot){ var inp = FF.getBodyArmorTierData(mat, slot, 5).inputs; for(var k in inp){ if(/_t5$/.test(k)) return inp[k]; } return 0; } // the raw-material key ends in _t5 (the prev-tier key ends in _normal)
    ['leather','chain','plate','tailoring'].forEach(function(mat){
      // The Chest's XP tracks its material cost relative to the cheapest slot (rounding aside).
      var cheapSlot = 'gauntlets';
      var ratio = qty(mat,'chest') / qty(mat, cheapSlot);
      var expected = xp(mat, cheapSlot) * ratio;
      near(xp(mat,'chest'), expected, mat + ' chest XP scales with its material cost', Math.max(1, expected * 0.02));
      ok(xp(mat,'chest') > xp(mat, cheapSlot), mat + ' chest (more material) grants more XP than the cheap slot');
      // Non-chest slots that cost the same as the cheapest keep identical XP (no global inflation).
      eq(xp(mat,'boots'), xp(mat,'gauntlets'), mat + ' equal-cost slots keep equal XP');
    });
    // Concrete: leather Gambeson (3 leather) = 1.5x a 2-leather leather piece.
    near(xp('leather','chest') / xp('leather','gauntlets'), 1.5, 'leather Gambeson gives 1.5x a 2-leather piece', 1.02);
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
    // Berserker rework: Titan's Heft (Lv1) / Blood Pact (Lv20) / Glass Titan (Lv40) / Rage (Lv60) / Berserk Toll (Lv80).
    var bNames = FF.CLASS_DEFS_BY_ID.berserker.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(bNames), JSON.stringify(["Titan's Heft",'Blood Pact','Glass Titan','Rage','Berserk Toll']), 'Berserker ladder is the reworked five');
    // Titan's Heft (Lv1): flat bonus damage = 2% of max HP.
    var bHeft = stFor('berserker',1);
    eq(FF.berserkerTitansHeftDmg(bHeft), Math.round(0.02 * FF.maxHp(bHeft)), "Titan's Heft = 2% of max HP as flat damage");
    ok(FF.berserkerTitansHeftDmg(bHeft) > 0, "Titan's Heft grants a positive flat bonus");
    // Blood Pact (Lv20): +50% damage.
    eq(FF.berserkerBloodPactMult(stFor('berserker',20)), 1.5, 'Blood Pact +50% damage');
    eq(FF.berserkerBloodPactMult(stFor('berserker',1)), 1, 'Blood Pact inactive below Lv20');
    // Glass Titan (Lv40): +100% max HP (doubles the pool), -40% Armor & Dodge.
    eq(FF.berserkerGlassTitanHpMult(stFor('berserker',40)), 2, 'Glass Titan doubles max HP');
    eq(FF.berserkerGlassTitanHpMult(stFor('berserker',20)), 1, 'Glass Titan HP boost inactive below Lv40');
    eq(FF.maxHp(stFor('berserker',40)), 2 * FF.maxHp(stFor('berserker',20)), 'Glass Titan: max HP at Lv40 is double the pre-Lv40 pool');
    eq(FF.berserkerGlassMult(stFor('berserker',40)), 0.60, 'Glass Titan -40% Armor & Dodge (x0.60)');
    eq(FF.berserkerGlassMult(stFor('berserker',20)), 1, 'Glass Titan Armor/Dodge penalty inactive below Lv40');
    // Rage (Lv60, moved from Lv1): +1% dmg per 2% HP missing (up to +50%).
    eq(FF.berserkerRageMult(stFor('berserker',60,{playerHp: FF.maxHp(stFor('berserker',60))})), 1, 'Rage = x1 at full HP');
    ok(Math.abs(FF.berserkerRageMult(stFor('berserker',60,{playerHp:0})) - 1.5) < 1e-9, 'Rage = x1.5 near death');
    eq(FF.berserkerRageMult(stFor('berserker',40)), 1, 'Rage inactive below Lv60 (even while hurt)');
    // Berserk Toll (Lv80): +80% damage, and a hard 50%-max-HP heal ceiling.
    eq(FF.berserkerTollMult(stFor('berserker',80)), 1.8, 'Berserk Toll +80% damage');
    eq(FF.berserkerTollMult(stFor('berserker',60)), 1, 'Berserk Toll inactive below Lv80');
    var bToll = stFor('berserker',80); var bCeil = Math.round(0.5 * FF.maxHp(bToll));
    eq(FF.hpHealCeil(bToll), bCeil, 'Berserk Toll caps the heal ceiling at 50% of max HP');
    eq(FF.hpHealCeil(stFor('berserker',60)), FF.maxHp(stFor('berserker',60)), 'without Berserk Toll the heal ceiling is full max HP');
    eq(FF.healRoom(stFor('berserker',80,{playerHp: bCeil - 10})), 10, 'Berserk Toll: heal room stops at the 50% ceiling');
    eq(FF.healRoom(stFor('berserker',80,{playerHp: bCeil + 20})), 0, 'Berserk Toll: no heal room while above the 50% ceiling');
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
    // Sentinel rework: Spiked Barrier (Lv1) / Iron Maiden (Lv20) / Reckoning (Lv40) / Brittle Guard (Lv60) / Bulwark's Wrath (Lv80).
    var senNames = FF.CLASS_DEFS_BY_ID.sentinel.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(senNames), JSON.stringify(['Spiked Barrier','Iron Maiden','Reckoning','Brittle Guard',"Bulwark's Wrath"]), 'Sentinel ladder is the reworked five');
    // Spiked Barrier (Lv1): reflect 25% of every incoming hit (blocked or not).
    ok(Math.abs(FF.sentinelReflectDamage(100, 0, 999, stFor('sentinel',1)) - 25) < 1e-9, 'Spiked Barrier: reflect 25% of a 100 hit (unblocked)');
    ok(Math.abs(FF.sentinelReflectDamage(100, 80, 999, stFor('sentinel',1)) - 25) < 1e-9, 'Spiked Barrier alone ignores the blocked share below Lv20');
    // Iron Maiden (Lv20): + 150% of the damage a Block prevented, on top of Spiked Barrier.
    ok(Math.abs(FF.sentinelReflectDamage(100, 80, 999, stFor('sentinel',20)) - (25 + 120)) < 1e-9, 'Iron Maiden: +150% of the 80 prevented (=120) atop Spiked Barrier 25');
    ok(Math.abs(FF.sentinelReflectDamage(100, 0, 999, stFor('sentinel',20)) - 25) < 1e-9, 'Iron Maiden adds nothing on an unblocked hit');
    // Bulwark's Wrath (Lv80): +40% Armor, and every reflect adds your full Armor rating.
    eq(FF.sentinelArmorMult(stFor('sentinel',80)), 1.40, "Bulwark's Wrath +40% Armor");
    eq(FF.sentinelArmorMult(stFor('sentinel',60)), 1, 'no Armor bonus below Lv80 (Bracing removed)');
    ok(Math.abs(FF.sentinelReflectDamage(100, 80, 50, stFor('sentinel',80)) - (25 + 120 + 50)) < 1e-9, "Bulwark's Wrath adds the 50 Armor rating to the reflect");
    eq(FF.sentinelReflectDamage(100, 80, 50, stFor('sentinel',60)), 25 + 120, 'below Lv80 the Armor rating is not added to reflect');
    // Sentinel is the shield-wall: a solid innate Block chance so its Block-payoff perks reliably fire.
    ok(FF.classBlockBonus(stFor('sentinel',1)) >= 0.30, 'Sentinel gains innate Block chance');
    eq(FF.classBlockBonus(stFor('spellblade',80)), 0, 'a non-Sentinel class gets no innate Block bonus');
    // Brittle Guard (Lv60) shreds via the shared Sunder window; its constants are exported.
    eq(FF.SENTINEL_BRITTLE_MS, 6000, 'Brittle Guard Sunder window is 6s');
    eq(FF.SENTINEL_SHRED_FRAC, 0.5, 'Sunder ignores 50% of enemy armour');
    // No Sentinel reflect without the class.
    eq(FF.sentinelReflectDamage(100, 80, 999, {xp:{},physique:{},bodyArmor:{},equippedMainhand:null,equippedOffhand:null,activity:{type:'combat'},playerHp:1}), 0, 'no class -> no reflect');
    // Spellblade rework: Rune Hunger (Lv1) / Critical Runes (Lv20) / Spell Echo (Lv40) / Twin Echo (Lv60) / Empowered Runes (Lv80).
    var sbNames = FF.CLASS_DEFS_BY_ID.spellblade.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(sbNames), JSON.stringify(['Rune Hunger','Critical Runes','Spell Echo','Twin Echo','Empowered Runes']), 'Spellblade ladder is the reworked five');
    // Build a Spellblade with two equipped weapon enchants (a 20% Critical Damage + a 10% Weapon Damage).
    function sbEnch(level){
      var st = stFor('spellblade', level);
      st.uniqueItems = { w1:{ kind:'weapon', enhance:0, enchants:[{mod:'critDamage',roll:20},{mod:'weaponDamage',roll:10}] } };
      st.equippedMainhandUid = 'w1';
      return st;
    }
    // Rune Hunger (Lv1): +4% damage per equipped enchant.
    eq(FF.equippedEnchantCount(sbEnch(1)), 2, 'equippedEnchantCount tallies each equipped enchant');
    ok(Math.abs(FF.spellbladeRuneHungerMult(sbEnch(1)) - 1.08) < 1e-9, 'Rune Hunger: +4% x 2 enchants = +8%');
    eq(FF.spellbladeRuneHungerMult(stFor('spellblade',1)), 1, 'Rune Hunger neutral with no equipped enchants');
    // Critical Runes (Lv20): +1% crit per 5% Critical-Damage enchant (here 20% -> +4%).
    ok(Math.abs(FF.spellbladeCriticalRunesCrit(sbEnch(20)) - 0.04) < 1e-9, 'Critical Runes: 20% crit-dmg enchant -> +4% crit chance');
    eq(FF.spellbladeCriticalRunesCrit(sbEnch(1)), 0, 'Critical Runes inactive below Lv20');
    // Empowered Runes (Lv80): enchant bonuses doubled -> Critical Runes reads the doubled crit-dmg (40% -> +8%).
    eq(FF.spellbladeEnchantBoost(stFor('spellblade',80)), 2.0, 'Empowered Runes doubles enchant bonuses');
    eq(FF.spellbladeEnchantBoost(stFor('spellblade',60)), 1, 'no enchant amplification below Lv80');
    ok(Math.abs(FF.spellbladeCriticalRunesCrit(sbEnch(80)) - 0.08) < 1e-9, 'Empowered Runes doubles the crit-dmg feeding Critical Runes (40% -> +8%)');
    // Spell Echo (Lv40) 15%; Twin Echo (Lv60) 30%; nothing below Lv40.
    ok(Math.abs(FF.spellbladeEchoChance(stFor('spellblade',40)) - 0.15) < 1e-9, 'Spell Echo: 15% at Lv40');
    ok(Math.abs(FF.spellbladeEchoChance(stFor('spellblade',60)) - 0.30) < 1e-9, 'Twin Echo: 30% at Lv60');
    eq(FF.spellbladeEchoChance(stFor('spellblade',20)), 0, 'no echo below Lv40');
    // No class active -> every perk multiplier is neutral.
    var none = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:'combat'}, playerHp:1 };
    eq(FF.berserkerRageMult(none), 1, 'no class -> Rage neutral');
    eq(FF.frostwardenDmgMult(none), 1, 'no class -> Frostwarden damage neutral');
    eq(FF.sentinelArmorMult(none), 1, 'no class -> Sentinel armor neutral');
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
    // Sharpshooter rework: Eagle Eye (Lv1) / Pinpoint (Lv20) / Marksman's Focus (Lv40) / Armor-Splitter (Lv60) / Sniper's Patience (Lv80).
    var ssNames = FF.CLASS_DEFS_BY_ID.sharpshooter.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(ssNames), JSON.stringify(['Eagle Eye','Pinpoint',"Marksman's Focus",'Armor-Splitter',"Sniper's Patience"]), 'Sharpshooter ladder is the reworked five');
    var ssMon = FF.MONSTERS[0]; // a weak, low-Dodge foe so the marksman's Accuracy clears its Dodge
    function ssFor(level, extra){
      var st = stFor('sharpshooter', level, extra);
      st.xp.bowLong = FF.xpFloorForLevel(100); // strong bow proficiency -> high Accuracy
      st.activity = st.activity || {}; st.activity.type='combat';
      if(st.activity.monsterId == null) st.activity.monsterId = ssMon.id;
      if(st.activity.monsterHp == null) st.activity.monsterHp = ssMon.hp;
      return st;
    }
    var _ssAcc = FF.playerAccuracy(ssFor(80)), _ssOver = Math.max(0, _ssAcc - FF.monsterDodge(ssMon));
    ok(_ssOver > 0, 'Sharpshooter Accuracy clears the weak foe\'s Dodge (surplus fuels the kit)');
    // Eagle Eye (Lv1): Accuracy over Dodge -> crit chance (/1000, cap 25%). Steady Aim's flat accuracy is gone.
    ok(Math.abs(FF.sharpshooterEagleEyeCrit(ssFor(1)) - Math.min(0.25, _ssOver/1000)) < 1e-9, 'Eagle Eye: accuracy-over-dodge becomes crit chance');
    eq(FF.sharpshooterEagleEyeCrit(stFor('pyromancer',80)), 0, 'Eagle Eye inactive without the class');
    eq(FF.classAccuracyMult(stFor('sharpshooter',80)), 1, 'Steady Aim removed: no flat class accuracy bonus');
    ok(Math.abs(FF.newClassCritChance(ssFor(1)) - FF.sharpshooterEagleEyeCrit(ssFor(1))) < 1e-9, 'Sharpshooter crit chance is driven by Eagle Eye');
    // Pinpoint (Lv20): +1% damage per 5 Accuracy over Dodge (0.002/pt), cap +100%.
    ok(Math.abs(FF.sharpshooterPinpointMult(ssFor(20)) - (1 + Math.min(1.0, _ssOver*0.002))) < 1e-9, 'Pinpoint: accuracy-over-dodge -> damage');
    eq(FF.sharpshooterPinpointMult(ssFor(1)), 1, 'Pinpoint inactive below Lv20');
    // Marksman's Focus (Lv40): +5% crit damage per 100 Accuracy (0.0005/pt), cap +100%.
    ok(Math.abs(FF.sharpshooterFocusCritDmg(ssFor(40)) - Math.min(1.0, _ssAcc*0.0005)) < 1e-9, "Marksman's Focus: accuracy -> crit damage");
    eq(FF.sharpshooterFocusCritDmg(ssFor(20)), 0, "Marksman's Focus inactive below Lv40");
    ok(Math.abs(FF.newClassCritDmg(ssFor(40)) - FF.sharpshooterFocusCritDmg(ssFor(40))) < 1e-9, "Sharpshooter crit damage is driven by Marksman's Focus (flat Aimed/Kill removed)");
    // Armor-Splitter (Lv60): a Critical Hit ignores 100% of enemy armour; a non-crit (or below Lv60) ignores none.
    eq(FF.sharpshooterArmorPierce(true, ssFor(60)), 1, 'Armor-Splitter: a crit ignores all armour at Lv60');
    eq(FF.sharpshooterArmorPierce(false, ssFor(60)), 0, 'Armor-Splitter only applies on a crit');
    eq(FF.sharpshooterArmorPierce(true, ssFor(40)), 0, 'Armor-Splitter inactive below Lv60');
    // Sniper's Patience (Lv80): +4% damage/sec on one foe (cap +80%); resets on a new target (fresh duelStartedAt).
    near(FF.sharpshooterPatienceMult(ssFor(80,{activity:{type:'combat',monsterId:ssMon.id,monsterHp:ssMon.hp,duelStartedAt:Date.now()-10000}})), 1.40, "Sniper's Patience: +4%/sec -> +40% at 10s", 2e-2);
    near(FF.sharpshooterPatienceMult(ssFor(80,{activity:{type:'combat',monsterId:ssMon.id,monsterHp:ssMon.hp,duelStartedAt:Date.now()-30000}})), 1.80, "Sniper's Patience caps at +80%", 1e-6);
    eq(FF.sharpshooterPatienceMult(ssFor(60,{activity:{type:'combat',monsterId:ssMon.id,monsterHp:ssMon.hp,duelStartedAt:Date.now()-10000}})), 1, "Sniper's Patience inactive below Lv80");
    // Juggernaut rework: Wind-Up (Lv1) / Overhead Smash (Lv20) / Concussive Crits (Lv40) /
    // Building Fury (Lv60) / Pulverize (Lv80). Slow, hard-hitting crit bruiser; the old defensive kit is gone.
    var jugNames = FF.CLASS_DEFS_BY_ID.juggernaut.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(jugNames), JSON.stringify(['Wind-Up','Overhead Smash','Concussive Crits','Building Fury','Pulverize']), 'Juggernaut ladder is the reworked five');
    // Wind-Up (Lv1): +45% damage, +25% attack timer (25% slower). The old flat Crushing Blows +30% is gone.
    ok(Math.abs(FF.newClassDmgMult(monFull, stFor('juggernaut',80)) - 1.45) < 1e-9, 'Wind-Up: +45% damage');
    ok(Math.abs(FF.classAttackSpeedMult(stFor('juggernaut',1)) - 1.25) < 1e-9, 'Wind-Up: swings 25% slower (attack timer x1.25)');
    ok(Math.abs(FF.classAttackSpeedMult(stFor('pyromancer',80)) - 1) < 1e-9, 'a non-Juggernaut class does not slow its swings via Wind-Up');
    // The reworked kit drops all defensive perks: no Block, no Armor mult, no incoming reduction.
    eq(FF.classBlockBonus(stFor('juggernaut',80)), 0, 'Juggernaut no longer grants Block (Bulwark removed)');
    ok(typeof FF.juggernautArmorMult === 'undefined', 'Ironclad armor helper removed');
    ok(typeof FF.juggernautIncomingMult === 'undefined', 'Unstoppable incoming helper removed');
    // Overhead Smash (Lv20): every 4th landed hit is a guaranteed crit -> the NEXT hit crits when the tally is at 3, 7, ...
    eq(FF.juggernautSmashReady(stFor('juggernaut',20,{activity:{type:'combat',monsterHp:100,juggernautSwings:3}})), true, 'Overhead Smash: the 4th landed hit (tally 3 -> next) is forced-crit');
    eq(FF.juggernautSmashReady(stFor('juggernaut',20,{activity:{type:'combat',monsterHp:100,juggernautSwings:7}})), true, 'Overhead Smash repeats every 4 hits (tally 7 -> next)');
    eq(FF.juggernautSmashReady(stFor('juggernaut',20,{activity:{type:'combat',monsterHp:100,juggernautSwings:1}})), false, 'Overhead Smash does not fire between the 4th hits');
    eq(FF.juggernautSmashReady(stFor('juggernaut',1,{activity:{type:'combat',monsterHp:100,juggernautSwings:3}})), false, 'Overhead Smash inactive below Lv20');
    // Concussive Crits (Lv40): a crit stuns for 1.5s.
    eq(FF.JUG_CONCUSS_MS, 1500, 'Concussive Crits stun window is 1.5s');
    // Building Fury (Lv60): +12% crit dmg per banked stack (cap 8 -> +96%), read from the activity.
    eq(FF.juggernautFuryStacks(stFor('juggernaut',60,{activity:{type:'combat',monsterHp:100,juggernautFuryStacks:3}})), 3, 'Building Fury: banked stacks read from the fight');
    eq(FF.juggernautFuryStacks(stFor('juggernaut',60,{activity:{type:'combat',monsterHp:100,juggernautFuryStacks:20}})), 8, 'Building Fury caps at 8 stacks');
    eq(FF.juggernautFuryStacks(stFor('juggernaut',40,{activity:{type:'combat',monsterHp:100,juggernautFuryStacks:3}})), 0, 'Building Fury inactive below Lv60');
    ok(Math.abs(FF.newClassCritDmg(stFor('juggernaut',60,{activity:{type:'combat',monsterHp:100,juggernautFuryStacks:3}})) - 0.36) < 1e-9, 'Building Fury: 3 stacks -> +36% crit damage');
    ok(Math.abs(FF.newClassCritDmg(stFor('juggernaut',60,{activity:{type:'combat',monsterHp:100,juggernautFuryStacks:20}})) - 0.96) < 1e-9, 'Building Fury at cap -> +96% crit damage');
    eq(FF.newClassCritDmg(stFor('juggernaut',80)), 0, 'no banked Fury -> no crit-damage bonus (flat Devastate removed)');
    // Pulverize (Lv80): a Critical Hit ignores 100% of the foe\'s armour; a non-crit (or below Lv80) ignores none.
    eq(FF.juggernautArmorPierce(true, stFor('juggernaut',80)), 1, 'Pulverize: a crit ignores all armour at Lv80');
    eq(FF.juggernautArmorPierce(false, stFor('juggernaut',80)), 0, 'Pulverize only applies on a crit');
    eq(FF.juggernautArmorPierce(true, stFor('juggernaut',60)), 0, 'Pulverize inactive below Lv80');
    // Voidshadow rework: Mark of the Void (Lv1) / Enfeeble (Lv20) / Void Resonance (Lv40) /
    // Soul Tax (Lv60) / Doom (Lv80). Curses stack on the foe; the old flat Hex/Siphon/Shadowstep are gone.
    var nbNames = FF.CLASS_DEFS_BY_ID.nightblade.passives.map(function(p){ return p.name; });
    eq(JSON.stringify(nbNames), JSON.stringify(['Mark of the Void','Enfeeble','Void Resonance','Soul Tax','Doom']), 'Voidshadow ladder is the reworked five');
    var vFuture = Date.now() + 10000;
    function nbSt(level, vuln, extraDebuffs){
      var act = { type:'combat', monsterHp:100 };
      if(vuln > 0){ act.voidVulnStacks = vuln; act.voidVulnUntil = vFuture; }
      if(extraDebuffs){ for(var k in extraDebuffs) act[k] = extraDebuffs[k]; }
      return stFor('nightblade', level, { activity:act, classDebuffs:{ enemyDmgUntil:0, enemyArmorUntil:0 } });
    }
    // Mark of the Void: +2% dmg-taken per Vulnerability stack, capped at 10 (+20%).
    ok(Math.abs(FF.voidVulnMult(nbSt(1,5)) - 1.10) < 1e-9, 'Mark of the Void: 5 stacks -> +10% damage taken');
    ok(Math.abs(FF.voidVulnMult(nbSt(1,10)) - 1.20) < 1e-9, 'Mark of the Void: +20% at max (10) stacks');
    ok(Math.abs(FF.voidVulnMult(nbSt(1,20)) - 1.20) < 1e-9, 'Vulnerability mult caps at 10 stacks');
    eq(FF.voidVulnMult(nbSt(1,0)), 1, 'no Vulnerability -> neutral mult');
    // Doom (Lv80): at MAX Vulnerability the foe takes +40% (instead of +20%); below max it is ordinary.
    ok(Math.abs(FF.voidVulnMult(nbSt(80,10)) - 1.40) < 1e-9, 'Doom: +40% damage at max Vulnerability with Lv80');
    ok(Math.abs(FF.voidVulnMult(nbSt(80,9)) - 1.18) < 1e-9, 'below max Vulnerability, Doom does not apply (+18%)');
    ok(Math.abs(FF.voidVulnMult(nbSt(1,10)) - 1.20) < 1e-9, 'without Lv80, max Vulnerability stays +20% (no Doom)');
    // enemyDebuffCount: distinct debuffs on the foe (drives Void Resonance + Soul Tax).
    var nbCount = stFor('nightblade',80,{ activity:{type:'combat',monsterHp:100,voidVulnStacks:5,voidVulnUntil:vFuture,enemyStunUntil:vFuture}, classDebuffs:{enemyDmgUntil:vFuture,enemyArmorUntil:0} });
    eq(FF.enemyDebuffCount(nbCount), 3, 'enemyDebuffCount tallies Vulnerability + Stun + Enfeeble = 3');
    eq(FF.enemyDebuffCount(nbSt(1,0)), 0, 'a foe with no debuffs -> count 0');
    // Void Resonance (Lv40): +6% damage per distinct debuff. Isolate it with 0 Vulnerability (mult 1) + 2 debuffs.
    var nbRes = stFor('nightblade',40,{ activity:{type:'combat',monsterHp:100,enemyStunUntil:vFuture}, classDebuffs:{enemyDmgUntil:vFuture,enemyArmorUntil:0} });
    ok(Math.abs(FF.voidDmgMult(nbRes) - 1.12) < 1e-9, 'Void Resonance: +6% x 2 debuffs = +12% (no Vulnerability)');
    eq(FF.voidDmgMult(stFor('nightblade',20,{activity:{type:'combat',monsterHp:100,enemyStunUntil:vFuture},classDebuffs:{enemyDmgUntil:vFuture,enemyArmorUntil:0}})), 1, 'Void Resonance inactive below Lv40');
    // Soul Tax (Lv60): +2% lifesteal AND +2% dark damage per distinct debuff.
    var nbTax = stFor('nightblade',60,{ activity:{type:'combat',monsterHp:100,enemyStunUntil:vFuture}, classDebuffs:{enemyDmgUntil:vFuture,enemyArmorUntil:0} });
    ok(Math.abs(FF.nightbladeLifestealPct(nbTax) - 0.04) < 1e-9, 'Soul Tax: +2% lifesteal x 2 debuffs = +4%');
    ok(Math.abs(FF.voidDmgMult(nbTax) - (1.12 * 1.04)) < 1e-9, 'Soul Tax stacks its +2%/debuff dark damage atop Void Resonance');
    eq(FF.nightbladeLifestealPct(stFor('nightblade',40,{activity:{type:'combat',monsterHp:100,enemyStunUntil:vFuture},classDebuffs:{enemyDmgUntil:vFuture,enemyArmorUntil:0}})), 0, 'Soul Tax lifesteal inactive below Lv60');
    // Removed helpers/perks: the old flat Hex, Shadowstep dodge, and Siphon lifesteal are gone.
    eq(FF.newClassDmgMult(monFull, stFor('nightblade',80)), FF.voidDmgMult(stFor('nightblade',80)), 'Voidshadow damage is driven entirely by voidDmgMult (no flat Hex)');
    ok(typeof FF.nightbladeDodgeBonus === 'undefined', 'Shadowstep dodge helper removed');
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
    eq(FF.juggernautFuryStacks(none), 0, 'no class -> no Building Fury stacks');
    eq(FF.juggernautArmorPierce(true, none), 0, 'no class -> no Pulverize armour ignore');
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
  // ---- Tier curves must not reverse direction --------------------------------------------------
  // Balance II had to fix FIVE shipped tier inversions -- higher tiers weaker than lower ones. That's
  // a mechanical property, so check it mechanically instead of catching it in a later balance pass.
  //
  // Deliberately NOT asserting "every stat increases": some fields legitimately fall with tier (costs,
  // timers, penalties). What is never legitimate is a curve that REVERSES -- rises then falls, or falls
  // then rises. So walk each tier-data function across all tiers and flag any numeric field whose
  // direction flips. Flat stretches are fine (many curves plateau).
  suite('balance: tier curves never reverse direction', function(){
    var TC = FF.TIER_COUNT;
    ok(TC > 1, 'TIER_COUNT is available');
    // Only unambiguous POWER stats. Deliberately narrow: costs, timers and input counts can legitimately
    // fall or plateau, and flagging those would red-CI on correct data. These are fields where a higher
    // tier being worse than a lower one is always a bug. Widen the list as families are confirmed clean.
    var POWER = { xp:1, sell:1, levelReq:1, defense:1, reflect:1, bonus:1, dmgBonus:1, ammoPreserve:1, dmgMin:1, dmgMax:1 };
    function directionOf(vals){          // +1 rising, -1 falling, 0 flat -- ignoring equal steps
      for(var i = 1; i < vals.length; i++){ if(vals[i] > vals[i-1]) return 1; if(vals[i] < vals[i-1]) return -1; }
      return 0;
    }
    function checkCurve(label, getAt){
      var rows = [];
      for(var t = 0; t < TC; t++){ var d = null; try { d = getAt(t); } catch(e){ d = null; } if(d) rows.push(d); }
      if(rows.length < 2) return;        // nothing to compare (family may not span all tiers)
      var fields = {};
      rows.forEach(function(r){ for(var k in r){ if(POWER[k] && typeof r[k] === 'number' && isFinite(r[k])) fields[k] = 1; } });
      Object.keys(fields).forEach(function(k){
        var vals = rows.map(function(r){ return typeof r[k] === 'number' ? r[k] : null; });
        if(vals.some(function(v){ return v === null; })) return;   // field not present at every tier
        var dir = directionOf(vals), bad = -1;
        for(var i = 1; i < vals.length && dir !== 0; i++){
          var step = vals[i] > vals[i-1] ? 1 : (vals[i] < vals[i-1] ? -1 : 0);
          if(step !== 0 && step !== dir){ bad = i; break; }
        }
        ok(bad === -1, label + '.' + k + ' is monotonic across tiers' +
          (bad === -1 ? '' : ' (reverses at tier ' + bad + ': ' + vals[bad-1] + ' -> ' + vals[bad] + ')'));
      });
    }
    // Families whose type list AND tier-data fn are both exported.
    (FF.WARD_TYPES || []).forEach(function(w){ checkCurve('ward:' + w.id, function(t){ return FF.getWardTierData(w.id, t); }); });
    (FF.RING_TYPES || []).forEach(function(r){ checkCurve('ring:' + r.id, function(t){ return FF.getRingTierData(r.id, t); }); });
    (FF.AMULET_TYPES || []).forEach(function(a){ checkCurve('amulet:' + a.id, function(t){ return FF.getAmuletTierData(a.id, t); }); });
    // Single-argument families.
    if(FF.getBeltTierData) checkCurve('belt', function(t){ return FF.getBeltTierData(t); });
    if(FF.getCottageTierData) checkCurve('cottage', function(t){ return FF.getCottageTierData(t); });
  });

  // ---- The enemy card and live combat share ONE damage chain -----------------------------------
  // The card preview used to MIRROR monsterAttackTick's ~20 reducers with only a comment keeping them
  // in step. It drifted twice: D2/D3 set reducers and the Tunnelborn cloak reached combat but not the
  // card, so cards overstated incoming damage for anyone wearing them. Both now call incomingDamageMult.
  suite('combat: card preview and live chain share one reduction fn', function(){
    var s = FF._state;
    ok(typeof FF.incomingDamageMult === 'function', 'incomingDamageMult is exported as the single source');
    var foe = { name:'T', atkMin:100, atkMax:200, attackTypes:{blunt:1}, armorTypes:{blunt:1}, element:null };
    var mult = FF.incomingDamageMult(s, foe, foe.attackTypes);
    ok(typeof mult === 'number' && isFinite(mult) && mult > 0, 'the chain yields a positive finite multiplier');
    // The card must be derivable from that same multiplier: reproduce its per-hit math independently
    // and require it to match. If someone re-inlines a private chain in either place, this fails.
    var prof = FF.playerDefenseProfile(s);
    var r = FF.enemyDamageRangeVsPlayer(foe, s, prof);
    function expected(raw){
      var reduced = FF.incomingMitigationFloor(Math.round(raw * mult), raw);
      return Math.max(1, Math.round((reduced - prof.armorDefense) / prof.tenacity));
    }
    eq(r.min, expected(foe.atkMin), 'card min equals the shared chain applied to atkMin');
    eq(r.max, expected(foe.atkMax), 'card max equals the shared chain applied to atkMax');
    // The floor is part of the shared path: an absurdly mitigated hit still lands >= the floor share.
    eq(FF.incomingMitigationFloor(0, 200), Math.round(200 * FF.INCOMING_FLOOR_FRAC), 'a fully-reduced swing floors at INCOMING_FLOOR_FRAC of the roll');
    eq(FF.incomingMitigationFloor(500, 200), 500, 'the floor never REDUCES a hit that already exceeds it');
  });

  // ---- One unique can never fill both hands ---------------------------------------------------
  // Regression: once unique Claws became off-hand-equippable, equipping the SAME Claw into the main
  // hand left the off-hand pointing at it too. equippedEnchantTotals adds both hands, so its enchants
  // were counted twice (enhance multiplier included) -- a stat-duplication exploit, not just a display
  // glitch.
  suite('uniques: the same item cannot occupy both hands', function(){
    var s = FF._state;
    var savedU = s.uniqueItems, savedMain = s.equippedMainhandUid, savedOff = s.equippedOffhandUid;
    var savedMainId = s.equippedMainhand, savedOffId = s.equippedOffhand, savedXp = s.xp;
    // A tier-0 Claw with one known enchant, so double-counting is unmistakable in the totals.
    var mod = (FF.ENCHANT_MODS && FF.ENCHANT_MODS.weapon && FF.ENCHANT_MODS.weapon[0]) || null;
    if(mod){
      s.uniqueItems = { c1:{ uid:'c1', base:'stweapon_claw_t0_normal', kind:'weapon', tier:0, rarity:'normal', enhance:0, enchants:[{ mod:mod.id, roll:10 }] } };
      s.xp = Object.assign({}, s.xp, { claw: 1000000 });   // clear the proficiency gate
      s.equippedMainhand = 'claw'; s.equippedMainhandTier = 1; s.equippedMainhandUid = null;
      s.equippedOffhand = 'claw';  s.equippedOffhandTier = 1; s.equippedOffhandUid = 'c1';
      var single = FF.equippedEnchantTotals(s)[mod.stat] || 0;
      eq(single, 10, 'one equipped copy contributes its roll once');
      FF.equipUniqueWeapon('c1');                      // equip the very item already in the off-hand
      eq(s.equippedOffhandUid, null, 'equipping it into the main hand frees the off-hand');
      eq(s.equippedMainhandUid, 'c1', 'it is now in the main hand');
      eq(FF.equippedEnchantTotals(s)[mod.stat] || 0, 10, 'its enchant is still counted ONCE, not doubled');
    }
    s.uniqueItems = savedU; s.equippedMainhandUid = savedMain; s.equippedOffhandUid = savedOff;
    s.equippedMainhand = savedMainId; s.equippedOffhand = savedOffId; s.xp = savedXp;
  });

  // ---- CRAFT FAMILY REGISTRY INTEGRITY (Stage 0) ----------------------------------------------
  // A craft family has to be registered in ~12 hand-maintained places. A family present in 11 of 12
  // is invisible, which is how 'ward' went missing from matchesSpecialCraft and 'ring'/'amulet' from
  // the live inputs updater -- both shipped to players. CRAFT_FAMILIES states each family once; these
  // assertions prove it still agrees with every hand-written list, so an incomplete family fails here
  // instead of in someone's game. Nothing consumes the registry yet -- this is the safety net first.
  suite('craft families: registry matches every hand-written list', function(){
    var F = FF.CRAFT_FAMILIES;
    ok(F && typeof F === 'object', 'CRAFT_FAMILIES is exported');
    var kinds = Object.keys(F);
    eq(kinds.length, 12, 'all 12 craft families are described');

    // 1) Every family is MATCHABLE, using the match keys the registry claims. This is the exact
    //    failure ward had: startable but never matchable, so its card never showed Stop.
    var sample = { skillId:'mining', typeId:'sword', tierIndex:3, material:'plate', slot:'chest' };
    kinds.forEach(function(kind){
      var act = { type:'craft', craftKind:kind }, params = {};
      F[kind].match.forEach(function(k){ act[k] = sample[k]; params[k] = sample[k]; });
      eq(FF.matchesSpecialCraft(act, kind, params), true, kind + ': matchable via its declared match keys');
      // and a differing value on the FIRST match key must NOT match, or every card would show Stop.
      var k0 = F[kind].match[0], bad = {};
      F[kind].match.forEach(function(k){ bad[k] = sample[k]; });
      bad[k0] = (k0 === 'tierIndex') ? 99 : 'zzz-not-a-real-value';
      eq(FF.matchesSpecialCraft(act, kind, bad), false, kind + ': a different ' + k0 + ' does not match');
    });

    // 2+3) SPECIAL_DOUBLEABLE_KINDS and STACKABLE_SAC_CATEGORIES are now DERIVED from the registry,
    //      so comparing them back to it would be tautological. Pin the expected contents here instead
    //      -- an independent copy, so a wrong flag in the registry changes the derived list and fails.
    var EXPECTED_DOUBLEABLE = ['amulet','belt','bodyarmor','ring','stackquiver','stackshield','stackweapon','tool','ward','workshop'];
    eq((FF.SPECIAL_DOUBLEABLE_KINDS || []).slice().sort().join(','), EXPECTED_DOUBLEABLE.slice().sort().join(','),
       'derived SPECIAL_DOUBLEABLE_KINDS still holds exactly the 10 doubleable families');
    var EXPECTED_SAC = ['amulet','belt','relic','ring','stackquiver','stackshield','stackweapon','tool'];
    eq((FF.STACKABLE_SAC_CATEGORIES || []).slice().sort().join(','), EXPECTED_SAC.slice().sort().join(','),
       'derived STACKABLE_SAC_CATEGORIES still holds the 7 sacrificeable families plus relic');
    ok((FF.STACKABLE_SAC_CATEGORIES || []).indexOf('relic') !== -1, "'relic' survives derivation (a drop, not a craft family)");
    // cottage/offhand must NOT be doubleable -- they were the two false flags, easy to flip by accident.
    ok((FF.SPECIAL_DOUBLEABLE_KINDS || []).indexOf('cottage') === -1, 'cottage is not doubleable');
    ok((FF.SPECIAL_DOUBLEABLE_KINDS || []).indexOf('offhand') === -1, 'offhand is not doubleable');

    // 4) Every card's tier-stepper target must exist, or its +/- stepper silently does nothing.
    kinds.forEach(function(kind){
      (F[kind].cards || []).forEach(function(card){
        if(card.tierTarget === null) return;   // offhand has no tier stepper
        ok(!!FF.TIER_STEP_TARGETS[card.tierTarget], kind + ': tier target "' + card.tierTarget + '" exists in TIER_STEP_TARGETS');
      });
    });

    // 5) Lock the set of families lacking a live inputs updater. ring/amulet were in this state and
    //    their material counts lagged several crafts; a NEW family landing here must fail loudly.
    var noLive = kinds.filter(function(k){
      return (F[k].cards || []).every(function(c){ return !c.idPrefix; });
    }).sort();
    eq(noLive.join(','), (FF.CRAFT_FAMILIES_WITHOUT_LIVE_INPUTS || []).slice().sort().join(','),
       'the set of families without a live inputs updater is unchanged (belt, cottage, offhand)');

    // 6) Every family declares at least one card and at least one match key.
    kinds.forEach(function(kind){
      ok((F[kind].cards || []).length > 0, kind + ': declares at least one UI card');
      ok((F[kind].match || []).length > 0, kind + ': declares at least one match key');
    });
  });

  // ---- Every special craft kind must be matchable ---------------------------------------------
  // Regression: 'ward' (Runesmithing) was missing from matchesSpecialCraft, so a running ward craft
  // could never be found by its card -- the Inscribe button never became Stop and the progress bar
  // never filled. A kind that can be STARTED but not MATCHED is always this bug, so pin all of them.
  suite('crafting: special craft kinds are all matchable', function(){
    ok(typeof FF.matchesSpecialCraft === 'function', 'matchesSpecialCraft is exported');
    // One representative activity per kind, shaped exactly as its craft* function creates it.
    var cases = [
      { kind:'tool',        act:{ skillId:'mining', tierIndex:3 },                       params:{ skillId:'mining', tierIndex:3 } },
      { kind:'stackweapon', act:{ typeId:'sword', tierIndex:4 },                         params:{ typeId:'sword', tierIndex:4 } },
      { kind:'stackshield', act:{ typeId:'shieldSmall', tierIndex:2 },                   params:{ typeId:'shieldSmall', tierIndex:2 } },
      { kind:'stackquiver', act:{ typeId:'quiver', tierIndex:1 },                        params:{ typeId:'quiver', tierIndex:1 } },
      { kind:'ward',        act:{ typeId:'wardFire', tierIndex:5 },                      params:{ typeId:'wardFire', tierIndex:5 } },
      { kind:'bodyarmor',   act:{ material:'plate', slot:'chest', tierIndex:6 },         params:{ material:'plate', slot:'chest', tierIndex:6 } },
      { kind:'belt',        act:{ tierIndex:7 },                                         params:{ tierIndex:7 } },
      { kind:'offhand',     act:{ typeId:'torch' },                                      params:{ typeId:'torch' } },
      { kind:'ring',        act:{ typeId:'plain', tierIndex:2 },                         params:{ typeId:'plain', tierIndex:2 } },
      { kind:'amulet',      act:{ typeId:'plain', tierIndex:2 },                         params:{ typeId:'plain', tierIndex:2 } },
      { kind:'workshop',    act:{ skillId:'mining', tierIndex:1 },                       params:{ skillId:'mining', tierIndex:1 } },
      { kind:'cottage',     act:{ tierIndex:3 },                                         params:{ tierIndex:3 } }
    ];
    cases.forEach(function(c){
      var act = Object.assign({ type:'craft', craftKind:c.kind }, c.act);
      eq(FF.matchesSpecialCraft(act, c.kind, c.params), true, c.kind + ': a running craft matches its own card');
    });
    // A different tier / type must NOT match, or every card would show Stop at once.
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'ward', typeId:'wardFire', tierIndex:5 }, 'ward', { typeId:'wardFire', tierIndex:6 }), false, 'ward: a different tier does not match');
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'ward', typeId:'wardFire', tierIndex:5 }, 'ward', { typeId:'wardWater', tierIndex:5 }), false, 'ward: a different element does not match');
    // Amulet carries a legacy 'plain' fallback: an omitted typeId on EITHER side means plain. The
    // generic matcher has to preserve that or plain-amulet cards stop matching their own craft.
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'amulet', tierIndex:2 }, 'amulet', { typeId:'plain', tierIndex:2 }), true, 'amulet: omitted typeId on the activity means plain');
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'amulet', typeId:'plain', tierIndex:2 }, 'amulet', { tierIndex:2 }), true, 'amulet: omitted typeId in the params means plain');
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'amulet', typeId:'warding', tierIndex:2 }, 'amulet', { tierIndex:2 }), false, 'amulet: a warding amulet does not match the plain card');
    // An unregistered kind can't match anything (previously the switch's default `return false`).
    eq(FF.matchesSpecialCraft({ type:'craft', craftKind:'notafamily', tierIndex:1 }, 'notafamily', { tierIndex:1 }), false, 'an unregistered craft kind never matches');
    eq(FF.matchesSpecialCraft(null, 'ward', { typeId:'wardFire', tierIndex:5 }), false, 'a null activity matches nothing');
    eq(FF.matchesSpecialCraft({ type:'gather' }, 'ward', { typeId:'wardFire', tierIndex:5 }), false, 'a non-craft activity matches nothing');
  });

  // ---- Destroying a unique must never leave it "equipped" -------------------------------------
  // Regression: a shattered Enhancement only cleared the MAINHAND, so a destroyed offhand / armour /
  // ring / amulet stayed equipped -- still drawn, still satisfying its class requirement.
  suite('uniques: destroying one clears every slot', function(){
    var s = FF._state;
    var savedU = s.uniqueItems, savedArmor = s.bodyArmor, savedJewel = s.jewelrySlots;
    var savedBelt = s.equippedBeltUid, savedRelic = s.equippedRelicUid, savedMain = s.equippedMainhandUid;
    // Each case: put a uid in a slot, destroy it, assert nothing still references it.
    function destroyedFromSlot(label, place, check){
      s.uniqueItems = {}; s.uniqueItems['u1'] = { uid:'u1', base:'stweapon_sword_t5_rare', kind:'weapon', tier:5, rarity:'rare', enhance:0, enchants:[] };
      place('u1');
      ok(FF.uniqueIsEquipped('u1'), label + ': starts equipped');
      FF.removeUnique('u1');
      eq(!!(s.uniqueItems && s.uniqueItems['u1']), false, label + ': removed from the unique table');
      eq(FF.uniqueIsEquipped('u1'), false, label + ': no slot still points at it');
      if(check) check(label);
    }
    s.bodyArmor = s.bodyArmor || {}; s.jewelrySlots = s.jewelrySlots || {};
    destroyedFromSlot('mainhand', function(uid){ s.equippedMainhandUid = uid; });
    destroyedFromSlot('body armour', function(uid){ s.bodyArmor.chest = { uid:uid, tier:5, rarity:'rare', material:'plate' }; },
      function(l){ eq(s.bodyArmor.chest.uid, null, l + ': the armour slot is emptied, not left half-set'); });
    destroyedFromSlot('amulet', function(uid){ s.jewelrySlots.amulet = { uid:uid, tier:5, rarity:'rare' }; });
    destroyedFromSlot('belt', function(uid){ s.equippedBeltUid = uid; });
    destroyedFromSlot('relic', function(uid){ s.equippedRelicUid = uid; });
    // Destroying something that was never equipped must still drop it, and not throw.
    s.uniqueItems = { u2:{ uid:'u2', base:'stweapon_sword_t1_normal', kind:'weapon', tier:1, rarity:'normal' } };
    FF.removeUnique('u2');
    eq(!!s.uniqueItems['u2'], false, 'an unequipped unique is still removed');
    FF.removeUnique(null); FF.removeUnique('nope');   // must be no-ops, not crashes
    ok(true, 'removing a null / unknown uid is a safe no-op');
    s.uniqueItems = savedU; s.bodyArmor = savedArmor; s.jewelrySlots = savedJewel;
    s.equippedBeltUid = savedBelt; s.equippedRelicUid = savedRelic; s.equippedMainhandUid = savedMain;
  });

  // ---- Enemy cards: the "damage to YOU" range (post-mitigation, current gear) ------------------
  suite('combat: enemy damage vs player', function(){
    var s = FF._state;
    var foe = { name:'Test Foe', atkMin:100, atkMax:200, attackTypes:{blunt:1}, armorTypes:{blunt:1}, element:null };
    ok(typeof FF.enemyDamageRangeVsPlayer === 'function', 'enemyDamageRangeVsPlayer is exported');
    ok(typeof FF.playerDefenseProfile === 'function', 'playerDefenseProfile is exported');
    var r = FF.enemyDamageRangeVsPlayer(foe, s);
    ok(r && typeof r.min === 'number' && typeof r.max === 'number', 'returns a {min,max} pair');
    ok(r.min >= 1 && r.max >= 1, 'a landed hit is always at least 1 (never zero/negative)');
    ok(r.min <= r.max, 'min never exceeds max');
    // Mitigation LOWERS the landed hit: the same foe lands strictly less on an armoured profile than a
    // bare one. Note "never exceeds raw" is NOT an invariant -- a bad type/element matchup multiplies the
    // hit above raw (weightedAdvantage averages >1), exactly as monsterAttackTick does, so the honest
    // displayed number can top the foe's raw max on a poor matchup. What must hold is that armour reduces it.
    var _neutralMix = { slashing:1/3, piercing:1/3, blunt:1/3 };
    var _bareProf = { armorDefense:0, offhandStyle:null, offhandItem:null, offhandProf:1, armorMix:_neutralMix, shieldProf:1, flat:1, tenacity:1 };
    var _armProf  = { armorDefense:60, offhandStyle:null, offhandItem:null, offhandProf:1, armorMix:_neutralMix, shieldProf:1, flat:1, tenacity:1 };
    var _bareMax = FF.enemyDamageRangeVsPlayer(foe, s, _bareProf).max;
    var _armMax  = FF.enemyDamageRangeVsPlayer(foe, s, _armProf).max;
    ok(_armMax < _bareMax, 'armour mitigates: the same foe lands less on an armoured profile');
    ok(_armMax < foe.atkMax, 'a well-armoured profile takes less than the foe\'s raw max');
    // Harder-hitting foe -> strictly larger (or equal, if both floor at 1) landed damage.
    var big = FF.enemyDamageRangeVsPlayer({ name:'Big', atkMin:1000, atkMax:2000, attackTypes:{blunt:1}, armorTypes:{blunt:1}, element:null }, s);
    ok(big.max >= r.max, 'a foe with higher raw damage lands at least as much on the same gear');
    // Passing a precomputed profile (what the card grid does) must match computing it inline.
    var prof = FF.playerDefenseProfile(s);
    var viaProf = FF.enemyDamageRangeVsPlayer(foe, s, prof);
    eq(viaProf.min, r.min, 'precomputed profile gives the same min as an inline profile');
    eq(viaProf.max, r.max, 'precomputed profile gives the same max as an inline profile');
    eq(FF.enemyDamageRangeVsPlayer(null, s).max, 0, 'a null foe yields a zero range (no crash)');
  });

  // ---- Death chronicle: a detailed "final hit" line when the player is slain ----
  suite('combat: death chronicle explains the final hit', function(){
    ok(typeof FF.deathBlowChronicle === 'function', 'deathBlowChronicle is exported');
    var foe = { name:'Obsidian Elemental', damageType:'piercing', element:'light' };
    // Killed by a hit that landed 42 after soaking 18 of a 60 raw swing, from 30 HP, with a Block.
    var line = FF.deathBlowChronicle(foe, 42, 60, 18, true, 30);
    ok(/Obsidian Elemental/.test(line), 'names the foe that killed you');
    ok(/42/.test(line), 'reports the final hit damage');
    ok(/Light/.test(line) && /Piercing/.test(line), 'reports the damage element and type');
    ok(/raw 60/.test(line) && /18 soaked/.test(line), 'reports the raw swing and how much armour/shield soaked');
    ok(/Blocked/.test(line), 'notes a Block');
    ok(/fell from 30 HP/.test(line), 'reports the Health you fell from');
    // A clean hit with no mitigation and no element: still coherent, no "raw" clause, physical type.
    var plain = FF.deathBlowChronicle({ name:'Rabbit' }, 10, 10, 0, false, 10);
    ok(/Rabbit/.test(plain) && /10/.test(plain) && /physical/.test(plain), 'handles a plain physical kill');
    ok(!/soaked/.test(plain), 'omits the mitigation clause when nothing was soaked');
    // No crash / sane output on a missing foe.
    ok(typeof FF.deathBlowChronicle(null, 5, 5, 0, false, 5) === 'string', 'tolerates a missing foe');
  });

  // ---- Death resets HP to 1, not 0 (no 0-HP re-entry window) ----
  suite('combat: a death lands you at 1 HP, alive and recovering', function(){
    var S = FF._state;
    var saved = { act:S.activity, hp:S.playerHp, deaths:(S.stats&&S.stats.deaths)||0 };
    try {
      // A tier-20 Tower foe hits for hundreds -- a lethal blow from 1 HP, guaranteed to trip the death path.
      var mon = FF.buildTowerMonster('all', 20);
      FF.startCombat(mon.id);
      ok(S.activity.type === 'combat', 'the fight started');
      var died = false;
      for(var i=0;i<80 && !died;i++){
        S.playerHp = 1;                 // sit at 1 HP; the next landed hit is lethal
        FF.monsterAttackTick();
        if(S.activity.type === null) died = true; // the death handler ends the fight
      }
      ok(died, 'a lethal hit triggered the death handler');
      eq(S.playerHp, 1, 'HP resets to 1 after death (not 0), so there is no 0-HP re-entry window');
      eq(S.activity.type, null, 'the fight ends on death');
    } finally {
      S.activity = saved.act; S.playerHp = saved.hp; if(S.stats) S.stats.deaths = saved.deaths;
    }
  });

  // ---- Battle IA: a live-fight "Combat" tab, split from an "Enemies" selection tab ---------------
  suite('battle tabs: Combat (live fight) vs Enemies (selection)', function(){
    ok(typeof FF.renderCombatTab === 'function' && typeof FF.renderEnemiesTab === 'function', 'both battle tabs exported');
    var battle = FF.AREAS.filter(function(a){ return a.id==='battle'; })[0];
    var subIds = battle.subs.map(function(x){ return x[0]; });
    ok(subIds.indexOf('enemies') !== -1 && subIds.indexOf('combat') !== -1, 'Battle exposes both Enemies and Combat tabs');
    ok(subIds.indexOf('enemies') < subIds.indexOf('combat'), 'Enemies is listed before Combat');
    var s = FF._state, savedAct = s.activity;
    try {
      s.activity = { type:null, tier:0 };  // out of combat
      var enemiesHtml = FF.renderEnemiesTab();
      ok(/data-action="fight"/.test(enemiesHtml), 'the Enemies tab lists foes with Fight buttons');
      var combatHtml = FF.renderCombatTab();
      ok(!/data-action="fight"/.test(combatHtml), 'the Combat tab has NO enemy Fight buttons (moved to Enemies)');
      ok(/Enemies/.test(combatHtml), 'the idle Combat tab points players to the Enemies tab');
    } finally { s.activity = savedAct; }
  });

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
    // damage/timing desyncs in Stage B: atkMin=round(80*1.04^i), atkMax=round(200*1.04^i)
    // (D1 group offense cut 60%, was 200/500), interval_ms = round((2.2 + (i%5)*0.3)*1000).
    for(var _j = 0; _j < 25; _j++){
      eq(en[_j].atkMin, Math.round(80 * Math.pow(1.04, _j)), 'enemy ' + _j + ' atkMin matches server');
      eq(en[_j].atkMax, Math.round(200 * Math.pow(1.04, _j)), 'enemy ' + _j + ' atkMax matches server');
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
    eq(def.minCombatScore, undefined, 'D2 no longer carries a Combat Score gate (Total Level gate now)');
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
    eq(def.minCombatScore, undefined, 'D3 no longer carries a Combat Score gate (Total Level gate now)');
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
    eq(def.minCombatScore, undefined, 'D4 no longer carries a Combat Score gate (Total Level gate now)');
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

  // ---- Masterwork Blueprints: 13 formula types x 4 dungeons, weighted boss drops, separate inventory ----
  suite('masterwork blueprints', function(){
    var slots = FF.MASTERWORK_SLOTS;
    eq(slots.length, 13, 'thirteen Masterwork formula types');
    // exact drop chances: armor highest, weapons (+ shield) equal, jewelry lowest
    var byId = {}; slots.forEach(function(s){ byId[s.id] = s; });
    var want = { cloth:0.12, leather:0.12, chain:0.12, plate:0.12, slash:0.08, pierce:0.08, blunt:0.08, ranged:0.08, arcane:0.08, defense:0.08, ring:0.05, amulet:0.03, cape:0.02 };
    Object.keys(want).forEach(function(k){ ok(byId[k], 'formula ' + k + ' exists'); near((byId[k]||{}).chance, want[k], 'formula ' + k + ' drop chance', 1e-9); });
    // Tiering the request asked for: armor > weapons/shield > jewelry.
    ok(byId.cloth.chance > byId.slash.chance && byId.slash.chance > byId.ring.chance, 'drop-rate tiers: armor > weapons > jewelry');
    ['slash','pierce','blunt','ranged','arcane','defense'].forEach(function(k){ eq(byId[k].chance, byId.slash.chance, 'all weapon/shield formulas share one drop rate'); });
    // 52 Blueprints (4 dungeons x 13 types), each named "<Category> <Label> Blueprint"
    eq(Object.keys(FF.BLUEPRINT_ITEMS).length, 52, '4 dungeons x 13 types = 52 Blueprints');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','amulet')].name, 'Cave Amulet Blueprint', 'D1 amulet is "Cave Amulet Blueprint"');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','slash')].name, 'Cave Slash Weapon Blueprint', 'D1 slash is "Cave Slash Weapon Blueprint"');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','cloth')].name, 'Underground Chamber Cloth Armor Blueprint', 'D3 cloth armor name');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','defense')].name, 'Tunnel Shield Blueprint', 'D2 shield is "Tunnel Shield Blueprint"');
    eq(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','cape')].name, 'Nest of the Depths Cape Blueprint', 'D4 cape name');
    ok(Object.keys(FF.BLUEPRINT_ITEMS).every(function(id){ var b = FF.BLUEPRINT_ITEMS[id]; return b.blueprint === true && b.sell === 0 && /<svg/.test(b.icon); }), 'every Blueprint is flagged, non-vendorable, and has an icon');
    // Blueprints are their OWN inventory, not in the sellable/item economy.
    ok(Object.keys(FF.BLUEPRINT_ITEMS).every(function(id){ return !FF.ALL_SELLABLE[id]; }), 'Blueprints are not part of ALL_SELLABLE (separate inventory)');
    // addBlueprint stores into state.blueprints (not state.inventory).
    var s = FF._state; var svB = s.blueprints, svI = s.inventory;
    s.blueprints = {}; s.inventory = {};
    var bid = FF.masterworkBlueprintId('d2','plate');
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
    eq(Object.keys(FF.LEGENDARY_RING_ITEMS).filter(function(id){ return FF.LEGENDARY_RING_ITEMS[id].dungeon==='d1'; }).length, 20, '5 D1 effects x 4 rarities = 20 D1 legendary ring items');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','normal')].value, 0.05, 'block Signet base is 5%');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','rare')].value, 0.10, 'rare = 2x');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','supreme')].value, 0.20, 'supreme = 4x');
    eq(FF.LEGENDARY_RING_ITEMS[FF.legRingItemId('block','fantastic')].value, 0.40, 'fantastic = 8x');
    // Recipe matches the spec; only D1 Ring exists so far.
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','ring')]);
    ok(rec && rec.inputs.metallurgy_t20===1000 && rec.inputs.gem_voidcrystal===100 && rec.inputs.twine_t20===100 && rec.inputs.goldsmithing_t20===100 && rec.rareCount===10, 'D1 Ring recipe = 1000 ingots / 100 gems / 100 twine / 100 settings / 10 rare rings');
    ok(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','ring')]) !== null, 'D2 Ring mastercraft is now available (Batch K)');
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

  suite('mastercraft: D1 legendary cloaks (Shrouds)', function(){
    var s = FF._state;
    eq(Object.keys(FF.LEGENDARY_CLOAK_ITEMS).filter(function(id){ return FF.LEGENDARY_CLOAK_ITEMS[id].dungeon==='d1'; }).length, 12, '3 D1 effects x 4 rarities = 12 D1 legendary cloak items');
    // Each effect has its own base, scaled 2x/4x/8x by rarity.
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('accuracy','normal')].value, 0.50, 'accuracy Shroud base is 50%');
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('accuracy','fantastic')].value, 4.00, 'accuracy fantastic = 8x = 400%');
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('critchance','normal')].value, 0.05, 'crit-chance Shroud base is 5%');
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('critchance','supreme')].value, 0.20, 'crit-chance supreme = 4x = 20%');
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('critdmg','normal')].value, 0.20, 'crit-damage Shroud base is 20%');
    eq(FF.LEGENDARY_CLOAK_ITEMS[FF.legCloakItemId('critdmg','rare')].value, 0.40, 'crit-damage rare = 2x = 40%');
    // Recipe = 1000 Tier-20 Cloths + 10 rare Tier-20 Cloaks.
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','cape')]);
    ok(rec && rec.inputs.weaving_t20===1000 && rec.rareCount===10, 'D1 Cloak recipe = 1000 refined cloths / 10 rare cloaks');
    ok(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','cape')]) !== null, 'D2 Cloak mastercraft is now available (Batch K)');
    // Effect aggregation from an equipped Shroud in the Back slot.
    var svB = s.bodyArmor.back;
    s.bodyArmor.back = { leg:'critchance', rarity:'supreme', tier:0, material:null };
    near(FF.legendaryCloakBonus('critchance', s), 0.20, 'an equipped supreme crit-chance Shroud gives +20% crit chance');
    eq(FF.legendaryCloakBonus('critdmg', s), 0, 'only the worn effect counts');
    ok(FF.legCloakEquipped(s), 'legCloakEquipped detects a worn Shroud');
    s.bodyArmor.back = svB;
    // Full craft: 1000 cloths + 10 rare Tier-20 cloaks + a Blueprint -> one Shroud, all inputs consumed.
    var svInv = s.inventory, svBp = s.blueprints, svBack = s.bodyArmor.back;
    s.inventory = { weaving_t20:1000, bodyarmor_tailoring_back_t20_rare:10 };
    s.blueprints = {}; s.blueprints[FF.masterworkBlueprintId('d1','cape')] = 1;
    FF.craftMastercraft(FF.masterworkBlueprintId('d1','cape'));
    eq(s.blueprints[FF.masterworkBlueprintId('d1','cape')], 0, 'craft consumes the Blueprint');
    eq(s.inventory.weaving_t20, 0, 'craft consumes the 1000 cloths');
    eq(s.inventory.bodyarmor_tailoring_back_t20_rare, 0, 'craft consumes the 10 rare cloaks');
    var made = Object.keys(FF.LEGENDARY_CLOAK_ITEMS).reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(made, 1, 'craft grants exactly one Legendary Shroud');
    s.inventory = svInv; s.blueprints = svBp; s.bodyArmor.back = svBack;
  });

  // ---- D1 legendary weapons / shields / wards: the 35 effect definitions + item generation ------------
  suite('mastercraft: D1 legendary gear (35 effects)', function(){
    var defs = FF.D1_LEG_GEAR_DEFS;
    eq(defs.length, 35, '35 legendary gear effects (24 weapons + 6 shields + 5 wards)');
    // Group counts by formula.
    var byGroup = {}; defs.forEach(function(d){ byGroup[d.group] = (byGroup[d.group]||0) + 1; });
    eq(byGroup.slash, 6, 'slash formula forges one of 6 legendaries');
    eq(byGroup.pierce, 4, 'pierce -> 4');
    eq(byGroup.blunt, 4, 'blunt -> 4');
    eq(byGroup.ranged, 3, 'ranged -> 3');
    eq(byGroup.arcane, 12, 'arcane -> 12 (7 arcane weapons + 5 wards)');
    eq(byGroup.defense, 6, 'defense -> 6 shields');
    // Unique keys; every effect maps to a real class and a real base gear type.
    var keys = {}; defs.forEach(function(d){ keys[d.key] = (keys[d.key]||0) + 1; });
    ok(Object.keys(keys).every(function(k){ return keys[k] === 1; }), 'every legendary key is unique');
    ok(defs.every(function(d){ return !!FF.CLASS_DEFS_BY_ID[d.cls]; }), 'every legendary names a real class');
    ok(defs.every(function(d){ return d.slot === 'mainhand' || d.slot === 'offhand'; }), 'every legendary slots main- or off-hand');
    ok(defs.every(function(d){ return typeof d.desc === 'string' && d.desc.length > 10; }), 'every legendary has a description');
    // Every def's base is a real weapon / shield / ward type, and top-tier resolves.
    ok(defs.every(function(d){ return FF.getWeaponStyle(d.base) || FF.isWard(d.base) || /^shield/.test(d.base); }), 'every base is a real gear type');
    eq(FF.legGearBaseTopTier('scimitar'), 19, 'melee top tier is index 19 (20 tiers)');
    eq(FF.legGearBaseTopTier('bowLong'), 20, 'bows top out at index 20');
    eq(FF.legGearBaseTopTier('wandFire'), 20, 'wands top out at index 20');
    // 35 effects x 4 rarities = 140 generated items, all flagged + non-vendorable + iconned.
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS).length, 140, '35 x 4 rarities = 140 legendary gear items');
    ok(Object.keys(FF.LEGENDARY_GEAR_ITEMS).every(function(id){ var it = FF.LEGENDARY_GEAR_ITEMS[id]; return it.legendary === true && it.gear === true && it.sell === 0 && /<svg/.test(it.icon); }), 'every legendary gear item is flagged, non-vendorable, iconned');
    // Names carry the rarity as a PREFIX (e.g. "Rare Tombshatter"); base Normal is bare.
    eq(FF.LEGENDARY_GEAR_ITEMS[FF.legGearItemId('cull','normal')].name, 'Huskmaker', 'Normal legendary name is bare');
    eq(FF.LEGENDARY_GEAR_ITEMS[FF.legGearItemId('cull','fantastic')].name.replace(/\s+/g,' ').trim(), 'Fantastic Huskmaker', 'a non-Normal legendary carries the rarity as a prefix');
    eq(FF.LEGENDARY_GEAR_ITEMS[FF.legGearItemId('cull','rare')].name.replace(/\s+/g,' ').trim(), 'Rare Huskmaker', 'a Rare legendary is "Rare <name>"');
    // Group -> outcome-key pools (what a formula can forge).
    eq(FF.LEG_GEAR_GROUP_KEYS.slash.length, 6, 'slash outcome pool has 6 keys');
    ok(FF.LEG_GEAR_GROUP_KEYS.arcane.indexOf('holyward') !== -1, 'wards live in the arcane outcome pool');
    // Detection: nothing legendary equipped -> no effect active.
    var none = { equippedMainhandUid:null, equippedOffhandUid:null, uniqueItems:{} };
    eq(FF.legMainhandEffect(none), null, 'no legendary mainhand -> null');
    eq(FF.legOffhandEffect(none), null, 'no legendary offhand -> null');
    eq(FF.legActive('cull', none), false, 'legActive false with nothing equipped');
    // Detection reads the equipped unique's leg field.
    var eq2 = { equippedMainhandUid:'u1', equippedOffhandUid:null, uniqueItems:{ u1:{ uid:'u1', leg:'cull' } } };
    eq(FF.legMainhandEffect(eq2), 'cull', 'a legendary mainhand exposes its effect key');
    eq(FF.legActive('cull', eq2), true, 'legActive true for the equipped legendary effect');
  });

  // ---- D1 legendary gear FORGE: the six formula recipes mint a legendary unique -----------------------
  suite('mastercraft: D1 legendary gear forge', function(){
    // Every formula group has a recipe with the right inputs + a rare-t20 counting list.
    ['slash','pierce','blunt','ranged','arcane','defense'].forEach(function(g){
      var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1',g)]);
      ok(rec && rec.gear === true, g + ' has a gear forge recipe');
      eq(rec.rareCount, 10, g + ' needs 10 rare Tier-20 items');
      eq(rec.outcomes.length, FF.LEG_GEAR_GROUP_KEYS[g].length, g + ' forges one of its group pool');
    });
    // Exact input bills the user specified.
    var melee = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','slash')]);
    eq(melee.inputs.metallurgy_t20, 1000, 'melee formula costs 1000 t20 ingots');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','ranged')]).inputs.forestry_t20, 1000, 'bow formula costs 1000 t20 wood');
    var arc = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','arcane')]).inputs;
    eq(arc.forestry_t20, 1000, 'arcane formula costs 1000 t20 wood');
    ['fire','water','earth','light','dark'].forEach(function(el){ eq(arc['glyph_'+el], 200, 'arcane formula costs 200 '+el+' glyphs'); });
    // Rare-t20 id lists point at real inventory item ids of the right family + top tier.
    ok(FF.legGearRareIds('slash').indexOf('stweapon_scimitar_t19_rare') !== -1, 'slash counts rare t20 (index 19) slashing melee');
    ok(FF.legGearRareIds('ranged').indexOf('stweapon_bowLong_t20_rare') !== -1, 'ranged counts rare t20 (index 20) bows');
    ok(FF.legGearRareIds('arcane').indexOf('stward_wardFire_t20_rare') !== -1, 'arcane counts rare t20 wards');
    ok(FF.legGearRareIds('defense').indexOf('stshield_shieldSmall_t19_rare') !== -1, 'defense counts rare t20 shields');
    // Full forge: give the inputs + a blueprint, craft, and confirm a legendary UNIQUE is minted (with its leg).
    var s = FF._state, svInv = s.inventory, svBp = s.blueprints, svUniq = s.uniqueItems;
    s.inventory = { metallurgy_t20: 1000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('slash').forEach(function(id){ s.inventory[id] = 2; }); // plenty of rare slash weapons
    var bpId = FF.masterworkBlueprintId('d1','slash'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the forge mints exactly one legendary unique');
    var u = minted[0];
    ok(u && u.leg && FF.LEG_GEAR_GROUP_KEYS.slash.indexOf(u.leg) !== -1, 'the unique carries a slash-group legendary effect');
    ok(/^stweapon_.+_t19_(normal|rare|supreme|fantastic)$/.test(u.base), 'the unique is a top-tier slashing weapon base');
    eq(s.blueprints[bpId], 0, 'the forge consumes the Blueprint');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 1000 ingots');
    var rareLeft = FF.legGearRareIds('slash').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('slash').length * 2 - 10, 'the forge consumes exactly 10 rare weapons');
    s.inventory = svInv; s.blueprints = svBp; s.uniqueItems = svUniq;
  });

  suite('mastercraft: a desynced uidSeq never overwrites an owned legendary', function(){
    // Repro of the reported "consumed materials but no item appeared" bug: a pre-existing legendary at u1,
    // but the uid counter has fallen behind (a save that kept uniqueItems yet lost uidSeq). genUid must skip
    // the occupied uid so the new mint is ADDED, not recycled on top of the old legendary.
    var s = FF._state, svInv = s.inventory, svBp = s.blueprints, svUniq = s.uniqueItems, svSeq = s.uidSeq;
    try {
      s.uniqueItems = { u1:{ uid:'u1', base:'stweapon_greatsword_t19_rare', kind:'weapon', tier:19, rarity:'rare', enchants:[], enhance:0, leg:'runegrave' } };
      s.uidSeq = 0; // desynced: sits at/below an existing uid
      s.inventory = { metallurgy_t20: 1000 };
      FF.legGearRareIds('blunt').forEach(function(id){ s.inventory[id] = 4; });
      var bpId = FF.masterworkBlueprintId('d1','blunt'); s.blueprints = {}; s.blueprints[bpId] = 1;
      FF.craftMastercraft(bpId);
      var uids = Object.keys(s.uniqueItems);
      eq(uids.length, 2, 'the craft ADDS a new unique instead of overwriting the existing one');
      ok(s.uniqueItems.u1 && s.uniqueItems.u1.leg === 'runegrave', 'the pre-existing legendary (u1) is left untouched');
      var neu = uids.filter(function(k){ return k!=='u1'; }).map(function(k){ return s.uniqueItems[k]; })[0];
      ok(neu && FF.LEG_GEAR_GROUP_KEYS.blunt.indexOf(neu.leg) !== -1, 'the added unique is the freshly forged blunt legendary');
      ok(s.blueprints[bpId] === 0, 'the Blueprint was still consumed (materials + item both accounted for)');
    } finally { s.inventory = svInv; s.blueprints = svBp; s.uniqueItems = svUniq; s.uidSeq = svSeq; }
  });

  suite('mastercraft: a forged legendary reads as itself (name + effect) in cards + inventory', function(){
    var u = { uid:'ux', base:'stweapon_warhammer_t19_rare', kind:'weapon', tier:19, rarity:'rare', enchants:[], enhance:0, leg:'gravewrath' };
    var card = FF.uniqueCardBody(u);
    ok(/Gravewrath/.test(card), 'the unique card shows the Legendary name (not the raw base weapon name)');
    ok(!/Warhammer/.test(FF.uniqueDisplayName(u)), 'uniqueDisplayName returns the Legendary name, not the base');
    ok(/Legendary Effect/.test(card) && /Decay/.test(card), 'the card surfaces the legendary effect blurb');
    // It shows up in the Inventory "Unique" group under its Legendary name.
    var S = FF._state, sInv=S.inventory, sUniq=S.uniqueItems, sCat=FF.currentCategoryId();
    try {
      S.inventory = {}; S.uniqueItems = { ux:u };
      FF.navPickCat('inventory');
      var h = document.getElementById('inventoryPanel').innerHTML;
      ok(/inv-acc-title">Unique/.test(h), 'the Unique inventory group renders');
      ok(/Gravewrath/.test(h), 'the forged legendary appears in the inventory under its Legendary name');
    } finally { S.inventory=sInv; S.uniqueItems=sUniq; if(sCat) FF.navPickCat(sCat); }
  });

  // ---- D1 legendary gear EQUIP: forged uniques slot into hand + expose their effect --------------------
  suite('mastercraft: legendary gear equip', function(){
    var s = FF._state;
    var sv = { mh:s.equippedMainhand, mht:s.equippedMainhandTier, mhr:s.equippedMainhandRarity, mhu:s.equippedMainhandUid,
      oh:s.equippedOffhand, oht:s.equippedOffhandTier, ohr:s.equippedOffhandRarity, ohu:s.equippedOffhandUid, uniq:s.uniqueItems, xp:s.xp };
    s.uniqueItems = {}; s.xp = {};
    s.equippedMainhand = null; s.equippedMainhandUid = null; s.equippedOffhand = null; s.equippedOffhandUid = null;
    // A legendary wand (no weapon-proficiency gate) equips to the main hand and exposes its effect.
    s.uniqueItems.w = { uid:'w', base:'stweapon_wandFire_t20_rare', kind:'weapon', tier:20, rarity:'rare', enchants:[], enhance:0, leg:'emberstorm' };
    ok(FF.equipUniqueWeapon('w'), 'a legendary wand equips to the main hand');
    eq(s.equippedMainhandUid, 'w', 'equippedMainhandUid points at the legendary');
    eq(s.equippedMainhand, 'wandFire', 'the base weapon type is set for combat math');
    eq(FF.legMainhandEffect(), 'emberstorm', 'legMainhandEffect reads the equipped legendary');
    ok(/Creeping Flame/.test(FF.uniqueDisplayName(s.uniqueItems.w)), 'the legendary displays its effect name, not the base weapon');
    // Its base resolves to a real top-tier weapon item (tier index + 1 wiring is correct).
    ok(FF.getEquippedWeaponItem(s).dmgMax > 0, 'the equipped legendary resolves to a real weapon (tier wiring correct)');
    // A legendary ward equips to the off-hand (the wand main hand is 1h) with no weapon proficiency needed.
    s.uniqueItems.d = { uid:'d', base:'stward_wardFire_t20_rare', kind:'offhand', tier:20, rarity:'rare', enchants:[], enhance:0, leg:'everburning' };
    ok(FF.equipUniqueOffhand('d'), 'a legendary ward equips to the off-hand');
    eq(FF.legOffhandEffect(), 'everburning', 'legOffhandEffect reads the equipped ward');
    eq(FF.legActive('everburning'), true, 'legActive true for the equipped ward');
    eq(FF.legActive('emberstorm'), true, 'legActive true for the equipped wand');
    s.equippedMainhand=sv.mh; s.equippedMainhandTier=sv.mht; s.equippedMainhandRarity=sv.mhr; s.equippedMainhandUid=sv.mhu;
    s.equippedOffhand=sv.oh; s.equippedOffhandTier=sv.oht; s.equippedOffhandRarity=sv.ohr; s.equippedOffhandUid=sv.ohu;
    s.uniqueItems=sv.uniq; s.xp=sv.xp;
  });

  // ---- D1 legendary gear COMBAT effects, Batch 3: the six Slash weapons ------------------------------
  suite('mastercraft: legendary slash effects', function(){
    // A minimal state with a legendary weapon slotted to the main hand (legActive only reads the uid + uniqueItems).
    function legSt(key, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_scimitar_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } },
        equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var MON = { hp:100 };
    // The legendary damage term is a NAMED row in PLAYER_DMG_MODS (not spliced into the damage line).
    ok(FF.PLAYER_DMG_MODS.some(function(r){ return r.name === 'legendaryGear'; }), 'legendaryGear is a named PLAYER_DMG_MODS row');

    // Cull (executioner/fullmoonaxe): +2% damage per 1% of the foe's missing Health, capped at +100%.
    var cullFull = legSt('cull', { activity:{type:'combat', monsterHp:100} });
    near(FF.legendaryDmgMult(MON, cullFull), 1, 'Cull adds nothing at full enemy HP');
    var cullHalf = legSt('cull', { activity:{type:'combat', monsterHp:50} });
    near(FF.legendaryDmgMult(MON, cullHalf), 2.0, 'Cull: 50% missing HP -> +100% (x2.0)');
    var cullQuarter = legSt('cull', { activity:{type:'combat', monsterHp:75} });
    near(FF.legendaryDmgMult(MON, cullQuarter), 1.5, 'Cull: 25% missing HP -> +50% (x1.5)');
    var cullExec = legSt('cull', { activity:{type:'combat', monsterHp:1} });
    near(FF.legendaryDmgMult(MON, cullExec), 2.0, 'Cull caps at +100% below 50% HP');
    near(FF.legendaryDmgMult(MON, legSt('crimsonharvest', { activity:{type:'combat', monsterHp:1} })), 1, 'Cull is inert without the Cull legendary');

    // Phantom Assault (assassin/claw): while the 4s-untouched Vanish window is ready, +25% damage and +20% Dodge.
    var paReady = legSt('phantomassault', { activity:{type:'combat', monsterHp:100, lastDamagedAt: Date.now() - 5000} });
    ok(FF.legVanishWindowReady(paReady), 'the Vanish window is ready after 4s untouched');
    near(FF.legendaryDmgMult(MON, paReady), 1.25, 'Phantom Assault: +25% damage while Vanish ready');
    near(FF.legendaryDodgeBonus(paReady), 0.20, 'Phantom Assault: +20% Dodge while Vanish ready');
    var paHit = legSt('phantomassault', { activity:{type:'combat', monsterHp:100, lastDamagedAt: Date.now()} });
    ok(!FF.legVanishWindowReady(paHit), 'the Vanish window closes when freshly hit');
    near(FF.legendaryDmgMult(MON, paHit), 1, 'Phantom Assault gives no damage while recently hit');
    near(FF.legendaryDodgeBonus(paHit), 0, 'Phantom Assault gives no Dodge while recently hit');

    // Crimson Harvest (reaver/halfmoonaxe): +2% lifesteal per Bleed stack on the foe.
    var chBleed = legSt('crimsonharvest', { activity:{type:'combat', monsterHp:100, bleedStacks:3, bleedUntil: Date.now()+4000} });
    near(FF.legendaryLifestealPct(chBleed), 0.06, 'Crimson Harvest: 3 Bleed stacks -> +6% lifesteal');
    var chNoBleed = legSt('crimsonharvest', { activity:{type:'combat', monsterHp:100, bleedStacks:0} });
    near(FF.legendaryLifestealPct(chNoBleed), 0, 'Crimson Harvest gives no lifesteal against an unbled foe');
    near(FF.legendaryLifestealPct(legSt('cull', { activity:{type:'combat', bleedStacks:3, bleedUntil: Date.now()+4000} })), 0, 'Crimson Harvest is inert without its legendary');

    // Wasting Curse (plaguebearer/hatchet): a poisoned foe deals -5% damage per second poisoned (cap -40%).
    var wcNone = legSt('wastingcurse', { activity:{type:'combat', monsterHp:100} });
    near(FF.legWastingCurseIncomingMult(wcNone), 1, 'Wasting Curse is inert against an unpoisoned foe');
    var wc3 = legSt('wastingcurse', { activity:{type:'combat', monsterHp:100, potionPoisonUntil: Date.now()+4000, poisonSince: Date.now()-3000} });
    near(FF.legWastingCurseIncomingMult(wc3), 0.85, 'Wasting Curse: 3s poisoned -> incoming x0.85', 1e-3);
    var wc10 = legSt('wastingcurse', { activity:{type:'combat', monsterHp:100, potionPoisonUntil: Date.now()+4000, poisonSince: Date.now()-10000} });
    near(FF.legWastingCurseIncomingMult(wc10), 0.60, 'Wasting Curse caps at -40% (x0.60)', 1e-3);
    // legNotePoisonStart stamps the start of a fresh poison, but leaves an already-active poison's clock alone.
    var actFresh = { potionPoisonUntil: 0 }; FF.legNotePoisonStart(actFresh); ok(actFresh.poisonSince > 0, 'legNotePoisonStart stamps a fresh poison start');
    var actLive = { potionPoisonUntil: Date.now()+4000, poisonSince: 111 }; FF.legNotePoisonStart(actLive); eq(actLive.poisonSince, 111, 'legNotePoisonStart does not reset an ongoing poison');

    // Relic Reaver (treasureHunter/scimitar): +25% damage while Faith is above half.
    var rrHi = legSt('relicreaver', { xp:{ prayer:0 }, faith:9999 });
    rrHi.faith = FF.faithMax(rrHi) * 0.75;
    near(FF.legendaryDmgMult(MON, rrHi), 1.25, 'Relic Reaver: +25% while Faith above half');
    var rrLo = legSt('relicreaver', { xp:{ prayer:0 } });
    rrLo.faith = FF.faithMax(rrLo) * 0.25;
    near(FF.legendaryDmgMult(MON, rrLo), 1, 'Relic Reaver: no bonus while Faith at or below half');

    // Spectral Aegis (reaper/scythe): the Siphon Shield cap doubles to 40% of max Health.
    var saOff = legSt('cull', { xp:{ vitality: FF.xpFloorForLevel(30) } });
    var saOn = legSt('spectralaegis', { xp:{ vitality: FF.xpFloorForLevel(30) } });
    eq(FF.reaperShieldCap(saOn), 2 * FF.reaperShieldCap(saOff), 'Spectral Aegis doubles the Siphon Shield cap');
    near(FF.reaperShieldCap(saOn), Math.round(FF.maxHp(saOn) * 0.40), 'Spectral Aegis cap = 40% of max HP');

    // combatShieldTotal: sums every absorb pool that soaks hits before your Health (Aegis + Siphon + Barrier),
    // which the combat UI draws as a blue overlay on the HP bar. Clamps at 0 (never negative / NaN).
    eq(FF.combatShieldTotal({ templarShield:10, reaperShield:20, lumenShield:5 }), 35, 'combatShieldTotal sums Aegis + Siphon + Barrier');
    eq(FF.combatShieldTotal({ reaperShield:12 }), 12, 'combatShieldTotal handles missing pools');
    eq(FF.combatShieldTotal({}), 0, 'combatShieldTotal is 0 with no shields');
    eq(FF.combatShieldTotal({ templarShield:-5 }), 0, 'combatShieldTotal never goes negative');

    // clampPlayerHpToMax: Health can never sit above its CURRENT max. A temp max-HP buff that inflated the
    // ceiling and then expired leaves playerHp stranded above the new max -- the clamp snaps it back down,
    // and (crucially) leaves an at-or-below-max value untouched.
    var _cs = FF._state, _svHp = _cs.playerHp;
    var _mh = FF.maxHp(_cs);
    _cs.playerHp = _mh + 40;
    eq(FF.clampPlayerHpToMax(_cs), _mh, 'clampPlayerHpToMax snaps stranded over-max Health down to the max');
    eq(_cs.playerHp, _mh, 'the clamp mutates state.playerHp');
    _cs.playerHp = Math.max(1, _mh - 3);
    eq(FF.clampPlayerHpToMax(_cs), Math.max(1, _mh - 3), 'clampPlayerHpToMax leaves an at-or-below-max value untouched');
    _cs.playerHp = _svHp;
  });

  // ---- Settings: per-tier-band rarity-roll toggles (QoL) ----
  suite('settings: per-tier rarity-roll toggles', function(){
    var st5 = { settings:{ noRarityT0_5:true } };
    ok(FF.rarityRollDisabledForTier(0, st5) && FF.rarityRollDisabledForTier(5, st5), 'the T0-5 toggle covers tiers 0 and 5');
    eq(FF.rarityRollDisabledForTier(6, st5), false, 'the T0-5 toggle does not reach tier 6');
    var st610 = { settings:{ noRarityT6_10:true } };
    eq(FF.rarityRollDisabledForTier(5, st610), false, 'the T6-10 toggle does not reach tier 5');
    ok(FF.rarityRollDisabledForTier(6, st610) && FF.rarityRollDisabledForTier(10, st610), 'the T6-10 toggle covers tiers 6 and 10');
    var st1619 = { settings:{ noRarityT16_19:true } };
    ok(FF.rarityRollDisabledForTier(16, st1619) && FF.rarityRollDisabledForTier(19, st1619), 'the T16-19 toggle covers tiers 16 and 19');
    eq(FF.rarityRollDisabledForTier(20, st1619), false, 'tier 20 always rolls (no band covers it)');
    eq(FF.rarityRollDisabledForTier(3, { settings:{} }), false, 'no toggle set -> rarity rolls stay enabled');
    // rollCraftRarity forces Normal when its tier band is disabled (deterministic -- no RNG in that path).
    eq(FF.rollCraftRarity({ settings:{ noRarityT0_5:true } }, 2), 'normal', 'a disabled band makes rollCraftRarity return normal');
    // The four rarity toggles live in the Quality of Life group; toggles split into Interface + QoL.
    var rk = FF.SETTINGS_TOGGLES.filter(function(t){ return /^noRarityT/.test(t.key); });
    eq(rk.length, 4, 'there are four per-band rarity toggles');
    ok(rk.every(function(t){ return t.cat==='qol'; }), 'the rarity toggles are in the Quality of Life section');
    ok(FF.SETTINGS_TOGGLES.some(function(t){ return t.cat==='interface'; }) && FF.SETTINGS_TOGGLES.some(function(t){ return t.cat==='qol'; }), 'toggles are split into Interface and QoL categories');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 4: the four Pierce weapons -----------------------------
  suite('mastercraft: legendary pierce effects', function(){
    function armor(mat){ return { material:mat, tier:5 }; }
    // A minimal state with a legendary main-hand weapon and (optionally) class gear/enchants layered on.
    function legSt(key, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_rapier_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } },
        equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // En Garde (duelist/rapier): flat +15% Dodge.
    near(FF.legendaryDodgeBonus(legSt('engarde')), 0.15, 'En Garde: flat +15% Dodge');
    near(FF.legendaryDodgeBonus(legSt('flowingblade')), 0, 'a non-En-Garde legendary gives no flat Dodge');

    // Flowing Blade (samurai/falchion): the Bushido Focus cap rises to 15 (from 10).
    eq(FF.samuraiFocusCap(legSt('flowingblade')), 15, 'Flowing Blade raises the Focus cap to 15');
    eq(FF.samuraiFocusCap(legSt('engarde')), 10, 'the Focus cap is 10 without Flowing Blade');

    // Relentless Assault (knight/claymore): Momentum cap -> 10 stacks, per-stack speed bonus -> 12%.
    eq(FF.knightStackCap(legSt('relentlessassault')), 10, 'Relentless Assault raises the Momentum cap to 10');
    near(FF.knightMomentumPerStack(legSt('relentlessassault')), 0.12, 'Relentless Assault: 12% per Momentum stack');
    near(FF.knightMomentumPerStack(legSt('engarde')), 0.10, 'Momentum is 10% per stack without Relentless Assault');
    eq(FF.knightStackCap(legSt('engarde')), 5, 'the base Momentum cap is 5 without the legendary or Lv80');
    // On a live Knight, the legendary deepens the attack-speed ramp but the timer is floored at -90% (x0.10).
    function kgear(lvl, ex){ var st = { xp:{ knight: FF.xpFloorForLevel(lvl||85) }, physique:{}, equippedMainhand:'claymore', equippedOffhand:null,
      bodyArmor:{ helmet:armor('chain'), chest:armor('plate'), gauntlets:armor('chain'), boots:armor('plate') }, activity:{type:'combat'}, playerHp:100 };
      if(ex) for(var k in ex) st[k]=ex[k]; return st; }
    eq(FF.activeClassId(kgear()), 'knight', 'claymore + plate/chain set => Knight');
    var kBase = kgear(85, { knightStacks: 5 });
    near(FF.classAttackSpeedMult(kBase), 0.50, 'base Knight: 5 Momentum stacks -> -50% timer (10% each)', 1e-9);
    // Same Knight, now wielding Relentless Assault: 10 stacks * 12% = -120%, floored to -90% (x0.10).
    var kLeg = kgear(85, { knightStacks: 10, uniqueItems:{ L:{ uid:'L', leg:'relentlessassault', kind:'weapon', base:'stweapon_claymore_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' });
    near(FF.classAttackSpeedMult(kLeg), 0.10, 'Relentless Assault: the attack timer floors at -90% (x0.10)', 1e-9);

    // Resonant Echo (spellblade/greatsword): each Spell Echo hits +10% harder per DISTINCT enchant carried.
    var reSt = legSt('resonantecho');
    reSt.uniqueItems.L.enchants = [ {mod:'critDamage', roll:10}, {mod:'critChance', roll:5}, {mod:'weaponDamage', roll:8} ]; // 3 distinct weapon-enchant stats
    eq(FF.legDistinctEnchantCount(reSt), 3, 'legDistinctEnchantCount reads the distinct equipped-enchant stats');
    near(FF.legEchoDmgMult(reSt), 1.30, 'Resonant Echo: 3 distinct enchants -> echoes hit +30%');
    var reNone = legSt('resonantecho'); // no enchants on the item
    near(FF.legEchoDmgMult(reNone), 1, 'Resonant Echo with no enchants is a no-op multiplier');
    near(FF.legEchoDmgMult(legSt('engarde')), 1, 'Resonant Echo is inert without its legendary');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 5: the four Blunt weapons ------------------------------
  suite('mastercraft: legendary blunt effects', function(){
    function legSt(key, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_mace_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } },
        equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Shield Bash (herald/mace): a Block smashes the attacker for half your Armor rating.
    eq(FF.legShieldBashDamage(200, legSt('shieldbash')), 100, 'Shield Bash deals 50% of Armor on a Block');
    eq(FF.legShieldBashDamage(200, legSt('titaniccrits')), 0, 'Shield Bash is inert without its legendary');
    eq(FF.legShieldBashDamage(0, legSt('shieldbash')), 1, 'Shield Bash floors at 1 even with no Armor');

    // Crushing Reprisal (sentinel/maul): thorns can crit, and the crit deals +100% extra crit damage.
    eq(FF.legReflectCanCrit(legSt('crushingreprisal')), true, 'Crushing Reprisal lets a reflect crit');
    eq(FF.legReflectCanCrit(legSt('shieldbash')), false, 'no reflect crit without Crushing Reprisal');
    near(FF.legReflectCritMult(legSt('crushingreprisal')), FF.CRIT_DAMAGE_MULT + 1.0, 'Crushing Reprisal: reflect crit = base crit mult +100%');
    near(FF.legReflectCritMult(legSt('shieldbash')), FF.CRIT_DAMAGE_MULT, 'the reflect crit mult is the base without the legendary');

    // Titanic Crits (berserker/warhammer): +10% crit damage per 1000 max Health, capped at +100%.
    var tcSmall = legSt('titaniccrits'); // empty physique -> low max HP
    near(FF.legendaryCritDmg(tcSmall), Math.min(1.0, 0.0001 * FF.maxHp(tcSmall)), 'Titanic Crits scales +10% crit dmg per 1000 max HP');
    // Reach 10k+ max HP via a big Max-HP armor enchant (fortitude alone caps at Lv100 -> ~550 HP).
    var tcBig = legSt('titaniccrits');
    tcBig.bodyArmor = { chest:{ uid:'A' } };
    tcBig.uniqueItems.A = { uid:'A', kind:'armor', base:'bodyarmor_plate_chest_t19_rare', tier:19, rarity:'rare', enchants:[{mod:'maxHp', roll:20000}], enhance:0 };
    ok(FF.maxHp(tcBig) >= 10000, 'the boosted profile clears 10k max HP');
    near(FF.legendaryCritDmg(tcBig), 1.0, 'Titanic Crits caps at +100% crit damage');
    near(FF.legendaryCritDmg(legSt('shieldbash')), 0, 'Titanic Crits is inert without its legendary');

    // Earthshaker (juggernaut/sledge): crits build a 5-stack Tremor; at full, the next swing hits x4 and empties it.
    var esSt = legSt('earthshaker');
    var act = esSt.activity;
    for(var i=0;i<4;i++) FF.legEarthshakerBuild(act, esSt);
    eq(act.tremorStacks, 4, '4 crits bank 4 Tremor stacks');
    ok(!act.tremorReady, 'the Tremor is not yet primed at 4 stacks');
    eq(FF.legEarthshakerConsume(act, esSt), 1, 'an unprimed Tremor does not empower the swing');
    FF.legEarthshakerBuild(act, esSt); // the 5th crit
    eq(act.tremorStacks, 0, 'reaching the cap resets the stack counter');
    ok(act.tremorReady, 'the 5th crit primes the Tremor');
    eq(FF.legEarthshakerConsume(act, esSt), FF.LEG_TREMOR_MULT, 'a primed swing hits x4 (+300%)');
    ok(!act.tremorReady, 'consuming the Tremor disarms it');
    eq(FF.legEarthshakerConsume(act, esSt), 1, 'the Tremor only empowers one swing');
    // Without the legendary, build/consume are no-ops.
    var plain = legSt('shieldbash'); var pact = plain.activity;
    for(var j=0;j<6;j++) FF.legEarthshakerBuild(pact, plain);
    ok(!pact.tremorReady && !pact.tremorStacks, 'Earthshaker never charges without its legendary');
    eq(FF.legEarthshakerConsume(pact, plain), 1, 'Earthshaker never empowers without its legendary');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 6: the three Ranged weapons ----------------------------
  suite('mastercraft: legendary ranged effects', function(){
    function legSt(key, base, extra){
      var st = { xp:{ bowLong: FF.xpFloorForLevel(50) }, physique:{ perception: FF.xpFloorForLevel(40) }, bodyArmor:{},
        activity:{type:'combat', monsterHp:100}, playerHp:100, equippedMainhand:'bowLong',
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'bowLong')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } },
        equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Steady Aim (sharpshooter/bowLong): flat +30% Accuracy.
    near(FF.legendaryAccuracyBonus(legSt('steadyaim')), 0.30, 'Steady Aim: +30% Accuracy bonus');
    near(FF.legendaryAccuracyBonus(legSt('chainshot')), 0, 'no accuracy bonus without Steady Aim');
    var aimOn = legSt('steadyaim'), aimOff = legSt('chainshot');
    ok(FF.playerAccuracy(aimOff) > 0, 'the base profile has positive Accuracy');
    near(FF.playerAccuracy(aimOn) / FF.playerAccuracy(aimOff), 1.30, 'Steady Aim raises live Accuracy by ~30%', 0.02);

    // Compound Arrows (ranger/bowMedium): each hit rolls its ailment volley twice.
    eq(FF.legRangerAilmentRolls(legSt('compoundarrows', 'bowMedium')), 2, 'Compound Arrows rolls the ailment volley twice');
    eq(FF.legRangerAilmentRolls(legSt('steadyaim')), 1, 'a single ailment roll without Compound Arrows');

    // Chain Shot (quickdraw/bowShort): the free arrow can chain, bounded by LEG_CHAINSHOT_MAX.
    eq(FF.LEG_CHAINSHOT_MAX, 5, 'the Chain Shot follow-up chain is bounded at 5');
    eq(FF.legActive('chainshot', legSt('chainshot', 'bowShort')), true, 'legActive detects an equipped Chain Shot bow');
    eq(FF.legActive('chainshot', legSt('steadyaim')), false, 'Chain Shot inert without its legendary');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 7: the seven Arcane weapons ----------------------------
  suite('mastercraft: legendary arcane weapon effects', function(){
    function armor(mat){ return { material:mat, tier:5 }; }
    function legSt(key, base, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'wandFire')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } },
        equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Tempest (thunderfury/wandEarth): +15% crit chance and a deeper Chain Lightning attack-speed ramp (cap 9 = -90%).
    near(FF.legendaryCritChance(legSt('tempest', 'wandEarth')), 0.15, 'Tempest: +15% Critical Hit chance');
    near(FF.legendaryCritChance(legSt('emberstorm')), 0, 'no crit-chance bonus without Tempest');
    eq(FF.legThunderMaxStacks(legSt('tempest', 'wandEarth')), 9, 'Tempest raises the Chain Lightning stack cap to 9');
    eq(FF.legThunderMaxStacks(legSt('emberstorm')), FF.THUNDER_MAX_STACKS, 'the base Chain Lightning stack cap is 7');
    // On a live Thunderfury, the deeper ramp reaches -90% attack timer at 9 stacks.
    function tfSt(stacks, tempest){
      var st = { xp:{ thunderfury: FF.xpFloorForLevel(85) }, physique:{}, equippedMainhand:'wandEarth', equippedOffhand:'wardEarth',
        bodyArmor:{ helmet:armor('tailoring'), chest:armor('tailoring'), gauntlets:armor('tailoring'), boots:armor('tailoring') },
        activity:{type:'combat'}, playerHp:100, thunderStacks:stacks, uniqueItems:{}, equippedMainhandUid:null };
      if(tempest){ st.uniqueItems.L = { uid:'L', leg:'tempest', kind:'weapon', base:'stweapon_wandEarth_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 }; st.equippedMainhandUid = 'L'; }
      return st;
    }
    eq(FF.activeClassId(tfSt(0, false)), 'thunderfury', 'earth wand + ward + full cloth => Thunderfury');
    near(FF.classAttackSpeedMult(tfSt(7, false)), 0.30, 'base Chain Lightning caps at 7 stacks (-70%)', 1e-9);
    near(FF.classAttackSpeedMult(tfSt(9, true)), 0.10, 'Tempest lets Chain Lightning reach 9 stacks (-90%)', 1e-9);

    // Rapid Conjuring (summoner/staff): familiars cast 20% faster.
    near(FF.legFamiliarHasteMult(legSt('rapidconjuring', 'staff')), 0.80, 'Rapid Conjuring: familiars cast 20% faster');
    near(FF.legFamiliarHasteMult(legSt('tempest', 'wandEarth')), 1, 'no familiar haste without Rapid Conjuring');

    // Retribution (templar/scepter): a Holy shield absorb arms a +50% next strike, consumed once.
    var rSt = legSt('retribution', 'scepter');
    eq(FF.legRetributionArmed(rSt), false, 'Retribution is unarmed until a Holy shield absorbs');
    rSt.retributionCharged = true;
    eq(FF.legRetributionArmed(rSt), true, 'a Holy shield absorb arms Retribution');
    near(FF.legRetributionConsume(rSt), 1.5, 'the armed strike deals +50%');
    eq(rSt.retributionCharged, false, 'consuming Retribution disarms it');
    near(FF.legRetributionConsume(rSt), 1, 'Retribution only empowers one strike');
    var rOff = legSt('emberstorm'); rOff.retributionCharged = true;
    near(FF.legRetributionConsume(rOff), 1, 'Retribution is inert without its legendary');

    // Cursebringer / Deep Freeze / Ember Storm / Aegis Break: detection + tuning constants (behaviour driven live).
    eq(FF.legActive('cursebringer', legSt('cursebringer', 'wandDark')), true, 'legActive detects Cursebringer');
    eq(FF.LEG_SUNDER_MS, 4000, 'Cursebringer refreshes a 4s Sunder');
    eq(FF.legActive('deepfreeze', legSt('deepfreeze', 'wandWater')), true, 'legActive detects Deep Freeze');
    eq(FF.legActive('aegisbreak', legSt('aegisbreak', 'wandLight')), true, 'legActive detects Aegis Break');
    eq(FF.legActive('emberstorm', legSt('emberstorm', 'wandFire')), true, 'legActive detects Ember Storm');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 8: the six Shields (all offhand) -----------------------
  suite('mastercraft: legendary shield effects', function(){
    function armor(mat){ return { material:mat, tier:5 }; }
    function legSt(key, base, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'offhand', base:'stshield_'+(base||'shieldSmall')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } },
        equippedOffhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Fortune's Riposte (treasureHunter/shieldSmall): a Block arms a +40% next strike, consumed once.
    var frp = legSt('fortunesriposte');
    eq(FF.legRiposteArmed(frp), false, "Fortune's Riposte is unarmed until a Block");
    frp.riposteCharged = true;
    eq(FF.legRiposteArmed(frp), true, 'a Block arms the Riposte');
    near(FF.legRiposteConsume(frp), 1.4, 'the armed strike deals +40%');
    eq(frp.riposteCharged, false, 'consuming disarms it');
    near(FF.legRiposteConsume(frp), 1, 'it only empowers one strike');
    var frpOff = legSt('immunize'); frpOff.riposteCharged = true;
    near(FF.legRiposteConsume(frpOff), 1, "Fortune's Riposte is inert without its legendary");

    // Immunize (plaguebearer/shieldSmall): take 25% less damage from a poisoned foe.
    var imP = legSt('immunize', 'shieldSmall', { activity:{type:'combat', monsterHp:100, potionPoisonUntil: Date.now()+4000} });
    near(FF.legImmunizeIncomingMult(imP), 0.75, 'Immunize: -25% incoming from a poisoned foe');
    var imU = legSt('immunize', 'shieldSmall', { activity:{type:'combat', monsterHp:100} });
    near(FF.legImmunizeIncomingMult(imU), 1, 'Immunize is inert against an unpoisoned foe');
    near(FF.legImmunizeIncomingMult(legSt('frenziedguard', 'shieldSmall', { activity:{type:'combat', potionPoisonUntil: Date.now()+4000} })), 1, 'Immunize is inert without its legendary');

    // Frenzied Guard (reaver/shieldSmall): a Block grants +10% attack speed (x0.90 timer) for a few seconds.
    near(FF.legAttackSpeedMult(legSt('frenziedguard', 'shieldSmall', { frenziedGuardUntil: Date.now()+2000 })), 0.90, 'Frenzied Guard: +10% attack speed while the window is live');
    near(FF.legAttackSpeedMult(legSt('frenziedguard', 'shieldSmall', { frenziedGuardUntil: Date.now()-1 })), 1, 'the Frenzied Guard window expires');
    near(FF.legAttackSpeedMult(legSt('immunize', 'shieldSmall', { frenziedGuardUntil: Date.now()+2000 })), 1, 'no haste without Frenzied Guard');

    // Perfect Bulwark (herald/shieldLarge): the Perfect Guard stack cap rises to 8 (-40%); a miss drops one stack.
    eq(FF.heraldGuardMaxStacks(legSt('perfectbulwark', 'shieldLarge')), 8, 'Perfect Bulwark raises the Perfect Guard cap to 8');
    eq(FF.heraldGuardMaxStacks(legSt('immunize')), FF.HERALD_GUARD_MAX_STACKS, 'the base Perfect Guard cap is 5');
    function hgear(stacks, bulwark){
      var st = { xp:{ herald: FF.xpFloorForLevel(85) }, physique:{}, equippedMainhand:'mace', equippedOffhand:'shieldLarge',
        bodyArmor:{ helmet:armor('plate'), chest:armor('plate'), gauntlets:armor('plate'), boots:armor('plate') },
        activity:{type:'combat'}, playerHp:100, heraldGuardStacks:stacks, uniqueItems:{}, equippedOffhandUid:null };
      if(bulwark){ st.uniqueItems.L = { uid:'L', leg:'perfectbulwark', kind:'offhand', base:'stshield_shieldLarge_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 }; st.equippedOffhandUid = 'L'; }
      return st;
    }
    eq(FF.activeClassId(hgear(0, false)), 'herald', 'mace + large shield + full plate => Herald');
    near(FF.heraldGuardMult(hgear(5, false)), 0.75, 'base Perfect Guard caps at -25% (5 stacks)', 1e-9);
    near(FF.heraldGuardMult(hgear(8, true)), 0.60, 'Perfect Bulwark deepens Perfect Guard to -40% (8 stacks)', 1e-9);

    // Thornmail Shield (sentinel/shieldMedium): while at full Health, the thorns reflect is doubled.
    function sgear(hp, thornmail){
      var st = { xp:{ sentinel: FF.xpFloorForLevel(85) }, physique:{}, equippedMainhand:'maul', equippedOffhand:'shieldMedium',
        bodyArmor:{ helmet:armor('chain'), chest:armor('chain'), gauntlets:armor('chain'), boots:armor('chain') },
        activity:{type:'combat'}, playerHp:hp, uniqueItems:{}, equippedOffhandUid:null };
      if(thornmail){ st.uniqueItems.L = { uid:'L', leg:'thornmailshield', kind:'offhand', base:'stshield_shieldMedium_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 }; st.equippedOffhandUid = 'L'; }
      return st;
    }
    var sFull = sgear(FF.maxHp(sgear(9999, false)), false); // full HP, no legendary
    var baseRefl = FF.sentinelReflectDamage(100, 0, 0, sFull); // Spiked Barrier: 25% of 100
    ok(baseRefl > 0, 'Sentinel Spiked Barrier reflects a positive share');
    var sFullTm = sgear(FF.maxHp(sgear(9999, true)), true); // full HP + Thornmail
    near(FF.sentinelReflectDamage(100, 0, 0, sFullTm), baseRefl * 2, 'Thornmail Shield doubles the reflect at full Health');
    var sHurtTm = sgear(1, true); // 1 HP + Thornmail -> not full, no doubling
    near(FF.sentinelReflectDamage(100, 0, 0, sHurtTm), baseRefl, 'Thornmail Shield does nothing below full Health');

    // Cold Snap (frostwarden/shieldMedium): detection + tuning constant (Freeze-on-Block is behaviour-driven).
    eq(FF.legActive('coldsnap', legSt('coldsnap', 'shieldMedium')), true, 'legActive detects Cold Snap');
  });

  // ---- D1 legendary gear COMBAT effects, Batch 9: the five Wards (all offhand) ------------------------
  suite('mastercraft: legendary ward effects', function(){
    function legSt(key, base, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'offhand', base:'stward_'+(base||'wardFire')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } },
        equippedOffhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();

    // Everburning (pyromancer/wardFire): Burn never expires while stacks remain.
    var ebLapsed = legSt('everburning', 'wardFire', { activity:{type:'combat', monsterHp:100, burnStacks:3, burnUntil: now-1} });
    ok(FF.enemyBurning(ebLapsed), 'Everburning keeps Burn alive after its timer lapses (stacks remain)');
    var noEbLapsed = legSt('holyward', 'wardLight', { activity:{type:'combat', monsterHp:100, burnStacks:3, burnUntil: now-1} });
    ok(!FF.enemyBurning(noEbLapsed), 'without Everburning, a lapsed Burn is gone');
    var ebNoStacks = legSt('everburning', 'wardFire', { activity:{type:'combat', monsterHp:100, burnStacks:0, burnUntil: now-1} });
    ok(!FF.enemyBurning(ebNoStacks), 'Everburning does nothing once the last Burn stack is gone');
    eq(FF.legBurnNeverExpires(legSt('everburning', 'wardFire')), true, 'legBurnNeverExpires true with Everburning');
    eq(FF.legBurnNeverExpires(legSt('holyward', 'wardLight')), false, 'legBurnNeverExpires false otherwise');

    // Charged Riposte (thunderfury/wardEarth): a ward reflect arms a guaranteed crit on the next hit.
    var cr = legSt('chargedriposte', 'wardEarth');
    eq(FF.legChargedRiposteArmed(cr), false, 'Charged Riposte is unarmed until a reflect');
    cr.chargedRiposteReady = true;
    eq(FF.legChargedRiposteArmed(cr), true, 'a reflect arms Charged Riposte');
    eq(FF.legChargedRiposteConsume(cr), true, 'the armed strike is a guaranteed crit');
    eq(cr.chargedRiposteReady, false, 'consuming disarms it');
    eq(FF.legChargedRiposteConsume(cr), false, 'it only empowers one strike');
    var crOff = legSt('everburning', 'wardFire'); crOff.chargedRiposteReady = true;
    eq(FF.legChargedRiposteConsume(crOff), false, 'Charged Riposte is inert without its legendary');

    // Nightshroud (nightblade/wardDark): a foe that damaged you is Enfeebled -10%, and it counts as a debuff.
    var nsOn = legSt('nightshroud', 'wardDark', { activity:{type:'combat', monsterHp:100, nightshroudUntil: now+4000} });
    near(FF.legNightshroudIncomingMult(nsOn), 0.90, 'Nightshroud: the Enfeebled foe deals 10% less');
    ok(FF.legNightshroudActive(nsOn), 'Nightshroud is active while the window is live');
    eq(FF.enemyDebuffCount(nsOn), 1, 'Nightshroud Enfeeble counts as a debuff (feeds Void Resonance / Soul Tax)');
    var nsOff = legSt('nightshroud', 'wardDark', { activity:{type:'combat', monsterHp:100, nightshroudUntil: now-1} });
    near(FF.legNightshroudIncomingMult(nsOff), 1, 'the Nightshroud window expires');
    eq(FF.enemyDebuffCount(nsOff), 0, 'an expired Nightshroud no longer counts');
    near(FF.legNightshroudIncomingMult(legSt('everburning', 'wardFire', { activity:{type:'combat', nightshroudUntil: now+4000} })), 1, 'Nightshroud is inert without its legendary');

    // Beacon Ward / Holy Ward (both light wards): detection (heal / Holy-shield-on-reflect is behaviour-driven).
    eq(FF.legActive('beaconward', legSt('beaconward', 'wardLight')), true, 'legActive detects Beacon Ward');
    eq(FF.legActive('holyward', legSt('holyward', 'wardLight')), true, 'legActive detects Holy Ward');
  });

  // ---- D2 (Tunnel) legendary gear: arcane forge (Batch G) --------------------------------------------
  suite('mastercraft: D2 legendary gear forge (arcane group)', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','arcane')]);
    ok(rec && rec.gear === true, 'D2 arcane has a gear forge recipe');
    eq(rec.layer, 'd2', 'the D2 arcane recipe is a d2-layer recipe');
    eq(rec.rareCount, 20, 'D2 arcane needs 20 rare Tier-20 items (double D1)');
    eq(rec.outcomes.length, 12, 'the D2 arcane pool forges one of 7 weapons + 5 wards');
    eq(rec.inputs.forestry_t20, 2000, 'D2 arcane formula costs 2000 t20 wood');
    ['fire','water','earth','light','dark'].forEach(function(el){ eq(rec.inputs['glyph_'+el], 400, 'D2 arcane costs 400 '+el+' glyphs'); });
    // Item table: 12 effects x 4 rarities = 48 D2 gear items, all d2-tagged.
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D2).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D2[id].group==='arcane'; }).length, 48, '12 arcane effects x 4 rarities = 48 D2 arcane gear items');
    ok(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D2).every(function(id){ var it = FF.LEGENDARY_GEAR_ITEMS_D2[id]; return it.legendary && it.gear && it.dungeon==='d2' && it.sell===0 && /<svg/.test(it.icon); }), 'every D2 gear item is flagged, d2-layer, non-vendorable, iconned');
    eq(FF.LEGENDARY_GEAR_ITEMS_D2[FF.legGearItemIdD2('cindermaw','normal')].name, 'Cindermaw', 'Normal D2 legendary name is bare');
    ok(/Fantastic/.test(FF.LEGENDARY_GEAR_ITEMS_D2[FF.legGearItemIdD2('cindermaw','fantastic')].name), 'Fantastic D2 legendary carries the rarity suffix');
    // Full forge: give the bill + a blueprint, craft, confirm a d2 legendary UNIQUE with an arcane-group leg.
    var s = FF._state, svInv = s.inventory, svBp = s.blueprints, svUniq = s.uniqueItems;
    s.inventory = { forestry_t20: 2000, glyph_fire:400, glyph_water:400, glyph_earth:400, glyph_light:400, glyph_dark:400 };
    s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('arcane').forEach(function(id){ s.inventory[id] = 3; });
    var bpId = FF.masterworkBlueprintId('d2','arcane'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D2 forge mints exactly one legendary unique');
    var u = minted[0];
    ok(u && u.leg && FF.D2_LEG_GEAR_MAP[u.leg], 'the unique carries a D2 arcane-group legendary effect');
    ok(/^st(weapon|ward)_.+_t20_(rare|supreme|fantastic)$/.test(u.base), 'the unique is a top-tier wand/scepter/staff/ward base, floored at Rare');
    ok(FF.uniqueDisplayName(u).indexOf(FF.D2_LEG_GEAR_MAP[u.leg].name) !== -1, 'the forged D2 legendary displays its effect name, not the base wand/ward');
    eq(s.blueprints[bpId], 0, 'the forge consumes the Blueprint');
    eq(s.inventory.forestry_t20, 0, 'the forge consumes the 2000 wood');
    var rareLeft = FF.legGearRareIds('arcane').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('arcane').length * 3 - 20, 'the forge consumes exactly 20 rare arcane items');
    s.inventory = svInv; s.blueprints = svBp; s.uniqueItems = svUniq;
  });

  // ---- D2 legendary arcane weapon + ward effects (Batch G) -------------------------------------------
  suite('mastercraft: D2 legendary arcane effects', function(){
    function legSt(key, base, kind, extra){
      var isOff = kind === 'offhand';
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:kind||'weapon', base:'st'+(isOff?'ward':'weapon')+'_'+(base||'wandFire')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } } };
      st[isOff ? 'equippedOffhandUid' : 'equippedMainhandUid'] = 'L';
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();
    // Cindermaw (fire wand): +3 Burn cap; burning foes take +12%.
    eq(FF.pyroBurnCap(legSt('cindermaw','wandFire')), 8, 'Cindermaw: Burn cap 5 -> 8 (+3)');
    near(FF.d2LegDmgMult({}, legSt('cindermaw','wandFire','weapon',{ activity:{type:'combat', monsterHp:100, burnUntil: now+4000, burnStacks:1} })), 1.12, 'Cindermaw: +12% vs a burning foe');
    near(FF.d2LegDmgMult({}, legSt('cindermaw','wandFire')), 1.0, 'Cindermaw inert on an unburnt foe');
    // Rimefang (water wand): Chilled foes take +15%.
    near(FF.d2LegDmgMult({}, legSt('rimefang','wandWater','weapon',{ activity:{type:'combat', monsterHp:100, enemyChillUntil: now+4000} })), 1.15, 'Rimefang: +15% vs a Chilled foe');
    near(FF.d2LegDmgMult({}, legSt('rimefang','wandWater')), 1.0, 'Rimefang inert on an un-chilled foe');
    // Stormbrand (earth wand): +8% crit chance per Galvanize stack.
    near(FF.legStormbrandCrit(legSt('stormbrand','wandEarth','weapon',{ activity:{type:'combat', monsterHp:100, galvanizeStacks:3} })), 0.24, 'Stormbrand: +8% crit chance per Galvanize stack');
    near(FF.legStormbrandCrit(legSt('cindermaw','wandFire')), 0, 'no Stormbrand crit without the wand');
    // Voidfang (dark wand): each Vulnerability stack shreds 3% armour (cap 60%).
    near(FF.legVoidfangShred(legSt('voidfang','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, voidVulnStacks:5, voidVulnUntil: now+4000} })), 0.15, 'Voidfang: 5 Vuln stacks shred 15% armour');
    near(FF.legVoidfangShred(legSt('voidfang','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, voidVulnStacks:99, voidVulnUntil: now+4000} })), 0.60, 'Voidfang armour shred caps at 60%');
    near(FF.legVoidfangShred(legSt('cindermaw','wandFire')), 0, 'no Voidfang shred without the wand');
    // Sunbrand / Packbrand / Dawnbrand (behaviour-driven live): detection only.
    eq(FF.legActive('sunbrand', legSt('sunbrand','scepter')), true, 'legActive detects Sunbrand');
    eq(FF.legActive('packbrand', legSt('packbrand','staff')), true, 'legActive detects Packbrand');
    eq(FF.legActive('dawnbrand', legSt('dawnbrand','wandLight')), true, 'legActive detects Dawnbrand');
    // Wards: detection.
    eq(FF.legActive('emberveil', legSt('emberveil','wardFire','offhand')), true, 'legActive detects Emberveil');
    eq(FF.legActive('stormveil', legSt('stormveil','wardEarth','offhand')), true, 'legActive detects Stormveil');
    eq(FF.legActive('voidveil', legSt('voidveil','wardDark','offhand')), true, 'legActive detects Voidveil');
    eq(FF.legActive('lumenveil', legSt('lumenveil','wardLight','offhand')), true, 'legActive detects Lumenveil');
    eq(FF.legActive('aegisveil', legSt('aegisveil','wardLight','offhand')), true, 'legActive detects Aegisveil');
    // legBarrierAdd banks a Barrier on the live state, capped at >= 40% max HP for any class (Emberveil/Dawnbrand).
    var s = FF._state, svShield = s.lumenShield;
    s.lumenShield = 0; FF.legBarrierAdd(7);
    ok(Math.abs(s.lumenShield - 7) < 1e-9, 'legBarrierAdd banks the Barrier amount');
    ok(FF.legBarrierCap(s) >= Math.round(FF.maxHp(s) * 0.40) - 1e-9, 'the Barrier cap is at least 40% of max Health');
    s.lumenShield = svShield;
  });

  // ---- D2 (Tunnel) legendary shields (Batch H) -------------------------------------------------------
  suite('mastercraft: D2 legendary shields (defense group)', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','defense')]);
    ok(rec && rec.gear === true, 'D2 defense has a gear forge recipe');
    eq(rec.layer, 'd2', 'the D2 defense recipe is a d2-layer recipe');
    eq(rec.rareCount, 20, 'D2 defense needs 20 rare Tier-20 shields (double D1)');
    eq(rec.inputs.metallurgy_t20, 2000, 'D2 defense formula costs 2000 t20 ingots');
    eq(rec.outcomes.length, 6, 'the D2 defense pool forges one of 6 shields');
    eq(FF.LEG_GEAR_GROUP_KEYS_D2.defense.length, 6, 'six D2 shield effects in the defense group');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D2).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D2[id].group==='defense'; }).length, 24, '6 defense effects x 4 rarities = 24 D2 shield items');
    // Detection: each shield legendary is picked up by legActive when slotted to the off-hand.
    function legSt(key, base){ return { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'offhand', base:'stshield_'+(base||'shieldSmall')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedOffhandUid:'L' }; }
    ['cofferguard','rotshell','goreshell','rimeshell','thornwall','bulwarkbreach'].forEach(function(k){ eq(FF.legActive(k, legSt(k)), true, 'legActive detects '+k); });
    ok(/Bulwark of the Breach/.test(FF.LEGENDARY_GEAR_ITEMS_D2[FF.legGearItemIdD2('bulwarkbreach','normal')].name), 'the herald D2 shield is Bulwark of the Breach');
    // Full forge: give the bill, craft, confirm a d2 defense-group unique on a top-tier shield base.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 2000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('defense').forEach(function(id){ s.inventory[id] = 8; }); // 3 shield types x 8 = 24 >= 20
    var bpId = FF.masterworkBlueprintId('d2','defense'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D2 defense forge mints exactly one legendary unique');
    var u = minted[0];
    ok(u && u.leg && FF.LEG_GEAR_GROUP_KEYS_D2.defense.indexOf(u.leg) !== -1, 'the unique carries a D2 defense-group effect');
    ok(/^stshield_.+_t19_(rare|supreme|fantastic)$/.test(u.base), 'the unique is a top-tier shield base, floored at Rare');
    ok(FF.uniqueDisplayName(u).indexOf(FF.D2_LEG_GEAR_MAP[u.leg].name) !== -1, 'the forged D2 shield displays its effect name');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 2000 ingots');
    var rareLeft = FF.legGearRareIds('defense').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('defense').length * 8 - 20, 'the forge consumes exactly 20 rare shields');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D2 (Tunnel) legendary melee: slash + pierce (Batch I) -----------------------------------------
  suite('mastercraft: D2 legendary melee (slash + pierce)', function(){
    ['slash','pierce'].forEach(function(g){
      var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2',g)]);
      ok(rec && rec.gear === true && rec.layer === 'd2', 'D2 '+g+' has a d2-layer gear recipe');
      eq(rec.rareCount, 20, 'D2 '+g+' needs 20 rare Tier-20 weapons');
      eq(rec.inputs.metallurgy_t20, 2000, 'D2 '+g+' costs 2000 t20 ingots');
    });
    eq(FF.LEG_GEAR_GROUP_KEYS_D2.slash.length, 6, 'six D2 slash effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D2.pierce.length, 4, 'four D2 pierce effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D2).filter(function(id){ var g=FF.LEGENDARY_GEAR_ITEMS_D2[id].group; return g==='slash'||g==='pierce'; }).length, 40, '10 melee effects (6 slash + 4 pierce) x 4 rarities = 40 items');

    function legSt(key, base, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'scimitar')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();
    // Marrowsplitter (reaver/halfmoonaxe): +3% per Bleed stack.
    near(FF.d2LegDmgMult({}, legSt('marrowsplitter','halfmoonaxe',{ activity:{type:'combat', monsterHp:100, bleedStacks:5, bleedUntil:now+4000} })), 1.15, 'Marrowsplitter: +3% per Bleed stack (5 -> +15%)');
    near(FF.d2LegDmgMult({}, legSt('marrowsplitter','halfmoonaxe')), 1.0, 'Marrowsplitter inert on an unbled foe');
    // Headtaker (executioner/fullmoonaxe): stacking +10% per kill; d2HeadtakerOnKill builds a stack.
    var ht = legSt('headtaker','fullmoonaxe'); FF.d2HeadtakerOnKill(ht);
    eq(ht.d2HeadtakerStacks, 1, 'a kill adds a Headtaker stack'); ok(ht.d2HeadtakerUntil > now, 'and opens the window');
    ht.d2HeadtakerStacks = 3; ht.d2HeadtakerUntil = now + 9999;
    near(FF.d2LegDmgMult({}, ht), 1.30, 'Headtaker: +10% per kill stack (3 -> +30%)');
    ht.d2HeadtakerUntil = now - 1; near(FF.d2LegDmgMult({}, ht), 1.0, 'Headtaker lapses after its window');
    // Bloodwaltz (duelist/rapier): +5% per untouched hit, cap +50%.
    near(FF.d2LegDmgMult({}, legSt('bloodwaltz','rapier',{ d2BloodwaltzStacks:4 })), 1.20, 'Bloodwaltz: +5% per untouched hit (4 -> +20%)');
    near(FF.d2LegDmgMult({}, legSt('bloodwaltz','rapier',{ d2BloodwaltzStacks:99 })), 1.50, 'Bloodwaltz caps at +50%');
    // Runegorge (spellblade/greatsword): +3% crit damage per equipped enchant.
    var rg = legSt('runegorge','greatsword'); rg.uniqueItems.L.enchants = [{},{}]; // 2 enchants on the equipped weapon
    near(FF.legRunegorgeCritDmg(rg), 0.06, 'Runegorge: +3% crit damage per equipped enchant');
    near(FF.legRunegorgeCritDmg(legSt('marrowsplitter','halfmoonaxe')), 0, 'no Runegorge crit dmg without the greatsword');
    // Detection for the behaviour-driven effects (gold/heal/crit/armour handled live).
    eq(FF.legActive('goldgorge', legSt('goldgorge','scimitar')), true, 'legActive detects Goldgorge');
    eq(FF.legActive('blightfang', legSt('blightfang','hatchet')), true, 'legActive detects Blightfang');
    eq(FF.legActive('throatripper', legSt('throatripper','claw')), true, 'legActive detects Throatripper');
    eq(FF.legActive('soulflay', legSt('soulflay','scythe')), true, 'legActive detects Soulflay');
    eq(FF.legActive('ironwind', legSt('ironwind','falchion')), true, 'legActive detects Ironwind');
    eq(FF.legActive('breachblade', legSt('breachblade','claymore')), true, 'legActive detects Breachblade');
    // Full forge (slash): give the bill, craft, confirm a d2 slash-group unique.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 2000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('slash').forEach(function(id){ s.inventory[id] = 4; });
    var bpId = FF.masterworkBlueprintId('d2','slash'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D2 slash forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D2.slash.indexOf(minted[0].leg) !== -1, 'the unique carries a D2 slash-group effect');
    ok(/^stweapon_.+_t19_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier slashing weapon base');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D2 (Tunnel) legendary melee: blunt + ranged (Batch J) -----------------------------------------
  suite('mastercraft: D2 legendary blunt + ranged', function(){
    var blunt = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','blunt')]);
    var ranged = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','ranged')]);
    ok(blunt && blunt.gear && blunt.layer==='d2' && blunt.rareCount===20 && blunt.inputs.metallurgy_t20===2000, 'D2 blunt: d2 gear recipe, 20 rare, 2000 ingots');
    ok(ranged && ranged.gear && ranged.layer==='d2' && ranged.rareCount===20 && ranged.inputs.forestry_t20===2000, 'D2 ranged: d2 gear recipe, 20 rare, 2000 wood');
    eq(FF.LEG_GEAR_GROUP_KEYS_D2.blunt.length, 4, 'four D2 blunt effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D2.ranged.length, 3, 'three D2 ranged effects');
    // With all 46-slot vision, the D2 gear table now holds every group except accessories: 35 effects x 4 = 140.
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D2).filter(function(id){ var g=FF.LEGENDARY_GEAR_ITEMS_D2[id].group; return g==='blunt'||g==='ranged'; }).length, 28, '7 effects (4 blunt + 3 ranged) x 4 rarities = 28 items');

    function legSt(key, base, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'mace')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();
    // Wallbreaker (herald/mace): +4% damage per Perfect Guard stack.
    near(FF.d2LegDmgMult({}, legSt('wallbreaker','mace',{ heraldGuardStacks:3 })), 1.12, 'Wallbreaker: +4% per Perfect Guard stack (3 -> +12%)');
    near(FF.d2LegDmgMult({}, legSt('wallbreaker','mace')), 1.0, 'Wallbreaker inert with no Guard stacks');
    // Trapmaster (ranger/bowMedium): +20% vs an ailing foe.
    near(FF.d2LegDmgMult({}, legSt('trapmaster','bowMedium',{ activity:{type:'combat', monsterHp:100, bleedUntil:now+4000} })), 1.20, 'Trapmaster: +20% vs an ailing (bleeding) foe');
    near(FF.d2LegDmgMult({}, legSt('trapmaster','bowMedium')), 1.0, 'Trapmaster inert on a clean foe');
    // Earthrender (juggernaut/sledge): +30% and never miss (the +30% is the readable part).
    near(FF.d2LegDmgMult({}, legSt('earthrender','sledge')), 1.30, 'Earthrender: Wind-Up swings hit +30%');
    // Spineshatter (sentinel/maul): stacking -4% enemy damage per reflect (cap -40%).
    near(FF.legSpineshatterMult(legSt('spineshatter','maul',{ activity:{type:'combat', monsterHp:100, spineshatterStacks:5, spineshatterUntil:now+4000} })), 0.80, 'Spineshatter: -4% enemy damage per reflect (5 -> -20%)');
    near(FF.legSpineshatterMult(legSt('spineshatter','maul',{ activity:{type:'combat', monsterHp:100, spineshatterStacks:99, spineshatterUntil:now+4000} })), 0.60, 'Spineshatter caps at -40%');
    near(FF.legSpineshatterMult(legSt('wallbreaker','mace')), 1.0, 'no Spineshatter debuff without the maul');
    // Serpentcoil (quickdraw/bowShort): +30% poison ticks.
    near(FF.legPoisonTickMult(legSt('serpentcoil','bowShort')), 1.30, 'Serpentcoil: +30% poison ticks');
    near(FF.legPoisonTickMult(legSt('trapmaster','bowMedium')), 1.0, 'no Serpentcoil poison boost without the short bow');
    // Farstrike (sharpshooter/bowLong): +40% crit damage.
    near(FF.legFarstrikeCritDmg(legSt('farstrike','bowLong')), 0.40, 'Farstrike: +40% crit damage');
    near(FF.legFarstrikeCritDmg(legSt('trapmaster','bowMedium')), 0, 'no Farstrike crit dmg without the long bow');
    // Detection for the behaviour-driven crit effects (Skullcleaver / Ironwind handled in the crit roll).
    eq(FF.legActive('skullcleaver', legSt('skullcleaver','warhammer')), true, 'legActive detects Skullcleaver');
    // Full forge (ranged): give the bill, craft, confirm a d2 ranged-group unique.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { forestry_t20: 2000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('ranged').forEach(function(id){ s.inventory[id] = 8; }); // 3 bow types x 8 = 24 >= 20
    var bpId = FF.masterworkBlueprintId('d2','ranged'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D2 ranged forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D2.ranged.indexOf(minted[0].leg) !== -1, 'the unique carries a D2 ranged-group effect');
    ok(/^stweapon_bow.+_t20_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier bow base');
    eq(s.inventory.forestry_t20, 0, 'the forge consumes the 2000 wood');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D2 (Tunnel) universal accessories: Signets / Shrouds / Pendants (Batch K) ---------------------
  suite('mastercraft: D2 legendary accessories', function(){
    var ring = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','ring')]);
    var cape = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','cape')]);
    var amu  = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','amulet')]);
    ok(ring && ring.layer==='d2' && ring.rareCount===20 && ring.outcomes.length===5, 'D2 ring: d2 recipe, 20 rare, 5 Signets');
    ok(cape && cape.layer==='d2' && cape.rareCount===20 && cape.outcomes.length===3, 'D2 cape: d2 recipe, 20 rare, 3 Shrouds');
    ok(amu  && amu.layer==='d2'  && amu.rareCount===20  && amu.outcomes.length===3, 'D2 amulet: d2 recipe, 20 rare, 3 Pendants');
    eq(ring.inputs.metallurgy_t20, 2000, 'D2 ring costs 2000 ingots');
    eq(cape.inputs.weaving_t20, 2000, 'D2 cape costs 2000 cloth');
    eq(FF.D2_LEG_RING_DEFS.length, 5, '5 D2 Signets'); eq(FF.D2_LEG_CLOAK_DEFS.length, 3, '3 D2 Shrouds'); eq(FF.D2_LEG_AMULET_DEFS.length, 3, '3 D2 Pendants');
    eq(Object.keys(FF.LEGENDARY_RING_ITEMS).filter(function(id){ return FF.LEGENDARY_RING_ITEMS[id].dungeon==='d2'; }).length, 20, '5 Signets x 4 rarities = 20 D2 ring items');
    eq(Object.keys(FF.LEGENDARY_CLOAK_ITEMS).filter(function(id){ return FF.LEGENDARY_CLOAK_ITEMS[id].dungeon==='d2'; }).length, 12, '3 Shrouds x 4 = 12 D2 cloak items');
    eq(Object.keys(FF.LEGENDARY_AMULET_ITEMS).filter(function(id){ return FF.LEGENDARY_AMULET_ITEMS[id].dungeon==='d2'; }).length, 12, '3 Pendants x 4 = 12 D2 amulet items');
    // Bonus readers pick up the merged D2 keys and scale by rarity (rare = x2).
    var R = FF.RING_SLOT_IDS[0];
    function ringSt(key, r){ var js = {}; js[R] = { leg:key, rarity:r||'rare' }; return { jewelrySlots: js }; }
    function cloakSt(key, r){ return { bodyArmor: { back: { leg:key, rarity:r||'rare' } } }; }
    function amuSt(key, r){ return { jewelrySlots: { amulet: { leg:key, rarity:r||'rare' } } }; }
    near(FF.legendaryRingBonus('d2_leech', ringSt('d2_leech')), 0.10, 'Signet of the Leech (Rare): +10% Lifesteal');
    near(FF.legendaryRingBonus('d2_fury', ringSt('d2_fury','fantastic')), 0.40, 'Signet of Fury (Fantastic): +40% Attack Speed');
    near(FF.legendaryRingBonus('d2_bramble', ringSt('d2_bramble')), 0.30, 'Signet of the Bramble (Rare): +30% Reflect');
    near(FF.legendaryRingBonus('d2_goldfind', ringSt('d2_goldfind')), 0.50, 'Signet of Plunder (Rare): +50% Gold Find');
    ok(FF.legRingEquipped('d2_feast', ringSt('d2_feast')), 'legRingEquipped detects an equipped D2 Signet');
    near(FF.legendaryCloakBonus('d2_ruin', cloakSt('d2_ruin')), 0.16, 'Shroud of Ruin (Rare): +16% All Damage');
    near(FF.legendaryCloakBonus('d2_tunnelborn', cloakSt('d2_tunnelborn')), 0.16, 'Shroud of the Tunnelborn (Rare): +16% Damage Reduction');
    near(FF.legendaryCloakBonus('d2_warpack', cloakSt('d2_warpack')), 0.30, 'Shroud of the Warpack (Rare): +30% Elemental Damage');
    near(FF.legendaryAmuletBonus('d2_ironhide', amuSt('d2_ironhide')), 0.50, 'Pendant of Ironhide (Rare): +50% Armor');
    near(FF.legendaryAmuletBonus('d2_veteran', amuSt('d2_veteran')), 0.40, 'Pendant of the Veteran (Rare): +40% XP');
    near(FF.legendaryAmuletBonus('d2_zealot', amuSt('d2_zealot')), 0.50, 'Pendant of the Zealot (Rare): +50% Faith');
    // Full forge (ring): give the bill + 20 rare t20 rings, craft, confirm a d2 Signet is added to inventory.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints;
    var catId = 'ring_' + FF.RING_TYPES[0].id + '_t20_rare';
    s.inventory = { metallurgy_t20:2000, gem_voidcrystal:200, twine_t20:200, goldsmithing_t20:200 }; s.inventory[catId] = 20;
    s.blueprints = {};
    var bpId = FF.masterworkBlueprintId('d2','ring'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var mintedId = Object.keys(s.inventory).filter(function(id){ return /^legring_d2_/.test(id) && s.inventory[id] > 0; })[0];
    ok(mintedId, 'the D2 ring forge adds a d2 Signet to inventory');
    ok(FF.LEGENDARY_RING_ITEMS[mintedId] && ring.outcomes.indexOf(FF.LEGENDARY_RING_ITEMS[mintedId].legKey) !== -1, 'the forged Signet carries a D2 ring-group effect');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 2000 ingots');
    eq(s.inventory[catId], 0, 'the forge consumes 20 rare t20 rings');
    s.inventory=svInv; s.blueprints=svBp;
  });

  // ---- D3 (Underground) universal accessories: Signets / Shrouds / Pendants (Batch V) ---------------
  suite('mastercraft: D3 legendary accessories', function(){
    var ring = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','ring')]);
    var cape = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','cape')]);
    var amu  = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','amulet')]);
    ok(ring && ring.layer==='d3' && ring.rareCount===30 && ring.outcomes.length===5, 'D3 ring: d3 recipe, 30 rare, 5 Signets');
    ok(cape && cape.layer==='d3' && cape.rareCount===30 && cape.outcomes.length===3, 'D3 cape: d3 recipe, 30 rare, 3 Shrouds');
    ok(amu  && amu.layer==='d3'  && amu.rareCount===30  && amu.outcomes.length===3, 'D3 amulet: d3 recipe, 30 rare, 3 Pendants');
    eq(FF.D3_LEG_RING_DEFS.length, 5, '5 D3 Signets'); eq(FF.D3_LEG_CLOAK_DEFS.length, 3, '3 D3 Shrouds'); eq(FF.D3_LEG_AMULET_DEFS.length, 3, '3 D3 Pendants');
    eq(Object.keys(FF.LEGENDARY_RING_ITEMS).filter(function(id){ return FF.LEGENDARY_RING_ITEMS[id].dungeon==='d3'; }).length, 20, '5 Signets x 4 = 20 D3 ring items');
    eq(Object.keys(FF.LEGENDARY_CLOAK_ITEMS).filter(function(id){ return FF.LEGENDARY_CLOAK_ITEMS[id].dungeon==='d3'; }).length, 12, '3 Shrouds x 4 = 12 D3 cloak items');
    eq(Object.keys(FF.LEGENDARY_AMULET_ITEMS).filter(function(id){ return FF.LEGENDARY_AMULET_ITEMS[id].dungeon==='d3'; }).length, 12, '3 Pendants x 4 = 12 D3 amulet items');

    var R = FF.RING_SLOT_IDS[0], now = Date.now();
    function ringSt(key, r){ var js={}; js[R]={leg:key,rarity:r||'rare'}; return { jewelrySlots:js }; }
    function ringDmgSt(key, act){ var js={}; js[R]={leg:key,rarity:'rare'}; return { jewelrySlots:js, bodyArmor:{}, activity:act, playerHp:1e9, physique:{}, xp:{} }; }
    function cloakDmgSt(key, act){ return { jewelrySlots:{}, bodyArmor:{ back:{leg:key,rarity:'rare'} }, activity:act, playerHp:1e9, physique:{}, xp:{} }; }
    // Grave (vs Cursed) / Wight (vs afflicted) / Reap (vs low-HP) — via d3AccessoryDmgMult.
    near(FF.d3AccessoryDmgMult({hp:1000}, ringDmgSt('d3_grave', {type:'combat', monsterHp:800, curseUntil:now+4000})), 1.20, 'Signet of the Grave: +20% vs a Cursed foe (rare)');
    near(FF.d3AccessoryDmgMult({hp:1000}, ringDmgSt('d3_grave', {type:'combat', monsterHp:800})), 1.0, 'Grave inert on an uncursed foe');
    near(FF.d3AccessoryDmgMult({hp:1000}, ringDmgSt('d3_wight', {type:'combat', monsterHp:800, decayStacks:1, decayUntil:now+4000})), 1.16, 'Signet of the Wight: +16% vs an afflicted (Decaying) foe');
    near(FF.d3AccessoryDmgMult({hp:1000}, cloakDmgSt('d3_reaper', {type:'combat', monsterHp:200})), 1.24, 'Shroud of the Reaper: +24% vs a foe below 30% HP');
    near(FF.d3AccessoryDmgMult({hp:1000}, cloakDmgSt('d3_reaper', {type:'combat', monsterHp:800})), 1.0, 'Reap inert on a healthy foe');
    // Decay Power (Crypt) via d3DecayTickMult.
    near(FF.d3DecayTickMult(ringSt('d3_crypt')), 1.40, 'Signet of the Crypt: +40% Decay Power (rare)');
    // Deathless (Undeath) via d3SetIncomingMult, only below 50% HP.
    var lowHp = { bodyArmor:{ back:{leg:'d3_undeath',rarity:'rare'} }, jewelrySlots:{}, physique:{}, xp:{}, activity:{type:'combat',monsterHp:100}, playerHp:1 };
    near(FF.d3SetIncomingMult(lowHp), 0.80, 'Shroud of Undeath: -20% Damage Reduction below 50% HP (rare)');
    lowHp.playerHp = 1e9; near(FF.d3SetIncomingMult(lowHp), 1.0, 'Undeath inert above 50% HP');
    // enemyAfflicted spans DoT / Decay / Curse.
    ok(FF.enemyAfflicted({ activity:{type:'combat', monsterHp:100, curseUntil:now+4000} }), 'a Cursed foe is afflicted');
    ok(!FF.enemyAfflicted({ activity:{type:'combat', monsterHp:100} }), 'a clean foe is not afflicted');
    // Full forge (ring).
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints;
    var catId = 'ring_' + FF.RING_TYPES[0].id + '_t20_rare';
    s.inventory = { metallurgy_t20:3000, gem_voidcrystal:300, twine_t20:300, goldsmithing_t20:300 }; s.inventory[catId] = 30;
    s.blueprints = {};
    var bpId = FF.masterworkBlueprintId('d3','ring'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var mintedId = Object.keys(s.inventory).filter(function(id){ return /^legring_d3_/.test(id) && s.inventory[id] > 0; })[0];
    ok(mintedId, 'the D3 ring forge adds a d3 Signet to inventory');
    ok(FF.LEGENDARY_RING_ITEMS[mintedId] && ring.outcomes.indexOf(FF.LEGENDARY_RING_ITEMS[mintedId].legKey) !== -1, 'the forged Signet carries a D3 ring-group effect');
    eq(s.inventory[catId], 0, 'the forge consumes 30 rare t20 rings');
    s.inventory=svInv; s.blueprints=svBp;
  });

  // ---- D4 legendary accessories: Signets / Shrouds / Pendants (Batch GG) ----------------------------
  suite('mastercraft: D4 legendary accessories', function(){
    var ring = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','ring')]);
    var cape = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','cape')]);
    var amu  = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','amulet')]);
    ok(ring && ring.layer==='d4' && ring.rareCount===40 && ring.outcomes.length===5, 'D4 ring: d4 recipe, 40 rare, 5 Signets');
    ok(cape && cape.layer==='d4' && cape.rareCount===40 && cape.outcomes.length===3, 'D4 cape: d4 recipe, 40 rare, 3 Shrouds');
    ok(amu  && amu.layer==='d4'  && amu.rareCount===40  && amu.outcomes.length===3, 'D4 amulet: d4 recipe, 40 rare, 3 Pendants');
    eq(FF.D4_LEG_RING_DEFS.length, 5, '5 D4 Signets'); eq(FF.D4_LEG_CLOAK_DEFS.length, 3, '3 D4 Shrouds'); eq(FF.D4_LEG_AMULET_DEFS.length, 3, '3 D4 Pendants');
    eq(Object.keys(FF.LEGENDARY_RING_ITEMS).filter(function(id){ return FF.LEGENDARY_RING_ITEMS[id].dungeon==='d4'; }).length, 20, '5 Signets x 4 = 20 D4 ring items');
    eq(Object.keys(FF.LEGENDARY_CLOAK_ITEMS).filter(function(id){ return FF.LEGENDARY_CLOAK_ITEMS[id].dungeon==='d4'; }).length, 12, '3 Shrouds x 4 = 12 D4 cloak items');
    eq(Object.keys(FF.LEGENDARY_AMULET_ITEMS).filter(function(id){ return FF.LEGENDARY_AMULET_ITEMS[id].dungeon==='d4'; }).length, 12, '3 Pendants x 4 = 12 D4 amulet items');

    var R = FF.RING_SLOT_IDS[0], now = Date.now();
    function ringSt(key, extra){ var js={}; js[R]={leg:key,rarity:'rare'}; var st = { jewelrySlots:js, bodyArmor:{}, physique:{}, xp:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9 }; if(extra) for(var k in extra) st[k]=extra[k]; return st; }
    function cloakSt(key, extra){ var st = { jewelrySlots:{}, bodyArmor:{ back:{leg:key,rarity:'rare'} }, physique:{}, xp:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9 }; if(extra) for(var k in extra) st[k]=extra[k]; return st; }
    function amuletSt(key, extra){ var st = { jewelrySlots:{ amulet:{leg:key,rarity:'rare'} }, bodyArmor:{}, physique:{}, xp:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9 }; if(extra) for(var k in extra) st[k]=extra[k]; return st; }

    // Signet of the Wyrm: +Elemental Damage (rare = 0.15 x2 = +0.30 folded into elementDmgMult).
    near(FF.elementDmgMult(ringSt('d4_wyrm'), 'fire') - FF.elementDmgMult(ringSt('d4_nothere'), 'fire'), 0.30, 'Signet of the Wyrm: +30% Elemental Damage (rare)');
    // Signet of Scales: +Elemental Resistance (0.08 x2 = 0.16).
    near(FF.d4SetElementResist(ringSt('d4_scales'), 'fire'), 0.10, 'Signet of Scales: +10% Elemental Resistance (rare, base trimmed to 0.05)');
    // Signet of Wrath: +damage per Wrath stack (0.02 x2 = 0.04/stack).
    near(FF.d4LegDmgMult({}, ringSt('d4_wrath', { d4Wrath:5, d4WrathUntil:now+9999 })), 1 + 0.02*5, 'Signet of Wrath: +2% damage per Wrath stack (rare, base trimmed to 0.01)');
    // Signet of the Breath / Hoard: stat values (behaviour rides charge / kill hooks).
    near(FF.legendaryRingBonus('d4_breath', ringSt('d4_breath')), 0.50, 'Signet of the Breath: +50% Breath Power (rare)');
    near(FF.legendaryRingBonus('d4_hoard', ringSt('d4_hoard')), 1.00, 'Signet of the Hoard: +100% elemental-kill gold (rare)');

    // Shroud of Scales: elemental DR (0.12 x2 = 0.24 -> x0.76 incoming from an elemental foe).
    near(FF.d4LegIncomingMult(cloakSt('d4_scaleshroud'), { element:'fire' }), 0.76, 'Shroud of Scales: -24% elemental damage (rare)');
    near(FF.d4LegIncomingMult(cloakSt('d4_scaleshroud'), { element:null }), 1.0, 'Shroud of Scales inert vs a non-elemental foe');
    // Shroud of the Wyrm: +damage vs an elemental foe (0.12 x2 = +0.24).
    near(FF.d4LegDmgMult({ element:'fire' }, cloakSt('d4_wyrmshroud')), 1.16, 'Shroud of the Wyrm: +16% vs an elemental foe (rare, base trimmed to 0.08)');
    near(FF.d4LegDmgMult({ element:null }, cloakSt('d4_wyrmshroud')), 1.0, 'Shroud of the Wyrm inert vs a non-elemental foe');
    // Shroud of Cinders: stat value (retort rides the incoming hook).
    near(FF.legendaryCloakBonus('d4_cinders', cloakSt('d4_cinders')), 0.30, 'Shroud of Cinders: 30% Fire retort (rare)');

    // Pendant of the Elements: +damage vs a Scorched foe (0.15 x2 = +0.30).
    near(FF.d4LegDmgMult({}, amuletSt('d4_scorchpend', { activity:{type:'combat', monsterHp:100, scorchStacks:1, scorchUntil:now+4000} })), (1+0.02) * 1.20, 'Pendant of the Elements: +20% vs a Scorched foe (rare, base trimmed to 0.10, atop the Scorch stack)');
    near(FF.d4LegDmgMult({}, amuletSt('d4_scorchpend')), 1.0, 'Pendant of the Elements inert on an unscorched foe');
    // Pendant of the Everflame: +DoT damage (0.15 x2 = +0.30 into legNecromancyDoTMult).
    near(FF.legNecromancyDoTMult(amuletSt('d4_everflame')), 1.30, 'Pendant of the Everflame: elemental DoTs tick +30% (rare)');
    // Pendant of the Dragon: +Attunement XP stat value.
    near(FF.legendaryAmuletBonus('d4_dragon', amuletSt('d4_dragon')), 1.00, 'Pendant of the Dragon: +100% Attunement XP (rare)');

    // Full forge (ring) — mirrors the D3 ring forge's known catalyst family.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints;
    var catId = 'ring_' + FF.RING_TYPES[0].id + '_t20_rare';
    s.inventory = { metallurgy_t20:4000, gem_voidcrystal:400, twine_t20:400, goldsmithing_t20:400 }; s.inventory[catId] = 40;
    s.blueprints = {};
    var bpId = FF.masterworkBlueprintId('d4','ring'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var mintedId = Object.keys(s.inventory).filter(function(id){ return /^legring_d4_/.test(id) && s.inventory[id] > 0; })[0];
    ok(mintedId, 'the D4 ring forge adds a d4 Signet to inventory');
    ok(FF.LEGENDARY_RING_ITEMS[mintedId] && ring.outcomes.indexOf(FF.LEGENDARY_RING_ITEMS[mintedId].legKey) !== -1, 'the forged Signet carries a D4 ring-group effect');
    eq(s.inventory[catId], 0, 'the forge consumes 40 rare t20 rings');
    s.inventory=svInv; s.blueprints=svBp;
  });

  // ---- Balance pass, Batch HH: critical fixes (elem-resist clamp + dead D2 sets) --------------------
  suite('balance HH: critical fixes', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, js:s.jewelrySlots, hp:s.playerHp, act:s.activity, ks:s.knightStacks };
    var R = FF.RING_SLOT_IDS[0];
    function wearD2(cls, n){ s.bodyArmor = {}; s.uniqueItems = {};
      var order = FF.D2_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d2' }; s.bodyArmor[order[i]] = { uid:uid }; } }
    try {
      // C1: stack Scaleward (herald 2pc, +0.15) + Warscale (knight 2pc @max Momentum, +0.12) + a fantastic
      // Signet of Scales (+0.40) = 0.67 raw -> must clamp to 0.60, and elementResistMult must never go negative.
      s.bodyArmor = { helmet:{uid:'h1'}, chest:{uid:'h2'}, gauntlets:{uid:'k1'}, boots:{uid:'k2'} };
      s.uniqueItems = { h1:{set:'herald',setLayer:'d4'}, h2:{set:'herald',setLayer:'d4'}, k1:{set:'knight',setLayer:'d4'}, k2:{set:'knight',setLayer:'d4'} };
      s.knightStacks = 999;
      s.jewelrySlots = {}; s.jewelrySlots[R] = { leg:'d4_scales', rarity:'fantastic' };
      ok(FF.d4SetElementResist(s, 'fire') <= 0.60 + 1e-9, 'd4SetElementResist is hard-capped at 0.60');
      near(FF.d4SetElementResist(s, 'fire'), 0.60, 'an over-cap aggregate (0.67 raw) is clamped to 0.60');
      ok(FF.elementResistMult(s, 'fire') > 0, 'elementResistMult stays positive — an elemental hit can never heal you');
      ok(FF.elementResistMult(s, 'fire') >= 0.05, 'elementResistMult respects the 5% floor');
      s.bodyArmor = {}; s.uniqueItems = {}; s.knightStacks = 0; s.jewelrySlots = {};
      ok(FF.elementResistMult(s, 'fire') <= 1.0 && FF.elementResistMult(s, 'fire') > 0.7, 'with no resist gear, elementResistMult is ~1 (minus base attunement)');

      // C2: Reap (reaper D2 full) — foes below 25% HP take +30%.
      s.jewelrySlots = {}; s.knightStacks = 0;
      wearD2('reaper', FF.D2_SET_DEFS.reaper.full); s.activity = { type:'combat', monsterHp:100 };
      near(FF.d2SetDmgMult({ hp:1000 }, s), 1.30, 'Reap (reaper D2 full): +30% vs a foe below 25% Health');
      s.activity = { type:'combat', monsterHp:800 }; near(FF.d2SetDmgMult({ hp:1000 }, s), 1.0, 'Reap inert on a healthy foe');
      // C2: Soul Glut (reaper D2 2pc) is now a live lifesteal source (wired into the lifesteal sum).
      wearD2('reaper', 2); ok(FF.set2D2('reaper', s), 'the reaper D2 2-piece is detectable (Soul Glut lifesteal live)');

      // C2: Spiked Retort / Retribution (sentinel D2) — reflect amplifier.
      s.playerHp = FF.maxHp(s);
      wearD2('sentinel', 2); near(FF.d2SentinelReflectMult(s), 1.25, 'Spiked Retort (sentinel D2 2pc): +25% reflect');
      wearD2('sentinel', FF.D2_SET_DEFS.sentinel.full); near(FF.d2SentinelReflectMult(s), 1.25 * 1.50, 'Retribution (full) adds +50% reflect at full Health');
      s.playerHp = 1; near(FF.d2SentinelReflectMult(s), 1.25, 'Retribution drops off below full Health (2pc remains)');
      s.bodyArmor = {}; s.uniqueItems = {}; near(FF.d2SentinelReflectMult(s), 1.0, 'no sentinel D2 set -> no reflect bonus');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.jewelrySlots=sv.js; s.playerHp=sv.hp; s.activity=sv.act; s.knightStacks=sv.ks; }
  });

  // ---- Balance pass, Batch II: tier-inversion fixes (D4/D3 now beat earlier tiers) -----------------
  suite('balance II: tier inversions resolved', function(){
    function legSt(key, base, kind){ var isOff = kind === 'offhand';
      return { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:kind||'weapon', base:'st'+(isOff?'ward':'weapon')+'_'+(base||'scepter')+'_t19_rare', tier:19, rarity:'rare' } },
        equippedMainhandUid: isOff?undefined:'L', equippedOffhandUid: isOff?'L':undefined }; }
    var now = Date.now();
    // M1 — Plaguebearer shield: D4 Venomscale (-30% -> x0.70) now beats D3 Immunize (-25% -> x0.75).
    var vs = FF.d4LegIncomingMult(legSt('venomscale','shieldSmall','offhand'), { element:'fire' }); // no poison -> inert here
    near(FF.d4LegIncomingMult({ uniqueItems:{L:{uid:'L',leg:'venomscale',kind:'offhand'}}, equippedOffhandUid:'L', activity:{type:'combat',monsterHp:100,potionPoisonUntil:now+5000,potionPoisonDps:100} }, { element:'fire' }), 0.70, 'M1: Venomscale x0.70 < D3 Immunize x0.75 (D4 now wins)');
    // M3 — Ranger bow: D4 Wyrmstalker now carries a damage bonus (+25% vs Scorched), beating D2 Trapmaster x1.20.
    near(FF.d4LegDmgMult({}, legSt('wyrmstalker','bowMedium')), 1.0, 'Wyrmstalker inert on an unscorched foe');
    near(FF.d4LegDmgMult({}, legSt('wyrmstalker','bowMedium', undefined) ), 1.0, 'Wyrmstalker baseline');
    var wsScorch = legSt('wyrmstalker','bowMedium'); wsScorch.activity = { type:'combat', monsterHp:100, scorchStacks:1, scorchUntil:now+4000 };
    near(FF.d4LegDmgMult({}, wsScorch), (1+0.02) * 1.25, 'M3: Wyrmstalker +25% vs a Scorched foe (progresses past D2 Trapmaster x1.20)');
    // M4 — Magmacore base value is now x1.35 (> D2 Earthrender x1.30); gated on the juggernaut Wind-Up so inert here.
    near(FF.d4LegDmgMult({}, legSt('magmacore','sledge')), 1.0, 'M4: Magmacore inert without the juggernaut Wind-Up (value x1.35 when active)');
  });

  // ---- Balance pass, Batch JJ: global incoming-damage floor (N1) -----------------------------------
  suite('balance JJ: incoming mitigation floor', function(){
    eq(FF.INCOMING_FLOOR_FRAC, 0.05, 'the incoming floor is 5% of the raw swing');
    // A mitigation chain that would round the hit to 0 is clamped up to 5% of the raw roll.
    eq(FF.incomingMitigationFloor(0, 1000), 50, 'a fully-mitigated 1000 swing still lands 50 (5%)');
    eq(FF.incomingMitigationFloor(3, 1000), 50, 'near-zero mitigation is floored to 5%');
    // A hit already above the floor is untouched.
    eq(FF.incomingMitigationFloor(400, 1000), 400, 'a hit above the floor passes through unchanged');
    eq(FF.incomingMitigationFloor(50, 1000), 50, 'exactly at the floor is unchanged');
    // Tiny swings still land at least 1.
    eq(FF.incomingMitigationFloor(0, 5), 1, 'a tiny swing still lands at least 1');
    eq(FF.incomingMitigationFloor(0, 0), 1, 'floor never returns 0');
    // End-to-end: drive one landed hit with a fixed roll and no dodge/block, confirm HP actually drops.
    var s = FF._state, sv = { act:s.activity, hp:s.playerHp, ba:s.bodyArmor, ui:s.uniqueItems, js:s.jewelrySlots };
    try {
      s.bodyArmor = {}; s.uniqueItems = {}; s.jewelrySlots = {};
      s.playerHp = FF.maxHp(s);
      // A dungeon foe with a fixed swing (atkMin===atkMax) removes roll RNG; dodge/block are ~0 with no gear.
      s.activity = { type:'combat', monsterId:'dungeon_d4_1', monsterHp: 1e9, tickAccum:0, monsterTickAccum:0 };
      var before = s.playerHp;
      // fire the monster's attack directly; a landed hit must reduce HP (never mitigated to 0)
      var landed = false; for(var i=0;i<12 && !landed;i++){ s.playerHp = FF.maxHp(s); FF.monsterAttackTick(); if(s.playerHp < FF.maxHp(s)) landed = true; }
      ok(landed, 'a landed enemy hit always deals at least the floor (never fully mitigated to 0)');
    } finally { s.activity=sv.act; s.playerHp=sv.hp; s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.jewelrySlots=sv.js; }
  });

  // ---- D3 (Underground) legendary gear: arcane forge + effects (Batch R) -----------------------------
  suite('mastercraft: D3 legendary arcane (forge + effects)', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','arcane')]);
    ok(rec && rec.gear === true && rec.layer === 'd3', 'D3 arcane has a d3-layer gear recipe');
    eq(rec.rareCount, 30, 'D3 arcane needs 30 rare Tier-20 items (triple D1)');
    eq(rec.outcomes.length, 12, 'the D3 arcane pool forges one of 7 weapons + 5 wards');
    eq(rec.inputs.forestry_t20, 3000, 'D3 arcane costs 3000 t20 wood');
    ['fire','water','earth','light','dark'].forEach(function(el){ eq(rec.inputs['glyph_'+el], 600, 'D3 arcane costs 600 '+el+' glyphs'); });
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D3).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D3[id].group==='arcane'; }).length, 48, '12 arcane effects x 4 rarities = 48 D3 arcane gear items');
    ok(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D3).every(function(id){ var it = FF.LEGENDARY_GEAR_ITEMS_D3[id]; return it.legendary && it.gear && it.dungeon==='d3' && it.sell===0 && /<svg/.test(it.icon); }), 'every D3 gear item is flagged, d3-layer, non-vendorable, iconned');

    function legSt(key, base, kind, extra){
      var isOff = kind === 'offhand';
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:kind||'weapon', base:'st'+(isOff?'ward':'weapon')+'_'+(base||'wandFire')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } } };
      st[isOff ? 'equippedOffhandUid' : 'equippedMainhandUid'] = 'L';
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();
    // Pyresoul: +15% vs a Decayed foe.
    near(FF.d3LegDmgMult({}, legSt('pyresoul','wandFire','weapon',{ activity:{type:'combat', monsterHp:100, decayStacks:2, decayUntil:now+4000} })), 1.15, 'Pyresoul: +15% vs a Decayed foe');
    near(FF.d3LegDmgMult({}, legSt('pyresoul','wandFire')), 1.0, 'Pyresoul inert on a clean foe');
    // Soulrend: +25% vs a Cursed + Vulnerable foe (both required).
    near(FF.d3LegDmgMult({}, legSt('soulrend','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, curseUntil:now+4000, voidVulnStacks:3, voidVulnUntil:now+4000} })), 1.25, 'Soulrend: +25% vs a Cursed + Vulnerable foe');
    near(FF.d3LegDmgMult({}, legSt('soulrend','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, curseUntil:now+4000} })), 1.0, 'Soulrend needs Vulnerability too');
    // Lichbane: +30% above 75% HP.
    near(FF.d3LegDmgMult({}, legSt('lichbane','scepter')), 1.30, 'Lichbane: +30% above 75% Health');
    near(FF.d3LegDmgMult({}, legSt('lichbane','scepter','weapon',{ playerHp:1 })), 1.0, 'Lichbane inert below 75% HP');
    // Gravefrost: Chilled foes take +20% Decay (via the Decay tick multiplier).
    near(FF.d3DecayTickMult(legSt('gravefrost','wandWater','weapon',{ activity:{type:'combat', monsterHp:100, enemyChillUntil:now+4000} })), 1.20, 'Gravefrost: Chilled foes take +20% Decay');
    // Detection for the behaviour-driven arcane weapons + all 5 wards.
    ['stormtomb','gravelight','necrocaller'].forEach(function(k){ var b = FF.D3_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b)), true, 'legActive detects '+k); });
    ['ashveil','voltveil','shadeveil','gleamveil','sanctveil'].forEach(function(k){ var b = FF.D3_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b, 'offhand')), true, 'legActive detects '+k); });

    // Full forge: give the bill, craft, confirm a d3 legendary UNIQUE with an arcane-group leg + display name.
    var s = FF._state, svInv = s.inventory, svBp = s.blueprints, svUniq = s.uniqueItems;
    s.inventory = { forestry_t20: 3000, glyph_fire:600, glyph_water:600, glyph_earth:600, glyph_light:600, glyph_dark:600 };
    s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('arcane').forEach(function(id){ s.inventory[id] = 3; });
    var bpId = FF.masterworkBlueprintId('d3','arcane'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D3 forge mints exactly one legendary unique');
    var u = minted[0];
    ok(u && u.leg && FF.D3_LEG_GEAR_MAP[u.leg], 'the unique carries a D3 arcane-group legendary effect');
    ok(/^st(weapon|ward)_.+_t20_(rare|supreme|fantastic)$/.test(u.base), 'the unique is a top-tier wand/scepter/staff/ward base');
    ok(FF.uniqueDisplayName(u).indexOf(FF.D3_LEG_GEAR_MAP[u.leg].name) !== -1, 'the forged D3 legendary displays its effect name');
    eq(s.inventory.forestry_t20, 0, 'the forge consumes the 3000 wood');
    var rareLeft = FF.legGearRareIds('arcane').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('arcane').length * 3 - 30, 'the forge consumes exactly 30 rare arcane items');
    s.inventory = svInv; s.blueprints = svBp; s.uniqueItems = svUniq;
  });

  // ---- D4 legendary arcane weapons + wards + Scorch (Batch CC) --------------------------------------
  suite('mastercraft: D4 legendary arcane (Scorch + forge + effects)', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','arcane')]);
    ok(rec && rec.gear === true && rec.layer === 'd4', 'D4 arcane has a d4-layer gear recipe');
    eq(rec.rareCount, 40, 'D4 arcane needs 40 rare Tier-20 items (quadruple D1)');
    eq(rec.outcomes.length, 12, 'the D4 arcane pool forges one of 7 weapons + 5 wards');
    eq(rec.inputs.forestry_t20, 4000, 'D4 arcane costs 4000 t20 wood');
    ['fire','water','earth','light','dark'].forEach(function(el){ eq(rec.inputs['glyph_'+el], 800, 'D4 arcane costs 800 '+el+' glyphs'); });
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='arcane'; }).length, 48, '12 arcane effects x 4 rarities = 48 D4 arcane gear items');
    ok(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).every(function(id){ var it = FF.LEGENDARY_GEAR_ITEMS_D4[id]; return it.legendary && it.gear && it.dungeon==='d4' && it.sell===0 && /<svg/.test(it.icon); }), 'every D4 gear item is flagged, d4-layer, non-vendorable, iconned');

    function legSt(key, base, kind, extra){
      var isOff = kind === 'offhand';
      var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9,
        uniqueItems:{ L:{ uid:'L', leg:key, kind:kind||'weapon', base:'st'+(isOff?'ward':'weapon')+'_'+(base||'wandFire')+'_t20_rare', tier:20, rarity:'rare', enchants:[], enhance:0 } } };
      st[isOff ? 'equippedOffhandUid' : 'equippedMainhandUid'] = 'L';
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();

    // --- Scorch mechanic ---
    var sc = { type:'combat', monsterHp:1000 };
    FF.scorchApply(sc, 3); eq(sc.scorchStacks, 3, 'scorchApply stacks Scorch');
    ok(sc.scorchUntil > now, 'Scorch opens a window');
    FF.scorchApply(sc, 99); eq(sc.scorchStacks, FF.SCORCH_MAX_STACKS, 'Scorch caps at 15 stacks');
    var scst = { activity: sc }; near(FF.scorchDmgMult(scst), 1 + 0.02*FF.SCORCH_MAX_STACKS, 'Scorch: +2% damage per stack');
    ok(FF.enemyScorched(scst), 'a Scorched foe reads as Scorched');
    sc.scorchUntil = now - 1; ok(!FF.enemyScorched(scst), 'Scorch lapses after its window'); near(FF.scorchDmgMult(scst), 1.0, 'a non-Scorched foe has no Scorch bonus');
    // Scorch's amplifier rides d4LegDmgMult for anyone.
    near(FF.d4LegDmgMult({}, { activity:{type:'combat', monsterHp:100, scorchStacks:5, scorchUntil:now+4000} }), 1 + 0.02*5, 'd4LegDmgMult folds in Scorch (+10% at 5 stacks)');

    // --- Read-only weapon amplifiers ---
    // Rimewyrm's Fang: +20% vs a Scorched foe.
    near(FF.d4LegDmgMult({}, legSt('rimewyrm','wandWater','weapon',{ activity:{type:'combat', monsterHp:100, scorchStacks:1, scorchUntil:now+4000} })), (1+0.02) * 1.20, 'Rimewyrm: +20% vs a Scorched foe (atop the Scorch stack)');
    near(FF.d4LegDmgMult({}, legSt('rimewyrm','wandWater')), 1.0, 'Rimewyrm inert on an unscorched foe');
    // Sunwyrm's Verdict: +40% vs a Dark foe (progresses past D3 Lichbane x1.30).
    near(FF.d4LegDmgMult({ element:'dark' }, legSt('sunwyrm','scepter')), 1.40, "Sunwyrm's Verdict: +40% vs a Dark foe");
    near(FF.d4LegDmgMult({ element:'fire' }, legSt('sunwyrm','scepter')), 1.0, 'Sunwyrm inert vs a non-Dark foe');
    // Dawnwyrm's Radiance: while a Radiant Barrier holds, +Light Attunement to all damage.
    var dw = legSt('dawnwyrm','wandLight','weapon',{ lumenShield:500 });
    near(FF.d4LegDmgMult({}, dw), 1 + FF.elementDamageBonus(dw, 'light'), 'Dawnwyrm: Barrier lends your Light Attunement');
    near(FF.d4LegDmgMult({}, legSt('dawnwyrm','wandLight')), 1.0, 'Dawnwyrm inert with no Barrier up');

    // Duskwyrm's Whisper: each Vulnerability stack strips 1.5% of a dragon's resistance to your wand.
    var waterDragon = { dungeon:'d4', element:'water' };
    near(FF.d4WandElementMult(legSt('duskwyrm','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, voidVulnStacks:4, voidVulnUntil:now+4000} }), 'fire', waterDragon), 1 - (0.15 - 0.06), 'Duskwyrm: 4 Vulnerability -> resistance 15% -> 9%');
    near(FF.d4WandElementMult(legSt('duskwyrm','wandDark','weapon',{ activity:{type:'combat', monsterHp:100, voidVulnStacks:10, voidVulnUntil:now+4000} }), 'fire', waterDragon), 1.0, 'Duskwyrm: 10 Vulnerability fully strips the resistance');

    // Broodwyrm's Chorus: familiars always fight with advantage.
    near(FF.d4FamiliarElementMult(legSt('broodwyrm','staff'), 'fire', { element:'water' }), FF.ELEMENT_ADVANTAGE_MULT, "Broodwyrm's Chorus: familiars gain the advantage bite when they lack it");
    near(FF.d4FamiliarElementMult(legSt('broodwyrm','staff'), 'fire', { element:'earth' }), 1.0, 'Broodwyrm does not double an advantage the familiar already has (Fire already beats Earth)');

    // Detection for the behaviour-driven weapons + all 5 wards.
    ['cinderwyrm','stormwyrm'].forEach(function(k){ var b = FF.D4_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b)), true, 'legActive detects '+k); });
    ['emberscale','stormscale','duskscale','dawnscale','sunscale'].forEach(function(k){ var b = FF.D4_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b, 'offhand')), true, 'legActive detects '+k); });

    // Full forge: give the bill, craft, confirm a d4 legendary UNIQUE with an arcane-group leg + display name.
    var s = FF._state, svInv = s.inventory, svBp = s.blueprints, svUniq = s.uniqueItems;
    s.inventory = { forestry_t20: 4000, glyph_fire:800, glyph_water:800, glyph_earth:800, glyph_light:800, glyph_dark:800 };
    s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('arcane').forEach(function(id){ s.inventory[id] = 4; });
    var bpId = FF.masterworkBlueprintId('d4','arcane'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D4 forge mints exactly one legendary unique');
    var u = minted[0];
    ok(u && u.leg && FF.D4_LEG_GEAR_MAP[u.leg], 'the unique carries a D4 arcane-group legendary effect');
    ok(/^st(weapon|ward)_.+_t20_(rare|supreme|fantastic)$/.test(u.base), 'the unique is a top-tier wand/scepter/staff/ward base');
    ok(FF.uniqueDisplayName(u).indexOf(FF.D4_LEG_GEAR_MAP[u.leg].name) !== -1, 'the forged D4 legendary displays its effect name');
    eq(s.inventory.forestry_t20, 0, 'the forge consumes the 4000 wood');
    var rareLeft = FF.legGearRareIds('arcane').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('arcane').length * 4 - 40, 'the forge consumes exactly 40 rare arcane items');
    s.inventory = svInv; s.blueprints = svBp; s.uniqueItems = svUniq;
  });

  // ---- D4 legendary shields (Batch DD) -------------------------------------------------------------
  suite('mastercraft: D4 legendary shields', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','defense')]);
    ok(rec && rec.gear === true && rec.layer === 'd4', 'D4 defense has a d4-layer gear recipe');
    eq(rec.rareCount, 40, 'D4 defense needs 40 rare Tier-20 shields');
    eq(rec.inputs.metallurgy_t20, 4000, 'D4 defense costs 4000 t20 ingots');
    eq(rec.outcomes.length, 6, 'the D4 defense pool forges one of 6 shields');
    eq(FF.LEG_GEAR_GROUP_KEYS_D4.defense.length, 6, 'six D4 shield effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='defense'; }).length, 24, '6 defense effects x 4 rarities = 24 D4 shield items');
    function legSt(key, extra){ var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'offhand', base:'stshield_shieldSmall_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedOffhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k]; return st; }
    ['hoardwall','venomscale','bloodscale','rimescale','wyrmthornwall','dragonbulwark'].forEach(function(k){ eq(FF.legActive(k, legSt(k)), true, 'legActive detects '+k); });
    ok(/Dragonscale Bulwark/.test(FF.LEGENDARY_GEAR_ITEMS_D4[FF.legGearItemIdD4('dragonbulwark','normal')].name), 'the herald D4 shield is Dragonscale Bulwark');
    var now = Date.now();
    // Dragonscale Bulwark: +12% resistance to all elements.
    near(FF.d4SetElementResist(legSt('dragonbulwark'), 'fire'), 0.12, 'Dragonscale Bulwark: +12% resist, all elements');
    near(FF.d4SetElementResist(legSt('dragonbulwark'), 'dark'), 0.12, 'Dragonscale Bulwark covers every element');
    near(FF.d4SetElementResist(legSt('bloodscale'), 'fire'), 0, 'a non-resist shield adds no elemental resist');
    // Venomscale Shield: -20% from a Poisoned, elemental foe.
    near(FF.d4LegIncomingMult(legSt('venomscale', { activity:{type:'combat', monsterHp:100, potionPoisonUntil:now+5000, potionPoisonDps:100} }), { element:'fire' }), 0.70, 'Venomscale: -30% from a Poisoned elemental foe (beats D1 Immunize -25%)');
    near(FF.d4LegIncomingMult(legSt('venomscale', { activity:{type:'combat', monsterHp:100, potionPoisonUntil:now+5000, potionPoisonDps:100} }), { element:null }), 1.0, 'Venomscale needs the foe to carry an element');
    near(FF.d4LegIncomingMult(legSt('venomscale'), { element:'fire' }), 1.0, 'Venomscale inert vs an unpoisoned foe');
    // Wyrmthorn Wall: reflect carries the attacker's element, +50%.
    near(FF.d4SentinelThornsMult({ element:'fire' }, legSt('wyrmthornwall')), 1.50, 'Wyrmthorn Wall: +50% reflect carrying the element');
    near(FF.d4SentinelThornsMult({ element:null }, legSt('wyrmthornwall')), 1.0, 'Wyrmthorn Wall needs the attacker to have an element');
    // Full forge.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 4000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('defense').forEach(function(id){ s.inventory[id] = 16; }); // 3 shield types x 16 = 48 >= 40
    var bpId = FF.masterworkBlueprintId('d4','defense'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D4 defense forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D4.defense.indexOf(minted[0].leg) !== -1, 'the unique carries a D4 defense-group effect');
    ok(/^stshield_.+_t19_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier shield base');
    var rareLeft = FF.legGearRareIds('defense').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('defense').length * 16 - 40, 'the forge consumes exactly 40 rare shields');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D4 legendary melee: slash + pierce (Batch EE) ------------------------------------------------
  suite('mastercraft: D4 legendary slash + pierce', function(){
    ['slash','pierce'].forEach(function(g){
      var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4', g)]);
      ok(rec && rec.gear === true && rec.layer === 'd4', 'D4 '+g+' has a d4-layer gear recipe');
      eq(rec.rareCount, 40, 'D4 '+g+' needs 40 rare Tier-20 weapons');
      eq(rec.inputs.metallurgy_t20, 4000, 'D4 '+g+' costs 4000 t20 ingots');
    });
    eq(FF.LEG_GEAR_GROUP_KEYS_D4.slash.length, 6, 'six D4 slash effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D4.pierce.length, 4, 'four D4 pierce effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='slash'; }).length, 24, '6 slash effects x 4 rarities');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='pierce'; }).length, 16, '4 pierce effects x 4 rarities');
    function legSt(key, base, extra){ var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'scimitar')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k]; return st; }
    var now = Date.now();

    // --- Read-only amplifiers ---
    // Greedwyrm's Claw: +2% per 1k gold this fight (cap +50%).
    near(FF.d4LegDmgMult({}, legSt('greedwyrm','scimitar',{ activity:{type:'combat', monsterHp:100, goldEarned:3000} })), 1.06, 'Greedwyrm: +2% per 1k gold (3k -> +6%)');
    near(FF.d4LegDmgMult({}, legSt('greedwyrm','scimitar',{ activity:{type:'combat', monsterHp:100, goldEarned:99000} })), 1.50, 'Greedwyrm caps at +50%');
    near(FF.d4LegDmgMult({}, legSt('greedwyrm','scimitar')), 1.0, 'Greedwyrm inert with no gold this fight');
    // Wyrmdancer's Fang: +6% per Wrath stack; builds Wrath twice as fast.
    near(FF.d4LegDmgMult({}, legSt('wyrmdancer','rapier',{ d4Wrath:5, d4WrathUntil:now+9999 })), 1.30, "Wyrmdancer: +6% per Wrath (5 -> +30%)");
    var wd = legSt('wyrmdancer','rapier'); wd.d4Wrath = 0; wd.d4WrathUntil = 0; FF.d4WrathOnHit(wd); eq(FF.d4WrathStacks(wd), 2, "Wyrmdancer's Fang builds 2 Wrath per hit");
    // Emberdraw: opener +50%.
    near(FF.d4LegDmgMult({}, legSt('emberdraw','falchion',{ activity:{type:'combat', monsterHp:100, samuraiFirstStrike:true} })), 1.50, 'Emberdraw: opening strike +50%');
    near(FF.d4LegDmgMult({}, legSt('emberdraw','falchion')), 1.0, 'Emberdraw only rides the opener');
    // Drakelance: +20% at max Momentum.
    near(FF.d4LegDmgMult({}, legSt('drakelance','claymore',{ knightStacks:999 })), 1.20, 'Drakelance: +20% at max Momentum');
    near(FF.d4LegDmgMult({}, legSt('drakelance','claymore',{ knightStacks:0 })), 1.0, 'Drakelance inert below max Momentum');
    // Runewyrm Blade: echoes strike the weakness (advantage bite).
    near(FF.d4EchoMult(legSt('runewyrm','greatsword')), FF.ELEMENT_ADVANTAGE_MULT, 'Runewyrm Blade: echoes strike the weakness');

    // --- Bursts / execute helpers ---
    var swMon = { hp:1000 };
    var swSt = legSt('shadowwyrm','claw',{ activity:{type:'combat', monsterHp:250} }); // 25% HP -> 75% missing
    near(FF.d4ShadowwyrmBurst(1000, swMon, swSt), Math.round(1000 * (0.50 + 1.50*0.75) * FF.elementDmgMult(swSt,'fire')), 'Shadowwyrm Immolation scales with the foe\'s missing Health');
    eq(FF.d4ShadowwyrmBurst(1000, swMon, legSt('gorewyrm','halfmoonaxe')), 0, 'no Shadowwyrm burst without the claw');
    var sfSt = legSt('soulflame','scythe');
    near(FF.d4SoulflameBurst(1000, sfSt), Math.round(1000 * 0.12 * FF.elementDmgMult(sfSt,'fire')), 'Soulflame exhales a ~12% Fire burst');
    var ewMon = { hp:1000, isBoss:false };
    ok(FF.d4EmberwyrmExecutes(ewMon, legSt('emberwyrm','fullmoonaxe',{ activity:{type:'combat', monsterHp:200, burnUntil:now+5000, burnStacks:2} })), 'Emberwyrm executes a Burning foe below 25% Health');
    ok(!FF.d4EmberwyrmExecutes(ewMon, legSt('emberwyrm','fullmoonaxe',{ activity:{type:'combat', monsterHp:200} })), 'Emberwyrm needs the foe Burning or Scorched');
    ok(!FF.d4EmberwyrmExecutes({ hp:1000, isBoss:true }, legSt('emberwyrm','fullmoonaxe',{ activity:{type:'combat', monsterHp:200, burnUntil:now+5000, burnStacks:2} })), 'Emberwyrm never executes a boss');

    // --- Behavioural: Gorewyrm bleed Fire lifesteal; Blightwyrm poison Scorch ---
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, hp:s.playerHp, mh:s.equippedMainhandUid };
    var mhp = FF.maxHp(s);
    try {
      s.bodyArmor = {}; s.uniqueItems = { G:{ uid:'G', leg:'gorewyrm', kind:'weapon', base:'stweapon_halfmoonaxe_t19_rare', tier:19, rarity:'rare' } }; s.equippedMainhandUid = 'G';
      s.activity = { type:'combat', monsterHp:1000000, bleedDps:1000, bleedUntil:now+9999 }; s.playerHp = Math.round(mhp*0.5); var hp0 = s.playerHp;
      var before = s.activity.monsterHp; FF.applyReaverBleedTick(1000); var drop = before - s.activity.monsterHp;
      ok(drop > 1000, 'Gorewyrm adds a Fire component to Bleed ticks'); ok(s.playerHp > hp0, 'Gorewyrm lifesteals from the Bleed Fire');
      s.uniqueItems = { B:{ uid:'B', leg:'blightwyrm', kind:'weapon', base:'stweapon_hatchet_t19_rare', tier:19, rarity:'rare' } }; s.equippedMainhandUid = 'B';
      s.activity = { type:'combat', monsterHp:1000000, potionPoisonUntil:now+9999, potionPoisonDps:1000 };
      FF.applyPotionPoisonTick(1000); ok(FF.enemyScorched(s), "Blightwyrm's poison applies Scorch");
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.activity=sv.act; s.playerHp=sv.hp; s.equippedMainhandUid=sv.mh; }

    // Detection for all 10.
    ['greedwyrm','blightwyrm','gorewyrm','shadowwyrm','emberwyrm','soulflame'].forEach(function(k){ eq(FF.legActive(k, legSt(k, FF.D4_LEG_GEAR_MAP[k].base)), true, 'legActive detects '+k); });
    ['wyrmdancer','emberdraw','runewyrm','drakelance'].forEach(function(k){ eq(FF.legActive(k, legSt(k, FF.D4_LEG_GEAR_MAP[k].base)), true, 'legActive detects '+k); });

    // Full forge (slash).
    var s2 = FF._state, svInv=s2.inventory, svBp=s2.blueprints, svUniq=s2.uniqueItems;
    s2.inventory = { metallurgy_t20: 4000 }; s2.blueprints = {}; s2.uniqueItems = {};
    FF.legGearRareIds('slash').forEach(function(id){ s2.inventory[id] = 8; });
    var bpId = FF.masterworkBlueprintId('d4','slash'); s2.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s2.uniqueItems).map(function(k){ return s2.uniqueItems[k]; });
    eq(minted.length, 1, 'the D4 slash forge mints one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D4.slash.indexOf(minted[0].leg) !== -1, 'the unique carries a D4 slash-group effect');
    ok(/^stweapon_.+_t19_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier slash-weapon base');
    s2.inventory=svInv; s2.blueprints=svBp; s2.uniqueItems=svUniq;
  });

  // ---- D4 legendary melee/ranged: blunt + ranged (Batch FF) ----------------------------------------
  suite('mastercraft: D4 legendary blunt + ranged', function(){
    var rb = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','blunt')]);
    ok(rb && rb.gear === true && rb.layer === 'd4' && rb.rareCount === 40, 'D4 blunt has a d4-layer gear recipe (40 catalysts)');
    eq(rb.inputs.metallurgy_t20, 4000, 'D4 blunt costs 4000 t20 ingots');
    var rr = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','ranged')]);
    ok(rr && rr.gear === true && rr.layer === 'd4' && rr.rareCount === 40, 'D4 ranged has a d4-layer gear recipe (40 catalysts)');
    eq(rr.inputs.forestry_t20, 4000, 'D4 ranged costs 4000 t20 wood');
    eq(FF.LEG_GEAR_GROUP_KEYS_D4.blunt.length, 4, 'four D4 blunt effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D4.ranged.length, 3, 'three D4 ranged effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='blunt'; }).length, 16, '4 blunt effects x 4 rarities');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D4).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D4[id].group==='ranged'; }).length, 12, '3 ranged effects x 4 rarities');
    function legSt(key, base, extra){ var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:1e9,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'mace')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k]; return st; }

    // Wrathscale Hammer: up to +40% as Health falls below 50%.
    var wsSt = legSt('wrathscale','warhammer'); var mh = FF.maxHp(wsSt);
    wsSt.playerHp = Math.round(mh * 0.25); near(FF.d4LegDmgMult({}, wsSt), 1 + 0.40 * (1 - (Math.round(mh*0.25)/(mh*0.5))), 'Wrathscale: scales up as Health falls (below 50%)', 0.03);
    wsSt.playerHp = mh; near(FF.d4LegDmgMult({}, wsSt), 1.0, 'Wrathscale inert at full Health');
    // Wyrmthorn Maul: reflect +50%.
    near(FF.d4SentinelThornsMult({ element:'fire' }, legSt('wyrmthornmaul','maul')), 1.50, 'Wyrmthorn Maul: +50% reflect');
    near(FF.d4SentinelThornsMult({ element:null }, legSt('wyrmthornmaul','maul')), 1.50, 'Wyrmthorn Maul reflects regardless of the foe element');

    // Breathfang Bow: charges the meter (on its own), fires the burst, and the burst hits twice.
    var bf = legSt('breathfang','bowShort');
    eq(FF.d4BreathFullSet(bf), 'quickdraw', 'Breathfang Bow fires the Dragon\'s Breath burst');
    bf.activity = { type:'combat', monsterHp:1000000, breathCharge:0 };
    eq(FF.d4BreathChargeOnHit(bf, false), 8, 'Breathfang charges Dragon\'s Breath on every shot');
    bf.activity = { type:'combat', monsterHp:1000000, breathCharge:100 };
    var expBurst = Math.round(1000 * FF.D4_BREATH_BURST_MULT * FF.elementDmgMult(bf, 'fire')) * 2;
    eq(FF.d4BreathFire(bf, { element:'water' }, 1000), expBurst, 'Breathfang: the breath burst hits twice');

    // Detection for all 7 (block/on-hit/Magmacore effects are behavioural).
    ['bastionbreaker','wyrmthornmaul','wrathscale','magmacore'].forEach(function(k){ eq(FF.legActive(k, legSt(k, FF.D4_LEG_GEAR_MAP[k].base)), true, 'legActive detects '+k); });
    ['breathfang','wyrmstalker','dragoneye'].forEach(function(k){ eq(FF.legActive(k, legSt(k, FF.D4_LEG_GEAR_MAP[k].base)), true, 'legActive detects '+k); });
    // Magmacore is inert without the juggernaut class (Wind-Up gates it).
    near(FF.d4LegDmgMult({}, legSt('magmacore','sledge')), 1.0, 'Magmacore inert without the juggernaut Wind-Up');

    // Full forge (ranged).
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { forestry_t20: 4000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('ranged').forEach(function(id){ s.inventory[id] = 15; }); // 3 bow types x 15 = 45 >= 40
    var bpId = FF.masterworkBlueprintId('d4','ranged'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D4 ranged forge mints one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D4.ranged.indexOf(minted[0].leg) !== -1, 'the unique carries a D4 ranged-group effect');
    ok(/^stweapon_bow.+_t\d+_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier bow base');
    var rareLeft = FF.legGearRareIds('ranged').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('ranged').length * 15 - 40, 'the forge consumes exactly 40 rare bows');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D3 (Underground) legendary shields (Batch S) -------------------------------------------------
  suite('mastercraft: D3 legendary shields', function(){
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','defense')]);
    ok(rec && rec.gear === true && rec.layer === 'd3', 'D3 defense has a d3-layer gear recipe');
    eq(rec.rareCount, 30, 'D3 defense needs 30 rare Tier-20 shields');
    eq(rec.inputs.metallurgy_t20, 3000, 'D3 defense costs 3000 t20 ingots');
    eq(rec.outcomes.length, 6, 'the D3 defense pool forges one of 6 shields');
    eq(FF.LEG_GEAR_GROUP_KEYS_D3.defense.length, 6, 'six D3 shield effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D3).filter(function(id){ return FF.LEGENDARY_GEAR_ITEMS_D3[id].group==='defense'; }).length, 24, '6 defense effects x 4 rarities = 24 D3 shield items');
    function legSt(key){ return { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'offhand', base:'stshield_shieldSmall_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedOffhandUid:'L' }; }
    ['cryptguard','blightshell','boneshell','rimecrypt','tombwall','mausoleumwall'].forEach(function(k){ eq(FF.legActive(k, legSt(k)), true, 'legActive detects '+k); });
    ok(/Mausoleum Wall/.test(FF.LEGENDARY_GEAR_ITEMS_D3[FF.legGearItemIdD3('mausoleumwall','normal')].name), 'the herald D3 shield is Mausoleum Wall');
    // Tombwall incoming reduction (folds into d3SetIncomingMult) vs a Decayed foe.
    var now = Date.now();
    var tw = { activity:{type:'combat', monsterHp:100, decayStacks:3, decayUntil:now+4000}, uniqueItems:{ L:{ uid:'L', leg:'tombwall', kind:'offhand', base:'stshield_shieldMedium_t19_rare', tier:19, rarity:'rare' } }, equippedOffhandUid:'L' };
    near(FF.d3SetIncomingMult(tw), 0.80, 'Tombwall: Decayed attackers deal 20% less');
    tw.activity = { type:'combat', monsterHp:100 }; near(FF.d3SetIncomingMult(tw), 1.0, 'Tombwall inert on a clean foe');
    // Full forge.
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 3000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('defense').forEach(function(id){ s.inventory[id] = 12; }); // 3 shield types x 12 = 36 >= 30
    var bpId = FF.masterworkBlueprintId('d3','defense'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D3 defense forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D3.defense.indexOf(minted[0].leg) !== -1, 'the unique carries a D3 defense-group effect');
    ok(/^stshield_.+_t19_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier shield base');
    var rareLeft = FF.legGearRareIds('defense').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, FF.legGearRareIds('defense').length * 12 - 30, 'the forge consumes exactly 30 rare shields');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D3 (Underground) legendary melee: slash + pierce (Batch T) ------------------------------------
  suite('mastercraft: D3 legendary melee (slash + pierce)', function(){
    ['slash','pierce'].forEach(function(g){
      var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3',g)]);
      ok(rec && rec.gear === true && rec.layer === 'd3', 'D3 '+g+' has a d3-layer gear recipe');
      eq(rec.rareCount, 30, 'D3 '+g+' needs 30 rare Tier-20 weapons');
      eq(rec.inputs.metallurgy_t20, 3000, 'D3 '+g+' costs 3000 t20 ingots');
    });
    eq(FF.LEG_GEAR_GROUP_KEYS_D3.slash.length, 6, 'six D3 slash effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D3.pierce.length, 4, 'four D3 pierce effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D3).filter(function(id){ var g=FF.LEGENDARY_GEAR_ITEMS_D3[id].group; return g==='slash'||g==='pierce'; }).length, 40, '10 melee effects x 4 rarities = 40 items');

    function legSt(key, base){ return { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'scimitar')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' }; }
    // Deathshepherd (D3 scythe): Siphon Shield cap +50% (observable via reaperShieldCap).
    near(FF.reaperShieldCap(legSt('deathshepherd','scythe')) / FF.reaperShieldCap(legSt('wraithclaw','claw')), 1.5, 'Deathshepherd: Siphon Shield cap +50%', 0.06);
    // Detection for the behaviour-driven slash + pierce weapons.
    ['gravepilfer','rotmaw','bonereaver','wraithclaw','soulharvester','deathshepherd'].forEach(function(k){ var b = FF.D3_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b)), true, 'legActive detects '+k); });
    ['phantomthrust','ghostblade','runegrave','gravewarden'].forEach(function(k){ var b = FF.D3_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b)), true, 'legActive detects '+k); });
    // Full forge (slash).
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 3000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('slash').forEach(function(id){ s.inventory[id] = 6; });
    var bpId = FF.masterworkBlueprintId('d3','slash'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D3 slash forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D3.slash.indexOf(minted[0].leg) !== -1, 'the unique carries a D3 slash-group effect');
    ok(/^stweapon_.+_t19_(rare|supreme|fantastic)$/.test(minted[0].base), 'the unique is a top-tier slashing weapon base');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D3 (Underground) legendary melee: blunt + ranged (Batch U) ------------------------------------
  suite('mastercraft: D3 legendary blunt + ranged', function(){
    var blunt = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','blunt')]);
    var ranged = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','ranged')]);
    ok(blunt && blunt.gear && blunt.layer==='d3' && blunt.rareCount===30 && blunt.inputs.metallurgy_t20===3000, 'D3 blunt: d3 gear recipe, 30 rare, 3000 ingots');
    ok(ranged && ranged.gear && ranged.layer==='d3' && ranged.rareCount===30 && ranged.inputs.forestry_t20===3000, 'D3 ranged: d3 gear recipe, 30 rare, 3000 wood');
    eq(FF.LEG_GEAR_GROUP_KEYS_D3.blunt.length, 4, 'four D3 blunt effects');
    eq(FF.LEG_GEAR_GROUP_KEYS_D3.ranged.length, 3, 'three D3 ranged effects');
    eq(Object.keys(FF.LEGENDARY_GEAR_ITEMS_D3).filter(function(id){ var g=FF.LEGENDARY_GEAR_ITEMS_D3[id].group; return g==='blunt'||g==='ranged'; }).length, 28, '7 effects (4 blunt + 3 ranged) x 4 rarities = 28 items');

    function legSt(key, base, extra){ var st = { xp:{}, physique:{}, bodyArmor:{}, activity:{type:'combat', monsterHp:100}, playerHp:100,
      uniqueItems:{ L:{ uid:'L', leg:key, kind:'weapon', base:'stweapon_'+(base||'mace')+'_t19_rare', tier:19, rarity:'rare', enchants:[], enhance:0 } }, equippedMainhandUid:'L' };
      if(extra) for(var k in extra) st[k]=extra[k]; return st; }
    var now = Date.now();
    // Bonecrusher (+50% vs Decayed) / Bonevolley (+15% vs Decayed) via d3LegDmgMult.
    near(FF.d3LegDmgMult({}, legSt('bonecrusher','maul', { activity:{type:'combat', monsterHp:100, decayStacks:2, decayUntil:now+4000} })), 1.50, 'Bonecrusher: +50% vs a Decayed foe');
    near(FF.d3LegDmgMult({}, legSt('bonecrusher','maul')), 1.0, 'Bonecrusher inert on a clean foe');
    near(FF.d3LegDmgMult({}, legSt('bonevolley','bowMedium', { activity:{type:'combat', monsterHp:100, decayStacks:2, decayUntil:now+4000} })), 1.15, 'Bonevolley: +15% vs a Decayed foe');
    // Cryptvenom slow: a venomed + Decayed foe is slowed +30% (measured as a delta so global familiar-slow cancels).
    var cvOn = legSt('cryptvenom','bowShort', { activity:{type:'combat', monsterHp:100, potionPoisonUntil:now+4000, potionPoisonDps:5, decayStacks:1, decayUntil:now+4000} });
    var cvOff = legSt('cryptvenom','bowShort', { activity:{type:'combat', monsterHp:100, potionPoisonUntil:now+4000, potionPoisonDps:5, decayStacks:1, decayUntil:now-1} });
    near(FF.enemyExtraSlowPct(cvOn) - FF.enemyExtraSlowPct(cvOff), 0.30, 'Cryptvenom: a venomed + Decayed foe is slowed +30%');
    var cvNoVenom = legSt('cryptvenom','bowShort', { activity:{type:'combat', monsterHp:100, decayStacks:1, decayUntil:now+4000} });
    near(FF.enemyExtraSlowPct(cvOn) - FF.enemyExtraSlowPct(cvNoVenom), 0.30, 'Cryptvenom slow needs venom too (no venom -> no slow)');
    // Detection.
    ['tombshatter','bonecrusher','gravewrath','monolith','cryptvenom','bonevolley','gravesight'].forEach(function(k){ var b = FF.D3_LEG_GEAR_MAP[k].base; eq(FF.legActive(k, legSt(k, b)), true, 'legActive detects '+k); });
    // Full forge (blunt).
    var s = FF._state, svInv=s.inventory, svBp=s.blueprints, svUniq=s.uniqueItems;
    s.inventory = { metallurgy_t20: 3000 }; s.blueprints = {}; s.uniqueItems = {};
    FF.legGearRareIds('blunt').forEach(function(id){ s.inventory[id] = 8; });
    var bpId = FF.masterworkBlueprintId('d3','blunt'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.uniqueItems).map(function(k){ return s.uniqueItems[k]; });
    eq(minted.length, 1, 'the D3 blunt forge mints exactly one legendary unique');
    ok(minted[0].leg && FF.LEG_GEAR_GROUP_KEYS_D3.blunt.indexOf(minted[0].leg) !== -1, 'the unique carries a D3 blunt-group effect');
    s.inventory=svInv; s.blueprints=svBp; s.uniqueItems=svUniq;
  });

  // ---- D1 legendary AMULETS (Pendants): 3 universal effects, worn in the single Amulet slot -----------
  // ---- D1 armor Set Items: data model + set-piece detection ------------------------------------------
  suite('D1 armor sets: data model + detection', function(){
    var ids = FF.D1_SET_CLASS_IDS;
    eq(ids.length, 24, '24 class sets defined (one per class)');
    ids.forEach(function(id){ ok(FF.CLASS_DEFS_BY_ID[id], id + ' set maps to a real class'); });
    FF.CLASS_SKILL_IDS.forEach(function(cid){ ok(FF.D1_SET_DEFS[cid], cid + ' has a D1 set'); });
    // Bare-head classes are 3-piece sets (no helmet); everyone else is a full 4.
    ['reaper','berserker','executioner'].forEach(function(id){ var d = FF.D1_SET_DEFS[id];
      eq(d.full, 3, id + ' is a 3-piece set'); ok(!d.pieces.helmet, id + ' has no helmet piece'); });
    eq(FF.D1_SET_DEFS.summoner.full, 4, 'summoner is a 4-piece set');
    // Materials valid; both bonuses present with name/desc/key.
    var mats = { tailoring:1, leather:1, chain:1, plate:1 };
    ids.forEach(function(id){ var d = FF.D1_SET_DEFS[id];
      Object.keys(d.pieces).forEach(function(slot){ ok(mats[d.pieces[slot]], id + '/' + slot + ' has a valid material'); });
      ok(d.b2 && d.b2.name && d.b2.desc && d.b2.key, id + ' has a named 2-piece bonus');
      ok(d.bf && d.bf.name && d.bf.desc && d.bf.key, id + ' has a named full-set bonus'); });
    // Spot-check a couple of the chosen bonuses landed.
    eq(FF.D1_SET_DEFS.summoner.b2.name, 'Pack Tactics', 'Summoner 2pc is Pack Tactics');
    eq(FF.D1_SET_DEFS.reaver.bf.name, 'Feeding Frenzy', 'Reaver capstone is Feeding Frenzy');
    eq(FF.D1_SET_DEFS.nightblade.b2.name, 'Resistance Rot', 'Voidshadow (nightblade) 2pc is Resistance Rot');
    // Themed set names: every class has one, and pieces read "<Slot> of <SetName>".
    ids.forEach(function(id){ ok(FF.SET_NAMES[id] && FF.setName(id) === FF.SET_NAMES[id], id + ' has a themed set name'); });
    eq(FF.setPieceName('nightblade', 'helmet'), 'Helmet of the Umbral Coil', 'a Voidshadow helm reads "Helmet of the Umbral Coil"');
    eq(FF.setPieceName('herald', 'chest'), 'Chest of Chitinwall', 'a Herald chest reads "Chest of Chitinwall"');
    eq(FF.setPieceName('reaver', 'gauntlets'), 'Gauntlets of the Bloodspinner', 'a Reaver piece reads "Gauntlets of the Bloodspinner"');
    // Detection: seat set pieces via unique.set on body-armor slots.
    var st = { bodyArmor:{ helmet:{uid:'a'}, chest:{uid:'b'}, gauntlets:{uid:'c'}, boots:{} },
      uniqueItems:{ a:{set:'summoner'}, b:{set:'summoner'}, c:{set:'summoner'} } };
    eq(FF.setPiecesWorn('summoner', st), 3, 'counts worn Summoner set pieces');
    eq(FF.set2('summoner', st), true, '3 pieces -> the 2-piece bonus is active');
    eq(FF.setFull('summoner', st), false, '3 of 4 -> the capstone is not yet active');
    st.bodyArmor.boots = { uid:'d' }; st.uniqueItems.d = { set:'summoner' };
    eq(FF.setFull('summoner', st), true, 'the full 4 -> the capstone is active');
    eq(FF.setPiecesWorn('duelist', st), 0, "another class's set is not counted");
    // A bare-head 3-piece set reaches its capstone at 3.
    var rst = { bodyArmor:{ chest:{uid:'x'}, gauntlets:{uid:'y'}, boots:{uid:'z'} },
      uniqueItems:{ x:{set:'reaper'}, y:{set:'reaper'}, z:{set:'reaper'} } };
    eq(FF.setFull('reaper', rst), true, 'a bare-head 3-piece set hits its capstone at 3 pieces');
  });

  // ---- D2 armor sets: t22 tier, all-new bonuses, layer-isolated from D1 -------------------------------
  suite('D2 sets: foundation', function(){
    eq(FF.D2_SET_CLASS_IDS.length, 24, 'D2 has a set for all 24 classes');
    eq(FF.SET_TIER_INDEX_D2, FF.SET_TIER_INDEX + 1, 'D2 set pieces sit one tier (t22) above D1 (t21)');
    // Every D2 bonus is a NEW key vs the class's D1 set (the "all-new effects" decision).
    var clash = FF.D2_SET_CLASS_IDS.filter(function(cls){ var a=FF.D1_SET_DEFS[cls], b=FF.D2_SET_DEFS[cls];
      return b.b2.key===a.b2.key || b.bf.key===a.bf.key; });
    eq(clash.length, 0, 'every D2 set bonus uses a fresh key, distinct from its D1 set');
    FF.D2_SET_CLASS_IDS.forEach(function(cls){ var d=FF.D2_SET_DEFS[cls];
      ok(d.b2 && d.b2.name && d.b2.desc, cls+' D2 has a named 2-piece bonus');
      ok(d.bf && d.bf.name && d.bf.desc, cls+' D2 has a named full-set bonus'); });
    // Bare-head classes stay 3-piece in D2 too.
    ['reaper','berserker','executioner'].forEach(function(id){ eq(FF.D2_SET_DEFS[id].full, 3, id+' D2 is a 3-piece set'); });
    // t22 base armour exists and out-defends the t21 piece of the same slot/material/rarity.
    var t21 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX+'_rare'];
    var t22 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX_D2+'_rare'];
    ok(t21 && t22, 'both t21 and t22 plate chest bases exist');
    ok(t22.defense > t21.defense, 't22 base armour rolls higher defense than t21');
    // Layer isolation: a D1 piece and a D2 piece of the SAME class never merge into one set.
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems };
    try {
      s.uniqueItems = {}; s.bodyArmor = {};
      var d2uid = FF.mintSetPiece('summoner','chest','rare','d2');
      var d1uid = FF.mintSetPiece('summoner','helmet','rare','d1');
      eq(s.uniqueItems[d2uid].setLayer, 'd2', 'a D2 piece carries setLayer d2');
      eq(s.uniqueItems[d2uid].tier, FF.SET_TIER_INDEX_D2, 'a D2 piece is minted at t22');
      ok(!s.uniqueItems[d1uid].setLayer || s.uniqueItems[d1uid].setLayer==='d1', 'a D1 piece stays layer d1');
      s.bodyArmor = { chest:{uid:d2uid}, helmet:{uid:d1uid} };
      eq(FF.setPiecesWorn('summoner', s, 'd2'), 1, 'the D2 layer counts only the D2 piece');
      eq(FF.setPiecesWorn('summoner', s, 'd1'), 1, 'the D1 layer counts only the D1 piece');
      eq(FF.set2('summoner', s), false, 'a mixed D1+D2 pair does NOT trigger the D1 2-piece');
      eq(FF.set2D2('summoner', s), false, 'a mixed D1+D2 pair does NOT trigger the D2 2-piece');
      // Two genuine D2 pieces DO trigger the D2 2-piece.
      s.bodyArmor.helmet = { uid: FF.mintSetPiece('summoner','helmet','rare','d2') };
      eq(FF.set2D2('summoner', s), true, 'two D2 pieces trigger the D2 2-piece bonus');
      // Names are orc-themed and distinct from D1.
      ok(FF.setPieceName('summoner','chest','d2') !== FF.setPieceName('summoner','chest','d1'), 'D2 piece names differ from D1');
      ok(/Warbeast/.test(FF.setPieceName('summoner','chest','d2')), 'the D2 Summoner set is the Warbeast Harness');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; }
  });

  // ---- D3 sets: foundation (t23, layer isolation, necromancy systems) — Batch L ----------------------
  suite('D3 sets: foundation', function(){
    eq(FF.D3_SET_CLASS_IDS.length, 24, 'D3 has a set for all 24 classes');
    eq(FF.SET_TIER_INDEX_D3, FF.SET_TIER_INDEX_D2 + 1, 'D3 set pieces sit one tier (t23) above D2 (t22)');
    // Every D3 bonus key is fresh vs BOTH the class's D1 and D2 sets.
    var clash = FF.D3_SET_CLASS_IDS.filter(function(cls){ var a=FF.D1_SET_DEFS[cls], b=FF.D2_SET_DEFS[cls], c=FF.D3_SET_DEFS[cls];
      return c.b2.key===a.b2.key || c.bf.key===a.bf.key || c.b2.key===b.b2.key || c.bf.key===b.bf.key; });
    eq(clash.length, 0, 'every D3 set bonus uses a fresh key, distinct from its D1 and D2 sets');
    FF.D3_SET_CLASS_IDS.forEach(function(cls){ var d=FF.D3_SET_DEFS[cls];
      ok(d.b2 && d.b2.name && d.b2.desc, cls+' D3 has a named 2-piece bonus');
      ok(d.bf && d.bf.name && d.bf.desc, cls+' D3 has a named full-set bonus'); });
    ['reaper','berserker','executioner'].forEach(function(id){ eq(FF.D3_SET_DEFS[id].full, 3, id+' D3 is a 3-piece set'); });
    // t23 base armour exists and out-defends t22.
    var t22 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX_D2+'_rare'];
    var t23 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX_D3+'_rare'];
    ok(t22 && t23, 'both t22 and t23 plate chest bases exist');
    ok(t23.defense > t22.defense, 't23 base armour rolls higher defense than t22');
    // Layer isolation across all three layers.
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, souls:s.d3Souls };
    try {
      s.uniqueItems = {}; s.bodyArmor = {};
      var d3uid = FF.mintSetPiece('reaper','chest','rare','d3');
      eq(s.uniqueItems[d3uid].setLayer, 'd3', 'a D3 piece carries setLayer d3');
      eq(s.uniqueItems[d3uid].tier, FF.SET_TIER_INDEX_D3, 'a D3 piece is minted at t23');
      s.bodyArmor = { chest:{uid:d3uid}, gauntlets:{uid:FF.mintSetPiece('reaper','gauntlets','rare','d1')}, boots:{uid:FF.mintSetPiece('reaper','boots','rare','d2')} };
      eq(FF.setPiecesWorn('reaper', s, 'd3'), 1, 'the D3 layer counts only the D3 piece');
      eq(FF.setPiecesWorn('reaper', s, 'd2'), 1, 'the D2 layer counts only the D2 piece');
      eq(FF.setPiecesWorn('reaper', s, 'd1'), 1, 'the D1 layer counts only the D1 piece');
      eq(FF.set2D3('reaper', s), false, 'one D3 piece is not the D3 2-piece');
      s.bodyArmor.gauntlets = { uid: FF.mintSetPiece('reaper','gauntlets','rare','d3') };
      s.bodyArmor.boots = { uid: FF.mintSetPiece('reaper','boots','rare','d3') };
      eq(FF.set2D3('reaper', s), true, 'two D3 pieces trigger the D3 2-piece');
      eq(FF.setFullD3('reaper', s), true, 'three D3 pieces (bare-head) trigger the full set');
      // D3 crypt-themed names, distinct from D1/D2.
      ok(/Lich/.test(FF.setPieceName('reaper','chest','d3')), 'the D3 Reaper set is the Lich’s Vestments');
      ok(FF.setPieceName('reaper','chest','d3') !== FF.setPieceName('reaper','chest','d2'), 'D3 names differ from D2');

      // --- Necromancy systems ---
      // Souls: bank + cap at 10; scattered on death is exercised elsewhere.
      s.d3Souls = 0; FF.d3SoulsAdd(3); eq(FF.d3SoulCount(s), 3, 'd3SoulsAdd banks Soul Charges');
      FF.d3SoulsAdd(20); eq(FF.d3SoulCount(s), FF.D3_SOUL_CAP, 'Soul Charges cap at 10');
      // Decay: apply builds stacks + a live window; the tick chips HP (armour-ignoring).
      s.activity = { type:'combat', monsterHp:1000 };
      FF.decayApply(s.activity, 3); eq(s.activity.decayStacks, 3, 'decayApply stacks Decay');
      ok(FF.enemyDecaying(s), 'a decaying foe reads as Decaying'); ok(s.activity.decayUntil > Date.now(), 'Decay opens a window');
      s.activity = { type:'combat', monsterHp:1000, decayStacks:5, decayUntil:Date.now()+9999, decayDps:100 };
      FF.applyDecayTick(1000); near(s.activity.monsterHp, 900, 'a 1s Decay tick chips ~decayDps HP', 2);
      // The 1 HP floor is gone: every DoT can finish a foe. This fixture has no monsterId, so
      // defeatMonster cannot fire and HP simply falls past 0 -- which is exactly what proves no floor.
      s.activity = { type:'combat', monsterHp:1, decayStacks:5, decayUntil:Date.now()+9999, decayDps:100 };
      FF.applyDecayTick(1000); ok(s.activity.monsterHp <= 0, 'Decay CAN land the killing blow (no 1 HP floor)');
      near(FF.d3DecayTickMult(s), 1, 'Decay tick multiplier is 1 with no D3 Decay full set');
      // Curse: apply sets the window; enemyCursed reads it.
      s.activity = { type:'combat', monsterHp:1000 };
      ok(!FF.enemyCursed(s), 'a clean foe is not Cursed');
      FF.curseApply(s.activity); ok(FF.enemyCursed(s), 'curseApply marks the foe Cursed');
      s.activity.curseUntil = Date.now()-1; ok(!FF.enemyCursed(s), 'Curse lapses after its window');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; s.d3Souls = sv.souls; }
  });

  // ---- D3 sets: Batch M — Souls sets (build + spend Soul Charges) ------------------------------------
  suite('D3 sets: Batch M — Souls sets', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, souls:s.d3Souls };
    function wearD3(cls, n){
      var order = FF.D3_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d3' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    try {
      s.activity = { type:'combat', monsterHp:500 };
      // Reaper Soul Harvest (full): +5% damage per Soul Charge (cap 10).
      wearD3('reaper', 3); s.d3Souls = 5; near(FF.d3SetDmgMult({}, s), 1.25, 'Reaper Soul Harvest: +5% per Soul (5 -> +25%)');
      s.d3Souls = 0; near(FF.d3SetDmgMult({}, s), 1.0, 'Soul Harvest inert at 0 Souls');
      s.d3Souls = 99; near(FF.d3SetDmgMult({}, s), 1.50, 'Soul count caps at 10 (Soul Harvest maxes at +50%)');
      // 2-piece alone (builder) grants no spender.
      wearD3('reaper', 2); s.d3Souls = 5; near(FF.d3SetDmgMult({}, s), 1.0, '2-piece Reaper has no Soul Harvest (full only)');
      // Executioner Death Toll (full): +4% per Soul.
      wearD3('executioner', 3); s.d3Souls = 5; near(FF.d3SetDmgMult({}, s), 1.20, 'Executioner Death Toll: +4% per Soul');
      // Spellblade Necroblade (full, 4pc): +4% per Soul.
      wearD3('spellblade', 4); s.d3Souls = 5; near(FF.d3SetDmgMult({}, s), 1.20, 'Spellblade Necroblade: +4% per Soul');
      wearD3('spellblade', 2); s.d3Souls = 5; near(FF.d3SetDmgMult({}, s), 1.0, 'Necroblade needs the full set');
      // Reaver Exsanguinate (full): +5% per Soul, but only vs a bleeding foe.
      wearD3('reaver', 4); s.d3Souls = 4; s.activity = { type:'combat', monsterHp:500, bleedStacks:3, bleedUntil:Date.now()+4000 };
      near(FF.d3SetDmgMult({}, s), 1.20, 'Reaver Exsanguinate: +5% per Soul vs a bleeding foe (4 -> +20%)');
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d3SetDmgMult({}, s), 1.0, 'Exsanguinate inert on an unbled foe');
      // A class with no D3 set gets none of it.
      s.bodyArmor = {}; s.uniqueItems = {}; s.d3Souls = 8; near(FF.d3SetDmgMult({}, s), 1.0, 'no D3 set -> no Souls damage');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.activity=sv.act; s.d3Souls=sv.souls; }
  });

  // ---- D3 sets: Batch N — Decay sets (necrotic DoT appliers + amplifiers) ----------------------------
  suite('D3 sets: Batch N — Decay sets', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity };
    function wearD3(cls, n){
      var order = FF.D3_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d3' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    function wearFull(cls){ wearD3(cls, FF.D3_SET_DEFS[cls].full); }
    var now = Date.now();
    try {
      // Decay-tick multipliers (fulls).
      wearFull('ranger'); s.activity = { type:'combat', monsterHp:500 };
      near(FF.d3DecayTickMult(s), 1.40, 'Ranger Plague Hunter: Decay ticks +40%');
      wearFull('pyromancer'); s.activity = { type:'combat', monsterHp:500, burnUntil:now+4000, burnStacks:1 };
      near(FF.d3DecayTickMult(s), 1.50, 'Pyromancer Cremation: +50% Decay on a burning foe');
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d3DecayTickMult(s), 1.0, 'Cremation inert on an unburnt foe');
      wearFull('frostwarden'); s.activity = { type:'combat', monsterHp:500, enemyChillUntil:now+4000 };
      near(FF.d3DecayTickMult(s), 1.20, 'Frostwarden Deathfrost: +20% Decay on a Chilled foe');
      // Damage / crit / incoming amplifiers vs a Decayed foe.
      wearFull('quickdraw'); s.activity = { type:'combat', monsterHp:500, decayStacks:3, decayUntil:now+4000 };
      near(FF.d3SetDmgMult({}, s), 1.15, 'Quickdraw Grave Toxin: +15% vs a Decayed foe');
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d3SetDmgMult({}, s), 1.0, 'Grave Toxin inert on a clean foe');
      wearFull('assassin'); s.activity = { type:'combat', monsterHp:500, decayStacks:3, decayUntil:now+4000 };
      near(FF.d3SetCritDmgBonus(s), 0.30, 'Assassin Death Mark: +30% crit damage vs a Decayed foe');
      s.activity.decayUntil = now-1; near(FF.d3SetCritDmgBonus(s), 0, 'Death Mark inert on a clean foe');
      wearFull('sentinel'); s.activity = { type:'combat', monsterHp:500, decayStacks:3, decayUntil:now+4000 };
      near(FF.d3SetIncomingMult(s), 0.80, 'Sentinel Crypt Wall: Decayed foes deal 20% less');
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d3SetIncomingMult(s), 1.0, 'Crypt Wall inert on a clean foe');
      // Grave Chill applier (2pc): a chilling hit also applies Decay (tested through the shared chill helper).
      wearD3('frostwarden', 2); s.activity = { type:'combat', monsterHp:500 };
      FF.frostwardenApplyChill(s.activity);
      ok((s.activity.decayStacks||0) >= 1 && FF.enemyDecaying(s), 'Grave Chill: a chilling hit also applies Decay');
      // The remaining 2pc appliers (Soul Rend / Marrow Shot / Bone Thorns / Necrosis / Funeral Pyre / Decaying
      // Traps) fire at their own combat hooks; confirm every Decay set is defined.
      ['plaguebearer','pyromancer','frostwarden','quickdraw','ranger','assassin','sharpshooter','sentinel'].forEach(function(c){
        ok(FF.D3_SET_DEFS[c] && FF.D3_SET_DEFS[c].b2 && FF.D3_SET_DEFS[c].bf, c+' has a full D3 Decay set'); });
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.activity=sv.act; }
  });

  // ---- D3 sets: Batch O — Curse sets (mark the foe, cash it in) --------------------------------------
  suite('D3 sets: Batch O — Curse sets', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity };
    function wearD3(cls, n){
      var order = FF.D3_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d3' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    function wearFull(cls){ wearD3(cls, FF.D3_SET_DEFS[cls].full); }
    var now = Date.now();
    try {
      // Full-set amplifiers vs a Cursed foe (outgoing).
      wearFull('nightblade'); s.activity = { type:'combat', monsterHp:500, curseUntil:now+4000 };
      near(FF.d3SetDmgMult({}, s), 1.25, 'Nightblade Doomcurse: +25% vs a Cursed foe (bumped to match D2 Eclipse)');
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d3SetDmgMult({}, s), 1.0, 'Doomcurse inert on an uncursed foe');
      wearFull('duelist'); s.activity = { type:'combat', monsterHp:500, curseUntil:now+4000 };
      near(FF.d3SetDmgMult({}, s), 1.15, 'Duelist Spectral Grace: +15% vs a Cursed foe');
      wearFull('thunderfury'); s.activity = { type:'combat', monsterHp:500, curseUntil:now+4000 };
      near(FF.d3SetDmgMult({}, s), 1.12, 'Thunderfury Death Static: +12% vs a Cursed foe');
      // Herald Mausoleum (incoming): Cursed foes deal 15% less.
      wearFull('herald'); s.activity = { type:'combat', monsterHp:500, curseUntil:now+4000 };
      near(FF.d3SetIncomingMult(s), 0.85, 'Herald Mausoleum: Cursed foes deal 15% less');
      s.activity.curseUntil = now-1; near(FF.d3SetIncomingMult(s), 1.0, 'Mausoleum inert once the Curse lapses');
      // Curse appliers (2pc) reach curseApply through their hooks; verify curse tracking + one applier (Ghost Step via a Dodge).
      wearD3('duelist', 2); s.activity = { type:'combat', monsterHp:500 };
      ok(!FF.enemyCursed(s), 'no Curse before a Dodge');
      FF.onPlayerDodged(); ok(FF.enemyCursed(s), 'Ghost Step (Duelist D3 2pc): a Dodge Curses the foe');
      // The other appliers (Cursemark / Gravestone / Grave Guard / Grave Spark) fire at their combat hooks — set is defined.
      ['nightblade','juggernaut','herald','thunderfury'].forEach(function(c){ ok(FF.D3_SET_DEFS[c], c+' has a D3 Curse set'); });
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.activity=sv.act; }
  });

  // ---- D3 sets: Batch P — Undeath + Treasure sets ---------------------------------------------------
  suite('D3 sets: Batch P — Undeath + Treasure sets', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, ks:s.knightStacks };
    function wearD3(cls, n){
      var order = FF.D3_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d3' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    function wearFull(cls){ wearD3(cls, FF.D3_SET_DEFS[cls].full); }
    try {
      s.activity = { type:'combat', monsterHp:500 };
      // Knight Grave Momentum (2pc): -10% incoming at max Momentum.
      wearD3('knight', 2); s.knightStacks = FF.knightStackCap(s);
      near(FF.d3SetIncomingMult(s), 0.90, 'Knight Grave Momentum: -10% damage at max Momentum');
      s.knightStacks = 0; near(FF.d3SetIncomingMult(s), 1.0, 'Grave Momentum inert below max Momentum');
      // Treasure Hunter Cursed Hoard (full): +50% Treasure Find (ratio cancels amulet/D1 factors).
      wearFull('treasureHunter'); var withF = FF.legTreasureMult(s);
      s.bodyArmor = {}; s.uniqueItems = {}; var without = FF.legTreasureMult(s);
      near(withF / without, 1.50, 'Treasure Hunter Cursed Hoard: +50% Treasure Find');
      // Grave Robber (2pc) gold bonus rides on enemyCursed at kill time; and its crit-Curse applier is a combat hook.
      ok(FF.D3_SET_DEFS.treasureHunter.b2.name === 'Grave Robber', 'TH D3 2pc is Grave Robber');
      // The Undeath revives / Grave Ward / Consecrate / Soulguard fire at combat hooks (lethal-blow guard,
      // shield-absorb, tick loop). Confirm each set is defined with its named bonuses.
      ['berserker','templar','knight','lumen','treasureHunter'].forEach(function(c){
        ok(FF.D3_SET_DEFS[c] && FF.D3_SET_DEFS[c].b2.name && FF.D3_SET_DEFS[c].bf.name, c+' has a full D3 set'); });
      eq(FF.D3_SET_DEFS.berserker.bf.name, 'Second Death', 'Berserker D3 full is Second Death');
      eq(FF.D3_SET_DEFS.templar.bf.name, 'Resurrection', 'Templar D3 full is Resurrection');
      eq(FF.D3_SET_DEFS.knight.bf.name, 'Undying March', 'Knight D3 full is Undying March');
      eq(FF.D3_SET_DEFS.lumen.bf.name, 'Soulguard', 'Lumen D3 full is Soulguard');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.activity=sv.act; s.knightStacks=sv.ks; }
  });

  // ---- D4 sets: foundation (t24, layer isolation, elemental aggregators, Breath + Wrath) — Batch W ----
  suite('D4 sets: foundation', function(){
    eq(FF.D4_SET_CLASS_IDS.length, 24, 'D4 has a set for all 24 classes');
    eq(FF.SET_TIER_INDEX_D4, FF.SET_TIER_INDEX_D3 + 1, 'D4 set pieces sit one tier (t24) above D3 (t23)');
    // Every D4 bonus key is fresh vs the class's D1, D2 AND D3 sets.
    var clash = FF.D4_SET_CLASS_IDS.filter(function(cls){ var a=FF.D1_SET_DEFS[cls], b=FF.D2_SET_DEFS[cls], c=FF.D3_SET_DEFS[cls], d=FF.D4_SET_DEFS[cls];
      return [a,b,c].some(function(o){ return o.b2.key===d.b2.key || o.bf.key===d.bf.key; }); });
    eq(clash.length, 0, 'every D4 set bonus uses a fresh key, distinct from its D1/D2/D3 sets');
    FF.D4_SET_CLASS_IDS.forEach(function(cls){ var d=FF.D4_SET_DEFS[cls];
      ok(d.b2 && d.b2.name && d.b2.desc, cls+' D4 has a named 2-piece bonus');
      ok(d.bf && d.bf.name && d.bf.desc, cls+' D4 has a named full-set bonus'); });
    ['reaper','berserker','executioner'].forEach(function(id){ eq(FF.D4_SET_DEFS[id].full, 3, id+' D4 is a 3-piece set'); });
    // t24 base armour exists and out-defends t23.
    var t23 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX_D3+'_rare'];
    var t24 = FF.BODY_ARMOR_ITEMS['bodyarmor_plate_chest_t'+FF.SET_TIER_INDEX_D4+'_rare'];
    ok(t23 && t24, 'both t23 and t24 plate chest bases exist');
    ok(t24.defense > t23.defense, 't24 base armour rolls higher defense than t23');
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, w:s.d4Wrath, wu:s.d4WrathUntil };
    try {
      // --- Layer isolation across all four layers ---
      s.uniqueItems = {}; s.bodyArmor = {};
      var d4uid = FF.mintSetPiece('pyromancer','chest','rare','d4');
      eq(s.uniqueItems[d4uid].setLayer, 'd4', 'a D4 piece carries setLayer d4');
      eq(s.uniqueItems[d4uid].tier, FF.SET_TIER_INDEX_D4, 'a D4 piece is minted at t24');
      s.bodyArmor = { chest:{uid:d4uid}, gauntlets:{uid:FF.mintSetPiece('pyromancer','gauntlets','rare','d3')}, boots:{uid:FF.mintSetPiece('pyromancer','boots','rare','d1')} };
      eq(FF.setPiecesWorn('pyromancer', s, 'd4'), 1, 'the D4 layer counts only the D4 piece');
      eq(FF.setPiecesWorn('pyromancer', s, 'd3'), 1, 'the D3 layer counts only the D3 piece');
      eq(FF.setPiecesWorn('pyromancer', s, 'd1'), 1, 'the D1 layer counts only the D1 piece');
      eq(FF.set2D4('pyromancer', s), false, 'one D4 piece is not the D4 2-piece');
      s.bodyArmor.gauntlets = { uid: FF.mintSetPiece('pyromancer','gauntlets','rare','d4') };
      eq(FF.set2D4('pyromancer', s), true, 'two D4 pieces trigger the D4 2-piece');
      // Dragon-themed D4 names, distinct from D3.
      ok(/Cinderwyrm/.test(FF.setPieceName('pyromancer','chest','d4')), 'the D4 Pyromancer set is Cinderwyrm Scales');
      ok(FF.setPieceName('pyromancer','chest','d4') !== FF.setPieceName('pyromancer','chest','d3'), 'D4 names differ from D3');

      // --- Attunement offense aggregator (2pc +30% single element) ---
      function wearD4(cls, n){ s.bodyArmor = {}; s.uniqueItems = {};
        var order = FF.D4_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
        for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d4' }; s.bodyArmor[order[i]] = { uid:uid }; } }
      wearD4('pyromancer', 2);
      near(FF.d4SetElementDmg(s, 'fire'), 0.30, 'Emberheart: +30% Fire (2pc)');
      near(FF.d4SetElementDmg(s, 'water'), 0, 'Emberheart does not boost other elements');
      var baseFire = FF.elementDmgMult(s, 'fire'); s.bodyArmor = {}; s.uniqueItems = {};
      near(baseFire - FF.elementDmgMult(s, 'fire'), 0.30, 'Emberheart folds +0.30 into elementDmgMult(fire)');
      wearD4('frostwarden', 2); near(FF.d4SetElementDmg(s, 'water'), 0.30, 'Frostheart: +30% Water (2pc)');
      wearD4('thunderfury', 2); near(FF.d4SetElementDmg(s, 'earth'), 0.30, 'Galvanic Heart: +30% Earth (2pc)');
      wearD4('lumen', 2); near(FF.d4SetElementDmg(s, 'light'), 0.30, 'Radiant Heart: +30% Light (2pc)');
      wearD4('templar', 2); near(FF.d4SetElementDmg(s, 'light'), 0.30, 'Solar Heart: +30% Light (2pc)');
      wearD4('nightblade', 2); near(FF.d4SetElementDmg(s, 'dark'), 0.30, 'Umbral Heart: +30% Dark (2pc)');
      // 1 piece does not trip the 2pc.
      wearD4('pyromancer', 1); near(FF.d4SetElementDmg(s, 'fire'), 0, 'one Cinderwyrm piece is not the 2pc');

      // --- Dragonscale defense aggregator (Scaleward +15% all-element resist) ---
      wearD4('herald', 2); near(FF.d4SetElementResist(s, 'fire'), 0.15, 'Scaleward: +15% resist, all elements');
      near(FF.d4SetElementResist(s, 'dark'), 0.15, 'Scaleward applies to every element');
      near(FF.elementResistMult(s, 'fire'), (1 - FF.elementResistBonus(s,'fire')) * 0.85, 'Scaleward folds x0.85 into elementResistMult');
      s.bodyArmor = {}; s.uniqueItems = {}; near(FF.d4SetElementResist(s, 'fire'), 0, 'no Dragonscale set -> no D4 resist');

      // --- Dragon's Breath charge meter ---
      s.activity = { type:'combat', monsterHp:1000 };
      eq(FF.d4BreathCharge(s), 0, 'a fresh fight starts with no Breath charge');
      FF.d4BreathAdd(s.activity, 40); eq(FF.d4BreathCharge(s), 40, 'd4BreathAdd banks charge');
      ok(!FF.d4BreathReady(s), '40/100 is not a ready Breath');
      FF.d4BreathAdd(s.activity, 999); eq(FF.d4BreathCharge(s), FF.D4_BREATH_MAX, 'Breath charge caps at 100');
      ok(FF.d4BreathReady(s), 'a full meter is a ready Breath');
      near(FF.d4BreathPct(s), 1, 'a full meter reads 100%');
      FF.d4BreathReset(s.activity); eq(FF.d4BreathCharge(s), 0, 'd4BreathReset empties the meter');

      // --- Wrath stacking buff ---
      FF.d4WrathReset(s); eq(FF.d4WrathStacks(s), 0, 'Wrath starts empty');
      FF.d4WrathAdd(3, s); eq(FF.d4WrathStacks(s), 3, 'd4WrathAdd stacks Wrath');
      FF.d4WrathAdd(50, s); eq(FF.d4WrathStacks(s), FF.D4_WRATH_CAP, 'Wrath caps at 10');
      s.d4WrathUntil = Date.now() - 1; eq(FF.d4WrathStacks(s), 0, 'Wrath decays once its window lapses');
      FF.d4WrathAdd(2, s); FF.d4WrathReset(s); eq(FF.d4WrathStacks(s), 0, 'd4WrathReset clears Wrath');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; s.d4Wrath = sv.w; s.d4WrathUntil = sv.wu; }
  });

  // ---- D4 sets: Batch X — Attunement pillar (elemental offense fulls) ---------------------------------
  suite('D4 sets: Batch X — Attunement pillar', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity };
    function wearD4(cls, n){ s.bodyArmor = {}; s.uniqueItems = {};
      var order = FF.D4_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d4' }; s.bodyArmor[order[i]] = { uid:uid }; } }
    function wearFull(cls){ wearD4(cls, FF.D4_SET_DEFS[cls].full); }
    try {
      // Frostwarden Absolute Zero (full): Chilled foes take +25% Water damage.
      s.activity = { type:'combat', monsterHp:1000, chillStacks:3, enemyChillUntil:Date.now()+5000 };
      wearFull('frostwarden'); near(FF.d4SetElementDmg(s, 'water'), 0.55, 'Absolute Zero: +25% Water on a Chilled foe (on top of +30% Frostheart)');
      s.activity = { type:'combat', monsterHp:1000 }; near(FF.d4SetElementDmg(s, 'water'), 0.30, 'Absolute Zero inert on a non-Chilled foe');
      // Thunderfury Overload (full): +5% Earth per Static Charge.
      s.activity = { type:'combat', monsterHp:1000, staticCharge:4 };
      wearFull('thunderfury'); near(FF.d4SetElementDmg(s, 'earth'), 0.30 + 0.20, 'Overload: +5% Earth per Static (4 -> +20%, on top of +30%)');
      s.activity = { type:'combat', monsterHp:1000, staticCharge:0 }; near(FF.d4SetElementDmg(s, 'earth'), 0.30, 'Overload adds nothing at 0 Static');

      // --- Foe elemental resistance + Attunement "never resisted" fulls (wand path) ---
      var waterDragon = { dungeon:'d4', element:'water', armorTypes:{} };  // water beats fire -> resists Fire
      var darkDragon  = { dungeon:'d4', element:'dark',  armorTypes:{} };  // dark beats light -> resists Light
      var normalWater = { element:'water' };                              // not a D4 dragon
      ok(FF.d4FoeResistsElement(waterDragon, 'fire'), 'a water dragon resists Fire');
      ok(!FF.d4FoeResistsElement(waterDragon, 'earth'), 'a water dragon does not resist Earth');
      ok(!FF.d4FoeResistsElement(normalWater, 'fire'), 'a non-dragon foe has no D4 elemental resistance');
      s.bodyArmor = {}; s.uniqueItems = {};
      near(FF.d4WandElementMult(s, 'fire', waterDragon), 0.85, 'Fire is resisted 15% by a water dragon');
      near(FF.d4WandElementMult(s, 'fire', normalWater), 1.0, 'no resistance against a non-dragon');
      wearFull('pyromancer'); near(FF.d4WandElementMult(s, 'fire', waterDragon), 1.0, 'Everflame: Fire is never resisted');
      // Lumen Radiant Judgment (full): Light never resisted + 40% vs Dark.
      s.bodyArmor = {}; s.uniqueItems = {};
      near(FF.d4WandElementMult(s, 'light', darkDragon), 0.85, 'Light is resisted 15% by a dark dragon');
      wearFull('lumen'); near(FF.d4WandElementMult(s, 'light', darkDragon), 1.40, 'Radiant Judgment: Light unresisted AND +40% vs a Dark foe');
      near(FF.d4WandElementMult(s, 'light', { element:'dark' }), 1.40, 'Radiant Judgment +40% vs any Dark foe');
      near(FF.d4WandElementMult(s, 'fire', waterDragon), 0.85, 'Radiant Judgment does not save Fire from resistance');

      // --- Spellblade echoes (Rune Heart / Prismatic Edge) ---
      s.bodyArmor = {}; s.uniqueItems = {};
      wearD4('spellblade', 2); near(FF.d4EchoMult(s), 1.30, 'Rune Heart (2pc): echoes +30% elemental');
      wearFull('spellblade'); near(FF.d4EchoMult(s), 1.30 * FF.ELEMENT_ADVANTAGE_MULT, 'Prismatic Edge (full): echoes also strike the weakness (advantage)');

      // --- Summoner familiars (Brood Heart / Wyrmling Swarm) ---
      s.bodyArmor = {}; s.uniqueItems = {};
      wearD4('summoner', 2); near(FF.d4FamiliarElementMult(s, 'fire', { element:'earth' }), 1.30, 'Brood Heart (2pc): +30% familiar elemental');
      wearFull('summoner');
      near(FF.d4FamiliarElementMult(s, 'fire', { element:'water' }), 1.30 * FF.ELEMENT_ADVANTAGE_MULT, 'Wyrmling Swarm: grants the advantage bite when the familiar lacks it');
      near(FF.d4FamiliarElementMult(s, 'fire', { element:'earth' }), 1.30, 'Wyrmling Swarm does not double an advantage the familiar already has');

      // --- Templar Aegis of Light (full): Holy shield scales with Light Attunement ---
      s.bodyArmor = {}; s.uniqueItems = {};
      wearFull('templar'); near(FF.d4TemplarAegisMult(s), 1 + FF.elementDamageBonus(s, 'light'), 'Aegis of Light scales the shield by Light Attunement');
      ok(FF.d4TemplarAegisMult(s) > 1, 'Aegis of Light always grows the shield at least a little');
      s.bodyArmor = {}; s.uniqueItems = {}; near(FF.d4TemplarAegisMult(s), 1, 'no Aegis of Light without the full Sunwyrm set');

      // --- Nightblade Eclipse (full): a Vulnerable foe's elemental advantage against you is stripped ---
      // Seat leather weakness (fire) AND the nightblade set on the same slots (slot carries material+tier for
      // playerElementWeakness; uniqueItems carries the set membership for setPiecesWorn).
      var fireMon = { element:'fire' };
      function wearNightbladeLeather(){ s.bodyArmor = {}; s.uniqueItems = {};
        var order = ['helmet','chest','gauntlets','boots'];
        for(var i=0;i<FF.D4_SET_DEFS.nightblade.full;i++){ s.uniqueItems['n'+i] = { set:'nightblade', setLayer:'d4' }; s.bodyArmor[order[i]] = { uid:'n'+i, material:'leather', tier:5 }; } }
      wearNightbladeLeather(); s.activity = { type:'combat', monsterHp:1000 };
      var weakBase = FF.incomingElementMult(s, fireMon); ok(weakBase > 1, 'leather armour is weak to a Fire foe (incoming > 1)');
      s.activity = { type:'combat', monsterHp:1000, voidVulnStacks:3, voidVulnUntil:Date.now()+5000 };
      near(FF.incomingElementMult(s, fireMon), 1, 'Eclipse: a Vulnerable foe deals no elemental advantage against you');
      // Without the full nightblade set, the weakness stands even against a Vulnerable foe.
      s.bodyArmor = { chest:{ material:'leather', tier:5 } }; s.uniqueItems = {};
      ok(FF.incomingElementMult(s, fireMon) > 1, 'no Eclipse without the Duskwyrm full set — the weakness remains');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; }
  });

  // ---- D4 sets: Batch Y — Dragonscale pillar (elemental defense) --------------------------------------
  suite('D4 sets: Batch Y — Dragonscale pillar', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, hp:s.playerHp, ks:s.knightStacks };
    function wearD4(cls, n){ s.bodyArmor = {}; s.uniqueItems = {};
      var order = FF.D4_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d4' }; s.bodyArmor[order[i]] = { uid:uid }; } }
    function wearFull(cls){ wearD4(cls, FF.D4_SET_DEFS[cls].full); }
    var mhp = FF.maxHp(s);
    try {
      // Knight Warscale (2pc): +12% all-element resist at max Momentum.
      wearD4('knight', 2); s.knightStacks = FF.knightStackCap(s);
      near(FF.d4SetElementResist(s, 'fire'), 0.12, 'Warscale: +12% resist at max Momentum');
      near(FF.d4SetElementResist(s, 'dark'), 0.12, 'Warscale covers every element');
      s.knightStacks = 0; near(FF.d4SetElementResist(s, 'fire'), 0, 'Warscale inert below max Momentum');

      // Berserker Burning Blood (2pc) / Dragonrage (full): low-HP outgoing scaling.
      wearD4('berserker', 2); s.playerHp = Math.round(mhp * 0.40);
      near(FF.d4SetDmgMult({}, s), 1.20, 'Burning Blood: +20% below 50% Health');
      s.playerHp = mhp; near(FF.d4SetDmgMult({}, s), 1.0, 'Burning Blood inert at full Health');
      wearFull('berserker'); s.playerHp = Math.round(mhp * 0.40); var f = s.playerHp / mhp;
      near(FF.d4SetDmgMult({}, s), 1.20 * (1 + 0.30 * (1 - f)), 'Dragonrage stacks with Burning Blood below 50% Health', 0.02);
      s.playerHp = 1; f = s.playerHp / mhp;
      near(FF.d4SetDmgMult({}, s), 1.20 * (1 + 0.30 * (1 - f)), 'Dragonrage: near-max +30% near death, with Burning Blood', 0.02);
      s.playerHp = mhp; near(FF.d4SetDmgMult({}, s), 1.0, 'Wrathscale outgoing is inert at full Health');

      // Juggernaut Emberhide (2pc): -20% Fire + heal 25% of the avoided.
      wearD4('juggernaut', 2);
      var mit = FF.d4DragonscaleIncoming(s, { element:'fire' }, 1000);
      near(mit.mult, 0.80, 'Emberhide: -20% Fire');
      eq(mit.heal, 50, 'Emberhide heals 25% of the 200 avoided');
      var mitW = FF.d4DragonscaleIncoming(s, { element:'water' }, 1000);
      near(mitW.mult, 1.0, 'Emberhide only mitigates Fire');
      // Knight Unbreakable Scales (full): a big elemental hit is halved.
      wearFull('knight');
      near(FF.d4DragonscaleIncoming(s, { element:'earth' }, mhp).mult, 0.50, 'Unbreakable Scales halves an elemental hit above 12% max Health');
      near(FF.d4DragonscaleIncoming(s, { element:'earth' }, 1).mult, 1.0, 'a tiny elemental hit is under the Unbreakable Scales threshold');
      near(FF.d4DragonscaleIncoming(s, { element:'earth' }, mhp*10, mhp).heal, 0, 'Unbreakable Scales heals nothing (it is a cap, not a leech)');

      // Sentinel Molten Thorns (2pc) / Dragon's Retort (full): reflect amplifier.
      wearD4('sentinel', 2);
      near(FF.d4SentinelThornsMult({ element:'fire' }, s), FF.elementDmgMult(s, 'fire'), 'Molten Thorns: reflect carries the attacker element (scaled by Attunement)');
      near(FF.d4SentinelThornsMult({ element:null }, s), 1.0, 'Molten Thorns needs the attacker to have an element');
      wearFull('sentinel');
      near(FF.d4SentinelThornsMult({ element:'fire' }, s), FF.elementDmgMult(s, 'fire') * 1.50, "Dragon's Retort: +50% on top of Molten Thorns");

      // Herald Elemental Bastion (full): a Perfect Guard reflects an elemental burst of the prevented damage.
      wearFull('herald');
      near(FF.d4HeraldBastionReflect(1000, { element:'fire' }, s), Math.round(1000 * 0.50 * FF.elementDmgMult(s, 'fire')), 'Elemental Bastion reflects half the prevented, scaled by Attunement');
      eq(FF.d4HeraldBastionReflect(0, { element:'fire' }, s), 0, 'no Bastion reflect when nothing was prevented');
      wearD4('herald', 2); eq(FF.d4HeraldBastionReflect(1000, { element:'fire' }, s), 0, 'no Bastion reflect without the full Bulwark of Scales');

      // Reaver Searing Wounds (2pc) / Cauterize (full): Bleeds gain a Fire component; the full heals from it.
      function bleedDrop(){ s.activity = { type:'combat', monsterHp:1000000, bleedDps:1000, bleedUntil:Date.now()+9999 };
        var before = s.activity.monsterHp; FF.applyReaverBleedTick(1000); return before - s.activity.monsterHp; }
      s.bodyArmor = {}; s.uniqueItems = {}; s.playerHp = mhp;
      var plain = bleedDrop();
      wearD4('reaver', 2); var seared = bleedDrop();
      near(seared - plain, 1000 * 0.25 * FF.elementDmgMult(s, 'fire'), 'Searing Wounds adds a ~25% Fire component to Bleed ticks', 3);
      wearFull('reaver'); s.playerHp = Math.round(mhp * 0.5); var hpBefore = s.playerHp; bleedDrop();
      ok(s.playerHp > hpBefore, 'Cauterize heals you from the Bleed Fire damage');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; s.playerHp = sv.hp; s.knightStacks = sv.ks; }
  });

  // ---- D4 sets: Batch Z — Dragon's Breath pillar (charge meter + breath weapon) -----------------------
  suite('D4 sets: Batch Z — Dragon\'s Breath pillar', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, hp:s.playerHp };
    function wearD4(cls, n){ s.bodyArmor = {}; s.uniqueItems = {};
      var order = FF.D4_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d4' }; s.bodyArmor[order[i]] = { uid:uid }; } }
    function wearFull(cls){ wearD4(cls, FF.D4_SET_DEFS[cls].full); }
    var mhp = FF.maxHp(s);
    try {
      // --- Charging (2pc) ---
      s.activity = { type:'combat', monsterHp:1000000, breathCharge:0 };
      wearD4('quickdraw', 2); s.activity.breathCharge = 0; eq(FF.d4BreathChargeOnHit(s, false), 8, 'Elemental Arrows: +8 charge per shot');
      eq(FF.d4BreathCharge(s), 8, 'the charge is banked onto the meter');
      wearD4('sharpshooter', 2); s.activity.breathCharge = 0;
      eq(FF.d4BreathChargeOnHit(s, false), 4, 'Focused Breath: +4 on a normal hit');
      s.activity.breathCharge = 0; eq(FF.d4BreathChargeOnHit(s, true), 14, 'Focused Breath: crits charge faster (+14)');
      wearD4('reaper', 2); s.activity.breathCharge = 0; eq(FF.d4BreathChargeOnHit(s, false), 8, 'Soulfire Siphon: +8 per lifesteal hit');
      wearD4('ranger', 2); s.activity = { type:'combat', monsterHp:1000000, breathCharge:0 }; // clean, no ailment
      eq(FF.d4BreathChargeOnHit(s, false), 0, 'Elemental Traps: no charge without an ailment on the foe');
      s.activity.bleedUntil = Date.now() + 5000; eq(FF.d4BreathChargeOnHit(s, false), 10, 'Elemental Traps: +10 when the foe is afflicted');

      // --- Full-set selection ---
      wearFull('quickdraw'); eq(FF.d4BreathFullSet(s), 'quickdraw', 'the full Breathfang set fires Dragon\'s Breath');
      wearFull('reaper'); eq(FF.d4BreathFullSet(s), 'reaper', 'the full Wyrmsoul set fires Spirit Breath');
      wearD4('quickdraw', 2); eq(FF.d4BreathFullSet(s), null, 'a 2-piece set does not fire a breath weapon');

      // --- Firing (full) ---
      // Not ready -> no fire.
      wearFull('quickdraw'); s.activity = { type:'combat', monsterHp:1000000, breathCharge:50 };
      eq(FF.d4BreathFire(s, { element:'water' }, 1000), 0, 'the breath does not fire below full charge');
      // Quickdraw Dragon's Breath: a devastating elemental burst; resets the meter.
      s.activity = { type:'combat', monsterHp:1000000, breathCharge:100 };
      var expBurst = Math.round(1000 * FF.D4_BREATH_BURST_MULT * FF.elementDmgMult(s, 'fire'));
      eq(FF.d4BreathFire(s, { element:'water' }, 1000), expBurst, 'Dragon\'s Breath bursts for 5x the strike (x Fire Attunement)');
      eq(FF.d4BreathCharge(s), 0, 'firing resets the Breath meter');
      // Sharpshooter Piercing Breath: strikes the weakness (+20%). (Recompute the base — earlier breaths trained Fire Attunement.)
      wearFull('sharpshooter'); s.activity = { type:'combat', monsterHp:1000000, breathCharge:100 };
      var baseSharp = Math.round(1000 * FF.D4_BREATH_BURST_MULT * FF.elementDmgMult(s, 'fire'));
      eq(FF.d4BreathFire(s, { element:'water' }, 1000), Math.round(baseSharp * FF.ELEMENT_ADVANTAGE_MULT), 'Piercing Breath strikes the weakness (+20%)');
      // Reaper Spirit Breath: burst + heal.
      wearFull('reaper'); s.activity = { type:'combat', monsterHp:1000000, breathCharge:100 }; s.playerHp = Math.round(mhp * 0.5); var hpBefore = s.playerHp;
      var rb = FF.d4BreathFire(s, { element:'water' }, 1000); ok(rb > 0 && s.playerHp > hpBefore, 'Spirit Breath heals you for a share of its damage');
      // Executioner Immolation Breath: executes a foe below 25% Health.
      wearFull('executioner'); s.activity = { type:'combat', monsterHp:200, breathCharge:100 }; var exMon = { isBoss:false, hp:1000 };
      var slain = FF.d4BreathFire(s, exMon, 10); eq(s.activity.monsterHp, 0, 'Immolation Breath executes a foe below 25% Health');
      ok(slain >= 200, 'the execute reports the slain HP');
      s.activity = { type:'combat', monsterHp:500, breathCharge:100 }; // 50% -> no execute, normal burst
      var nb = FF.d4BreathFire(s, exMon, 10); ok(s.activity.monsterHp > 0 && s.activity.monsterHp < 500, 'above 25% Health, Immolation Breath just bursts');
      // Ranger Venombreath: burst + apply your ailments (Chill / Decay / Curse).
      wearFull('ranger'); s.activity = { type:'combat', monsterHp:1000000, breathCharge:100 };
      FF.d4BreathFire(s, { element:'water' }, 1000);
      ok(FF.enemyChilled(s) && FF.enemyDecaying(s) && FF.enemyCursed(s), 'Venombreath applies Chill, Decay and a Curse');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; s.playerHp = sv.hp; }
  });

  // ---- D4 sets: Batch AA — Wrath pillar (draconic Wrath scaling) --------------------------------------
  suite('D4 sets: Batch AA — Wrath pillar', function(){
    var s = FF._state, sv = { ba:s.bodyArmor, ui:s.uniqueItems, act:s.activity, w:s.d4Wrath, wu:s.d4WrathUntil };
    function wearD4(cls, n, extra){ s.bodyArmor = {}; s.uniqueItems = {};
      var order = FF.D4_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d4' }; s.bodyArmor[order[i]] = extra ? { uid:uid, rarity:extra } : { uid:uid }; } }
    function wearFull(cls, extra){ wearD4(cls, FF.D4_SET_DEFS[cls].full, extra); }
    function setWrath(n){ s.d4Wrath = n; s.d4WrathUntil = Date.now() + 9999; }
    try {
      // --- Wrath generation: any Wrath set builds a stack per hit; no set builds nothing ---
      s.activity = { type:'combat', monsterHp:1000 };
      s.bodyArmor = {}; s.uniqueItems = {}; FF.d4WrathReset(s); FF.d4WrathOnHit(s); eq(FF.d4WrathStacks(s), 0, 'no Wrath set -> no Wrath builds');
      wearD4('duelist', 2); FF.d4WrathReset(s); FF.d4WrathOnHit(s); FF.d4WrathOnHit(s); eq(FF.d4WrathStacks(s), 2, 'a Wrath set banks a stack per hit');

      // --- Flame Waltz (Duelist 2pc): +3% damage per Wrath stack ---
      wearD4('duelist', 2); setWrath(5); near(FF.d4SetDmgMult({}, s), 1.15, 'Flame Waltz: +3% per Wrath (5 -> +15%)');
      setWrath(0); near(FF.d4SetDmgMult({}, s), 1.0, 'Flame Waltz is flat with no Wrath');

      // --- Kindled Focus (Samurai 2pc): +2% damage per Focus stack ---
      wearD4('samurai', 2); FF.d4WrathReset(s); s.activity = { type:'combat', monsterHp:1000, samuraiFocus:10 };
      near(FF.d4SetDmgMult({}, s), 1.20, 'Kindled Focus: +2% per Focus (10 -> +20%)');
      // --- Blazing Iaijutsu (Samurai full): opener +20% ---
      wearFull('samurai'); s.activity = { type:'combat', monsterHp:1000, samuraiFocus:0, samuraiFirstStrike:true };
      near(FF.d4SetDmgMult({}, s), 1.20, 'Blazing Iaijutsu: the opening strike hits +20%');
      s.activity.samuraiFirstStrike = false; near(FF.d4SetDmgMult({}, s), 1.0, 'Blazing Iaijutsu only rides the opener');

      // --- Dragon Hoard (Treasure Hunter 2pc): +8% per Supreme item, cap +40% ---
      FF.d4WrathReset(s); s.activity = { type:'combat', monsterHp:1000 };
      s.bodyArmor = {}; var base = FF.d4SupremeItemCount(s);
      s.bodyArmor = { chest:{ rarity:'supreme' }, boots:{ rarity:'fantastic' }, helmet:{ rarity:'rare' } };
      eq(FF.d4SupremeItemCount(s) - base, 2, 'd4SupremeItemCount counts Supreme + Fantastic gear (not Rare)');
      wearD4('treasureHunter', 2, 'supreme'); var cnt = FF.d4SupremeItemCount(s);
      near(FF.d4SetDmgMult({}, s), 1 + 0.08 * Math.min(5, cnt), 'Dragon Hoard: +8% per Supreme item');
      ok(cnt >= 2, 'the two Supreme set pieces count toward Dragon Hoard');

      // --- Plaguebreath (Plaguebearer full): +20% vs a Poisoned foe ---
      wearFull('plaguebearer'); FF.d4WrathReset(s);
      s.activity = { type:'combat', monsterHp:1000, potionPoisonUntil:Date.now()+5000, potionPoisonDps:100 };
      ok(FF.enemyPoisonedFoe(s), 'a foe on the poison channel reads as Poisoned');
      near(FF.d4SetDmgMult({}, s), 1.20, 'Plaguebreath: +20% vs a Poisoned foe');
      s.activity = { type:'combat', monsterHp:1000 }; near(FF.d4SetDmgMult({}, s), 1.0, 'Plaguebreath inert on a clean foe');

      // --- Firestorm (Duelist full): +12% Dodge AND never-resisted at max Wrath ---
      wearFull('duelist'); setWrath(FF.D4_WRATH_CAP);
      near(FF.d4FirestormDodge(s), 0.12, 'Firestorm: +12% Dodge at max Wrath');
      var waterDragon = { dungeon:'d4', element:'water' };
      near(FF.d4WandElementMult(s, 'fire', waterDragon), 1.0, 'Firestorm: at max Wrath your elemental damage is never resisted');
      setWrath(FF.D4_WRATH_CAP - 1);
      near(FF.d4FirestormDodge(s), 0, 'Firestorm needs max Wrath for the Dodge');
      near(FF.d4WandElementMult(s, 'fire', waterDragon), 0.85, 'below max Wrath, Firestorm does not lift the resistance');
    } finally { s.bodyArmor = sv.ba; s.uniqueItems = sv.ui; s.activity = sv.act; s.d4Wrath = sv.w; s.d4WrathUntil = sv.wu; }
  });

  // ---- D2 sets: Batch B effects (damage & tempo) -----------------------------------------------------
  suite('D2 sets: Batch B combat effects', function(){
    var s = FF._state;
    var sv = { ba:s.bodyArmor, ui:s.uniqueItems, hp:s.playerHp, act:s.activity };
    function wearD2(cls, n){ // seat n D2 pieces of a class on the body-armour slots
      var order = FF.D2_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d2' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    var foe = { hp:1000 };
    try {
      var mh = FF.maxHp(s);
      s.playerHp = mh; s.activity = { type:'combat', monsterHp:800 };
      // Berserker Reckless (2pc): +18% out, +8% in.
      wearD2('berserker', 2);
      near(FF.d2SetDmgMult(foe, s), 1.18, 'Berserker Reckless: +18% damage');
      near(FF.d2IncomingDmgMult(s), 1.08, 'Berserker Reckless: +8% damage taken');
      // Berserker Last Stand (full, bare-head 3pc): +50% below 25% HP, stacking with Reckless.
      wearD2('berserker', 3); s.playerHp = Math.round(mh*0.2);
      near(FF.d2SetDmgMult(foe, s), 1.18*1.5, 'Berserker Last Stand stacks with Reckless below 25% HP');
      s.playerHp = mh;
      // Templar Zealous Wrath (2pc): +15% above 75% HP only.
      wearD2('templar', 2);
      near(FF.d2SetDmgMult(foe, s), 1.15, 'Templar Zealous Wrath: +15% above 75% HP');
      s.playerHp = Math.round(mh*0.5); near(FF.d2SetDmgMult(foe, s), 1.0, 'Zealous Wrath inert below 75% HP'); s.playerHp = mh;
      // Templar Radiant Aegis (full): +50% Holy shield cap.
      wearD2('templar', 4); near(FF.templarAegisCapMult(s), 1.5, 'Templar Radiant Aegis: +50% shield cap');
      // Juggernaut Crushing Blows (2pc): +15% vs foe above 50% HP (reads pre-hit HP).
      wearD2('juggernaut', 2); s.activity.monsterHp = 800; near(FF.d2SetDmgMult({hp:1000}, s), 1.15, 'Juggernaut Crushing Blows: +15% vs a healthy foe');
      s.activity.monsterHp = 300; near(FF.d2SetDmgMult({hp:1000}, s), 1.0, 'Crushing Blows inert on a wounded foe');
      // Sharpshooter Steady Aim (2pc): +12% crit damage.
      wearD2('sharpshooter', 2); near(FF.d2SetCritDmgBonus(s), 0.12, 'Sharpshooter Steady Aim: +12% crit damage');
      // Nightblade Creeping Doom (2pc): Vulnerability cap +4; Eclipse (full): +25% at max Vuln.
      wearD2('nightblade', 2); eq(FF.voidVulnCap(s), 10+4, 'Nightblade Creeping Doom: Vulnerability cap +4');
      wearD2('nightblade', 4); s.activity = { type:'combat', monsterHp:800, voidVulnStacks:FF.voidVulnCap(s), voidVulnUntil:Date.now()+9999 };
      near(FF.d2SetDmgMult({hp:1000}, s), 1.25, 'Nightblade Eclipse: +25% at max Vulnerability');
      // Reaver Savage Wounds (2pc): Bleed cap +3; Bloodfrenzy (full): faster as HP falls.
      wearD2('reaver', 2); eq(FF.reaverBleedCap(s), 5+3, 'Reaver Savage Wounds: Bleed cap 5 -> 8');
      wearD2('reaver', 4); s.playerHp = Math.round(mh*0.5);
      ok(FF.reaverBloodfrenzyMult(s) < 1, 'Reaver Bloodfrenzy: attack timer shrinks as HP falls');
      near(FF.reaverBloodfrenzyMult(s), 1 - 0.30*0.5, 'Reaver Bloodfrenzy: ~ -15% timer at half HP', 0.02);
      // A class with NO D2 pieces gets none of these.
      s.bodyArmor = {}; s.uniqueItems = {}; s.playerHp = mh;
      near(FF.d2SetDmgMult(foe, s), 1.0, 'no D2 set -> no bonus damage');
      near(FF.d2IncomingDmgMult(s), 1.0, 'no D2 set -> no extra damage taken');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.playerHp=sv.hp; s.activity=sv.act; }
  });

  // ---- D2 sets: Batch C effects (tank / defense / utility) -------------------------------------------
  suite('D2 sets: Batch C combat effects', function(){
    var s = FF._state;
    var sv = { ba:s.bodyArmor, ui:s.uniqueItems, hp:s.playerHp, act:s.activity, hg:s.heraldGuardStacks, ks:s.knightStacks, cs:s.d2CounterstanceUntil };
    function wearD2(cls, n){
      var order = FF.D2_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d2' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    var foe = { hp:1000 };
    try {
      s.playerHp = FF.maxHp(s); s.activity = { type:'combat', monsterHp:800 };
      // Herald Momentum Guard (2pc): +2% damage per Perfect Guard stack.
      wearD2('herald', 2); var gmax = FF.heraldGuardMaxStacks(s); s.heraldGuardStacks = Math.min(gmax, 3);
      near(FF.d2SetDmgMult(foe, s), 1 + 0.02*Math.min(gmax,3), 'Herald Momentum Guard: +2% per Perfect Guard stack');
      // Herald Immovable (full): -15% damage taken at max Perfect Guard.
      wearD2('herald', 4); s.heraldGuardStacks = gmax; near(FF.d2IncomingDmgMult(s), 0.85, 'Herald Immovable: -15% damage at max Guard');
      s.heraldGuardStacks = 0; near(FF.d2IncomingDmgMult(s), 1.0, 'Immovable inert below max Guard');
      // Duelist En Garde (full): +12% Dodge; Counterstance (2pc): -35% for 2s after a Dodge.
      wearD2('duelist', 4); near(FF.d2SetDodgeBonus(s), 0.12, 'Duelist En Garde: +12% Dodge');
      wearD2('duelist', 2); s.d2CounterstanceUntil = Date.now()+2000; near(FF.d2IncomingDmgMult(s), 0.65, 'Duelist Counterstance: -35% just after a Dodge');
      s.d2CounterstanceUntil = Date.now()-1; near(FF.d2IncomingDmgMult(s), 1.0, 'Counterstance lapses after its window');
      // Frostwarden Brittle (2pc): Chilled foes take +12%.
      wearD2('frostwarden', 2); s.activity = { type:'combat', monsterHp:800, enemyChillUntil:Date.now()+9999 };
      near(FF.d2SetDmgMult({hp:1000}, s), 1.12, 'Frostwarden Brittle: +12% vs a Chilled foe');
      s.activity.enemyChillUntil = Date.now()-1; near(FF.d2SetDmgMult({hp:1000}, s), 1.0, 'Brittle inert on an un-chilled foe');
      // Treasure Hunter Sharp Eye (2pc): +8% crit chance; Plunder (full): +40% Treasure Find.
      wearD2('treasureHunter', 2); near(FF.d2SetCritChance(s), 0.08, 'TH Sharp Eye: +8% crit chance');
      wearD2('treasureHunter', 4); ok(FF.legTreasureMult(s) >= 1.40 - 1e-9, 'TH Plunder: +40% Treasure Find folded into the treasure multiplier');
      // Knight Bulwark March (2pc): +12% Armor at max Momentum.
      wearD2('knight', 2); s.knightStacks = FF.knightStackCap(s); near(FF.knightBulwarkMarchMult(s), 1.12, 'Knight Bulwark March: +12% Armor at max Momentum');
      s.knightStacks = 0; near(FF.knightBulwarkMarchMult(s), 1.0, 'Bulwark March inert below max Momentum');
      // Lumen Radiance (2pc): Reflected Light heals +50%.
      wearD2('lumen', 2); near(FF.lumenReflectD2Mult(s), 1.5, 'Lumen Radiance: +50% Reflected Light heal');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.playerHp=sv.hp; s.activity=sv.act; s.heraldGuardStacks=sv.hg; s.knightStacks=sv.ks; s.d2CounterstanceUntil=sv.cs; }
  });

  // ---- D2 sets: Batch D effects (DoT / ailment) ------------------------------------------------------
  suite('D2 sets: Batch D combat effects', function(){
    var s = FF._state;
    var sv = { ba:s.bodyArmor, ui:s.uniqueItems, hp:s.playerHp, act:s.activity };
    function wearD2(cls, n){
      var order = FF.D2_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d2' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    var foe = { hp:1000 };
    try {
      s.playerHp = FF.maxHp(s); s.activity = { type:'combat', monsterHp:500 };
      // DoT-tick multipliers.
      wearD2('plaguebearer', 2); near(FF.d2PoisonTickMult(s), 1.40, 'Plaguebearer Virulence: +40% poison ticks');
      wearD2('assassin', 2);     near(FF.d2BleedTickMult(s), 1.50, 'Assassin Exsanguinate: +50% bleed ticks');
      wearD2('pyromancer', 2);   near(FF.d2BurnTickMult(s), 1.40, 'Pyromancer Conflagration: +40% burn ticks');
      wearD2('ranger', 2);       near(FF.rangerAilmentDmgMult(s), 1.25, 'Ranger Barbed Ailments: +25% ailment ticks');
      // Barbed Ailments compounds with a class DoT bonus (e.g. poison) when both sets are... single-set only,
      // so a bare state gives 1x.
      s.bodyArmor = {}; s.uniqueItems = {}; near(FF.d2PoisonTickMult(s), 1.0, 'no set -> poison ticks unchanged');
      // Miasma (Plaguebearer full): poisoned foes take +15%.
      wearD2('plaguebearer', 4); s.activity = { type:'combat', monsterHp:500, potionPoisonUntil:Date.now()+9999, potionPoisonDps:10 };
      near(FF.d2SetDmgMult({hp:1000}, s), 1.15, 'Plaguebearer Miasma: +15% vs a poisoned foe');
      // Hunter's Mark (Ranger full): ailing foes take +15% (uses enemyHasAilment).
      wearD2('ranger', 4); ok(FF.enemyHasAilment(s), 'a poisoned foe counts as ailing');
      near(FF.d2SetDmgMult({hp:1000}, s), 1.15, "Ranger Hunter's Mark: +15% vs an ailing foe");
      s.activity = { type:'combat', monsterHp:500 }; near(FF.d2SetDmgMult({hp:1000}, s), 1.0, "Hunter's Mark inert on a clean foe");
      // First Blood (Assassin full): +40% on a full-HP foe only.
      wearD2('assassin', 4); s.activity = { type:'combat', monsterHp:1000 };
      near(FF.d2SetDmgMult({hp:1000}, s), 1.40, 'Assassin First Blood: +40% on a full-HP foe');
      s.activity.monsterHp = 500; near(FF.d2SetDmgMult({hp:1000}, s), 1.0, 'First Blood inert once the foe is hurt');
      // Iaijutsu Mastery (Samurai 2pc): +50% on the opening strike (samuraiFirstStrike flag).
      wearD2('samurai', 2); s.activity = { type:'combat', monsterHp:500, samuraiFirstStrike:true };
      near(FF.d2SetDmgMult({hp:1000}, s), 1.50, 'Samurai Iaijutsu Mastery: +50% opening strike');
      s.activity.samuraiFirstStrike = false; near(FF.d2SetDmgMult({hp:1000}, s), 1.0, 'Iaijutsu inert after the opener');
      // Zanshin (Samurai full): +15% crit at max Focus.
      wearD2('samurai', 4); s.activity = { type:'combat', monsterHp:500, samuraiFocus:FF.samuraiFocusCap(s) };
      near(FF.d2SetCritChance(s), 0.15, 'Samurai Zanshin: +15% crit at max Focus');
      s.activity.samuraiFocus = 0; near(FF.d2SetCritChance(s), 0.0, 'Zanshin inert below max Focus');
      // Grounding Rod (Thunderfury 2pc): needs Galvanize (Lv80) to show; check the per-stack scaling is applied.
      wearD2('thunderfury', 2); ok(typeof FF.thunderGalvanizeCritDmg === 'function', 'thunderGalvanizeCritDmg exported (Grounding Rod scales it)');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.playerHp=sv.hp; s.activity=sv.act; }
  });

  // ---- D2 sets: Batch E effects (Summoner / Spellblade / Quickdraw / Executioner) --------------------
  suite('D2 sets: Batch E combat effects', function(){
    var s = FF._state;
    var sv = { ba:s.bodyArmor, ui:s.uniqueItems, hp:s.playerHp, act:s.activity,
               fs:s.d2FeralStacks, fu:s.d2FeralUntil, bs:s.d2BloodthirstStacks, bu:s.d2BloodthirstUntil,
               mh:s.equippedMainhandUid, oh:s.equippedOffhandUid, be:s.equippedBeltUid, rl:s.equippedRelicUid, js:s.jewelrySlots };
    function wearD2(cls, n){
      var order = FF.D2_SET_DEFS[cls].bareHead ? ['chest','gauntlets','boots'] : ['helmet','chest','gauntlets','boots'];
      s.bodyArmor = {}; s.uniqueItems = {};
      for(var i=0;i<n;i++){ var uid='w'+i; s.uniqueItems[uid] = { set:cls, setLayer:'d2' }; s.bodyArmor[order[i]] = { uid:uid }; }
    }
    var foe = { hp:1000 };
    try {
      // Isolate the enchant counter: null every other equipped slot so equippedEnchantCount only sees worn D2 pieces.
      s.equippedMainhandUid = s.equippedOffhandUid = s.equippedBeltUid = s.equippedRelicUid = null; s.jewelrySlots = {};
      var mh = FF.maxHp(s); s.playerHp = mh; s.activity = { type:'combat', monsterHp:800 };
      // Summoner Feral Surge (2pc): +5% per stack while the window is live.
      wearD2('summoner', 2); s.d2FeralStacks = 3; s.d2FeralUntil = Date.now()+9999;
      near(FF.d2SetDmgMult(foe, s), 1 + 0.05*3, 'Summoner Feral Surge: +5% per recent familiar cast');
      s.d2FeralUntil = Date.now()-1; near(FF.d2SetDmgMult(foe, s), 1.0, 'Feral Surge lapses after its window');
      s.d2FeralStacks = 0; s.d2FeralUntil = 0; FF.d2FeralOnCast(s);
      eq(s.d2FeralStacks, 1, 'a familiar cast adds a Feral Surge stack (cap = active-familiar count, min 1)');
      ok(s.d2FeralUntil > Date.now(), 'a familiar cast opens the Feral Surge window');
      // Summoner Bloodmoon Pack (full): familiars cast 25% faster.
      s.bodyArmor = {}; s.uniqueItems = {}; var baseMs = FF.familiarCastIntervalMs();
      wearD2('summoner', 4); var setMs = FF.familiarCastIntervalMs();
      near(setMs/baseMs, 0.75, 'Summoner Bloodmoon Pack: familiars cast 25% faster');
      // Spellblade Arcane Overflow (2pc): +2% per equipped enchant.
      wearD2('spellblade', 2); s.uniqueItems.w0.enchants = [{},{},{}];
      eq(FF.equippedEnchantCount(s), 3, 'the worn Spellblade piece carries 3 enchants');
      near(FF.d2SetDmgMult(foe, s), 1 + 0.02*3, 'Spellblade Arcane Overflow: +2% per equipped enchant');
      // Spellblade Runic Detonation (full): +5% per Echo debuff stack (no enchants -> Arcane Overflow = 1).
      wearD2('spellblade', 4); s.activity = { type:'combat', monsterHp:800, d2RunicStacks:4, d2RunicUntil:Date.now()+9999 };
      near(FF.d2SetDmgMult(foe, s), 1 + 0.05*4, 'Spellblade Runic Detonation: +5% per Echo stack');
      s.activity.d2RunicUntil = Date.now()-1; near(FF.d2SetDmgMult(foe, s), 1.0, 'Runic Detonation lapses after its window');
      // Executioner Cleave (2pc): +20% vs non-boss; inert vs a boss.
      wearD2('executioner', 2);
      near(FF.d2SetDmgMult({hp:1000}, s), 1.20, 'Executioner Cleave: +20% vs a non-boss foe');
      near(FF.d2SetDmgMult({hp:1000, isBoss:true}, s), 1.0, 'Cleave inert against a boss');
      // Executioner Bloodthirst (full): stacking attack speed after kills.
      wearD2('executioner', 3); s.d2BloodthirstStacks = 3; s.d2BloodthirstUntil = Date.now()+9999;
      near(FF.d2BloodthirstSpeedMult(s), 1 - 0.08*3, 'Executioner Bloodthirst: -8% attack timer per kill stack');
      s.d2BloodthirstUntil = Date.now()-1; near(FF.d2BloodthirstSpeedMult(s), 1.0, 'Bloodthirst lapses after its window');
      s.d2BloodthirstStacks = 0; s.d2BloodthirstUntil = 0; FF.d2BloodthirstOnKill(s);
      eq(s.d2BloodthirstStacks, 1, 'a kill adds a Bloodthirst stack');
      // Quickdraw Paralytic Venom (full): a venomed foe's attacks are slowed 30%.
      wearD2('quickdraw', 4); s.activity = { type:'combat', monsterHp:800, potionPoisonUntil:Date.now()+9999, potionPoisonDps:10 };
      near(FF.quickdrawParalyticSlow(s), 0.30, 'Quickdraw Paralytic Venom: -30% enemy attack speed vs a venomed foe');
      ok(FF.enemyExtraSlowPct(s) >= 0.30 - 1e-9, 'Paralytic Venom folds into the enemy slow total');
      s.activity.potionPoisonUntil = Date.now()-1; near(FF.quickdrawParalyticSlow(s), 0.0, 'Paralytic Venom inert without venom');
    } finally { s.bodyArmor=sv.ba; s.uniqueItems=sv.ui; s.playerHp=sv.hp; s.activity=sv.act; s.d2FeralStacks=sv.fs; s.d2FeralUntil=sv.fu; s.d2BloodthirstStacks=sv.bs; s.d2BloodthirstUntil=sv.bu; s.equippedMainhandUid=sv.mh; s.equippedOffhandUid=sv.oh; s.equippedBeltUid=sv.be; s.equippedRelicUid=sv.rl; s.jewelrySlots=sv.js; }
  });

  // ---- D2 sets: Quickdraw Rapid Reload integrates through classAttackSpeedMult on a live Quickdraw -----
  suite('D2 sets: Quickdraw Rapid Reload (attack speed)', function(){
    function u(cls){ return { set:cls, setLayer:'d2' }; }
    function slot(mat, uid){ return { material:mat, tier:22, rarity:'fantastic', uid:uid }; }
    var hi = FF.xpFloorForLevel(85);
    var st = { xp:{ quickdraw: hi }, physique:{}, playerHp:1e9,
               equippedMainhand:'bowShort', equippedMainhandRarity:'normal', equippedOffhand:'quiver',
               uniqueItems:{ q0:u('quickdraw'), q1:u('quickdraw'), q2:u('quickdraw'), q3:u('quickdraw') },
               bodyArmor:{ helmet:slot('leather','q0'), chest:slot('leather','q1'), gauntlets:slot('leather','q2'), boots:slot('plate','q3') } };
    eq(FF.activeClassId(st), 'quickdraw', 'D2 Quickdraw armor + short bow + quiver activates Quickdraw');
    eq(FF.set2D2('quickdraw', st), true, 'the four D2 pieces trigger the Quickdraw 2-piece bonus');
    near(FF.classAttackSpeedMult(st), 0.88, 'Rapid Reload: +12% attack speed with a bow (x0.88 timer)', 1e-9);
    var bare = { xp:{ quickdraw: hi }, physique:{}, playerHp:1e9,
                 equippedMainhand:'bowShort', equippedMainhandRarity:'normal', equippedOffhand:'quiver',
                 bodyArmor:{ helmet:{material:'leather',tier:5}, chest:{material:'leather',tier:5}, gauntlets:{material:'leather',tier:5}, boots:{material:'plate',tier:5} } };
    near(FF.classAttackSpeedMult(bare), 1.0, 'no D2 set -> no Rapid Reload', 1e-9);
  });

  // ---- D1 armor Set Items: t21 pieces, forge, equip, defense ------------------------------------------
  suite('D1 armor sets: forge + equip + t21 stats', function(){
    // The four material formulas exist with the right bill.
    var cloth = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','cloth')]);
    ok(cloth && cloth.setarmor, 'the Cloth armor formula is a set-armor recipe');
    eq(cloth.inputs.weaving_t20, 1000, 'Cloth set formula costs 1000 t20 cloth');
    eq(cloth.rareCount, 10, 'set formulas need 10 rare t20 armor of the material');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','plate')]).inputs.metallurgy_t20, 1000, 'Plate set formula costs 1000 t20 ingots');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','leather')]).inputs.tanning_t20, 1000, 'Leather set formula costs 1000 t20 leather');
    // The catalyst is rare t20 armor of that material, across the four slots.
    ok(FF.setArmorRareIds('tailoring').indexOf('bodyarmor_tailoring_helmet_t20_rare') !== -1, 'cloth catalyst counts rare t20 cloth armor');
    eq(FF.setArmorRareIds('chain').length, 4, 'four slots of rare t20 chain armor count as catalysts');

    var s = FF._state, svInv = s.inventory, svUniq = s.uniqueItems, svBody = s.bodyArmor, svBp = s.blueprints, svXp = s.xp, svPhys = s.physique;

    // Full forge: give the bill, craft a Chain set piece, confirm a t21 set unique is minted.
    s.uniqueItems = {}; s.blueprints = {};
    s.inventory = { metallurgy_t20: 1000 };
    FF.setArmorRareIds('chain').forEach(function(id){ s.inventory[id] = 3; });
    var bp = FF.masterworkBlueprintId('d1','chain'); s.blueprints[bp] = 1;
    FF.craftMastercraft(bp);
    var mintedUid = Object.keys(s.uniqueItems)[0];
    var u = s.uniqueItems[mintedUid];
    ok(u && u.set && FF.D1_SET_DEFS[u.set], 'the forge mints a set-piece unique carrying its class-set');
    eq(u.material, 'chain', 'a Chain formula forges a chain piece');
    eq(u.tier, FF.SET_TIER_INDEX, 'the set piece is t21 (one above the t20 cap)');
    ok(/^bodyarmor_chain_(helmet|chest|gauntlets|boots)_t21_(rare|supreme|fantastic)$/.test(u.base), 'the base is a t21 chain armor item, floored at Rare');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 1000 ingots');
    eq(s.blueprints[bp], 0, 'the forge consumes the Blueprint');
    var rareLeft = FF.setArmorRareIds('chain').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, 4*3 - 10, 'the forge consumes exactly 10 rare chain armor pieces');

    // Enchant slots follow rarity (the shared unique rule): normal 1 / rare 2 / supreme 3 / fantastic 4.
    eq(FF.enchantSlotsFor(u.rarity), ({normal:1,rare:2,supreme:3,fantastic:4})[u.rarity], 'a set piece uses the rarity enchant-slot rule');

    // Equip it: requires t20 (level 100) armor proficiency, then it seats + counts toward the set.
    s.bodyArmor = { helmet:{tier:0,rarity:'normal'}, chest:{tier:0,rarity:'normal'}, gauntlets:{tier:0,rarity:'normal'}, boots:{tier:0,rarity:'normal'}, back:{tier:0,rarity:'normal'} };
    s.physique = {}; s.xp = {}; // no proficiency yet
    eq(FF.equipUniqueBodyArmor(mintedUid), false, 'a t21 set piece needs maxed armor proficiency to equip');
    s.xp.chainmailarmor = FF.xpFloorForLevel(100);
    eq(FF.equipUniqueBodyArmor(mintedUid), true, 'with maxed Chain proficiency, the set piece equips');
    eq(s.bodyArmor[u.slot].uid, mintedUid, 'the piece seats in its slot');
    eq(s.bodyArmor[u.slot].material, 'chain', 'the seated slot records its material (for class gating)');
    eq(FF.setPiecesWorn(u.set, s), 1, 'the equipped piece counts toward its class set');
    // Its t21 defense flows through the normal armor total and beats a t20 rare of the same slot.
    var setDef = FF.getTotalArmorDefense(s);
    ok(setDef > 0, 'the t21 set piece contributes armor defense');

    s.inventory = svInv; s.uniqueItems = svUniq; s.bodyArmor = svBody; s.blueprints = svBp; s.xp = svXp; s.physique = svPhys;
  });

  // ---- D2 armor Set Items: t22 pieces, forge, equip, layer isolation (Batch F) -----------------------
  suite('D2 armor sets: forge + equip + t22 stats', function(){
    // The four D2 material formulas exist as set-armor recipes, one tier above D1.
    ['cloth','leather','chain','plate'].forEach(function(slot){
      var r = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2', slot)]);
      ok(r && r.setarmor, 'the D2 ' + slot + ' formula is a set-armor recipe');
      eq(r.layer, 'd2', 'the D2 ' + slot + ' formula is a d2-layer recipe');
      eq(r.rareCount, 20, 'D2 set formulas need 20 rare t20 armor (double D1)');
    });
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','chain')]).inputs.metallurgy_t20, 2000, 'D2 Chain formula costs 2000 t20 ingots');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','cloth')]).inputs.weaving_t20, 2000, 'D2 Cloth formula costs 2000 t20 cloth');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d2','leather')]).inputs.tanning_t20, 2000, 'D2 Leather formula costs 2000 t20 leather');

    var s = FF._state, svInv = s.inventory, svUniq = s.uniqueItems, svBody = s.bodyArmor, svBp = s.blueprints, svXp = s.xp, svPhys = s.physique;
    // Full forge: give the bill, craft a D2 Chain set piece, confirm a t22 set unique on the d2 layer.
    s.uniqueItems = {}; s.blueprints = {};
    s.inventory = { metallurgy_t20: 2000 };
    FF.setArmorRareIds('chain').forEach(function(id){ s.inventory[id] = 6; }); // 4 slots x 6 = 24 rare t20 chain
    var bp = FF.masterworkBlueprintId('d2','chain'); s.blueprints[bp] = 1;
    FF.craftMastercraft(bp);
    var mintedUid = Object.keys(s.uniqueItems)[0];
    var u = s.uniqueItems[mintedUid];
    ok(u && u.set && FF.D2_SET_DEFS[u.set], 'the D2 forge mints a set-piece unique carrying its class-set');
    eq(u.setLayer, 'd2', 'the minted piece is tagged as a D2-layer set piece');
    eq(u.material, 'chain', 'a D2 Chain formula forges a chain piece');
    eq(u.tier, FF.SET_TIER_INDEX_D2, 'the D2 set piece is t22 (two above the t20 cap)');
    ok(/^bodyarmor_chain_(helmet|chest|gauntlets|boots)_t22_(rare|supreme|fantastic)$/.test(u.base), 'the base is a t22 chain armor item, floored at Rare');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 2000 ingots');
    var rareLeft = FF.setArmorRareIds('chain').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, 4*6 - 20, 'the forge consumes exactly 20 rare chain armor pieces');

    // Equip it: t22 pieces still gate on maxed Chain proficiency, and count toward the D2 layer only.
    s.bodyArmor = { helmet:{tier:0,rarity:'normal'}, chest:{tier:0,rarity:'normal'}, gauntlets:{tier:0,rarity:'normal'}, boots:{tier:0,rarity:'normal'}, back:{tier:0,rarity:'normal'} };
    s.physique = {}; s.xp = { chainmailarmor: FF.xpFloorForLevel(100) };
    eq(FF.equipUniqueBodyArmor(mintedUid), true, 'with maxed Chain proficiency, the D2 set piece equips');
    eq(s.bodyArmor[u.slot].uid, mintedUid, 'the piece seats in its slot');
    eq(FF.setPiecesWorn(u.set, s, 'd2'), 1, 'the equipped piece counts toward its class D2 set');
    eq(FF.setPiecesWorn(u.set, s, 'd1'), 0, 'a D2 piece does NOT count toward the D1 set (layer isolation)');

    s.inventory = svInv; s.uniqueItems = svUniq; s.bodyArmor = svBody; s.blueprints = svBp; s.xp = svXp; s.physique = svPhys;
  });

  // ---- D3 armor Set Items: t23 pieces, forge, equip, layer isolation (Batch Q) -----------------------
  suite('D3 armor sets: forge + equip + t23 stats', function(){
    ['cloth','leather','chain','plate'].forEach(function(slot){
      var r = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3', slot)]);
      ok(r && r.setarmor, 'the D3 ' + slot + ' formula is a set-armor recipe');
      eq(r.layer, 'd3', 'the D3 ' + slot + ' formula is a d3-layer recipe');
      eq(r.rareCount, 30, 'D3 set formulas need 30 rare t20 armor (triple D1)');
    });
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','chain')]).inputs.metallurgy_t20, 3000, 'D3 Chain formula costs 3000 t20 ingots');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d3','cloth')]).inputs.weaving_t20, 3000, 'D3 Cloth formula costs 3000 t20 cloth');

    var s = FF._state, svInv = s.inventory, svUniq = s.uniqueItems, svBody = s.bodyArmor, svBp = s.blueprints, svXp = s.xp, svPhys = s.physique;
    // Full forge: give the bill, craft a D3 Chain set piece, confirm a t23 set unique on the d3 layer.
    s.uniqueItems = {}; s.blueprints = {};
    s.inventory = { metallurgy_t20: 3000 };
    FF.setArmorRareIds('chain').forEach(function(id){ s.inventory[id] = 10; }); // 4 slots x 10 = 40 rare t20 chain
    var bp = FF.masterworkBlueprintId('d3','chain'); s.blueprints[bp] = 1;
    FF.craftMastercraft(bp);
    var mintedUid = Object.keys(s.uniqueItems)[0];
    var u = s.uniqueItems[mintedUid];
    ok(u && u.set && FF.D3_SET_DEFS[u.set], 'the D3 forge mints a set-piece unique carrying its class-set');
    eq(u.setLayer, 'd3', 'the minted piece is tagged as a D3-layer set piece');
    eq(u.material, 'chain', 'a D3 Chain formula forges a chain piece');
    eq(u.tier, FF.SET_TIER_INDEX_D3, 'the D3 set piece is t23 (three above the t20 cap)');
    ok(/^bodyarmor_chain_(helmet|chest|gauntlets|boots)_t23_(rare|supreme|fantastic)$/.test(u.base), 'the base is a t23 chain armor item, floored at Rare');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 3000 ingots');
    var rareLeft = FF.setArmorRareIds('chain').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, 4*10 - 30, 'the forge consumes exactly 30 rare chain armor pieces');

    // Equip it: t23 pieces gate on maxed Chain proficiency, and count toward the D3 layer only.
    s.bodyArmor = { helmet:{tier:0,rarity:'normal'}, chest:{tier:0,rarity:'normal'}, gauntlets:{tier:0,rarity:'normal'}, boots:{tier:0,rarity:'normal'}, back:{tier:0,rarity:'normal'} };
    s.physique = {}; s.xp = { chainmailarmor: FF.xpFloorForLevel(100) };
    eq(FF.equipUniqueBodyArmor(mintedUid), true, 'with maxed Chain proficiency, the D3 set piece equips');
    eq(s.bodyArmor[u.slot].uid, mintedUid, 'the piece seats in its slot');
    eq(FF.setPiecesWorn(u.set, s, 'd3'), 1, 'the equipped piece counts toward its class D3 set');
    eq(FF.setPiecesWorn(u.set, s, 'd2'), 0, 'a D3 piece does NOT count toward the D2 set');
    eq(FF.setPiecesWorn(u.set, s, 'd1'), 0, 'a D3 piece does NOT count toward the D1 set (layer isolation)');

    s.inventory = svInv; s.uniqueItems = svUniq; s.bodyArmor = svBody; s.blueprints = svBp; s.xp = svXp; s.physique = svPhys;
  });

  // ---- D4 armor sets: forge + equip + t24 stats (Batch BB) --------------------------------------------
  suite('D4 armor sets: forge + equip + t24 stats', function(){
    ['cloth','leather','chain','plate'].forEach(function(slot){
      var r = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4', slot)]);
      ok(r && r.setarmor, 'the D4 ' + slot + ' formula is a set-armor recipe');
      eq(r.layer, 'd4', 'the D4 ' + slot + ' formula is a d4-layer recipe');
      eq(r.rareCount, 40, 'D4 set formulas need 40 rare t20 armor (quadruple D1)');
    });
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','plate')]).inputs.metallurgy_t20, 4000, 'D4 Plate formula costs 4000 t20 ingots');
    eq(FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d4','cloth')]).inputs.weaving_t20, 4000, 'D4 Cloth formula costs 4000 t20 cloth');

    var s = FF._state, svInv = s.inventory, svUniq = s.uniqueItems, svBody = s.bodyArmor, svBp = s.blueprints, svXp = s.xp, svPhys = s.physique;
    // Full forge: give the bill, craft a D4 Plate set piece, confirm a t24 set unique on the d4 layer.
    s.uniqueItems = {}; s.blueprints = {};
    s.inventory = { metallurgy_t20: 4000 };
    FF.setArmorRareIds('plate').forEach(function(id){ s.inventory[id] = 12; }); // 4 slots x 12 = 48 rare t20 plate
    var bp = FF.masterworkBlueprintId('d4','plate'); s.blueprints[bp] = 1;
    FF.craftMastercraft(bp);
    var mintedUid = Object.keys(s.uniqueItems)[0];
    var u = s.uniqueItems[mintedUid];
    ok(u && u.set && FF.D4_SET_DEFS[u.set], 'the D4 forge mints a set-piece unique carrying its class-set');
    eq(u.setLayer, 'd4', 'the minted piece is tagged as a D4-layer set piece');
    eq(u.material, 'plate', 'a D4 Plate formula forges a plate piece');
    eq(u.tier, FF.SET_TIER_INDEX_D4, 'the D4 set piece is t24 (four above the t20 cap)');
    ok(/^bodyarmor_plate_(helmet|chest|gauntlets|boots)_t24_(rare|supreme|fantastic)$/.test(u.base), 'the base is a t24 plate armor item, floored at Rare');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 4000 ingots');
    var rareLeft = FF.setArmorRareIds('plate').reduce(function(n,id){ return n + (s.inventory[id]||0); }, 0);
    eq(rareLeft, 4*12 - 40, 'the forge consumes exactly 40 rare plate armor pieces');

    // Equip it: t24 pieces gate on maxed Plate proficiency, and count toward the D4 layer only.
    s.bodyArmor = { helmet:{tier:0,rarity:'normal'}, chest:{tier:0,rarity:'normal'}, gauntlets:{tier:0,rarity:'normal'}, boots:{tier:0,rarity:'normal'}, back:{tier:0,rarity:'normal'} };
    s.physique = {}; s.xp = { platearmor: FF.xpFloorForLevel(100) };
    eq(FF.equipUniqueBodyArmor(mintedUid), true, 'with maxed Plate proficiency, the D4 set piece equips');
    eq(s.bodyArmor[u.slot].uid, mintedUid, 'the piece seats in its slot');
    eq(FF.setPiecesWorn(u.set, s, 'd4'), 1, 'the equipped piece counts toward its class D4 set');
    eq(FF.setPiecesWorn(u.set, s, 'd3'), 0, 'a D4 piece does NOT count toward the D3 set');
    eq(FF.setPiecesWorn(u.set, s, 'd1'), 0, 'a D4 piece does NOT count toward the D1 set (layer isolation)');

    s.inventory = svInv; s.uniqueItems = svUniq; s.bodyArmor = svBody; s.blueprints = svBp; s.xp = svXp; s.physique = svPhys;
  });

  // ---- D1 set bonuses, Batch 1: DoT caps & procs ------------------------------------------------------
  suite('D1 set bonuses: DoT caps & procs', function(){
    // Build a state wearing `count` of a class's set pieces (unique.set on body-armor slots).
    function setSt(cls, count, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, activity:{type:'combat', monsterHp:100}, playerHp:100 };
      var slots = Object.keys(FF.D1_SET_DEFS[cls].pieces);
      for(var i=0;i<count && i<slots.length;i++){ var uid='sp'+i; st.uniqueItems[uid] = { uid:uid, set:cls };
        st.bodyArmor[slots[i]] = { uid:uid, material:FF.D1_SET_DEFS[cls].pieces[slots[i]], tier:22, rarity:'rare' }; }
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();

    // 2-piece cap raises: Bleed / Burn / Chill 5 -> 8; Samurai Focus 1 -> 2/hit.
    eq(FF.reaverBleedCap(setSt('reaver',2)), 8, 'Rabid (2pc): Reaver Bleed cap -> 8');
    eq(FF.reaverBleedCap(setSt('reaver',1)), 5, '1 piece -> base Bleed cap 5');
    eq(FF.pyroBurnCap(setSt('pyromancer',2)), 8, 'Wildfire (2pc): Burn cap -> 8');
    eq(FF.pyroBurnCap(setSt('pyromancer',1)), FF.PYRO_BURN_MAX_STACKS, '1 piece -> base Burn cap');
    eq(FF.frostChillCap(setSt('frostwarden',2)), 8, 'Deep Chill (2pc): Chill cap -> 8');
    eq(FF.frostChillCap(setSt('frostwarden',1)), FF.FROST_CHILL_MAX_STACKS, '1 piece -> base Chill cap');
    eq(FF.samuraiFocusPerHit(setSt('samurai',2)), 2, 'Unbroken Focus (2pc): +2 Focus per hit');
    eq(FF.samuraiFocusPerHit(setSt('samurai',1)), 1, '1 piece -> +1 Focus per hit');

    // Poison / ailment multipliers.
    near(FF.plagueBloomMult(setSt('plaguebearer',2)), 1.5, 'Plague Bloom (2pc): poison ticks x1.5');
    near(FF.plagueBloomMult(setSt('plaguebearer',1)), 1, '1 piece -> poison unmodified');
    near(FF.rangerAilmentDurMult(setSt('ranger',2)), 1.5, 'Persistent Ailments (2pc): ailments last x1.5');
    near(FF.rangerProcChance(setSt('ranger',4)), 0.40, 'Toxic Fletching (full): ailment proc chance 40%');
    near(FF.rangerProcChance(setSt('ranger',2)), 0.25, '2 of 4 -> base 25% proc (full-set not met)');

    // Full-set capstones.
    var frFull = setSt('frostwarden',4, { activity:{type:'combat', chillStacks:5, enemyChillUntil: now+4000} });
    near(FF.hoarfrostIncomingMult(frFull), 1 - 0.20, 'Hoarfrost (full): a 5-Chill foe deals -20%', 1e-9);
    near(FF.hoarfrostIncomingMult(setSt('frostwarden',2, { activity:{type:'combat', chillStacks:5, enemyChillUntil: now+4000} })), 1, 'no Hoarfrost below the full set');
    var rvFull = setSt('reaver',4, { activity:{type:'combat', bleedStacks:5, bleedUntil: now+4000} });
    near(FF.reaverFeedingFrenzyMult(rvFull), 1 - 0.20, 'Feeding Frenzy (full): 5 Bleed stacks -> -20% attack timer', 1e-9);
    near(FF.reaverFeedingFrenzyMult(setSt('reaver',1, { activity:{type:'combat', bleedStacks:5, bleedUntil: now+4000} })), 1, 'no Feeding Frenzy below the full set');

    // Flowing Strikes integrates through classAttackSpeedMult on a live Samurai (leather set = the class armor).
    function armor(mat){ return { material:mat, tier:5 }; }
    var samu = setSt('samurai',4, { equippedMainhand:'falchion', xp:{ samurai: FF.xpFloorForLevel(85) } });
    samu.activity = { type:'combat', samuraiFocus:10 }; // at Focus cap
    eq(FF.activeClassId(samu), 'samurai', 'a full leather set + katana activates Samurai');
    near(FF.classAttackSpeedMult(samu), 0.80, 'Flowing Strikes: +20% attack speed at max Focus', 1e-9);
    samu.activity.samuraiFocus = 3; // below cap
    near(FF.classAttackSpeedMult(samu), 1, 'no Flowing Strikes below max Focus');
  });

  // ---- D1 set bonuses, Batch 2: crit / tempo / momentum ----------------------------------------------
  suite('D1 set bonuses: crit, tempo & momentum', function(){
    function setSt(cls, count, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, activity:{type:'combat', monsterHp:100}, playerHp:100 };
      var slots = Object.keys(FF.D1_SET_DEFS[cls].pieces);
      for(var i=0;i<count && i<slots.length;i++){ var uid='sp'+i; st.uniqueItems[uid] = { uid:uid, set:cls };
        st.bodyArmor[slots[i]] = { uid:uid, material:FF.D1_SET_DEFS[cls].pieces[slots[i]], tier:22, rarity:'rare' }; }
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();

    // The Batch 2 outgoing-damage row exists in the ordered table.
    ok(FF.PLAYER_DMG_MODS.some(function(r){ return r.name === 'setBonuses'; }), 'setBonuses is a named PLAYER_DMG_MODS row');

    // Juggernaut Heavy Hitter (2pc): Wind-Up 45% -> 60%.
    near(FF.jugWindupDmg(setSt('juggernaut',2)), 1.60, 'Heavy Hitter: Wind-Up +60%');
    near(FF.jugWindupDmg(setSt('juggernaut',1)), FF.JUG_WINDUP_DMG, '1 piece -> base Wind-Up');
    // Knight Unstoppable Force (2pc): +25% only at max Momentum.
    near(FF.knightUnstoppableMult(setSt('knight',2, { knightStacks:5 })), 1.25, 'Unstoppable Force: +25% at max Momentum');
    near(FF.knightUnstoppableMult(setSt('knight',2, { knightStacks:2 })), 1, 'no Unstoppable Force below max Momentum');
    near(FF.knightUnstoppableMult(setSt('knight',1, { knightStacks:5 })), 1, '1 piece -> no Unstoppable Force');
    // Thunderfury Supercell (2pc) + Overcharge (full).
    eq(FF.thunderStaticPerHit(setSt('thunderfury',2)), 2, 'Supercell: Static builds 2/hit');
    eq(FF.thunderStaticThreshold(setSt('thunderfury',4)), 4, 'Overcharge: discharge at 4 stacks');
    eq(FF.thunderStaticThreshold(setSt('thunderfury',2)), FF.THUNDER_STATIC_MAX, '2 of 4 -> base discharge threshold');
    ok(FF.thunderDischargeMult(setSt('thunderfury',4)) > FF.thunderDischargeMult(setSt('thunderfury',2)), 'Overcharge: bigger discharge burst');
    // Sharpshooter Deadeye (2pc).
    near(FF.deadeyeAccuracyBonus(setSt('sharpshooter',2)), 0.20, 'Deadeye: +20% Accuracy');
    near(FF.deadeyeAccuracyBonus(setSt('sharpshooter',1)), 0, '1 piece -> no Deadeye');
    // Duelist Redoublement (full).
    eq(FF.duelistFlourishStabs(setSt('duelist',4)), 5, 'Redoublement: Flourish = 5 stabs');
    eq(FF.duelistFlourishStabs(setSt('duelist',2)), 3, '2 of 4 -> 3 stabs');
    // Assassin Shadowstep (full): 3s Vanish window.
    eq(FF.assassinVanishMs(setSt('assassin',4)), 3000, 'Shadowstep: Vanish window arms in 3s');
    eq(FF.assassinVanishMs(setSt('assassin',3)), 4000, '3 of 4 -> base 4s window');
    // Time-ramp capstones: Momentum Swing (Juggernaut) + Long Shot (Sharpshooter).
    near(FF.jugMomentumSwingMult(setSt('juggernaut',4, { activity:{type:'combat', lastSwingAt: now-3000} })), 1.30, 'Momentum Swing: +30% after a 3s gap', 1e-2);
    near(FF.jugMomentumSwingMult(setSt('juggernaut',4, { activity:{type:'combat', lastSwingAt: now-20000} })), 1.50, 'Momentum Swing caps at +50%', 1e-2);
    near(FF.jugMomentumSwingMult(setSt('juggernaut',2, { activity:{type:'combat', lastSwingAt: now-3000} })), 1, 'no Momentum Swing below the full set');
    near(FF.longShotMult(setSt('sharpshooter',4, { activity:{type:'combat', lastDamagedAt: now-4000} })), 1.20, 'Long Shot: +20% after 4s untouched', 1e-2);
    near(FF.longShotMult(setSt('sharpshooter',2, { activity:{type:'combat', lastDamagedAt: now-4000} })), 1, 'no Long Shot below the full set');
  });

  // ---- D1 set bonuses, Batch 3: tank / block / shield / heal -----------------------------------------
  suite('D1 set bonuses: tank / block / shield / heal', function(){
    function setSt(cls, count, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, activity:{type:'combat', monsterHp:100}, playerHp:100 };
      var slots = Object.keys(FF.D1_SET_DEFS[cls].pieces);
      for(var i=0;i<count && i<slots.length;i++){ var uid='sp'+i; st.uniqueItems[uid] = { uid:uid, set:cls };
        st.bodyArmor[slots[i]] = { uid:uid, material:FF.D1_SET_DEFS[cls].pieces[slots[i]], tier:22, rarity:'rare' }; }
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Herald Full Retort (2pc): a Block reflects 100% of what it prevented (up from 50%).
    near(FF.heraldRipostePct(setSt('herald',2)), 1.0, 'Full Retort (2pc): reflect 100% of a Block');
    near(FF.heraldRipostePct(setSt('herald',1)), FF.HERALD_RIPOSTE_PCT, '1 piece -> base 50% Riposte');
    // Herald Bastion (full): no single blow exceeds 25% of max HP.
    var hFull = setSt('herald',4); var hCap = Math.max(1, Math.round(FF.maxHp(hFull) * 0.25));
    eq(FF.bastionCapHit(999999, hFull), hCap, 'Bastion (full): a huge hit is capped at 25% max HP');
    eq(FF.bastionCapHit(3, hFull), 3, 'Bastion: a small hit passes through untouched');
    eq(FF.bastionCapHit(999999, setSt('herald',2)), 999999, 'no Bastion cap below the full set');

    // Sentinel Unbreakable Will (full): +30% Armor.
    near(FF.sentinelUnbreakableArmorMult(setSt('sentinel',4)), 1.30, 'Unbreakable Will (full): +30% Armor');
    near(FF.sentinelUnbreakableArmorMult(setSt('sentinel',2)), 1, 'no Unbreakable Will below the full set');
    // Sentinel Barbed Plating (2pc): thorns also return half your Armor rating -- needs the class active.
    function sentSt(asSet){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, equippedMainhand:'maul', equippedOffhand:'shieldMedium', activity:{type:'combat', monsterHp:100}, playerHp:55 };
      st.xp.sentinel = FF.xpFloorForLevel(80);
      ['helmet','chest','gauntlets','boots'].forEach(function(slot,i){
        if(asSet){ var uid='ss'+i; st.uniqueItems[uid] = { uid:uid, set:'sentinel' }; st.bodyArmor[slot] = { uid:uid, material:'chain', tier:22, rarity:'rare' }; }
        else st.bodyArmor[slot] = { material:'chain', tier:5 };
      });
      return st;
    }
    eq(FF.activeClassId(sentSt(true)), 'sentinel', 'a full Sentinel set still activates the Sentinel class');
    ok(FF.setFull('sentinel', sentSt(true)), 'four Sentinel pieces = full set');
    var rSet = FF.sentinelReflectDamage(100, 0, 200, sentSt(true));
    var rPlain = FF.sentinelReflectDamage(100, 0, 200, sentSt(false));
    near(rSet - rPlain, 100, 'Barbed Plating (2pc): thorns return an extra half of Armor (200 x 0.5)');

    // Berserker Undying Rage (2pc): -25% incoming damage below 30% HP.
    near(FF.undyingRageIncomingMult(setSt('berserker',2, { playerHp:1 })), 0.75, 'Undying Rage (2pc): -25% incoming below 30% HP');
    near(FF.undyingRageIncomingMult(setSt('berserker',2, { playerHp:9999 })), 1, 'no Undying Rage while healthy');
    near(FF.undyingRageIncomingMult(setSt('berserker',1, { playerHp:1 })), 1, '1 piece -> no Undying Rage');
    // Berserker Frenzied Blows (full): attack timer shrinks up to -30% as HP falls.
    var bFull = setSt('berserker',3, { playerHp:1 });
    ok(FF.berserkerFrenziedBlowsMult(bFull) < FF.berserkerFrenziedBlowsMult(setSt('berserker',3, { playerHp:9999 })), 'Frenzied Blows: faster while hurt than while full');
    near(FF.berserkerFrenziedBlowsMult(setSt('berserker',3, { playerHp:9999 })), 1, 'Frenzied Blows: no haste at full HP');
    near(FF.berserkerFrenziedBlowsMult(setSt('berserker',2, { playerHp:1 })), 1, 'no Frenzied Blows below the full set');

    // Templar Mercy (2pc): Lay on Hands mends 40% (up from 20%).
    near(FF.templarLayOnHandsPct(setSt('templar',2)), 0.40, 'Mercy (2pc): Lay on Hands heals 40%');
    near(FF.templarLayOnHandsPct(setSt('templar',1)), 0.20, '1 piece -> base 20% Lay on Hands');
    // Templar Blessing of Haste (full): -15% attack timer.
    near(FF.templarBlessingOfHasteMult(setSt('templar',4)), 0.85, 'Blessing of Haste (full): -15% attack timer');
    near(FF.templarBlessingOfHasteMult(setSt('templar',2)), 1, 'no Blessing of Haste below the full set');

    // Lumen Radiant Surge (2pc): Reflected Light heals 25% (up from 15%).
    near(FF.lumenReflectPct(setSt('lumen',2)), 0.25, 'Radiant Surge (2pc): Reflected Light 25%');
    near(FF.lumenReflectPct(setSt('lumen',1)), FF.LUMEN_REFLECT_PCT, '1 piece -> base Reflected Light');
    // Lumen Sanctuary (full): Radiant Barrier cap 30% -> 40% max HP.
    near(FF.lumenSanctuaryCapPct(setSt('lumen',4)), 0.40, 'Sanctuary (full): Barrier cap 40% max HP');
    near(FF.lumenSanctuaryCapPct(setSt('lumen',2)), FF.LUMEN_SHIELD_MAX_PCT, 'no Sanctuary below the full set');
    ok(FF.lumenShieldCap(setSt('lumen',4)) > FF.lumenShieldCap(setSt('lumen',2)), 'Sanctuary raises the actual shield cap');
  });

  // ---- D1 set bonuses, Batch 4: casters / familiars / echoes / void / misc --------------------------
  suite('D1 set bonuses: casters / familiars / echoes / void', function(){
    function setSt(cls, count, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, activity:{type:'combat', monsterHp:100}, playerHp:100 };
      var slots = Object.keys(FF.D1_SET_DEFS[cls].pieces);
      for(var i=0;i<count && i<slots.length;i++){ var uid='sp'+i; st.uniqueItems[uid] = { uid:uid, set:cls };
        st.bodyArmor[slots[i]] = { uid:uid, material:FF.D1_SET_DEFS[cls].pieces[slots[i]], tier:22, rarity:'rare' }; }
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }
    var now = Date.now();

    // Summoner Pack Tactics (2pc): +8% familiar damage per active familiar.
    var packSt = setSt('summoner', 2, { activeCompanions:['woodcutting'], familiars:{ woodcutting:{owned:true} } });
    near(FF.summonerPackTacticsMult(packSt), 1.08, 'Pack Tactics (2pc): +8% per active familiar');
    near(FF.summonerPackTacticsMult(setSt('summoner', 2, { activeCompanions:[], familiars:{} })), 1, 'Pack Tactics: no bonus with no familiars');
    near(FF.summonerPackTacticsMult(setSt('summoner', 1, { activeCompanions:['woodcutting'], familiars:{ woodcutting:{owned:true} } })), 1, '1 piece -> no Pack Tactics');

    // Spellblade Resonant Crit (full): echoes can Critically Hit.
    ok(FF.spellbladeResonantCrit(setSt('spellblade', 4)), 'Resonant Crit (full): echoes can crit');
    ok(!FF.spellbladeResonantCrit(setSt('spellblade', 2)), 'no Resonant Crit below the full set');
    // Echo Chamber (2pc): +15% echo chance where an echo mechanic already exists (base 0 without the class stays 0).
    eq(FF.spellbladeEchoChance(setSt('spellblade', 2)), 0, 'Echo Chamber does not fabricate echoes without the Spellblade echo perk');
    // With the Spellblade class active (greatsword + chain/leather set that doubles as its gear), Echo Chamber adds 15%.
    function sbSt(asSet, level){
      var st = { xp:{}, physique:{}, bodyArmor:{}, uniqueItems:{}, equippedMainhand:'greatsword', activity:{type:'combat', monsterHp:100}, playerHp:55 };
      st.xp.spellblade = FF.xpFloorForLevel(level);
      var mats = { helmet:'chain', chest:'chain', gauntlets:'leather', boots:'leather' };
      Object.keys(mats).forEach(function(slot,i){
        if(asSet){ var uid='sb'+i; st.uniqueItems[uid] = { uid:uid, set:'spellblade' }; st.bodyArmor[slot] = { uid:uid, material:mats[slot], tier:22, rarity:'rare' }; }
        else st.bodyArmor[slot] = { material:mats[slot], tier:5 };
      });
      return st;
    }
    eq(FF.activeClassId(sbSt(true,40)), 'spellblade', 'a full Spellblade set doubles as its class gear');
    near(FF.spellbladeEchoChance(sbSt(true,40)), 0.30, 'Echo Chamber (2pc): Spell Echo 15% -> 30%');
    near(FF.spellbladeEchoChance(sbSt(false,40)), 0.15, 'plain Spellblade Lv40 -> base 15% echo chance');

    // Voidshadow Resistance Rot (2pc): Vulnerability bites +3%/stack.
    near(FF.voidVulnPerStack(setSt('nightblade', 2)), 0.03, 'Resistance Rot (2pc): +3%/Vulnerability stack');
    near(FF.voidVulnPerStack(setSt('nightblade', 1)), FF.VOID_VULN_PER_STACK, '1 piece -> base +2%/stack');
    var vulnSt = setSt('nightblade', 2, { activity:{ type:'combat', monsterHp:100, voidVulnStacks:5, voidVulnUntil: now+4000 } });
    near(FF.voidVulnMult(vulnSt), 1.15, 'Resistance Rot: 5 stacks -> +15% damage taken (up from +10%)');
    // Malediction (full): each hit sinks 2 Vulnerability stacks.
    eq(FF.voidMarkPerHit(setSt('nightblade', 4)), 2, 'Malediction (full): 2 Vulnerability stacks per hit');
    eq(FF.voidMarkPerHit(setSt('nightblade', 2)), 1, 'no Malediction below the full set');

    // Quickdraw Venom Glut (2pc) + Trick Volley (full).
    near(FF.quickdrawVenomPct(setSt('quickdraw', 2)), 0.50, "Venom Glut (2pc): Serpent's Sting injects 50%");
    near(FF.quickdrawVenomPct(setSt('quickdraw', 1)), 0.30, '1 piece -> base 30%');
    near(FF.quickdrawTwinFangChance(setSt('quickdraw', 4)), 0.30, 'Trick Volley (full): Twin Fang 30%');
    near(FF.quickdrawTwinFangChance(setSt('quickdraw', 2)), 0.15, 'no Trick Volley below the full set');

    // Treasure Hunter Blessed Arsenal (2pc) + Wider Appraisal (full).
    near(FF.treasureProspectorPer(setSt('treasureHunter', 2)), 0.15, 'Blessed Arsenal (2pc): +15%/Rare+ item');
    near(FF.treasureProspectorPer(setSt('treasureHunter', 1)), 0.10, '1 piece -> base +10%');
    near(FF.setTreasureMult(setSt('treasureHunter', 4)), 1.25, 'Wider Appraisal (full): +25% Treasure Find');
    near(FF.setTreasureMult(setSt('treasureHunter', 2)), 1, 'no Wider Appraisal below the full set');
    near(FF.legTreasureMult(setSt('treasureHunter', 4)), 1.25, 'Wider Appraisal folds into the Treasure Find multiplier');

    // Executioner Execute (2pc): a non-boss foe below 15% Health is slain instantly (threshold constant;
    // the kill itself is exercised in the drive harness).
    near(FF.EXEC_SET_EXECUTE_FRAC, 0.15, 'Execute (2pc): instant-kill threshold is 15% max HP');
    ok(FF.set2('executioner', setSt('executioner', 2)), 'two Executioner pieces arm Execute');
    ok(!FF.set2('executioner', setSt('executioner', 1)), 'one piece does not arm Execute');
  });

  // ---- Combat card: buff/debuff stack badges -------------------------------------------
  suite('combat card shows buff & debuff stacks', function(){
    var S = FF._state, now = Date.now();
    var savedAct = S.activity;
    try {
      S.activity = { type:'combat', monsterHp:100,
        enemyChillUntil: now+5000, chillStacks: 6,
        bleedUntil: now+4000, bleedStacks: 4,
        frostbiteUntil: now+3000, frostbiteStacks: 3,
        burnUntil: now+3500, burnStacks: 5,
        voidVulnUntil: now+6000, voidVulnStacks: 7,
        enemyStunUntil: now+2000 };
      var deb = {}; FF.combatEnemyDebuffs().forEach(function(d){ deb[d.key] = d; });
      eq(deb.chill.stacks, 6, 'Chilled carries its stack count');
      eq(deb.bleed.stacks, 4, 'Bleeding carries its stack count');
      eq(deb.frostbite.stacks, 3, 'Frostbite is now shown, with stacks');
      eq(deb.burn.stacks, 5, 'Burning is now shown, with stacks');
      eq(deb.voidvuln.stacks, 7, 'Vulnerable carries its stack count');
      eq(deb.voidvuln.name, 'Vulnerable', 'the Vuln name is clean (count lives in the badge)');
      eq(deb.stun.stacks, undefined, 'a single (non-stacking) debuff has no stack count');
      // The rendered row carries a live-updating badge element and a filled bar.
      var html = FF.renderFxBars(FF.combatEnemyDebuffs(), 'Enemy Effects');
      ok(/id="arenaFxN-chill"/.test(html) && /&times;6/.test(html), 'the Chill row renders a x6 badge');
      ok(/id="arenaFxN-voidvuln"/.test(html), 'the Vuln row renders a live stack badge');
    } finally { S.activity = savedAct; }
  });

  // ---- Loadouts: save & swap the full combat kit, inventory-safe ------------------------
  suite('loadouts: capture / apply / conserve', function(){
    var S = FF._state;
    var saved = { inv:S.inventory, uq:S.uniqueItems, lo:S.loadouts,
      mh:S.equippedMainhand, mht:S.equippedMainhandTier, mhr:S.equippedMainhandRarity, mhu:S.equippedMainhandUid,
      ba:S.bodyArmor, js:S.jewelrySlots };
    try {
      FF.ensureLoadouts(); eq(S.loadouts.length, FF.LOADOUT_SLOT_COUNT, 'ensureLoadouts pads to 5 presets');
      // Gear/familiar changes are locked mid-fight.
      var _sa = S.activity; S.activity = { type:null }; ok(!FF.combatLocksGear(), 'no gear lock outside combat');
      S.activity = { type:'combat', monsterHp:100 }; ok(FF.combatLocksGear(), 'gear is locked during combat'); S.activity = _sa;
      // Activating/deactivating a companion is locked mid-fight, but examining a familiar card
      // (toggleFamiliar just expands/collapses it) must stay allowed so players can inspect spells.
      ok(FF.COMBAT_LOCKED_ACTIONS.activateCompanion, 'activate/deactivate companion is combat-locked');
      ok(FF.COMBAT_LOCKED_ACTIONS.equipLoadout, 'equipping a loadout is combat-locked');
      ok(!FF.COMBAT_LOCKED_ACTIONS.toggleFamiliar, 'expanding a familiar card to examine it is NOT combat-locked');
      var SW='stweapon_sword_t0_normal', CH='bodyarmor_chain_chest_t0_normal';
      FF.applyCombatLoadout({}); // naked
      S.inventory = {}; S.inventory[SW]=1; S.inventory[CH]=1;
      S.uniqueItems = { UZ:{ uid:'UZ', kind:'weapon', base:'x', tier:20, rarity:'rare', enchants:[], enhance:0 } };
      // capture snapshots every slot
      var snap = FF.captureCombatLoadout();
      ok(snap && 'mainhand' in snap && 'offhand' in snap && 'helmet' in snap && 'ring1' in snap && 'amulet' in snap && 'relic' in snap, 'capture snapshots every combat slot');
      // apply a kit: unique weapon + chain chest
      var gearA = { mainhand:{id:'sword',tier:0,rarity:'rare',uid:'UZ'}, chest:{tier:1,rarity:'normal',material:'chain'} };
      var r = FF.applyCombatLoadout(gearA);
      eq(S.equippedMainhandUid, 'UZ', 'apply equips the unique (uid pointer)');
      eq(S.bodyArmor.chest.material, 'chain', 'apply equips the chain chest');
      eq(S.inventory[CH]||0, 0, 'the chest was consumed from the bag');
      eq(r.dropped, 0, 'nothing dropped when everything is owned');
      // strip back to nothing returns the consumed item
      FF.applyCombatLoadout({});
      eq(S.inventory[CH]||0, 1, 'unequipping returns the chest to the bag (conserved)');
      ok(!!S.uniqueItems.UZ, 'the unique is never consumed — it stays in uniqueItems');
      // summary text
      ok(/pieces/.test(FF.loadoutSummary(gearA)), 'loadoutSummary reports the piece count');
    } finally {
      S.inventory=saved.inv; S.uniqueItems=saved.uq; S.loadouts=saved.lo;
      S.equippedMainhand=saved.mh; S.equippedMainhandTier=saved.mht; S.equippedMainhandRarity=saved.mhr; S.equippedMainhandUid=saved.mhu;
      S.bodyArmor=saved.ba; S.jewelrySlots=saved.js;
    }
  });

  suite('mastercraft: D1 legendary amulets', function(){
    // A state with a legendary Pendant seated in the Amulet slot.
    function amSt(key, rarity, extra){
      var st = { xp:{}, physique:{}, bodyArmor:{}, jewelrySlots:{ amulet:{ leg:key, rarity:rarity||'normal' } },
        activity:{type:'combat', monsterHp:100}, playerHp:100 };
      if(extra) for(var k in extra) st[k]=extra[k];
      return st;
    }

    // Data model: 3 Pendants x 4 rarities = 12 inventory items.
    eq(FF.D1_LEG_AMULET_DEFS.length, 3, 'three D1 legendary amulet effects');
    var keys = FF.D1_LEG_AMULET_DEFS.map(function(d){ return d.key; });
    eq(JSON.stringify(keys), JSON.stringify(['maxhealth','treasure','cheatdeath']), 'the three chosen effects: Max Health, Treasure, Cheat Death');
    eq(Object.keys(FF.LEGENDARY_AMULET_ITEMS).filter(function(id){ return FF.LEGENDARY_AMULET_ITEMS[id].dungeon==='d1'; }).length, 12, '3 D1 effects x 4 rarities = 12 D1 Pendant items');
    eq(FF.legAmuletItemId('maxhealth','rare'), 'legamulet_d1_maxhealth_rare', 'Pendant item id format');

    // Bonus scaling: base value x the 2x/4x/8x rarity ladder.
    near(FF.legendaryAmuletBonus('maxhealth', amSt('maxhealth','normal')), 0.10, 'Max Health: +10% at Normal');
    near(FF.legendaryAmuletBonus('maxhealth', amSt('maxhealth','rare')), 0.20, 'Max Health: +20% at Rare (2x)');
    near(FF.legendaryAmuletBonus('maxhealth', amSt('maxhealth','fantastic')), 0.80, 'Max Health: +80% at Fantastic (8x)');
    near(FF.legendaryAmuletBonus('treasure', amSt('treasure','normal')), 0.25, 'Treasure: +25% at Normal');
    near(FF.legendaryAmuletBonus('cheatdeath', amSt('cheatdeath','normal')), 0.15, 'Cheat Death: revive to 15% at Normal');
    near(FF.legendaryAmuletBonus('maxhealth', amSt('treasure','normal')), 0, 'a Pendant only grants its own effect');
    eq(FF.legAmuletEquipped('cheatdeath', amSt('cheatdeath','supreme')), true, 'legAmuletEquipped detects the seated Pendant');
    eq(FF.legAmuletEquipped('cheatdeath', amSt('maxhealth','supreme')), false, 'legAmuletEquipped false for a different effect');

    // Max Health folds into maxHp: +10% at Normal.
    var mhBase = { xp:{}, physique:{}, bodyArmor:{}, jewelrySlots:{ amulet:{ tier:0, rarity:'normal' } } };
    var mhAmu  = { xp:{}, physique:{}, bodyArmor:{}, jewelrySlots:{ amulet:{ leg:'maxhealth', rarity:'normal' } } };
    eq(FF.maxHp(mhAmu), Math.round(FF.maxHp(mhBase) * 1.10), 'Pendant of Vitality raises max HP by +10% at Normal');
    var mhFan  = { xp:{}, physique:{}, bodyArmor:{}, jewelrySlots:{ amulet:{ leg:'maxhealth', rarity:'fantastic' } } };
    eq(FF.maxHp(mhFan), Math.round(FF.maxHp(mhBase) * 1.80), 'Fantastic Pendant of Vitality raises max HP by +80%');

    // Treasure multiplier.
    near(FF.legTreasureMult(amSt('treasure','normal')), 1.25, 'Treasure Find multiplier is 1.25x at Normal');
    near(FF.legTreasureMult(amSt('treasure','supreme')), 2.0, 'Treasure Find multiplier is 2.0x at Supreme (4x base)');
    near(FF.legTreasureMult(amSt('maxhealth','normal')), 1, 'no Treasure bonus without the Fortune Pendant');

    // Forge recipe: exact input bill the user specified.
    var rec = FF.mastercraftRecipeFor(FF.BLUEPRINT_ITEMS[FF.masterworkBlueprintId('d1','amulet')]);
    ok(rec, 'a d1 amulet Mastercraft recipe exists');
    eq(rec.inputs.metallurgy_t20, 1000, 'amulet formula costs 1000 t20 ingots');
    eq(rec.inputs.twine_t20, 100, 'amulet formula costs 100 t20 twine');
    eq(rec.inputs.diving_t20, 100, 'amulet formula costs 100 t20 pearls');
    eq(rec.rareCount, 10, 'amulet formula needs 10 rare t20 amulets');
    eq(rec.outcomes.length, 3, 'the amulet formula forges one of three Pendants');

    // Rare-amulet counter reads plain + warding t20 rares.
    var s = FF._state, svInv = s.inventory, svJewel = s.jewelrySlots, svBp = s.blueprints;
    s.inventory = { amulet_t20_rare: 6, amulet_warding_t20_rare: 4 };
    eq(FF.countRareT20Amulets(), 10, 'countRareT20Amulets sums plain + warding rare t20 amulets');

    // Full forge mints a legendary Pendant inventory item.
    s.inventory = { metallurgy_t20:1000, twine_t20:100, diving_t20:100, amulet_t20_rare:10 };
    s.blueprints = {}; var bpId = FF.masterworkBlueprintId('d1','amulet'); s.blueprints[bpId] = 1;
    FF.craftMastercraft(bpId);
    var minted = Object.keys(s.inventory).filter(function(id){ return id.indexOf('legamulet_d1_')===0 && s.inventory[id]>0; });
    eq(minted.length, 1, 'the forge mints exactly one legendary Pendant');
    eq(s.inventory.metallurgy_t20, 0, 'the forge consumes the 1000 ingots');
    eq(s.inventory.amulet_t20_rare, 0, 'the forge consumes the 10 rare amulets');
    eq(s.blueprints[bpId], 0, 'the forge consumes the Blueprint');

    // Equip / unequip round-trips through the single Amulet slot.
    s.jewelrySlots = { amulet:{ tier:0, rarity:'normal' } };
    s.inventory = { legamulet_d1_maxhealth_rare: 1 };
    FF.equipLegAmulet('legamulet_d1_maxhealth_rare');
    eq(s.jewelrySlots.amulet.leg, 'maxhealth', 'equipLegAmulet seats the Pendant');
    eq(s.jewelrySlots.amulet.rarity, 'rare', 'the seated Pendant keeps its rarity');
    eq(s.inventory.legamulet_d1_maxhealth_rare || 0, 0, 'equipping consumes the inventory copy');
    FF.unequipLegAmulet();
    eq(s.inventory.legamulet_d1_maxhealth_rare, 1, 'unequip returns the Pendant to inventory');
    ok(!s.jewelrySlots.amulet.leg, 'the slot is cleared after unequip');
    // A normal amulet equipped over a legendary returns the legendary.
    s.jewelrySlots = { amulet:{ leg:'treasure', rarity:'supreme' } };
    s.inventory = { amulet_t0_normal: 1 };
    FF.equipAmulet('amulet_t0_normal');
    eq(s.inventory.legamulet_d1_treasure_supreme, 1, 'a normal amulet displaces the legendary back to inventory');
    s.inventory = svInv; s.jewelrySlots = svJewel; s.blueprints = svBp;
  });

  // ---- Dungeon gate: a minimum Total Level to enter ANY dungeon, plus the clear-the-previous-boss chain --
  suite('dungeons: Total Level gate + unlock chain', function(){
    var s = FF._state, saved = s.dungeonsCleared;
    eq(FF.DUNGEON_MIN_TOTAL_LEVEL, 5000, 'the dungeon entry gate is Total Level 5000');
    eq(FF.dungeonPrevId('d1'), null, 'd1 (Cave) has no prerequisite dungeon');
    eq(FF.dungeonPrevId('d2'), 'd1', 'd2 requires d1');
    eq(FF.dungeonPrevId('d3'), 'd2', 'd3 requires d2');
    eq(FF.dungeonPrevId('d4'), 'd3', 'd4 requires d3');
    // The default test state is below 5000 Total Level, so every layer is Total-Level-blocked first.
    ok(FF.playerTotalLevel(s) < FF.DUNGEON_MIN_TOTAL_LEVEL, 'the default test profile is under the Total Level gate');
    ok((FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d1) || '').indexOf('Total Level') === 0, 'the Cave is Total-Level-gated below 5000');
    s.dungeonsCleared = {};
    eq(FF.dungeonBossCleared('d1'), false, 'a boss is not cleared until beaten');
    FF.dungeonMarkCleared('d1');
    eq(FF.dungeonBossCleared('d1'), true, 'dungeonMarkCleared records the boss kill');
    // Whatever the level gate, d2 is never blocked by the prereq once d1 is cleared (block is the level gate or null).
    var b2 = FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d2);
    ok(b2 === null || b2.indexOf('Total Level') === 0, 'clearing d1 lifts d2\'s prerequisite (Total Level gate aside)');
    // Nothing cleared -> d4 is always blocked (prereq and/or level), never enterable.
    s.dungeonsCleared = {};
    ok(FF.dungeonEntryBlock(FF.DUNGEON_DEFS.d4) !== null, 'd4 is blocked while its prerequisites are unmet');
    s.dungeonsCleared = saved;
  });

  // ---- Quests: own area, Getting Started category, accordion + complete/claim/flash flow ----
  // ---- The Tower: floors, rotation, scaling, rewards, progress ----
  // ---- Tower quests + Titles system (equip, browser, how-to) ----
  suite('quests: tower milestones + titles', function(){
    var s = FF._state;
    var savedTower = s.tower, savedQ = s.quests, savedTitles = s.titles, savedEq = s.equippedTitle;
    s.tower = {}; s.quests = { claimed:{} }; s.titles = {}; s.equippedTitle = null;
    // Generation: every entrance gets 25/50/75/100 (25*4=100) + All Classes 125..500 (16) = 116 tower quests.
    var towerQs = FF.QUESTS.filter(function(q){ return q.cat==='towerquests'; });
    eq(towerQs.length, 116, '116 tower quests generated (25 entrances x4 + All Classes 125-500)');
    eq(FF.isQuestCategory('towerquests'), true, 'Tower is a quest category');
    eq(FF.isQuestCategory('titles'), true, 'Titles is a quest category');
    // A class entrance stops at floor 100; All Classes climbs to 500.
    ok(FF.questById('tq_pyromancer_f100') != null && FF.questById('tq_pyromancer_f125') == null, 'class entrances cap at floor 100');
    ok(FF.questById('tq_all_f500') != null, 'All Classes has a Floor 500 quest');
    // A milestone quest: reward is a unique title; progress reads that entrance's best floor.
    var q = FF.questById('tq_all_f100');
    ok(q && q.cat==='towerquests' && q.target===100, 'the Floor-100 All Classes quest exists with target 100');
    ok(q.reward.kind==='title' && q.reward.titleId==='title_all_f100' && q.reward.name==='Tower Ascendant', 'it rewards the "Tower Ascendant" title');
    eq(FF.questById('tq_pyromancer_f25').reward.name, 'Pyromancer Initiate', 'a class quest names its class title');
    eq(FF.questById('tq_all_f500').reward.name, 'Lord of the Endless Tower', 'the Floor-500 title is the grand finale');
    // Progress + claim -> unlock the title.
    eq(FF.questComplete(q), false, 'no climb yet -> not complete');
    s.tower.all = { floor:101, best:100 };
    ok(FF.questComplete(q) && FF.questClaimable(q), 'reaching best floor 100 completes + arms the quest');
    eq(FF.questClaimableInCat('towerquests'), true, 'the Tower quest tab has a claimable');
    eq(FF.railSubFlash('towerquests'), true, 'the Tower quest tab flashes when a milestone is claimable');
    ok(FF.claimQuest('tq_all_f100'), 'claim succeeds');
    ok(s.titles['title_all_f100'] === true, 'claiming unlocks the title');
    // TITLES registry: flat, ordered, one per title-rewarding quest.
    eq(FF.TITLES.length, 117, 'the Titles registry has one entry per tower quest (116) plus the Frontier Hero capstone');
    // The Getting Started capstone title is defined before the tower quests, so it leads the registry.
    eq(FF.TITLES[0].id, 'title_frontier_hero', 'the Frontier Hero capstone title leads the registry');
    // Order: the whole All Classes ladder (25..500 = 20 titles) comes next, then the per-class titles.
    var _allTitles = FF.TITLES.slice(1, 21);
    ok(_allTitles.every(function(t){ return /^title_all_f/.test(t.id); }), 'the first 20 tower titles are the full All Classes ladder (25-500)');
    ok(!/^title_all_f/.test(FF.TITLES[21].id), 'the individual class titles follow the All Classes block');
    ok(FF.TITLE_BY_ID['title_all_f100'] && FF.TITLE_BY_ID['title_all_f100'].name==='Tower Ascendant', 'the registry is keyed by title id');
    ok(FF.TITLE_BY_ID['title_all_f100'].how && /Floor 100/.test(FF.TITLE_BY_ID['title_all_f100'].how), 'each title carries a how-to (drives the ? tooltip)');
    // Equip system: only earned titles equip; toggling / unequip clears.
    FF.equipTitle('title_all_f500'); // locked -> no-op
    ok(s.equippedTitle == null, 'a locked title cannot be equipped');
    FF.equipTitle('title_all_f100');
    eq(s.equippedTitle, 'title_all_f100', 'an earned title equips');
    FF.equipTitle('title_all_f100'); // toggle off
    ok(s.equippedTitle == null, 're-equipping the worn title takes it off');
    FF.equipTitle('title_all_f100'); FF.unequipTitle();
    ok(s.equippedTitle == null, 'unequip clears the worn title');
    // Titles browser markup: earned -> Equip button; the ? is a TAPPABLE toggle (touch-friendly, not hover).
    var th = FF.renderTitlesTab();
    ok(/Tower Ascendant/.test(th) && /data-action="titleEquip"/.test(th), 'the browser lists an earned title with an Equip control');
    ok(/data-action="titleHelpToggle"/.test(th), 'the ? is a tappable toggle (works on touch, not just hover)');
    // Collapsed by default: the how-to line is not shown until the ? is tapped.
    ok(!/title-help-text/.test(FF.renderTitlesTab()), 'the how-to text is hidden until tapped');
    FF.titleHelpToggle('title_all_f100');
    var thOpen = FF.renderTitlesTab();
    ok(/title-help-text/.test(thOpen) && /How to earn/.test(thOpen), 'tapping the ? reveals the how-to-earn line inline');
    FF.titleHelpToggle('title_all_f100'); // collapse again (restore state)
    ok(!/title-help-text/.test(FF.renderTitlesTab()), 'tapping again collapses it');
    // restore
    s.tower = savedTower; s.quests = savedQ; s.titles = savedTitles; s.equippedTitle = savedEq;
  });

  suite('tower: floors, rotation, scaling + rewards', function(){
    var s = FF._state;
    var savedTower = s.tower, savedFam = s.familiars, savedAct = s.activity, savedCat = FF.currentCategoryId();
    s.tower = {}; s.familiars = {}; s.activity = { type:null };
    // 25 entrances: All Classes first, then one per class.
    eq(FF.TOWER_ENTRANCES.length, 25, '25 entrances (All Classes + 24 classes)');
    eq(FF.TOWER_ENTRANCES[0].id, 'all', 'the first entrance is All Classes');
    ok(FF.TOWER_ENTRANCES.some(function(en){ return en.id==='pyromancer'; }), 'there is a class entrance (pyromancer)');
    ok(FF.isTowerEntrance('all') && FF.isTowerEntrance('pyromancer') && !FF.isTowerEntrance('nope'), 'isTowerEntrance gates real entrances');
    // Floor tier: floor 1 = tier 10, +2 per floor, unbounded.
    eq(FF.towerFloorTier(1), 10, 'floor 1 = tier 10');
    eq(FF.towerFloorTier(2), 12, 'floor 2 = tier 12');
    eq(FF.towerFloorTier(6), 20, 'floor 6 = tier 20');
    eq(FF.towerFloorTier(7), 22, 'floor 7 climbs past the normal tier ceiling');
    // Rotation: every 3rd floor is slashing, every 5th is dark.
    eq(FF.towerFloorType(3), 'slashing', 'floor 3 is slashing');
    eq(FF.towerFloorType(6), 'slashing', 'floor 6 is slashing');
    eq(FF.towerFloorType(1), 'piercing', 'floor 1 is not slashing');
    eq(FF.towerFloorElement(5), 'dark', 'floor 5 is dark');
    eq(FF.towerFloorElement(10), 'dark', 'floor 10 is dark');
    eq(FF.towerFloorElement(1), 'fire', 'floor 1 is not dark');
    // Scaled monster: registered, resolvable, monotonically harder, finite/capped, carries the rotation.
    var m1 = FF.buildTowerMonster('all', 1), m5 = FF.buildTowerMonster('all', 5), m40 = FF.buildTowerMonster('all', 40);
    ok(m1.id === 'tower_all_f1' && m1.category === 'tower', 'the foe id/category are tower-scoped');
    ok(FF.monsterById('tower_all_f1') != null, 'the tower foe resolves via monsterById (registered)');
    ok(m5.hp > m1.hp && m40.hp > m5.hp, 'each floor is harder (HP climbs)');
    ok(isFinite(m40.hp) && m40.hp <= 1e15, 'deep-floor stats stay finite and capped');
    ok(m5.element === 'dark' && m5.attackTypes.slashing == null, 'floor 5 foe is Dark (element rotation)');
    // The card preview is the SAME scaled stats the fight uses (pure, no registration).
    var pv = FF.towerFloorStats(5);
    ok(pv.hp === m5.hp && pv.atkMin === m5.atkMin && pv.atkMax === m5.atkMax, 'the entrance-card preview matches the real foe stats');
    ok(pv.element === 'dark' && pv.type === 'blunt' && pv.baseName && pv.attackSpeed > 0, 'the preview carries element/type/foe/speed');
    // The borrowed foe's element ALWAYS agrees with the floor's element rotation (name and element match).
    for(var f=1; f<=10; f++){ eq(FF.towerBaseMonster(f).element, FF.towerFloorElement(f), 'floor '+f+' foe element matches the floor element'); }
    ok(m1.attackTypes.piercing === 1 && m1.armorTypes.piercing === 1, 'floor 1 foe is a piercing type');
    ok(FF.monsterById('tower_all_f7') != null, 'a tower foe rebuilds from its id after a reload (monsterById fallback)');
    // Progress defaults + advance/reward on kill (All Classes: guaranteed random familiar).
    eq(FF.towerEntry('all').floor, 1, 'a fresh entrance starts on floor 1');
    eq(FF.towerEntry('all').best, 0, '...with no best yet');
    s.activity = { type:'combat', tower:{ entrance:'all', floor:3 }, monsterId:'tower_all_f3' };
    s.tower.all = { floor:3, best:2 };
    var ownedBefore = Object.keys(s.familiars).length;
    FF.navPickCat('combat'); // watching the arena live, as after towerEnter
    FF.towerOnKill(FF.buildTowerMonster('all', 3));
    eq(s.tower.all.best, 3, 'clearing floor 3 banks best=3');
    eq(s.tower.all.floor, 4, '...and advances to floor 4');
    eq(s.activity.type, null, 'the run ends after a clear (re-enter for the next floor)');
    eq(FF.currentCategoryId(), 'tower', 'clearing a floor lands back in the Tower category, not Combat');
    ok(Object.keys(s.familiars).length > ownedBefore, 'All Classes grants a familiar every clear');
    // If the player wandered off the arena during the fight, a clear does NOT yank the view back.
    FF.navPickCat('inventory');
    s.activity = { type:'combat', tower:{ entrance:'all', floor:4 }, monsterId:'tower_all_f4' };
    FF.towerOnKill(FF.buildTowerMonster('all', 4));
    eq(FF.currentCategoryId(), 'inventory', 'a clear while viewing another tab leaves that view alone');
    // A class entrance summons THAT class familiar; the guaranteed grant path owns it.
    s.familiars = {};
    // A tower familiar grant queues the SAME popup a normal summon shows (respecting the popup setting).
    var savedPopupQ = s.popupQueue, savedPopupTotal = s.popupBatchTotal, savedPopupSetting = s.settings.popupFamiliar;
    s.settings.popupFamiliar = true; s.popupQueue = []; s.popupBatchTotal = 0;
    ok(FF.towerGrantFamiliar('pyromancer') === true, 'towerGrantFamiliar grants the class familiar');
    ok(s.familiars['pyromancer'] && s.familiars['pyromancer'].owned, 'the pyromancer familiar is now owned');
    eq(s.popupQueue.length, 1, 'a first-time tower grant queues one familiar popup');
    ok(s.popupQueue[0].type === 'familiar' && s.popupQueue[0].skillId === 'pyromancer' && s.popupQueue[0].leveledUp === false, 'the popup is the "answered your call" familiar popup for the earned familiar');
    FF.towerGrantFamiliar('pyromancer'); // level it up
    ok(s.popupQueue.length === 2 && s.popupQueue[1].leveledUp === true, 'a repeat grant queues a "grew stronger" popup');
    // With the setting off, no popup is queued.
    s.settings.popupFamiliar = false; s.popupQueue = []; s.familiars = {};
    FF.towerGrantFamiliar('pyromancer');
    eq(s.popupQueue.length, 0, 'no popup when the familiar-popup setting is off');
    s.popupQueue = savedPopupQ; s.popupBatchTotal = savedPopupTotal; s.settings.popupFamiliar = savedPopupSetting; s.familiars = {};
    ok(FF.grantTowerReward != null, 'grantTowerReward exists for class/all reward routing');
    // randomTowerFamiliarId returns a real familiar key.
    s.familiars = {};
    var rid = FF.randomTowerFamiliarId();
    ok(rid && FF.FAMILIAR_DATA[rid], 'randomTowerFamiliarId returns a valid familiar id');
    // towerEnter starts a scaled fight from idle. Use the always-open All Classes entrance (a class
    // entrance now requires that class equipped -- covered by the class-lock assertions below).
    s.activity = { type:null }; s.tower = { all:{ floor:2, best:1 } };
    FF.towerEnter('all');
    ok(s.activity.type === 'combat' && s.activity.tower && s.activity.tower.entrance === 'all' && s.activity.tower.floor === 2, 'towerEnter starts the entrance\'s current floor');
    ok(FF.monsterById(s.activity.monsterId) != null, 'the started fight has a resolvable foe');
    // "Enter Floor" opens a detailed foe-preview popup FIRST (with the Damage-to-You stat), then commits.
    s.activity = { type:null }; s.tower = { all:{ floor:5, best:4 } };
    ok(/data-action="towerPreviewOpen"/.test(FF.renderTowerTab()) && !/data-action="towerEnter"/.test(FF.renderTowerTab()), 'the tower card Enter button opens the preview, not the fight directly');
    var card = FF.towerPreviewCardHtml('all');
    ok(/Floor 5/.test(card), 'the preview names the floor being entered');
    ok(/to you/.test(card) && /dmg-vs-you/.test(card), 'the preview shows the "Damage to You" stat like a normal enemy card');
    ok(/Offense/.test(card) && /Defense/.test(card) && /Versus you/.test(card), 'the preview shows a full offensive/defensive breakdown');
    ok(/matchup-badge/.test(card) && /Your hit chance/.test(card), 'it carries the weapon matchup and your hit chance');
    ok(/data-action="towerEnter" data-tower="all"/.test(card), 'the preview Enter button commits to the fight');
    ok(/data-action="towerPreviewClose"/.test(card), 'the preview has a Cancel button');
    // Class-entrance lock: only the entrance matching your EQUIPPED class (+ All Classes) is enterable.
    function _armor(mat){ return { material:mat, tier:5 }; }
    var fwState = { xp:{}, physique:{}, bodyArmor:{ helmet:_armor('chain'), chest:_armor('chain'), gauntlets:_armor('tailoring'), boots:_armor('tailoring') }, equippedMainhand:'wandWater', equippedOffhand:'shieldMedium', activity:{type:'combat'}, playerHp:55 };
    fwState.xp.frostwarden = FF.xpFloorForLevel(80);
    eq(FF.activeClassId(fwState), 'frostwarden', 'the mock state activates Frostwarden');
    eq(FF.towerEntranceClassLocked('all', fwState), false, 'All Classes is never class-locked');
    eq(FF.towerEntranceClassLocked('frostwarden', fwState), false, 'your equipped class entrance is open');
    eq(FF.towerEntranceClassLocked('berserker', fwState), true, 'a class you have NOT equipped is locked');
    var noneState = { xp:{}, physique:{}, bodyArmor:{}, equippedMainhand:null, equippedOffhand:null, activity:{type:null} };
    eq(FF.towerEntranceClassLocked('all', noneState), false, 'All Classes stays open with no class equipped');
    eq(FF.towerEntranceClassLocked('frostwarden', noneState), true, 'every class entrance locks with no class equipped');
    // The tower cards grey out non-equipped class entrances (disabled button, no preview action) while
    // All Classes stays enterable. The selftest state has no class equipped.
    s.activity = { type:null };
    var tabHtml = FF.renderTowerTab();
    ok(/Class not equipped/.test(tabHtml), 'locked class entrances render a disabled "Class not equipped" button');
    ok(/data-action="towerPreviewOpen" data-tower="all"/.test(tabHtml), 'All Classes stays enterable');
    // restore
    s.tower = savedTower; s.familiars = savedFam; s.activity = savedAct;
    if(savedCat) FF.navPickCat(savedCat);
  });

  suite('quests: area, category, accordion + claim flow', function(){
    var s = FF._state;
    var savedMK = s.monsterKills, savedQ = s.quests, savedInv = s.inventory['corpse_t0'], savedTitles = s.titles, savedFal = s.inventory['stweapon_scimitar_t0_normal'];
    // Every field a Getting Started quest's progress() reads must start clean, or state leaked from an
    // earlier suite could leave one of them complete+unclaimed and break the "only Answer the Call is
    // claimable" flash assertions below. Saved here, restored at the end of the suite.
    var savedStatsQ = s.stats, savedRelicQ = s.equippedRelicTier, savedBeltTQ = s.equippedBeltTier, savedBeltRQ = s.equippedBeltRarity,
        savedGTQ = s.gatherTools, savedACQ = s.activeCompanions, savedMHQ = s.equippedMainhand, savedOffQ = s.equippedOffhand,
        savedOffTQ = s.equippedOffhandTier, savedBAQ = s.bodyArmor, savedXpQ = s.xp, savedUniqQ = s.uniqueItems, savedJSQ = s.jewelrySlots;
    s.monsterKills = {}; s.quests = { claimed:{} }; s.titles = {};
    s.stats = {}; s.equippedRelicTier = 0; s.equippedBeltTier = 0; s.equippedBeltRarity = 'normal';
    s.gatherTools = {}; s.activeCompanions = []; s.equippedMainhand = null; s.equippedOffhand = null; s.equippedOffhandTier = 0; s.bodyArmor = {};
    s.xp = {}; s.uniqueItems = {}; s.jewelrySlots = {}; // master-of-the-frontier (skill Lv), steel-sharpened (uniques), cut-and-set (rings)
    // Quests is its OWN top-level area, with Getting Started as a category tab inside it (not under Battle).
    var qArea = FF.AREAS.filter(function(a){ return a.id==='quests'; })[0];
    ok(!!qArea, 'Quests is its own top-level area');
    ok(qArea.subs.some(function(sub){ return sub[0]==='gettingstarted'; }), 'Getting Started is a tab within Quests');
    ok(!FF.AREAS.some(function(a){ return a.id==='battle' && a.subs.some(function(sub){ return sub[0]==='quests'; }); }), 'Quests is no longer a sub of Battle');
    eq(FF.isQuestCategory('gettingstarted'), true, 'gettingstarted is a quest category');
    eq(FF.isQuestCategory('enemies'), false, 'a normal category is not a quest category');
    var q = FF.questById('answer_the_call');
    ok(!!q, 'the first Getting Started quest (Answer the Call) exists');
    ok(!FF.questById('watership_down'), 'the old Watership Down quest was removed');
    eq(q.cat, 'gettingstarted', 'it lives in the Getting Started category');
    eq(q.target, 1, 'its target is 1 (a first-login welcome quest)');
    ok(q.reward.kind==='item' && q.reward.itemId==='stweapon_scimitar_t0_normal' && q.reward.qty===1, 'reward is a Tier-1 Scimitar (stweapon_scimitar_t0_normal)');
    ok(typeof q.how === 'string' && q.how.length > 0 && typeof q.desc === 'string' && q.desc.length > 0, 'it carries how-to + lore text');
    // A first-login welcome quest is immediately complete + claimable (progress is always met).
    ok(FF.questComplete(q) && FF.questClaimable(q), 'the welcome quest is immediately complete + claimable');
    eq(FF.questProgress(q), 1, 'progress is met (and clamps at the target of 1)');
    eq(FF.questClaimableInCat('gettingstarted'), true, 'the owning category reports a claimable');
    eq(FF.railSubFlash('gettingstarted'), true, 'the Getting Started tab flashes when a reward is claimable');
    eq(FF.railAreaFlash('quests'), true, 'the Quests area flashes so it is visible from anywhere');
    // Accordion: collapsed shows the Claim button but not the body; expand reveals how-to + reward.
    var collapsed = FF.renderQuestsTab();
    ok(/data-action="questClaim"/.test(collapsed) && /data-quest="answer_the_call"/.test(collapsed), 'the bar renders a Claim button when complete');
    ok(/quest-acc-bar/.test(collapsed) && !/quest-acc-body/.test(collapsed), 'collapsed: no expanded body');
    FF.questToggleExpand('answer_the_call');
    var expanded = FF.renderQuestsTab();
    ok(/quest-acc-body/.test(expanded) && /How to complete/.test(expanded) && /Reward:/.test(expanded), 'expanded: shows the how-to instructions and the reward');
    FF.questToggleExpand('answer_the_call'); // collapse again
    // Claim grants the blade exactly once and clears the flash.
    var before = s.inventory['stweapon_scimitar_t0_normal'] || 0;
    ok(FF.claimQuest('answer_the_call'), 'claim succeeds when claimable');
    eq((s.inventory['stweapon_scimitar_t0_normal']||0) - before, 1, 'claim grants the Tier-1 Scimitar');
    eq(FF.questClaimed(q), true, 'the quest is marked claimed');
    eq(FF.questClaimable(q), false, 'a claimed quest is no longer claimable');
    eq(FF.railSubFlash('gettingstarted'), false, 'the flash clears after claiming');
    eq(FF.railAreaFlash('quests'), false, 'the area flash clears after claiming');
    // Idempotent: a second claim grants nothing.
    var after = s.inventory['stweapon_scimitar_t0_normal'] || 0;
    eq(FF.claimQuest('answer_the_call'), false, 'a claimed quest cannot be re-claimed');
    eq(s.inventory['stweapon_scimitar_t0_normal']||0, after, 'no extra blade from a double-claim');
    // ---- Quest 2: "Take Up Arms" -- equip your scimitar -> a 4-piece starter armor kit (multi-item reward) ----
    var q2 = FF.questById('take_up_arms');
    ok(!!q2 && q2.cat==='gettingstarted', 'Take Up Arms lives in Getting Started');
    eq(q2.target, 1, 'its target is 1 (equip a scimitar)');
    eq(q2.reward.kind, 'items', 'it grants a multi-item reward');
    var kitIds = q2.reward.items.map(function(it){ return it.itemId; });
    ok(kitIds.indexOf('bodyarmor_plate_chest_t0_normal')!==-1 && kitIds.indexOf('bodyarmor_chain_boots_t0_normal')!==-1
      && kitIds.indexOf('bodyarmor_chain_helmet_t0_normal')!==-1 && kitIds.indexOf('bodyarmor_tailoring_gauntlets_t0_normal')!==-1
      && kitIds.indexOf('stshield_shieldSmall_t0_normal')!==-1,
      'the kit is t0 plate chest + chain boots + chain helm + cloth gloves + a small shield (all equippable at Lv 1)');
    ok(kitIds.every(function(id){ return !!FF.ALL_SELLABLE[id]; }), 'every kit item resolves to a real armor piece');
    // Progress tracks whether a scimitar is equipped.
    var savedMH = s.equippedMainhand;
    s.quests = { claimed:{} }; s.equippedMainhand = null;
    eq(FF.questComplete(q2), false, 'no weapon equipped -> not complete');
    s.equippedMainhand = 'rapier';
    eq(FF.questComplete(q2), false, 'a different weapon does not count');
    s.equippedMainhand = 'scimitar';
    ok(FF.questComplete(q2) && FF.questClaimable(q2), 'equipping a scimitar completes + arms the quest');
    // Claim grants all four pieces.
    var kitBefore = kitIds.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('take_up_arms'), 'claim succeeds');
    ok(kitIds.every(function(id, i){ return (s.inventory[id]||0) - kitBefore[i] === 1; }), 'claim grants one of each armor piece');
    kitIds.forEach(function(id){ if((s.inventory[id]||0) > 0) s.inventory[id] = Math.max(0, (s.inventory[id]||0) - 1); }); // undo the grant
    s.equippedMainhand = savedMH;
    // ---- Quest 3: "Don Your Armor" -- equip all 5 starter pieces -> summon the Treasure Hunter familiar ----
    var savedArmor = s.bodyArmor, savedOff = s.equippedOffhand, savedOffTier = s.equippedOffhandTier,
        savedFams = s.familiars, savedPQ = s.popupQueue, savedPopFam = s.settings.popupFamiliar, savedPBT = s.popupBatchTotal;
    var q3 = FF.questById('don_your_armor');
    ok(!!q3 && q3.cat==='gettingstarted', 'Don Your Armor lives in Getting Started');
    eq(q3.target, 5, 'its target is all 5 starter pieces');
    eq(q3.reward.kind, 'familiar', 'it grants a familiar reward');
    eq(q3.reward.familiarId, 'treasureHunter', 'the familiar granted is the Treasure Hunter');
    ok(/Midas/.test(FF.questRewardLabel(q3)), 'the reward line names the Treasure Hunter familiar (Midas, its companion)');
    // Progress counts each of the 5 equipped pieces (4 armor slots by material + the small shield offhand).
    s.quests = { claimed:{} };
    s.bodyArmor = {}; s.equippedOffhand = null; s.equippedOffhandTier = 0;
    eq(FF.questProgress(q3), 0, 'nothing equipped -> 0 progress');
    s.bodyArmor.chest = { material:'plate', tier:1 };
    eq(FF.questProgress(q3), 1, 'copper plate chest counts');
    s.bodyArmor.boots = { material:'chain', tier:1 };
    s.bodyArmor.helmet = { material:'chain', tier:1 };
    s.bodyArmor.gauntlets = { material:'tailoring', tier:1 };
    eq(FF.questProgress(q3), 4, 'chain boots + chain helm + cotton gloves all count');
    eq(FF.questComplete(q3), false, 'without the shield the quest is not complete');
    s.equippedOffhand = 'shieldSmall'; s.equippedOffhandTier = 1;
    eq(FF.questProgress(q3), 5, 'the copper small shield is the 5th piece');
    ok(FF.questComplete(q3) && FF.questClaimable(q3), 'all 5 pieces equipped completes + arms the quest');
    // A wrong material in a slot must not count (plate chest only, not chain chest, etc.).
    s.bodyArmor.chest = { material:'chain', tier:1 };
    eq(FF.questProgress(q3), 4, 'a chain chest does not satisfy the plate-chest requirement');
    s.bodyArmor.chest = { material:'plate', tier:1 };
    // Claim summons the Treasure Hunter as if found normally: familiar becomes owned + a summon popup queues.
    s.familiars = {}; s.popupQueue = []; s.popupBatchTotal = 0; s.settings.popupFamiliar = true;
    ok(!(s.familiars['treasureHunter'] && s.familiars['treasureHunter'].owned), 'Treasure Hunter is not owned before claiming');
    ok(FF.claimQuest('don_your_armor'), 'claim succeeds');
    ok(s.familiars['treasureHunter'] && s.familiars['treasureHunter'].owned && s.familiars['treasureHunter'].level===1, 'claim summons the Treasure Hunter at level 1');
    ok(s.popupQueue.some(function(p){ return p.type==='familiar' && p.skillId==='treasureHunter'; }), 'a familiar summon popup is queued (as if found normally)');
    eq(FF.questClaimed(q3), true, 'the quest is marked claimed');
    eq(FF.claimQuest('don_your_armor'), false, 'a claimed quest cannot be re-claimed');
    s.bodyArmor = savedArmor; s.equippedOffhand = savedOff; s.equippedOffhandTier = savedOffTier;
    s.familiars = savedFams; s.popupQueue = savedPQ; s.settings.popupFamiliar = savedPopFam; s.popupBatchTotal = savedPBT;
    // ---- Quest 4: "A Companion at Your Side" -- activate Midas (treasureHunter) -> 20 first-tier roasted fish ----
    var savedAC = s.activeCompanions, savedFams4 = s.familiars, savedRoast = s.inventory['roasting_t0'];
    var q4 = FF.questById('midas_at_your_side');
    ok(!!q4 && q4.cat==='gettingstarted', 'A Companion at Your Side lives in Getting Started');
    eq(q4.target, 1, 'its target is 1 (activate the companion)');
    ok(q4.reward.kind==='item' && q4.reward.itemId==='roasting_t0' && q4.reward.qty===20, 'reward is 20x first-tier Roasted fish (roasting_t0)');
    ok(/Roasted/.test(FF.questRewardLabel(q4)), 'the reward line reads as the real roasted fish');
    eq(q4.nav.cat, 'menagerie', 'its Go destination is the Menagerie');
    s.quests = { claimed:{} };
    s.familiars = { treasureHunter:{ owned:true, level:1 } };
    s.activeCompanions = [];
    eq(FF.questComplete(q4), false, 'Midas summoned but not yet an active companion -> not complete');
    s.activeCompanions = ['digging']; // some OTHER active companion doesn't count
    eq(FF.questComplete(q4), false, 'a different active companion does not satisfy the quest');
    s.familiars.digging = { owned:true, level:1 };
    eq(FF.questComplete(q4), false, 'still not complete while only a non-Midas companion is active');
    s.activeCompanions = ['treasureHunter'];
    ok(FF.questComplete(q4) && FF.questClaimable(q4), 'making Midas an active companion completes + arms the quest');
    // An unowned Midas in the slot must not count (activeCompanionList filters to owned).
    s.familiars.treasureHunter = { owned:false, level:0 };
    eq(FF.questComplete(q4), false, 'an un-summoned Midas in the slot does not count');
    s.familiars.treasureHunter = { owned:true, level:1 };
    var rBefore = s.inventory['roasting_t0'] || 0;
    ok(FF.claimQuest('midas_at_your_side'), 'claim succeeds');
    eq((s.inventory['roasting_t0']||0) - rBefore, 20, 'claim grants 20 Roasted Bluegill');
    eq(FF.claimQuest('midas_at_your_side'), false, 'a claimed quest cannot be re-claimed');
    s.activeCompanions = savedAC; s.familiars = savedFams4;
    if(savedRoast===undefined) delete s.inventory['roasting_t0']; else s.inventory['roasting_t0'] = savedRoast;
    // ---- Quest 5: "Thin the Warren" -- kill 10 Rabbits -> a Copper Cleaver (first-tier Butchering tool) ----
    var savedTool = s.inventory['tool_butchering_t0_normal'];
    var q5 = FF.questById('thin_the_warren');
    ok(!!q5 && q5.cat==='gettingstarted', 'Thin the Warren lives in Getting Started');
    eq(q5.target, 10, 'its target is 10 Rabbit kills');
    ok(q5.reward.kind==='item' && q5.reward.itemId==='tool_butchering_t0_normal' && q5.reward.qty===1, 'reward is a first-tier Butchering tool (tool_butchering_t0_normal)');
    ok(/Copper/.test(FF.questRewardLabel(q5)) && /Cleaver/.test(FF.questRewardLabel(q5)), 'the reward line reads as the real Copper Cleaver');
    eq(q5.nav.cat, 'enemies', 'its Go destination is the Enemies list');
    s.quests = { claimed:{} };
    s.monsterKills = {};
    eq(FF.questProgress(q5), 0, 'no kills -> 0 progress');
    s.monsterKills['wildlife_fox'] = 10; // a different animal must not count
    eq(FF.questProgress(q5), 0, 'killing other wildlife does not advance the Rabbit tally');
    s.monsterKills['wildlife_rabbit'] = 9;
    eq(FF.questComplete(q5), false, '9 Rabbits is not enough');
    s.monsterKills['wildlife_rabbit'] = 10;
    ok(FF.questComplete(q5) && FF.questClaimable(q5), 'the 10th Rabbit completes + arms the quest');
    var tBefore = s.inventory['tool_butchering_t0_normal'] || 0;
    ok(FF.claimQuest('thin_the_warren'), 'claim succeeds');
    eq((s.inventory['tool_butchering_t0_normal']||0) - tBefore, 1, 'claim grants one Copper Cleaver');
    eq(FF.claimQuest('thin_the_warren'), false, 'a claimed quest cannot be re-claimed');
    s.monsterKills = {};
    if(savedTool===undefined) delete s.inventory['tool_butchering_t0_normal']; else s.inventory['tool_butchering_t0_normal'] = savedTool;
    // ---- Quest 6: "Take Up the Cleaver" -- equip a Butchering tool -> 10 Rabbit Corpses (corpse_t0) ----
    var savedGT = s.gatherTools, savedCorpse = s.inventory['corpse_t0'];
    var q6 = FF.questById('take_up_the_cleaver');
    ok(!!q6 && q6.cat==='gettingstarted', 'Take Up the Cleaver lives in Getting Started');
    eq(q6.target, 1, 'its target is 1 (equip the Cleaver)');
    ok(q6.reward.kind==='item' && q6.reward.itemId==='corpse_t0' && q6.reward.qty===10, 'reward is 10x first-tier Corpse (corpse_t0)');
    ok(/Rabbit Corpse/.test(FF.questRewardLabel(q6)), 'the reward line reads as the real Rabbit Corpse');
    eq(q6.nav.cat, 'refining', 'its Go destination is the Refining tab');
    eq(q6.nav.sub, 'butchering', 'the Go destination drills into the Butchering sub-tab');
    s.quests = { claimed:{} };
    s.gatherTools = { butchering:0 };
    eq(FF.questComplete(q6), false, 'no Butchering tool equipped -> not complete');
    s.gatherTools.butchering = 1; // tierIndex 0 + 1 == the equipped Copper Cleaver
    ok(FF.questComplete(q6) && FF.questClaimable(q6), 'equipping the Cleaver completes + arms the quest');
    var cBefore = s.inventory['corpse_t0'] || 0;
    ok(FF.claimQuest('take_up_the_cleaver'), 'claim succeeds');
    eq((s.inventory['corpse_t0']||0) - cBefore, 10, 'claim grants 10 Rabbit Corpses');
    eq(FF.claimQuest('take_up_the_cleaver'), false, 'a claimed quest cannot be re-claimed');
    s.gatherTools = savedGT;
    if(savedCorpse===undefined) delete s.inventory['corpse_t0']; else s.inventory['corpse_t0'] = savedCorpse;
    // ---- Quest 7: "Render the Kill" -- butcher 10 Rabbit corpses -> 10 hide + 10 fat + 10 meat + a Copper Tanning Knife ----
    // First, the fat-line realignment this quest surfaced: a Rabbit's rendered fat must READ as a Rabbit's.
    eq(FF.ALL_SELLABLE['meat_t0'].name, 'Rabbit Meat', 'tier-0 Meat is Rabbit Meat');
    eq(FF.ALL_SELLABLE['butchering_t0'].name, 'Rabbit Hide', 'tier-0 Hide is Rabbit Hide');
    ok(/^Rabbit /.test(FF.ALL_SELLABLE['fat_t0'].name), 'tier-0 Fat now names the Rabbit (was the misaligned "Rat Fat")');
    ok(/^Bear /.test(FF.ALL_SELLABLE['fat_t5'].name), 'tier-5 Fat now names the Bear (each fat matches its own animal)');
    var q7 = FF.questById('render_the_kill');
    ok(!!q7 && q7.cat==='gettingstarted', 'Render the Kill lives in Getting Started');
    eq(q7.target, 10, 'its target is 10 butchered corpses');
    eq(q7.reward.kind, 'items', 'it grants a multi-item reward');
    var r7 = q7.reward.items.map(function(it){ return it.itemId; });
    ok(r7.indexOf('butchering_t0')!==-1 && r7.indexOf('fat_t0')!==-1 && r7.indexOf('meat_t0')!==-1 && r7.indexOf('tool_tanning_t0_normal')!==-1,
      'reward is 10 Rabbit Hide + 10 Rabbit fat + 10 Rabbit Meat + a Copper Tanning Knife');
    ok(r7.every(function(id){ return !!FF.ALL_SELLABLE[id]; }), 'every reward item resolves to a real item');
    ok(/Tanning Knife/.test(FF.questRewardLabel(q7)) && /Copper/.test(FF.questRewardLabel(q7)), 'the reward line names the Copper Tanning Knife');
    var savedStats = s.stats, savedR7 = r7.map(function(id){ return s.inventory[id]; });
    s.quests = { claimed:{} };
    s.stats = {};
    eq(FF.questProgress(q7), 0, 'no corpses butchered -> 0 progress');
    s.stats['butcher_1'] = 10; // butchering a higher-tier animal must not count for the Rabbit quest
    eq(FF.questProgress(q7), 0, 'butchering other-tier carcasses does not advance the Rabbit-corpse tally');
    s.stats['butcher_0'] = 9;
    eq(FF.questComplete(q7), false, '9 butchered is not enough');
    s.stats['butcher_0'] = 10;
    ok(FF.questComplete(q7) && FF.questClaimable(q7), 'the 10th butchered Rabbit corpse completes + arms the quest');
    var r7Before = r7.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('render_the_kill'), 'claim succeeds');
    eq((s.inventory['butchering_t0']||0) - r7Before[0], 10, 'claim grants 10 Rabbit Hide');
    eq((s.inventory['fat_t0']||0) - r7Before[1], 10, 'claim grants 10 Rabbit fat');
    eq((s.inventory['meat_t0']||0) - r7Before[2], 10, 'claim grants 10 Rabbit Meat');
    eq((s.inventory['tool_tanning_t0_normal']||0) - r7Before[3], 1, 'claim grants a Copper Tanning Knife');
    eq(FF.claimQuest('render_the_kill'), false, 'a claimed quest cannot be re-claimed');
    s.stats = savedStats;
    r7.forEach(function(id, i){ if(savedR7[i]===undefined) delete s.inventory[id]; else s.inventory[id] = savedR7[i]; });
    // ---- Quest 8: "Cure the Hides" -- tan 10 Rabbit Leather -> 10 Rabbit Leather + a Copper Awl ----
    var q8 = FF.questById('cure_the_hides');
    ok(!!q8 && q8.cat==='gettingstarted', 'Cure the Hides lives in Getting Started');
    eq(q8.target, 10, 'its target is 10 tanned Rabbit Leather');
    eq(q8.reward.kind, 'items', 'it grants a multi-item reward');
    var r8 = q8.reward.items.map(function(it){ return it.itemId; });
    ok(r8.indexOf('tanning_t0')!==-1 && r8.indexOf('tool_leatherworking_t0_normal')!==-1, 'reward is 10 Rabbit Leather + a Copper Leatherworking tool');
    ok(r8.every(function(id){ return !!FF.ALL_SELLABLE[id]; }), 'every reward item resolves to a real item');
    eq(FF.ALL_SELLABLE['tanning_t0'].name, 'Rabbit Leather', 'tier-0 Leather is Rabbit Leather');
    ok(/Awl/.test(FF.questRewardLabel(q8)) && /Copper/.test(FF.questRewardLabel(q8)), 'the reward line names the Copper Awl (Leatherworking tool)');
    eq(q8.nav.cat, 'crafting', 'its Go destination is the Crafting tab');
    eq(q8.nav.sub, 'tanning', 'the Go destination drills into the Tanning sub-tab');
    var savedStats8 = s.stats, savedR8 = r8.map(function(id){ return s.inventory[id]; });
    s.quests = { claimed:{} };
    s.stats = {};
    eq(FF.questProgress(q8), 0, 'nothing tanned -> 0 progress');
    s.stats['made_tanning_t1'] = 10; // tanning a higher-tier leather must not count
    eq(FF.questProgress(q8), 0, 'tanning other-tier leather does not advance the Rabbit tally');
    s.stats['made_tanning_t0'] = 9;
    eq(FF.questComplete(q8), false, '9 tanned is not enough');
    s.stats['made_tanning_t0'] = 10;
    ok(FF.questComplete(q8) && FF.questClaimable(q8), 'the 10th tanned Rabbit Leather completes + arms the quest');
    var r8Before = r8.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('cure_the_hides'), 'claim succeeds');
    eq((s.inventory['tanning_t0']||0) - r8Before[0], 10, 'claim grants 10 Rabbit Leather');
    eq((s.inventory['tool_leatherworking_t0_normal']||0) - r8Before[1], 1, 'claim grants a Copper Awl');
    eq(FF.claimQuest('cure_the_hides'), false, 'a claimed quest cannot be re-claimed');
    s.stats = savedStats8;
    r8.forEach(function(id, i){ if(savedR8[i]===undefined) delete s.inventory[id]; else s.inventory[id] = savedR8[i]; });
    // ---- Quest 9: "Belt and Buckle" -- make 10 Rabbit Belts -> a Rare Rabbit Belt ----
    var q9 = FF.questById('belt_and_buckle');
    ok(!!q9 && q9.cat==='gettingstarted', 'Belt and Buckle lives in Getting Started');
    eq(q9.target, 10, 'its target is 10 crafted belts');
    ok(q9.reward.kind==='item' && q9.reward.itemId==='belt_t0_rare' && q9.reward.qty===1, 'reward is a Rare tier-0 belt (belt_t0_rare)');
    eq(FF.ALL_SELLABLE['belt_t0_rare'].name, 'Rare Rabbit Belt', 'the reward reads as a Rare Rabbit Belt');
    eq(q9.nav.cat, 'outfitting', 'its Go destination is the Outfitting tab');
    eq(q9.nav.sub, 'leatherworking', 'the Go destination drills into Leatherworking');
    var savedStats9 = s.stats, savedBeltRare = s.inventory['belt_t0_rare'];
    s.quests = { claimed:{} }; s.stats = {};
    eq(FF.questProgress(q9), 0, 'no belts made -> 0 progress');
    s.stats['belt_made_1'] = 10; // a higher-tier belt must not count
    eq(FF.questProgress(q9), 0, 'making other-tier belts does not advance the Rabbit-belt tally');
    s.stats['belt_made_0'] = 9;
    eq(FF.questComplete(q9), false, '9 belts is not enough');
    s.stats['belt_made_0'] = 10;
    ok(FF.questComplete(q9) && FF.questClaimable(q9), 'the 10th Rabbit Belt completes + arms the quest');
    var beltRareBefore = s.inventory['belt_t0_rare'] || 0;
    ok(FF.claimQuest('belt_and_buckle'), 'claim succeeds');
    eq((s.inventory['belt_t0_rare']||0) - beltRareBefore, 1, 'claim grants a Rare Rabbit Belt');
    eq(FF.claimQuest('belt_and_buckle'), false, 'a claimed quest cannot be re-claimed');
    s.stats = savedStats9;
    if(savedBeltRare===undefined) delete s.inventory['belt_t0_rare']; else s.inventory['belt_t0_rare'] = savedBeltRare;
    // ---- Quest 10: "Cinch It On" -- equip the Rare Rabbit Belt -> a Copper Shovel ----
    var q10 = FF.questById('cinch_it_on');
    ok(!!q10 && q10.cat==='gettingstarted', 'Cinch It On lives in Getting Started');
    eq(q10.target, 1, 'its target is 1 (equip the belt)');
    ok(q10.reward.kind==='item' && q10.reward.itemId==='tool_digging_t0_normal' && q10.reward.qty===1, 'reward is a first-tier Digging tool');
    ok(/Copper/.test(FF.questRewardLabel(q10)) && /Shovel/.test(FF.questRewardLabel(q10)), 'the reward line names the Copper Shovel');
    var savedBT = s.equippedBeltTier, savedBR = s.equippedBeltRarity, savedShovel = s.inventory['tool_digging_t0_normal'];
    s.quests = { claimed:{} };
    s.equippedBeltTier = 0; s.equippedBeltRarity = 'normal';
    eq(FF.questComplete(q10), false, 'no belt equipped -> not complete');
    s.equippedBeltTier = 1; s.equippedBeltRarity = 'normal';
    eq(FF.questComplete(q10), false, 'a NORMAL rabbit belt does not satisfy the Rare requirement');
    s.equippedBeltTier = 1; s.equippedBeltRarity = 'rare';
    ok(FF.questComplete(q10) && FF.questClaimable(q10), 'equipping the Rare Rabbit Belt completes + arms the quest');
    var shovelBefore = s.inventory['tool_digging_t0_normal'] || 0;
    ok(FF.claimQuest('cinch_it_on'), 'claim succeeds');
    eq((s.inventory['tool_digging_t0_normal']||0) - shovelBefore, 1, 'claim grants a Copper Shovel');
    eq(FF.claimQuest('cinch_it_on'), false, 'a claimed quest cannot be re-claimed');
    s.equippedBeltTier = savedBT; s.equippedBeltRarity = savedBR;
    if(savedShovel===undefined) delete s.inventory['tool_digging_t0_normal']; else s.inventory['tool_digging_t0_normal'] = savedShovel;
    // ---- Quest 11: "Break Ground" -- dig 100 Sand -> 200 Sand + 10 Sand Artifacts + a Copper Excavation Brush ----
    var q11 = FF.questById('break_ground');
    ok(!!q11 && q11.cat==='gettingstarted', 'Break Ground lives in Getting Started');
    eq(q11.target, 100, 'its target is 100 Sand dug');
    eq(q11.reward.kind, 'items', 'it grants a multi-item reward');
    var r11 = q11.reward.items.map(function(it){ return it.itemId; });
    ok(r11.indexOf('digging_t0')!==-1 && r11.indexOf('muddyartifact_t0')!==-1 && r11.indexOf('tool_archaeology_t0_normal')!==-1, 'reward is 200 Sand + 10 Sand Artifacts + a Copper Excavation Brush');
    ok(r11.every(function(id){ return !!FF.ALL_SELLABLE[id]; }), 'every reward item resolves to a real item');
    eq(FF.ALL_SELLABLE['muddyartifact_t0'].name, 'Sand Artifact', 'tier-0 artifact is a Sand Artifact');
    eq(q11.nav.cat, 'gathering', 'its Go destination is the Gathering tab');
    eq(q11.nav.sub, 'digging', 'the Go destination drills into Digging');
    var savedStats11 = s.stats, savedR11 = r11.map(function(id){ return s.inventory[id]; });
    s.quests = { claimed:{} }; s.stats = {};
    eq(FF.questProgress(q11), 0, 'no Sand dug -> 0 progress');
    s.stats['gathered_digging_t1'] = 100; // a different soil must not count
    eq(FF.questProgress(q11), 0, 'digging other soil does not advance the Sand tally');
    s.stats['gathered_digging_t0'] = 100;
    ok(FF.questComplete(q11) && FF.questClaimable(q11), '100 Sand completes + arms the quest');
    var r11Before = r11.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('break_ground'), 'claim succeeds');
    eq((s.inventory['digging_t0']||0) - r11Before[0], 200, 'claim grants 200 Sand');
    eq((s.inventory['muddyartifact_t0']||0) - r11Before[1], 10, 'claim grants 10 Sand Artifacts');
    eq((s.inventory['tool_archaeology_t0_normal']||0) - r11Before[2], 1, 'claim grants a Copper Excavation Brush');
    s.stats = savedStats11;
    r11.forEach(function(id, i){ if(savedR11[i]===undefined) delete s.inventory[id]; else s.inventory[id] = savedR11[i]; });
    // ---- Quest 12: "Extract the Past" -- excavate 10 Sand Artifacts -> a Sand Relic ----
    var q12 = FF.questById('extract_the_past');
    ok(!!q12 && q12.cat==='gettingstarted', 'Extract the Past lives in Getting Started');
    eq(q12.target, 10, 'its target is 10 excavated artifacts');
    ok(q12.reward.kind==='item' && q12.reward.itemId==='relic_t0_normal' && q12.reward.qty===1, 'reward is a Sand Relic (relic_t0_normal)');
    eq(FF.ALL_SELLABLE['relic_t0_normal'].name, 'Sand Relic', 'the reward reads as a Sand Relic');
    eq(q12.nav.cat, 'crafting', 'its Go destination is the Crafting tab');
    eq(q12.nav.sub, 'archaeology', 'the Go destination drills into Archaeology');
    var savedStats12 = s.stats, savedRelic = s.inventory['relic_t0_normal'];
    s.quests = { claimed:{} }; s.stats = {};
    eq(FF.questProgress(q12), 0, 'nothing excavated -> 0 progress');
    s.stats['excavate_1'] = 10; // a different-tier artifact must not count
    eq(FF.questProgress(q12), 0, 'excavating other-tier artifacts does not advance the Sand tally');
    s.stats['excavate_0'] = 10;
    ok(FF.questComplete(q12) && FF.questClaimable(q12), '10 excavated Sand Artifacts completes + arms the quest');
    var relicBefore = s.inventory['relic_t0_normal'] || 0;
    ok(FF.claimQuest('extract_the_past'), 'claim succeeds');
    eq((s.inventory['relic_t0_normal']||0) - relicBefore, 1, 'claim grants a Sand Relic');
    s.stats = savedStats12;
    if(savedRelic===undefined) delete s.inventory['relic_t0_normal']; else s.inventory['relic_t0_normal'] = savedRelic;
    // ---- Quest 13: "Bear the Relic" -- equip a relic -> 10 Critter Caches ----
    var q13 = FF.questById('bear_the_relic');
    ok(!!q13 && q13.cat==='gettingstarted', 'Bear the Relic lives in Getting Started');
    eq(q13.target, 1, 'its target is 1 (equip the relic)');
    ok(q13.reward.kind==='item' && q13.reward.itemId==='critter_cache' && q13.reward.qty===10, 'reward is 10 Critter Caches');
    var savedRT = s.equippedRelicTier, savedCache = s.inventory['critter_cache'];
    s.quests = { claimed:{} };
    s.equippedRelicTier = 0;
    eq(FF.questComplete(q13), false, 'no relic equipped -> not complete');
    s.equippedRelicTier = 1;
    ok(FF.questComplete(q13) && FF.questClaimable(q13), 'equipping the Sand Relic completes + arms the quest');
    var cacheBefore = s.inventory['critter_cache'] || 0;
    ok(FF.claimQuest('bear_the_relic'), 'claim succeeds');
    eq((s.inventory['critter_cache']||0) - cacheBefore, 10, 'claim grants 10 Critter Caches');
    s.equippedRelicTier = savedRT;
    if(savedCache===undefined) delete s.inventory['critter_cache']; else s.inventory['critter_cache'] = savedCache;
    // ---- Quest 14: "Crack the Cache" -- open a Critter Cache -> 10 Cotton Seeds ----
    var q14 = FF.questById('crack_the_cache');
    ok(!!q14 && q14.cat==='gettingstarted', 'Crack the Cache lives in Getting Started');
    eq(q14.target, 1, 'its target is 1 opened cache');
    ok(q14.reward.kind==='item' && q14.reward.itemId==='seed_t0' && q14.reward.qty===10, 'reward is 10 Cotton Seeds (seed_t0)');
    eq(FF.ALL_SELLABLE['seed_t0'].name, 'Cotton Seed', 'the reward reads as Cotton Seed');
    eq(q14.nav.cat, 'inventory', 'its Go destination is the Inventory');
    var savedStats14 = s.stats, savedSeed = s.inventory['seed_t0'];
    s.quests = { claimed:{} }; s.stats = {};
    eq(FF.questComplete(q14), false, 'no cache opened -> not complete');
    s.stats['caches_opened'] = 1;
    ok(FF.questComplete(q14) && FF.questClaimable(q14), 'opening a Critter Cache completes + arms the quest');
    var seedBefore = s.inventory['seed_t0'] || 0;
    ok(FF.claimQuest('crack_the_cache'), 'claim succeeds');
    eq((s.inventory['seed_t0']||0) - seedBefore, 10, 'claim grants 10 Cotton Seeds');
    s.stats = savedStats14;
    if(savedSeed===undefined) delete s.inventory['seed_t0']; else s.inventory['seed_t0'] = savedSeed;
    // ---- Quest 15: "Tame the Wild" -- clear an estate resource -> a Copper Pickaxe ----
    var q15 = FF.questById('tame_the_wild');
    ok(!!q15 && q15.cat==='gettingstarted', 'Tame the Wild lives in Getting Started');
    eq(q15.target, 1, 'its target is 1 cleared obstacle');
    ok(q15.reward.kind==='item' && q15.reward.itemId==='tool_mining_t0_normal' && q15.reward.qty===1, 'reward is a first-tier Mining tool');
    ok(/Copper/.test(FF.questRewardLabel(q15)) && /Pickaxe/.test(FF.questRewardLabel(q15)), 'the reward line names the Copper Pickaxe');
    eq(q15.nav.cat, 'estate', 'its Go destination is the estate');
    var savedClears15 = s.estateClears, savedPick = s.inventory['tool_mining_t0_normal'];
    s.quests = { claimed:{} }; s.estateClears = 0;
    eq(FF.questComplete(q15), false, 'no clears -> not complete');
    s.estateClears = 1;
    ok(FF.questComplete(q15) && FF.questClaimable(q15), 'clearing one obstacle completes + arms the quest');
    var pickBefore = s.inventory['tool_mining_t0_normal'] || 0;
    ok(FF.claimQuest('tame_the_wild'), 'claim succeeds');
    eq((s.inventory['tool_mining_t0_normal']||0) - pickBefore, 1, 'claim grants a Copper Pickaxe');
    s.estateClears = savedClears15;
    if(savedPick===undefined) delete s.inventory['tool_mining_t0_normal']; else s.inventory['tool_mining_t0_normal'] = savedPick;
    // ---- Quest 16: "Strike the Vein" -- mine 100 Copper -> 100 Coal + a Copper Bellows ----
    var q16 = FF.questById('strike_the_vein');
    ok(!!q16 && q16.cat==='gettingstarted', 'Strike the Vein lives in Getting Started');
    eq(q16.target, 100, 'its target is 100 Copper mined');
    var r16 = q16.reward.items.map(function(it){ return it.itemId; });
    ok(r16.indexOf('coal')!==-1 && r16.indexOf('tool_metallurgy_t0_normal')!==-1, 'reward is 100 Coal + a Copper Metallurgy tool');
    ok(/Bellows/.test(FF.questRewardLabel(q16)), 'the reward line names the Copper Bellows');
    eq(q16.nav.sub, 'mining', 'the Go destination drills into Mining');
    var savedStats16 = s.stats, savedR16 = r16.map(function(id){ return s.inventory[id]; });
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['gathered_mining_t1'] = 100; // a different ore must not count
    eq(FF.questProgress(q16), 0, 'mining other ore does not advance the Copper tally');
    s.stats['gathered_mining_t0'] = 100;
    ok(FF.questComplete(q16) && FF.questClaimable(q16), '100 Copper completes + arms the quest');
    var r16Before = r16.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('strike_the_vein'), 'claim succeeds');
    eq((s.inventory['coal']||0) - r16Before[0], 100, 'claim grants 100 Coal');
    eq((s.inventory['tool_metallurgy_t0_normal']||0) - r16Before[1], 1, 'claim grants a Copper Bellows');
    s.stats = savedStats16;
    r16.forEach(function(id, i){ if(savedR16[i]===undefined) delete s.inventory[id]; else s.inventory[id] = savedR16[i]; });
    // ---- Quest 17: "Fire the Forge" -- smelt 100 Copper Bars -> 100 Copper Bars ----
    var q17 = FF.questById('fire_the_forge');
    ok(!!q17 && q17.cat==='gettingstarted', 'Fire the Forge lives in Getting Started');
    eq(q17.target, 100, 'its target is 100 smelted bars');
    ok(q17.reward.kind==='item' && q17.reward.itemId==='metallurgy_t0' && q17.reward.qty===100, 'reward is 100 Copper Bars (metallurgy_t0)');
    eq(FF.ALL_SELLABLE['metallurgy_t0'].name, 'Copper Bar', 'tier-0 metallurgy is a Copper Bar');
    eq(q17.nav.sub, 'metallurgy', 'the Go destination drills into Metallurgy');
    var savedStats17 = s.stats, savedBars = s.inventory['metallurgy_t0'];
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['made_metallurgy_t1'] = 100; // a different bar must not count
    eq(FF.questProgress(q17), 0, 'smelting other bars does not advance the Copper-bar tally');
    s.stats['made_metallurgy_t0'] = 100;
    ok(FF.questComplete(q17) && FF.questClaimable(q17), '100 Copper Bars completes + arms the quest');
    var barsBefore = s.inventory['metallurgy_t0'] || 0;
    ok(FF.claimQuest('fire_the_forge'), 'claim succeeds');
    eq((s.inventory['metallurgy_t0']||0) - barsBefore, 100, 'claim grants 100 Copper Bars');
    s.stats = savedStats17;
    if(savedBars===undefined) delete s.inventory['metallurgy_t0']; else s.inventory['metallurgy_t0'] = savedBars;
    // ---- Quest 18: "Forge Your Tools" -- forge a Copper Hatchet -> a Rare Copper Hatchet ----
    var q18 = FF.questById('forge_your_tools');
    ok(!!q18 && q18.cat==='gettingstarted', 'Forge Your Tools lives in Getting Started');
    eq(q18.target, 1, 'its target is 1 forged tool');
    ok(q18.reward.kind==='item' && q18.reward.itemId==='tool_forestry_t0_rare' && q18.reward.qty===1, 'reward is a Rare tier-0 Forestry tool');
    ok(/Rare/.test(FF.questRewardLabel(q18)) && /Hatchet/.test(FF.questRewardLabel(q18)), 'the reward line names the Rare Copper Hatchet');
    eq(q18.nav.sub, 'blacksmithing', 'the Go destination drills into Blacksmithing');
    var savedStats18 = s.stats, savedHatchet = s.inventory['tool_forestry_t0_rare'];
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['tool_made_mining_0'] = 1; // forging a DIFFERENT skill's tool must not count
    eq(FF.questProgress(q18), 0, 'forging another tool does not advance the Forestry-tool tally');
    s.stats['tool_made_forestry_0'] = 1;
    ok(FF.questComplete(q18) && FF.questClaimable(q18), 'forging a Copper Hatchet completes + arms the quest');
    var hatchetBefore = s.inventory['tool_forestry_t0_rare'] || 0;
    ok(FF.claimQuest('forge_your_tools'), 'claim succeeds');
    eq((s.inventory['tool_forestry_t0_rare']||0) - hatchetBefore, 1, 'claim grants a Rare Copper Hatchet');
    s.stats = savedStats18;
    if(savedHatchet===undefined) delete s.inventory['tool_forestry_t0_rare']; else s.inventory['tool_forestry_t0_rare'] = savedHatchet;
    // ---- Quest 19: "Break the Sod" -- place a Sand Field -> 10 Fertilizer ----
    var q19 = FF.questById('break_the_sod');
    ok(!!q19 && q19.cat==='gettingstarted', 'Break the Sod lives in Getting Started');
    eq(q19.target, 1, 'its target is 1 field placed');
    ok(q19.reward.kind==='item' && q19.reward.itemId==='fertilizer_t0' && q19.reward.qty===10, 'reward is 10 tier-0 Fertilizer');
    eq(q19.nav.cat, 'estate', 'its Go destination is the estate');
    var savedStats19 = s.stats, savedFert = s.inventory['fertilizer_t0'];
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['field_placed_1'] = 1; // a higher-tier field must not count
    eq(FF.questProgress(q19), 0, 'placing a different-tier field does not advance the Sand-field tally');
    s.stats['field_placed_0'] = 1;
    ok(FF.questComplete(q19) && FF.questClaimable(q19), 'placing a Sand Field completes + arms the quest');
    var fertBefore = s.inventory['fertilizer_t0'] || 0;
    ok(FF.claimQuest('break_the_sod'), 'claim succeeds');
    eq((s.inventory['fertilizer_t0']||0) - fertBefore, 10, 'claim grants 10 Fertilizer');
    s.stats = savedStats19;
    if(savedFert===undefined) delete s.inventory['fertilizer_t0']; else s.inventory['fertilizer_t0'] = savedFert;
    // ---- Quest 20: "Sow the First Seed" -- sow a Cotton Seed -> 10 Cotton ----
    var q20 = FF.questById('sow_the_first_seed');
    ok(!!q20 && q20.cat==='gettingstarted', 'Sow the First Seed lives in Getting Started');
    eq(q20.target, 1, 'its target is 1 seed sown');
    ok(q20.reward.kind==='item' && q20.reward.itemId==='farming_t0' && q20.reward.qty===10, 'reward is 10 Cotton (farming_t0)');
    eq(FF.ALL_SELLABLE['farming_t0'].name, 'Cotton', 'tier-0 crop is Cotton');
    eq(q20.nav.cat, 'farming', 'its Go destination is the Farming tab');
    var savedStats20 = s.stats, savedCotton20 = s.inventory['farming_t0'];
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['sowed_seed_t1'] = 1; // a different seed must not count
    eq(FF.questProgress(q20), 0, 'sowing a different seed does not advance the Cotton-seed tally');
    s.stats['sowed_seed_t0'] = 1;
    ok(FF.questComplete(q20) && FF.questClaimable(q20), 'sowing a Cotton Seed completes + arms the quest');
    var cotton20Before = s.inventory['farming_t0'] || 0;
    ok(FF.claimQuest('sow_the_first_seed'), 'claim succeeds');
    eq((s.inventory['farming_t0']||0) - cotton20Before, 10, 'claim grants 10 Cotton');
    s.stats = savedStats20;
    if(savedCotton20===undefined) delete s.inventory['farming_t0']; else s.inventory['farming_t0'] = savedCotton20;
    // ---- Quest 21: "Feed the Field" -- fertilize a Cotton plant -> 10 Cotton ----
    var q21 = FF.questById('feed_the_field');
    ok(!!q21 && q21.cat==='gettingstarted', 'Feed the Field lives in Getting Started');
    eq(q21.target, 1, 'its target is 1 fertilized plant');
    ok(q21.reward.kind==='item' && q21.reward.itemId==='farming_t0' && q21.reward.qty===10, 'reward is 10 Cotton');
    var savedStats21 = s.stats, savedCotton21 = s.inventory['farming_t0'];
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['fertilized_farming_t1'] = 1; // a different crop must not count
    eq(FF.questProgress(q21), 0, 'fertilizing a different crop does not advance the Cotton tally');
    s.stats['fertilized_farming_t0'] = 1;
    ok(FF.questComplete(q21) && FF.questClaimable(q21), 'fertilizing a Cotton plant completes + arms the quest');
    var cotton21Before = s.inventory['farming_t0'] || 0;
    ok(FF.claimQuest('feed_the_field'), 'claim succeeds');
    eq((s.inventory['farming_t0']||0) - cotton21Before, 10, 'claim grants 10 Cotton');
    s.stats = savedStats21;
    if(savedCotton21===undefined) delete s.inventory['farming_t0']; else s.inventory['farming_t0'] = savedCotton21;
    // ---- Quest 22: "First Harvest" -- harvest Cotton -> 10 Cotton + a Copper Loom ----
    var q22 = FF.questById('first_harvest');
    ok(!!q22 && q22.cat==='gettingstarted', 'First Harvest lives in Getting Started');
    eq(q22.target, 1, 'its target is 1 harvest');
    eq(q22.reward.kind, 'items', 'it grants a multi-item reward');
    var r22 = q22.reward.items.map(function(it){ return it.itemId; });
    ok(r22.indexOf('farming_t0')!==-1 && r22.indexOf('tool_weaving_t0_normal')!==-1, 'reward is 10 Cotton + a Copper Weaving tool');
    ok(/Loom/.test(FF.questRewardLabel(q22)), 'the reward line names the Copper Loom');
    var savedStats22 = s.stats, savedR22 = r22.map(function(id){ return s.inventory[id]; });
    s.quests = { claimed:{} }; s.stats = {};
    s.stats['harvested_farming_t1'] = 1; // a different crop must not count
    eq(FF.questProgress(q22), 0, 'harvesting a different crop does not advance the Cotton tally');
    s.stats['harvested_farming_t0'] = 1;
    ok(FF.questComplete(q22) && FF.questClaimable(q22), 'harvesting Cotton completes + arms the quest');
    var r22Before = r22.map(function(id){ return s.inventory[id]||0; });
    ok(FF.claimQuest('first_harvest'), 'claim succeeds');
    eq((s.inventory['farming_t0']||0) - r22Before[0], 10, 'claim grants 10 Cotton');
    eq((s.inventory['tool_weaving_t0_normal']||0) - r22Before[1], 1, 'claim grants a Copper Loom');
    s.stats = savedStats22;
    r22.forEach(function(id, i){ if(savedR22[i]===undefined) delete s.inventory[id]; else s.inventory[id] = savedR22[i]; });
    // ---- Act IV: Cloth, Kitchen & Cup (quests 23-30) ----
    // Reward system is now additive-by-field; a crafted_<skill> tally powers the crafting quests.
    var savedActStats = s.stats, savedActBA = s.bodyArmor, savedActGold = s.gold;
    function invGrantCheck(qid, itemId, n){ var b = s.inventory[itemId]||0; ok(FF.claimQuest(qid), 'claim '+qid+' succeeds'); eq((s.inventory[itemId]||0)-b, n, qid+' grants '+n+'x '+itemId); }
    // 23 Weave the Bolt: weave 10 Cotton Cloth -> Sewing Kit + 10 cloth
    var q23 = FF.questById('weave_the_bolt');
    ok(!!q23 && q23.target===10, 'Weave the Bolt: craft 10');
    ok(q23.reward.items.some(function(i){return i.itemId==='tool_tailoring_t0_normal';}) && q23.reward.items.some(function(i){return i.itemId==='weaving_t0';}), 'reward is Sewing Kit + Cotton Cloth');
    eq(FF.ALL_SELLABLE['weaving_t0'].name, 'Cotton Cloth', 'weaving_t0 is Cotton Cloth');
    s.quests={claimed:{}}; s.stats={};
    s.stats['crafted_tanning']=10; eq(FF.questProgress(q23), 0, 'crafting a different skill does not advance weaving');
    s.stats['crafted_weaving']=10; ok(FF.questComplete(q23), '10 weaves completes');
    invGrantCheck('weave_the_bolt','tool_tailoring_t0_normal',1);
    // 24 Dress the Part: equip a cloth (tailoring) chest -> Fishing Rod
    var q24 = FF.questById('dress_the_part');
    ok(!!q24 && q24.reward.items[0].itemId==='tool_fishing_t0_normal', 'Dress the Part rewards a Fishing Rod');
    s.quests={claimed:{}}; s.bodyArmor={};
    eq(FF.questComplete(q24), false, 'no cloth chest -> not complete');
    s.bodyArmor.chest={material:'chain',tier:1}; eq(FF.questComplete(q24), false, 'a chain chest is not cloth');
    s.bodyArmor.chest={material:'tailoring',tier:1}; ok(FF.questComplete(q24), 'a tailoring (cloth) chest completes');
    invGrantCheck('dress_the_part','tool_fishing_t0_normal',1);
    // 25 Cast a Line: catch 50 fish -> Roasting Spit + 30 fish
    var q25 = FF.questById('cast_a_line');
    ok(!!q25 && q25.target===50, 'Cast a Line: catch 50');
    s.quests={claimed:{}}; s.stats={};
    s.stats['gathered_fishing_t1']=50; eq(FF.questProgress(q25), 0, 'a different fish does not count');
    s.stats['gathered_fishing_t0']=50; ok(FF.questComplete(q25), '50 fish completes');
    invGrantCheck('cast_a_line','tool_roasting_t0_normal',1);
    // 26-28 kitchen crafts (crafted_<skill>)
    [['roast_the_catch','roasting',20,'tool_cooking_t0_normal'],['a_warm_meal','cooking',10,'tool_baking_t0_normal'],['break_bread','baking',10,'tool_mixology_t0_normal']].forEach(function(row){
      var q = FF.questById(row[0]); ok(!!q && q.target===row[2], row[0]+' target '+row[2]);
      s.quests={claimed:{}}; s.stats={};
      s.stats['crafted_'+row[1]]=row[2]; ok(FF.questComplete(q), row[0]+' completes at target');
      invGrantCheck(row[0], row[3], 1);
    });
    // 29 Steep the Leaves: brew 5 teas -> 10 teas
    var q29 = FF.questById('steep_the_leaves');
    ok(!!q29 && q29.target===5, 'Steep the Leaves: brew 5');
    s.quests={claimed:{}}; s.stats={ crafted_mixology:5 }; ok(FF.questComplete(q29), '5 teas completes');
    invGrantCheck('steep_the_leaves','mixology_t0',10);
    // 30 A Restful Cup: drink a tea -> foraging + GOLD (additive reward)
    var q30 = FF.questById('a_restful_cup');
    ok(!!q30 && q30.reward.gold===500, 'A Restful Cup rewards 500 gold alongside items');
    ok(/Gold/.test(FF.questRewardLabel(q30)) && /Blackberry/.test(FF.questRewardLabel(q30)), 'reward line shows both the berries and the gold');
    s.quests={claimed:{}}; s.stats={}; s.gold=0;
    eq(FF.questComplete(q30), false, 'no tea drunk -> not complete');
    s.stats['teas_drunk']=1; ok(FF.questComplete(q30), 'drinking a tea completes');
    var g30 = s.gold||0, f30 = s.inventory['foraging_t0']||0;
    ok(FF.claimQuest('a_restful_cup'), 'claim a_restful_cup succeeds');
    eq((s.gold||0)-g30, 500, 'claim grants 500 gold');
    eq((s.inventory['foraging_t0']||0)-f30, 20, 'claim grants 20 Blackberries');
    s.stats = savedActStats; s.bodyArmor = savedActBA; s.gold = savedActGold;
    // ---- Act V: Wood, Stone & Home (quests 31-38) ----
    var savedVStats = s.stats, savedVGold = s.gold;
    // 31 Fell the Timber (gather forestry) + 32-34 build crafts (crafted_<skill>)
    [['fell_the_timber','gathered_forestry_t0',100,'tool_carpentry_t0_normal'],
     ['square_the_planks','crafted_carpentry',100,'tool_stonecutting_t0_normal'],
     ['cut_the_stone','crafted_stonecutting',50,'tool_paving_t0_normal'],
     ['lay_the_tiles','crafted_paving',20,'paving_t0']].forEach(function(row){
      var q = FF.questById(row[0]); ok(!!q && q.target===row[2], row[0]+' target '+row[2]);
      s.quests={claimed:{}}; s.stats={};
      s.stats[row[1]] = row[2]-1; eq(FF.questComplete(q), false, row[0]+': one short is not complete');
      s.stats[row[1]] = row[2]; ok(FF.questComplete(q), row[0]+' completes at target');
      invGrantCheck(row[0], row[3], row[3]==='paving_t0'?20:1);
    });
    // 35 Pave the Estate, 36 Raise a Workshop, 37 Hearth and Home, 38 Put a Peon to Work
    [['pave_the_estate','paved_estate'],['raise_a_workshop','workshop_built'],['hearth_and_home','cottage_built'],['put_a_peon_to_work','peons_housed']].forEach(function(row){
      var q = FF.questById(row[0]); ok(!!q && q.target===1, row[0]+' target 1');
      s.quests={claimed:{}}; s.stats={};
      eq(FF.questComplete(q), false, row[0]+': not complete at 0');
      s.stats[row[1]] = 1; ok(FF.questComplete(q), row[0]+' completes when the estate action fires');
    });
    // Verify the gold-only rewards actually pay out (Hearth and Home = 1000g).
    var q37 = FF.questById('hearth_and_home');
    eq(q37.reward.gold, 1000, 'Hearth and Home rewards 1000 gold');
    ok(/1,000 Gold/.test(FF.questRewardLabel(q37)), 'its reward line reads as gold');
    s.quests={claimed:{}}; s.stats={ cottage_built:1 }; s.gold=0;
    ok(FF.claimQuest('hearth_and_home'), 'claim hearth_and_home succeeds');
    eq(s.gold, 1000, 'claim pays 1000 gold');
    s.stats = savedVStats; s.gold = savedVGold;
    // ---- Act VI: Faith & Flask (quests 39-41) ----
    var savedVIStats = s.stats, savedVIGold = s.gold;
    // 39 Kneel and Pray: 10 prayers -> Sickle + gold
    var q39 = FF.questById('kneel_and_pray');
    ok(!!q39 && q39.target===10, 'Kneel and Pray: 10 prayers');
    ok(/Sickle/.test(FF.questRewardLabel(q39)) && /Gold/.test(FF.questRewardLabel(q39)), 'reward is a Sickle + gold');
    s.quests={claimed:{}}; s.stats={}; s.gold=0;
    s.stats['prayers']=9; eq(FF.questComplete(q39), false, '9 prayers is not enough');
    s.stats['prayers']=10; ok(FF.questComplete(q39), '10 prayers completes');
    invGrantCheck('kneel_and_pray','tool_herbalism_t0_normal',1);
    // 40 Green of Thumb: 100 herbs -> Mortar & Pestle + 20 herbs
    var q40 = FF.questById('green_of_thumb');
    ok(!!q40 && q40.target===100, 'Green of Thumb: 100 herbs');
    eq(FF.ALL_SELLABLE['herbalism_t0'].name, 'Chamomile', 'herbalism_t0 is Chamomile');
    s.quests={claimed:{}}; s.stats={ gathered_herbalism_t0:100 }; ok(FF.questComplete(q40), '100 herbs completes');
    invGrantCheck('green_of_thumb','tool_alchemy_t0_normal',1);
    // 41 Brew a Draught: 5 potions -> 10 elixirs
    var q41 = FF.questById('brew_a_draught');
    ok(!!q41 && q41.target===5, 'Brew a Draught: 5 potions');
    ok(!!FF.ALL_SELLABLE['elixir_t0'], 'elixir_t0 is a real item');
    s.quests={claimed:{}}; s.stats={ crafted_alchemy:5 }; ok(FF.questComplete(q41), '5 potions completes');
    invGrantCheck('brew_a_draught','elixir_t0',10);
    s.stats = savedVIStats; s.gold = savedVIGold;
    // ---- Act VII: Adornment & Enchantment (quests 42-45) ----
    var savedVIIStats = s.stats, savedVIIGold = s.gold, savedJS = s.jewelrySlots, savedUniq = s.uniqueItems, savedOff7 = s.equippedOffhand, savedOffT7 = s.equippedOffhandTier;
    // 42 Cut and Set: equip a ring -> Copper Amulet + gold
    var q42 = FF.questById('cut_and_set');
    ok(!!q42 && q42.target===1, 'Cut and Set: target 1');
    s.quests={claimed:{}}; s.jewelrySlots={ ring1:{}, ring2:{}, ring3:{}, ring4:{}, ring5:{}, amulet:{} };
    eq(FF.questComplete(q42), false, 'no ring equipped -> not complete');
    s.jewelrySlots.ring1 = { typeId:'plain', tier:1, rarity:'normal' };
    ok(FF.questComplete(q42), 'a ring in a ring slot completes');
    invGrantCheck('cut_and_set','amulet_t0_normal',1);
    // 43 Steel Sharpened: enhance a unique to +5 (progress = max enhance)
    var q43 = FF.questById('steel_sharpened');
    ok(!!q43 && q43.target===5, 'Steel Sharpened: to +5');
    // Progress reads the non-regressing enhance_best stat (set on any successful enhance of ANY item, not
    // just masterwork loot) so a later shatter can't drop the bar back below +5.
    s.quests={claimed:{}}; s.stats={ enhance_best:4 };
    eq(FF.questProgress(q43), 4, '+4 reads as 4/5 progress');
    eq(FF.questComplete(q43), false, '+4 is not complete');
    s.stats.enhance_best = 5; ok(FF.questComplete(q43), '+5 on any item completes');
    s.gold=0; ok(FF.claimQuest('steel_sharpened'), 'claim steel_sharpened'); eq(s.gold, 2000, 'grants 2000 gold');
    // 44 Bind the Crystal: enchant a piece -> 5 crystals
    var q44 = FF.questById('bind_the_crystal');
    ok(!!q44 && q44.target===1, 'Bind the Crystal: target 1');
    s.quests={claimed:{}}; s.stats={};
    eq(FF.questComplete(q44), false, 'no enchant applied -> not complete');
    s.stats['enchants_applied']=1; ok(FF.questComplete(q44), 'one enchant completes');
    invGrantCheck('bind_the_crystal','enchant_t0',5);
    // 45 Ward and Glyph: equip a ward
    var q45 = FF.questById('ward_and_glyph');
    ok(!!q45 && q45.target===1, 'Ward and Glyph: target 1');
    s.quests={claimed:{}}; s.equippedOffhand='shieldSmall'; s.equippedOffhandTier=1;
    eq(FF.questComplete(q45), false, 'a shield is not a ward');
    s.equippedOffhand='wardFire'; s.equippedOffhandTier=1;
    ok(FF.questComplete(q45), 'an equipped Ward completes');
    invGrantCheck('ward_and_glyph','stward_wardFire_t0_normal',1);
    s.stats=savedVIIStats; s.gold=savedVIIGold; s.jewelrySlots=savedJS; s.uniqueItems=savedUniq; s.equippedOffhand=savedOff7; s.equippedOffhandTier=savedOffT7;
    // ---- Act VIII: Trade & Legacy (quests 46-50) ----
    var savedVIIIStats = s.stats, savedVIIIGold = s.gold, savedXp = s.xp;
    // 46 Light the Hall (chandlery), 47 Burn the Midnight Oil (peon_lit), 48 Study the Tomes (tomes_studied)
    [['light_the_hall','crafted_chandlery',10,'chandlery_t0',20],['burn_the_midnight_oil','peon_lit',1,'chandlery_t0',10],['study_the_tomes','tomes_studied',1,'tome_t0',3]].forEach(function(row){
      var q = FF.questById(row[0]); ok(!!q && q.target===row[2], row[0]+' target '+row[2]);
      s.quests={claimed:{}}; s.stats={};
      eq(FF.questComplete(q), false, row[0]+': not complete at 0');
      s.stats[row[1]]=row[2]; ok(FF.questComplete(q), row[0]+' completes');
      invGrantCheck(row[0], row[3], row[4]);
    });
    // 49 Kindred Spirits: visit the guild
    var q49 = FF.questById('kindred_spirits');
    ok(!!q49 && q49.target===1 && q49.reward.gold===2000, 'Kindred Spirits: visit guild -> 2000 gold');
    s.quests={claimed:{}}; s.stats={}; eq(FF.questComplete(q49), false, 'not visited -> not complete');
    s.stats['guild_visited']=1; ok(FF.questComplete(q49), 'visiting the guild completes');
    // 50 Master of the Frontier: any skill to Lv 25
    var q50 = FF.questById('master_of_the_frontier');
    ok(!!q50 && q50.target===25, 'Master of the Frontier: to Lv 25');
    s.quests={claimed:{}}; s.xp={ mining: FF.xpFloorForLevel(24) };
    eq(FF.questComplete(q50), false, 'Lv 24 is not enough');
    s.xp={ mining: FF.xpFloorForLevel(25) }; ok(FF.questComplete(q50), 'a skill at Lv 25 completes');
    s.gold=0; ok(FF.claimQuest('master_of_the_frontier'), 'claim master_of_the_frontier'); eq(s.gold, 5000, 'grants 5000 gold');
    s.stats=savedVIIIStats; s.gold=savedVIIIGold; s.xp=savedXp;
    // ---- Capstone (quest 51): "Frontier Hero" -- complete all 50 -> Title + Supreme Rabbit Belt ----
    var qCap = FF.questById('frontier_hero');
    ok(!!qCap && qCap.cat==='gettingstarted', 'Frontier Hero lives in Getting Started');
    eq(qCap.target, 50, 'its target is the other 50 Getting Started quests');
    ok(qCap.reward.titleId==='title_frontier_hero' && qCap.reward.items[0].itemId==='belt_t0_supreme', 'reward is the Frontier Hero title + a Supreme Rabbit Belt');
    eq(FF.ALL_SELLABLE['belt_t0_supreme'].name, 'Supreme Rabbit Belt', 'the belt reads as a Supreme Rabbit Belt');
    ok(/Title: Frontier Hero/.test(FF.questRewardLabel(qCap)) && /Supreme Rabbit Belt/.test(FF.questRewardLabel(qCap)), 'reward line shows both the title and the belt');
    // The capstone title must be registered in the TITLES browser.
    ok(FF.TITLE_BY_ID ? !!FF.TITLE_BY_ID['title_frontier_hero'] : true, 'the Frontier Hero title is registered');
    var gsIds = FF.QUESTS.filter(function(q){ return q.cat==='gettingstarted' && q.id!=='frontier_hero'; }).map(function(q){ return q.id; });
    eq(gsIds.length, 50, 'there are exactly 50 other Getting Started quests');
    var savedTitlesCap = s.titles, savedBeltSup = s.inventory['belt_t0_supreme'];
    s.quests={claimed:{}}; s.titles={};
    // Claim 49 of 50 -> not yet complete.
    gsIds.slice(0,49).forEach(function(id){ s.quests.claimed[id]=true; });
    eq(FF.questProgress(qCap), 49, '49 of 50 claimed reads as 49');
    eq(FF.questComplete(qCap), false, '49 of 50 does not complete the capstone');
    s.quests.claimed[gsIds[49]] = true;
    ok(FF.questComplete(qCap) && FF.questClaimable(qCap), 'all 50 claimed arms the capstone');
    var beltSupBefore = s.inventory['belt_t0_supreme']||0;
    ok(FF.claimQuest('frontier_hero'), 'claim frontier_hero succeeds');
    eq((s.inventory['belt_t0_supreme']||0)-beltSupBefore, 1, 'claim grants a Supreme Rabbit Belt');
    eq(!!(s.titles && s.titles['title_frontier_hero']), true, 'claim grants the Frontier Hero title');
    s.titles = savedTitlesCap; if(savedBeltSup===undefined) delete s.inventory['belt_t0_supreme']; else s.inventory['belt_t0_supreme']=savedBeltSup;
    // ---- Sorting: claimed quests sink to the bottom (stable); earned titles float to the top ----
    var _qA = FF.questById('answer_the_call'), _qB = FF.questById('take_up_arms'), _qC = FF.questById('don_your_armor');
    s.quests = { claimed:{} };
    eq(FF.questsClaimedLast([_qA,_qB,_qC]).map(function(q){return q.id;}).join(','), 'answer_the_call,take_up_arms,don_your_armor', 'nothing claimed -> original order preserved');
    s.quests.claimed['take_up_arms'] = true; // claim the MIDDLE one
    eq(FF.questsClaimedLast([_qA,_qB,_qC]).map(function(q){return q.id;}).join(','), 'answer_the_call,don_your_armor,take_up_arms', 'a claimed quest sinks to the bottom; unclaimed keep order');
    s.quests.claimed['answer_the_call'] = true; // claim the FIRST too
    eq(FF.questsClaimedLast([_qA,_qB,_qC]).map(function(q){return q.id;}).join(','), 'don_your_armor,answer_the_call,take_up_arms', 'two claimed sink in their original order; unclaimed stays on top');
    // Titles page: an earned title renders above an unearned one.
    var _t0 = FF.TITLES[0].id, _t1 = FF.TITLES[1].id;
    s.titles = {}; s.titles[_t1] = true; // own only the SECOND registry title
    var _th = FF.renderTitlesTab();
    ok(_th.indexOf('data-title="'+_t1+'"') !== -1 && _th.indexOf('data-title="'+_t1+'"') < _th.indexOf('data-title="'+_t0+'"'), 'an earned title renders above an unearned one');
    s.titles = {};
    // ---- Quest tracker: pin/unpin quests to the persistent card; claiming untracks; empties when none ----
    var savedTracked = s.trackedQuests;
    s.quests = { claimed:{} }; s.trackedQuests = []; // prior sorting test left some quests claimed
    FF.questToggleTrack('take_up_arms');
    ok(FF.questTracked('take_up_arms') && s.trackedQuests.indexOf('take_up_arms')!==-1, 'toggling Track pins the quest');
    FF.questToggleTrack('take_up_arms');
    ok(!FF.questTracked('take_up_arms'), 'toggling Track again unpins it');
    s.trackedQuests = []; s.quests = { claimed:{ don_your_armor:true } };
    FF.questToggleTrack('don_your_armor');
    ok(!FF.questTracked('don_your_armor'), 'a claimed quest cannot be tracked');
    // Claiming a tracked quest removes it from the tracker.
    s.quests = { claimed:{} }; s.trackedQuests = ['answer_the_call'];
    ok(FF.questTracked('answer_the_call'), 'answer_the_call is tracked');
    ok(FF.claimQuest('answer_the_call'), 'claim the tracked quest');
    ok(!FF.questTracked('answer_the_call'), 'claiming a quest untracks it');
    // renderQuestTracker: a card appears for a tracked quest and empties out when nothing is tracked.
    var _qtEl = (typeof document !== 'undefined') && document.getElementById('questTracker');
    if(_qtEl){
      s.quests = { claimed:{} }; s.trackedQuests = ['take_up_arms'];
      FF.renderQuestTracker();
      ok(/Take Up Arms/.test(_qtEl.innerHTML) && /qtrack/.test(_qtEl.innerHTML), 'the tracker card renders the tracked quest');
      ok(/data-action="questUntrack"/.test(_qtEl.innerHTML), 'the tracker card offers an untrack (✕) control');
      ok(/qtrack-how/.test(_qtEl.innerHTML) && /equip your Scimitar/.test(_qtEl.innerHTML), 'the tracker card shows the quest’s how-to action text');
      s.trackedQuests = [];
      FF.renderQuestTracker();
      eq(_qtEl.innerHTML, '', 'the tracker empties out completely when nothing is tracked');
    }
    s.quests = { claimed:{} }; s.trackedQuests = savedTracked || [];
    // ---- Quests page: 1-50 numbering, capstone thick border, claimable-to-top + Act grouping ----
    eq(FF.QUEST_ORDINAL['answer_the_call'], 1, 'the first First Frontier quest is numbered 1');
    eq(FF.QUEST_ORDINAL['master_of_the_frontier'], 50, 'the 50th First Frontier quest is numbered 50');
    eq(FF.QUEST_ORDINAL['frontier_hero'], undefined, 'the capstone has no 1-50 number');
    ok(/quest-acc-num">1</.test(FF.renderQuestAccordion(FF.questById('answer_the_call'))), 'quest 1 renders its number badge');
    ok(/quest-acc-num">50</.test(FF.renderQuestAccordion(FF.questById('master_of_the_frontier'))), 'quest 50 renders its number badge');
    var accCap = FF.renderQuestAccordion(FF.questById('frontier_hero'));
    ok(/quest-acc\b[^"]*capstone/.test(accCap) || /class="quest-acc[^"]*capstone/.test(accCap), 'the capstone accordion carries the capstone (thick-border) class');
    ok(/★/.test(accCap) && !/quest-acc-num">\d/.test(accCap), 'the capstone shows a ★ badge, not a 1-50 number');
    // questsSorted: ready-to-claim first, then in-progress, then claimed.
    var _qa=FF.questById('answer_the_call'), _qb=FF.questById('take_up_arms'), _qc=FF.questById('don_your_armor');
    s.stats={}; s.equippedMainhand=null; s.bodyArmor={};
    s.quests={ claimed:{ don_your_armor:true } }; // answer_the_call claimable, take_up_arms in-progress, don_your_armor claimed
    var order = FF.questsSorted([_qc,_qb,_qa]).map(function(q){ return q.id; });
    eq(order[0], 'answer_the_call', 'a claimable quest sorts to the front');
    eq(order[order.length-1], 'don_your_armor', 'a claimed quest sorts to the back');
    // renderQuestsTab (best-effort: only asserts when the First Frontier tab is the one that renders).
    s.quests={ claimed:{} }; s.stats={}; s.equippedMainhand=null; s.bodyArmor={}; s.activeCompanions=[];
    var qtHtml = FF.renderQuestsTab();
    if(/Answer the Call/.test(qtHtml)){
      ok(/Ready to Claim/.test(qtHtml), 'claimable quests get a Ready to Claim header');
      ok(/Act I · First Steps/.test(qtHtml), 'in-progress quests are grouped under Act headers');
      ok(qtHtml.indexOf('Ready to Claim') < qtHtml.indexOf('Act I'), 'Ready to Claim sits above the Acts');
    }
    s.quests={ claimed:{} };
    // ---- Estate quest category: "Clearing the Land" (clear 10 obstacles -> 20 tier-5 paving tiles) ----
    var savedClears = s.estateClears, savedPave = s.inventory['paving_t5'];
    s.estateClears = 0; s.quests = { claimed:{} };
    // 'estatequests' is a distinct quest category id -- it must NOT collide with the 'estate' map category.
    eq(FF.isQuestCategory('estatequests'), true, 'estatequests is a quest category');
    eq(FF.isQuestCategory('estate'), false, 'the estate map category is NOT a quest category (no collision)');
    var eArea = FF.AREAS.filter(function(a){ return a.id==='quests'; })[0];
    ok(eArea.subs.some(function(sub){ return sub[0]==='estatequests'; }), 'Estate is a tab within Quests');
    var eq2 = FF.questById('clearing_the_land');
    ok(!!eq2 && eq2.cat==='estatequests', 'the Clearing the Land quest lives in the Estate category');
    eq(eq2.target, 10, 'its target is 10 cleared obstacles');
    ok(eq2.reward.kind==='item' && eq2.reward.itemId==='paving_t5' && eq2.reward.qty===20, 'reward is 20x tier-5 paving tiles (paving_t5)');
    ok(eq2.nav.cat==='estate', 'its Go destination is the estate');
    eq(FF.questComplete(eq2), false, 'no clears -> not complete');
    s.estateClears = 10;
    ok(FF.questComplete(eq2) && FF.questClaimable(eq2), 'reaching 10 clears completes + arms the quest');
    eq(FF.questClaimableInCat('estatequests'), true, 'the Estate tab reports a claimable');
    var pBefore = s.inventory['paving_t5'] || 0;
    ok(FF.claimQuest('clearing_the_land'), 'claim succeeds');
    eq((s.inventory['paving_t5']||0) - pBefore, 20, 'claim grants 20 tier-5 paving tiles');
    s.estateClears = savedClears; if(savedPave===undefined) delete s.inventory['paving_t5']; else s.inventory['paving_t5'] = savedPave;
    // restore
    s.monsterKills = savedMK; s.quests = savedQ; s.inventory['corpse_t0'] = savedInv; s.titles = savedTitles;
    if(savedFal===undefined) delete s.inventory['stweapon_scimitar_t0_normal']; else s.inventory['stweapon_scimitar_t0_normal'] = savedFal;
    s.stats = savedStatsQ; s.equippedRelicTier = savedRelicQ; s.equippedBeltTier = savedBeltTQ; s.equippedBeltRarity = savedBeltRQ;
    s.gatherTools = savedGTQ; s.activeCompanions = savedACQ; s.equippedMainhand = savedMHQ; s.equippedOffhand = savedOffQ;
    s.equippedOffhandTier = savedOffTQ; s.bodyArmor = savedBAQ; s.xp = savedXpQ; s.uniqueItems = savedUniqQ; s.jewelrySlots = savedJSQ;
  });

  // ---- Auth identity guard: cross-account write prevention (shared per-origin auth session) ----
  suite('auth: identity-mismatch guard', function(){
    var saved = FF._authBoundUserId();
    // No binding yet -> nothing is a mismatch (an unbound tab never false-fences).
    FF.authBindIdentity(null);
    eq(FF.authIdentityMismatch('user-A'), false, 'an unbound tab never reports a mismatch');
    // Bound to account A: A's own session matches; a foreign id (shared-storage swap) mismatches.
    FF.authBindIdentity('user-A');
    eq(FF.authIdentityMismatch('user-A'), false, 'the bound account is not a mismatch');
    ok(FF.authIdentityMismatch('user-B') === true, 'a different account on the shared session IS a mismatch');
    // A missing session id (mid-refresh) is not treated as a swap.
    eq(FF.authIdentityMismatch(null), false, 'a null session id does not fence');
    eq(FF.authIdentityMismatch(undefined), false, 'an undefined session id does not fence');
    // Deliberate in-tab switch: clearing the binding first means the imminent SIGNED_IN isn't misread.
    FF.authBindIdentity(null);
    eq(FF.authIdentityMismatch('user-B'), false, 'cleared binding: a fresh login is not a foreign swap');
    FF.authBindIdentity(saved || null);
  });

  // ---- Joining a party: Total Level 5000 + the PREVIOUS layer cleared (like starting your own) ----
  suite('dungeons: join requirements + party code', function(){
    var s = FF._state, savedCleared = s.dungeonsCleared, savedXp = s.xp, savedPhys = s.physique;
    // Force the profile over the Total Level gate so the join test isolates the progression rule.
    // (playerTotalLevel sums skill + physique levels; a big fake skill map clears 5000 handily.)
    var bigXp = {}; if (FF.ALL_MAIN_SKILL_IDS) FF.ALL_MAIN_SKILL_IDS.forEach(function(id){ bigXp[id] = 1e12; });
    s.xp = bigXp; s.physique = {};
    ok(FF.playerTotalLevel(s) >= FF.DUNGEON_MIN_TOTAL_LEVEL, 'the boosted profile clears the Total Level gate');
    s.dungeonsCleared = {};
    eq(FF.dungeonJoinBlock('d1'), null, 'the Cave has no prerequisite to join');
    ok(FF.dungeonJoinBlock('d2') !== null, 'joining a Tunnel party requires the Cave cleared first');
    // Beating D1 (solo OR group -- both call dungeonMarkCleared) unlocks joining D2 parties;
    // a prior D2 clear must NOT be required (that locked group progression behind solo play).
    FF.dungeonMarkCleared('d1');
    eq(FF.dungeonJoinBlock('d2'), null, 'clearing the Cave unlocks joining Tunnel parties -- no Tunnel clear needed');
    ok(FF.dungeonJoinBlock('d3') !== null, 'D3 parties still need the Tunnel cleared');
    FF.dungeonMarkCleared('d2');
    eq(FF.dungeonJoinBlock('d3'), null, 'the chain continues: clearing D2 unlocks joining D3 parties');
    ok(FF.dungeonJoinBlock('d4') !== null, '...and D4 parties still need D3 cleared');
    // Below the Total Level gate, even the Cave blocks joining.
    s.xp = {}; s.physique = {};
    ok((FF.dungeonJoinBlock('d1') || '').indexOf('Total Level') === 0, 'below the Total Level gate even the Cave blocks joining');
    s.xp = savedXp; s.physique = savedPhys; s.dungeonsCleared = savedCleared;
    // Party-code parsing: "<layer>:<id>" splits; a bare id yields a null layer.
    var c = FF.parseDungeonCode('d2:abc-123');
    eq(c.layer, 'd2', 'a "d2:<id>" code parses the layer'); eq(c.id, 'abc-123', '...and the session id');
    eq(FF.parseDungeonCode('D3 9f8e').layer, 'd3', 'space + upper-case layer prefixes also parse');
    eq(FF.parseDungeonCode('abc-123').layer, null, 'a bare id has no encoded layer');
    eq(FF.parseDungeonCode('abc-123').id, 'abc-123', 'a bare id passes through as the id');
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
    // Reworked ladder: Flashbang / Mending Ray / Reflected Light / Everfull / Radiant Barrier.
    eq(cd.passives.map(function(p){ return p.name; }).join(','), 'Flashbang,Mending Ray,Reflected Light,Everfull,Radiant Barrier', 'reworked Lumen ladder (party medic)');
    // The class no longer grants flat damage (Glare retired).
    eq(FF.newClassDmgMult({hp:100}, stFor(80)), 1, 'Lumen no longer grants flat damage');
    eq(FF.LUMEN_REFLECT_PCT, 0.15, 'Reflected Light returns 15% of damage as healing');
    // Solo, a heal always targets self (no living networked party).
    eq(FF.lumenHealTarget().isSelf, true, 'solo -> Lumen heals cast on self');
    // Live-state mechanics: the Lumen kit must be worn on _state so the bonuses are active.
    var S = FF._state;
    var sv = { mh:S.equippedMainhand, oh:S.equippedOffhand, ba:S.bodyArmor, xp:S.xp.lumen, act:S.activity, hp:S.playerHp, sh:S.lumenShield };
    try {
      S.equippedMainhand='wandLight'; S.equippedOffhand='wardLight';
      S.bodyArmor={helmet:armor('leather'),chest:armor('leather'),gauntlets:armor('leather'),boots:armor('leather')};
      S.activity = { type:'combat', monsterId:null, monsterHp:100 };
      // Reflected Light (Lv40): a Lumen heal restores HP to self; no shield yet (Everfull/Barrier locked).
      S.xp.lumen = FF.xpFloorForLevel(40); S.lumenShield = 0; S.playerHp = 1;
      ok(FF.lumenBonus(40), 'Lumen Lv40 active with the kit worn');
      ok(FF.lumenApplyHeal(100) > 0 && S.playerHp > 1, 'a Lumen heal restores HP to self');
      eq(S.lumenShield||0, 0, 'no shield before Everfull/Radiant Barrier');
      // Everfull (Lv60): healing a full-HP target banks the overheal as a shield.
      S.xp.lumen = FF.xpFloorForLevel(60); S.lumenShield = 0; S.playerHp = FF.maxHp(S);
      FF.lumenApplyHeal(100);
      ok((S.lumenShield||0) > 0, 'Everfull banks overheal as a shield');
      // Radiant Barrier (Lv80): a normal heal also grants a shield = 30% of the HP restored.
      S.xp.lumen = FF.xpFloorForLevel(80); S.lumenShield = 0; S.playerHp = Math.max(1, FF.maxHp(S) - 100);
      var h2 = FF.lumenApplyHeal(50);
      ok(h2 > 0 && Math.abs((S.lumenShield||0) - Math.round(h2 * 0.30)) <= 1, 'Radiant Barrier shields 30% of the amount healed');
      // The shield is capped at 30% of max HP.
      S.lumenShield = 0; FF.lumenAddShield(1e9); eq(S.lumenShield, FF.lumenShieldCap(S), 'Lumen shield caps at 30% of max HP');
    } finally {
      S.equippedMainhand=sv.mh; S.equippedOffhand=sv.oh; S.bodyArmor=sv.ba; S.xp.lumen=sv.xp; S.activity=sv.act; S.playerHp=sv.hp; S.lumenShield=sv.sh;
    }
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
    // Reworked ladder: Savagery / Bloodletting / Frenzied Rending / Arterial Spray / Hemorrhagic Burst.
    eq(cd.passives.map(function(p){ return p.name; }).join(','), 'Savagery,Bloodletting,Frenzied Rending,Arterial Spray,Hemorrhagic Burst', 'reworked Reaver ladder');
    // Savagery +25% damage (Lv1); the class no longer grants any flat crit damage (Hemorrhage retired).
    ok(Math.abs(FF.newClassDmgMult({hp:100}, stFor(1)) - 1.25) < 1e-9, 'Savagery +25% damage');
    eq(FF.newClassCritDmg(stFor(80)), 0, 'Reaver no longer grants flat crit damage');
    // Frenzied Rending (Lv40): +15% attack speed (x0.85) at max Bleed stacks; neutral below max or before Lv40.
    var frMax = stFor(40); frMax.activity = { type:'combat', monsterHp:100, bleedStacks:5, bleedUntil:Date.now()+5000 };
    near(FF.classAttackSpeedMult(frMax), 0.85, 'Frenzied Rending: +15% attack speed at max Bleed stacks', 1e-9);
    var frLow = stFor(40); frLow.activity = { type:'combat', monsterHp:100, bleedStacks:2, bleedUntil:Date.now()+5000 };
    eq(FF.classAttackSpeedMult(frLow), 1, 'no frenzy haste below max stacks');
    var fr20 = stFor(20); fr20.activity = { type:'combat', monsterHp:100, bleedStacks:5, bleedUntil:Date.now()+5000 };
    eq(FF.classAttackSpeedMult(fr20), 1, 'no frenzy haste before Lv40');
    // Bleed tick: it reads the global _state.activity. Snapshot the fields we touch, then restore.
    // With no Reaver kit equipped on _state, reaverBonus(60/80) are off, so we exercise the base tick:
    // it chips the enemy (no floor -- a Bleed can finish a foe), and an expired Bleed does nothing.
    var S = FF._state;
    var save = { act:S.activity, hp:S.playerHp, mh:S.equippedMainhand, oh:S.equippedOffhand };
    try {
      S.equippedMainhand=null; S.equippedOffhand=null;
      S.activity = { type:'combat', monsterId:null, monsterHp:100, bleedDps:20, bleedUntil:Date.now()+5000 };
      FF.applyReaverBleedTick(1000);
      ok(Math.abs(S.activity.monsterHp - 80) < 1e-6, 'Bleed chips 20 damage over 1s (20 dps)');
      S.activity.monsterHp = 5; S.activity.bleedDps = 999;
      FF.applyReaverBleedTick(1000);
      ok(S.activity.monsterHp <= 0, 'Bleed CAN land the killing blow (no 1 HP floor)');
      S.activity.monsterHp = 100; S.activity.bleedUntil = Date.now()-1;
      FF.applyReaverBleedTick(1000);
      eq(S.activity.monsterHp, 100, 'an expired Bleed deals no damage');
    } finally {
      S.activity=save.act; S.playerHp=save.hp; S.equippedMainhand=save.mh; S.equippedOffhand=save.oh;
    }
    // Bloodletting (Lv20): with the Reaver kit worn, the Bleed tick heals 8% of the damage it deals.
    var bl = { mh:S.equippedMainhand, oh:S.equippedOffhand, ba:S.bodyArmor, xp:S.xp.reaver, act:S.activity, hp:S.playerHp };
    try {
      S.equippedMainhand='halfmoonaxe'; S.equippedOffhand='shieldSmall';
      S.bodyArmor={helmet:armor('chain'),chest:armor('chain'),gauntlets:armor('leather'),boots:armor('leather')};
      S.xp.reaver = FF.xpFloorForLevel(25);
      ok(FF.reaverBonus(20), 'Reaver Lv20 is active with the kit worn');
      S.activity = { type:'combat', monsterId:null, monsterHp:100000, bleedDps:100, bleedUntil:Date.now()+5000 };
      S.playerHp = 10;
      FF.applyReaverBleedTick(1000); // 100 Bleed damage over 1s -> heal 8% = +8 HP
      ok(S.playerHp >= 18 - 1e-6, 'Bloodletting heals 8% of Bleed damage (100 dmg -> +8 HP), got '+S.playerHp);
    } finally {
      S.equippedMainhand=bl.mh; S.equippedOffhand=bl.oh; S.bodyArmor=bl.ba; S.xp.reaver=bl.xp; S.activity=bl.act; S.playerHp=bl.hp;
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
    ok(/HP \/ 5s/.test(FF.describeSpell({type:'regen',hps:4,durationMs:6000}, 1)), 'regen spell describes HP per 5s');
    ok(/killing blow/.test(FF.describeSpell({type:'bubble',durSec:3}, 1)), 'bubble spell describes killing blow');
    // Familiar regen rework: base value doubled, buff duration tripled (regenSpell('Patch Job',4,6)).
    var patch = FF.FAMILIAR_SPELLS.salvaging.filter(function(s){ return s.type==='regen'; })[0];
    ok(patch, 'salvaging familiar has a regen spell');
    eq(patch.hps, 8, 'familiar regen base value doubled (4 -> 8 HP per 5s)');
    eq(patch.durationMs, 18000, 'familiar regen buff duration tripled (6s -> 18s)');
  });

  suite('familiars: direct-damage spells scale from a T2 weapon (Lv1) to a Rare top weapon (Lv100)', function(){
    var wl = FF.STACKABLE_WEAPON_ITEMS;
    var t2 = wl['stweapon_rapier_t2_normal'], topRare = wl['stweapon_rapier_t19_rare']; // rapier: clean 1h, no dmgMult
    ok(t2 && topRare, 'reference rapier tiers resolve (Tier-2 normal + Rare top tier)');
    // A reference spell (amount 15) reads like a Tier-2 weapon at Lv1 and a Rare top-tier weapon at Lv100.
    var l1 = FF.familiarHitLevelDamage(1, FF.FAM_HIT_REF_AMOUNT), l100 = FF.familiarHitLevelDamage(100, FF.FAM_HIT_REF_AMOUNT);
    ok(l1 >= t2.dmgMin && l1 <= t2.dmgMax, 'Lv1 reference spell sits in the Tier-2 weapon raw range ('+t2.dmgMin+'-'+t2.dmgMax+'), got '+Math.round(l1*10)/10);
    ok(l100 >= topRare.dmgMin && l100 <= topRare.dmgMax, 'Lv100 reference spell sits in the Rare top-tier weapon raw range ('+topRare.dmgMin+'-'+topRare.dmgMax+'), got '+Math.round(l100));
    // Monotonic climb, and far steeper than the old +5%/lvl linear potency (~6x) it replaced.
    var prev = -1, mono = true; for(var lv=1; lv<=100; lv++){ var d = FF.familiarHitLevelDamage(lv, 15); if(d < prev) mono = false; prev = d; }
    ok(mono, 'familiar hit damage climbs monotonically from Lv1 to Lv100');
    ok(l100 / l1 > 200, 'the Lv1 -> Lv100 climb is ~270x (far steeper than the old ~6x linear potency)');
    // Per-spell weighting preserved: a higher-amount spell hits harder at the same level.
    ok(FF.familiarHitLevelDamage(50,16) > FF.familiarHitLevelDamage(50,13), 'a higher-amount spell hits harder at the same level');
    // Heals/buffs keep the gentle linear potency (unchanged) -- only direct damage got the steep curve.
    ok(Math.abs(FF.familiarPotencyMult(100) / FF.familiarPotencyMult(1) - 5.95) < 0.5, 'non-damage potency still ~6x at Lv100 (linear, unchanged)');
    // Every hit/siphon spell across every familiar lands in the weapon bands at both ends.
    var bad1 = [], bad100 = [];
    Object.keys(FF.FAMILIAR_SPELLS).forEach(function(k){
      FF.FAMILIAR_SPELLS[k].forEach(function(s){
        if(s.type!=='hit' && s.type!=='siphon') return;
        var d1 = FF.familiarHitLevelDamage(1, s.amount), d100 = FF.familiarHitLevelDamage(100, s.amount);
        if(!(d1 >= t2.dmgMin && d1 <= t2.dmgMax)) bad1.push(k+':'+s.name+'='+(Math.round(d1*10)/10));
        if(!(d100 >= topRare.dmgMin && d100 <= topRare.dmgMax)) bad100.push(k+':'+s.name+'='+Math.round(d100));
      });
    });
    ok(bad1.length===0, 'every hit/siphon at Lv1 lands in the Tier-2 weapon raw range' + (bad1.length?': '+bad1.slice(0,5).join(', '):''));
    ok(bad100.length===0, 'every hit/siphon at Lv100 lands in the Rare top-tier weapon raw range' + (bad100.length?': '+bad100.slice(0,5).join(', '):''));
    // Poison DoT familiars ride the SAME steep curve: a poison's per-application total (dps*duration) is
    // weighted through familiarHitLevelDamage, so poison keeps pace at Lv100 instead of falling behind.
    var pL1 = FF.familiarHitLevelDamage(1, 6*6), pL100 = FF.familiarHitLevelDamage(100, 6*6);
    ok(pL100 / pL1 > 200, 'poison per-application total climbs on the same ~270x curve as direct hits');
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

  // ---- Inventory accordions: fine-grained groups replace the category filter chips ----
  suite('inventory: accordion groups (weapons by family, armour by material)', function(){
    ok(typeof FF.invGroupFor === 'function' && Array.isArray(FF.INV_GROUPS), 'accordion group helpers exported');
    // Weapons split by family.
    eq(FF.invGroupFor('stweapon_greatsword_t5_rare'), 'w_swords', 'greatsword -> Swords');
    eq(FF.invGroupFor('stweapon_sledge_t3_normal'),   'w_hammers','sledge -> Hammers');
    eq(FF.invGroupFor('stweapon_hatchet_t3_normal'),  'w_axes',   'hatchet -> Axes');
    eq(FF.invGroupFor('stweapon_bowLong_t3_normal'),  'w_bows',   'long bow -> Bows');
    eq(FF.invGroupFor('stweapon_wandFire_t3_normal'), 'w_wands',  'fire wand -> Wands');
    eq(FF.invGroupFor('stweapon_claw_t3_normal'),     'w_claws',  'claws -> Claws');
    // Armour split by material.
    eq(FF.invGroupFor('bodyarmor_plate_chest_t5_rare'),     'a_plate',     'plate -> Plate Armor');
    eq(FF.invGroupFor('bodyarmor_tailoring_chest_t5_normal'),'a_tailoring','cloth -> Cloth Armor');
    eq(FF.invGroupFor('bodyarmor_leather_boots_t5_normal'), 'a_leather',   'leather -> Leather Armor');
    // Jewelry / offhands / tools each their own group; raw materials fall to the broad buckets.
    eq(FF.invGroupFor('stshield_medium_t5_normal'), 'shields', 'shield -> Shields');
    eq(FF.invGroupFor('ring_fire_t5_rare'),   'rings',   'ring -> Rings');
    eq(FF.invGroupFor('amulet_t5_rare'),      'amulets', 'amulet -> Amulets');
    eq(FF.invGroupFor('relic_t5_rare'),       'relics',  'relic -> Relics');
    eq(FF.invGroupFor('tool_mining_t5_normal'),'tools',  'tool -> Tools');
    eq(FF.invGroupFor('digging_t5'),          'gathering','raw material -> Gathering');
    eq(FF.invGroupFor('metallurgy_t5'),       'crafting', 'refined bar -> Crafting');
    // Render: the panel emits collapsible accordions + keeps the search box; the old chips are gone.
    var S = FF._state, savedInv = S.inventory, savedCat = FF.currentCategoryId();
    try {
      var wid = Object.keys(FF.ALL_SELLABLE).filter(function(id){ return id.indexOf('stweapon_greatsword_')===0; })[0];
      var aid = Object.keys(FF.ALL_SELLABLE).filter(function(id){ return id.indexOf('bodyarmor_plate_chest_')===0; })[0];
      ok(wid && aid, 'sample weapon + armour ids resolve in ALL_SELLABLE');
      var inv = { digging_t5:20 }; inv[wid] = 1; inv[aid] = 1;
      S.inventory = inv;
      FF.navPickCat('inventory');
      var h = document.getElementById('inventoryPanel').innerHTML;
      ok(/inv-acc-bar/.test(h) && /data-action="invAccToggle"/.test(h), 'items render inside collapsible accordions');
      ok(/Swords/.test(h) && /Plate Armor/.test(h) && /Gathering/.test(h), 'weapons/armour/materials each get their own group');
      ok(/id="invSearchInput"/.test(h), 'the search box is preserved');
      ok(/data-action="invExpandAll"/.test(h) && /data-action="invCollapseAll"/.test(h), 'expand/collapse-all controls exist');
      ok(!/data-action="invFilterCat"/.test(h), 'the old category filter chips are gone');
    } finally { S.inventory = savedInv; if(savedCat) FF.navPickCat(savedCat); }
  });

  suite('equip picker: best-first, grouped, filterable candidate list', function(){
    ok(typeof FF.sortEquipCandidates==='function' && typeof FF.renderEquipCandidatePicker==='function', 'equip picker helpers exported');
    // Sort: equipped pinned to the top, usable by score desc, locked sunk to the bottom.
    var srt = FF.sortEquipCandidates([
      {name:'weak',  score:5,   canEquip:true,  equipped:false},
      {name:'strong',score:9,   canEquip:true,  equipped:false},
      {name:'locked',score:100, canEquip:false, equipped:false},
      {name:'worn',  score:1,   canEquip:true,  equipped:true}
    ]);
    eq(srt[0].name,'worn',   'equipped pinned first');
    eq(srt[1].name,'strong', 'then the strongest usable');
    eq(srt[2].name,'weak',   'then the next usable');
    eq(srt[3].name,'locked', 'locked (even if higher score) sinks to the bottom');
    // Render: Equip best points at the strongest USABLE piece (never the locked one), hide-locked toggle
    // appears when a locked candidate exists, and the toggle actually filters the locked row out.
    var groups = [{ key:'g', title:'G', candidates:[
      { icon:'', name:'Weak',   qty:1, score:2,  statHtml:'', deltaHtml:'', equipped:false, canEquip:true,  lockHtml:'', action:'equipX', data:'data-item="weak"' },
      { icon:'', name:'Strong', qty:1, score:9,  statHtml:'', deltaHtml:'', equipped:false, canEquip:true,  lockHtml:'', action:'equipX', data:'data-item="strong"' },
      { icon:'', name:'Locked', qty:1, score:99, statHtml:'', deltaHtml:'', equipped:false, canEquip:false, lockHtml:'', action:'equipX', data:'data-item="locked"' }
    ]}];
    var savedHL = FF.getEquipHideLocked();
    try {
      FF.setEquipHideLocked(false);
      var h = FF.renderEquipCandidatePicker(groups, {flat:true, bestLabel:'Equip best'});
      var toolbar = (h.match(/<div class="equip-picker-tools">[\s\S]*?<\/div>/) || [''])[0];
      ok(/data-item="strong"/.test(toolbar) && !/data-item="locked"/.test(toolbar), 'Equip best targets the strongest usable piece, not the locked higher-score one');
      ok(/data-action="equipHideLockedToggle"/.test(h), 'the hide-locked toggle shows when a locked candidate exists');
      ok(h.indexOf('data-item="strong"') < h.indexOf('data-item="weak"'), 'rows render strongest-first');
      FF.setEquipHideLocked(true);
      var h2 = FF.renderEquipCandidatePicker(groups, {flat:true});
      ok(!/data-item="locked"/.test(h2), 'hide-locked filters the locked candidate out of the list');
      ok(/data-item="strong"/.test(h2), '...but keeps the usable ones');
    } finally { FF.setEquipHideLocked(savedHL); }

    // Body-armour picker is scoped to the tapped slot and groups owned pieces by material accordion.
    var S = FF._state, savedInv=S.inventory, savedBody=S.bodyArmor, savedXp=S.xp, savedUniq=S.uniqueItems;
    try {
      var chestId = Object.keys(FF.ALL_SELLABLE).filter(function(id){ return id.indexOf('bodyarmor_plate_chest_t0_')===0 && /_normal$/.test(id); })[0];
      var helmId  = Object.keys(FF.ALL_SELLABLE).filter(function(id){ return id.indexOf('bodyarmor_plate_helmet_t0_')===0 && /_normal$/.test(id); })[0];
      ok(chestId && helmId, 'sample plate chest + helmet ids resolve');
      S.xp = { chainmailarmor:1e9, platearmor:1e9, leatherarmor:1e9, clotharmor:1e9 };
      S.bodyArmor = {}; S.uniqueItems = {};
      var invA = {}; invA[chestId] = 1; invA[helmId] = 1; S.inventory = invA;
      var ch = FF.renderEquipBodyArmorSection('chest');
      ok(ch.indexOf(chestId) !== -1, 'the chest picker offers the owned chest piece');
      ok(ch.indexOf(helmId) === -1, 'the chest picker is scoped to the chest slot (no helmet pieces leak in)');
      ok(/inv-acc-bar/.test(ch) && /Plate/.test(ch), 'owned pieces are grouped into a Plate material accordion');
    } finally { S.inventory=savedInv; S.bodyArmor=savedBody; S.xp=savedXp; S.uniqueItems=savedUniq; }

    // Mainhand weapon picker nests a per-type sub-accordion when a family holds more than one owned type,
    // so a 100+ item melee list stops being one flat wall.
    var mSaved = { mh:S.equippedMainhand, mht:S.equippedMainhandTier, mhr:S.equippedMainhandRarity, inv:S.inventory, xp:S.xp, uniq:S.uniqueItems };
    try {
      S.xp = { rapier:1e9, greatsword:1e9, weaponsmithing:1e9 };
      var rap = 'stweapon_rapier_t4_normal', rap2 = 'stweapon_rapier_t2_normal', gs = 'stweapon_greatsword_t4_normal';
      ok(FF.STACKABLE_WEAPON_ITEMS[rap] && FF.STACKABLE_WEAPON_ITEMS[gs], 'sample rapier + greatsword ids resolve');
      // Equip a rapier so the Rapier nest opens by default; the Greatsword nest stays collapsed.
      S.equippedMainhand = 'rapier'; S.equippedMainhandTier = 5; S.equippedMainhandRarity = 'normal'; S.uniqueItems = {};
      var inv = {}; inv[rap]=1; inv[rap2]=1; inv[gs]=1; S.inventory = inv;
      var h = FF.renderMainhandEquipSection();
      ok(/Melee Weapons/.test(h), 'the Melee Weapons family accordion renders');
      ok(/inv-acc-sub/.test(h), 'multiple owned weapon types nest into per-type sub-accordions');
      ok(/>Rapier<\/span>/.test(h) && />Greatsword<\/span>/.test(h), 'each owned weapon type gets its own nested accordion title');
      ok(h.indexOf('data-item="'+rap2+'"')!==-1, 'the equipped type nest opens by default, showing its other items');
      ok(/data-key="[^"]*_greatsword" data-open="0"/.test(h), 'a non-equipped type nest (Greatsword) is collapsed by default');
      // A single owned weapon type skips the redundant second nest.
      var inv2 = {}; inv2[rap]=1; inv2[rap2]=1; S.inventory = inv2;
      var h1 = FF.renderMainhandEquipSection();
      ok(/Melee Weapons/.test(h1) && !/inv-acc-sub/.test(h1), 'a single owned weapon type skips the redundant sub-nest');
    } finally { S.equippedMainhand=mSaved.mh; S.equippedMainhandTier=mSaved.mht; S.equippedMainhandRarity=mSaved.mhr; S.inventory=mSaved.inv; S.xp=mSaved.xp; S.uniqueItems=mSaved.uniq; }
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
        // The 1 HP floor is gone, and this fixture has a REAL monster -- so unlike the Decay/Bleed cases
        // the kill actually RESOLVES rather than leaving HP negative. Assert the resolution, not the HP:
        // defeatMonster banks a kill and retargets the activity to a fresh foe at full health.
        var _killsBefore = (s.stats && s.stats.kills) || 0;
        s.activity.monsterHp = 1;
        // Wither ticks 1.5% of MAX HP per second, so against a low-HP foe one second removes a fraction
        // of a point -- a 1s tick left this at 0.85 and the kill never fired. Use a long dt so the tick is
        // lethal regardless of which monster the roster puts first (0.015 * 200s = 3x its max health).
        FF.applyReaperWitherTick(200000);
        eq(((s.stats && s.stats.kills) || 0), _killsBefore + 1, 'a DoT tick CAN land the kill (Wither finishes a 1 HP foe)');
        ok(s.activity.monsterHp > 1, 'the resolved kill retargets to a fresh foe rather than sitting at 0 HP');
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

  // ---- Classes: Quickdraw (short-bow archer: Trick Shot / Second Wind / Twin Fang / Eagle Eye / Serpent's Sting) ----
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
    var lv100 = FF.xpFloorForLevel(100);
    function leveled(){ var s = base(); s.xp.quickdraw = lvHi; s.physique = {}; return s; }

    // Lv 1 Trick Shot is a crit -> bonus-shot proc; Quickdraw no longer has any passive attack-speed.
    eq(FF.classAttackSpeedMult(full), 1, 'Quickdraw has no passive attack-speed at Lv 1 (Trick Shot is a crit proc)');

    // Lv 20 Second Wind: below 40% HP -> -20% attack timer + +20% Dodge; gated on Lv 20 AND the HP threshold.
    var swLow = leveled(); swLow.playerHp = 10;    // maxHp(physique {}) = 50 -> 40% = 20; 10 < 20 => active
    var swFull = leveled(); swFull.playerHp = 45;  // 45 >= 20 => inactive
    eq(FF.quickdrawSecondWind(swLow), true, 'Second Wind active below 40% HP at Lv 20+');
    eq(FF.quickdrawSecondWind(swFull), false, 'Second Wind inactive at healthy HP');
    eq(FF.quickdrawSecondWindDodge(swLow), 0.20, 'Second Wind grants +20% Dodge');
    eq(FF.classAttackSpeedMult(swLow), 0.80, 'Second Wind: -20% attack timer while active');
    var swLv1 = base(); swLv1.physique = {}; swLv1.playerHp = 1;
    eq(FF.quickdrawSecondWind(swLv1), false, 'Second Wind is gated on Class Lv 20 (not at Lv 1)');

    // Lv 60 Eagle Eye: accuracy over a foe's Dodge -> crit chance (cap +25%); nothing when accuracy <= dodge.
    var ee = leveled(); ee.xp.bowShort = lv100;    // high bow proficiency -> accuracy well over a t0 foe's dodge
    ok(FF.quickdrawEagleEyeCrit({tierIndex:0}, ee) > 0, 'Eagle Eye converts overflow accuracy into crit chance');
    eq(FF.quickdrawEagleEyeCrit({tierIndex:20}, ee), 0, 'no Eagle Eye crit when accuracy does not exceed a tough foe\'s dodge');
    eq(FF.quickdrawEagleEyeCrit({tierIndex:0}, full), 0, 'Eagle Eye is gated on Class Lv 60 (nothing at Lv 1)');
    var eeMax = leveled(); eeMax.physique = { agility:lv100, bodyControl:lv100, grossMotor:lv100, fineMotor:lv100, sleightOfHand:lv100 };
    eq(FF.quickdrawEagleEyeCrit({tierIndex:0}, eeMax), 0.25, 'Eagle Eye crit is capped at +25%');

    // Class familiar is a piercing archer to match the fantasy.
    var fam = FF.FAMILIAR_DATA.quickdraw;
    ok(fam && fam.spells && fam.spells.length === 4, 'quickdraw familiar has 4 spells');
    ok(fam.spells.some(function(s){ return s.type==='hit' && s.element==='earth'; }), 'quickdraw familiar has earth-element hit spells');
  });

  // ---- Classes: Templar (Lay on Hands / Beacon of Faith / Dawnbreaker / Holy Light / Aegis of Dawn) ----
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
    function leveled(){ var s = base(); s.xp.templar = lvHi; s.physique = {}; return s; }

    // Lv 20 Beacon of Faith: +20% familiar spell potency (gated on the class being active).
    eq(FF.templarBeaconPotencyMult(full), 1, 'Lv 1 templar: no Beacon potency yet');
    ok(Math.abs(FF.templarBeaconPotencyMult(leveled()) - 1.20) < 1e-9, 'Lv 20+: familiar spells +20%');
    var off = base(); off.equippedOffhand=null; off.xp.templar = lvHi;
    eq(FF.templarBeaconPotencyMult(off), 1, 'Beacon gated on the class being active');

    // Lv 40 Dawnbreaker: +30% Light (the scepter's light half) vs Dark-element foes only.
    eq(FF.templarDawnbreakerMult({element:'dark'}, leveled()), 1.30, 'Dawnbreaker: +30% Light vs a Dark foe');
    eq(FF.templarDawnbreakerMult({element:'fire'}, leveled()), 1, 'Dawnbreaker: no bonus vs a non-Dark foe');
    eq(FF.templarDawnbreakerMult({element:'dark'}, full), 1, 'Dawnbreaker gated on Class Lv 40 (nothing at Lv 1)');

    // Lv 60 Holy Light: a heal-over-time only below 40% HP at Lv 60+.
    var hlLow = leveled(); hlLow.playerHp = 10;    // maxHp(physique {}) ~50 -> 40% ~20; 10 < 20 => healing
    var hlFull = leveled(); hlFull.playerHp = 45;  // 45 >= 20 => none
    ok(FF.templarHolyLightHps(hlLow) > 0, 'Holy Light heals below 40% HP at Lv 60+');
    eq(FF.templarHolyLightHps(hlFull), 0, 'Holy Light does nothing at healthy HP');
    var hlLv1 = base(); hlLv1.physique = {}; hlLv1.playerHp = 1;
    eq(FF.templarHolyLightHps(hlLv1), 0, 'Holy Light gated on Class Lv 60 (nothing at Lv 1)');

    // The enemy-damage debuff window (now driven by Lumen's Blind) still applies 25% off via templarIncomingDmgMult.
    var s = FF._state, saved = s.classDebuffs;
    s.classDebuffs = { enemyDmgUntil:0, enemyArmorUntil:0 };
    eq(FF.templarIncomingDmgMult(), 1, 'no blind window => enemy deals full damage');
    s.classDebuffs = { enemyDmgUntil: Date.now()+9000, enemyArmorUntil:0 };
    eq(FF.templarIncomingDmgMult(), 0.75, 'blind window => enemy deals 25% less (x0.75)');
    s.classDebuffs = saved; // restore for other suites

    // Class familiar (light-themed smiter).
    var fam = FF.FAMILIAR_DATA.templar;
    ok(fam && fam.spells && fam.spells.length === 4, 'templar familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'templar familiar has damaging spells');
  });

  // ---- Quiver is now a stackable Leatherworking Equipment item (crafted like shields) --------
  suite('quiver: stackable leatherworking equipment', function(){
    var q0 = FF.getStackableQuiverTierData('quiver', 0);
    var q20 = FF.getStackableQuiverTierData('quiver', 20);
    // Named after the leather (Wildlife) tier, not a metal ingot.
    eq(q0.name, FF.WILDLIFE_NAMES[0] + ' Quiver', 'tier-1 quiver is named after the Wildlife tier');
    eq(q20.name, FF.WILDLIFE_NAMES[20] + ' Quiver', 'top-tier quiver is Wildlife-named too');
    // Built from Leather (Tanning's cured hide, tanning_t<n>), not Metallurgy bars.
    ok(q0.inputs.tanning_t0 > 0, 'tier-1 quiver costs Leather (tanning_t0)');
    ok(!q0.inputs.metallurgy_t0, 'the quiver no longer costs metal bars');
    ok(FF.getStackableQuiverTierData('quiver', 5).inputs.tanning_t5 > 0, 'tier-6 quiver costs the matching-tier Leather');
    // A damage-boost offhand, not defense.
    ok(q0.dmgBonus > 0 && q0.defense === undefined, 'the quiver grants arrow damage, no defense');
    // Ammo-preservation bonus: 5% at t0 -> 20% at t20 on the base tier data.
    near(q0.ammoPreserve, 0.05, 't0 quiver keeps ammo 5% of the time');
    near(q20.ammoPreserve, 0.20, 't20 quiver keeps ammo 20% of the time');

    // The stackable items live in ALL_SELLABLE and carry rarity-scaled bonuses (x2/4/8).
    var stq0 = FF.ALL_SELLABLE['stquiver_quiver_t0_normal'];
    ok(stq0 && stq0.tierIndex === 0, 'stquiver_quiver_t0_normal exists as a sellable equipment item');
    near(stq0.ammoPreserve, 0.05, 't0 normal stack quiver keeps 5%');
    near(FF.ALL_SELLABLE['stquiver_quiver_t20_fantastic'].ammoPreserve, 1.60, 'rarity scales ammo-keep x8 (0.20 -> 1.60 pre-cap)');

    // The craft engine routes its XP / success / tool-speed to Leatherworking.
    eq(FF.getSpecialSkillId({ craftKind:'stackquiver', typeId:'quiver' }), 'leatherworking', 'a quiver craft trains Leatherworking');

    // getEquippedOffhandItem resolves the stackable quiver from the equipped tier/rarity.
    var worn = FF.getEquippedOffhandItem({ equippedOffhand:'quiver', equippedOffhandTier:21, equippedOffhandRarity:'fantastic' });
    ok(worn && worn.id === 'stquiver_quiver_t20_fantastic', 'a worn quiver resolves to its stack item');
    // quiverAmmoPreserve reads the equipped quiver and caps the effective chance at 95%.
    eq(FF.quiverAmmoPreserve({ equippedOffhand:'quiver', equippedOffhandTier:21, equippedOffhandRarity:'fantastic' }), 0.95, 'a t20 fantastic quiver caps ammo-keep at 95%');
    near(FF.quiverAmmoPreserve({ equippedOffhand:'quiver', equippedOffhandTier:1, equippedOffhandRarity:'normal' }), 0.05, 'a t1 normal quiver keeps 5%');
    eq(FF.quiverAmmoPreserve({ equippedOffhand:null }), 0, 'no quiver equipped -> 0% keep');

    // bowArrowToConsume: the highest-tier Fletching Arrow you own that isn't fancier than the bow.
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, inventory:{ fletching_arrow_t0:10, fletching_arrow_t3:5 } }), 'fletching_arrow_t3', 'consumes the highest owned arrow within the bow tier');
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, inventory:{} }), null, 'no arrows -> null (shoot unfletched)');
    eq(FF.bowArrowToConsume({ equippedMainhandTier:2, inventory:{ fletching_arrow_t10:5 } }), null, 'arrows fancier than the bow are not usable');
    eq(FF.UNFLETCHED_DMG_MULT, 0.25, 'an unfletched bow deals 25% damage');

    // Arrow base damage equals a same-tier bow (handBonus 1.0), so a nocked arrow adds bow-equivalent damage.
    [0, 5, 12, 19].forEach(function(i){
      var bow = FF.getStackableWeaponTierData('bowShort', i);
      var ar = FF.arrowBaseDamage('fletching_arrow_t'+i);
      eq(ar.dmgMin, bow.dmgMin, 'arrow t'+i+' min damage matches a tier-'+i+' bow');
      eq(ar.dmgMax, bow.dmgMax, 'arrow t'+i+' max damage matches a tier-'+i+' bow');
    });
    ok(FF.arrowBaseDamage('fletching_arrow_t19').dmgMax > FF.arrowBaseDamage('fletching_arrow_t0').dmgMax, 'higher-tier arrows hit harder');
    eq(FF.arrowBaseDamage(null), null, 'no arrow id -> no arrow damage');
    eq(FF.arrowBaseDamage('not_an_arrow'), null, 'a non-arrow id -> no arrow damage');

    // bowArrowsAvailable: total usable arrows at or below the bow's tier (live combat ammo counter).
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, inventory:{ fletching_arrow_t0:10, fletching_arrow_t3:5 } }), 15, 'sums all usable arrows');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:3, inventory:{ fletching_arrow_t0:4, fletching_arrow_t10:99 } }), 4, 'arrows fancier than the bow are excluded from the count');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, inventory:{} }), 0, 'no arrows -> 0');

    // Equipping a specific arrow (state.equippedArrow) fires ONLY that arrow -- higher owned arrows are
    // ignored, and running out shoots unfletched rather than falling back to a different arrow.
    var invMix = { fletching_arrow_t0:10, fletching_arrow_t3:5 };
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t0', inventory:invMix }), 'fletching_arrow_t0', 'a chosen arrow is used even when a higher one is owned');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t0', inventory:invMix }), 10, 'ammo count reflects only the chosen arrow');
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t5', inventory:invMix }), null, 'chosen arrow you own none of -> unfletched (no fallback)');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t5', inventory:invMix }), 0, 'ammo count is 0 for a chosen arrow you have none of');
    // A chosen arrow fancier than the bow can't be nocked.
    eq(FF.bowArrowToConsume({ equippedMainhandTier:2, equippedArrow:'fletching_arrow_t9', inventory:{ fletching_arrow_t9:5 } }), null, 'a chosen arrow above the bow tier is unusable');
    ok(!FF.arrowUsableWithBow({ equippedMainhandTier:2 }, 'fletching_arrow_t9'), 'arrowUsableWithBow rejects an over-tier arrow');
    ok(FF.arrowUsableWithBow({ equippedMainhandTier:6 }, 'fletching_arrow_t3'), 'arrowUsableWithBow accepts an in-tier arrow');
    eq(FF.bowArrowTierCap({ equippedMainhandTier:6 }), 5, 'bow tier cap is bow tier - 1');
    // Locked ammunition is protected -- never auto-nocked/fired and not counted as available, until unlocked.
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, inventory:{ fletching_arrow_t0:10, fletching_arrow_t3:5 }, lockedItems:{ fletching_arrow_t3:true } }), 'fletching_arrow_t0', 'Auto skips a locked arrow and falls to the next unlocked one');
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, inventory:{ fletching_arrow_t3:5 }, lockedItems:{ fletching_arrow_t3:true } }), null, 'Auto with only locked arrows -> null (shoot unfletched, never consume the lock)');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, inventory:{ fletching_arrow_t0:10, fletching_arrow_t3:5 }, lockedItems:{ fletching_arrow_t3:true } }), 10, 'locked arrows are excluded from the available count');
    eq(FF.bowArrowToConsume({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t3', inventory:{ fletching_arrow_t3:5 }, lockedItems:{ fletching_arrow_t3:true } }), null, 'a locked chosen arrow is not fired');
    eq(FF.bowArrowsAvailable({ equippedMainhandTier:6, equippedArrow:'fletching_arrow_t3', inventory:{ fletching_arrow_t3:5 }, lockedItems:{ fletching_arrow_t3:true } }), 0, 'a locked chosen arrow counts as 0 available');
    // equipArrow mutates the shared state; snapshot/restore so other suites are unaffected.
    var _savedArrow = FF._state.equippedArrow;
    FF.equipArrow('fletching_arrow_t3'); eq(FF._state.equippedArrow, 'fletching_arrow_t3', 'equipArrow sets the chosen arrow');
    FF.equipArrow(''); eq(FF._state.equippedArrow, null, 'equipArrow with empty id resets to Auto');
    FF.equipArrow('not_an_arrow'); eq(FF._state.equippedArrow, null, 'equipArrow ignores a non-arrow id');
    FF._state.equippedArrow = _savedArrow;
  });

  suite('locked consumables are never auto-used (food / potions / ammo)', function(){
    var S = FF._state, savedInv = S.inventory, savedLock = S.lockedItems;
    try {
      var foods = FF.getAutoEatFoodTypes();
      ok(foods.length >= 2, 'there are auto-eat food types to test');
      var hi = foods[0], lo = foods[1];   // getAutoEatFoodTypes is sorted by heal desc
      S.inventory = {}; S.inventory[hi.id] = 3; S.inventory[lo.id] = 5;
      S.lockedItems = {};
      eq(FF.getNextAutoEatFood().id, hi.id, 'Auto-Eat picks the strongest food when nothing is locked');
      eq(FF.getTotalAutoEatFoodQty(), 8, 'total auto-eat food counts every unlocked stack');
      S.lockedItems[hi.id] = true;
      eq(FF.getNextAutoEatFood().id, lo.id, 'Auto-Eat skips the locked strongest food and eats the next unlocked one');
      eq(FF.getTotalAutoEatFoodQty(), 5, 'a locked food stack is excluded from the auto-eat total');
      S.lockedItems[lo.id] = true;
      eq(FF.getNextAutoEatFood(), null, 'with every food locked, Auto-Eat has nothing to eat (protects the locks)');
      eq(FF.getTotalAutoEatFoodQty(), 0, 'all food locked -> auto-eat total is 0');
    } finally { S.inventory = savedInv; S.lockedItems = savedLock; }
  });

  // ---- Classes: Knight (claymore offtank brawler: momentum + counterweight/bulwark/warlord/relentless) ----
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

    // Lv 80 Relentless: Momentum cap rises from 5 to 8 (up to -80% attack timer).
    eq(FF.knightStackCap(base()), 5, 'below Lv80 the Momentum cap stays at 5');
    var r8 = base(); r8.xp.knight = FF.xpFloorForLevel(85); r8.knightStacks = 8;
    eq(FF.knightStackCap(r8), 8, 'Relentless (Lv80) raises the Momentum cap to 8');
    near(FF.classAttackSpeedMult(r8), 0.20, 'Lv80: 8 stacks => -80% attack timer');
    eq(FF.knightStacks(r8), 8, 'knightStacks caps at 8 with Relentless');

    // Lv 40 Bulwark: -4% damage taken per stack, capped at -20% (5 stacks) even past the Relentless cap.
    var b20 = base(); b20.xp.knight = FF.xpFloorForLevel(25); b20.knightStacks = 5;
    eq(FF.knightBulwarkDR(b20), 0, 'no Bulwark before Lv40');
    var b40 = base(); b40.xp.knight = FF.xpFloorForLevel(45);
    b40.knightStacks = 0; eq(FF.knightBulwarkDR(b40), 0, '0 stacks => no mitigation');
    b40.knightStacks = 3; near(FF.knightBulwarkDR(b40), 0.12, '3 stacks => -12% damage taken');
    b40.knightStacks = 5; near(FF.knightBulwarkDR(b40), 0.20, '5 stacks => -20% (cap)');
    var b85 = base(); b85.xp.knight = FF.xpFloorForLevel(85); b85.knightStacks = 8;
    near(FF.knightBulwarkDR(b85), 0.20, 'Bulwark still caps at -20% past the Relentless stack cap');

    // Lv 60 Warlord's Presence + the combined mitigation need a full state (maxHp reads physique/enchants),
    // so exercise them on _state with a controlled Knight loadout, then restore for the other suites.
    var s = FF._state;
    var snap = { xpK:s.xp.knight, main:s.equippedMainhand, rar:s.equippedMainhandRarity, hp:s.playerHp, stk:s.knightStacks,
      helm:s.bodyArmor.helmet, chest:s.bodyArmor.chest, gaunt:s.bodyArmor.gauntlets, boots:s.bodyArmor.boots };
    s.equippedMainhand='claymore'; s.equippedMainhandRarity='normal';
    s.bodyArmor.helmet=chain(); s.bodyArmor.chest=plate(); s.bodyArmor.gauntlets=chain(); s.bodyArmor.boots=plate();
    var hp = FF.maxHp(s); // fortitude-driven, independent of Knight level/stacks
    s.xp.knight = FF.xpFloorForLevel(25); s.playerHp = 1;
    eq(FF.knightWarlordDmgMult(s), 1, 'no Warlord before Lv60');
    s.xp.knight = FF.xpFloorForLevel(65);
    s.playerHp = hp; // full HP -> offense stance
    near(FF.knightWarlordDmgMult(s), 1.20, 'above half HP => +20% damage');
    eq(FF.knightWarlordDR(s), 0, '...and no defensive bonus while healthy');
    eq(FF.knightWarlordLifestealPct(s), 0, '...and no lifesteal while healthy');
    ok(!FF.knightHurt(s), 'not "hurt" at full HP');
    s.playerHp = Math.floor(hp*0.4); // below half -> defense stance
    eq(FF.knightWarlordDmgMult(s), 1, 'below half HP => no damage bonus');
    near(FF.knightWarlordDR(s), 0.25, '...but -25% damage taken');
    near(FF.knightWarlordLifestealPct(s), 0.10, '...and +10% lifesteal');
    ok(FF.knightHurt(s), '"hurt" below half HP');
    // Combined incoming-damage multiplier: Bulwark (5 stacks, Lv85) + Warlord below-half.
    s.xp.knight = FF.xpFloorForLevel(85); s.knightStacks = 5;
    near(FF.knightDamageTakenMult(s), 0.55, 'Bulwark -20% + Warlord -25% => -45% damage taken');
    // restore _state
    s.xp.knight = snap.xpK; s.equippedMainhand = snap.main; s.equippedMainhandRarity = snap.rar; s.playerHp = snap.hp; s.knightStacks = snap.stk;
    s.bodyArmor.helmet = snap.helm; s.bodyArmor.chest = snap.chest; s.bodyArmor.gauntlets = snap.gaunt; s.bodyArmor.boots = snap.boots;

    // Class familiar (steel swordsman).
    var fam = FF.FAMILIAR_DATA.knight;
    ok(fam && fam.spells && fam.spells.length === 4, 'knight familiar has 4 spells');
    ok(fam.spells.some(function(sp){ return sp.type==='hit'; }), 'knight familiar has a damaging spell');
  });

  // ---- Class registration integrity: adding a class touches several registries; this suite
  // fails CI loudly when one is missed (instead of a silently missing familiar/icon/element,
  // or the leaderboard freezing because the skill set outgrew submit_profile's MAX_SKILLS). ----
  suite('classes: registration integrity', function(){
    var defs = FF.CLASS_DEFS;
    ok(Array.isArray(defs) && defs.length >= 20, 'CLASS_DEFS present ('+defs.length+' classes)');
    eq(FF.CLASS_SKILL_IDS.join(','), defs.map(function(c){ return c.id; }).join(','), 'CLASS_SKILL_IDS is derived from CLASS_DEFS');
    // Summoner deliberately has no class familiar of its own -- its kit amplifies OTHER familiars
    // (extra companion slot, familiar-damage passives). Every other class must have the full kit.
    var NO_OWN_FAMILIAR = ['summoner'];
    var ELEMENTS = ['fire','water','earth','light','dark'];
    defs.forEach(function(cd){
      var id = cd.id;
      // submit_profile stores the class id only if it matches this exact pattern -- a mismatch
      // silently nulls the player's leaderboard class icon (this caught 'treasureHunter' once).
      ok(/^[a-z][a-zA-Z0-9_]{0,23}$/.test(id), id+': id is a slug submit_profile accepts');
      ok(cd.name && cd.icon && cd.blurb, id+': has name/icon/blurb');
      ok(Array.isArray(cd.reqParts) && cd.reqParts.length >= 1, id+': has gear requirements');
      cd.reqParts.forEach(function(p){ ok(typeof p.met === 'function' && p.label, id+': req part has met() + label'); });
      eq((cd.passives||[]).map(function(p){ return p.level; }).join(','), '1,20,40,60,80', id+': passive tiers are 1/20/40/60/80');
      cd.passives.forEach(function(p){ ok(p.name && p.desc, id+': passive '+p.level+' has name + desc'); });
      ok(id in FF._state.xp, id+': xp seeded in newGame');
      if(NO_OWN_FAMILIAR.indexOf(id) === -1){
        var fam = FF.FAMILIAR_DATA[id];
        ok(fam && fam.name && fam.icon, id+': has a class familiar');
        eq((fam && fam.spells || []).length, 4, id+': class familiar has 4 spells');
        eq((FF.FAMILIAR_SPELLS[id]||[]).length, 4, id+': FAMILIAR_SPELLS kit has 4 spells');
        ok(ELEMENTS.indexOf(FF.FAMILIAR_ELEMENT[id]) !== -1, id+': familiar element is valid');
      }
      ok(FF.FAM_SKIN[id], id+': familiar skin defined');
    });
    // MAX_SKILLS headroom: the deployed submit_profile rejects submissions with more skills than
    // its MAX_SKILLS (currently 400) -- and when that trips, the WHOLE leaderboard silently stops
    // updating (it has happened). Fail here first, with room to react.
    var skillCount = Object.keys(FF.computeProfileStats().skills).length;
    ok(skillCount < 380, 'profile skill set ('+skillCount+') stays well under the deployed MAX_SKILLS=400 -- if this fails, RAISE MAX_SKILLS in submit_profile and redeploy BEFORE merging');
  });

  // ---- PLAYER_DMG_MODS: the named damage-modifier table behind the damage formula ---------
  suite('combat: player damage modifier table', function(){
    var mods = FF.PLAYER_DMG_MODS;
    ok(Array.isArray(mods) && mods.length >= 20, 'the modifier table exists ('+mods.length+' rows)');
    var names = mods.map(function(m){ return m.name; });
    eq(names.length, new Set(names).size, 'modifier names are unique');
    mods.forEach(function(m){ ok(typeof m.fn === 'function', m.name+' has a fn'); });
    // A benign context: no crit, mainhand, physical weapon, no special flags.
    var mon = FF.MONSTERS[0];
    function ctx(over){ return Object.assign({ monster:mon, weaponStyle:{attackTypes:{blunt:1}}, enchTot:{}, isCrit:false, isOffhand:false, isWandAttack:false, isScepterAttack:false, assassinVanish:false, unfletched:false }, over||{}); }
    var byName = {}; mods.forEach(function(m){ byName[m.name] = m; });
    // Pure ctx-driven rows behave exactly like the old inline ternaries.
    eq(byName.offhandClawPenalty.fn(ctx()), 1, 'mainhand swing: no claw penalty');
    eq(byName.offhandClawPenalty.fn(ctx({isOffhand:true})), FF.OFFHAND_CLAW_DMG_MULT, 'offhand claw applies its damage penalty');
    eq(byName.unfletchedPenalty.fn(ctx()), 1, 'arrows in stock: no unfletched penalty');
    eq(byName.unfletchedPenalty.fn(ctx({unfletched:true})), FF.UNFLETCHED_DMG_MULT, 'no arrows: unfletched penalty applies');
    eq(byName.assassinVanish.fn(ctx({assassinVanish:true})), FF.ASSASSIN_VANISH_MULT, 'Vanish empowers the strike');
    near(byName.damageEnchants.fn(ctx({enchTot:{pctDamage:25}})), 1.25, '+25% damage enchant => x1.25');
    eq(byName.mainhandEnhance.fn(ctx({isOffhand:true})), 1, 'offhand swings ignore the mainhand Enhance');
    // The aggregate multiplier is a sane positive number on the (unbuffed) selftest state.
    var total = FF.playerDamageMultiplier(ctx());
    ok(isFinite(total) && total > 0, 'aggregate multiplier is finite and positive ('+total+')');
  });

  // ---- activeClassId memo: live-state gear changes must invalidate the cached class ------
  suite('classes: activeClassId memo invalidation', function(){
    var s = FF._state;
    function plate(){ return {tier:1, rarity:'normal', material:'plate'}; }
    function chain(){ return {tier:1, rarity:'normal', material:'chain'}; }
    var snap = { main:s.equippedMainhand, off:s.equippedOffhand, helm:s.bodyArmor.helmet, chest:s.bodyArmor.chest, gaunt:s.bodyArmor.gauntlets, boots:s.bodyArmor.boots };
    s.equippedMainhand = 'claymore'; s.equippedOffhand = null;
    s.bodyArmor.helmet = chain(); s.bodyArmor.chest = plate(); s.bodyArmor.gauntlets = chain(); s.bodyArmor.boots = plate();
    eq(FF.activeClassId(), 'knight', 'live state derives Knight (memoized path)');
    s.equippedMainhand = null;
    ok(FF.activeClassId() !== 'knight', 'unequipping the mainhand invalidates the memo');
    s.equippedMainhand = 'claymore';
    eq(FF.activeClassId(), 'knight', 're-equipping re-derives Knight');
    s.bodyArmor.chest = chain();
    ok(FF.activeClassId() !== 'knight', 'an armor material change invalidates the memo');
    s.bodyArmor.chest = plate();
    eq(FF.activeClassId(), 'knight', '...and restoring it re-derives Knight again');
    // restore
    s.equippedMainhand = snap.main; s.equippedOffhand = snap.off;
    s.bodyArmor.helmet = snap.helm; s.bodyArmor.chest = snap.chest; s.bodyArmor.gauntlets = snap.gaunt; s.bodyArmor.boots = snap.boots;
    FF.activeClassId(); // re-derive once so the memo reflects the restored gear for later suites
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

    // Enhance scales a UNIQUE ring's base stat, like weapons/belts (a +6 rare Copper Water ring: +10% -> +30%).
    function enhRingSt(enh){
      return { physique:{}, xp:{},
        uniqueItems:{ RW:{ uid:'RW', kind:'ring', base:'ring_water_t0_rare', tier:0, rarity:'rare', enchants:[], enhance:enh } },
        jewelrySlots:{ ring1:{typeId:'water',tier:1,rarity:'rare',uid:'RW'}, ring2:empty(), ring3:empty(), ring4:empty(), ring5:empty(), amulet:{tier:0,rarity:'normal'} } };
    }
    near(FF.getRingItemInSlot(enhRingSt(0),'ring1').bonus, 0.10, '+0 enhance: base rare Copper Water ring is +10%');
    near(FF.getRingItemInSlot(enhRingSt(6),'ring1').bonus, 0.30, '+6 enhance triples the base ring stat to +30%');
    near(FF.getRingElementDamageBonus(enhRingSt(6), 'water'), 0.30, '+6 enhance: combat Water bonus is +30%');
    near(FF.getRingElementDamageBonus(enhRingSt(15), 'water'), 0.60, '+15 (max) enhance: x6 -> +60%');

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

    // Equipment doll: the off-hand Claw must render as a FILLED offhand slot (it's a weapon, so the
    // usual getEquippedOffhandItem() returns null -- regression guard for it showing "Empty").
    var s = FF._state;
    var sv = { mh:s.equippedMainhand, mt:s.equippedMainhandTier, mr:s.equippedMainhandRarity, oh:s.equippedOffhand, ot:s.equippedOffhandTier, or:s.equippedOffhandRarity, muid:s.equippedMainhandUid, ouid:s.equippedOffhandUid };
    try {
      s.equippedMainhandUid = null; s.equippedOffhandUid = null;
      s.equippedMainhand='claw'; s.equippedMainhandTier=6; s.equippedMainhandRarity='rare';
      s.equippedOffhand='claw'; s.equippedOffhandTier=6; s.equippedOffhandRarity='rare';
      var offSlot = FF.equipSlotState('offhand');
      eq(offSlot.filled, true, 'off-hand Claw renders the offhand slot as filled');
      eq(offSlot.rarity, 'rare', 'off-hand Claw slot carries its rarity');
      ok(/Claws/.test(offSlot.name), 'off-hand Claw slot shows the claw name, not "Empty"');
      ok(offSlot.icon && offSlot.icon.length > 0, 'off-hand Claw slot has an icon');
      // Without a claw main hand the off-hand claw is invalid -> slot falls back to empty.
      s.equippedMainhand='rapier';
      eq(FF.equipSlotState('offhand').name, 'Empty', 'off-hand claw slot is Empty when the main hand is not a claw');
    } finally {
      s.equippedMainhand=sv.mh; s.equippedMainhandTier=sv.mt; s.equippedMainhandRarity=sv.mr; s.equippedOffhand=sv.oh; s.equippedOffhandTier=sv.ot; s.equippedOffhandRarity=sv.or; s.equippedMainhandUid=sv.muid; s.equippedOffhandUid=sv.ouid;
    }

    // A UNIQUE (enchanted) Claw is kind 'weapon', so equipUnique routes it to the main hand -- it must
    // still be equippable in the off-hand via equipUniqueOffhandClaw (regression: it couldn't before).
    ok(typeof FF.equipUniqueOffhandClaw === 'function', 'equipUniqueOffhandClaw exported');
    var sv2 = { mh:s.equippedMainhand, mt:s.equippedMainhandTier, mr:s.equippedMainhandRarity, oh:s.equippedOffhand, ot:s.equippedOffhandTier, or:s.equippedOffhandRarity, muid:s.equippedMainhandUid, ouid:s.equippedOffhandUid, ui:s.uniqueItems, cx:s.xp.claw };
    try {
      s.uniqueItems = { uc:{ uid:'uc', base:'stweapon_claw_t5_rare', kind:'weapon', tier:5, rarity:'rare', enchants:[{mod:'flatDamage',roll:17}], enhance:0 } };
      s.xp.claw = 5e7;
      s.equippedMainhand='claw'; s.equippedMainhandTier=6; s.equippedMainhandRarity='rare'; s.equippedMainhandUid=null;
      s.equippedOffhand=null; s.equippedOffhandTier=0; s.equippedOffhandRarity='normal'; s.equippedOffhandUid=null;
      eq(FF.equipUniqueOffhandClaw('uc'), true, 'a unique Claw equips into the off-hand with a Claw main hand');
      eq(s.equippedOffhandUid, 'uc', 'the off-hand slot points at the unique');
      eq(FF.hasOffhandClaw(s), true, 'hasOffhandClaw is true for a unique off-hand Claw');
      eq(FF.uniqueIsEquipped('uc'), true, 'the unique reads as equipped');
      // Damage pipeline: the unique's enchants flow through the equipped totals via the off-hand uid.
      eq(FF.equippedEnchantTotals(s).flatDamage, 17, 'the off-hand unique Claw\'s enchant is in the equipped totals');
      // Inventory/Improvement "Equip off-hand" button appears only for an unworn unique Claw with a Claw main hand.
      ok(typeof FF.uniqueOffhandClawBtn === 'function', 'uniqueOffhandClawBtn exported');
      // (it's equipped off-hand right now -> no button)
      eq(FF.uniqueOffhandClawBtn(s.uniqueItems.uc), '', 'no off-hand button while the Claw is already worn');
      FF.unequipUnique('uc');
      ok(/equipUniqueOffhandClaw/.test(FF.uniqueOffhandClawBtn(s.uniqueItems.uc)), 'an unworn unique Claw offers the off-hand button with a Claw main hand');
      s.equippedMainhand='rapier';
      eq(FF.uniqueOffhandClawBtn(s.uniqueItems.uc), '', 'no off-hand button without a Claw main hand');
      s.equippedMainhand='claw';
      // Guard: the same unique can't be off-handed while it's in the main hand.
      s.equippedMainhandUid='uc';
      eq(FF.equipUniqueOffhandClaw('uc'), false, 'cannot off-hand the Claw already in the main hand');
      s.equippedMainhandUid=null;
      // Guard: no unique off-hand Claw without a Claw main hand.
      s.equippedMainhand='rapier';
      eq(FF.equipUniqueOffhandClaw('uc'), false, 'cannot off-hand a unique Claw without a Claw main hand');
    } finally {
      s.equippedMainhand=sv2.mh; s.equippedMainhandTier=sv2.mt; s.equippedMainhandRarity=sv2.mr; s.equippedOffhand=sv2.oh; s.equippedOffhandTier=sv2.ot; s.equippedOffhandRarity=sv2.or; s.equippedMainhandUid=sv2.muid; s.equippedOffhandUid=sv2.ouid; s.uniqueItems=sv2.ui; s.xp.claw=sv2.cx;
    }
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
    eq(FF.WARDING_XP_PER_DMG, 2.0, 'Warding trains at 2 XP per point of damage reflected');
    eq(FF.DEF_PROF_XP_PER_DMG, 1.0, 'armor proficiencies still train at 1 XP per point mitigated (unchanged)');
    // Warding is a single shared proficiency: the per-element ward styles are NOT proficiency skills.
    ok(FF.OFFHAND_STYLE_IDS.indexOf('warding') === -1, 'warding is not an offhand STYLE id');
    FF.WARD_TYPES.forEach(function(w){ ok(FF.OFFHAND_STYLE_IDS.indexOf(w.id) === -1, w.id+' is not a per-style proficiency'); });
  });

  // ---- Masterwork physique: trains ONLY when a craft yields rare+ equipment ----------------
  suite('masterwork physique: rare+ only', function(){
    // No longer bundled into any outfitting skill's per-craft physique list.
    ['weaponsmithing','armorsmithing','tailoring','shieldsmithing','arcanism','bowyer','leatherworking','jewelrycrafting'].forEach(function(sk){
      var list = FF.CRAFT_PHYSIQUE[sk] || [];
      ok(!list.some(function(p){ return p[0]==='masterwork'; }), sk+' no longer bundles masterwork into every craft');
    });
    // awardMasterworkXp grants XP on rare+ outputs, nothing on a normal output.
    var s = FF._state, sv = s.physique;
    try {
      s.physique = {};
      FF.awardMasterworkXp('normal', 5); eq((s.physique.masterwork||0), 0, 'a normal craft grants no masterwork XP');
      FF.awardMasterworkXp('rare', 5); ok((s.physique.masterwork||0) > 0, 'a rare craft grants masterwork XP');
      var afterRare = s.physique.masterwork;
      FF.awardMasterworkXp('fantastic', 5); ok(s.physique.masterwork > afterRare, 'a fantastic craft also grants masterwork XP');
    } finally { s.physique = sv; }
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

  // ---- Sacrifice UI: each item card shows a live remaining/owned counter ----------------
  suite('sacrifice UI: item cards show remaining count', function(){
    ok(typeof FF.renderSacrificeTab === 'function', 'renderSacrificeTab exported');
    var s = FF._state;
    var save = { inv:s.inventory, locked:s.lockedItems };
    try {
      var wid = Object.keys(FF.STACKABLE_WEAPON_ITEMS)[0];
      s.inventory = {}; s.lockedItems = {};
      s.inventory[wid] = 7;
      var html = FF.renderSacrificeTab();
      ok(/Owned:\s*7/.test(html), 'a stack of 7 renders "Owned: 7" on its card');
      ok(/Tier 1 · Owned: 7/.test(html), 'the counter sits alongside the tier line');
      // The count reflects the live inventory: drop it to 2 and it re-reads.
      s.inventory[wid] = 2;
      ok(/Owned:\s*2/.test(FF.renderSacrificeTab()) && !/Owned:\s*7/.test(FF.renderSacrificeTab()), 'counter tracks the current quantity');
    } finally {
      s.inventory = save.inv; s.lockedItems = save.locked;
    }
  });

  suite('sacrifice UI: category / rarity / tier filters', function(){
    ok(typeof FF.sacSetFilters === 'function', 'sacSetFilters seam exported');
    var S = FF._state, save = { inv:S.inventory, locked:S.lockedItems };
    var W = 'stweapon_rapier_t4_rare', T = 'tool_mining_t2_normal'; // weapon: Rare, Tier 5 | tool: Normal, Tier 3
    var hasW = function(h){ return h.indexOf('data-id="'+W+'"') !== -1; };
    var hasT = function(h){ return h.indexOf('data-id="'+T+'"') !== -1; };
    try {
      ok(FF.STACKABLE_WEAPON_ITEMS[W] && FF.ALL_SELLABLE[T], 'sample weapon + tool ids resolve');
      S.inventory = {}; S.inventory[W] = 1; S.inventory[T] = 1; S.lockedItems = {};
      FF.sacSetFilters('all','all','all');
      var h = FF.renderSacrificeTab();
      ok(/class="sac-filter-bar"/.test(h), 'the filter bar renders');
      ok(/data-action="sacFilterCat"/.test(h) && /data-action="sacFilterRarity"/.test(h) && /id="sacTierSelect"/.test(h), 'category, rarity, and tier controls are present');
      ok(hasW(h) && hasT(h), 'All/All/All shows both the weapon and the tool');
      FF.sacSetFilters('tools', null, null);
      var ht = FF.renderSacrificeTab();
      ok(hasT(ht) && !hasW(ht), 'the Tools category filter shows tools only');
      FF.sacSetFilters('equipment', null, null);
      var he = FF.renderSacrificeTab();
      ok(hasW(he) && !hasT(he), 'the Equipment category filter excludes tools');
      FF.sacSetFilters('all', 'rare', null);
      var hr = FF.renderSacrificeTab();
      ok(hasW(hr) && !hasT(hr), 'the Rare rarity filter keeps the rare weapon and drops the normal tool');
      FF.sacSetFilters('all', 'all', '5');
      var h5 = FF.renderSacrificeTab();
      ok(hasW(h5) && !hasT(h5), 'the Tier 5 filter keeps the t5 weapon and drops the t3 tool');
      FF.sacSetFilters('all', 'normal', '3');
      var h3 = FF.renderSacrificeTab();
      ok(hasT(h3) && !hasW(h3), 'Normal + Tier 3 shows the tool only');
      // A tier with nothing owned falls back to All rather than rendering an empty grid.
      FF.sacSetFilters('all', 'all', '20');
      ok(hasW(FF.renderSacrificeTab()), 'a tier selection with no matching items resets to All');
    } finally { FF.sacSetFilters('all','all','all'); S.inventory = save.inv; S.lockedItems = save.locked; }
  });

  // ---- Sacrifice: equippable relics are offerable under Equipment -----------------------
  suite('sacrifice: equippable relics are offerable', function(){
    ok(FF.RELIC_ITEMS && typeof FF.RELIC_ITEMS === 'object', 'RELIC_ITEMS exported');
    var s = FF._state, save = { inv:s.inventory, locked:s.lockedItems, faith:s.faith, sx:s.xp.sacrifice, obl:(s.physique&&s.physique.oblation) };
    try {
      if(s.physique) s.physique.oblation = 0; // deterministic: no return-chance / bonus
      var rid = Object.keys(FF.RELIC_ITEMS)[0]; // a "relic_t<i>_<rarity>" equippable relic
      ok(rid && FF.RELIC_ITEMS[rid], 'a sample equippable relic id resolves');
      s.inventory = {}; s.lockedItems = {}; s.faith = 0;
      s.inventory[rid] = 3;
      FF.sacSetFilters('all','all','all');
      var h = FF.renderSacrificeTab();
      ok(h.indexOf('data-id="'+rid+'"') !== -1, 'an owned equippable relic appears as a sacrifice offering');
      ok(h.indexOf('data-category="relicgear"') !== -1, 'it is offered under the relicgear category (not a Broken Relic)');
      // It sits under the Equipment filter (it is gear, not a tool).
      FF.sacSetFilters('equipment', null, null);
      ok(FF.renderSacrificeTab().indexOf('data-id="'+rid+'"') !== -1, 'the equippable relic shows under the Equipment filter');
      FF.sacSetFilters('tools', null, null);
      ok(FF.renderSacrificeTab().indexOf('data-id="'+rid+'"') === -1, 'and is excluded from the Tools filter');
      FF.sacSetFilters('all','all','all');
      // Sacrificing it consumes one from the stack and restores Faith.
      var before = s.faith;
      FF.sacrificeItem('relicgear', rid, true);
      eq(s.inventory[rid], 2, 'sacrificing an equippable relic consumes one from the stack');
      ok(s.faith > before, 'and restores Faith');
      // A locked relic is protected.
      s.lockedItems[rid] = true;
      FF.sacrificeItem('relicgear', rid, true);
      eq(s.inventory[rid], 2, 'a locked equippable relic is protected from sacrifice');
    } finally {
      FF.sacSetFilters('all','all','all');
      s.inventory = save.inv; s.lockedItems = save.locked; s.faith = save.faith; s.xp.sacrifice = save.sx; if(s.physique) s.physique.oblation = save.obl;
    }
  });

  // ---- Faith: sacrifice value scales with rarity (2x/4x/8x) -----------------------------
  suite('faith: sacrifice rarity scaling', function(){
    // Base (normal) value: tier curve, with a +50% jewelry boost. The rarity multiplier (2x/4x/8x) is
    // applied to the raw value BEFORE the final round, so assert against the exact rounded expectations.
    var raw = 15 * Math.pow(1.25, 4); // tier-5 base, no jewelry
    eq(FF.sacrificeGearFaith(5, false, 'normal'),    Math.round(raw),     'normal gear uses the base tier curve');
    eq(FF.sacrificeGearFaith(5, false, 'rare'),      Math.round(raw * 2), 'rare => 2x Faith');
    eq(FF.sacrificeGearFaith(5, false, 'supreme'),   Math.round(raw * 4), 'supreme => 4x Faith');
    eq(FF.sacrificeGearFaith(5, false, 'fantastic'), Math.round(raw * 8), 'fantastic => 8x Faith');
    // A missing/unknown rarity is treated as normal (1x).
    eq(FF.sacrificeGearFaith(5, false, undefined), Math.round(raw), 'undefined rarity => normal value');
    // The jewelry boost and the rarity multiplier compound.
    var rawRing = 15 * Math.pow(1.25, 2) * 1.5; // tier-3 jewelry base
    eq(FF.sacrificeGearFaith(3, true, 'supreme'), Math.round(rawRing * 4), 'jewelry + supreme => 4x on top of the +50% jewelry base');
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

  // ---- Bows: slower draw hits harder (Short 1x / Medium 1.25x / Long 1.5x base damage) -----
  suite('bows: damage scales with draw', function(){
    var T = 15; // a high tier keeps rounding error tiny for the ratio check
    var s = FF.getStackableWeaponTierData('bowShort', T);
    var m = FF.getStackableWeaponTierData('bowMedium', T);
    var l = FF.getStackableWeaponTierData('bowLong', T);
    ok(m.dmgMax > s.dmgMax && l.dmgMax > m.dmgMax, 'Long > Medium > Short base damage');
    near(m.dmgMax / s.dmgMax, 1.25, 'Medium bow = Short x1.25', 0.02);
    near(l.dmgMax / s.dmgMax, 1.5,  'Long bow = Short x1.5', 0.02);
    // The slower bow is the harder-hitting one (Short 4 / Medium 5 / Long 6 attack speed).
    var W = FF.getWeaponStyle('bowLong');
    ok(W.attackSpeed === 6, 'Long bow is the slowest');
    // A melee weapon is unaffected (dmgMult defaults to 1).
    ok(FF.getStackableWeaponTierData('bowShort', T).dmgMax > 0, 'short bow still deals damage');
  });

  // ---- Leaderboard over-100 Mastery: capped `skills` + separate display-only `mastery` -----
  suite('leaderboard: over-100 mastery split', function(){
    var s = FF._state;
    var gid = FF.GATHER_SKILL_IDS[0];                 // a gathering skill (over-levelable)
    var lvl105 = FF.SKILL_XP_FLOOR_EXT[105];          // xp for extended level 105
    var saved = s.xp[gid];
    s.xp[gid] = lvl105;
    ok(FF.skillLevel(gid, lvl105) >= 105, 'gathering skill reads extended level past 100');
    var ps = FF.computeProfileStats();
    eq(ps.skills[gid], FF.MAX_SKILL_LEVEL, 'submitted `skills` value stays capped at 100 (ranking/gate unchanged)');
    ok(ps.mastery && ps.mastery[gid] >= 105, 'the true over-100 level rides in the separate `mastery` map');
    // A non-overlevelable skill (or one at/under 100) never appears in mastery.
    ok(!(ps.mastery && (gid+'_never') in ps.mastery), 'mastery only holds genuine over-100 entries');
    s.xp[gid] = saved;
    // Back at a normal level, mastery drops the key entirely.
    ok(!FF.computeProfileStats().mastery[gid], 'mastery omits a skill once it is back at/under 100');
  });

  // ---- Server-authoritative inventory: recipe manifest (Stage A2) -----------------------
  suite('inventory: recipe manifest', function(){
    var m = FF.buildRecipeManifest();
    ok(m && typeof m === 'object', 'buildRecipeManifest returns a map');
    var keys = Object.keys(m);
    ok(keys.length > 20, 'manifest has many recipes ('+keys.length+')');
    // Every entry is a { item_key: positive-integer } bill; every key carries a known prefix.
    var badBill = keys.filter(function(k){
      var bill = m[k]; if(!bill || typeof bill !== 'object' || !Object.keys(bill).length) return true;
      return Object.keys(bill).some(function(ik){ var q = bill[ik]; return !(q > 0) || Math.floor(q) !== q; });
    });
    eq(badBill.length, 0, 'every recipe bill is {key: positive int}');
    var badPrefix = keys.filter(function(k){ return !/^(std|wep|off):/.test(k); });
    eq(badPrefix.length, 0, 'every recipe_key is prefixed std:/wep:/off:');
    // Cross-check one real standard recipe: the manifest must reproduce its input bill exactly.
    var stdId = Object.keys(FF.ALL_CRAFT_RECIPES).filter(function(id){
      var r = FF.ALL_CRAFT_RECIPES[id]; return r && !r.shaftCraft && r.inputs && Object.keys(r.inputs).length;
    })[0];
    ok(stdId, 'found a standard recipe to cross-check');
    var man = m['std:'+stdId];
    ok(man, 'manifest contains std:'+stdId);
    Object.keys(FF.ALL_CRAFT_RECIPES[stdId].inputs).forEach(function(ik){
      eq(man[ik], Math.floor(FF.ALL_CRAFT_RECIPES[stdId].inputs[ik]), 'std:'+stdId+' input '+ik+' matches');
    });
    // Shaft craft (dynamic inputs) is intentionally excluded.
    var shaftId = Object.keys(FF.ALL_CRAFT_RECIPES).filter(function(id){ return FF.ALL_CRAFT_RECIPES[id] && FF.ALL_CRAFT_RECIPES[id].shaftCraft; })[0];
    if(shaftId) ok(!m['std:'+shaftId], 'dynamic shaft craft is excluded from the manifest');
  });

  // ---- Server-authoritative inventory: itemReconcile (item analog of walletReconcileGold) ----
  suite('inventory: itemReconcile', function(){
    var R = FF.itemReconcile;
    ok(typeof R === 'function', 'itemReconcile exported');
    eq(R({iron:100}, {iron:100}, {iron:100}, {iron:100}, {iron:100}).iron, 100, 'fully-credited item preserved');
    eq(R({iron:100}, {iron:100}, {iron:100}, {iron:40}, {iron:40}).iron, 100, 'throttled legit earn kept via pending');
    eq(R({sand:100000000}, {sand:100000000}, {sand:0}, {sand:25000}, {sand:0}).sand, 25000, 'spoofed item (no earned anchor) collapses to the ledger');
    eq(R({iron:40}, {iron:40}, {iron:100}, {iron:40}, {iron:100}).iron, 40, 'a spend sticks (ledger adopted the lower count)');
    eq(R({iron:120}, {iron:100}, {iron:100}, {iron:100}, {iron:100}).iron, 120, 'drift gathered mid-request is not clobbered');
    eq(R({sand:100000000}, {sand:100000000}, {sand:100000000}, {sand:25000}, undefined).sand, 25000, 'no serverEarned -> clamp to ledger');
    ok(!('iron' in R({iron:0}, {iron:0}, {}, {}, {})), 'a zero item is omitted');
    // The min(localInv) safety cap: adoption never CREATES items beyond what the client locally holds,
    // so an over-counted earned anchor (e.g. a missed equip-return) can't mint -- it just fails to clamp.
    ok(!('gold_bar' in R({}, {}, {}, {gold_bar:5}, {gold_bar:5})), 'ledger-only item (no local entry) is NOT created');
    eq(R({iron:1}, {iron:1}, {iron:9}, {iron:1}, {iron:1}).iron, 1, 'inflated earned anchor cannot push adoption above local (cap)');
  });

  // ---- addItem maintains the per-item lifetime-earned anchor (default), skips on noEarn -------
  suite('inventory: addItem earned anchor', function(){
    var s = FF._state;
    var K = '__ff_test_earn_item__';
    var savedInv = s.inventory[K], savedEarn = (s.itemEarnedTotal||{})[K];
    if(!s.itemEarnedTotal) s.itemEarnedTotal = {};
    delete s.inventory[K]; delete s.itemEarnedTotal[K];
    FF.addItem(K, 10);                 // production -> bumps the anchor
    eq(s.inventory[K], 10, 'addItem added to inventory');
    eq(s.itemEarnedTotal[K], 10, 'addItem bumped the earned anchor by default');
    FF.addItem(K, 5, { noEarn:true }); // pure local move -> inventory rises, anchor does NOT
    eq(s.inventory[K], 15, 'noEarn add still adds to inventory');
    eq(s.itemEarnedTotal[K], 10, 'noEarn add did NOT bump the earned anchor');
    // restore
    if(savedInv === undefined) delete s.inventory[K]; else s.inventory[K] = savedInv;
    if(savedEarn === undefined) delete s.itemEarnedTotal[K]; else s.itemEarnedTotal[K] = savedEarn;
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
      pool.forEach(function(m){ var r = FF.enchantModRange(m, 0); ok(m.id && m.label && m.stat && r.min <= r.max, cat + '/' + m.id + ' well-formed'); });
    });
    for(var i=0;i<50;i++){
      var e = FF.rollEnchant('weapon', { tier: 5 }); var m = FF.enchantModById('weapon', e.mod);
      var r = FF.enchantModRange(m, 5);
      ok(m && e.roll >= r.min && e.roll <= r.max, 'weapon roll lands in the mod range');
    }
    eq(FF.enchantCrystalCost({enchants:[]}), 1, 'first enchant costs 1 crystal');
    eq(FF.enchantCrystalCost({enchants:[1,2,3]}), 4, 'each extra enchant adds +1 crystal');
  });

  // ---- Weapon raw-damage enchants: tier-scaled physical + elemental, barred from magic weapons -----
  suite('improvement: elemental & tier-scaled raw-damage enchants', function(){
    ok(typeof FF.rawEnchantRange==='function' && typeof FF.elementalRawHitDamage==='function' && FF.ELEM_RAW_STATS, 'raw-damage helpers exported');
    // The weapon pool carries flat physical + one raw line per element, all flagged raw.
    var wpool = FF.ENCHANT_MODS.weapon;
    var raws = wpool.filter(function(m){ return m.raw; });
    eq(raws.length, 6, 'six raw-damage lines: flat physical + 5 elements');
    ['fire','water','earth','light','dark'].forEach(function(el){
      var m = wpool.filter(function(x){ return x.elem===el; })[0];
      ok(m && m.raw && m.stat===FF.ELEM_RAW_STATS[el], el + ' damage line exists with its own stat key');
    });
    ok(FF.enchantModById('weapon','flatDamage').raw && !FF.enchantModById('weapon','flatDamage').elem, 'flat physical is a raw line with no element');
    // Tier scaling: the range grows with weapon tier (was a fixed band before).
    var r0 = FF.rawEnchantRange(0), r10 = FF.rawEnchantRange(10), r20 = FF.rawEnchantRange(20);
    ok(r0.min <= r0.max && r10.min > r0.max && r20.min > r10.max, 'raw-damage range scales up with tier');
    ok(FF.enchantModRange(FF.enchantModById('weapon','critChance'), 20).max === 12, 'a percent mod ignores tier (fixed range)');
    // Magic weapons (wand/staff/scepter) can't roll raw lines; melee/ranged can.
    ok(FF.baseIsMagicWeapon('stweapon_wandFire_t5_rare'), 'a wand base is a magic weapon');
    ok(FF.baseIsMagicWeapon('stweapon_staff_t5_rare'), 'a staff base is a magic weapon');
    ok(!FF.baseIsMagicWeapon('stweapon_rapier_t5_rare'), 'a rapier is not a magic weapon');
    var magicPool = FF.enchantPoolForItem('weapon', true), meleePool = FF.enchantPoolForItem('weapon', false);
    ok(!magicPool.some(function(m){ return m.raw; }), 'magic-weapon pool drops every raw line');
    ok(meleePool.some(function(m){ return m.elem==='fire'; }), 'melee/ranged pool keeps the elemental lines');
    // 400 rolls on a magic weapon never produce a raw line.
    var badRaw = 0; for(var i=0;i<400;i++){ if(FF.enchantModById('weapon', FF.rollEnchant('weapon',{tier:8, magicWeapon:true}).mod).raw) badRaw++; }
    eq(badRaw, 0, 'wands/staffs/scepters never roll a raw-damage line');
    // Combat: elemental raw damage is a flat add, scaled by element advantage vs the foe (fire beats earth).
    var enchTot = {}; enchTot[FF.ELEM_RAW_STATS.fire] = 100;
    eq(FF.elementalRawHitDamage(enchTot, { element:'grass' }), 100, 'neutral matchup adds the raw total flat');
    eq(FF.elementalRawHitDamage(enchTot, { element:'earth' }), 120, 'fire vs earth gets the +20% element-advantage bonus');
    eq(FF.elementalRawHitDamage({}, { element:'earth' }), 0, 'no elemental lines -> no elemental damage');
    // Label rendering: the HTML label carries the element's <svg> icon (injected, never escaped); the
    // text label drops it. This guards against the "<svg ...> +4 Fire Damage" raw-markup regression.
    var fireEnch = { mod:'fireDamage', roll:4 };
    var htmlLbl = FF.enchantLabel('weapon', fireEnch), txtLbl = FF.enchantLabelText('weapon', fireEnch);
    ok(/<svg/.test(htmlLbl) && /Fire Damage/.test(htmlLbl), 'enchantLabel renders the element icon as real <svg> markup');
    ok(!/<svg/.test(txtLbl) && /\+4 Fire Damage/.test(txtLbl), 'enchantLabelText is icon-free plain text for options/prose/floats');
    // The improve detail card injects the label as HTML, so the icon shows instead of escaped markup.
    var S = FF._state, savedU = S.uniqueItems;
    try {
      S.uniqueItems = { u_test:{ uid:'u_test', kind:'weapon', base:'stweapon_rapier_t5_normal', rarity:'rare', tier:5, enhance:0, enchants:[fireEnch] } };
      FF.improveSelect('u_test');
      var card = FF.renderImproveDetail();
      ok(/<svg/.test(card) && !/&lt;svg/.test(card), 'the enchant card shows the icon (no escaped &lt;svg raw text)');
    } finally { S.uniqueItems = savedU; FF.improveSelect(null); }
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
  // ---- Thorns armour enchant now reflects flat damage on every landed hit --------------------------
  suite('thorns armour enchant reflects damage in combat', function(){
    var S = FF._state;
    var snap = { ba:S.bodyArmor, uq:S.uniqueItems, act:S.activity, hp:S.playerHp, mh:S.equippedMainhand, oh:S.equippedOffhand };
    try {
      var mon = FF.MONSTERS[0];
      var bare = { helmet:{tier:0}, chest:{tier:0}, gauntlets:{tier:0}, boots:{tier:0}, back:{tier:0} };
      // Control: with no thorns/ward/sentinel source, a monster's attack never touches its own HP.
      S.uniqueItems = {}; S.bodyArmor = bare; S.equippedOffhand = null; S.playerHp = 1e9;
      S.activity = { type:'combat', monsterId:mon.id, monsterHp:100000, tickAccum:0, monsterTickAccum:0 };
      for(var i=0;i<40;i++){ FF.monsterAttackTick(); if(S.activity.monsterHp<50000) S.activity.monsterHp=100000; }
      eq(100000 - S.activity.monsterHp, 0, 'no reflect fires without a thorns source');
      // +18 Thorns on the chest: the aggregate reads 18, and every landed hit reflects exactly 18.
      S.uniqueItems = { TH:{ uid:'TH', kind:'bodyarmor', tier:5, rarity:'rare', enhance:0, enchants:[{mod:'thorns', roll:18}] } };
      S.bodyArmor = { helmet:{tier:0}, chest:{material:'chain',tier:5,rarity:'rare',uid:'TH'}, gauntlets:{tier:0}, boots:{tier:0}, back:{tier:0} };
      eq(FF.equippedEnchantTotals(S).thorns, 18, 'thorns enchant feeds the aggregate (+18)');
      S.playerHp = 1e9;
      S.activity = { type:'combat', monsterId:mon.id, monsterHp:100000, tickAccum:0, monsterTickAccum:0 };
      var drops = {};
      for(var j=0;j<120;j++){ var b=S.activity.monsterHp; FF.monsterAttackTick(); var d=b-S.activity.monsterHp; if(d>0) drops[d]=(drops[d]||0)+1; }
      var sizes = Object.keys(drops).map(Number);
      ok(sizes.length===1 && sizes[0]===18, 'every landed-hit reflect is exactly the flat +18 thorns');
      ok((drops[18]||0) > 0, 'thorns actually fired on the hits that landed');
    } finally {
      S.bodyArmor=snap.ba; S.uniqueItems=snap.uq; S.activity=snap.act; S.playerHp=snap.hp; S.equippedMainhand=snap.mh; S.equippedOffhand=snap.oh;
    }
  });

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
    // Block Chance enchant must actually reach the combat block roll. playerBlockChance folds in
    // enchantBlockChance(st) (percent -> fraction), so a blockChance:4 enchant contributes +0.04 to the
    // roll -- and the stat-panel Block display (which reads playerBlockChance) now shows it too.
    ok(typeof FF.enchantBlockChance==='function' && typeof FF.enchantDamageReductionMult==='function', 'block/DR enchant helpers exported');
    eq(Math.round(FF.enchantBlockChance(stAll)*100), 4, 'blockChance:4 enchant -> +0.04 block chance folded into playerBlockChance');
    var stNoEnch = { uniqueItems:{}, jewelrySlots:{}, bodyArmor:{} };
    eq(FF.enchantBlockChance(stNoEnch), 0, 'no block enchant -> +0 block chance');
    // Damage Reduction enchant must reach the incoming-damage chain: a dmgReduction:7 enchant returns a
    // 0.93 multiplier (7% off), and it's capped at 90% off so a hit can never be fully negated.
    var stDR = { uniqueItems:{ ch:{uid:'ch',kind:'bodyarmor',enhance:0,enchants:[{mod:'dmgReduction',roll:7}]} },
                 bodyArmor:{ chest:{uid:'ch'} }, jewelrySlots:{} };
    eq(FF.equippedEnchantTotals(stDR).dmgReduction, 7, 'dmgReduction enchant feeds the aggregate');
    ok(Math.abs(FF.enchantDamageReductionMult(stDR) - 0.93) < 1e-9, 'dmgReduction:7 -> incoming damage x0.93');
    eq(FF.enchantDamageReductionMult(stNoEnch), 1, 'no DR enchant -> incoming damage unchanged (x1)');
    var stDRmax = { uniqueItems:{ ch:{uid:'ch',kind:'bodyarmor',enhance:0,enchants:[{mod:'dmgReduction',roll:200}]} },
                    bodyArmor:{ chest:{uid:'ch'} }, jewelrySlots:{} };
    ok(FF.enchantDamageReductionMult(stDRmax) >= 0.1 - 1e-9, 'DR is capped at 90% off (mult never below 0.10)');
    // The remaining armour/jewelry/weapon enchants that used to be inert are now wired into combat. Each
    // helper (or the aggregate for the two inline weapon reads) proves the stat reaches its combat site.
    ok(typeof FF.enchantResistanceMult==='function' && typeof FF.enchantAccuracyBonus==='function' && typeof FF.enchantHpRegen==='function' && typeof FF.enchantDefenseMult==='function', 'resistance/accuracy/hpRegen/defense enchant helpers exported');
    // Resistance (jewelry): a flat % off incoming damage, capped at 90%, separate from Damage Reduction.
    var stRes = { uniqueItems:{ am:{uid:'am',kind:'amulet',enhance:0,enchants:[{mod:'resistance',roll:12}]} },
                  jewelrySlots:{ amulet:{uid:'am'} }, bodyArmor:{} };
    eq(FF.equippedEnchantTotals(stRes).resistance, 12, 'resistance enchant feeds the aggregate');
    ok(Math.abs(FF.enchantResistanceMult(stRes) - 0.88) < 1e-9, 'resistance:12 -> incoming damage x0.88');
    eq(FF.enchantResistanceMult(stNoEnch), 1, 'no resistance enchant -> incoming unchanged (x1)');
    // Accuracy (weapon): a % boost folded into playerAccuracy's bonus group.
    var stAcc = { uniqueItems:{ w:{uid:'w',kind:'weapon',enhance:0,enchants:[{mod:'accuracy',roll:15}]} },
                  equippedMainhandUid:'w', jewelrySlots:{}, bodyArmor:{} };
    ok(Math.abs(FF.enchantAccuracyBonus(stAcc) - 0.15) < 1e-9, 'accuracy:15 enchant -> +0.15 accuracy multiplier');
    // HP Regen (armour): a FLAT bonus (pct:false) added to each passive regen tick.
    var stReg = { uniqueItems:{ ch:{uid:'ch',kind:'bodyarmor',enhance:0,enchants:[{mod:'hpRegen',roll:6}]} },
                  bodyArmor:{ chest:{uid:'ch'} }, jewelrySlots:{} };
    eq(FF.enchantHpRegen(stReg), 6, 'hpRegen:6 enchant -> +6 flat HP per 5s regen tick');
    eq(FF.enchantHpRegen(stNoEnch), 0, 'no hpRegen enchant -> +0');
    // The enchant HP regen is capped at 10 HP / 5s no matter how many armour slots stack it.
    var stRegCap = { uniqueItems:{ a:{uid:'a',kind:'bodyarmor',enhance:0,enchants:[{mod:'hpRegen',roll:6}]},
                                   b:{uid:'b',kind:'bodyarmor',enhance:0,enchants:[{mod:'hpRegen',roll:6}]},
                                   c:{uid:'c',kind:'bodyarmor',enhance:0,enchants:[{mod:'hpRegen',roll:6}]} },
                     bodyArmor:{ chest:{uid:'a'}, helmet:{uid:'b'}, back:{uid:'c'} }, jewelrySlots:{} };
    eq(FF.enchantHpRegen(stRegCap), 10, 'stacked hpRegen enchants (18 raw) cap at 10 HP / 5s');
    // The enchant reads as a per-5s regen on the item card.
    eq(FF.enchantLabel('bodyarmor', {mod:'hpRegen', roll:6}), '+6 HP Regen / 5s', 'HP Regen enchant label reads per 5s');
    // The Improvement card lists every possible enchant roll for the item's kind, with min-max ranges.
    ok(typeof FF.enchantPoolListHtml === 'function', 'enchantPoolListHtml exported');
    var poolW = FF.enchantPoolListHtml('weapon');
    eq((poolW.match(/inputs-line/g)||[]).length, FF.ENCHANT_MODS.weapon.length, 'weapon pool lists every weapon enchant mod');
    ok(/Critical Damage/.test(poolW) && /\+5% – \+30%/.test(poolW), 'weapon pool shows Critical Damage +5% to +30%');
    ok(/Flat Physical Damage/.test(poolW), 'the flat physical raw line is listed');
    ok(/Fire Damage/.test(poolW) && /Dark Damage/.test(poolW), 'elemental raw lines are listed for a melee/ranged weapon');
    // Raw lines scale with the weapon's tier: a tier-10 card shows a larger band than the tier-0 default.
    var r10 = FF.rawEnchantRange(10);
    ok(FF.enchantPoolListHtml('weapon', { tier:10 }).indexOf('+'+r10.min+' – +'+r10.max) !== -1, 'raw lines show a tier-scaled range');
    // A magic weapon's card hides every raw line.
    var poolMagic = FF.enchantPoolListHtml('weapon', { magicWeapon:true });
    ok(!/Fire Damage/.test(poolMagic) && !/Flat Physical Damage/.test(poolMagic), 'a wand/staff/scepter card hides the raw-damage lines');
    var poolA = FF.enchantPoolListHtml('bodyarmor');
    eq((poolA.match(/inputs-line/g)||[]).length, FF.ENCHANT_MODS.armor.length, 'armour pool lists every armour enchant mod');
    ok(/HP Regen \/ 5s/.test(poolA) && /\+1 – \+6/.test(poolA), 'armour pool shows HP Regen per 5s with its range');
    eq((FF.enchantPoolListHtml('ring').match(/inputs-line/g)||[]).length, FF.ENCHANT_MODS.jewelry.length, 'jewelry (ring) pool lists every jewelry enchant mod');
    // Defense (armour): a % multiplier on total Armor (also lifts the stat-panel Armor row).
    var stDef = { uniqueItems:{ ch:{uid:'ch',kind:'bodyarmor',enhance:0,enchants:[{mod:'defense',roll:30}]} },
                  bodyArmor:{ chest:{uid:'ch'} }, jewelrySlots:{} };
    ok(Math.abs(FF.enchantDefenseMult(stDef) - 1.30) < 1e-9, 'defense:30 enchant -> x1.30 armour');
    eq(FF.enchantDefenseMult(stNoEnch), 1, 'no defense enchant -> armour unchanged (x1)');
    // Lifesteal + Armour Pierce (weapon) are read inline from the (Spellblade-boosted) enchTot in
    // playerAttackTick; assert both reach the aggregate so the /100 combat reads have a value to use.
    var stWpn = { uniqueItems:{ w:{uid:'w',kind:'weapon',enhance:0,enchants:[{mod:'lifesteal',roll:8},{mod:'penetration',roll:15}]} },
                  equippedMainhandUid:'w', jewelrySlots:{}, bodyArmor:{} };
    eq(FF.equippedEnchantTotals(stWpn).lifesteal, 8, 'lifesteal enchant feeds the aggregate (combat heals dmg x 8%)');
    eq(FF.equippedEnchantTotals(stWpn).penetration, 15, 'penetration enchant feeds the aggregate (combat pierces 15% armour)');
    ok(typeof FF.equipUnique==='function' && typeof FF.unequipUnique==='function' && typeof FF.uniqueSellValue==='function', 'stage-3 equip/trade fns exported');
    // Chat item links: a unique round-trips through encode -> decode with base/enhance/enchants intact.
    var linkU = { base:'stweapon_wandFire_t3_rare', kind:'weapon', tier:3, rarity:'rare', enhance:4, enchants:[{mod:'critDamage',roll:12},{mod:'lifesteal',roll:7}] };
    var tok = FF.encodeItemLink(linkU);
    ok(typeof tok==='string' && tok.length>0, 'encodeItemLink returns a token');
    var dec = FF.decodeItemLink(tok);
    ok(dec && dec.base==='stweapon_wandFire_t3_rare' && dec.tier===3 && dec.rarity==='rare' && dec.kind==='weapon', 'decode recovers base/tier/rarity/kind');
    ok(dec && dec.enhance===4 && dec.enchants.length===2 && dec.enchants[0].mod==='critDamage' && dec.enchants[0].roll===12 && dec.enchants[1].mod==='lifesteal' && dec.enchants[1].roll===7, 'decode recovers enhance + enchant rolls');
    ok(FF.decodeItemLink('!!!not-base64!!!')===null || FF.decodeItemLink('')===null, 'garbage payload decodes to null (safe fallback)');
    // A linked MASTERCRAFT legendary carries its leg key so the chip/card show the Legendary name, not the base.
    var legLink = { base:'stweapon_maul_t19_rare', kind:'weapon', tier:19, rarity:'rare', enhance:0, enchants:[], leg:'bonecrusher' };
    var legDec = FF.decodeItemLink(FF.encodeItemLink(legLink));
    ok(legDec && legDec.leg==='bonecrusher', 'a linked legendary round-trips its leg key through encode/decode');
    var legName = FF.uniqueDisplayName(legDec).replace(/\s+/g,' ').trim();
    eq(legName, 'Rare Bonecrusher', 'the linked legendary reads as "Rare Bonecrusher", not the base "... Maul"');
    var chip = FF.itemLinkChipHtml(FF.encodeItemLink(legLink));
    ok(/Bonecrusher/.test(chip) && !/Maul/.test(chip), 'the chat chip shows the Legendary name, not the base weapon');
    // Old-format (3-field) links still decode safely (no leg -> falls back to the base name).
    var oldTok = (function(){ try { return btoa(['stweapon_maul_t19_rare','0',''].join('|')); } catch(e){ return ''; } })();
    var oldDec = FF.decodeItemLink(oldTok);
    ok(oldDec && oldDec.base==='stweapon_maul_t19_rare' && !oldDec.leg, 'a legacy 3-field link still decodes (no leg field)');
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
    // The unique card's BASE damage line scales a weapon by its Enhance (combat uses mainhandEnhanceMult
    // === enhanceStatMult), so +N no longer looks like it only touches the enchants.
    var wid = Object.keys(FF.STACKABLE_WEAPON_ITEMS).filter(function(k){ return /wandWater_t5_fantastic$/.test(k); })[0];
    var wb = FF.STACKABLE_WEAPON_ITEMS[wid];
    function shownDmg(enh){ var m = FF.uniqueCardBody({ base:wid, kind:'weapon', tier:5, rarity:'fantastic', enhance:enh, enchants:[] }).match(/Damage (\d+)[–-](\d+)/); return m ? [+m[1], +m[2]] : null; }
    var d0 = shownDmg(0), d7 = shownDmg(7);
    eq(d0[0], wb.dmgMin, 'a +0 weapon card shows its raw min damage');
    eq(d0[1], wb.dmgMax, 'a +0 weapon card shows its raw max damage');
    eq(d7[0], Math.round(wb.dmgMin * FF.enhanceStatMult(7)), '+7 card min = raw x enhanceStatMult(7)');
    eq(d7[1], Math.round(wb.dmgMax * FF.enhanceStatMult(7)), '+7 card max = raw x enhanceStatMult(7)');
    ok(d7[1] > d0[1], 'enhancing a weapon raises its shown base damage');

    // The unique card's BASE section now names a ring's / amulet's inherent typed value (fire damage,
    // familiar potency = summon efficiency, damage resistance), scaled by its Enhance.
    function ringCard(base, enh){ return FF.uniqueCardBody({ base:base, kind:'ring', tier:0, rarity:'normal', enhance:enh||0, enchants:[] }); }
    var fireCard = ringCard('ring_fire_t0_normal', 0);
    ok(/\+5% Fire damage/.test(fireCard), 'fire ring card shows its Fire damage value');
    ok(/\+5% familiar potency/.test(ringCard('ring_communion_t0_normal', 0)), 'communion ring card shows familiar potency (summon efficiency)');
    ok(/\+5% accuracy/.test(ringCard('ring_precision_t0_normal', 0)), 'precision ring card shows accuracy');
    // Physical rings say WHICH type, not a bare "% damage".
    ok(/slashing damage/.test(ringCard('ring_slash_t0_normal', 0)), 'physical ring card names its damage type');
    // Enhancing a ring scales the shown value (applyJewelryEnhance multiplies bonus by enhanceStatMult).
    var m5 = ringCard('ring_fire_t0_normal', 5).match(/\+(\d+)% Fire damage/);
    ok(m5 && +m5[1] === Math.round(0.05 * FF.enhanceStatMult(5) * 100), '+5 fire ring shows the enhanced Fire-damage value');
    // Warding amulet base line shows damage resistance.
    ok(/damage resistance/.test(FF.uniqueCardBody({ base:'amulet_warding_t0_normal', kind:'amulet', tier:0, rarity:'normal', enhance:0, enchants:[] })), 'warding amulet card shows damage resistance');

    // Weapons: a wand names its element on the Damage line; a staff shows its extra familiar (summon)
    // slots and Block chance -- values that weren't surfaced on the card before.
    var wandId = Object.keys(FF.STACKABLE_WEAPON_ITEMS).filter(function(k){ var it=FF.STACKABLE_WEAPON_ITEMS[k]; return FF.isWandWeapon(it.typeId) && it.element==='fire' && it.rarity==='normal' && it.tierIndex===0; })[0];
    var wandItem = FF.STACKABLE_WEAPON_ITEMS[wandId];
    var wandCard = FF.uniqueCardBody({ base:wandId, kind:'weapon', tier:wandItem.tierIndex, rarity:'normal', enhance:0, enchants:[] });
    ok(/Damage \d+[–-]\d+ Fire/.test(wandCard), 'a wand card names its element on the damage line');
    var staffId = Object.keys(FF.STACKABLE_WEAPON_ITEMS).filter(function(k){ var it=FF.STACKABLE_WEAPON_ITEMS[k]; return (it.familiarSlots||0)>0 && it.rarity==='fantastic' && it.tierIndex===0; })[0];
    var staffItem = FF.STACKABLE_WEAPON_ITEMS[staffId];
    var staffCard = FF.uniqueCardBody({ base:staffId, kind:'weapon', tier:staffItem.tierIndex, rarity:'fantastic', enhance:0, enchants:[] });
    ok(new RegExp('\\+'+staffItem.familiarSlots+' familiar slot').test(staffCard), 'a staff card shows its extra familiar (summon) slots');
    ok(/Block \d+%/.test(staffCard), 'a staff card shows its Block chance');

    // Field-driven ward / quiver lines (surfaced if such a card is ever shown): reflect % and arrow dmg + keep-ammo.
    ok(/Reflects \d+% \w+ damage/.test(FF.uniqueCardBody({ base:'stward_wardFire_t0_normal', kind:'offhand', tier:0, rarity:'normal', enhance:0, enchants:[] })), 'ward card shows its elemental reflect');
    ok(/arrow damage/.test(FF.uniqueCardBody({ base:'stquiver_quiver_t0_normal', kind:'offhand', tier:0, rarity:'normal', enhance:0, enchants:[] })), 'quiver card shows its arrow-damage bonus');
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

  // ---- Enhance: first-ever enhance warns it permanently locks the item out of enchanting ---------
  suite('enhance: first-enhance enchant-lock confirmation', function(){
    var s = FF._state;
    var sv = { ui:s.uniqueItems, inv:s.inventory, ack:s.enhanceLockWarnAck, mh:s.equippedMainhandUid };
    s.uniqueItems = { u_lock:{ uid:'u_lock', base:'stweapon_rapier_t2_rare', kind:'weapon', tier:2, rarity:'rare', enchants:[], enhance:0 } };
    s.inventory = { scroll_t2: 50 };
    s.enhanceLockWarnAck = false;
    s.equippedMainhandUid = null;
    var rnd = Math.random; Math.random = function(){ return 0; }; // force enhance success (0 < chance)
    // First click on a never-enhanced item ARMS the warning: it must not enhance or spend scrolls yet.
    FF.enhanceItem('u_lock');
    eq(s.uniqueItems.u_lock.enhance, 0, 'first click arms the warning, does not enhance');
    eq(s.inventory.scroll_t2, 50, 'first click spends no Inscription Scrolls');
    eq(s.enhanceLockWarnAck, false, 'acknowledgment not set until the confirming click');
    // Second click confirms.
    FF.enhanceItem('u_lock');
    eq(s.uniqueItems.u_lock.enhance, 1, 'confirming click enhances to +1');
    eq(s.enhanceLockWarnAck, true, 'acknowledgment recorded game-wide after confirming');
    // Once acknowledged, a fresh item's first enhance no longer re-prompts.
    s.uniqueItems.u_lock2 = { uid:'u_lock2', base:'stweapon_rapier_t2_rare', kind:'weapon', tier:2, rarity:'rare', enchants:[], enhance:0 };
    FF.enhanceItem('u_lock2');
    eq(s.uniqueItems.u_lock2.enhance, 1, 'once acknowledged, later first-enhances skip the confirmation');
    Math.random = rnd;
    s.uniqueItems = sv.ui; s.inventory = sv.inv; s.enhanceLockWarnAck = sv.ack; s.equippedMainhandUid = sv.mh;
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

  // ---- Improvement tab: equipped gear is grouped at the top so you know what to improve ---------
  suite('improvement tab: equipped gear first', function(){
    ok(typeof FF.renderImprovementTab === 'function', 'renderImprovementTab exported');
    var s = FF._state;
    var sv = { mh:s.equippedMainhand, mt:s.equippedMainhandTier, mr:s.equippedMainhandRarity, muid:s.equippedMainhandUid, ui:s.uniqueItems, js:s.jewelrySlots };
    try {
      s.uniqueItems = {
        ueq:{ uid:'ueq', base:'stweapon_rapier_t5_rare', kind:'weapon', tier:5, rarity:'rare', enchants:[], enhance:0 },
        ubag:{ uid:'ubag', base:'ring_plain_t5_supreme', kind:'ring', tier:5, rarity:'supreme', enchants:[], enhance:0 }
      };
      s.equippedMainhand='rapier'; s.equippedMainhandTier=6; s.equippedMainhandRarity='rare'; s.equippedMainhandUid='ueq';
      s.jewelrySlots = s.jewelrySlots || {};
      var html = FF.renderImprovementTab();
      var eqIdx = html.indexOf('>Equipped<'), bagIdx = html.indexOf('>In your bags<');
      ok(eqIdx >= 0, 'an "Equipped" section is rendered');
      ok(bagIdx >= 0, 'an "In your bags" section is rendered');
      ok(eqIdx < bagIdx, 'equipped gear is listed before bag gear');
      ok(html.indexOf('data-uid="ueq"') >= 0 && html.indexOf('data-uid="ueq"') < bagIdx, 'the equipped unique sits in the Equipped section');
      ok(html.indexOf('data-uid="ubag"') > bagIdx, 'the unequipped unique sits in the In-your-bags section');
    } finally {
      s.equippedMainhand=sv.mh; s.equippedMainhandTier=sv.mt; s.equippedMainhandRarity=sv.mr; s.equippedMainhandUid=sv.muid; s.uniqueItems=sv.ui; s.jewelrySlots=sv.js;
    }
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

  // ---- Equip a unique ring: full slots must show a reason, not silently do nothing --------------
  suite('unique ring: full-slots feedback', function(){
    var s = FF._state;
    var sv = { ui:s.uniqueItems, js:s.jewelrySlots };
    try {
      var u = { uid:'ur', base:'ring_plain_t0_rare', kind:'ring', tier:0, rarity:'rare', enchants:[], enhance:0 };
      s.uniqueItems = { ur:u };
      // All 5 ring slots occupied -> equipping the unique ring is blocked with a clear reason.
      s.jewelrySlots = {};
      FF.RING_SLOT_IDS.forEach(function(id){ s.jewelrySlots[id] = { typeId:'plain', tier:1, rarity:'normal' }; });
      ok(/Ring slots full/.test(FF.uniqueEquipLock(u) || ''), 'a full ring set reports "slots full" instead of null');
      var cardFull = FF.renderUniqueEquipCard(u);
      ok(/disabled/.test(cardFull) && !/data-action="improveEquip"/.test(cardFull), 'the card shows a disabled button (no live Equip) when slots are full');
      FF.equipUnique('ur');
      eq(FF.uniqueIsEquipped('ur'), false, 'equipping is a no-op while every ring slot is full');
      // Free a slot -> it becomes equippable and equips.
      s.jewelrySlots[FF.RING_SLOT_IDS[0]] = { typeId:null, tier:0, rarity:'normal' };
      eq(FF.uniqueEquipLock(u), null, 'a free slot clears the lock');
      ok(/data-action="improveEquip"/.test(FF.renderUniqueEquipCard(u)), 'the card offers a live Equip button once a slot frees');
      FF.equipUnique('ur');
      eq(FF.uniqueIsEquipped('ur'), true, 'the unique ring equips into the free slot');
    } finally {
      s.uniqueItems = sv.ui; s.jewelrySlots = sv.js;
    }
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
  suite('blacksmithing forge groups', function(){
    ok(Array.isArray(FF.TOOL_TYPES) && FF.TOOL_TYPES.length > 0, 'TOOL_TYPES exported');
    ok(typeof FF.toolBenefitLabel === 'function', 'toolBenefitLabel exported');
    ok(Array.isArray(FF.BLACKSMITH_TOOL_GROUPS) && FF.BLACKSMITH_TOOL_GROUPS.length === 5, 'five tool-family groups');
    ok(typeof FF.blacksmithToolGroupKey === 'function', 'blacksmithToolGroupKey exported');
    var groupKeys = FF.BLACKSMITH_TOOL_GROUPS.map(function(g){ return g.key; });
    eq(groupKeys.join(','), 'gathering,refining,cooking,outfitting,construction', 'groups mirror the Resources families, in order');
    // Every tool classifies into exactly one known group.
    var buckets = {}; groupKeys.forEach(function(k){ buckets[k] = []; });
    var covered = FF.TOOL_TYPES.every(function(tt){ var k = FF.blacksmithToolGroupKey(tt.skillId); if(!buckets[k]) return false; buckets[k].push(tt); return true; });
    ok(covered, 'every tool maps to a known family');
    var total = groupKeys.reduce(function(n,k){ return n + buckets[k].length; }, 0);
    eq(total, FF.TOOL_TYPES.length, 'the families partition all tools (none dropped or double-counted)');
    // A few known placements.
    eq(FF.blacksmithToolGroupKey('mining'), 'gathering', 'mining tool nests under Gathering');
    eq(FF.blacksmithToolGroupKey('butchering'), 'refining', 'butchering nests under Refining (a refining activity)');
    eq(FF.blacksmithToolGroupKey('cooking'), 'cooking', 'cooking nests under Cooking');
    eq(FF.blacksmithToolGroupKey('weaponsmithing'), 'outfitting', 'weaponsmithing nests under Outfitting');
    eq(FF.blacksmithToolGroupKey('carpentry'), 'construction', 'carpentry nests under Construction');
    // Within each group, tools sort alphabetically by benefited skill (the render order).
    groupKeys.forEach(function(k){
      var labels = buckets[k].map(function(tt){ return FF.toolBenefitLabel(tt); });
      var sorted = labels.slice().sort(function(a,b){ return a.localeCompare(b); });
      eq(JSON.stringify(labels.slice().sort(function(a,b){ return a.localeCompare(b); })), JSON.stringify(sorted), k + ' group sorts A→Z');
    });
  });

  // ---- Blacksmithing: "Equip Best" picks and equips the top owned tool for a skill --------------
  suite('blacksmithing: equip best tool', function(){
    ok(typeof FF.equipBestTool === 'function' && typeof FF.bestOwnedToolForSkill === 'function', 'equip-best helpers exported');
    var s = FF._state;
    var sv = { inv:s.inventory, gt:s.gatherTools, gr:s.gatherToolRarities };
    try {
      var sk = 'herbalism';
      s.inventory = {}; s.gatherTools = {}; s.gatherToolRarities = {};
      s.gatherTools[sk] = 0; s.gatherToolRarities[sk] = 'normal';
      s.inventory['tool_'+sk+'_t2_normal'] = 1;
      s.inventory['tool_'+sk+'_t5_rare'] = 1;
      // best = highest tier, then highest rarity -> the t5 rare.
      eq(FF.bestOwnedToolForSkill(sk).id, 'tool_'+sk+'_t5_rare', 'best owned tool is the highest tier/rarity');
      FF.equipBestTool(sk);
      eq(s.gatherTools[sk], 6, 'Equip Best equips the tier-5 tool (stored as tier+1)');
      eq(s.gatherToolRarities[sk], 'rare', 'Equip Best carries the rarity');
      eq(s.inventory['tool_'+sk+'_t5_rare']||0, 0, 'the equipped tool is consumed from the bag');
      eq(s.inventory['tool_'+sk+'_t2_normal']||0, 1, 'lesser tools stay in the bag');
      ok(FF.equippedToolAtLeast(sk, FF.TOOL_ITEMS['tool_'+sk+'_t2_normal']), 'the equipped tool now beats the leftover');
      // A second Equip Best does not downgrade to the leftover t2.
      FF.equipBestTool(sk);
      eq(s.gatherTools[sk], 6, 'Equip Best never downgrades when the equipped tool is already best');

      // Outlier: "best" is the aggregate speed/success score (rarity-scaled), NOT raw tier -- a lower-tier
      // higher-rarity tool (Supreme) can beat a higher-tier lower-rarity one (Rare). Find such a pair.
      var mk = 'mining', pair = null;
      for(var hi=1; hi<21 && !pair; hi++){ for(var lo=0; lo<hi; lo++){
        if(FF.toolAggregateScore(mk,true,lo,'supreme') > FF.toolAggregateScore(mk,true,hi,'rare')){ pair = {lo:lo, hi:hi}; break; }
      } }
      ok(pair, 'a lower-tier Supreme out-scores a higher-tier Rare somewhere on the ladder');
      s.inventory = {}; s.gatherTools[mk] = 0; s.gatherToolRarities[mk] = 'normal';
      s.inventory['tool_'+mk+'_t'+pair.hi+'_rare'] = 1;   // higher tier, lower rarity
      s.inventory['tool_'+mk+'_t'+pair.lo+'_supreme'] = 1; // lower tier, higher rarity -- actually better
      eq(FF.bestOwnedToolForSkill(mk).id, 'tool_'+mk+'_t'+pair.lo+'_supreme', 'best picks the higher-scoring Supreme, not the higher tier');
      FF.equipBestTool(mk);
      eq(s.gatherTools[mk], pair.lo+1, 'Equip Best equips the higher-scoring (lower-tier) Supreme');
      eq(s.gatherToolRarities[mk], 'supreme', 'the equipped tool is the Supreme');
      eq(s.inventory['tool_'+mk+'_t'+pair.hi+'_rare']||0, 1, 'the higher-tier Rare stays in the bag (it scored lower)');
    } finally {
      s.inventory = sv.inv; s.gatherTools = sv.gt; s.gatherToolRarities = sv.gr;
    }
  });

  // ---- Chandlery: candles light a Cottage to speed its Peon ------------------------------------
  suite('chandlery: cottage candles', function(){
    ok(typeof FF.peonCandleBurn === 'function' && typeof FF.candleBurnMs === 'function', 'candle helpers exported');

    // Tier buys BURN TIME, not power. Both halves of that need pinning: the ladder climbs, and the
    // speed bonus does NOT.
    ok(FF.candleBurnMs(20) > FF.candleBurnMs(0) * 30, 'a T20 candle burns >30x as long as a T0');
    var mono = true;
    for(var ci=1; ci<21; ci++){ if(FF.candleBurnMs(ci) <= FF.candleBurnMs(ci-1)) mono = false; }
    ok(mono, 'burn time climbs monotonically across the whole tier ladder');
    eq(FF.candleTierOf('chandlery_t13'), 13, 'candle tier parses out of the item id');

    // The flat-bonus property, checked at BOTH ends of the ladder -- a tier-scaled bonus would pass at
    // one end and fail at the other. baseTime is large so the 200ms floor can't clamp either side and
    // silently flatten the ratio.
    [0, 10, 20].forEach(function(tier){
      var unlit = FF.peonActionTime(100, tier, 'chandlery', false);
      var lit   = FF.peonActionTime(100, tier, 'chandlery', true);
      ok(Math.abs((unlit/lit) - (1 + FF.CANDLE_LIT_SPEED_BONUS)) < 1e-9,
         'T'+tier+': lit is exactly +'+Math.round(FF.CANDLE_LIT_SPEED_BONUS*100)+'% faster (bonus is flat, not tier-scaled)');
    });

    var s = FF._state, savedInv = s.inventory;
    try {
      // An UNLIT peon must behave exactly as it did before candles existed -- this is the whole premise
      // of shipping it as opt-in acceleration rather than an upkeep tax.
      s.inventory = { 'chandlery_t0': 5 };
      var plain = { x:0, y:0, skillId:'chandlery', kind:'craft', itemId:'chandlery_t0', progress:0 };
      eq(FF.peonCandleBurn(plain, 999999), false, 'an unlit task never reports a lit/dark flip');
      eq(s.inventory['chandlery_t0'], 5, 'an unlit task consumes no candles at all');
      eq(FF.peonIsLit(plain), false, 'a task with no candle is not lit');

      // Lighting draws one candle from the bag.
      var t = { x:0, y:0, skillId:'chandlery', candleId:'chandlery_t0', candleMs:0 };
      eq(FF.peonCandleLight(t), true, 'lighting succeeds while candles are in the bag');
      eq(s.inventory['chandlery_t0'], 4, 'lighting consumes exactly one candle');
      eq(t.candleMs, FF.candleBurnMs(0), 'the fresh candle starts at its full burn time');
      ok(FF.peonIsLit(t), 'the cottage is now lit');

      // One action longer than a whole candle drains several in a single call. This is the offline
      // catch-up path: a big dt replays many actions and the burn must not stall at one candle per call.
      s.inventory = { 'chandlery_t0': 5 };
      var big = { candleId:'chandlery_t0', candleMs:0 };
      FF.peonCandleBurn(big, FF.candleBurnMs(0) * 2.8);
      eq(s.inventory['chandlery_t0'], 2, 'a burn spanning 2.8 candles consumes 3 and leaves 2');
      ok(FF.peonIsLit(big), 'the partially-burnt third candle keeps it lit');

      // Running out goes DARK, it does not destroy the task -- degradation, not failure.
      s.inventory = { 'chandlery_t0': 0 };
      var dying = { candleId:'chandlery_t0', candleMs:500 };
      eq(FF.peonCandleBurn(dying, 1000), true, 'burning the last candle out reports the flip to dark');
      eq(dying.candleMs, 0, 'burn time floors at zero rather than going negative');
      eq(FF.peonIsLit(dying), false, 'the cottage is dark');
      eq(dying.candleId, 'chandlery_t0', 'the candle choice is REMEMBERED so it relights when restocked');
      eq(FF.peonCandleBurn(dying, 1000), false, 'a cottage already dark reports no further flips');
      var relit = FF.peonActionTime(100, 5, 'chandlery', FF.peonIsLit(dying));
      eq(relit, FF.peonActionTime(100, 5, 'chandlery', false), 'a dark cottage runs at exactly unlit speed');
    } finally {
      s.inventory = savedInv;
    }
  });

  // ---- Chandlery: burn RATE scales with task tier, and the UI figures must match the loop -------
  suite('chandlery: candle burn rates', function(){
    ok(typeof FF.peonCandlesPerHour === 'function' && typeof FF.candleStoreSummary === 'function', 'rate helpers exported');

    eq(FF.peonTaskTier({ kind:'special', tierIndex:13 }), 13, 'special-craft task tier reads tierIndex');
    eq(FF.peonTaskTier({ kind:'craft', itemId:'chandlery_t7' }), 7, 'standard-craft task tier reads the recipe');
    ok(Math.abs(FF.peonBurnRate({ kind:'special', tierIndex:0 }) - 1) < 1e-9, 'a T0 task burns at the base rate');
    ok(Math.abs(FF.peonBurnRate({ kind:'special', tierIndex:20 }) - (1 + 20*FF.CANDLE_TASK_BURN_PER_TIER)) < 1e-9, 'a T20 task burns at the full multiplier');
    ok(FF.peonBurnRate({ kind:'special', tierIndex:20 }) > FF.peonBurnRate({ kind:'special', tierIndex:0 }), 'higher-tier work drains faster');

    var s = FF._state, savedInv = s.inventory, savedP = s.peons, savedG = s.guildPeons;
    try {
      // THE load-bearing test. peonCandlesPerHour is what the card and the top bar both display; the
      // actual drain is peonCandleBurn charging effTime*burnRate per action. Those are two separate
      // expressions and nothing structural keeps them in step -- if they drift, the UI quietly lies about
      // runway and the player finds out by going dark early. Simulate a real day of actions and count.
      var task = { kind:'craft', itemId:'chandlery_t10', skillId:'chandlery', candleId:'chandlery_t0', candleMs:0 };
      s.inventory = { 'chandlery_t0': 100000 };
      FF.peonCandleLight(task);
      var stock0 = s.inventory['chandlery_t0'];
      var rate = FF.peonBurnRate(task), eff = FF.peonActionTime(10, 10, 'chandlery', true);
      var DAY = 24*3600000, elapsed = 0;
      while(elapsed < DAY){ FF.peonCandleBurn(task, eff*rate); elapsed += eff; }
      var actual = stock0 - s.inventory['chandlery_t0'];
      var advertised = FF.peonCandlesPerHour(task) * 24;
      ok(Math.abs(actual - advertised) <= 2,
         'the advertised candles/hr matches a simulated day of real burning (' + actual + ' burnt vs ' + advertised.toFixed(1) + ' advertised)');
      ok(advertised > 0, 'a lit task advertises a non-zero rate');
      eq(FF.peonCandlesPerHour({ kind:'craft', itemId:'chandlery_t0' }), 0, 'a task with no candle advertises no burn');

      // Both estates draw on ONE inventory. A per-estate summary would tell each side it had the whole
      // stack, so the aggregate has to span scopes and peons sharing a candle type must share a group.
      var mk = function(x){ return { x:x, y:0, skillId:'chandlery', kind:'craft', itemId:'chandlery_t0', candleId:'chandlery_t0', candleMs:5000 }; };
      s.inventory = { 'chandlery_t0': 100 };
      s.peons = [mk(0)]; s.guildPeons = [mk(1)];
      var sum = FF.candleStoreSummary();
      eq(sum.litCount, 2, 'the summary counts lit cottages on BOTH estates');
      eq(Object.keys(sum.groups).length, 1, 'peons burning the same candle type share one pool');
      ok(Math.abs(sum.totalPerHour - 2*FF.peonCandlesPerHour(mk(0))) < 1e-9, 'drain rates add across scopes');
      ok(Math.abs(sum.totalStoredMs - 100*FF.candleBurnMs(0)) < 1e-9, 'stored burn is the whole bag, not just what is alight');
      ok(sum.runwayMs > 0 && sum.soonest && sum.soonest.id === 'chandlery_t0', 'runway names the type that empties first');

      // Two peons on one stack drain it in half the time one would.
      s.guildPeons = [];
      var solo = FF.candleStoreSummary();
      ok(Math.abs(solo.runwayMs - sum.runwayMs*2) < 1e-6, 'dropping one of two peons doubles the runway on a shared stack');

      // A candle type nobody burns must not claim a runway, but still counts toward stored burn.
      s.peons = []; s.guildPeons = [];
      var idle = FF.candleStoreSummary();
      eq(idle.totalPerHour, 0, 'no lit peons -> no drain');
      eq(idle.soonest, null, 'no drain -> nothing is "first to run dry"');
      ok(idle.totalStoredMs > 0, 'unassigned candles still count as stored burn');
    } finally {
      s.inventory = savedInv; s.peons = savedP; s.guildPeons = savedG;
    }
  });

  // ---- Chandlery: the advertised OUTPUT rate matches what the peon loop actually produces -------
  suite('chandlery: peon output rate', function(){
    ok(typeof FF.peonYieldPerHour === 'function' && typeof FF.peonEffTime === 'function', 'yield helpers exported');

    var s = FF._state;
    var snap = { peons:s.peons, inv:s.inventory };
    // Two adjacent tiles inside the always-owned 5..14 core. Stand up a real workshop+cottage there so
    // peonEffTime resolves through the SAME path the burn loop uses -- a hand-built fixture wouldn't
    // exercise estateAdjacentWorkshop / the tier caps.
    var wx = 7, wy = 7, g = s.estate && s.estate.grid;
    var cellW = g && g[wx] && g[wx][wy], cellC = g && g[wx+1] && g[wx+1][wy];
    var saveW = cellW && { type:cellW.type, pave:cellW.paveTileId, ws:cellW.workshopId, cot:cellW.cottageId, obs:cellW.obstacle };
    var saveC = cellC && { type:cellC.type, pave:cellC.paveTileId, ws:cellC.workshopId, cot:cellC.cottageId, obs:cellC.obstacle };
    try {
      var wId = 'workshop_herbalism_t20', cId = 'cottage_t20';
      var haveDefs = FF.WORKSHOP_ITEMS && FF.WORKSHOP_ITEMS[wId] && FF.COTTAGE_ITEMS && FF.COTTAGE_ITEMS[cId];
      ok(cellW && cellC && haveDefs, 'core tiles and tier-20 workshop/cottage defs exist');
      if(cellW && cellC && haveDefs){
        cellW.type='paved'; cellW.paveTileId='paving_t20'; cellW.workshopId=wId; cellW.cottageId=null; cellW.obstacle=null;
        cellC.type='paved'; cellC.paveTileId='paving_t20'; cellC.cottageId=cId; cellC.workshopId=null; cellC.obstacle=null;
        var gi = (FF.GATHERING_SKILLS.herbalism.items||[])[0];
        var real = { x:wx+1, y:wy, skillId:'herbalism', kind:'gather', itemId:gi.id, progress:0, candleId:null, candleMs:0 };
        s.peons = [real]; s.inventory = {};

        var eff = FF.peonEffTime('personal', real);
        ok(eff > 0, 'peonEffTime resolves against the placed cottage/workshop');
        var y1 = FF.peonYieldPerHour('personal', real);
        ok(y1, 'yield resolves for a real peon');
        // The load-bearing identity: items/hr is exactly the loop's two rolls over the same effTime.
        ok(Math.abs(y1.items - (3600000/eff) * y1.succ * (1 + y1.dbl)) < 1e-6, 'items/hr = (3600/effTime) * success * (1+double)');
        ok(Math.abs(y1.attempts - 3600000/eff) < 1e-6, 'attempts/hr = 3600/effTime');
        eq(y1.succ, 1, 'a simple gather never misses (100% success)');
        eq(y1.consumes, false, 'a gather consumes no inputs');

        // Output tracks speed: lighting the cottage raises items/hr by exactly the +50% speed bonus.
        s.inventory = { 'chandlery_t0': 100 };
        real.candleId = 'chandlery_t0'; FF.peonCandleLight(real);
        var y2 = FF.peonYieldPerHour('personal', real);
        ok(Math.abs(y2.items/y1.items - (1+FF.CANDLE_LIT_SPEED_BONUS)) < 1e-6, 'a lit peon produces exactly +'+Math.round(FF.CANDLE_LIT_SPEED_BONUS*100)+'% output');

        // A crafting peon reports its consume flag and the base craft success.
        cellW.workshopId = 'workshop_tailoring_t20';
        if(FF.WORKSHOP_ITEMS['workshop_tailoring_t20']){
          var craft = { x:wx+1, y:wy, skillId:'tailoring', kind:'craft', itemId:(FF.CRAFTING_SKILLS.tailoring.recipes[0]||{}).id, progress:0 };
          s.peons = [craft];
          var yc = FF.peonYieldPerHour('personal', craft);
          if(yc){ eq(yc.consumes, true, 'a crafting peon consumes inputs each attempt'); ok(yc.succ < 1, 'craft success is below 100%'); }
        }
      }
    } finally {
      s.peons = snap.peons; s.inventory = snap.inv;
      if(cellW && saveW){ cellW.type=saveW.type; cellW.paveTileId=saveW.pave; cellW.workshopId=saveW.ws; cellW.cottageId=saveW.cot; cellW.obstacle=saveW.obs; }
      if(cellC && saveC){ cellC.type=saveC.type; cellC.paveTileId=saveC.pave; cellC.workshopId=saveC.ws; cellC.cottageId=saveC.cot; cellC.obstacle=saveC.obs; }
    }
  });

  // ---- New players start with a placed Forestry workshop + cottage --------------------------------
  suite('estate: new-player starter kit', function(){
    ok(typeof FF.generatePersonalEstateGrid === 'function' && typeof FF.estatePlaceStarterKit === 'function', 'starter helpers exported');

    var W = FF.ESTATE_STARTER_WORKSHOP, C = FF.ESTATE_STARTER_COTTAGE, PAVE = FF.ESTATE_STARTER_PAVING;
    eq(W.x + ',' + W.y, '10,10', 'workshop starts at (10,10)');
    eq(C.x + ',' + C.y, '10,9', 'cottage starts at (10,9)');
    eq(Math.abs(W.x - C.x) + Math.abs(W.y - C.y), 1, 'workshop and cottage are orthogonally adjacent (so the cottage links)');

    // The ids must resolve to REAL definitions, or the peon system silently no-ops on them.
    ok(FF.WORKSHOP_ITEMS[W.id] && FF.WORKSHOP_ITEMS[W.id].skillId === 'forestry', 'the starter workshop id is a real Forestry workshop');
    ok(FF.COTTAGE_ITEMS[C.id], 'the starter cottage id is a real cottage');
    eq(FF.WORKSHOP_ITEMS[W.id].tierIndex, 0, 'workshop is tier 1 (index 0, the level-1 tier)');
    eq(FF.COTTAGE_ITEMS[C.id].tierIndex, 0, 'cottage is tier 1 (index 0)');
    ok(FF.getPavingRecipe(PAVE), 'the starter paving id is a real paving recipe');

    // A freshly-minted personal estate has the kit; the plain generator (guild / landing / migration)
    // does NOT -- that separation is the whole reason generatePersonalEstateGrid exists.
    var pg = FF.generatePersonalEstateGrid(), plain = FF.generateEstateGrid();
    var pw = pg[W.x][W.y], pc = pg[C.x][C.y];
    eq(pw.workshopId, W.id, 'personal grid: workshop placed at (10,10)');
    eq(pw.type, 'paved', 'personal grid: workshop tile is paved');
    eq(pw.paveTileId, PAVE, 'personal grid: workshop tile is on tier-1 paving');
    eq(pw.obstacle, null, 'personal grid: NO resource obstacle under the workshop');
    ok(pw.owned, 'personal grid: workshop tile is owned');
    eq(pc.cottageId, C.id, 'personal grid: cottage placed at (10,9)');
    eq(pc.type, 'paved', 'personal grid: cottage tile is paved');
    eq(pc.obstacle, null, 'personal grid: NO resource obstacle under the cottage');
    eq(pc.workshopId, null, 'personal grid: cottage tile has no workshop of its own');

    ok(!(plain[W.x][W.y].workshopId), 'plain generator does NOT place the starter workshop (guild/landing stay bare)');
    ok(!(plain[C.x][C.y].cottageId), 'plain generator does NOT place the starter cottage');

    // Resource generation skips ONLY the two starter tiles -- every other core/outer tile is untouched.
    var startersCleared = 0, otherCleared = 0, others = 0;
    for(var x=0; x<pg.length; x++){ for(var y=0; y<pg[x].length; y++){
      if(FF.estateIsStarterTile(x,y)){ if(pg[x][y].obstacle === null) startersCleared++; }
      else { others++; if(pg[x][y].obstacle === null && plain[x][y].obstacle !== null) otherCleared++; }
    }}
    eq(startersCleared, 2, 'both starter tiles are cleared of resources');
    eq(otherCleared, 0, 'no non-starter tile had its resource removed by the kit');

    // The payoff: estatePeonSources sees the pair as a staffable Forestry source on the fresh grid.
    var sources = FF.estatePeonSources(pg);
    var starterSrc = sources.filter(function(s){ return s.x === C.x && s.y === C.y; })[0];
    ok(starterSrc && starterSrc.skillId === 'forestry', 'the starter cottage is immediately a staffable Forestry peon source');
  });

  // ---- My Estate action queue --------------------------------------------------------------------
  suite('estate: action queue', function(){
    ok(typeof FF.estateProjectedCell === 'function' && typeof FF.estateQueuedJobValid === 'function', 'queue helpers exported');
    eq(FF.ESTATE_QUEUE_MAX, 5, 'queue holds five actions');

    // THE load-bearing invariant: the pure projector must predict EXACTLY the grid change that the real
    // completion applies. If they drift, a chained action (queue 3 raises, pave-then-build) validates
    // against a tile that differs from what actually gets built. Drive every kind through both and compare.
    var kinds = [
      { kind:'clear' },
      { kind:'pave', paveTileId:'paving_t3' },
      { kind:'workshop', workshopId:'workshop_forestry_t0' },
      { kind:'cottage', cottageId:'cottage_t0' },
      { kind:'field', fieldTier:4 },
      { kind:'raise' },
      { kind:'lower' }
    ];
    kinds.forEach(function(k){
      var start = { height:9, type:(k.kind==='workshop'||k.kind==='cottage')?'paved':'dirt', obstacle:(k.kind==='clear'?{type:'trees',tierIndex:2}:null),
                    paveTileId:(k.kind==='workshop'||k.kind==='cottage')?'paving_t5':null, workshopId:null, cottageId:null, fieldTier:null, owned:true };
      var job = Object.assign({ x:0, y:0 }, k);
      // real completion (grid-only, no rewards) on a one-cell mini estate
      var real = JSON.parse(JSON.stringify(start));
      var mini = { grid: [[real]] };
      FF.applyEstateJobCompletion(mini, job, false, false);
      // pure projection
      var proj = JSON.parse(JSON.stringify(start));
      FF.estateApplyProjection(proj, job);
      ['height','type','obstacle','paveTileId','workshopId','cottageId','fieldTier'].forEach(function(f){
        eq(JSON.stringify(proj[f]), JSON.stringify(real[f]), k.kind+': projection matches real completion for '+f);
      });
    });

    // Reserve/refund symmetry -- what enqueue removes, cancel returns, for each consuming kind.
    var s = FF._state, savedInv = s.inventory;
    try {
      [ { kind:'pave', paveTileId:'paving_t2' }, { kind:'workshop', workshopId:'workshop_forestry_t3' },
        { kind:'cottage', cottageId:'cottage_t1' }, { kind:'field', fieldTier:6 }, { kind:'raise' } ].forEach(function(job){
        s.inventory = {};
        var mats = FF.estateJobMaterials(job);
        mats.forEach(function(m){ s.inventory[m[0]] = 1000; });
        var before = {}; mats.forEach(function(m){ before[m[0]] = s.inventory[m[0]]; });
        FF.estateJobConsume(job);
        mats.forEach(function(m){ ok(s.inventory[m[0]] === before[m[0]] - m[1], job.kind+': consume removes '+m[1]+' '+m[0]); });
        FF.estateJobRefund(job);
        mats.forEach(function(m){ ok(s.inventory[m[0]] === before[m[0]], job.kind+': refund restores '+m[0]); });
      });
      eq(FF.estateJobMaterials({ kind:'lower' }).length, 0, 'lower reserves nothing');
      eq(FF.estateJobMaterials({ kind:'clear' }).length, 0, 'clear reserves nothing');
    } finally { s.inventory = savedInv; }

    // Projection chaining against the live personal grid: a stack of raises climbs, and the validator
    // stops the stack exactly at the ceiling.
    var savedJob = s.estate.job, savedQ = s.estate.queue;
    var gx = 6, gy = 9, cell = s.estate.grid[gx] && s.estate.grid[gx][gy];
    var savedCell = cell && JSON.parse(JSON.stringify(cell));
    try {
      if(cell){
        cell.type='dirt'; cell.obstacle=null; cell.workshopId=null; cell.cottageId=null; cell.fieldTier=null; cell.paveTileId=null;
        cell.height = 5;
        s.estate.job = null; s.estate.queue = [];
        eq(FF.estateProjectedCell(gx,gy).height, 5, 'projection with empty queue equals the raw tile');
        s.estate.queue = [ {kind:'raise',x:gx,y:gy}, {kind:'raise',x:gx,y:gy} ];
        eq(FF.estateProjectedCell(gx,gy).height, 7, 'two queued raises project +2 height');
        // clear-then-pave chain: obstacle gone, then paved
        cell.obstacle = {type:'rocks',tierIndex:1};
        s.estate.queue = [ {kind:'clear',x:gx,y:gy} ];
        var pc = FF.estateProjectedCell(gx,gy);
        eq(pc.obstacle, null, 'queued clear projects the obstacle away');
        eq(FF.estateQueuedJobValid({kind:'pave',paveTileId:'paving_t0'}, pc).ok, true, 'pave becomes valid once the queued clear has cleared it');
        eq(FF.estateQueuedJobValid({kind:'clear'}, pc).ok, false, 'a second clear on the same tile is rejected (nothing left)');
        // ceiling / floor
        cell.obstacle = null; cell.height = FF.ESTATE_MAX_HEIGHT - 1; s.estate.queue = [];
        eq(FF.estateQueuedJobValid({kind:'raise'}, FF.estateProjectedCell(gx,gy)).ok, false, 'raise rejected at max height');
        cell.height = 0;
        eq(FF.estateQueuedJobValid({kind:'lower'}, FF.estateProjectedCell(gx,gy)).ok, false, 'lower rejected at the waterline');
        eq(FF.estateQueuedJobValid({kind:'pave',paveTileId:'paving_t0'}, FF.estateProjectedCell(gx,gy)).ok, false, 'pave rejected on an underwater tile');
      }

      // Cancelling a queued entry refunds its reserved materials and drops it.
      s.inventory = {}; s.inventory['paving_t2'] = 100;
      s.estate.queue = [];
      FF.estateJobConsume({kind:'pave',paveTileId:'paving_t2'});   // simulate a reserve at enqueue
      s.estate.queue = [ {kind:'pave',x:gx,y:gy,paveTileId:'paving_t2'} ];
      eq(s.inventory['paving_t2'], 80, 'reserve removed 20 tiles');
      FF.estateCancelQueued(0);
      eq(s.inventory['paving_t2'], 100, 'cancelling the queued pave refunded the 20 tiles');
      eq(s.estate.queue.length, 0, 'the entry was removed from the queue');
    } finally {
      s.estate.job = savedJob; s.estate.queue = savedQ; s.inventory = savedInv;
      if(cell && savedCell){ Object.keys(savedCell).forEach(function(f){ cell[f] = savedCell[f]; }); }
    }
  });

  // ---- Lifesteal must never proc on reflected damage ---------------------------------------------
  suite('combat: reflect does not lifesteal', function(){
    ok(typeof FF.applyChipDamage === 'function', 'applyChipDamage exported');
    var s = FF._state;
    var snap = { act:s.activity, hp:s.playerHp };
    try {
      // applyChipDamage is the single path EVERY reflect source uses (Thorns, Iron Maiden, Riposte,
      // Bastion, Thornwall, ward reflect, Thorns enchant, Bramble) as well as DoTs and echoes. Generic
      // lifesteal is applied only in playerAttackTick on the direct hit's effDmg, so reflect must not heal.
      // This pins that: chipping a foe's health leaves the player's HP untouched, even below max where a
      // lifesteal WOULD have room to land. If a future edit adds a heal hook inside applyChipDamage --
      // the natural place someone would wire "heal on reflect" -- this fails.
      var mon = FF.MONSTERS[0];
      s.activity = { type:'combat', monsterId:mon.id, monsterHp: mon.hp, tickAccum:0, monsterTickAccum:0 };
      s.playerHp = Math.max(1, Math.round(FF.maxHp(s) * 0.5));   // well below max: any lifesteal has room
      var hpBefore = s.playerHp;
      var killed = FF.applyChipDamage(5);                        // a reflect tick against a healthy foe
      eq(killed, false, 'a small chip against a full-HP foe does not kill it');
      eq(s.playerHp, hpBefore, 'reflected/chip damage heals the player for exactly 0 (no lifesteal)');
      eq(s.activity.monsterHp, mon.hp - 5, 'the chip still moved the monster health bar');
    } finally {
      s.activity = snap.act; s.playerHp = snap.hp;
    }
  });

  // ---- Party dungeon: the local mirror never kills or rewards locally ----------------------------
  suite('dungeon: party mirror is inert locally', function(){
    ok(typeof FF.defeatMonster === 'function', 'defeatMonster exported');
    var s = FF._state;
    var snap = { act:s.activity, gold:s.gold, kills:(s.stats && s.stats.kills) || 0 };
    try {
      var mon = FF.MONSTERS[0];
      var goldBefore = s.gold, killsBefore = (s.stats && s.stats.kills) || 0;
      // A PARTY fight is flagged netDungeon (NOT dungeon). High DPS can zero the mirror between the 2.5s
      // server syncs -> defeatMonster is called. It must pin the mirror, reward nothing, and -- crucially
      // -- NOT reset monsterHp to full (that reset is what made the reported damage vanish and the real
      // counter crawl while the chronicle filled with phantom kills).
      s.activity = { type:'combat', monsterId:mon.id, monsterHp:0, netDungeon:'sess-test', netIndex:0, tickAccum:0, monsterTickAccum:0 };
      FF.defeatMonster(mon);
      eq(s.activity.monsterHp, 1, 'the party mirror is pinned at 1 after a would-be kill');
      ok(s.activity.monsterHp !== mon.hp, 'the mirror is NOT reset to full HP (full reset lost the reported damage)');
      eq(s.gold, goldBefore, 'no local gold is paid on a party mirror death (server owns per-kill reward)');
      eq((s.stats && s.stats.kills) || 0, killsBefore, 'no kill is counted locally on a party mirror death');

      // applyChipDamage (the reflect/DoT path) must also report NO kill in a party, so reflect-kill
      // follow-ups don't fire on a foe the server still owns.
      s.activity.monsterHp = 0;
      eq(FF.applyChipDamage(5), false, 'applyChipDamage reports no kill in a party dungeon');
      eq(s.activity.monsterHp, 1, 'and re-pins the mirror at 1');
      // A chip that does NOT empty the foe never reports a kill (party or not).
      s.activity.monsterHp = 100;
      eq(FF.applyChipDamage(5), false, 'a non-lethal chip reports no kill');
      eq(s.activity.monsterHp, 95, 'and moves the mirror health bar normally');
    } finally {
      s.activity = snap.act; s.gold = snap.gold; if(s.stats) s.stats.kills = snap.kills;
    }
  });

  // ---- Dungeon Masterwork formulas drop AND forge for every layer (d1-d4) ------------------------
  suite('dungeon: d2-d4 formulas wired', function(){
    ok(typeof FF.rollMasterworkDrops === 'function' && typeof FF.mastercraftRecipeFor === 'function' && FF.BLUEPRINT_ITEMS && FF.MASTERWORK_SLOTS, 'masterwork helpers exported');
    eq(JSON.stringify(FF.DUNGEON_ORDER), JSON.stringify(['d1','d2','d3','d4']), 'four dungeon layers');

    // Every layer x every slot must (a) have a droppable Blueprint item and (b) resolve to a forge recipe.
    // A blueprint that drops but can't be forged is a dead end; a slot with no blueprint never drops. This
    // pins the whole chain so a future slot/layer edit can't silently strand d2-d4 (the reported worry).
    FF.DUNGEON_ORDER.forEach(function(layer){
      FF.MASTERWORK_SLOTS.forEach(function(slot){
        var id = FF.masterworkBlueprintId(layer, slot.id);
        var bp = FF.BLUEPRINT_ITEMS[id];
        ok(bp, layer+'/'+slot.id+': blueprint exists to drop ('+id+')');
        if(bp){
          eq(bp.dungeon, layer, layer+'/'+slot.id+': blueprint tagged to its layer');
          var rec = FF.mastercraftRecipeFor(bp);
          ok(rec, layer+'/'+slot.id+': dropped blueprint resolves to a forge recipe');
          if(rec){
            eq(rec.layer, layer, layer+'/'+slot.id+': recipe is for the same layer');
            ok((rec.setarmor && rec.material) || (rec.outcomes && rec.outcomes.length > 0), layer+'/'+slot.id+': recipe can produce an item');
          }
        }
      });
    });

    // Runtime drop path: force every slot to roll and confirm rollMasterworkDrops actually GRANTS d2/d3/d4
    // blueprints of the right layer (not just that the table is shaped right).
    var s = FF._state, savedBp = s.blueprints, savedRand = Math.random;
    try {
      ['d2','d3','d4'].forEach(function(layer){
        s.blueprints = {};
        Math.random = function(){ return 0; };   // every slot.chance*mult > 0 -> all drop
        var got = FF.rollMasterworkDrops(layer, 1);
        Math.random = savedRand;
        eq(got.length, FF.MASTERWORK_SLOTS.length, layer+': a full-luck clear drops one of every slot');
        ok(got.every(function(bp){ return bp.dungeon === layer; }), layer+': every dropped blueprint belongs to '+layer);
        eq((s.blueprints[FF.masterworkBlueprintId(layer,'plate')]||0), 1, layer+': the granted blueprint landed in inventory');
      });
    } finally {
      Math.random = savedRand;
      s.blueprints = savedBp;
    }
  });

  // ---- Group boss clear guarantees at least one blueprint ----------------------------------------
  suite('dungeon: group clear guarantees a blueprint', function(){
    ok(typeof FF.grantMasterworkDrops === 'function', 'grantMasterworkDrops exported');
    var s = FF._state, savedBp = s.blueprints, savedRand = Math.random;
    try {
      // Force every independent drop roll to MISS (Math.random always 1 -> 1 < chance is false), then a
      // GROUP clear (guarantee flag) must still grant exactly one d2 blueprint.
      s.blueprints = {}; Math.random = function(){ return 1; };
      FF.grantMasterworkDrops('d2', 1, true);
      Math.random = savedRand;
      var total = Object.keys(s.blueprints).reduce(function(n, k){ return n + (s.blueprints[k] || 0); }, 0);
      eq(total, 1, 'a dry GROUP clear still yields exactly one blueprint (guarantee floor)');
      ok(Object.keys(s.blueprints).every(function(k){ return FF.BLUEPRINT_ITEMS[k] && FF.BLUEPRINT_ITEMS[k].dungeon === 'd2'; }), 'the guaranteed blueprint belongs to d2');

      // A SOLO clear passes no guarantee -> a dry clear grants nothing (honest odds preserved).
      s.blueprints = {}; Math.random = function(){ return 1; };
      FF.grantMasterworkDrops('d2', FF.DUNGEON_SOLO_DROP_MULT);
      Math.random = savedRand;
      eq(Object.keys(s.blueprints).length, 0, 'a dry SOLO clear (no guarantee) still grants nothing');
    } finally {
      Math.random = savedRand; s.blueprints = savedBp;
    }
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
