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

// ---- Secret guard: nothing credential-shaped may reach a build we serve publicly -------------------
// A pentest (2026-07-31) found the community-feed Discord webhook as a plain literal in index.html. It had
// therefore been readable by every player for as long as it existed -- obfuscation is no defence, since the
// URL survives as a string. Webhooks now live as edge-function secrets, and this check FAILS THE DEPLOY if
// one is ever pasted back into the client, because CI runs `npm run build` before publishing. Cheap, and it
// catches the whole class rather than the one instance.
const SECRET_PATTERNS = [
  [/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i, "a Discord webhook URL"],
  [/\bsk-[A-Za-z0-9]{20,}/,                             "an API secret key"],
  [/\bservice_role\b\s*[:=]\s*['\"][^'\"]+['\"]/i,      "a service-role key"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]{20,}/,                   "a JWT (use the publishable key only)"],
  // Turnstile SITE and SECRET keys share the 0x4A... prefix and are easy to mix up in a dashboard, but they
  // differ in length: a site key is ~24 characters total, a secret ~34. Anything long enough to be a secret
  // has no business in client code, so length is the discriminator. The real site key is well under this.
  [/0x4A[A-Za-z0-9_-]{28,}/,                            "a Turnstile SECRET key (the client takes the SITE key)"],
];
for (const [re, what] of SECRET_PATTERNS) {
  const m = html.match(re);
  if (m) {
    console.error(`build: refusing to build -- ${SRC} contains ${what}.`);
    console.error(`  found: ${m[0].slice(0, 48)}...`);
    console.error(`  Client code is served to every player in clear text. Move it to an edge-function secret.`);
    process.exit(1);
  }
}

// ---- Fatal-pattern guard: the Turnstile render-loop -------------------------------------------------
// SHIPPED ONCE, and it made the login screen unusable: the Turnstile success callback called authRender(),
// which rebuilds the gate's innerHTML, which destroys the widget, which turnstileMount() then re-creates,
// which challenges, which fires the callback again. The box sat on "Verifying..." and flashed forever.
// Nothing in the gate's markup reads turnstileToken (the submit button holds-and-resumes rather than being
// disabled), so a render from inside these callbacks is never needed and always loops. Gate the deploy on it.
{
  const at = html.indexOf("window.turnstile.render(");
  if (at !== -1) {
    // Strip line comments FIRST -- the guard's own explanatory comment says "authRender()" and matched
    // itself, which failed the build on correct code. Then brace-match to the end of the options object so
    // the scan cannot overrun into unrelated code that legitimately renders.
    const raw = html.slice(at, at + 2500).replace(/\/\/[^\n]*/g, "");
    const open = raw.indexOf("{");
    let region = raw;
    if (open !== -1) {
      let depth = 0;
      for (let i = open; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}" && --depth === 0) { region = raw.slice(open, i + 1); break; }
      }
    }
    if (/authRender\s*\(/.test(region)) {
      console.error("build: refusing to build -- authRender() is called from inside a Turnstile callback.");
      console.error("  That rebuilds the gate, destroys the widget, and re-mounts it -> infinite re-challenge loop.");
      console.error("  The login screen sticks on 'Verifying...'. Remove the render; nothing there depends on the token.");
      process.exit(1);
    }
  }
}

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
if (existsSync("favicon.svg")) cpSync("favicon.svg", `${OUT_DIR}/favicon.svg`); // browser-tab icon (the crest logo)
if (existsSync("art")) cpSync("art", `${OUT_DIR}/art`, { recursive: true });     // painted class icons (see art/README.md)

// Note: supabase/ (backend source) is intentionally NOT copied, so the edge-function source stops
// being served from the Pages site.
console.log(`build: obfuscated ${count} script block(s) -> ${OUT_DIR}/index.html (build ${BUILD_ID})`);
