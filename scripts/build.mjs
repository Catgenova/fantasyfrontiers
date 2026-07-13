// Deploy-time obfuscation build.
//
// index.html stays fully readable/editable in the repo. This produces dist/index.html with every
// inline <script> obfuscated, so GitHub Pages serves a hardened build a casual cheater can't easily
// read or tamper. NOTE: this is a deterrent only -- the real enforcement is server-side (the wallet
// + item ledger gates), which an obfuscated client can't defeat. scripts/smoke.mjs runs the unit
// suite against THIS output in CI and gates the deploy, so a broken obfuscation never ships.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import JavaScriptObfuscator from "javascript-obfuscator";

const SRC = "index.html";
const OUT_DIR = "dist";

// Conservative options: rename identifiers + a light string array, but NO control-flow flattening,
// dead-code injection, self-defending or debug-protection. Those bloat/slow a large game loop and are
// the usual cause of "obfuscated build silently breaks". The IIFE's internal names (walletSync,
// itemSync, the sync/clamp/gate logic, etc.) are nested, so they're renamed even with renameGlobals
// off; window / supabase / DOM ids / edge-function names stay intact (renameProperties off).
const OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  renameProperties: false,
  transformObjectKeys: false,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: [],
  splitStrings: false,
  numbersToExpressions: false,
  simplify: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  target: "browser",
};

// Unique per-deploy build stamp. In GitHub Actions GITHUB_SHA is the commit being deployed; locally we
// fall back to a timestamp. The running client compares this against version.json (served from Pages)
// and hard-reloads the moment they differ -- i.e. on every patch pushed to main. See scheduleUpdateChecks.
const BUILD_ID = (process.env.GITHUB_SHA || ("local-" + Date.now().toString(36))).slice(0, 40);

let html = readFileSync(SRC, "utf8");
// Bake the build id into the client (replaces the readable copy's 'dev' sentinel, which disables the
// update check). Must run BEFORE obfuscation so the value ends up inside the obfuscated script.
if (!html.includes("var FF_BUILD_ID = 'dev';")) {
  console.error("build: FF_BUILD_ID = 'dev' sentinel not found in index.html -- aborting.");
  process.exit(1);
}
html = html.replace("var FF_BUILD_ID = 'dev';", "var FF_BUILD_ID = '" + BUILD_ID + "';");

// The document has exactly two attribute-less inline <script> blocks and no <script src>; the game
// script contains no literal "</script>", so a non-greedy match extracts each block cleanly.
let count = 0;
const out = html.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
  if (!code.trim()) return m;
  const obf = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode();
  count++;
  return "<script>" + obf + "</script>";
});
if (count < 1) { console.error("build: no inline <script> blocks matched -- aborting."); process.exit(1); }

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/index.html`, out);
writeFileSync(`${OUT_DIR}/version.json`, JSON.stringify({ build: BUILD_ID }) + "\n"); // deployed build stamp the client polls
writeFileSync(`${OUT_DIR}/.nojekyll`, "");                                  // serve files verbatim
if (existsSync("tests")) cpSync("tests", `${OUT_DIR}/tests`, { recursive: true }); // keep ?selftest working
if (existsSync("CNAME")) cpSync("CNAME", `${OUT_DIR}/CNAME`);               // preserve a custom domain if set

// Note: supabase/ (backend source) is intentionally NOT copied, so the edge-function source stops
// being served from the Pages site.
console.log(`build: obfuscated ${count} script block(s) -> ${OUT_DIR}/index.html (build ${BUILD_ID})`);
