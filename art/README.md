# Painted class art

Commissioned raster icons for the Hero Classes. Drop a file here, add one line to `CLASS_ART` in
`index.html`, and it replaces that class's authored SVG portrait in three places at once:

- the **Classes** tab card crest (`classCardIcon`)
- the **Combat** arena avatar while the class is active (`playerPortrait`)
- every **Leaderboard** row for a player wearing that class (`classPortraitFor`)

## Naming

`art/<classId>.png` — the class id, exactly as it appears in `CLASS_DEFS` (camelCase where it is
camelCase: `treasureHunter`, `plaguebearer`, `thunderfury`).

## Format

- **PNG with transparency**, square, **512×512** or larger. The art is drawn at 104px in the arena and
  24px on a leaderboard row, so it needs enough resolution for the big one and enough contrast to still
  read at the small one.
- Design it **circular**, with its own frame/ring, and transparent corners. The CSS applies
  `border-radius:50%` and `object-fit:cover`, so a square canvas is cropped to a circle — anything in the
  corners is lost.
- Keep files lean. These are fetched on every boot; a few hundred KB each is fine, several MB is not.

## Rollout is per class, and safe

`CLASS_ART` is probed at boot by `classArtPreload()`: each entry loads through an `Image()` and only flips
its ready flag once the file actually decodes. A missing, misnamed or corrupt file therefore does nothing
at all — the class keeps its existing SVG portrait, with no broken-image glyph in any of the three
screens. The art can only ever add.

That is also why there is no `<img onerror>` fallback: `index.html` has no inline event handlers anywhere
(every interaction is delegated off `data-action`), and the probe gives a better failure mode than an
attribute would.

## Deploy

`scripts/build.mjs` copies this whole directory into `dist/`, which is the GitHub Pages artifact root.
Paths in `CLASS_ART` are relative, so they resolve identically from the custom domain, a Pages subpath,
and `?selftest`.
