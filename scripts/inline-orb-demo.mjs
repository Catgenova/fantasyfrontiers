// Build demo/orb_standalone.html -- a self-contained copy of demo/orb.html with every image inlined.
//
// WHY: demo/orb.html references the art with relative paths (../art/...), which only resolve when the file
// sits in the repo and is served from the root. Sent on its own -- downloaded, emailed, dropped on a desktop
// -- every image 404s and the prototype renders as a flat fallback circle with broken-image glyphs. That is
// exactly what happened the first time it was shared, so the shareable copy is now generated rather than
// hand-carried.
//
// The art is downscaled for this file ONLY: the orbs render at 300px, so 512px holders and 384px
// liquid/glass are ample, and it keeps the payload near 230KB instead of the ~2MB the originals would cost
// as base64. demo/orb.html itself keeps the full-resolution references.
//
// Run: npm run demo:orb
import sharp from "sharp";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";

const SRC = "demo/orb.html";
const OUT = "demo/orb_standalone.html";

if (!existsSync(SRC)) { console.error(`demo:orb: ${SRC} is missing.`); process.exit(1); }

// [source file, how it is referenced in orb.html, expected reference count, demo pixel size]
const ASSETS = [
  ["art/UI_orb_holder_LEFT.png",  '../art/UI_orb_holder_LEFT.png',  1, 512],
  ["art/UI_orb_holder_RIGHT.png", '../art/UI_orb_holder_RIGHT.png', 1, 512],
  ["art/UI_orb_transparent.png",  '../art/UI_orb_transparent.png',  2, 384],  // one glass per orb
  // UI_orb_red.png is deliberately NOT here: it is a colour REFERENCE, and the demo samples its palette into
  // constants rather than drawing it. Nothing loads it at runtime, so there is nothing to inline.
];

let html = readFileSync(SRC, "utf8");
let payload = 0, failed = 0;

for (const [file, ref, expect, px] of ASSETS) {
  if (!existsSync(file)) { console.error(`demo:orb: FAIL ${file} is missing`); failed++; continue; }
  const found = html.split(ref).length - 1;
  // A silent zero here would produce a "self-contained" file that still 404s, which is the whole bug this
  // script exists to prevent. So the reference count is asserted, not assumed.
  if (found !== expect) {
    console.error(`demo:orb: FAIL ${ref} appears ${found} time(s) in ${SRC}, expected ${expect}. `
                + `Did the demo markup change? Update ASSETS in scripts/inline-orb-demo.mjs.`);
    failed++; continue;
  }
  const buf = await sharp(file).resize(px, px, { fit: "inside" })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toBuffer();
  const uri = "data:image/png;base64," + buf.toString("base64");
  payload += uri.length;
  html = html.split(ref).join(uri);
  console.log(`demo:orb: inlined ${file.padEnd(30)} ${String(Math.round(statSync(file).size / 1024)).padStart(4)}KB`
            + ` -> ${String(Math.round(buf.length / 1024)).padStart(3)}KB @${px}px  x${expect}`);
}
if (failed) { console.error(`demo:orb: ${failed} failure(s); not writing ${OUT}.`); process.exit(1); }

html = html
  .replace("<title>HP orb — placeholder liquid</title>",
           "<title>HP orb — placeholder liquid (self-contained)</title>")
  .replace(/  STANDALONE PROTOTYPE\. Not part of the game[\s\S]*?open \/demo\/orb\.html\./,
`  SELF-CONTAINED build of demo/orb.html. Every image is inlined as a data URI, so this works from anywhere:
  double-click it, open it out of a downloads folder, mail it to someone. No server, no sibling art/ folder,
  nothing relative to break.

  GENERATED -- do not edit. Change demo/orb.html and re-run:  npm run demo:orb
  Art is downscaled to 512/384px for this file only; the orbs render at 300px, so that is ample and it keeps
  the payload near 230KB rather than the ~2MB the originals would cost as base64.`);

// Nothing relative may survive, or the file is not actually self-contained.
const leftovers = [...html.matchAll(/(?:src|href)\s*=\s*["'](?!data:|#)([^"']+)["']/g)].map((m) => m[1]);
if (leftovers.length) {
  console.error(`demo:orb: FAIL ${OUT} would still reference external files: ${leftovers.join(", ")}`);
  process.exit(1);
}

writeFileSync(OUT, html);
console.log(`demo:orb: wrote ${OUT} (${Math.round(Buffer.byteLength(html) / 1024)}KB, `
          + `${Math.round(payload / 1024)}KB of it inlined art) — opens standalone.`);
