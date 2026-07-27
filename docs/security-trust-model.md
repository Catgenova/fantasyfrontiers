# Fantasy Frontiers — trust model & the `Math.random()` question

Status: **accepted / by design** (2026-07-27). This documents where the game trusts the client,
why that is acceptable, and specifically why client-side `Math.random()` is *not* treated as a
fixable vulnerability. It is a developer reference, not a player-facing change.

## TL;DR

The game is **client-authoritative**: `index.html` runs the whole simulation in the browser and the
save blob is stored server-side largely verbatim. Therefore **no client-side change can secure
`Math.random()`** — the player owns the runtime and can override the RNG, patch the code, or edit the
save directly. Swapping `Math.random()` for a seeded or crypto RNG in the browser buys *zero* security.

The right question is not "can the roll be predicted/forged?" (it always can) but **"can a forged roll
reach anything of _shared_ value?"** The answer is: the shared economy is already gated server-side, and
the outputs that aren't gated (item rarity, enhancement, uniques, estate, buffs, familiars, combat wins)
are **non-tradeable and personal-only** — they affect the cheater's own save and nobody else. The one
residual with real shared impact is leaderboard rank from forged XP, which is partially — not fully —
covered today (see "Residual", below).

## What is authoritative server-side (a forged client roll cannot launder value through these)

| Client-rolled outcome | Shared value? | Server gate |
|---|---|---|
| **Gold** (drops, sale proceeds, transfers) | yes | `wallet` edge fn: `HARD_CAP` (1e15), per-window earn-rate limits, injection hard-clamp. `save_game` also clamps `data.gold` and `data.goldEarnedTotal` on every write (age-gated 500M ceiling for <7-day accounts). |
| **Item quantities** (gathering/crafting/drops) | yes (tradeable) | `items` ledger: `item_catalog` allowlist gates which keys can exist at all; per-item rate caps (`ITEM_PER_HOUR`/`ITEM_BURST`); one-time grandfather bounded by account age; single-item injection auto-clamp (`ITEM_INJECT_MIN_OVER`). |
| **Marketplace trades** | yes | `market_orders` store **`item_key` + numbers only** (price, qty). Names/icons/rarity are rebuilt client-side and never trusted. Sells debit / buys credit the item ledger; proceeds move through the wallet. |
| **Egregious XP forgery** | yes (leaderboard) | `save_game` derives `progress` from the submitted `xp`+`physique` (never a client-sent score) and clamps a fast jump: `≥ SIGNAL_PROGRESS_JUMP` (1e10) inside a `2s–120s` window trips `clamp_signals` + an auto `account_clamps` row (marketplace/leaderboard/guild/chat). |

Cross-cutting: `account_clamps` (auto-enforced) neutralizes a flagged account on the shared surfaces even
if a forged value slips into the save blob.

## Why item rarity / enhancement / uniques are *not* a hole

These live only in the save blob (`uniqueItems`, equipment slots). The **marketplace stores no rarity or
enhancement metadata** — it trades fungible item keys from the catalog allowlist and nothing else. So a
forged "Fantastic +15" has **no economic path to another player**: it can't be listed as anything other
than its base key, and its "value" is confined to the cheater's own combat numbers. Non-tradeable
forgery is a single-player concern in a game with no PvP, so it is explicitly out of scope.

## Residual (known, accepted for now)

- **Leaderboard rank via a _slow_ XP forge.** The progress-jump detector catches a large XP delta in a
  short window; a patient cheater who drips forged XP just under that line over many 8s save windows can
  still climb the board. Closing this means bounding XP growth by a per-elapsed-time **rate** rather than
  an absolute jump. Tracked as a possible future hardening; not fixed here.
- **Purely personal forgery** (estate structures, faith/HP, buffs, familiars, combat outcomes). Affects
  only the cheater's own experience; no shared/economic impact. Out of scope by design.

## Related known trade-offs (documented, intentional)

- **Session fencing is a correctness measure, not a security boundary.** A request omitting `session_id`
  is never fenced (rollout-safe by construction). It stops two *honest* live windows from double-crediting,
  not a crafted request. The economy stays guarded by the wallet/item ledgers regardless.
- **Rate limiters fail open.** `rl_hit` failures allow the request (`save_game`, `items`, others) so a
  limiter outage never locks players out. The hard clamps/ledgers remain the real bound.

## Decision

`Math.random()` is left as-is. It is not a securable primitive in a client-authoritative game, and the
values that would make a forged roll *matter to other players* are already gated by the wallet, the item
ledger + catalog allowlist, and a marketplace that trades only fungible item keys. The only shared-impact
residual is leaderboard XP (slow drip), noted above for a future, server-side rate-bound if we choose to
invest. No client-side RNG change would improve any of this.
