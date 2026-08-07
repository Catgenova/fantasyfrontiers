# Pass 10: test coverage heat map by system

Measured 2026-08-07 at `GAME_VERSION 0.0.86.48`.

Every `function` declaration in the inline script was assigned to the section banner it falls
under, then checked for a direct `FF.<name>` reference in `tests/selftest.js`.

**This is a FLOOR, not a coverage measure.** A function exercised indirectly, by a tested
function that calls it, counts as untested here. So every number below understates real
coverage. What the table is good for is comparing systems against each other, where the same
bias applies throughout.

| Section | Functions | Directly exercised | Floor |
| --- | --- | --- | --- |
| FAMILIARS | 12 | 1 | 8% |
| GUILDS | 127 | 25 | 20% |
| DUNGEON RUNS | 72 | 18 | 25% |
| ONLINE-ONLY BOOT | 24 | 7 | 29% |
| CLOUD SAVES | 110 | 41 | 37% |
| RENDER: ESTATE | 248 | 93 | 38% |
| RENDER: COMBAT | 44 | 17 | 39% |
| RENDER: CRAFTING | 61 | 25 | 41% |
| DATA | 33 | 14 | 42% |
| RENDER: FAITH | 68 | 29 | 43% |
| RENDER: SIDEBAR | 56 | 24 | 43% |
| FAMILIAR AVATARS | 39 | 18 | 46% |
| HP ORBS | 17 | 8 | 47% |
| ESTATE | 10 | 5 | 50% |
| STATE | 106 | 53 | 50% |
| RENDER: NAV | 34 | 17 | 50% |
| PLAYER PROFILES + LEADERBOARD | 30 | 15 | 50% |
| HELPERS | 327 | 172 | 53% |
| LOADOUTS | 67 | 38 | 57% |
| DUNGEONS | 89 | 55 | 62% |
| ACTIONS | 125 | 82 | 66% |
| QUESTS | 30 | 22 | 73% |
| CLASSES | 467 | 345 | 74% |
| THE TOWER | 25 | 20 | 80% |

2,245 functions, 1,152 directly exercised.

## What it says

**The shape is exactly what the tooling predicts, and that is the useful part.** `CLASSES` is
the warmest large system at 74%, which is what constant reworking plus a regression test per fix
produces. The cold end is entirely server-coupled: Guilds, Dungeon Runs, Boot, Cloud Saves. The
browser suite is pure in-process logic against the seam, so anything that needs a backend cannot
be unit-tested here by construction.

**The gap that matters is where NEITHER tool reaches.** There are two behavioural safety nets:
this suite, and `dpssim.mjs`, which measures real behaviour end to end and is the only thing that
catches dead wiring. The DPS harness only drives combat. So the systems at the cold end have
neither: no unit coverage and no sim coverage, backed only by `integration.sh`, which runs
**nightly and on manual dispatch only, never on push or PR**.

Concretely, the largest untested surface in the game is **Guilds: 102 functions with no direct
test**, followed by **Cloud Saves at 69**. Both are systems where a regression costs player data
or player trust rather than just damage numbers.

**FAMILIARS at 8% (one function of twelve) deserves a separate note.** Familiar hit damage is
already known to follow a raw weapon-tier curve about seven orders of magnitude short at
best-in-slot, which is why the standing owner rule is not to re-base familiars. So the system
with the least coverage is also a system with a known, deliberately unaddressed scaling problem.
That combination is worth knowing before anyone touches it.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 11 | P2 | Guilds (102 functions) and Cloud Saves (69) are the largest surfaces with no direct unit coverage, and the DPS harness cannot reach them either. Their only automated cover is `integration.sh`, which never runs on push or PR. A regression in either lands in production having passed every gate that actually gates the deploy. | Recorded. The cheap half is moving a subset of integration checks onto PR; the real half is seam-testable extraction, which is a project |
| 12 | P3 | FAMILIARS sits at 8% direct coverage, on a system with a known scaling problem the owner has deliberately deferred. | Recorded, no action proposed |

## Caveat repeated

These are floors. A system can be well covered indirectly and still read low here. Use the table
to rank systems, not to claim any absolute number.
