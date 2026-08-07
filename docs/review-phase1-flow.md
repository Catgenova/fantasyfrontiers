# Comprehensive review: Phase 1, mechanics flow

In progress. Started 2026-08-07 at `GAME_VERSION 0.0.86.48`.

Phase 1 traces one player's path end to end and checks the HANDOFFS rather than the systems:
boot, offline catch-up, the main loop, the activity pipeline, combat entry, persistence, and the
server round trips. Ordering bugs live in seams, so each seam below is stated as an invariant
with the evidence that something enforces it.

## Seams verified

### S1. Boot order: offline catch-up must precede the item sync

**Invariant.** `applyOfflineProgress` must run before `itemSync`. The ledger's rate clock reads
`synced_at`, so a sync that fires first throttles a returning player's whole allowance.

**Verified.** `startGameOnline` awaits `initGame()`, which runs `readSave()` and then
`applyOfflineProgress(elapsed)` and a `cloudSave`, before the line that fires
`profileSync / leaderboardFetch / walletSync / itemSync(true)`. The await is what enforces it.
Correct as written, and the ordering is load-bearing rather than incidental, so it is worth a
regression test that does not currently exist. See the open items below.

### S2. Persistence shape: nothing is silently dropped

**Invariant.** A field written by gameplay must survive a save and reload.

**Verified.** `cloudSave` posts `{ data: state, ... }`, the whole state object, not a whitelist.
There is no per-field serializer to fall out of date, so the entire class of "new field added,
forgot to persist it" bugs cannot occur. `initGame` rebuilds with `Object.assign(newGame(),
loaded)` plus per-map re-assigns for `xp`, `physique`, tool and rarity maps, so a newly added key
gets its default and a loaded key wins.

**Consequence worth stating.** Because persistence is whole-state, anything parked on `state`
persists, including the per-combat-session engine ramps. That is the subject of S3.

### S3. Session ramps: what "session" actually means

**Invariant, as the code comments state it.** The Juggernaut's ground (`jgEchoes`,
`jgResonance`, `jgFury`), the Doomsayer's contract (`nbDoomBank`), the Sharpshooter's species
seams (`ssSeams`), the Sentinel's growth (`snGrowth`), the Executioner's ramps (`exTally`,
`exHone`, `exCarry`), the Oracle's radiance (`lmRadiance`) and about fifteen more "fall silent
between sessions" while carrying foe to foe within one.

**Verified.** `resetPersistentCombatBuffs()` clears all of them, and it is called from exactly
one place: `companionCastsOnCombatEntry(prevType)`, which returns early when
`prevType === 'combat'`. So a foe-to-foe transition keeps the ramp and any other transition
clears it. The design is sound and the single call site is why it stays consistent across 24
classes.

**But "session" here means a combat chain, not a login.** The save is whole-state and restores
`state.activity`, so a player who logs out mid-fight comes back with `state.activity.type ===
'combat'` and the next entry takes the early return. Every ramp survives the logout intact.
This is not obviously wrong: the ramps are all capped, and simply staying logged in achieves the
same thing. It is recorded as a question for the owner rather than a defect, because the code
comments say "between sessions" and a player would read that as "between logins".

### S4. Offline and live must not drift apart

**Invariant.** The away-window simulation must produce what the live loop would have produced.

**Verified, and by the strongest possible means.** `applyOfflineProgress` does not reimplement
combat. It calls the live `playerAttackTick()`, the live off-hand claw tick, the live
`monsterAttackTick()` and `autoEatCheck()`, stepping the same accumulators against the same
interval functions. The offline craft queue reuses the live effTime and consume logic. Parity is
by construction, so the usual drift class (a second simulation that slowly diverges) does not
exist here.

Two deliberate differences are documented in place and both are correct: passive HP regen is a
single lump away from combat but ticks per step during an offline fight, so a regen build does
not take a whole window of hits with nothing healing it; and guild peons and guild fields are
deferred to `guildPeonOfflineMs` / `guildFarmOfflineMs` because the shared grid is not loaded at
login, then drained by the main loop.

### S5. The wake path has no gap against the loop's own clamp

**Invariant.** Time away is credited exactly once, whether the tab was hidden or the loop simply
ran slow.

**Verified.** The loop clamps `dt` at 60,000ms per frame, and the `visibilitychange` handler only
credits when `awayMs > 60000`, so the two cover disjoint ranges with no double credit and no
hole. The handler stamps `_hiddenAtWall` at hide time rather than reading `lastTick`, advances
`lastTick` before the staleness peek so the resumed loop cannot re-credit the window in flight,
and bounds the credit by the server-witnessed absence.

### S6. One bad frame must not kill the simulation

**Verified.** `loop()` wraps `loopFrame()` in try/catch, logs once, skips the frame and
reschedules. `dt < 0` is clamped to 0 so a backward NTP step cannot run the simulation in
reverse. Both are the right shape: the failure mode being defended against is not the throw, it
is `lastTick` freezing and the next wake reading the frozen span as hours away.

### S7. Combat entry stamps the fight signature

**Invariant.** Every combat entry point stamps `duelStartedAt`, because the arena's foe-orb reset
keys on `monsterId + duelStartedAt`.

**Verified.** Seven stamp sites: normal `startCombat`, re-engage, solo dungeon, networked
dungeon, tower, guild boss, and the landing preview. That covers the five documented entry
points plus two added since. No entry point was found that omits it.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 3 | P3 | The S1 boot ordering is load-bearing and has no regression test. `seamcheck` cannot see it and the browser suite does not exercise boot. A reordering would silently throttle every returning player's item allowance, which is exactly the failure the ledger notes warn about. | Fix batch drafted, not applied |
| 4 | open question | S3: the combat-session ramps survive a logout taken mid-fight, because the save restores `state.activity.type === 'combat'` and the reset is gated on the previous type. Capped, so not exploitable as far as this pass can tell, but it contradicts how the code comments read. | Needs an owner decision |

## Still to do in this phase

The activity pipeline (gather, refine, craft, enchant, enhance, equip, class activation), the
task-slot queue at the 15-slot endgame cap, the dungeon and tower run lifecycles, quests, the
estate and farming loops, and the guild and marketplace round trips. The economy sink and source
map (Pass 3) has not started.
