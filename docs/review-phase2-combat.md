# Comprehensive review: Phase 2, combat and class mechanics

In progress. Started 2026-08-07 at `GAME_VERSION 0.0.86.48`.

Phase 2 runs the codebase's own accumulated laws over the combat engine as a checklist, rather
than re-deriving them per class. Pass 4 is per-class conformance, Pass 5 is shared-channel
integrity, Pass 6 is the measured ceilings (running separately).

This pass starts with the rules that can be checked MECHANICALLY across all 24 classes at once,
because those give hard answers. The per-class reading of kits comes after.

## Pass 4: conformance

### 4.1 Every damage source must reach the Combat log: CLEAN

The rule exists because `applyChipDamage()` applies damage and logs nothing, which left signature
mechanics invisible for years. Three live call sites remain that use it raw rather than through
`applyEffectDamage` / `applyEffectDot`:

| Site | What it is | Logged? |
| --- | --- | --- |
| Summoner Skeletal Wraith strike | `applyChipDamage(dmg); decayApply(...)` | Yes, `combatLogPush({dir:'fam', spName:'Necrotic Strike'})` on the next line |
| Familiar spell cast | the shared familiar damage path | Yes, `combatLogPush({dir:'fam', spName:spell.name, crit, detail})` |
| Offline familiar poison | inside `applyOfflineProgress` | No, and correctly so: there is no live log to write into during an away-window replay |

So the rule holds. Both live sites log through `combatLogPush` directly rather than through the
two wrappers, which is a different route to the same requirement, not a violation.

### 4.2 The never-scale axes: CLEAN in live code, one dead helper left behind

Four axes are banned because enchant-then-enhance pins them at best-in-slot.

| Axis | Result |
| --- | --- |
| Raw Accuracy | Clean. `playerAccuracy` has exactly three callers: `playerHitChance`, and two stat-display rows. No damage line reads it. The v0.0.82.0 Sharpshooter rework removed the conversions and nothing has crept back. |
| Raw Armor | Clean. The only armour-to-damage path is the Herald's `heraldIroncladMult`, and it is `Math.min(HERALD_IRONCLAD_CAP, ...)`. Capped, documented, accepted. Every other `getTotalArmorDefense` caller is defensive or display. |
| Enchant count/totals | Clean in live code, but see the finding below. |
| The foe's incoming hit | Not yet checked. |

**Finding: `equippedEnchantCount` is dead and still exported.** It has zero callers in
`index.html`, and the only reference anywhere else is a COMMENT in `selftest.js`; no test calls
it. It implements exactly the axis the v0.0.83.0 Spellblade rework banned ("never scale a line
by raw enchant count or totals"). Leaving a working, seam-exported implementation of a banned
axis in the file is how the axis comes back: a future rework reaches for the helper that already
exists and looks authoritative. `seamcheck` cannot catch this because it only checks that
referenced keys are exported, never that exported keys are used.

### 4.3 Flat crit on derived attacks: no violation found, but the check is partial

No line applies a crit multiplier to a `dotBase` or recent-hit-EMA derived value. Stated
honestly: that search is line-scoped, so a violation split across two lines would not show up.
This one needs the per-class reading to close properly, and it deserves the attention, because
at eleven recorded instances it is the single most repeated bug in the game.

## Pass 5: shared-channel integrity

### 5.1 The shared poison channel: CLEAN

The bug this checks for is real and shipped once: Toxins and coatings ASSIGNED
`potionPoisonDps` unconditionally while every other writer guarded, so a weak Toxin overwrote a
Plaguebearer's stronger poison.

Seven writers, and all seven are correct now:

- Six guard with the "only if stronger or expired" form: Rotshell, the Venomscale path, the
  Plaguebearer's own severity derive, Toxins, coatings, and the Quiverlord's Serpent rider.
- One writes unconditionally, and it is correct by construction: the Pestilence carry sits
  INSIDE the foe swap in `defeatMonster`, after the previous foe's poison has been cleared and
  using a value captured from the slain foe. There is nothing to clobber at that point.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 5 | P3 | `equippedEnchantCount` is a live, seam-exported implementation of a banned scaling axis with zero callers. Nothing prevents a future rework from wiring it back up, and `seamcheck` structurally cannot notice. | Fix batch 2 to be drafted: delete it and its seam export, or rename it with the ban stated at the definition. Owner's call which. |

## Still to do in this phase

The foe's-incoming-hit axis. The per-class reading of all 24 kits for conditions that cannot fail
at best-in-slot, rate/cap axis classification against engine type, and multi-line crit re-rolls.
The remaining shared channels: `act.burnStacks`, `bleedStacks`, Decay, Curse, Scorch,
`enemyDebuffCount`, and `dotBase` itself, each needing its full reader and writer list. Pillar
membership after the de-theming sweeps, including whether the Dragon's Breath pillar still has
enough clients to justify keeping.

The Assassin's non-uniform drift (Pass 6, baseline doc) is the first concrete question waiting on
this per-class reading: something favours three of its four legendaries and not the fourth.
