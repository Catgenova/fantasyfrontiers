# Per-class read: three live flat-crit violations

Found 2026-08-07 at `GAME_VERSION 0.0.86.48`.

## Scope, stated honestly

A full-depth read of all 24 kits was not completed. This covers the one rule with the most at
stake, done properly across every class: the flat-crit rule, which at eleven recorded instances
is the most repeated bug in the game. The Phase 2 line-scoped grep could not close it; this pass
is function-scoped, slicing each top-level function body by brace matching and flagging any that
references BOTH a derived base (`dotBase(...)`, a `hitAvg` EMA) and a crit multiplier.

## The rule

Any effect scaling off a post-crit average must never re-roll the crit multiplier. The average
already contains crit, so rolling it again double-dips. The codebase applies this correctly in at
least eleven places and says so at each: the Reliquary's Grave Strike, the Reaper's Rot ticks,
the Ranger's Two as One, the Samurai's Draw-Cut, the Spellblade's afterimages, the Sentinel's
bloom, and more.

## The finding: three functions violate it

Four functions matched. `playerAttackTick` is the main hit pipeline, where crit legitimately
rolls. The other three are derived attacks and all three double-dip:

| Function | Class | The line |
| --- | --- | --- |
| `tfBoltFire` | Thunderfury | `dmg = inten * TF_BOLT_PCT * st.tfStormHitAvg` then `if(isCrit) dmg *= (CRIT_DAMAGE_MULT + ...)` |
| `heraldBreachFire` | Herald | `dmg = per10 * HERALD_BREACH_PCT * st.heraldHitAvg` then the same re-roll |
| `knDecreeOnSwing` | Knight | `dmg = knightStacks(st) * KN_DECREE_PCT * st.knHitAvg` then the same re-roll |

**All three averages are confirmed post-crit.** Each is banked inside `classOnHit(act, monster,
dmgToMonster, isCrit, ...)` as a 0.75/0.25 EMA over `dmgToMonster`, which is the LANDED damage
with `isCrit` passed alongside it, so the crit multiplier is already inside the value being
averaged. Verified for all three, not inferred from one.

## Why these three and not the others

The timeline explains it exactly, and it is not carelessness. Thunderfury shipped at v0.0.62.1,
Knight at v0.0.63.1, Herald at v0.0.64.1. The flat-crit rule was not yet a rule: it was
established at the Ranger rework, v0.0.70.1, which records itself as "now the THIRD instance"
and states the rule for the first time. Every class reworked after that applies it. These three
predate it and were never retrofitted.

## What it costs

`CRIT_DAMAGE_MULT` is 1.5, capped at 2.5 with bonuses, and at best-in-slot crit chance is
approximately 100%. So the double-dip is not an occasional spike: it is a permanent multiplier of
roughly **1.5x to 2.5x on each class's signature mechanic**, every time it fires.

This lines up with Pass 6. The Herald measured **+36%** over its recorded ceiling and the Knight
**+33%**, and in both kits the affected mechanic is central: the Breach is the Herald's capstone
payoff, and the Decree is the Warlord's whole engine (CLAUDE.md calls `KN_DECREE_PCT` "the single
knob"). A mechanism now explains two of the seven over-band classes, which is better than
attributing them to the tier change alone.

**Thunderfury does not fit that story and should not be forced into it.** It measured -28%, not
over. The Stormlord is the noisiest class on record (±25% same-config) and its bolts are the
entire kit, so both its drift figure and the effect of fixing this need their own measurement.
Do not assume the fix moves it down from where it was measured.

## Consequence for Pass 6

**Do not derive band knobs for the Herald or the Knight until this is fixed.** A knob fitted to
the inflated number would bake the double-dip into the balance and then need re-deriving. The
correct order is: fix the crit handling, re-measure both classes with two packs each, then band.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 14 | **P1** | `tfBoltFire`, `heraldBreachFire` and `knDecreeOnSwing` each re-roll the full crit multiplier on top of a confirmed post-crit hit average, inflating the signature mechanic of three classes by roughly 1.5x to 2.5x at best-in-slot. Three live instances of the game's most repeated bug, all predating the rule that bans it. | Fix batch 6 to be drafted: flat x2 in each, matching the Grave Strike and Rot tick precedent. Needs re-measurement after, not before |

## Not yet closed

The rest of the per-class read: conditions that cannot fail at best-in-slot, rate/cap axis
classification against engine type, and the Assassin's non-uniform drift and the Reaver's quiet
-17% miss, which remain open questions.
