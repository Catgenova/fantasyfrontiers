# Comprehensive review: Phase 0 baseline

Recorded 2026-08-07 at `GAME_VERSION 0.0.86.48`, on `claude/fantasy-frontiers-review-plan-g6zedc`.

Phase 0 of the comprehensive code and mechanics review. Its only job is to establish that the
tree is green, that the guards gating the deploy actually guard, and that there is a measured
DPS reference to compare later findings against. Nothing here is a review finding about game
logic; those come from Phases 1 to 3.

## 1. Toolchain

Every gate run locally against a clean tree, in the order CI runs them.

| Gate | Result |
| --- | --- |
| `node scripts/typecheck.mjs` | clean: 315 diagnostics scanned, 0 high-signal, 38,335 lines of inline script |
| `npm run typecheck:functions` | clean: all 15 edge functions |
| `npm run seamcheck` | clean: 2,161 seam keys exported, 1,646 referenced by tests/sim, 0 missing; 128 `act.*` fields assigned, 108 cleared on a foe swap, 0 unexplained |
| `npm run build` | clean: 3 script blocks obfuscated |
| `npm run artcheck` | clean: 2/2 class icons + 20 stage frames serve and decode |
| `npm run smoke` | pass: selftest 11,685 passed / 0 failed against the obfuscated build |
| selftest against readable source | 11,685 passed / 0 failed, identical to dist |

The suite is **11,685 runtime assertions**. A grep of the assertion helpers in `selftest.js`
counts only ~5,977, because many assertions are generated inside loops. Use the runtime figure.

Both browser runs log two console errors on the selftest page, `ERR_CONNECTION_RESET` and
`ERR_TUNNEL_CONNECTION_FAILED`. Both are blocked Supabase calls in a sandbox with no backend.
`smoke.mjs` prints them and deliberately does not fail on them.

## 2. Guard proofs

Project rule: a guard must be proven to fail before it is trusted to pass. Each bug below was
reintroduced, the guard run, and the tree restored and verified clean. Nine for nine, exit 1.

| Guard | Bug reintroduced | Caught |
| --- | --- | --- |
| `build.mjs` secret scan | Discord webhook URL as a literal in `index.html` | yes, named the pattern |
| `build.mjs` fatal-pattern | `authRender()` inside the Turnstile success callback | yes |
| `seamcheck` check 1 | removed `ACCURACY_PHYSIQUES` from the `window.__FF` seam | yes, named the consumer at `tests/selftest.js:11927` |
| `seamcheck` check 2 | new `act.ffLeakMeter` written but never cleared on a foe swap | yes, named the writing line |
| `typecheck.mjs` | undefined identifier in `index.html` | yes, TS2304 |
| `typecheck-functions.mjs` | undefined identifier in `supabase/functions/wallet/index.ts` | yes, TS2304 |
| `artcheck.mjs` | class icon path pointed at a file that does not exist | yes, 404 |
| selftest copy guard | em dash in `CLASS_DEFS.0.blurb` | yes, named the field path |
| selftest copy guard | emoji in the same field | yes, named the field path |
| `smoke.mjs` (the deploy gate) | a genuinely failing assertion, run end to end | yes, `SELFTEST FAILED`, exit 1 |

`typecheck-functions` reports "0 total diagnostics scanned" when clean, which reads like a check
that is not running. It is running: the injected identifier was caught. The count is of
diagnostics, not of files.

## 3. Measured DPS reference

`scripts/dpssim.mjs`, 45s window, zero-offense Archdemon, Ruin cloak (it won both cloak A/Bs).
Single pack each unless noted. Pack means are the four-legendary average.

### Assassin, set A/B winner D3 (matches the recorded layer), TWO packs

| Legendary | Pack 1 | Pack 2 | Mean | Spread | Recorded | Drift |
| --- | --- | --- | --- | --- | --- | --- |
| Wraithclaw | 184.5B | 172.4B | 178.4B | 6.8% | ~113B | +58% |
| Throatripper | 169.7B | 186.9B | 178.3B | 9.7% | ~123B | +45% |
| Gloomstalker (`phantomassault`) | 158.4B | 160.2B | 159.3B | 1.1% | ~111B | +44% |
| Shadowwyrm | 156.2B | 156.9B | 156.6B | 0.4% | ~125B | +25% |
| **pack mean** | **167.2B** | **169.1B** | **168.2B** | **1.1%** | **~118B** | **+43%** |

