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
