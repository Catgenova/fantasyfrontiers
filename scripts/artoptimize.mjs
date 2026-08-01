// Turn the delivered class art into the small copies the game actually serves.
//
//   art/src/<name>.png   the file as delivered by the artist -- the source of truth, never served
//   art/<name>.png       what the client fetches: RENDER_PX square, palette-quantised
//
// Run: npm run art:optimize   (idempotent; re-run after dropping a new source in)
//
// WHY PALETTE PNG AND NOT WEBP. Measured on the first two icons, weighting error by ALPHA so fully
// transparent pixels (whose RGB is undefined and differs wildly) don't pollute the average:
//
//   palette PNG  39KB   visible MAE 1.71/255   peak 49
//   webp q90     34KB   visible MAE 3.96/255   peak 130
//
// Palette wins on fidelity at the same size, which is the opposite of the usual answer and is a property of
// THIS content: flat vector-style illustration with a limited palette quantises almost losslessly, while
// lossy DCT rings around the hard edges (blade highlights, mask outline). It also keeps one format with no
// browser-support question. If a future icon is painterly rather than vector, re-measure -- do not assume.
//
// (An un-weighted MAE said the opposite, 15.84 vs 7.58, and would have picked webp. Averaging over invisible
// pixels is the trap; the alpha weighting is what makes the number mean anything.)
//
// WHY 384px. The art renders at 104px in the combat arena, 26px on a Classes card, 24px on a leaderboard row.
// 384 covers the largest at 3x device pixel ratio with margin, and costs ~40KB.
import sharp from "sharp";
import { readdirSync, statSync, existsSync, mkdirSync } from "node:fs";

const SRC_DIR = "art/src";
const OUT_DIR = "art";
const RENDER_PX = 384;

if (!existsSync(SRC_DIR)) {
  console.error(`art:optimize: no ${SRC_DIR}/ -- put the delivered files there (see art/README.md).`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const sources = readdirSync(SRC_DIR).filter((f) => /\.(png|webp|jpe?g)$/i.test(f));
if (!sources.length) { console.error(`art:optimize: ${SRC_DIR}/ holds no images.`); process.exit(1); }

let totalIn = 0, totalOut = 0, failed = 0;
for (const file of sources) {
  const inPath = `${SRC_DIR}/${file}`;
  const base = file.replace(/\.(png|webp|jpe?g)$/i, "").toLowerCase();
  const outPath = `${OUT_DIR}/${base}.png`;
  try {
    const meta = await sharp(inPath).metadata();
    if (!meta.hasAlpha) {
      console.warn(`art:optimize: warn ${file} has no alpha channel -- the corners will be opaque inside the circular crop.`);
    }
    if (Math.min(meta.width, meta.height) < RENDER_PX) {
      console.warn(`art:optimize: warn ${file} is ${meta.width}x${meta.height}, smaller than the ${RENDER_PX}px target -- it will be upscaled and look soft.`);
    }
    await sharp(inPath)
      .resize(RENDER_PX, RENDER_PX, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
      .toFile(outPath);
    const inKb = statSync(inPath).size / 1024, outKb = statSync(outPath).size / 1024;
    totalIn += inKb; totalOut += outKb;
    console.log(`art:optimize: ${base.padEnd(16)} ${meta.width}x${meta.height} ${String(Math.round(inKb)).padStart(4)}KB  ->  ${RENDER_PX}x${RENDER_PX} ${String(Math.round(outKb)).padStart(3)}KB  (-${Math.round((1 - outKb / inKb) * 100)}%)`);
  } catch (e) {
    console.error(`art:optimize: FAIL ${file} -- ${e.message}`);
    failed++;
  }
}
if (totalIn > 0) {
  console.log(`art:optimize: ${sources.length - failed}/${sources.length} written. ${Math.round(totalIn)}KB of sources -> ${Math.round(totalOut)}KB served (-${Math.round((1 - totalOut / totalIn) * 100)}%).`);
}
process.exit(failed ? 1 : 0);
