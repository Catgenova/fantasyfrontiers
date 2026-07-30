# Fantasy Frontiers — project notes for Claude

## Game version (MANDATORY on every change)

The player-facing version lives in `index.html` as `var GAME_VERSION = '...'` (next to
`FF_BUILD_ID`). It is shown on the landing page footer and in the Settings modal.

Scheme: `launch.test.bigfeature.incrementalfix`

- **1st digit (launch)** — `1` at Game Launch. Currently `0`.
- **2nd digit (test)** — `1` = Alpha, `2` = Beta. Currently `0` (pre-alpha). Only the owner
  declares Alpha/Beta/Launch; when they do, the remaining digits reset (`0.1.0.0`).
- **3rd digit (bigfeature)** — increment when a distinct NEW player-facing system ships
  (a new gameplay system, a new dungeon layer, a new skill family, a major rework of a
  whole system, a new social/backend capability players can see). Resets the 4th digit to 0.
- **4th digit (incrementalfix)** — increment for each bug-fix / balance / QoL / display batch
  merged to main. One themed batch = one increment, even if it spans several commits.

Rules:
- **Every change merged to main MUST bump `GAME_VERSION` in the same commit** (feature →
  bump 3rd + reset 4th; fix/QoL batch → bump 4th). Never ship a change that leaves the
  version untouched, and never bump twice for one batch.
- Increments to a feature that just shipped (e.g. adding stats to the new Discord feed)
  count as the 4th digit, not a new 3rd-digit feature.
- Baseline: `0.0.33.4` was set on 2026-07-22 after a full-history audit (709 commits,
  33 big features since 2026-07-05; see the version-stamp commit for the feature list).

## Deploy pipeline

- GitHub Pages deploys ONLY on push to `main` (`.github/workflows/pages.yml`): obfuscated
  build → smoke test (runs the ?selftest suite, 8k+ assertions) → publish. A failed smoke
  skips the deploy.
- Local verification before pushing: `node scripts/typecheck.mjs`, `npm run build`, then
  run `scripts/smoke.mjs` (in this remote env, launch Playwright with
  `executablePath: '/opt/pw-browsers/chromium'`).
- Supabase edge functions / migrations under `supabase/` are deployed separately by the
  owner — flag it in your summary whenever a change touches them.

## Conventions

- The whole game is one file: `index.html` (~28k-line inline script, ES5-style `var` +
  `function`, no build-time modules). Match that style.
- Unit tests live in `tests/selftest.js`, run in-browser via `index.html?selftest` against
  the `window.__FF` test seam (exports at the bottom of index.html). Add regression tests
  with new fixes; the seam blanks `DISCORD_FEED_WEBHOOK` so tests never post to Discord.
- Discord community feed: `discordFeedPost()` in index.html mirrors Fantastic-rarity
  creations and +12-or-better enhances (with item stats) to the channel webhook; posts fire
  only from the acting player's client, including offline catch-up rolls.

## Max-ceiling DPS simulation (run after EVERY class rework)

