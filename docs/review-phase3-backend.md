# Phase 3, Pass 7 remainder: the backend items

Recorded 2026-08-07 at `GAME_VERSION 0.0.86.48`.

## Rate limiter reach

`rl_hit` is called by 12 of the 15 edge functions. The three without it:

| Function | Verdict |
| --- | --- |
| `guild_estate` | **Not a gap.** It is a decommissioned stub: every action is refused. It exists only as a redeploy-safe neutralized shell after the mint-into-the-guild-bank path was closed. Its `item_credit` mention is in a comment describing the old exploit, not live code. |
| `discord_link` | **Low risk.** Its one action is `cleanup_orphan`, which lets a usernameless Discord ghost session delete itself, and it refuses any account that has a username. The blast radius is deleting your own ghost. |
| `account_recovery` | **Partly covered, one real gap.** See below. |

Confirming the ledger picture: exactly two functions call `item_credit`, `guild_bank` and
`guild_estate`, and the latter refuses everything. So the live server-witnessed credit path is
`guild_bank` alone, and it is rate-limited.

## `account_recovery`: the answer path is protected, the lookup path is not

The answer-verification path is genuinely defended, and I checked rather than taking the header
comment at its word. `20260707020000_account_recovery.sql` really does implement it:
`account_recovery` carries `fail_count` and `locked_until`, and `recovery_verify` takes
`p_max_fail` and `p_lock_minutes` and returns a `locked` status. Bcrypt via pgcrypto, hashes
never returned. That is a lockout, not a claim of one.

**The gap is `get_questions`.** It takes a `username`, requires no auth, and returns that
account's security questions. It has no `rl_hit`, and the lockout counter guards answer
attempts, not question lookups. Two consequences:

1. **Username enumeration is free and unlimited.** A username either has questions or does not.
2. **The security questions themselves are disclosed to anyone who asks.** They are
   user-authored, so they leak whatever the player chose to write, and they are the input half of
   a secondary credential.

The lockout still limits guessing, so this is not a break. It is a free head start on the one
credential path that bypasses the password, and the fix is small: `rl_hit` on `get_questions`,
keyed on caller rather than username so enumeration cannot be spread across names.

## What cannot be answered from the repository

Two of the outstanding items need production, and I have no database access from here. Saying so
rather than guessing:

- **Has the clean week that would re-arm `PROGRESS_JUMP_AUTOENFORCE` happened?** The flag is
  still `false` at `save_game/index.ts:94` and the signal is still recorded with
  `would_clamp: false`, so the shadow mode is intact and correct. Whether the signals it has
  written since are clean requires reading `clamp_signals` in production. Old rows are separable
  by `not (detail ? 'rate_per_sec_pct')`, as the notes say.
- **The one-paste reproduction at the bottom of `20260731180000`.** It asserts live clock
  behaviour (12h to 25000, 1min to 833, 60 keys to 50 credited and 10 deferred) and needs a live
  database. Phase 1 confirmed the boot order it depends on is still correct, which is the
  precondition the notes name, so the reproduction is worth running but nothing suggests it will
  fail.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 13 | P2 | `account_recovery`'s `get_questions` is unauthenticated, username-keyed, and has no rate limit. It gives free username enumeration and discloses user-authored security questions, the input half of the password-bypass credential. The answer path's lockout does not cover it. | Fix batch 5 to be drafted: `rl_hit` keyed on caller. Touches `supabase/`, so owner-deployed |

## Not findings, recorded so they are not re-investigated

- The three functions without `rl_hit` are not three gaps. Two are structurally safe.
- `PROGRESS_JUMP_AUTOENFORCE` is correctly still in shadow.
- All 41 tables have RLS; secrets are clean across all 15 functions and 80 migrations (Pass 7 part one).
