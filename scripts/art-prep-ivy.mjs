// Prepare the delivered ivy/marble UI set for use: rename, TRIM, crop, recompress -- and print the measured
// wells and border-image slices the CSS needs.
//
// Run: node scripts/art-prep-ivy.mjs
//
// Three things have to happen before this art is usable, and only the first is obvious.
//
// 1. SIZE. The five frames plus the marble field arrive at ~5.4MB. artcheck fails anything over 1MB and two
//    of them are over it on their own, so they are requantised. Dimensions are kept (or barely reduced):
//    these are thin stone edges and carved relief, where downscaling shows immediately.
//
// 2. TRIM. Every frame ships inside a large transparent margin -- the bar frame's art occupies only y
//    29.2%..69.2% of its canvas. That margin makes a frame UNSLICEABLE: border-image measures its slices
//    from the image edge, so a 28px CSS border would compress a 279px slice by 10x and squash the ivy into
//    mush. Trimming to the art's own bounds is what makes these usable as 9-slice borders at any size.
//
// The originals live in art/src/, which scripts/build.mjs EXCLUDES from dist -- so they stay in the repo for
// reproducibility without shipping 5.4MB to every player who loads the game.
//
// 3. A STANDALONE PORTRAIT RING. The delivered set has no circular portrait frame; the two round sockets are
//    baked into the corners of the big arena frame. One of them is cropped out here to become that asset,
//    which is the one thing in this pass that creates art rather than conditioning it.
import sharp from "sharp";
import { existsSync, statSync, unlinkSync } from "node:fs";

const SRC = {
  arena:  "art/src/1785591602842.png",   // 1254^2, two round portrait sockets in the top corners
  panel:  "art/src/1785591781658.png",   // wide plain stone+ivy frame  -> name plates + the mini log
  plinthL:"art/src/1785591789628.png",   // ring on the RIGHT  (figure outer-left)  -> player side
  plinthR:"art/src/1785591812790.png",   // ring on the LEFT   (figure outer-right) -> foe side
  bar:    "art/src/1785592029403.png",   // long thin slotted frame -> swing bars
  field:  "art/src/marble_field_original.png", // seamless marble -> the stage surface
};
for (const [k, p] of Object.entries(SRC)) {
  if (!existsSync(p)) { console.error(`art-prep-ivy: FAIL missing ${k} -> ${p}`); process.exit(1); }
}

const kb = (n) => Math.round(n / 1024);
const png = (s) => s.png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 });

// Interior transparent holes (the wells), as percentages of the TRIMMED image -- a plain alpha bbox reports
// the whole canvas for a frame, so the outside has to be flood-filled away first.
async function wells(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, OP = 40;
  const A = (x, y) => data[(y * W + x) * C + 3];
  const out = new Uint8Array(W * H), st = [];
  for (let x = 0; x < W; x++) st.push(x, 0, x, H - 1);
  for (let y = 0; y < H; y++) st.push(0, y, W - 1, y);
  while (st.length) {
    const y = st.pop(), x = st.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (out[i] || A(x, y) >= OP) continue;
    out[i] = 1; st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  const seen = new Uint8Array(W * H), holes = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (seen[i] || out[i] || A(x, y) >= OP) continue;
    let x0 = x, y0 = y, x1 = x, y1 = y, n = 0; const s2 = [x, y];
    while (s2.length) {
      const cy = s2.pop(), cx = s2.pop();
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const j = cy * W + cx;
      if (seen[j] || out[j] || A(cx, cy) >= OP) continue;
      seen[j] = 1; n++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      s2.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
    }
    if (n > W * H * 0.002) holes.push({ x0, y0, x1, y1, n, W, H });
  }
  return holes.sort((a, b) => b.n - a.n);
}
const fmtWell = (h) => {
  const w = h.x1 - h.x0 + 1, hh = h.y1 - h.y0 + 1;
  const round = Math.abs(w / hh - 1) < 0.08 && h.n / (w * hh) > 0.7 && h.n / (w * hh) < 0.86;
  return `${round ? "circle" : "rect  "} left:${(h.x0 / h.W * 100).toFixed(2)}% top:${(h.y0 / h.H * 100).toFixed(2)}%`
       + ` width:${(w / h.W * 100).toFixed(2)}% height:${(hh / h.H * 100).toFixed(2)}%`;
};
// border-image slice, in TRIMMED pixels: the distance from each edge to the well.
const fmtSlice = (h) => `border-image slice: ${h.y0} ${h.W - 1 - h.x1} ${h.H - 1 - h.y1} ${h.x0}`
                      + `   (top right bottom left)`;

