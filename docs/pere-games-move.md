# The move to pere.games/fantasyfrontiers (2026-11-27)

The game becomes a project site under the pere.games user site (`Catgenova/Catgenova.github.io`,
`CNAME pere.games`), exactly like Wildermon and the Daily Crossword: this repo keeps deploying from
`.github/workflows/pages.yml`, GitHub serves it at `catgenova.github.io/fantasyfrontiers/`, and the
user site's custom domain makes that `https://pere.games/fantasyfrontiers/`. The old home,
`fantasyfrontiers.online`, forwards there.

## What this repo already does (shipped in v0.1.4.41)

- Every asset path is relative, the manifest's `id`/`start_url`/`scope` are `./`, and the service worker
  tests paths against its own directory, so the game works at a subpath and at a root install alike.
- **Session handoff.** Saves are cloud-only, so nothing is lost by changing origin, but a GUEST account
  exists only as the Supabase session in the old origin's localStorage. The old home hands the refresh
  token over in the URL fragment (`#ffho=...`, never sent to a server); the new home consumes it once,
  strips it from the address bar, and signs the player in (`handoffReceive`, before the session restore).
  Registered players skip the login gate the same way.
- `redirect/index.html` is the forwarding page for the old domain (no dependencies; also unregisters the
  old service worker and empties its caches). `FF_NEW_HOME` in index.html is the in-app sender for the
  case where this build itself is still served at the old host; it ships EMPTY (inert).

## Cutover, in order (owner)

The custom domain can be attached to one repository at a time, and `pere.games/fantasyfrontiers/` cannot
answer while this repo still claims `fantasyfrontiers.online`. So the switch is a short sequence, and
new loads of the old domain see a GitHub 404 only between steps 2 and 3. Pick a quiet hour.

1. **Portal entry.** In `Catgenova/Catgenova.github.io` add `_games/fantasyfrontiers.md` (content below)
   and a 16:9 cover at `assets/img/games/fantasyfrontiers.png`. Also add
   `.well-known/assetlinks.json` to that repo's root (content below): Android checks the ORIGIN root, so
   the copy in this repo is invisible at `pere.games/fantasyfrontiers/.well-known/`.
2. **Release the old domain here.** Delete the `CNAME` file in this repo (one commit, bumps GAME_VERSION
   like every merge) and, in this repo's Settings > Pages, clear the custom domain if it is still shown.
   Set Source to "GitHub Actions" while there (it is "Deploy from a branch" today, which races the
   obfuscated deploy with the raw root). Within a few minutes `https://pere.games/fantasyfrontiers/`
   answers. Confirm the Settings modal there reads the deployed version.
3. **Forward the old domain.** Either:
   - a one-file repo (for example `Catgenova/fantasyfrontiers-redirect`) holding `redirect/index.html`
     as `index.html` plus a `CNAME` file reading `fantasyfrontiers.online`, Pages enabled; DNS already
     points at GitHub Pages, so nothing else moves; or
   - a Cloudflare Worker on the route `fantasyfrontiers.online/*` that returns that file's contents.
   A bare Cloudflare Redirect Rule also works but STRANDS GUESTS (no page runs, so no session handoff).
   Keep whichever you choose for at least a few months: bookmarks, the Play Store listing and Discord
   links all still say fantasyfrontiers.online.
4. **Supabase Auth > URL Configuration.** Site URL `https://pere.games/fantasyfrontiers/`; add
   `https://pere.games/fantasyfrontiers/**` to Redirect URLs (Discord login returns to
   `location.origin + location.pathname`). Keep the old URL in the list during the transition.
5. **Cloudflare Turnstile.** The widget `0x4AAAAAAEC2_MfHEfBWaCHM` is bound to hostnames: add `pere.games`
   to its allowed hostnames, or login and registration fail CAPTCHA at the new home.
6. **Android (TWA).** The Play app `online.fantasyfrontiers.app` opens fantasyfrontiers.online, which now
   forwards; the origin changed, so it shows a URL bar until it is rebuilt with `pere.games` as its host
   and start URL (`/fantasyfrontiers/`), with the asset links from step 1 live at the portal root.
7. **Discord.** The OAuth app needs no change (its callback is the Supabase URL). Update pinned links and
   the server description. The patch-note blast for the move is a one-liner: "Fantasy Frontiers now lives
   at pere.games/fantasyfrontiers. Your account and progress come with you; the old address forwards."

Rollback at any point before step 3: restore the CNAME file here (the custom domain re-attaches on the
next deploy).

## `_games/fantasyfrontiers.md` for the portal

```markdown
---
title: Fantasy Frontiers
tagline: An idle fantasy RPG of crafting, combat and estate-building, with guilds, dungeons, towers and 24 classes. Pre-alpha, in active development.
status: Live
tags:
  - Pre-Alpha
  - Idle
  - RPG
  - Crafting
  - Combat
  - Classes
  - Guilds
  - Dungeons
  - Economy
featured: true
order: 3
play_url: /fantasyfrontiers/
cover: /assets/img/games/fantasyfrontiers.png
source_url: https://github.com/Catgenova/fantasyfrontiers
---

Gather, refine and craft your way up twenty tiers of gear, then take it into combat: 24 classes, each
reworked around its own engine, legendary weapons, set armour, enchanting and enhancing. Build an
estate with peons, workshops, fields and walls; join a guild with a shared bank, hall and estate; climb
the Tower and run dungeons solo or in a party. Progress is saved to your account and continues while you
are away.

Pre-alpha: expect balance passes and the occasional rough edge. Bugs and ideas go to the Discord.
```

## `.well-known/assetlinks.json` for the portal root

Copy this repo's `.well-known/assetlinks.json` verbatim. It names the Play package
`online.fantasyfrontiers.app` and both signing fingerprints; it must be served at
`https://pere.games/.well-known/assetlinks.json` with a JSON content type (GitHub Pages does that for
`.json`). If another game ever ships a Play app, its statement is appended to the same array.
