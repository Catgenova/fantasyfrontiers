# Painted class art

Commissioned raster icons for the Hero Classes. Drop a file here, add one line to `CLASS_ART` in
`index.html`, and it replaces that class's authored SVG portrait in three places at once:

- the **Classes** tab card crest (`classCardIcon`)
- the **Combat** arena avatar while the class is active (`playerPortrait`)
- every **Leaderboard** row for a player wearing that class (`classPortraitFor`)

## Naming

`art/<classname>.png` — the class's **player-facing name**, lowercased, letters only. That is what an
artist naturally delivers, so it is the convention:

| Class id | Display name | File |
|---|---|---|
| `assassin` | Assassin | `art/assassin.png` |
| `nightblade` | **Voidshadow** | `art/voidshadow.png` |
| `treasureHunter` | Treasure Hunter | `art/treasurehunter.png` |

The id and the name coincide for most classes but not all — the Nightblade is the Voidshadow in game, the
Reaper is the Rotlord's chassis, and so on. `CLASS_ART` is keyed by the **id** regardless; only the filename
follows the name. The selftest accepts either form, so a genuine typo still fails the build.

**Lowercase matters.** GitHub Pages is case-sensitive: `Assassin.png` will 404 where `assassin.png` works,
and the failure is silent (the class just keeps its old portrait).

## Workflow

1. Drop the delivered file in **`art/src/`** — full resolution, exactly as the artist sent it. This is the
   source of truth and is **never served**; the build excludes it.
2. Run **`npm run art:optimize`**. It writes `art/<name>.png` at **384×384**, palette-quantised — about
   **40KB**, down from ~300KB, an 86% saving.
3. Add the line to `CLASS_ART` in `index.html`, keyed by class **id**.
4. Run **`npm run build && npm run artcheck`** to confirm it serves and decodes from `dist/`.

## Format

- **PNG with transparency.** Deliver at **512×512 or larger**; anything under 384 gets upscaled and
  `art:optimize` warns.
- Design it **circular**, with its own frame/ring, and transparent corners. The CSS applies
  `border-radius:50%` and `object-fit:cover`, and the optimizer crops square with `fit:cover`, so anything
  in the corners is lost.
- Don't hand-optimize. `art:optimize` handles it, and it is re-runnable — the served copy is a build
  artifact of the source, not something to edit.

### Why 384px palette PNG, and not WebP

Measured on the first two icons, weighting error by **alpha** so fully transparent pixels (whose RGB is
undefined and differs wildly) don't pollute the average:

| Encoding | Size | Visible MAE | Peak error |
|---|---|---|---|
| **palette PNG** | 39KB | **1.71**/255 | **49** |
| webp q90 | 34KB | 3.96/255 | 130 |

Palette wins on fidelity at the same size — the opposite of the usual answer, and a property of *this*
content: flat vector-style illustration with a limited palette quantises almost losslessly, while lossy DCT
rings around hard edges (blade highlights, mask outline). It also keeps one format with no browser-support
question.

An **un-weighted** MAE said the reverse (15.84 vs 7.58) and would have picked WebP. Averaging over invisible
pixels is the trap. **If a future icon is painterly rather than vector, re-measure — don't assume.**

384px covers the largest render (104px in the arena) at 3× device pixel ratio with margin.

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
