# Phase 3, Pass 8 (client code health) and Pass 10 (coverage map)

Recorded 2026-08-07 at `GAME_VERSION 0.0.86.48`.

## Method

Every `function name(` declaration in the inline script was extracted (2,332 of them), then
counted against two regions separately: the game body, and the `window.__FF` seam block. A
declaration whose name appears once in the body (its own declaration) and nowhere else has no
game caller. Splitting the seam out is what makes the result useful, because it separates "dead"
from "alive only for the tests".

**Caveat, stated plainly:** a function reached by dynamic dispatch (a name held in a table, a
computed property) would look uncalled to this method. Five results were verified by hand and
all five were genuine, but the list below should be treated as a candidate set to confirm, not a
delete list.

## Pass 8: dead code

**10 functions are fully dead:** no caller, no seam export, no test.

```
isDungeonMonster            plaguebearerContagionMultLegacy   farmingLevel
maybeDropGrainSeed          maybeDropHerbSeed                 countTierMaterials
guildEstateRemain           reapOrphanGuildEstateJobs         renderCharacterPanel
renderLogPanel
```

Two of these are worth a second look rather than a straight delete. `renderCharacterPanel` and
`renderLogPanel` are render functions, so either a whole panel was replaced and its renderer left
behind, or they are reachable through the render dispatch and this method missed them.
`maybeDropGrainSeed` / `maybeDropHerbSeed` look like a farming drop path that was superseded.

**26 more have no game caller and exist only through the seam.** These split three ways, and the
distinction matters:

1. **Deliberate retirement stubs, correctly tested.** `rangerProcChance` returns 0 with the
   comment "retired with the arrow procs", and `d4SoulflameBurst` returns 0 with "retired:
   Soulflame now rides the Rot ticks". Each has a test asserting it still returns 0. That is a
   legitimate pattern: the test documents that a removed mechanic stays removed. Not a defect.
   Worth noting only that the codebase has two idioms for this (a zero-returning stub, or
   deleting the function and asserting `typeof FF.x === 'undefined'`, which `seamcheck` knows
   about). The stub idiom leaves a callable function in the shipped file forever.

2. **Orphaned helpers with live-looking bodies.** `d4BreathPct`, `pbPlagueDps`, `playerDotDps`
   all compute something real and nothing in the game calls them. `pbPlagueDps` is plausibly
   superseded by `pbPlagueSync`'s derive-don't-replace path, and `d4BreathPct` belongs to the
   Dragon's Breath pillar that classes have been leaving. Each needs a one-line check of whether
   the mechanic still reaches players by another route.

3. **Dead and untested**, including `equippedEnchantCount` (finding 5, the banned axis),
   `d2FeralOnCast`, `legDistinctEnchantCount`, `legShieldBashDamage`, `legFamiliarHasteMult`,
   `questAnyClaimable`.

## Pass 10: what the assertion count does and does not mean

The suite runs 11,685 assertions. That number overstates coverage in one specific, knowable way,
and it is the failure mode CLAUDE.md already warns about ("unit tests call effect functions
directly and can miss dead wiring", and the Assassin-gated Downbeat bug that the DPS harness
caught while the suite stayed green).

**About 20 of the 26 seam-only functions have tests.** For the retirement stubs that is correct
by design. For the rest, a test that calls a seam-exported function which no game code calls
proves the function COMPUTES correctly. It cannot prove the mechanic FIRES. Both pass forever
whether or not the wiring exists.

This is not an argument for deleting those tests. It is a statement about where the suite's
confidence is thinner than the raw number suggests, and it says exactly where to point Pass 6's
DPS harness, which measures behaviour end to end and is the only tool here that can tell a live
mechanic from a dead one.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 8 | P3 | 10 functions are fully dead (no caller, no seam, no test), including two render functions that suggest a replaced panel left its renderer behind. | Candidate set to confirm, then a delete batch |
| 9 | P2 | Three seam-only helpers compute live-looking values that nothing in the game calls: `d4BreathPct`, `pbPlagueDps`, `playerDotDps`. Each is either a superseded helper (harmless) or a mechanic that stopped reaching players (not harmless). They cannot be told apart without checking each. | Needs per-mechanic confirmation |
| 10 | P3 | Roughly 20 tests assert functions with no game caller. For the two retirement stubs that is correct by design; for the others the test proves the computation, never the wiring. The 11,685 figure overstates coverage by that much. | Recorded, no fix. Informs where to aim Pass 6 |

## Still to do

Pass 8's render path: `#content` rebuilds up to 10x/sec, so anything holding state in the DOM or
allocating per rebuild is a latent bug. The orb physics already live outside the DOM for exactly
this reason, and that pattern needs checking anywhere else state meets the rebuild.

Pass 10's full heat map: plotting assertions per system to find systems with none, rather than
per function.
