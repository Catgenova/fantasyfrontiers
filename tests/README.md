# Tests

The game is a single-file browser app (one IIFE in `index.html`, no bundler, no Node build),
so the unit tests run **in the browser** against a small test seam rather than via a Node runner.

## How it works
- Opening the game with the `?selftest` query flag exposes a curated set of **pure** functions and
  data tables on `window.__FF` (see the "Test seam" block near the end of the `index.html` script),
  and `index.html` then loads `tests/selftest.js`.
- `selftest.js` runs assertions against `window.__FF`, logs `SELFTEST: N passed, M failed` to the
  console, shows a pass/fail chip in the top-right corner, and leaves the full result on
  `window.__FF_SELFTEST` (`{ passed, failed, failures }`).
- None of this runs during normal play — the seam and loader are both gated on `?selftest`.

## Running
Serve the repo over http (file:// won't load the sub-script cleanly) and open:

```
http://localhost:PORT/index.html?selftest
```

Any static server works, e.g.:

```
python -m http.server 8080        # then open http://localhost:8080/index.html?selftest
```

Green chip / `0 failed` = pass. Failures are listed on the chip, in the console, and on
`window.__FF_SELFTEST.failures`.

## What's covered
Pure logic and data invariants: the XP→level curve, tier scaling (`tierXp/tierSell/tierTime`),
guild bank slot cost (kept in lock-step with the server RPC formula), estate expansion cost,
workshop bonus % + the tier-N-consumes-tier-N-1 upgrade chain, paving recipes (all Slabs, 2/3/4
by finish), the combat damage-type advantage triangle + weighting, estate obstacle yields,
duration formatting, and that `monster.xp` is fully sunset.
