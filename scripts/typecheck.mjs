// Lightweight type/soundness gate for the single-file client.
//
// index.html ships the whole game as ONE inline <script> IIFE, so there's no per-file @ts-check to lean
// on. This extracts that script and runs the TypeScript compiler over it in checkJs mode -- but instead of
// surfacing the flood of "property does not exist on this inferred object literal" noise that a blanket
// checkJs produces on 24k lines of dynamically-shaped game code, it reports ONLY a curated set of
// HIGH-SIGNAL diagnostics that are almost always real bugs:
//
//   2304 Cannot find name 'X'                 <- typos / undefined identifiers (e.g. a renamed item key,
//   2552 Cannot find name 'X', did you mean.. <-   or calling a function that was removed)
//   2448/2454 used before its declaration/assignment  (let/const temporal-dead-zone -- real bugs)
//   2451 Cannot redeclare block-scoped variable
//   2588 Cannot assign to 'X' because it is a constant
//
// Wrong-arity codes (2554/2555) are deliberately EXCLUDED: idiomatic JS calls functions with fewer args
// than params all the time (optional trailing args), so they'd be pure noise until functions are JSDoc'd.
// Diagnostics are mapped back to index.html line numbers so they're clickable. Exit 1 if any fire.
//   node scripts/typecheck.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const HIGH_SIGNAL = new Set([2304, 2552, 2448, 2454, 2451, 2588]);

// 1) Extract the largest inline <script> block (the game IIFE) + the line it starts on in index.html.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const re = /<script>([\s\S]*?)<\/script>/g;
let m, best = null;
while ((m = re.exec(html)) !== null) {
  if (!best || m[1].length > best.code.length) best = { code: m[1], index: m.index + m[0].indexOf(m[1]) };
}
if (!best) { console.error("typecheck: no inline <script> block found in index.html -- aborting."); process.exit(1); }
const lineOffset = html.slice(0, best.index).split("\n").length - 1; // 0-based lines before the script body

// 2) Ambient globals the IIFE relies on but doesn't declare itself (the Supabase client is injected at
//    runtime; the __FF* seams are set on window). Keeps these out of the "cannot find name" results.
const AMBIENT = `
declare global {
  interface Window { supabase: any; __FF: any; __FF_SELFTEST: any; __ffItemShadow: any; FF_BUILD_ID: any; }
  var supabase: any;
}
export {};
`;

const GAME = "game.js", GLOBALS = "globals.d.ts";
const sources = { [GAME]: best.code, [GLOBALS]: AMBIENT };
const options = {
  allowJs: true, checkJs: true, noEmit: true, strict: false, noImplicitAny: false,
  noImplicitThis: false, skipLibCheck: true, target: ts.ScriptTarget.ES2020,
  lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.es2021.d.ts"], types: [],
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
};

// 3) In-memory compiler host (no temp files on disk).
const defaultHost = ts.createCompilerHost(options);
const host = {
  ...defaultHost,
  getSourceFile(name, langVersion, onErr) {
    if (sources[name] != null) return ts.createSourceFile(name, sources[name], langVersion, true, name === GAME ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    return defaultHost.getSourceFile(name, langVersion, onErr);
  },
  fileExists(name) { return sources[name] != null || defaultHost.fileExists(name); },
  readFile(name) { return sources[name] != null ? sources[name] : defaultHost.readFile(name); },
  writeFile() {},
};

const program = ts.createProgram([GAME, GLOBALS], options, host);
const all = ts.getPreEmitDiagnostics(program);
const hits = all.filter((d) => d.file && d.file.fileName === GAME && HIGH_SIGNAL.has(d.code));

if (hits.length === 0) {
  console.log(`typecheck: clean (${all.length} total diagnostics scanned, 0 high-signal). checked index.html inline script (${best.code.split("\n").length} lines).`);
  process.exit(0);
}
console.error(`typecheck: ${hits.length} high-signal issue(s) in index.html:\n`);
for (const d of hits) {
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  console.error(`  index.html:${line + 1 + lineOffset}:${character + 1}  TS${d.code}  ${msg}`);
}
console.error(`\n(High-signal codes: cannot-find-name / used-before-def / redeclare / assign-to-const.)`);
process.exit(1);
