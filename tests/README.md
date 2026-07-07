# Tests

Two layers:
- **Unit tests** (`selftest.js`) — pure game logic, run in the browser (below).
- **Integration tests** (`integration.sh`) — the live Supabase backend end-to-end (bottom).

## CI (GitHub Actions)

`.github/workflows/tests.yml` runs both on GitHub:
- **`unit`** — on every push and PR. Uses `tests/run-unit.mjs` to serve the repo and drive
  `index.html?selftest` in headless Chrome (Puppeteer's bundled Chromium), failing the job on any
  failed assertion.
- **`integration`** — on pushes to `main` + manual `workflow_dispatch` (skipped on PRs, since it
  creates live accounts). Reads optional `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` repo secrets;
  with none set it uses the built-in defaults (the publishable key is already public).

Run the unit harness locally with `cd tests && npm install && node run-unit.mjs`.

## Unit tests

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

## Integration tests (backend)

`integration.sh` drives the **real Supabase backend** (Edge Functions + SECURITY DEFINER RPCs +
RLS) with `curl` and asserts the actual JSON responses. Coverage:

- **Registration & auth** — register, duplicate/short-username/short-password rejection, sign-in token.
- **Guild lifecycle** — create, already-in-a-guild + duplicate-name rejection; open/close;
  apply → accept; roster promote/demote and leader-only enforcement.
- **Guild bank (items)** — slot count, deposit fills a slot, withdraw remainder, over-withdraw rejected.
- **Guild treasury** — donate, `buy_slot` and `spend_gold` deduct the coffers, leader `withdraw_gold`,
  over-spend → `code:"poor"`, withdraw-rank enforcement, members can donate but not buy slots.
- **Guild estate** — RLS (member reads the shared blob, non-member can't) + the optimistic
  version guard (guarded update succeeds once, a stale re-update matches no rows).
- **submit_profile** — valid accepted; `total_level != sum(skills)` and out-of-range skill rejected.

Run:

```
bash tests/integration.sh
```

Override the target with `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` env vars. Exits non-zero on
any failure. **Note:** it hits the live project and creates throwaway `it_<runid>_*` accounts; it
disbands the test guild (cascade cleanup) but Auth users can't be deleted with the publishable key,
so it prints the accounts it created for manual removal under Authentication → Users.
