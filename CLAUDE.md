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
Waltz/Firestorm). Duelist runs are the noisiest (~±25% — Danse/crit streak timing), and the
harness setup() now hard-resets session state between configs (companionCastsOnCombatEntry(null)
+ d4WrathReset) — continuously-refreshed buffs like Wrath otherwise leak into the next config.
Cloak: Ruin for every class so far. Caveats: runs are noisy (±20%); the zero-offense dummy keeps Vanish permanently
armed (flatters Assassin), keeps Berserker's HP bar full (flatters Wrathscale), and
ramp-speed legendaries (Gravewrath) measure at their floor when the ledger is primed.
Slow-swing classes: use SIM_MS=90000. The dummy HP pool is 1e15 with refill at 1e14 —
single ceiling hits exceed 1e12, which saturated the first Berserker run with kill resets.

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
