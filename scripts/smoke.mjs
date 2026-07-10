// CI smoke test that GATES the deploy.
//
// Serves dist/ and drives the OBFUSCATED build in headless Chromium: it runs the unit suite
// (?selftest) against the obfuscated code and confirms the game boots with no page errors. If
// anything fails this exits non-zero, the deploy job (needs: build) is skipped, and production is
// left untouched -- so a broken obfuscation can never reach players.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, normalize, join } from "node:path";
import { chromium } from "playwright";

const DIR = "dist";
const PORT = 4173;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const fp = join(DIR, normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(fp)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(fp)] || "application/octet-stream" });
  res.end(readFileSync(fp));
});
await new Promise((r) => server.listen(PORT, r));

const base = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
let failed = false;
try {
  // 1) Unit suite against the obfuscated build.
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.goto(base + "?selftest", { waitUntil: "domcontentloaded" });
  // Wait for the suite to finish, THEN read the full result object (waitForFunction resolves to the
  // predicate's return value, not __FF_SELFTEST -- so fetch the object with a separate evaluate).
  await page
    .waitForFunction(() => window.__FF_SELFTEST && (window.__FF_SELFTEST.passed || window.__FF_SELFTEST.error), null, { timeout: 45000 })
    .catch(() => null);
  const st = await page.evaluate(() => window.__FF_SELFTEST || null);
  console.log("smoke: selftest =", JSON.stringify(st));
  if (!st || st.error || st.failed > 0 || !(st.passed > 0)) { console.error("smoke: SELFTEST FAILED"); failed = true; }

  // 2) Normal boot (no ?selftest): the shell renders and nothing throws.
  const page2 = await browser.newPage();
  const errs2 = [];
  page2.on("pageerror", (e) => errs2.push("pageerror: " + e.message));
  await page2.goto(base, { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(2500);
  const booted = await page2.evaluate(() => !!document.querySelector(".ff-brand, #ffCoinVal, #hdrGold"));
  if (!booted) { console.error("smoke: GAME DID NOT BOOT (no shell element found)"); failed = true; }
  if (errs2.length) { console.error("smoke: BOOT ERRORS:\n" + errs2.join("\n")); failed = true; }
  if (errs.length) console.error("smoke: selftest-page errors:\n" + errs.join("\n"));
} catch (e) {
  console.error("smoke: THREW:", e && e.message); failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
