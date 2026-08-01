// Verify every painted class icon actually SERVES and DECODES from the built output.
//
// Why this exists: CLASS_ART is deliberately fail-soft -- a missing or misnamed file flips no flag, so the
// class silently keeps its old SVG portrait and nothing breaks. That is the right runtime behaviour and the
// wrong thing to rely on at build time, because a typo produces no error anywhere. The selftest can only
// check the MAP (keys are real class ids, filenames match); it cannot check that the bytes exist and are a
// valid image. This does, against dist/ -- i.e. against what Pages will actually publish.
//
// Run: PW_CHROMIUM=/opt/pw-browsers/chromium node scripts/artcheck.mjs   (npm run artcheck)
// Exits non-zero if any declared icon 404s, fails to decode, or is absurdly large.
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";

const OUT_DIR = "dist";
// Rendered at 104px in the arena, so 2x DPI wants ~208px. Anything past 1024 is wasted bytes on every boot.
// Size is ADVISORY, not a gate. A deploy must never fail because art is 20KB heavier than ideal -- the gates
// here are the ones that mean the feature is actually broken (404, undecodable, too small to render). The
// hard ceiling only catches a genuine mistake, like uploading a print-resolution export.
const MAX_KB = 1000;     // hard fail: nobody meant to ship this
const WARN_KB = 150;     // advisory: worth downscaling
const MIN_PX = 208;      // must survive the 104px arena render on a 2x display

const MIME = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json",
               ".png":"image/png", ".webp":"image/webp", ".svg":"image/svg+xml", ".md":"text/plain" };

if (!existsSync(`${OUT_DIR}/index.html`)) {
  console.error("artcheck: no dist/index.html -- run `npm run build` first.");
  process.exit(1);
}

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html");
  const p = OUT_DIR + rel;
  if (!existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[p.slice(p.lastIndexOf("."))] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => srv.listen(0, r));
const base = "http://127.0.0.1:" + srv.address().port;

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
await page.goto(`${base}/index.html?selftest`, { waitUntil: "domcontentloaded" });

const art = await page.evaluate(() => (window.__FF && window.__FF.CLASS_ART) || null);
if (!art) { console.error("artcheck: window.__FF.CLASS_ART not exposed -- is the seam intact?"); process.exit(1); }

let failed = 0, warned = 0;
const names = await page.evaluate(() => {
  const out = {}; (window.__FF.CLASS_DEFS || []).forEach((c) => { out[c.id] = c.name; }); return out;
});

for (const [cid, path] of Object.entries(art)) {
  // Fetch and decode IN THE PAGE, at the same relative path the running client will use -- so a path that
  // only works from the repo root, or an image the browser cannot decode, fails here rather than in prod.
  const r = await page.evaluate(async (u) => {
    const resp = await fetch(u);
    if (!resp.ok) return { ok: false, status: resp.status };
    const blob = await resp.blob();
    let w = 0, h = 0;
    try { const bmp = await createImageBitmap(blob); w = bmp.width; h = bmp.height; } catch { /* undecodable */ }
    return { ok: true, status: resp.status, bytes: blob.size, type: blob.type, w, h };
  }, `${base}/${path}`);

  const kb = r.bytes ? Math.round(r.bytes / 1024) : 0;
  const label = `${cid} (${names[cid] || "?"})`;
  if (!r.ok)            { console.error(`artcheck: FAIL ${label} -> ${path} returned ${r.status}`); failed++; continue; }
  if (!r.w)             { console.error(`artcheck: FAIL ${label} -> ${path} did not decode as an image`); failed++; continue; }
  if (r.w < MIN_PX || r.h < MIN_PX) { console.error(`artcheck: FAIL ${label} -> ${r.w}x${r.h} is under ${MIN_PX}px; it will look soft at the 104px arena size on a 2x display`); failed++; continue; }
  if (kb > MAX_KB)      { console.error(`artcheck: FAIL ${label} -> ${kb}KB exceeds ${MAX_KB}KB; that is a print-resolution export, not a UI icon`); failed++; continue; }
  if (kb > WARN_KB)     { console.warn(`artcheck: warn ${label} -> ${kb}KB (over ${WARN_KB}KB). Rendered at most 104px, so downscaling to ~256px would cut this a long way.`); warned++; }
  console.log(`artcheck: ok   ${label.padEnd(30)} ${path.padEnd(24)} ${r.w}x${r.h} ${String(kb).padStart(4)}KB ${r.type}`);
}

await browser.close();
srv.close();
const n = Object.keys(art).length;
console.log(`artcheck: ${n - failed}/${n} class icon(s) serve and decode${warned ? `, ${warned} oversized` : ""}.`);
process.exit(failed ? 1 : 0);