`scripts/dpssim.mjs` measures real sustained DPS by booting the live game headless
(`?selftest` seam + the selftest-only `__FF._startLoop`), seeding a fully maxed state, and
fighting a zero-offense Archdemon (real dodge/armor) while sampling `act.monsterHp`.
Run: `SIM_MS=45000 PW_CHROMIUM=/opt/pw-browsers/chromium node scripts/dpssim.mjs`.
The harness is class-parametric: add the class to `BUILDS` (weapon base + per-style xp keys,
legendary keys, signets, unique-ring type) and run with `SIM_CLASS=<id>`. It A/Bs set layers
and cloaks automatically before the final legendary matrix. Recorded ceilings (v0.0.57.11
rules): **Summoner** (45s) Baton ~53B / Broodwyrm ~43B / Packbrand ~43B / Necrocaller ~37B;
**Assassin** (45s) Shadowwyrm ~125B ≈ Throatripper ~123B / Wraithclaw ~113B / Gloomstalker
~111B (set D3 Bloodrush); **Berserker** (90s — 9s swings need the longer window; Blood
Ledger held at cap via `primeLedger`, owner rule) Wrathscale ~82B / Deepquake ~53B /
Skullcleaver ~44B / Gravewrath ~40B (set D2 Steep Price/Debt Paid); **Duelist** (45s,
v0.0.58.2 final tune — owner target "60B band": Sidestep 6s, Riposte +10%, Afterimage 10%,
Untouchable 1%/s cap 15%, Danse every 6th, Wyrmdancer 2.5%/stack, Flame Waltz 1.5%/stack)
Wyrmdancer ~88B / Bloodwaltz ~78B / Phantomthrust ~74B / Gossamer ~71B (set D4 Flame
Waltz/Firestorm); **Reaper** (45s, v0.0.59.1 final tune — Rot 5%/stack/s, tick crits flat x2,
Soulflame +10% ch / +10% Fire rider, Soulflay eruption 50%) Deathshepherd ~89B / Wraithguard
~73B / Soulflay ~72B / Soulflame ~72B (set D4 Festerweave Festering/Gangrene — renamed from
"Carrion Shroud" in v0.0.60.0, it collided with the Plaguebearer D3 set name); **Quickdraw**
(45s, v0.0.60.0 — the FIRST bow class simmed, which exposed the bow chassis: an uncapped
fantastic quiver granted +253% ALL damage, and the quiver's offhand proficiency carried
weapon mastery — a second unbounded mastery channel the sim measured growing +8% per shot.
Chassis rebalance shipped with the rework: quiver dmgBonus capped at +25%, quivers excluded
from offhand weapon mastery, leather bow bonus 3%/slot (was 5%).
OWNER RULE (set after this rework): weapon RAW damage stats are never balance levers — the
bows' brief x0.85 (and arrow tracking) and the scepter's 0.58 dmgMult were reversed;
equivalent scaling must live in class perk variables. Kit tune: tricks +20% each from
Broadheads/Heavy Heads, riders 25% stronger, Piercer payback capped at 1x the hit,
Breathfang eruption 1.0x fire-scaled) Breathfang ~94B / Websnare ~85B post-revert
(Serpentcoil/Cryptvenom between; set D2 Rapid Reload/Dead Aim — the only class NOT won by its D4).
Sharpshooter and Ranger inherit the bow-chassis changes; re-measure them at their reworks.
Quickdraw sim notes: BUILDS needs offhandQuiver (equips the quiver + stocks 1e9 t19 arrows +
equippedArrow); the deterministic cycle makes runs cleaner than melee classes'; **Templar**
(90s — the 24s Litany macro-cycle; v0.0.61.2 final tune, the FIRST elemental-half weapon
simmed, which exposed the scepter chassis: the swing's Light half carried the full
Attunement/element-gear multiplier inside its advantage term — rings AND attunement, a
double-dip physical weapons don't get — and Gloria at 150%/stack x lightMult reached ~30
average hits per Amen; start 839B-1248B. Chassis rebalance: the light half keeps only the
elemental matchup, TPL_LITANY_SWING_MULT 0.58 — a Lv1 Litany mechanic, raw swings channel
42% less while chanting (replaced the briefly-shipped scepter dmgMult per the owner rule).
Kit tune: verses 12%, Doxology 3%/verse, Gloria 0.35 x avgHit/stack flat, Sunwyrm +15% vs
Dark, Sunburst +30%) Sunwyrm ~89B / Retribution ~77B at 90s,
Lichbane/Sunbrand between — the tightest legendary spread of any rework (set
D4 Solar Heart/Sunburst Zeal, ward slot fixed to Sunscale: Hallowlight/Sanctveil key off
ward reflects, which the zero-offense dummy never triggers, and Aegisveil is defensive).
**Thunderfury** (45s,
v0.0.62.1 — the FIRST full-elemental weapon simmed, completing the chassis trilogy: the wand
swing's Wand Attunement mods row carried the whole element-gear stack, x49 at BiS — two
fantastic +15 Rings of Earth alone are +4,800% elemental damage (0.50 base x8 rarity x6
enhance each). Start: 4.4-6.5T. Fix per the owner rule, all in class perk variables:
TF_STORM_SWING_MULT 0.32 (Stormseed channels raw swings 68% down; bolts scale off the
channeled hitAvg so one knob drives the whole kit) and Stormwyrm's Eye scales Bolts by
CLAMPED attunement only, never the gear stack. Pyromancer/Frostwarden/Nightblade/Lumen
wield wands and will hit the same x49 chassis at their reworks — budget for it. Kit:
bolts 6%/intensity/s, claps every 6th x2, Galvanize 8%/crit-bolt) Stormtomb ~93B /
Gloomstorm ~90B / Stormwyrm ~85B / Stormbrand ~71B (set D4 Galvanic/Stormwyrm's Eye,
ward fixed to Stormscale — Stormcoil/Voltveil/Stormveil are reflect/hit-taken keyed, dead
on the dummy). Stormlord runs are the NOISIEST recorded (±25% same-config: 91-128B at one
setting — crit-bolt and Galvanize ramp timing); always average 2-3 runs before tuning.
**Knight** (90s — the 6s claymore two-hander; v0.0.63.1, the FIRST class won by its **D2**
set layer: War Council's "standing Orders 50% stronger" beat every other layer by ~35% in
the A/B, because the Warlord's whole kit routes through the three Orders — a set that scales
the Orders scales everything. KN_DECREE_PCT is the single knob (Decree = Banner x pct x
recent-hit EMA); start 35% read 70-116B, 22% read 62-76B, final **25%**) Drakelance ~88B
(2-run mean 86.5/90.0) / Highbanner ~89B / Warbringer ~83B / Breachblade ~72B (set D2 War
Council, cloak Ruin). No new chassis risk — plain physical two-hander, like the Berserker's
warhammer. Sim-dead on the dummy: Rally (needs hits taken), Shieldwall (defense), Under One
Banner (party/familiars) — the sim measures the Steel/Pace/Decree core, which is where the
knob lives anyway. The Banner never lowers, so runs ramp once and hold (quieter than the
Stormlord's ±25%).
**Herald** (45s — the 1h mace; v0.0.64.1, the FIRST **tank** simmed and the first shield offhand
(`offhandShield` in BUILDS), owner target **~60B** — tanks band BELOW the 70-90B dps classes.
Two structural findings. (1) His whole kit keyed off BEING HIT, so it measured near-zero on the
zero-offense dummy; the fix is a self-driven **Brace** clock (every 5s, running the full Guard
path via `heraldGuardFire`, so a Brace counts as a Block for EVERY set/legendary/class effect) —
the Duelist Sidestep pattern, and the only reason the class is measurable at all. (2) The
**armour chassis**: BiS live Armor is ~**42.4 MILLION** (enchant-then-enhance compounds it), so
Ironclad's per-1,000 conversion computes to **x1,273** and is pinned at its cap — `PER_1K` NEVER
binds at BiS and `HERALD_IRONCLAD_CAP` is the only real lever (whole-kit DPS is linear in it:
cap 1.00 read ~70B, final **0.72**). Worse, Armor-scaled Retorts (25M) and a maxHp-scaled Breach
(0.8x one hit / 20s) were rounding errors against ~1e11 hits — the class's whole identity measured
as noise on "swings x2.5". Both now scale off the recent-hit EMA (the Bolt/Gloria/Decree channel)
and inherit armour scaling free, since the hits they average are Ironclad-boosted; the Breach reads
the WALL's fill (10 units full), not a share of max Health. Cave-In jumped 49.8B -> 70.3B once the
double Retort became real — proof the mechanics were dead before. Also: the Barrier banks a FRACTION
OF THE CAP per Guard (4 Guards fill it), never an Armor amount, which filled and Breached instantly
at every level. Sentinel and Treasure Hunter wear armour and carry shields — they hit this same
chassis at their reworks. Ceilings: Wallbreaker ~70B (2-run mean 65.9/73.4) /
Bastionbreaker ~59B / Cave-In ~54B / Tombshatter ~49B (2-run mean 43.7/54.2) — pack mean ~58B, i.e.
the class centers on the ~60B tank target with its best mace ~17% above it (set **D2** Momentum
Guard/Siegework, cloak Ruin, shield Bulwark of the Breach). Runs are noisy: ±12-24% same-config
(43.7-54.2B on one setting) — Brace/Breach phase against the swing timer; average 2 runs.
Sim-dead on the dummy: Bastion's hit cap, Unbreakable's mitigation, real Blocks, and Tombshatter's
Curse/Decay (hence its low read — it is the utility mace).
**Treasure Hunter** (45s — the 1h scimitar; v0.0.66.2 "the Reliquary", the FIRST class tuned to the **~50B**
band, deliberately below the dps classes because it is the farming class; also the first class whose engine
consumes an INVENTORY ITEM — Broken Relics as ammunition). Three findings. (1) The **scimitar chassis
overshoots the target unaided**: a Strike-disabled probe measured raw swing DPS at **~78B**, above the whole
band before the kit contributes anything, so per the owner rule the correction is a class perk variable —
`TH_SWING_MULT` **0.42** channels the class's own raw swings down and the Grave Strike scales off the
channelled hit average, so one knob drives everything (this is the third chassis to need the
TPL_LITANY_SWING_MULT / TF_STORM_SWING_MULT treatment). (2) The Strike **double-dipped crit**: it rolled the
full crit multiplier on top of `state.thHitAvg`, which is itself an average of post-crit hits — the single
biggest cause of the first reading (375B-995B). It is now a flat x2, as the Reaper's Rot ticks are. (3)
**Goldgorge was a runaway, not merely strong**: its gold-buys-charges line fed on a dragon's gold reward
(thousands per crit-pilfer) in a loop with the Strike's own gold scatter, reading 995B against a 449B field;
capped at ONE bought charge per swing it sits 1.24x the field. Also: the charge need went 8 -> **12** hits
because a BiS crit rate counts every crit as two, which made the Strike fire every ~2.5 swings (a per-swing
rider, not an event). Ceilings (D4 set, Ruin cloak, Luckshell offhand): Goldgorge ~54B (2-run 54.6/53.4) /
Cryptreaver ~52B / Gravepilfer ~47B / Greedwyrm's Claw ~47B — pack mean ~50B, i.e. dead on the target with
its best scimitar 8% above. The FIRST class won by its **D4** layer for a non-elemental reason: Wyrm's Greed
upgrades every relic you unearth one tier, and relic tier IS the Strike's damage, so the quality layer scales
the whole engine (D1 47B / D2 38B / D3 45B / D4 51B in the A/B). Noise is config-dependent and wide:
two greedwyrm runs on one setting read 51.0B and 60.4B (±18%) while two goldgorge runs read 54.6/53.4
(±2%) — the loaded relic tier wanders as Endless Vigil degrades relics a step and Wyrm's Greed re-upgrades
finds a step, so always average 2-3 runs. The crit-damage cloak reads unusually LOW (37.9B vs Ruin 60.4B)
precisely because the Strike's crit is a flat x2.
**Reaver** (45s AND 90s — the fast 1h half-moon axe; v0.0.67.1 "the Butcher's Count", owner target **80B**).
Opened by fixing a DEAD MECHANIC: the Bleed ticked for `stacks * combatLevelEquivalent * 0.04`, and
combatLevelEquivalent sums proficiency LEVELS — roughly **120 damage/sec** against BiS hits of ~1e11. The
class's whole identity was nine orders of magnitude too small to see, which is why the old Reaver was really
"a fast axe with a flat +25%". Re-based on the recent-hit EMA (`act.rvBleedHitAvg`), the Reaper's Rot channel.
Findings: (1) **the Count is RATE-limited, not ceiling-limited** — it never reaches its +120% cap inside 45s,
so **D4 came LAST** in the set A/B (119.3B vs D2's 227.3B) because its only contribution is raising that cap
to +180%, while everything that raises the carve RATE dominated (D2's two Cuts per stack-second, and
Marrowsplitter's double-value Cuts). D4 is close to a dead layer at 45s and only earns its keep in the long
fights this class is built for — expect the layer ordering to invert at 90s+. (2) The ledger is deliberately
**two numbers** — `rvCuts` (lifetime tally, drives the Count) and `rvBank` (harvestable pool). With ONE
number the Lv80 capstone is a runaway: a tally that never drops sits permanently above the Harvest threshold
and fires on every crit, and crits are ~100% at BiS. (3) Cuts accrue as **fractional stack-seconds**, not per
tick — the Bleed is a continuous DoT, so a per-tick count pays out differently at different frame rates.
(4) Marrowsplitter x D2 stack multiplicatively to a **4x** effective carve rate, which is why it sits 24%
above the pack mean; left alone as a BiS pairing (the Herald's best was 21% over its own mean).
`RV_SWING_MULT` **0.184** is the band knob (the axe opens wounds, the wounds kill; the Bleed, Count and
Harvest all scale off the channelled hit, so one number drives everything) — the FOURTH chassis to need the
TPL_LITANY_SWING_MULT / TF_STORM_SWING_MULT / TH_SWING_MULT treatment. Ceilings (D2 set, Ruin cloak,
Frenzyshell offhand): **45s** Marrowsplitter ~89B (2-run 85.9/91.2) / Gorewyrm's Edge ~84B / Bonereaver ~72B /
Bloodsupper ~69B — pack mean **~78B**, on target. **90s** Marrowsplitter **129B**, i.e. **+46% over its own
45s read** — the LARGEST window sensitivity of any class recorded (the usual mastery-training effect is ~35%),
because a fight-long ramp keeps climbing. Never compare a Reaver number against another class's without
matching windows. Runs are the QUIETEST recorded: **±3%** same-config (220.4B vs 227.3B), since the tally
climbs deterministically off bleed uptime rather than wandering like the Reliquary's relic tier (±18%).
Reaver sim notes: BUILDS needs `offhandShield: {type:'shieldSmall', leg:'frenziedguard'}`. Sim-dead:
**Bloodfrenzy** (D2 full) scales with MISSING health and the dummy never swings, so that half reads zero and
the D2 A/B UNDERSTATES the winning layer — its "two Cuts per stack-second" half is all the sim sees;
**Bonereaver**'s tally carry is kill-gated (the harness refills rather than killing), so it under-reads; and
every heal (Bloodsupper, Goreshell, Cauterize) is inert on a full HP bar.
Treasure Hunter sim notes: BUILDS needs `offhandShield: {type:'shieldSmall', leg:'fortunesriposte'}` and the
harness MUST zero every `BROKEN_RELIC_ITEMS` id in `st.inventory` between configs — the ammunition lives in
the inventory, so a later A/B otherwise opens with a stocked pack of top-tier relics and reads far too high.
The pack is seeded EMPTY (relics are consumables, owner rule) and the class bootstraps itself because a full
charge with no ammo DIGS a relic instead of firing — without that fallback the class would measure at zero
here, since the harness refills the dummy instead of killing it. Consequence: every KILL-gated line reads
dead — Cryptreaver's guaranteed drop, Gravepilfer's second relic and doubled Gravecoin, the Lv80 kill-refund
— so Cryptreaver and Gravepilfer UNDER-read their real value, and Hoardwall (needs a 100-relic hoard) is
unreachable in 45s from empty, which is why the shield slot is fixed to Luckshell. Gravecoin is a farming
number, not a DPS number; report it from a kill-cadence probe, never from this matrix.
Templar sim notes: BUILDS needs offhandWard; **measurement window matters** — mastery/
proficiency train during the run, so 90s runs read ~35% above 60s runs on identical code;
always compare a class against ceilings recorded at the SAME window (Berserker 82B @90s is
the Templar comparator; the 45s classes compare among themselves). Reaper caveats:
the zero-offense dummy keeps the Siphon Shield permanently full (flatters Wraithguard's
faster ticks and Spectral Edge), and the refilled pool means no kills, so Contagion (D1
full) measures dead. Duelist runs are the noisiest (~±25% — Danse/crit streak timing), and the
harness setup() now hard-resets session state between configs (companionCastsOnCombatEntry(null)
+ d4WrathReset) — continuously-refreshed buffs like Wrath otherwise leak into the next config.
Cloak: Ruin for every class so far. Caveats: runs are noisy (±20%); the zero-offense dummy keeps Vanish permanently
armed (flatters Assassin), keeps Berserker's HP bar full (flatters Wrathscale), and
ramp-speed legendaries (Gravewrath) measure at their floor when the ledger is primed.
Slow-swing classes: use SIM_MS=90000. The dummy HP pool is 1e15 with refill at 1e14 —
single ceiling hits exceed 1e12, which saturated the first Berserker run with kill resets.

**Pyromancer** (45s — the Fire wand; v0.0.69.2 "the Conflagration", owner target **90B**). Burn became one
**Blaze with fuel**: hits feed it, it ticks off the recent-hit EMA scaled by its SIZE, and it burns itself
down, so uptime is the skill. The crux was a **COMPATIBILITY SHIM** — ~15 effects outside the class read
`enemyBurning()`/`enemyBurnStacks()` (Rimewyrm vs Scorched, the Ranger's Fire Arrows, Cremation,
`d2BurnTickMult`, several wards, Ember Burst), so the pool NEVER replaces `act.burnStacks`; `pyBlazeSync`
DERIVES burnStacks/burnUntil/burnDps from the fuel after every change and the whole existing tick body works
untouched. **Any future engine that replaces a shared field must do this** or it silently kills a dozen
effects. Chassis: this is the SECOND class on the x49 wand stack; uncorrected it read **820B**, NOT the
trillions the Stormlord's 4.4-6.5T implied — that figure came from Bolts compounding THROUGH the element
stack, whereas the Blaze scales off a plain channelled hit average. So the x49 stack only explodes when a
kit's own damage feeds back through it; **Frostwarden / Nightblade / Lumen should be budgeted per-kit, not
assumed catastrophic.** `PY_SWING_MULT` **0.081** is the band knob. Ceilings (D2 set, Ruin cloak, Everburning
ward): Emberstorm ~105B / Cinderwyrm ~96B / Cindermaw ~85B / Pyresoul ~83B — pack mean **92B**, on target.
The legendary ORDERING is noise, not signal: it flipped almost completely between the 0.11 and 0.081 matrices
(Emberstorm last then first; Pyresoul second then last), because the four wands sit within ~±12% of each
other while same-session variance is ±8-15%. Do not claim a "best wand" for this class.
**FEED RATE BEATS CAPACITY (confirmed across two engines).** Pyromancer set A/B: **D2 140.0B** (Firestarter,
+50% fuel per hit) vs D4 86.8B / D3 86.2B / **D1 79.2B** (+30 capacity, LAST). Identical shape on the Reaver,
where doubling the Cut RATE dominated and raising the CAP was inert (D4 came last at 119B vs D2's 227B). The
cause is structural: a Lv80 engine CYCLES through its capstone eruption rather than sitting near its ceiling,
so capacity is largely dead weight. Design any future fuel/ramp bonus as a rate, not a cap — and note the
Pyromancer's D1 "+30 capacity" is close to a non-bonus at max level and wants revisiting.
**SIM VARIANCE RULE (learned the hard way, v0.0.69).** Consecutive runs of one config agree tightly (0.4%
apart), but the SAME config measured at different points in one browser session does NOT: D2+Ruin+Cinderwyrm
read 140.0B / 131.5B / 154.7B (±8%) across the set A/B, cloak A/B and legendary matrix of a single run. So a
single matrix CELL is never a sound basis for a band knob. Two misses came from ignoring this — deriving a
knob from a lone D1 probe (D1 being the weakest layer: overshot 51%), then scaling from the 154.7B cell (the
high end of the spread). **Always measure the full pack at each candidate knob**; it is slower and it is the
only method that has held up.

**DOT CHASSIS (fixed game-wide in v0.0.68.0).** Every damage-over-time in the game used to tick for a
fraction of `combatLevelEquivalent()` — a SUM OF PROFICIENCY LEVELS, ~600 at max — while BiS hits land at
~1e11. A fully-stacked Burn dealt roughly **150 damage/sec**: eight to nine orders of magnitude too small to
matter. Weapon Coatings, a whole crafting line, fed a mechanic that was mathematically invisible. Found while
reworking the Reaver (whose Bleed had it); an audit showed it hit EIGHT sites — Decay, toxin, coating,
Rotshell, Pyromancer Burn, Frostwarden Frostbite, Samurai and Ranger Bleeds. Only the Reaper's Rot and the
Reaver's Bleed were correct, both because their reworks re-based them. Everything now reads `dotBase(st)` =
the fight's recent-hit EMA (`act.dotHitAvg`, banked on every landed main-hand hit, UNGATED by class because
Decay/poison are consumed by far more classes than the one worn), with a fallback to the old level figure so
a DoT applied before your first hit still does something. Coefficients were recalibrated BY ROLE, not 1:1:
incidental/universal channels scaled down hard (Decay 0.03 -> **0.006**, i.e. ~6% of a hit/sec at its 10-stack
cap, because ~20 sources apply it onto already-banded classes; toxin t20 0.10 -> 0.03; coating t20 0.14 ->
0.045; Rotshell 0.15 -> 0.03), while identity channels kept their pct on the corrected base (Burn, Frostbite,
Samurai/Ranger Bleeds) since their owning classes are un-reworked and get banded at their reworks.
**Consequence to remember: Pyromancer, Plaguebearer, Ranger, Frostwarden and Samurai are now materially
stronger and NOT banded** — band them at their reworks. Verified no blowout on an already-banded class:
Herald + Tombshatter (its Curse+Decay were dead, which is exactly why CLAUDE.md called it "the utility mace"
and why it read lowest) went ~49B -> **61.2B**, lifting the Herald's runt mace to the middle of its ~60B tank
band rather than out of it. When adding any NEW DoT, scale it off `dotBase` and size it by role — never off
`combatLevelEquivalent`, and never 1:1 from an old coefficient.

**TIER WARNING (v0.0.64.9): every recorded ceiling above was measured with a ONE-BELOW-BiS weapon.**
Melee weapons + shields shipped with `tierCount:20` (top `t19`) while bows/wands/wards/scepter/staff had
21 (top `t20`) — the ticket-0116 off-kilter. Melee/shields are now 21 tiers too (top `t20`, Tungsten), and
the harness DERIVES the top tier via `legGearBaseTopTier()` instead of hardcoding it, so it can never drift
again. Two consequences: (1) every melee ceiling was measured on a t19 weapon and will now read HIGHER;
(2) the bow builds were ALWAYS one tier low (bows were 21 tiers while BUILDS said t19), so Quickdraw's
~94B/~85B is understated more than the melee classes'. Re-measure before comparing any new class against
these numbers, and never hardcode a tier in BUILDS.

The owner-approved best-in-slot rules (v0.0.57.11):

- **Every slot filled, all fantastic**: class weapon (legendary effect per config), full
  class D-set armor, legendary Shroud back (A/B Ruin / Warpack / Widow per class), 5 rings
  (legendary Signets for the class + unique rings for its scaling stat, e.g. Communion for
  familiar classes), amulet, unique t20 relic (+dmg%!), unique t20 belt.
- **Enchant THEN enhance is the intended min-max order** (owner-confirmed): give each
  unique its 4 max fantastic enchant lines FIRST, then `enhance: 15` — the +15 multiplies
  base AND enchant stats ×6. The enchant lock is one-directional (no NEW enchants after
  enhancing); never "fix" this stacking, it is by design.
- Max everything else: all `st.xp` keys Lv100 **plus the per-style weapon key** (e.g.
  `st.xp.staff` — accuracy reads the typeId, not the shared proficiency) and every
  `st.physique[id]` (separate map; accuracy/crit read it — misses read as 0 DPS otherwise).
- **NO consumables** (owner rule): no Catalyst/elixirs/potions, no Faith actives, no
  server-wide buffs.
- Familiars (when the class uses them): fill every slot, Lv100 + 3 stars.
- The harness caught the assassin-gated Downbeat bug — trust a 0-stat anomaly over the
  test suite; unit tests call effect functions directly and can miss dead wiring.
