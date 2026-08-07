# Pass 6: all 24 class ceilings re-measured under one build

Measured 2026-08-07 at `GAME_VERSION 0.0.86.48`. 24 of 24 completed, zero failures.
Each class at the window it was banded at (45s for 16, 90s for eight), Ruin cloak, the set layer
its own A/B picked, two sims concurrent.

**One pack per class.** This is a drift map, not a set of band knobs. Deriving a knob needs
mean-of-packs; confirming packs belong on the outliers, listed at the end.

| Class | Measured | Recorded | Drift | Window |
| --- | --- | --- | --- | --- |
| Berserker | 80.1B | 55B | **+46%** | 90s |
| Quickdraw | 129.5B | 90B* | **+44%** | 45s |
| Assassin | 164.9B | 118B | **+40%** | 45s |
| Duelist | 107.8B | 78B | **+38%** | 45s |
| Herald | 79.0B | 58B | **+36%** | 45s |
| Knight | 110.8B | 83B | **+33%** | 90s |
| Reaper | 100.6B | 76B | **+32%** | 45s |
| Treasure Hunter | 56.4B | 50B | +13% | 45s |
| Executioner | 96.1B | 90B | +7% | 90s |
| Plaguebearer | 88.5B | 83B | +7% | 45s |
| Pyromancer | 95.9B | 90B | +7% | 45s |
| Templar | 86.2B | 83B* | +4% | 90s |
| Sharpshooter | 93.4B | 90B | +4% | 45s |
| Sentinel | 59.8B | 60B | 0% | 90s |
| Juggernaut | 89.0B | 90B | -1% | 90s |
| Spellblade | 98.3B | 100B | -2% | 90s |
| Ranger | 75.4B | 77B | -2% | 45s |
| Frostwarden | 79.4B | 82B | -3% | 45s |
| Summoner | 40.8B | 44B | -7% | 45s |
| Lumen Oracle | 55.4B | 60B | -8% | 45s |
| Samurai | 78.4B | 85B | -8% | 90s |
| Voidshadow | 74.3B | 85B | -13% | 45s |
| Reaver | 64.8B | 78B | -17% | 45s |
| Thunderfury | 61.2B | 85B | **-28%** | 45s |

`*` Templar and Quickdraw recorded means are interpolated: CLAUDE.md lists only two of their four
legendaries with "between" for the others. Every other recorded figure is the stated four-way mean.

## What the table says

**The split is by rework AGE, and it is clean.** Every class drifting more than +30% was reworked
at v0.0.57 to v0.0.64: Berserker, Quickdraw, Assassin, Duelist, Herald, Knight, Reaper. Every
class reworked from v0.0.69 onward lands within ±8% of its target. That is the TIER WARNING's
prediction confirmed at scale, and it is also a quiet vindication of the banding method: the
mean-of-packs procedure adopted at v0.0.72 has held every class it was applied to.

**Seven classes are 32 to 46 percent over band.** They were measured on a `t19` weapon where the
harness now derives `t20`, and they predate the v0.0.68.0 DoT chassis fix, which CLAUDE.md
already warned had left several classes "materially stronger and NOT banded".

**Two classes read UNDER, and they are not the same case.**

- **Thunderfury at -28%** is the largest single miss, but the Stormlord is on record as the
  noisiest class measured (±25% same-config, 91 to 128B at one setting). A single pack cannot
  distinguish a real regression from its own variance. This needs two more packs before anyone
  touches it.
- **Reaver at -17% is the more concerning number**, because the Reaver is on record as the
  QUIETEST class measured (±3% same-config). A 17% miss on a class whose runs agree to 3% is
  unlikely to be noise. Both the measurement and the recorded 78B are at 45s, so this is not the
  window-sensitivity trap that class is known for either.

**The Assassin remains the outlier in kind, not just degree.** Its two-pack mean is 168.2B and
its drift is non-uniform across legendaries (+58% to +25%), which no single band knob resolves.
That is the open question for the per-class read.

## Confirming packs needed

In priority order: Reaver (quiet class, unexplained miss), Thunderfury (largest miss, noisiest
class), then the seven over-band classes before any knob is derived for them.

## Method note for the next run

Do not leave a shell whose command line contains the string `dpssim` alive while a driver waits
on `pgrep -f dpssim`. That deadlocked this sweep at launch and it measured nothing until the
stale process was killed. Match on the node invocation, or use a pidfile.
