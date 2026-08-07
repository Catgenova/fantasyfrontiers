# Comprehensive review: Phase 3, platform

In progress. Started 2026-08-07 at `GAME_VERSION 0.0.86.48`.

Pass 7 is server and data integrity, read as one system rather than file by file. Pass 8 is
client code health, Pass 9 UI and copy, Pass 10 the test coverage map.

## Pass 7: server and data integrity

### 7.1 Secrets: CLEAN

`build.mjs` gates `index.html`, but nothing gates the backend tree, so it was scanned by hand
with the same patterns the build guard uses: Discord webhook URLs, `sk-` keys, Turnstile secrets
by their length signature, and `service_role` literal assignments. Across all 15 edge functions
and all 80 migrations there are zero hits. Secrets live where the notes say they live, in
edge-function secrets and `public.app_config`.

### 7.2 The parked migrations: still correctly parked

`20260731120000` and `20260731140000` (the Password Verification Attempt hook, gated to the
Supabase Team and Enterprise plans) both still open with the not-deployed banner, and the
companion file still states that applying it alone grants schema usage and defends nothing. No
drift. They have not quietly become live.

### 7.3 RLS coverage: complete

41 tables are created across the migration history and all 41 have an `enable row level
security` statement. No table was added without one.

### 7.4 Permissive read policies: one worth changing

Six policies read with a bare `using (true)`. Four are fine on inspection: `guilds` and
`guild_members` back a public guild directory, and `dungeon_sessions` / `dungeon_members` are
scoped `to authenticated`.

**Finding: `chat_mutes` is world-readable and exposes more than the client needs.** The policy
is `for select using (true)` with no `to authenticated`, so anyone holding the publishable key
(which is public by design) can read the whole table. That table is:

```
user_id, muted_until, reason, muted_by, muted_at
```

`reason` is free text a moderator wrote, and `muted_by` identifies which moderator acted. Both
are readable by the entire internet.

What makes this straightforward to fix is that **the client never asks for those columns**. The
only read in `index.html` is:

```js
chatClient.from('chat_mutes').select('user_id,muted_until').gt('muted_until', ...)
```

So restricting the public policy to `user_id` and `muted_until` (a column-scoped grant, or a
view that exposes only those two, with the full table left to service-role and the mod panel)
closes it with no client change at all. `chat_roles` is world-readable too, but that one looks
intended: moderator badges render in chat.

This is not an account-takeover issue. It is moderation notes leaking, written by staff who
would reasonably assume they were private.

## Pass 10: test coverage map

### 10.1 The synchronous-suite trap: CLEAN

`suite()` is synchronous and discards its return value, so any assertion inside a `.then()` runs
after the report is written and a failure there is silently invisible. The suite contains no
`.then()` assertions at all. The single match in the file is a COMMENT explaining the trap and
saying that the test targets the synchronous mechanics instead, which is the correct pattern and
shows the rule is understood rather than accidentally satisfied.

### 10.2 Seam exports with no consumer

`seamcheck` reports 2,161 exported keys against 1,646 referenced by the tests and the sim, so
**515 seam keys are exported and never used**. `seamcheck` is one-directional by design: it
catches a referenced key that is missing, never an exported key that nothing wants. Most of that
515 is presumably harmless surface area, but finding 5 from Phase 2 came out of exactly this
gap: `equippedEnchantCount` is one of the 515, and it implements a banned scaling axis. The
number is recorded here as a place to look, not as a finding in itself.

## Pass 9: copy

### 9.1 Full string-literal sweep, beyond what the def-table guard reaches

The shipped guard deep-scans strings reachable from the seam's exported def tables. That leaves
runtime-built strings and non-exported tables unscanned, so every quoted string literal in
`index.html` was swept directly.

**Em dashes: five, all inside `PATCH_NOTES`, and all legitimate.** The guard excludes
`PATCH_NOTES` deliberately and says why at the definition: historical, owner-authored blasts
kept verbatim. Every one of the five sits in a July-dated entry, predating the v0.0.86.20 sweep.
So this is not a finding, and the sweep confirms the rest of the file is genuinely clean rather
than clean only where the guard happens to look.

**Emoji: zero real hits.** The 22 matches are all glyphs the owner rule keeps on purpose:
`✕` (close buttons), `☑` / `☐` (checks), `✶` (four-pointed star). My first scan flagged them
because its keep-list was narrower than the documented one, not because the copy is wrong.

**But the `PATCH_NOTES` exclusion is unbounded, and that is a finding.** It is correct in intent,
since rewriting shipped history to satisfy a later rule would be worse than leaving it. It is
wrong in scope: it excludes the whole table forever, so a NEW daily blast can introduce an em
dash and the suite will pass. The newest entries are dated Aug 4 and Aug 5, i.e. after the
sweep, so new entries are actively being written into an unguarded table. Bounding the exclusion
(skip only entries older than the sweep, by date or by index) keeps the history verbatim while
guarding everything written from now on.

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 6 | P2 | `chat_mutes` is world-readable via `using (true)` with no `to authenticated`, exposing moderator-written `reason` text and `muted_by` to anyone with the publishable key. The client only ever selects `user_id, muted_until`, so a column-scoped policy or a two-column view closes it with no client change. | Fix batch 3 to be drafted. Touches `supabase/`, so it is owner-deployed, not shipped by CI. |
| 7 | P3 | The em-dash guard excludes `PATCH_NOTES` entirely. Correct for the historical entries it was written for, but unbounded: entries dated Aug 4 and Aug 5 are being added to a table the suite never scans, so a new daily blast can reintroduce an em dash and still pass. Bound the exclusion by date or index instead of excluding the table. | Fix batch 4 to be drafted |

## Still to do in this phase

Pass 7: the rate limiter's real reach, the item ledger's two credit paths against the reconcile
formula, which detection signals are shadow-only and whether the week of clean signals that
would re-arm `PROGRESS_JUMP_AUTOENFORCE` has happened, and re-running the one-paste reproduction
at the bottom of `20260731180000` (the boot order is in scope after Phase 1 confirmed it).

Pass 8: dead code across ~2,200 functions, and the render path, where `#content` rebuilds up to
10x/sec and anything holding state in the DOM or allocating per rebuild is a bug waiting.

Pass 9: dark-marble sweep coverage, narrow-screen combat stage behaviour, and a copy sweep of
what the def-table scanners cannot reach (runtime-built template strings, HTML inside the
stylesheet).

Pass 10: plotting the 11,685 assertions against the systems from every phase to find what is
untested. Expected gaps are where the sim is also blind: kill-gated effects, block and
hit-taken channels, party and familiar interactions.
