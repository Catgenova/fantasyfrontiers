// Build a self-contained copy of a demo page: every art reference becomes a data URI.
//
// Run: npm run demo:arena           (i.e. node scripts/inline-demo.mjs demo/arena.html)
//
// WHY THIS EXISTS: the demos reference art with relative paths (../art/...), which only resolve when the
// file sits in the repo and is served from the root. Sent on its own -- downloaded, mailed, dropped on a
// desktop -- every image 404s and the page renders as broken-image glyphs. That is exactly what happened
// the first time a demo was shared, so the shareable copy is generated rather than hand-carried.
//
// Unlike scripts/inline-orb-demo.mjs (which asserts a hand-written manifest for the two-orb prototype),
// this DISCOVERS every reference itself -- src="", href="" and CSS url() alike -- so a new frame added to
// the markup cannot be silently left out.
//
// TWO THINGS THAT WILL BITE IF CHANGED CARELESSLY:
//  1. Downscaling is per-asset and sized to how big the frame actually renders (x2 for retina), because the
//     orb holders alone are 816KB each and inlining everything at native cost ~3.2MB of base64.
//  2. `border-image-slice` IS IN SOURCE PIXELS. Downscaling the border art without rescaling the slice
//     silently mangles the frame's corners, so the slice is rewritten by the same factor and the rewrite is
//     ASSERTED -- a missed rewrite fails the build rather than shipping a broken frame.
import sharp from "sharp";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";

const SRC = process.argv[2];
if (!SRC) { console.error("inline-demo: usage: node scripts/inline-demo.mjs demo/<page>.html"); process.exit(1); }
if (!existsSync(SRC)) { console.error(`inline-demo: ${SRC} is missing.`); process.exit(1); }
const OUT = SRC.replace(/\.html$/, "_standalone.html");

// Target WIDTH in px per asset, from the size the frame actually renders at x2 for retina, capped at native.
// Anything not listed falls back to DEFAULT_W, which is deliberately generous.
const DEFAULT_W = 512;
const WIDTH = {
  "UI_orb_holder_LEFT.png": 768,   // the plinth renders ~430px wide
  "UI_orb_holder_RIGHT.png": 768,
  "UI_orb_transparent.png": 384,   // glass covers ~36% of the plinth, so ~155px
  "Icon_circleframe_gold (1).png": 256,  // portrait, 88px
  "Square_merged (2).png": 729,     // swing bar ~330px; native is already 729
  "Skill_set.png": 768,             // name plate ~330px wide on a 1024 canvas
  "Square_icons (1).png": 160,      // familiar slot, 62px
  "UI - Skill Level Up - Border.png": 1024,  // border-image; see the slice rescale below
  "assassin.png": 256,              // inside the portrait ring, ~70px
};

let html = readFileSync(SRC, "utf8");

// Every reference to the art folder, however it is written.
const refs = [...new Set([...html.matchAll(/(?:src|href)\s*=\s*["']([^"']*\.\.\/art\/[^"']+)["']|url\(\s*['"]?([^'")]*\.\.\/art\/[^'")]+)['"]?\s*\)/g)]
  .map((m) => m[1] || m[2]))];
if (!refs.length) { console.error(`inline-demo: found no ../art/ references in ${SRC} -- nothing to inline.`); process.exit(1); }

let payload = 0, failed = 0;
for (const ref of refs) {
  const file = ref.replace(/^(\.\.\/)+/, "");
  if (!existsSync(file)) { console.error(`inline-demo: FAIL ${ref} -> ${file} does not exist`); failed++; continue; }
  const meta = await sharp(file).metadata();
  const w = Math.min(meta.width, WIDTH[file.replace(/^art\//, "")] || DEFAULT_W);
  const buf = await sharp(file).resize({ width: w })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toBuffer();
  const scaled = await sharp(buf).metadata();

  // The slice rescale. Written as `border-image:url('<ref>') <N> fill stretch`.
  const sliceRe = new RegExp("(border-image\\s*:\\s*url\\(\\s*['\"]?" + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?\\s*\\)\\s+)(\\d+)", "g");
  const hits = [...html.matchAll(sliceRe)];
  if (hits.length) {
    const factor = scaled.width / meta.width;
    let rewritten = 0;
    html = html.replace(sliceRe, (_m, head, n) => {
      rewritten++;
      return head + Math.max(1, Math.round(Number(n) * factor));
    });
    if (rewritten !== hits.length) {
      console.error(`inline-demo: FAIL border-image slice for ${file}: ${hits.length} to rewrite, ${rewritten} done`);
      failed++; continue;
    }
    console.log(`inline-demo: rescaled ${rewritten} border-image slice(s) for ${file} by x${factor.toFixed(4)}`
              + ` (${hits[0][2]} -> ${Math.round(Number(hits[0][2]) * factor)})`);
  }

  const uri = "data:image/png;base64," + buf.toString("base64");
  payload += uri.length;
  html = html.split(ref).join(uri);
  console.log(`inline-demo: inlined ${file.padEnd(34)} ${String(Math.round(statSync(file).size / 1024)).padStart(4)}KB`
            + ` -> ${String(Math.round(buf.length / 1024)).padStart(4)}KB @${scaled.width}px`);
}
if (failed) { console.error(`inline-demo: ${failed} failure(s); not writing ${OUT}.`); process.exit(1); }

html = html.replace(/^(\s*)MOCK ONLY\..*$/m,
`$1SELF-CONTAINED build of ${SRC} -- every image is inlined as a data URI, so this works from anywhere:
$1double-click it, open it out of a downloads folder, mail it to someone. No server, no sibling art/ folder,
$1nothing relative to break. GENERATED -- do not edit; change ${SRC} and re-run the demo script.
$1Art is downscaled for this file only (the two orb plinths are 816KB each at native), and the mini log's
$1border-image slice is rescaled to match.`);

// Nothing relative may survive, or the file is not actually self-contained.
const leftovers = [
  ...[...html.matchAll(/(?:src|href)\s*=\s*["'](?!data:|#)([^"']+)["']/g)].map((m) => m[1]),
  ...[...html.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g)].map((m) => m[1]),
];
if (leftovers.length) {
  console.error(`inline-demo: FAIL ${OUT} would still reference external files: ${leftovers.join(", ")}`);
  process.exit(1);
}

writeFileSync(OUT, html);
console.log(`inline-demo: wrote ${OUT} (${Math.round(Buffer.byteLength(html) / 1024)}KB, `
          + `${Math.round(payload / 1024)}KB of it inlined art) — opens standalone.`);
