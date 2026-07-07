// CI runner for the browser unit tests.
//
// Serves the repo over a throwaway localhost port, opens index.html?selftest in headless
// Chrome (Puppeteer's bundled Chromium), waits for window.__FF_SELFTEST, prints the summary,
// and exits non-zero if any assertion failed. Used by .github/workflows/tests.yml; also
// runnable locally with `cd tests && npm install && node run-unit.mjs`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // repo root (tests/ is one level down)
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(normalize(ROOT))) { res.statusCode = 403; return res.end('forbidden'); }
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/index.html?selftest`;
console.log('Serving repo, loading', url);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let failed = 1;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.__FF_SELFTEST && (typeof window.__FF_SELFTEST.passed === "number" || window.__FF_SELFTEST.error)', { timeout: 30000 });
  const r = await page.evaluate(() => window.__FF_SELFTEST);
  if (r.error) {
    console.log('Unit tests could not run:', r.error);
  } else {
    console.log(`Unit tests: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures && r.failures.length) console.log('Failures:\n - ' + r.failures.join('\n - '));
    failed = r.failed;
  }
} catch (e) {
  console.log('Runner error:', e.message);
} finally {
  await browser.close();
  server.close();
}

process.exit(failed > 0 ? 1 : 0);