// A tight alpha bounding box, in source pixels. `trim()` does this internally but does not tell us where it
// cut, and the pair alignment below needs the offsets.
async function contentBox(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * C + 3] >= 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---- MATCHED MIRROR PAIRS ------------------------------------------------------------------------------
// A LEFT/RIGHT pair MUST leave here at the same pixel size with its well in mirrored positions. Trimming the
// two halves independently -- which is what the plain emit() above does -- is what broke the combat stage:
// the pieces are hand-drawn, not exact mirrors, so the right plinth's ring came out 434x464 in source against
// the left's 397x413. Each was then trimmed tight and scaled to width 900, so they landed at 900x506 and
// 900x539: at the same rendered width the foe's half was 14px taller, its HP orb 9% larger, and its orb centre
// 8px higher than the player's. Two different-sized orbs is the bug the player sees; the mismatched canvas is
// the cause, and no CSS can fix it because the boxes genuinely differ.
//
// So the pair is normalised HERE, on the one feature that has to agree -- the well:
//   1. Scale each half so its well is the same WIDTH (uniform scale; distorting carved stone is worse than a
//      1% oval), keyed on the mean of the two so neither is upscaled far.
//   2. Lay both onto ONE canvas, VERTICALLY aligned on the well centre so the two wells end up the same size
//      at the same height -- which is the whole point.
// Two images of identical size, one shared well width/height/top, one `left` per side.
//
// HORIZONTALLY there is a trade-off the art forces, and `joinAt:"centre"` is the answer for a pair that has to
// LOOK like one bench. Once the two rings are the same size the right-hand bench is genuinely ~75px shorter
// than the left one, so the pair cannot both butt at the centre AND reach both outer edges. Aligning on the
// well centre (the obvious choice) spends that slack on the INNER edge, which opened a 7px seam right where
// the two carvings are supposed to meet -- the most visible place to put it. So each half is flushed to its
// INNER edge instead and the slack falls on the outer edge, where the stage's own ivy border is already busy.
// The cost is that the two wells are then ~2% off exact mirror symmetry; nobody compares a well's distance to
// the centre line across two different carvings, and everybody sees a gap in a join.
//
// Without joinAt the halves align on the well centre, which is right for pieces that do not touch each other
// (the portrait rings hang off opposite corners, and their residual pads are under 3px rendered).
//
// The bench bases can then sit a couple of source pixels apart (the halves differ in height above the well).
// Anchoring vertically on the well rather than the bottom is deliberate: at the rendered size that residual is
// ~1px of transparent padding, while a mismatched orb is the thing that reads as broken.
async function emitPair(nameA, nameB, srcA, srcB, outWidth, opts = {}) {
  const halves = [];
  for (const [name, srcPath] of [[nameA, srcA], [nameB, srcB]]) {
    let src = srcPath;
    if (opts[name] && opts[name].extract) src = await sharp(srcPath).extract(opts[name].extract).png().toBuffer();
    const bb = await contentBox(src);
    const cropped = await sharp(src).extract({ left: bb.x0, top: bb.y0, width: bb.w, height: bb.h }).png().toBuffer();
    const hole = (await wells(cropped))[0];
    if (!hole) { console.error(`art-prep-ivy: FAIL ${name} has no interior well to align the pair on`); process.exit(1); }
    halves.push({ name, srcPath, cropped, bb,
                  hole: { w: hole.x1 - hole.x0 + 1, h: hole.y1 - hole.y0 + 1,
                          cx: (hole.x0 + hole.x1) / 2, cy: (hole.y0 + hole.y1) / 2 } });
  }
  // 1. one well width for both. Everything after this is INTEGER pixels, measured off the resized buffer that
  //    is actually composited -- deriving the canvas from float predictions overflowed it by a pixel, which
  //    sharp rejects outright ("Image to composite must have same dimensions or smaller").
  const ringWant = (halves[0].hole.w + halves[1].hole.w) / 2;
  for (const h of halves) {
    h.scaled = await sharp(h.cropped).resize({ width: Math.round(h.bb.w * (ringWant / h.hole.w)) }).png().toBuffer();
    const m = await sharp(h.scaled).metadata();
    h.sw = m.width; h.sh = m.height;
    h.rx = Math.round(h.hole.cx * h.sw / h.bb.w);   // well centre in the resized buffer
    h.ry = Math.round(h.hole.cy * h.sh / h.bb.h);
    h.rw = h.hole.w * h.sw / h.bb.w;
    h.rh = h.hole.h * h.sh / h.bb.h;
  }
  // 2. the union canvas. Vertically it is measured outward from the well centre, so both wells land on one
  //    line: taking the max reach above and below across both halves fits either of them by construction.
  //    Horizontally it is either the same treatment (default) or the inner-edge join (joinAt:'centre').
  const A = Math.max(halves[0].rx, halves[1].sw - halves[1].rx);
  const B = Math.max(halves[0].sw - halves[0].rx, halves[1].rx);
  const T = Math.max(halves[0].ry, halves[1].ry);
  const D = Math.max(halves[0].sh - halves[0].ry, halves[1].sh - halves[1].ry);
  const join = opts.joinAt === "centre";
  const CW = join ? Math.max(halves[0].sw, halves[1].sw) : A + B;
  const CH = T + D;
  const ringW = (halves[0].rw + halves[1].rw) / 2;
  const ringH = (halves[0].rh + halves[1].rh) / 2;
  const scale = outWidth / CW;

  for (let i = 0; i < halves.length; i++) {
    const h = halves[i];
    // joinAt:'centre' -- half 0 is the stage's LEFT piece, so its inner edge is its RIGHT one: flush it right.
    // Half 1 is the RIGHT piece: flush it left. Either way the two inner edges meet with no seam.
    const offX = join ? (i === 0 ? CW - h.sw : 0) : ((i === 0 ? A : B) - h.rx);
    const targetX = offX + h.rx;
    // COMPOSITE IN ITS OWN PASS, for the same reason extract gets one above: sharp does not honour chain
    // order, so `.composite().resize()` shrinks the base canvas to outWidth FIRST and then rejects the
    // full-size half as "must have same dimensions or smaller".
    const laid = await sharp({ create: { width: CW, height: CH, channels: 4,
                                         background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: h.scaled, left: offX, top: T - h.ry }]).png().toBuffer();
    const buf = await png(sharp(laid).resize({ width: outWidth })).toBuffer();
    const dest = `art/${h.name}.png`;
    await sharp(buf).toFile(dest);
    const m = await sharp(buf).metadata();
    const before = statSync(h.srcPath).size;
    console.log(`\n${dest}   ${m.width}x${m.height}   ${kb(before)}KB -> ${kb(buf.length)}KB`
              + `  (${Math.round((1 - buf.length / before) * 100)}% smaller)`);
    h.wellLeftPct = (targetX - ringW / 2) / CW * 100;
    OUT.push({ dest, w: m.width, h: m.height, kb: kb(buf.length), wells: [] });
  }
  console.log(`\n   PAIR ${nameA} / ${nameB}: both ${Math.round(CW * scale)}x${Math.round(CH * scale)}`
            + `   well ${Math.round(ringW * scale)}x${Math.round(ringH * scale)}`);
  console.log(`   SHARED well rule -- width:${(ringW / CW * 100).toFixed(2)}% height:${(ringH / CH * 100).toFixed(2)}%`
            + ` top:${((T - ringH / 2) / CH * 100).toFixed(2)}%`);
  console.log(`     ${nameA} left:${halves[0].wellLeftPct.toFixed(2)}%    ${nameB} left:${halves[1].wellLeftPct.toFixed(2)}%`
            + (join ? `   (inner edges joined; these are MEASURED, not mirrored)`
                    : `   (mirrored: they sum with the width to 100%)`));
}