The packs agree to 1.1%, far tighter than the ±20% recorded for this class, so this is a settled
number and not a noisy read. At 168.2B the class sits **1.77x the 95B midpoint** of the dps band.

Set A/B: D1 133.0B, D2 140.3B, **D3 157.6B**, D4 137.3B. Cloak A/B: Ruin 154.2B, Warpack 98.8B,
crit-damage 108.9B.

### Lumen Oracle, set A/B winner D1 (the recorded winner is D3)

| Legendary | This pack | Recorded in CLAUDE.md |
| --- | --- | --- |
| Gravelight | 54.5B | ~59B |
| Dawnwyrm | 52.8B | ~59B |
| Dawnbrand | 48.7B | ~59B |
| Gloompiercer (`aegisbreak`) | 47.7B | ~63B |
| **pack mean** | **50.9B** | **~60B** (target 60B) |

Set A/B: **D1 58.1B**, D2 49.1B, D3 50.0B, D4 52.4B. Cloak A/B: Ruin 61.3B, Warpack 34.3B,
crit-damage 34.1B.

### Reading these

The Assassin sits 43% above its recorded ceiling, confirmed across two packs. This is what the
TIER WARNING in CLAUDE.md predicts, and the Assassin is the most exposed class to it: its rework
(v0.0.57.11) predates the melee tier fix, so its ceiling was measured on a `t19` weapon where the
harness now derives `t20`, and it also predates the v0.0.68.0 DoT chassis fix.

**The drift is NOT uniform, and that is the finding.** A tier change alone would move every
legendary by about the same factor. Instead Wraithclaw gained 58% while Shadowwyrm gained 25%,
which inverted the ordering: Shadowwyrm was the recorded best and is now unambiguously the runt,
last in both packs. Something structural favours three of the four and not the fourth. That is a
mechanism question for the Pass 4 conformance read of this kit, not something to diagnose from
DPS totals.

**Practical consequence for Pass 6: one band knob will not fix this class.** Re-banding the pack
mean to 90B would put Shadowwyrm near 84B and the other three near 95B, preserving an inversion
the class was not designed around.

The Lumen pack reads about 15% under its recorded band, but its set A/B picked D1 where both
recorded packs picked D3, so this matrix measured a different config than the recorded one. That
is precisely the trap documented for the Sentinel, where a flipped A/B winner made two matrices
incomparable. Do not treat 50.9B as evidence the Lumen drifted; settle the layer first. It is
consistent with the recorded caveats that the wand matrix is flat within ±5% and that D1/D2/D4
must not be ranked.

Neither class shows a broken mechanic here. Both readings are about the recorded numbers being
stale or config-mismatched, not about the game being wrong.

## 4. Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | P3 | `scripts/smoke.mjs` launched Chromium with no `executablePath`, so the local verification step documented in CLAUDE.md could not run in any container where Playwright's browser download is skipped. `artcheck.mjs` and `dpssim.mjs` already took a `PW_CHROMIUM` override. | Fixed in v0.0.86.48 |
| 2 | P3 | `smoke.mjs` watches `pageerror` on the normal-boot page but not `console`, so a `console.error` during boot is invisible to the deploy gate. The selftest page is the reverse: console errors are collected and printed but never fail the run, correctly, since the sandbox has no backend. Making the boot page fail on console errors needs a network-error allowlist first. | Open, needs an owner decision |

## 5. Method notes for later phases

- Run the browser scripts with `PW_CHROMIUM=/opt/pw-browsers/chromium`.
- CLAUDE.md's ceiling tables use legendary **display** names; `BUILDS` in `dpssim.mjs` uses
  internal **keys**. `phantomassault` is Gloomstalker, `aegisbreak` is Gloompiercer. Check the
  mapping in `index.html` before reporting a name mismatch as a finding.
- The clone is shallow (50 commits), so `git log -S` cannot answer questions about when
  something was introduced. Treat the working tree as the only authority.
- Two sims can run concurrently: `dpssim.mjs` binds an ephemeral port.
