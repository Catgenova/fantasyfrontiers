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
  with new fixes; the seam sets `DISCORD_FEED_ENABLED = false` so tests never post to Discord.
  **`suite()` is SYNCHRONOUS and discards the return value** — assertions inside a `.then()`
  run after the report is written, so a failure there is silently invisible. Test async logic
  by its synchronous mechanics (e.g. a waiter-queue length), never by awaiting.
- **EVERY new damage source MUST show in the Combat log (MANDATORY on every class rework).**
  `applyChipDamage()` applies damage and logs NOTHING, so for years every rework's signature
  mechanic was invisible in the log — a player saw only weapon swings (ticket: "the damage of
  the skill Gloria is missing"). Use these instead, never the raw helper:
  - `applyEffectDamage(dmg, 'Name', {crit, detail, target})` — a DISCRETE hit: a proc, an
    eruption, a commanded strike, a reflect. One log row per call.
  - `applyEffectDot(dmg, 'Name')` — a per-FRAME DoT slice. DoTs tick every frame
    (`dps * dtMs / 1000`), so these AGGREGATE and emit one row per second ("Blaze ticks the foe
    for 4.1B over 1s"); logging per call would bury the 200-row buffer instantly.
  `detail` is only shown when the player has Advanced Combat Log on — pass the pipeline string
  for anything with a non-obvious multiplier chain. The names are player-facing: use the
  ability's own name ('Gloria', 'Storm Bolt', 'Grave Strike'), not the internal one.
  A rework is NOT done until each of its damage sources appears in the log.
- Discord community feed: `discordFeedPost()` in index.html sends a STRUCTURED EVENT
  (`{kind, name, item_key, rarity, enhance, stats}`) to the `discord_feed` edge function,
  which owns the webhook and composes the message. Fantastic creations + `+12`-or-better
  enhances, fired from the acting player's client including offline catch-up rolls.

## Auth, secrets, and the deploy guards (v0.0.72.4–.11, security tickets)

**NO CREDENTIAL EVER GOES IN `index.html`.** It is served to every player in clear text and
obfuscation does not hide a string. A pentest found the feed webhook as a literal there.
`scripts/build.mjs` now FAILS THE DEPLOY on Discord webhook URLs, `sk-` keys, `service_role`,
JWTs, and Turnstile SECRET keys (caught by LENGTH — site keys are ~24 chars, secrets ~34, and
both start `0x4A`). CI runs `npm run build`, so the guard gates publishing.

Where secrets actually live: **edge-function secrets** (`DISCORD_FEED_WEBHOOK`,
`TURNSTILE_SECRET`) or **`public.app_config`** (key `clamp_webhook`, read by
`discord_notify()`/`notify_clamp_discord()`, RLS-locked, service-role only). Never hand the
owner SQL or code with a real secret baked in — write a placeholder they fill in themselves.
The community feed and the moderation/clamp webhook are SEPARATE; point the clamp one at a
private channel (it posts usernames beside cheat signals).

**Password spraying: CAPTCHA is the answer, and the four attempts it took are worth knowing.**
1. Watching `auth.audit_log_entries` — impossible, GoTrue emits **no failed-login action**.
2. The **Password Verification Attempt hook** — implemented and correct, but **gated to the
   Supabase Team/Enterprise plan**, so it is INERT here. Migrations `20260731120000` +
   `20260731140000` are kept UNAPPLIED with that stated at the top. Do not propose it again
   without an upgrade. (Its schema grant was also missing: GoTrue calls hooks as
   `supabase_auth_admin`, which needs `grant usage on schema public` — a permission failure
   happens BEFORE the fail-open handler runs, so enabling it without that grant breaks LOGIN.)
3. An edge-function login proxy — **pointless**: login goes straight to GoTrue's token
   endpoint, so anything in front of it is skipped by calling that endpoint directly. The same
   reason `public.rl_hit()` (which guards every custom function) cannot see login at all.
4. **Cloudflare Turnstile** — shipped and live. Enforced INSIDE GoTrue, so it cannot be routed
   around. `CHAT_CONFIG.turnstileSiteKey` gates the client (empty = fully inert).

Turnstile rules learned the hard way, both of which caused live outages:
- **Tokens are SINGLE USE.** Registration needs **two**: `register` spends one at siteverify,
  then GoTrue spends another on the `signInWithPassword` that follows. Reusing one created the
  account and then refused the sign-in ("username already taken" on retry). Hence
  `captchaAwaitToken()` + a widget reset between the two.
- **NEVER call `authRender()` from a Turnstile callback.** `renderLoginGate()` rebuilds the
  gate's innerHTML, which destroys the widget, which `turnstileMount()` re-creates, which
  challenges again — an infinite loop showing as a box stuck on "Verifying...". Nothing in the
  gate reads the token (the submit button holds-and-resumes), so no render is ever needed.
  `build.mjs` gates on this too.
- `register` must verify the token ITSELF: it mints users via the **admin API**, which bypasses
  GoTrue's signup CAPTCHA entirely. It **fails closed** (unlike the rate limiter, which fails
  open) — otherwise breaking the verifier switches the check off.
- Discord OAuth login is unaffected by CAPTCHA (not a password grant), so it is the fallback
  when a password path is broken.

**`npm run typecheck:functions`** (`scripts/typecheck-functions.mjs`) typechecks every
`supabase/functions/*/index.ts` — added because they had NO checking, which let a `body`
reference to a nonexistent variable ship and break every registration at runtime. In CI ahead
of the build. `scripts/typecheck.mjs` covers `index.html` ONLY.

**A GUARD MUST BE PROVEN TO FAIL BEFORE IT IS TRUSTED TO PASS.** Twice this session a new check
reported clean because it was not really checking, and once a guard matched ITS OWN COMMENT
(the one naming `authRender`) and failed the build on correct code. Always reintroduce the bug,
confirm exit 1, then restore.

## The item ledger (v0.0.74.x, AndJustice4All ticket)

`public.player_items` is the authoritative stock and it GATES the marketplace and the guild bank
(`item_debit` in `marketplace/index.ts` and `guild_bank/index.ts`). Exactly two functions raise `qty`:
**`item_sync`** (client-reported inventory) and **`item_credit`** (server-witnessed: market buy, bank
withdraw, refunds). Client-side, `itemReconcile` = `max(0, min(local, server + pending + drift))` with
`pending = max(0, localEarned − serverEarned)`, so adoption can only ever REMOVE items, never create them.

**The reported exploit** was one line: `if prev = 0 then allowed := p_burst` gave a never-held key the whole
25,000 burst with no elapsed-time requirement, x 2,000 keys per call = 50 million items per request, and it
was invisible to the injection detector (which fires on the DENIED amount, and 25,000 against an allowance of
25,000 denies zero). Fixed in `20260731180000` by putting the first-seen grant on the account's own
`synced_at` clock plus a 50-new-keys-per-sync cap. **Verified on production**: 12h clock → 25000, 1min clock
→ 833, 60 keys → 50 credited / 10 deferred. The one-paste reproduction lives at the bottom of that migration;
re-run it after any change to `item_sync`, `ITEM_PER_HOUR`/`ITEM_BURST`, **or the boot order** — the clock
reads `synced_at`, so a sync that fires before `applyOfflineProgress` would throttle returning players.

**PER-CLASS CAPS ARE THE WRONG SHAPE — the owner caught this, and the arithmetic is why.** An endgame account
runs `MAX_TASK_SLOTS = 15`; weapons/tools are `tierTime(7,0.3,i)` (7s at t0); at 50% action time with the
workshop double-craft that is legitimately ~370,000 of ONE key per 12h offline window (~2M at the
`toolSpeedMultiplier` floor of 0.1), of which ~590 are fantastic at the 0.0016 cap. Any equipment cap low
enough to catch injection stops a legitimate mass-crafter from selling their own output. The RATE was never
the problem: 50,000/key/hour already sits above the legitimate 16–30k.

**`earned_total` means ACQUIRED BY ANY ROUTE, not crafted.** `item_credit` accrues it too, so a player who
BUYS fantastic gear is indistinguishable from one who mints it — and it is LIFETIME and monotonic, so it
mixes rarity-rate eras and pre-nerf holdings trip any current-rate threshold forever. A fantastic-share
signal run live flagged the real injection AND two rows belonging to Valuren, an active bug reporter.
Hence `20260731200000`: judge a DELTA against a snapshot table (`item_earn_watch`), subtract what the server
witnessed (`item_credit_log`), and ship it **shadow-only**. `item_credit`'s signature must NOT change —
adding a `p_source` default arg creates an OVERLOAD and makes the existing 3-arg calls from market
settlement and bank withdrawal ambiguous.

Still open by design: earning is client-reported because the server does not simulate crafting. Batch-validated
server-side crafting is the real fix and is a separate project.

## "Progress" IS damage, so every class rework tightens the anti-cheat thresholds (v0.0.75, Valuren)

`save_game`'s `deriveProgress()` sums every `xp` and `physique` value, and **class XP is awarded 1:1 with combat
damage dealt** (`awardClassXp(effDmg)` → `addXp(id, effDmg)`). So the stored "progress" score is a POWER metric
and **progress-per-second is approximately the player's DPS**. Consequences to keep in mind permanently:

- **Every DPS increase raises every player's progress rate.** The reworks moved ceilings to 80–90B and the
  v0.0.68.0 DoT fix lifted several unbanded classes, so anything calibrated in absolute progress units silently
  goes stale each time we ship a class. Re-check absolute thresholds after any balance work.
- **An absolute threshold always clamps your STRONGEST player first**, because their legitimate absolute numbers
  are the largest. That is exactly what happened: the 1e10-per-window progress-jump detector auto-clamped
  Valuren, the highest-level account, twice in one day out of marketplace/leaderboard/guild/chat. His real rate
  was 2.09e9 and 1.70e9 progress/sec — he crossed a 1e10 line in **under five seconds of ordinary combat**, and
  only the one-signal-per-hour audit rate-limit stopped it firing on every 8-second save.
- **The threshold's calibration comment was true in every clause and wrong in its conclusion.** It reasoned from
  `submit_profile`'s per-action caps (gather ≤8k, craft ≤200k) to "a legit 120s window accrues ~1e6-1e7, 1000x
  under this line" — and never mentioned combat, which is uncapped by design. The superseded text is kept in the
  function with that noted, because the failure mode is *enumerating the channels you thought of*.
- **The fix is the item ledger's shape: judge a delta against the account's OWN scale.** A jump must clear the
  absolute floor AND `prev_progress × 5%/s × elapsed`. Because progress accumulates at the combat rate, the
  fractional rate is ~`1/t` for t seconds of cumulative combat, so one number is scale-invariant. Valuren's real
  jumps clear by 23x/30x; a save that merely DOUBLES progress is still caught 2.5x over. Thin case, deliberately
  left documented rather than papered over: a sudden BiS power jump briefly outruns accumulated XP (~2.5x
  headroom at 10x Valuren's rate).
- `PROGRESS_JUMP_AUTOENFORCE` is now **separate from `CLAMP_AUTOENFORCE` and starts FALSE** — two confirmed false
  positives against an active player earns shadow mode until a week of signals reads clean. Old signal rows are
  identifiable by `not (detail ? 'rate_per_sec_pct')`; keep them, they are the evidence.
- **The durable version of this signal is server-witnessed, not threshold-based** (same conclusion as the item
  sweep): compare a save's progress delta against what the server actually saw happen. Until that exists, any
  number here needs re-checking after every balance change.

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
Waltz/Firestorm); **Reaper** (45s, v0.0.59.1 final tune — Rot 5%/stack/s, tick crits flat x2,
Soulflame +10% ch / +10% Fire rider, Soulflay eruption 50%) Deathshepherd ~89B / Wraithguard
~73B / Soulflay ~72B / Soulflame ~72B (set D4 Festerweave Festering/Gangrene — renamed from
"Carrion Shroud" in v0.0.60.0, it collided with the Plaguebearer D3 set name); **Quickdraw**
(45s, v0.0.60.0 — the FIRST bow class simmed, which exposed the bow chassis: an uncapped
fantastic quiver granted +253% ALL damage, and the quiver's offhand proficiency carried
weapon mastery — a second unbounded mastery channel the sim measured growing +8% per shot.
Chassis rebalance shipped with the rework: quiver dmgBonus capped at +25%, quivers excluded
from offhand weapon mastery, leather bow bonus 3%/slot (was 5%).
OWNER RULE (set after this rework): weapon RAW damage stats are never balance levers — the
bows' brief x0.85 (and arrow tracking) and the scepter's 0.58 dmgMult were reversed;
equivalent scaling must live in class perk variables. Kit tune: tricks +20% each from
Broadheads/Heavy Heads, riders 25% stronger, Piercer payback capped at 1x the hit,
Breathfang eruption 1.0x fire-scaled) Breathfang ~94B / Websnare ~85B post-revert
(Serpentcoil/Cryptvenom between; set D2 Rapid Reload/Dead Aim — the only class NOT won by its D4).
Sharpshooter and Ranger inherit the bow-chassis changes; re-measure them at their reworks.
Quickdraw sim notes: BUILDS needs offhandQuiver (equips the quiver + stocks 1e9 t19 arrows +
equippedArrow); the deterministic cycle makes runs cleaner than melee classes'; **Templar**
(90s — the 24s Litany macro-cycle; v0.0.61.2 final tune, the FIRST elemental-half weapon
simmed, which exposed the scepter chassis: the swing's Light half carried the full
Attunement/element-gear multiplier inside its advantage term — rings AND attunement, a
double-dip physical weapons don't get — and Gloria at 150%/stack x lightMult reached ~30
average hits per Amen; start 839B-1248B. Chassis rebalance: the light half keeps only the
elemental matchup, TPL_LITANY_SWING_MULT 0.58 — a Lv1 Litany mechanic, raw swings channel
42% less while chanting (replaced the briefly-shipped scepter dmgMult per the owner rule).
Kit tune: verses 12%, Doxology 3%/verse, Gloria 0.35 x avgHit/stack flat, Sunwyrm +15% vs
Dark, Sunburst +30%) Sunwyrm ~89B / Retribution ~77B at 90s,
Lichbane/Sunbrand between — the tightest legendary spread of any rework (set
D4 Solar Heart/Sunburst Zeal, ward slot fixed to Sunscale: Hallowlight/Sanctveil key off
ward reflects, which the zero-offense dummy never triggers, and Aegisveil is defensive).
**Thunderfury** (45s,
v0.0.62.1 — the FIRST full-elemental weapon simmed, completing the chassis trilogy: the wand
swing's Wand Attunement mods row carried the whole element-gear stack, x49 at BiS — two
fantastic +15 Rings of Earth alone are +4,800% elemental damage (0.50 base x8 rarity x6
enhance each). Start: 4.4-6.5T. Fix per the owner rule, all in class perk variables:
TF_STORM_SWING_MULT 0.32 (Stormseed channels raw swings 68% down; bolts scale off the
channeled hitAvg so one knob drives the whole kit) and Stormwyrm's Eye scales Bolts by
CLAMPED attunement only, never the gear stack. Pyromancer/Frostwarden/Nightblade/Lumen
wield wands and will hit the same x49 chassis at their reworks — budget for it. Kit:
bolts 6%/intensity/s, claps every 6th x2, Galvanize 8%/crit-bolt) Stormtomb ~93B /
Gloomstorm ~90B / Stormwyrm ~85B / Stormbrand ~71B (set D4 Galvanic/Stormwyrm's Eye,
ward fixed to Stormscale — Stormcoil/Voltveil/Stormveil are reflect/hit-taken keyed, dead
on the dummy). Stormlord runs are the NOISIEST recorded (±25% same-config: 91-128B at one
setting — crit-bolt and Galvanize ramp timing); always average 2-3 runs before tuning.
**Knight** (90s — the 6s claymore two-hander; v0.0.63.1, the FIRST class won by its **D2**
set layer: War Council's "standing Orders 50% stronger" beat every other layer by ~35% in
the A/B, because the Warlord's whole kit routes through the three Orders — a set that scales
the Orders scales everything. KN_DECREE_PCT is the single knob (Decree = Banner x pct x
recent-hit EMA); start 35% read 70-116B, 22% read 62-76B, final **25%**) Drakelance ~88B
(2-run mean 86.5/90.0) / Highbanner ~89B / Warbringer ~83B / Breachblade ~72B (set D2 War
Council, cloak Ruin). No new chassis risk — plain physical two-hander, like the Berserker's
warhammer. Sim-dead on the dummy: Rally (needs hits taken), Shieldwall (defense), Under One
Banner (party/familiars) — the sim measures the Steel/Pace/Decree core, which is where the
knob lives anyway. The Banner never lowers, so runs ramp once and hold (quieter than the
Stormlord's ±25%).
**Herald** (45s — the 1h mace; v0.0.64.1, the FIRST **tank** simmed and the first shield offhand
(`offhandShield` in BUILDS), owner target **~60B** — tanks band BELOW the 70-90B dps classes.
Two structural findings. (1) His whole kit keyed off BEING HIT, so it measured near-zero on the
zero-offense dummy; the fix is a self-driven **Brace** clock (every 5s, running the full Guard
path via `heraldGuardFire`, so a Brace counts as a Block for EVERY set/legendary/class effect) —
the Duelist Sidestep pattern, and the only reason the class is measurable at all. (2) The
**armour chassis**: BiS live Armor is ~**42.4 MILLION** (enchant-then-enhance compounds it), so
Ironclad's per-1,000 conversion computes to **x1,273** and is pinned at its cap — `PER_1K` NEVER
binds at BiS and `HERALD_IRONCLAD_CAP` is the only real lever (whole-kit DPS is linear in it:
cap 1.00 read ~70B, final **0.72**). Worse, Armor-scaled Retorts (25M) and a maxHp-scaled Breach
(0.8x one hit / 20s) were rounding errors against ~1e11 hits — the class's whole identity measured
as noise on "swings x2.5". Both now scale off the recent-hit EMA (the Bolt/Gloria/Decree channel)
and inherit armour scaling free, since the hits they average are Ironclad-boosted; the Breach reads
the WALL's fill (10 units full), not a share of max Health. Cave-In jumped 49.8B -> 70.3B once the
double Retort became real — proof the mechanics were dead before. Also: the Barrier banks a FRACTION
OF THE CAP per Guard (4 Guards fill it), never an Armor amount, which filled and Breached instantly
at every level. Sentinel and Treasure Hunter wear armour and carry shields — they hit this same
chassis at their reworks. Ceilings: Wallbreaker ~70B (2-run mean 65.9/73.4) /
Bastionbreaker ~59B / Cave-In ~54B / Tombshatter ~49B (2-run mean 43.7/54.2) — pack mean ~58B, i.e.
the class centers on the ~60B tank target with its best mace ~17% above it (set **D2** Momentum
Guard/Siegework, cloak Ruin, shield Bulwark of the Breach). Runs are noisy: ±12-24% same-config
(43.7-54.2B on one setting) — Brace/Breach phase against the swing timer; average 2 runs.
Sim-dead on the dummy: Bastion's hit cap, Unbreakable's mitigation, real Blocks, and Tombshatter's
Curse/Decay (hence its low read — it is the utility mace).
**Treasure Hunter** (45s — the 1h scimitar; v0.0.66.2 "the Reliquary", the FIRST class tuned to the **~50B**
band, deliberately below the dps classes because it is the farming class; also the first class whose engine
consumes an INVENTORY ITEM — Broken Relics as ammunition). Three findings. (1) The **scimitar chassis
overshoots the target unaided**: a Strike-disabled probe measured raw swing DPS at **~78B**, above the whole
band before the kit contributes anything, so per the owner rule the correction is a class perk variable —
`TH_SWING_MULT` **0.42** channels the class's own raw swings down and the Grave Strike scales off the
channelled hit average, so one knob drives everything (this is the third chassis to need the
TPL_LITANY_SWING_MULT / TF_STORM_SWING_MULT treatment). (2) The Strike **double-dipped crit**: it rolled the
full crit multiplier on top of `state.thHitAvg`, which is itself an average of post-crit hits — the single
biggest cause of the first reading (375B-995B). It is now a flat x2, as the Reaper's Rot ticks are. (3)
**Goldgorge was a runaway, not merely strong**: its gold-buys-charges line fed on a dragon's gold reward
(thousands per crit-pilfer) in a loop with the Strike's own gold scatter, reading 995B against a 449B field;
capped at ONE bought charge per swing it sits 1.24x the field. Also: the charge need went 8 -> **12** hits
because a BiS crit rate counts every crit as two, which made the Strike fire every ~2.5 swings (a per-swing
rider, not an event). Ceilings (D4 set, Ruin cloak, Luckshell offhand): Goldgorge ~54B (2-run 54.6/53.4) /
Cryptreaver ~52B / Gravepilfer ~47B / Greedwyrm's Claw ~47B — pack mean ~50B, i.e. dead on the target with
its best scimitar 8% above. The FIRST class won by its **D4** layer for a non-elemental reason: Wyrm's Greed
upgrades every relic you unearth one tier, and relic tier IS the Strike's damage, so the quality layer scales
the whole engine (D1 47B / D2 38B / D3 45B / D4 51B in the A/B). Noise is config-dependent and wide:
two greedwyrm runs on one setting read 51.0B and 60.4B (±18%) while two goldgorge runs read 54.6/53.4
(±2%) — the loaded relic tier wanders as Endless Vigil degrades relics a step and Wyrm's Greed re-upgrades
finds a step, so always average 2-3 runs. The crit-damage cloak reads unusually LOW (37.9B vs Ruin 60.4B)
precisely because the Strike's crit is a flat x2.
**Reaver** (45s AND 90s — the fast 1h half-moon axe; v0.0.67.1 "the Butcher's Count", owner target **80B**).
Opened by fixing a DEAD MECHANIC: the Bleed ticked for `stacks * combatLevelEquivalent * 0.04`, and
combatLevelEquivalent sums proficiency LEVELS — roughly **120 damage/sec** against BiS hits of ~1e11. The
class's whole identity was nine orders of magnitude too small to see, which is why the old Reaver was really
"a fast axe with a flat +25%". Re-based on the recent-hit EMA (`act.rvBleedHitAvg`), the Reaper's Rot channel.
Findings: (1) **the Count is RATE-limited, not ceiling-limited** — it never reaches its +120% cap inside 45s,
so **D4 came LAST** in the set A/B (119.3B vs D2's 227.3B) because its only contribution is raising that cap
to +180%, while everything that raises the carve RATE dominated (D2's two Cuts per stack-second, and
Marrowsplitter's double-value Cuts). D4 is close to a dead layer at 45s and only earns its keep in the long
fights this class is built for — expect the layer ordering to invert at 90s+. (2) The ledger is deliberately
**two numbers** — `rvCuts` (lifetime tally, drives the Count) and `rvBank` (harvestable pool). With ONE
number the Lv80 capstone is a runaway: a tally that never drops sits permanently above the Harvest threshold
and fires on every crit, and crits are ~100% at BiS. (3) Cuts accrue as **fractional stack-seconds**, not per
tick — the Bleed is a continuous DoT, so a per-tick count pays out differently at different frame rates.
(4) Marrowsplitter x D2 stack multiplicatively to a **4x** effective carve rate, which is why it sits 24%
above the pack mean; left alone as a BiS pairing (the Herald's best was 21% over its own mean).
`RV_SWING_MULT` **0.184** is the band knob (the axe opens wounds, the wounds kill; the Bleed, Count and
Harvest all scale off the channelled hit, so one number drives everything) — the FOURTH chassis to need the
TPL_LITANY_SWING_MULT / TF_STORM_SWING_MULT / TH_SWING_MULT treatment. Ceilings (D2 set, Ruin cloak,
Frenzyshell offhand): **45s** Marrowsplitter ~89B (2-run 85.9/91.2) / Gorewyrm's Edge ~84B / Bonereaver ~72B /
Bloodsupper ~69B — pack mean **~78B**, on target. **90s** Marrowsplitter **129B**, i.e. **+46% over its own
45s read** — the LARGEST window sensitivity of any class recorded (the usual mastery-training effect is ~35%),
because a fight-long ramp keeps climbing. Never compare a Reaver number against another class's without
matching windows. Runs are the QUIETEST recorded: **±3%** same-config (220.4B vs 227.3B), since the tally
climbs deterministically off bleed uptime rather than wandering like the Reliquary's relic tier (±18%).
Reaver sim notes: BUILDS needs `offhandShield: {type:'shieldSmall', leg:'frenziedguard'}`. Sim-dead:
**Bloodfrenzy** (D2 full) scales with MISSING health and the dummy never swings, so that half reads zero and
the D2 A/B UNDERSTATES the winning layer — its "two Cuts per stack-second" half is all the sim sees;
**Bonereaver**'s tally carry is kill-gated (the harness refills rather than killing), so it under-reads; and
every heal (Bloodsupper, Goreshell, Cauterize) is inert on a full HP bar.
Treasure Hunter sim notes: BUILDS needs `offhandShield: {type:'shieldSmall', leg:'fortunesriposte'}` and the
harness MUST zero every `BROKEN_RELIC_ITEMS` id in `st.inventory` between configs — the ammunition lives in
the inventory, so a later A/B otherwise opens with a stocked pack of top-tier relics and reads far too high.
The pack is seeded EMPTY (relics are consumables, owner rule) and the class bootstraps itself because a full
charge with no ammo DIGS a relic instead of firing — without that fallback the class would measure at zero
here, since the harness refills the dummy instead of killing it. Consequence: every KILL-gated line reads
dead — Cryptreaver's guaranteed drop, Gravepilfer's second relic and doubled Gravecoin, the Lv80 kill-refund
— so Cryptreaver and Gravepilfer UNDER-read their real value, and Hoardwall (needs a 100-relic hoard) is
unreachable in 45s from empty, which is why the shield slot is fixed to Luckshell. Gravecoin is a farming
number, not a DPS number; report it from a kill-cadence probe, never from this matrix.
Templar sim notes: BUILDS needs offhandWard; **measurement window matters** — mastery/
proficiency train during the run, so 90s runs read ~35% above 60s runs on identical code;
always compare a class against ceilings recorded at the SAME window (Berserker 82B @90s is
the Templar comparator; the 45s classes compare among themselves). Reaper caveats:
the zero-offense dummy keeps the Siphon Shield permanently full (flatters Wraithguard's
faster ticks and Spectral Edge), and the refilled pool means no kills, so Contagion (D1
full) measures dead. Duelist runs are the noisiest (~±25% — Danse/crit streak timing), and the
harness setup() now hard-resets session state between configs (companionCastsOnCombatEntry(null)
+ d4WrathReset) — continuously-refreshed buffs like Wrath otherwise leak into the next config.
Cloak: Ruin for every class so far. Caveats: runs are noisy (±20%); the zero-offense dummy keeps Vanish permanently
armed (flatters Assassin), keeps Berserker's HP bar full (flatters Wrathscale), and
ramp-speed legendaries (Gravewrath) measure at their floor when the ledger is primed.
Slow-swing classes: use SIM_MS=90000. The dummy HP pool is 1e15 with refill at 1e14 —
single ceiling hits exceed 1e12, which saturated the first Berserker run with kill resets.

**Frostwarden** (45s — the Water wand; v0.0.72.2 "the Deep Freeze", owner target **80B**). Chill became
**Rime**, a meter driving the foe's slow, its brittleness, Time Dilation's haste and Frostbite's tick at once;
a full meter freezes the foe and Shatters entirely. Third derive-don't-replace shim (rime derives
`chillStacks`, so the slow, Time Dilation, Brittle, Flash Freeze and Hoarfrost keep working untouched).
**Retired a capstone that did nothing:** Rime Resonance boosted the Rime FAMILIAR, and familiar hit damage
follows a raw weapon-tier curve ~7 orders of magnitude too small at BiS (owner rule: do NOT re-base
familiars), so only its "+25% vs Chilled" clause worked — folded into Permafrost's brittleness. Per owner,
D3/D4 dropped their dungeon themes: Fracture/Deathfrost are the Shatter layer, Frostheart/Absolute Zero the
brittleness layer. Knock-ons: **this class is no longer a Decay source** and **Rimewyrm's Fang no longer
applies Scorch**. `FW_SWING_MULT` **0.744**. Ceilings (D1 set, Ruin cloak, Rimeshell offhand): Gravefrost ~90B
/ Rimewyrm ~87B / Rimefang ~77B / Deepfreeze ~76B — pack mean **82B**, on target.
**WAND CHASSIS, THIRD DATA POINT — budget per-kit, confirmed.** Read **112.9B** uncorrected, not the trillions
the Stormlord's 4.4-6.5T implied, because Frostbite and the Shatter scale off a plain channelled hit rather
than feeding back THROUGH the element stack. Nightblade and Lumen should be budgeted the same way.
**AVERAGE ACROSS PACKS, NOT JUST WITHIN ONE (method fix).** The v0.0.69 variance rule said to measure the full
pack at each candidate knob. That is NOT enough on a noisy class: two full packs of this identical build
disagreed by **10%** (112.9B vs a 102.1B-equivalent). Single-pack scaling cost an extra tuning pass three
separate times this session (overshot 51% on the Pyromancer, undershot 9.5% here). Deriving the knob from the
MEAN OF BOTH packs predicted 80B and landed **82.4B — 3% off**. Use mean-of-packs for any class whose runs
move more than a few percent.
**DESIGN WEAKNESS LEFT ON THE TABLE (not fixed):** the four set layers read within **8%** of each other — the
noise band — and across runs the "winning" layer flipped D1 -> D3 -> D1 while the legendary ordering shuffled
almost completely (Rimewyrm 133.2 -> 70.5 -> 86.6). The armour and wand a Frostwarden picks barely change
their output; the core (brittleness + Frostbite + Shatter) does nearly everything. Fixing it means widening
each layer's effect. **Consequence: do not rank this class's layers or wands — there is no signal there.**
**A PREDICTION THAT DID NOT PAN OUT, recorded so it is not mistaken for evidence:** I predicted D1 (the
build-rate layer) would win the set A/B because this engine cycles. It won by 5% inside an 8% noise band, then
lost the next run. The rate/cap law's support comes from the Reaver, Pyromancer and Plaguebearer; this class
did not discriminate either way.

**Plaguebearer** (45s — the hatchet; v0.0.71.2 "the Plague", owner target **85B**). Poison became a process:
severity climbs per hit AND per second uncured, ticks off the recent-hit EMA scaled by it, and is LOST if the
Plague lapses. **Derive-don't-replace, the largest such shim yet** — a dozen-plus effects read this channel
(Immunize, Wasting Curse's poisonSince ramp, Miasma, Plaguebreath, Necrosis, Toxic Flames, Pestilence, three
tick multipliers, enemyAfflicted, the Quiverlord's Serpent rider), so `pbPlagueSync` derives
potionPoisonDps/Until from severity and takes the MAX against foreign poison. **Fixed a live bug in passing:**
Toxins and coatings ASSIGNED potionPoisonDps unconditionally while every other writer guarded with "only if
stronger or expired", so a weak Toxin OVERWROTE a Plaguebearer's stronger poison. All writers now guard.
`PB_SWING_MULT` **0.454** is the band knob. Ceilings (D4 set, Ruin cloak, Venomscale offhand): Blightwyrm
~99B / Wasting Curse ~90B / Blightfang ~74B / Rotmaw ~69B — pack mean **83B**, on target.

**THE RATE/CAP LAW — BOTH HALVES (this is the reusable finding of the session).**
  *Cycling* engines (Pyromancer Blaze, Reaver Cut bank, Frostwarden rime): **rate bonuses STRONG, cap DEAD.**
  *Sustained* engines (Plaguebearer severity): **cap bonuses STRONG, rate WEAK.**
The mechanism: a cycling engine spends its meter through a capstone and refills, so capacity is dead weight and
throughput compounds; a sustained engine sits AT its ceiling, so filling faster does nothing and raising the
ceiling is permanent damage. Evidence: Reaver D4 (cap) came LAST at 119B vs D2's 227B; Pyromancer D1 (+30
capacity) came LAST at 79B vs D2's 140B; Plaguebearer inverted it — Blightfang (cap +half) placed 2nd while
Wasting Curse (severity rate x2) placed **LAST at 61.4B against a 79.6B mean**. Re-axing Wasting Curse onto
eruption FREQUENCY (an axis that lives AT the cap) took it to **90.4B, second of four** — the law confirmed
prospectively, not in hindsight. **Diagnose the engine type BEFORE assigning set/legendary axes.** Two misses
came from not doing so: the Rotmaw "fix" that gained ~1% (I corrected the rate axis when the cap was the
binding one), and the Frostwarden's inherited D1 "cap rises to 8", which was moved to a build RATE before any
measurement because its rime meter cycles.

**Ranger** (45s — the medium bow; v0.0.70.1 "the Beastmaster", owner target **80B**). Crits are COMMANDS: a
Critical Hit sics a companion on the foe for a share of the recent-hit average, strikes stack a **Quarry**
damage ramp, chains send the beast back in, and **Feral Bond** adds a share of "your weapon damage" per strike.
Owner instruction: **do NOT re-base familiars** — so the commanded strike is this class's OWN attack, not a
familiar spell cast, and the general familiar system is untouched (nothing here touches the Summoner).
**"Your weapon damage" is implemented against the average LANDED hit, not the raw weapon stat**: a Fantastic
+15 t20 bow with flat enchants and the x6 enhance lands in the tens of thousands against BiS hits of ~1e11, so
the literal reading would have made the capstone a rounding error. Findings: (1) **FLAT CRIT ON DERIVED
ATTACKS — now the THIRD instance.** Two as One initially rolled the full crit multiplier on top of `dotBase`,
which is already an average of post-crit hits; the first matrix read 410B largely on that double-dip. Fixed to
a flat x2, matching the Reliquary's Grave Strike and the Reaper's Rot ticks. **RULE: any effect scaling off a
post-crit average must never re-roll the crit multiplier.** (2) **SET LINES WHOSE CONDITION NEVER FAILS.**
Throatseeker ("crits deal double against a Quarried foe") reads as a conditional but is a flat x2 at BiS,
where crit is ~100% and Quarry is permanent once the pack works — the same smell as the Pyromancer's D1
"+30 capacity" being a non-bonus. Audit new set lines for conditions that cannot fail at best-in-slot.
(3) **RATE BEATS EVERYTHING, third consecutive class.** The standout bow is the one granting an extra STRIKE
and the standout layers are the ones adding strikes/chains — matching the Reaver (Cut rate over cap) and the
Pyromancer (fuel rate over capacity). (4) Wyrmstalker at +40% max-Quarry read **39% clear of the pack** because
it triple-stacks with D3 (its own bonus x D3's guaranteed chains x Throatseeker's doubled crits, all keyed on
the same condition); trimmed to +20% and it fell mid-pack. `RG_SWING_MULT` **0.307** is the band knob.
Ceilings (D1 set, Ruin cloak, plain quiver): Compound Arrows ~89B / Wyrmstalker ~78B / Trapmaster ~77B /
Bonevolley ~65B — pack mean **77B**, on target.
**I PREDICTED THIS CLASS WOULD BE QUIET AND IT IS NOT — ±18%**, the noisiest measured since the Stormlord:
D1+Ruin+Wyrmstalker read 111.4B / 95.5B / 77.7B in ONE session. The reasoning error is worth remembering: I
assumed ~100% crit made the engine deterministic, but the real dice are the CHAIN rolls (35%, doubled by
Compound Arrows) and Bonevolley's re-strike, each of which can double a strike's contribution. **Judge run
variance by the per-event coin flips inside the kit, not by whether its trigger is reliable.** Consequence:
the D1-vs-D3 "winner" flipped between runs (341B vs 357B on the previous knob — 5% apart) and those two layers
should be treated as indistinguishable, not ranked.

**Pyromancer** (45s — the Fire wand; v0.0.69.2 "the Conflagration", owner target **90B**). Burn became one
**Blaze with fuel**: hits feed it, it ticks off the recent-hit EMA scaled by its SIZE, and it burns itself
down, so uptime is the skill. The crux was a **COMPATIBILITY SHIM** — ~15 effects outside the class read
`enemyBurning()`/`enemyBurnStacks()` (Rimewyrm vs Scorched, the Ranger's Fire Arrows, Cremation,
`d2BurnTickMult`, several wards, Ember Burst), so the pool NEVER replaces `act.burnStacks`; `pyBlazeSync`
DERIVES burnStacks/burnUntil/burnDps from the fuel after every change and the whole existing tick body works
untouched. **Any future engine that replaces a shared field must do this** or it silently kills a dozen
effects. Chassis: this is the SECOND class on the x49 wand stack; uncorrected it read **820B**, NOT the
trillions the Stormlord's 4.4-6.5T implied — that figure came from Bolts compounding THROUGH the element
stack, whereas the Blaze scales off a plain channelled hit average. So the x49 stack only explodes when a
kit's own damage feeds back through it; **Frostwarden / Nightblade / Lumen should be budgeted per-kit, not
assumed catastrophic.** `PY_SWING_MULT` **0.079** is the band knob. Ceilings (D2 set, Ruin cloak, Everburning
ward), measured at 0.081 and scaled by the final knob: Emberstorm ~102B / Cinderwyrm ~94B / Cindermaw ~83B /
Pyresoul ~81B — pack mean **90B**, dead on target. (0.081 measured 92B; the final 2.3% nudge centres the point
estimate and is well inside the ±8% variance below, so it is not separately measurable — do not re-sim for it.)
The legendary ORDERING is noise, not signal: it flipped almost completely between the 0.11 and 0.081 matrices
(Emberstorm last then first; Pyresoul second then last), because the four wands sit within ~±12% of each
other while same-session variance is ±8-15%. Do not claim a "best wand" for this class.
**FEED RATE BEATS CAPACITY (confirmed across two engines).** Pyromancer set A/B: **D2 140.0B** (Firestarter,
+50% fuel per hit) vs D4 86.8B / D3 86.2B / **D1 79.2B** (+30 capacity, LAST). Identical shape on the Reaver,
where doubling the Cut RATE dominated and raising the CAP was inert (D4 came last at 119B vs D2's 227B). The
cause is structural: a Lv80 engine CYCLES through its capstone eruption rather than sitting near its ceiling,
so capacity is largely dead weight. Design any future fuel/ramp bonus as a rate, not a cap — and note the
Pyromancer's D1 "+30 capacity" is close to a non-bonus at max level and wants revisiting.
**SIM VARIANCE RULE (learned the hard way, v0.0.69).** Consecutive runs of one config agree tightly (0.4%
apart), but the SAME config measured at different points in one browser session does NOT: D2+Ruin+Cinderwyrm
read 140.0B / 131.5B / 154.7B (±8%) across the set A/B, cloak A/B and legendary matrix of a single run. So a
single matrix CELL is never a sound basis for a band knob. Two misses came from ignoring this — deriving a
knob from a lone D1 probe (D1 being the weakest layer: overshot 51%), then scaling from the 154.7B cell (the
high end of the spread). **Always measure the full pack at each candidate knob**; it is slower and it is the
only method that has held up.

**DOT CHASSIS (fixed game-wide in v0.0.68.0).** Every damage-over-time in the game used to tick for a
fraction of `combatLevelEquivalent()` — a SUM OF PROFICIENCY LEVELS, ~600 at max — while BiS hits land at
~1e11. A fully-stacked Burn dealt roughly **150 damage/sec**: eight to nine orders of magnitude too small to
matter. Weapon Coatings, a whole crafting line, fed a mechanic that was mathematically invisible. Found while
reworking the Reaver (whose Bleed had it); an audit showed it hit EIGHT sites — Decay, toxin, coating,
Rotshell, Pyromancer Burn, Frostwarden Frostbite, Samurai and Ranger Bleeds. Only the Reaper's Rot and the
Reaver's Bleed were correct, both because their reworks re-based them. Everything now reads `dotBase(st)` =
the fight's recent-hit EMA (`act.dotHitAvg`, banked on every landed main-hand hit, UNGATED by class because
Decay/poison are consumed by far more classes than the one worn), with a fallback to the old level figure so
a DoT applied before your first hit still does something. Coefficients were recalibrated BY ROLE, not 1:1:
incidental/universal channels scaled down hard (Decay 0.03 -> **0.006**, i.e. ~6% of a hit/sec at its 10-stack
cap, because ~20 sources apply it onto already-banded classes; toxin t20 0.10 -> 0.03; coating t20 0.14 ->
0.045; Rotshell 0.15 -> 0.03), while identity channels kept their pct on the corrected base (Burn, Frostbite,
Samurai/Ranger Bleeds) since their owning classes are un-reworked and get banded at their reworks.
**Consequence to remember: Pyromancer, Plaguebearer, Ranger, Frostwarden and Samurai are now materially
stronger and NOT banded** — band them at their reworks. Verified no blowout on an already-banded class:
Herald + Tombshatter (its Curse+Decay were dead, which is exactly why CLAUDE.md called it "the utility mace"
and why it read lowest) went ~49B -> **61.2B**, lifting the Herald's runt mace to the middle of its ~60B tank
band rather than out of it. When adding any NEW DoT, scale it off `dotBase` and size it by role — never off
`combatLevelEquivalent`, and never 1:1 from an old coefficient.

**Samurai** (90s — the 5s katana; v0.0.75.0 "the Draw-Cut", owner target **85B**). The class was **one strike**:
`act.samuraiFirstStrike` was consumed by the first landed hit of a duel and re-armed only on a new foe, and FIVE
effects keyed off it (Iaijutsu, First Blood, Iaijutsu Mastery D2 2pc, Blazing Iaijutsu D4 full, Emberdraw) — so
four of the five multiplied by exactly 1.0 for the rest of every fight. First Blood's Bleed ran 8s and was never
re-applied, which made **Crimson Edge — the Lv40 passive — dark for almost the whole fight** (two swings of
uptime on a 5s weapon). Focus was a static +50% dmg / +15% crit that filled in a few hits and never moved again.
Now Focus is a **stance** that builds per hit AND **per second** (the Plaguebearer's climbs-per-hit-and-per-second
pattern), and a full stance makes the next strike a **Draw-Cut**: guaranteed crit, spends the meter, re-sinks the
Bleed. `SM_SWING_MULT` is the band knob. Findings:
- **A CLOCK IS MANDATORY ON A SLOW WEAPON, and this is now the third class to need one** (Herald's Brace,
  Duelist's Sidestep). Hits-only, a ten-stack stance on a 5s katana takes **50 seconds** to fill — one Cut per
  fight. The per-second build is the only reason the engine cycles at all, and it makes the class weapon-speed
  agnostic.
- **BUT THE CLOCK RATE IS ITSELF A DESIGN KNOB, and setting it too high produces a DEGENERATE engine.** At
  `SM_FOCUS_PER_SEC = 1.0` the first sim pack measured a stance that refilled in ~3s against a 5s swing, so it
  was always full when the next swing arrived and **every swing was a Draw-Cut** — the meter became decoration
  and the Cut a per-swing rider. **The tell was in the legendary matrix, not the DPS total:** Silkweaver, whose
  entire power is a bigger refund (i.e. a faster cycle), read 194.5B against Ghostblade's 185.5B, which has no
  rate effect whatsoever. When a pure-rate item measures level with a non-rate item, the cycle is not
  rate-limited and the engine is saturated. Dropped to 0.35. **Check any new cycling engine against its own
  rate item this way before trusting the ceiling.**
- **THE SET-LAYER ORDERING INVERTED WHEN THE CLOCK WAS FIXED, which is why a saturated engine must never be
  used to rank anything.** Degenerate pack: D1 176.9B vs D2 122.6B — D1 ahead by 44%, and I was ready to record
  "rate wins again, fourth class running". Corrected pack: **D2 73.0B vs D1 69.9B**, i.e. reversed and now only
  4.5% apart, well inside the ±8–15% noise band. **Do not rank D1 against D2 for this class — there is no
  signal there** (the Frostwarden lesson). What survives is that D3 is genuinely last (58.6B, 20% under D2),
  and the mechanism is legible: with the cycle no longer firing every swing, per-Cut VALUE competes with rate
  instead of being buried by it.
- **DEFER A SPREAD FIX UNTIL THE ENGINE IS SOUND — this session is the evidence.** Ironwind ("the Cut strikes
  twice") read **+31% over pack mean** on the degenerate run and I nearly trimmed it. After the clock fix it
  read **+15.5%**, below the Herald's best mace (+17%) and Marrowsplitter (+24%), both left alone as legitimate
  BiS pairings. The katana never needed touching; the clock did. A ratio measured on a broken engine is not
  evidence about the item.
- **CAP AXES WERE THE OLD DESIGN'S BLIND SPOT, and there were THREE.** Silkweaver raised the Focus cap 10 → 15,
  which on a cycling meter is not merely dead but a **downgrade** (a bigger stance takes longer to fill and the
  Cut still pays per stack spent). Ironwind's "every strike crits at max Focus" and Zanshin's "+15% crit at max
  Focus" both assumed the meter SITS full — it is spent by the very strike that fills it. `samuraiFocusCap` is
  now a constant and all three were re-axed onto rate/value. Fourth confirmation of the rate/cap law.
- **FLAT CRIT ON DERIVED ATTACKS — fourth instance.** The Cut scales off `dotBase` (already an average of
  post-crit hits), so it crits **flat x2**, like the Reliquary's Grave Strike, the Reaper's Rot ticks and the
  Ranger's Two as One. Written that way from the start this time rather than caught by a wild first reading.
- **Final Cut (D3 full) was a per-swing rider disguised as an event**: it fired off ANY Critical Hit, and BiS
  crit is ~100%, so it spent the Soul bank every swing. It now spends into the Draw-Cut, so the D3 layer scales
  with the cycle like the others.
- Derive-don't-replace: the Bleed still writes the SHARED `act.bleedStacks/bleedDps/bleedUntil`, so Marrowsplitter,
  Crimson Harvest, Exsanguinate, `d2BleedTickMult`, Feeding Frenzy, `enemyAfflicted`, Bonereaver's carry and the
  debuff readout are untouched; `samuraiFocus` stays an INTEGER (the UI and every existing reader expect one) with
  the sub-second remainder in `act.smFocusAccum`.
`SM_SWING_MULT` **0.316**, derived from the MEAN OF TWO PACKS per the v0.0.72 method fix (pack 1 at 0.45 read
124.2B; pack 2 at 0.308 read 80.8B = 118.0B rescaled; mean 121.1B → 0.316). Ceilings (D2 set, Ruin cloak, no
offhand): Ironwind ~100B / Silkweaver ~92B / Emberdraw ~80B / Ghostblade ~69B — pack mean **85B**, on target.
Ironwind is +17% over mean (the Herald's-best level, left alone) and Ghostblade the runt at −19%, which is the
utility katana — undodgeable and Decay are worth little against a dummy that never dodges meaningfully.
**Per-legendary variance across the two packs: Silkweaver ±12%, Ghostblade ±6%, Ironwind ±2%, Emberdraw ±1%.**
The rate katana is the noisy one, because its cadence phases against the swing timer — the same reason the
Herald's Brace/Breach runs were noisy. Average 2 runs on Silkweaver specifically.
**On D1 vs D2, an honest statement of a weak signal:** both packs put D2 ahead by the same small margin (4.5%
and 4.8%), so the DIRECTION is reproducible but the margin is under the noise floor. Treat them as
indistinguishable; do not tell a player one is better. D3 was last in both packs (−20%, −31%) and that IS
signal. Ruin won the cloak A/B decisively in both, like every class so far.
Sim notes: BUILDS needs no offhand (2H). Unusually clean to measure — the kit needs neither kills nor incoming
damage, so almost nothing is sim-dead. The exception is **Kindled Focus (D4 2pc)**, which scales with stance
HELD, and a cycling stance spends itself, so it under-reads what a real fight sees.
**WATCH ITEM (post-ship code review): D1 + Silkweaver + Zanshin saturates the cycle.** Rate stacked on rate on
rate: Unbroken Focus doubles both builders (2/hit + 0.7/s), and the refunds leave 6, so a cycle needs 4 stacks
while one 5s swing provides ~5.5 — a Draw-Cut EVERY swing for that one combo. Estimated ~8.75x avgHit/swing vs
the measured BiS (D2+Ironwind) at ~9.5x, so it does not beat the ceiling and needs no change now — but any buff
to SM_FOCUS_PER_SEC, SM_FOCUS_PER_HIT, the refunds, or Silkweaver re-tests this combo FIRST, and the sim never
measured it (set A/B ran on Emberdraw, the legendary matrix on D2).

**TIER WARNING (v0.0.64.9): every recorded ceiling above was measured with a ONE-BELOW-BiS weapon.**
Melee weapons + shields shipped with `tierCount:20` (top `t19`) while bows/wands/wards/scepter/staff had
21 (top `t20`) — the ticket-0116 off-kilter. Melee/shields are now 21 tiers too (top `t20`, Tungsten), and
the harness DERIVES the top tier via `legGearBaseTopTier()` instead of hardcoding it, so it can never drift
again. Two consequences: (1) every melee ceiling was measured on a t19 weapon and will now read HIGHER;
(2) the bow builds were ALWAYS one tier low (bows were 21 tiers while BUILDS said t19), so Quickdraw's
~94B/~85B is understated more than the melee classes'. Re-measure before comparing any new class against
these numbers, and never hardcode a tier in BUILDS.

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