const OUT = [];
async function emit(name, srcPath, opts = {}) {
  // EXTRACT IN ITS OWN PASS. sharp does not honour chain order -- it runs trim BEFORE a chained extract, so
  // `.extract().trim()` applies the crop to an already-shrunk image. That threw "bad extract area" on the
  // right-hand ring and, far worse, SILENTLY cropped the wrong region for the left one, which sits near the
  // origin and so still fell inside the trimmed bounds. Two stages makes the order explicit.
  let src = srcPath;
  if (opts.extract) src = await sharp(srcPath).extract(opts.extract).png().toBuffer();
  let s = sharp(src);
  // TRIM the transparent margin -- the step that makes a frame sliceable at all.
  if (opts.trim !== false) s = s.trim({ threshold: 1 });
  if (opts.width) s = s.resize({ width: opts.width });
  const buf = await png(s).toBuffer();
  const m = await sharp(buf).metadata();
  const dest = `art/${name}.png`;
  await sharp(buf).toFile(dest);
  const before = statSync(opts.srcSizeFrom || srcPath).size;
  console.log(`\n${dest}   ${m.width}x${m.height}   ${kb(before)}KB -> ${kb(buf.length)}KB`
            + `  (${Math.round((1 - buf.length / before) * 100)}% smaller)`);
  if (opts.noWells) return;
  const hs = await wells(buf);
  for (const h of hs) {
    console.log(`   ${fmtWell(h)}`);
    if (!h.circleOnly) console.log(`   ${fmtSlice(h)}`);
  }
  OUT.push({ dest, w: m.width, h: m.height, kb: kb(buf.length), wells: hs.map(fmtWell) });
}

