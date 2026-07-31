// Soundness gate for the Supabase Edge Functions.
//
// WHY THIS EXISTS. scripts/typecheck.mjs covers index.html only, so supabase/functions/** was entirely
// unchecked -- and that cost us: a CAPTCHA guard in `register` referenced a `body` variable that does not
// exist in that function (the parsed request is block-scoped to a try). A plain ReferenceError, invisible in
// review, dormant until TURNSTILE_SECRET was set -- at which point it broke EVERY sign-up while sign-in
// kept working. "Cannot find name" would have caught it instantly, so now there is a check that does.
//
// Same curated-diagnostics approach as the client gate: report only codes that are almost always real bugs,
// rather than the flood a blanket check produces on Deno sources with remote imports.
//   node scripts/typecheck-functions.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const HIGH_SIGNAL = new Set([2304, 2552, 2448, 2454, 2451, 2588]);
const FN_DIR = join(ROOT, "supabase", "functions");

if (!existsSync(FN_DIR)) {
  console.log("typecheck-functions: no supabase/functions directory -- nothing to do.");
  process.exit(0);
}

// Deno globals + remote-module shims. Edge functions import from https://esm.sh/... which the compiler
// cannot resolve, and use the Deno namespace, which it does not know. Declared as `any` here rather than
// filtered out afterwards, so a genuine cannot-find-name is never buried under module noise.
const AMBIENT = `
declare namespace Deno {
  export const env: { get(k: string): string | undefined };
  export function serve(h: (req: Request) => Response | Promise<Response>): void;
}
declare module "https://esm.sh/@supabase/supabase-js@2" {
  export function createClient(...a: any[]): any;
}
`;

const names = readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(FN_DIR, d.name, "index.ts")))
  .map((d) => d.name)
  .sort();
if (!names.length) {
  console.log("typecheck-functions: no function index.ts files found -- nothing to do.");
  process.exit(0);
}

const AMBIENT_NAME = "__edge_ambient.d.ts";
const sources = { [AMBIENT_NAME]: AMBIENT };
const checked = {};
for (const name of names) {
  const rel = `supabase/functions/${name}/index.ts`;
  sources[rel] = readFileSync(join(FN_DIR, name, "index.ts"), "utf8");
  checked[rel] = name;
}

const options = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  skipLibCheck: true,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
};
const defaultHost = ts.createCompilerHost(options, true);
const host = {
  ...defaultHost,
  getSourceFile(name, langVersion, onErr) {
    if (sources[name] != null) {
      const kind = name.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.TS;
      return ts.createSourceFile(name, sources[name], langVersion, true, kind);
    }
    return defaultHost.getSourceFile(name, langVersion, onErr);
  },
  fileExists(name) { return sources[name] != null || defaultHost.fileExists(name); },
  readFile(name) { return sources[name] != null ? sources[name] : defaultHost.readFile(name); },
  writeFile() {},
};

const program = ts.createProgram([AMBIENT_NAME, ...Object.keys(checked)], options, host);
const all = ts.getPreEmitDiagnostics(program);
const hits = all.filter((d) => d.file && checked[d.file.fileName] && HIGH_SIGNAL.has(d.code));

if (hits.length === 0) {
  console.log(`typecheck-functions: clean (${all.length} total diagnostics scanned, 0 high-signal). checked ${names.length} function(s): ${names.join(", ")}.`);
  process.exit(0);
}
console.error(`typecheck-functions: ${hits.length} high-signal issue(s):\n`);
for (const d of hits) {
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  console.error(`  ${d.file.fileName}:${line + 1}:${character + 1}  TS${d.code}  ${msg}`);
}
console.error(`\n(High-signal codes: cannot-find-name / used-before-def / redeclare / assign-to-const.)`);
process.exit(1);