console.log("art-prep-ivy: trimming, cropping and requantising the delivered ivy set\n"
          + "=".repeat(78));

await emit("ivy_panel",   SRC.panel,   { width: 900 });
await emit("ivy_bar",     SRC.bar,     { width: 760 });
await emitPair("ivy_plinth_LEFT", "ivy_plinth_RIGHT", SRC.plinthL, SRC.plinthR, 900, { joinAt: "centre" });
await emit("ivy_arena",   SRC.arena,   { width: 1100 });

// The portrait ring: crop the arena frame's LEFT socket with a margin, so the stone ring and its ivy come
// with it. Measured at left 4.15% / top 4.31% / 15.63% square on a 1254 canvas.
{
  const m = await sharp(SRC.arena).metadata();
  const pad = Math.round(m.width * 0.042);
  const x = Math.max(0, Math.round(m.width * 0.0415) - pad);
  const y = Math.max(0, Math.round(m.height * 0.0431) - pad);
  const w = Math.round(m.width * 0.1563) + pad * 2;
  const h = Math.round(m.height * 0.1595) + pad * 2;
  await emit("ivy_portrait", SRC.arena, { extract: { left: x, top: y, width: w, height: h }, width: 320 });
}

// ---- the second upload: a SPRITE SHEET of three pieces ----
// Labelled by 8-connected opaque components (8-connected so a hairline ivy tendril cannot split a piece in
// two) and cut apart. The bounds are MEASURED, not guessed:
//   left:34  top:39   437x417   the LEFT anchor ring  (ivy scroll tailing inward, to the right)
//   left:789 top:39   429x417   the RIGHT anchor ring (mirrored)
//   left:33  top:530  1186x685  the plain STRETCH frame -- symmetric, clean identical corners
//
// The stretch frame supersedes ivy_panel for every framed box. ivy_panel's slices came out lopsided
// (28/29/35/28) because its art is not symmetric, which shows as uneven borders once a box is small.
const SHEET = "art/src/1785594425096.png";
if (existsSync(SHEET)) {
  // Paired for the same reason as the plinths: trimmed apart they came out 420x401 and 420x408, so the foe's
  // portrait socket rendered 1.7% taller than the player's and each side needed its own well rule.
  await emitPair("ivy_ring_LEFT", "ivy_ring_RIGHT", SHEET, SHEET, 420, {
    ivy_ring_LEFT:  { extract: { left: 34,  top: 39, width: 437, height: 417 } },
    ivy_ring_RIGHT: { extract: { left: 789, top: 39, width: 429, height: 417 } },
  });
  await emit("ivy_stretch",    SHEET, { extract: { left: 33,  top: 530, width: 1186, height: 685 }, width: 900 });
}

// The marble field is a TILE, so it must not be trimmed (nothing transparent) and wants to stay modest --
// it repeats, so its pixel size is a tile size, not a display size.
//
// It is also SOFTENED, and that is the point of this step rather than a preference. The delivered marble is a
// strong crackle; at full strength every label on the stage ("Companions", "Your Effects", the foe's element
// line) sits on visible pattern, which is the exact failure the slate study measured as edge density. Veiling
// it toward white flattens the contrast range under a glyph while keeping the veining legible as marble.
{
  const m = await sharp(SRC.field).metadata();
  const veiled = await sharp(SRC.field)
    .composite([{ input: { create: { width: m.width, height: m.height, channels: 4,
                                     background: { r: 255, g: 255, b: 255, alpha: 0.55 } } } }])
    .png().toBuffer();
  await emit("ivy_field", veiled, { trim: false, width: 700, noWells: true, srcSizeFrom: SRC.field });
}

console.log("\n" + "=".repeat(78));
console.log("art-prep-ivy: done. Originals stay in art/src/, which build.mjs excludes from dist -- reproducible");
console.log("              here, and not 5.4MB of dead weight on every player's first load.");
