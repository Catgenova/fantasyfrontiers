// Temporary helper for the local-only branch: delete whole selftest suites by exact title prefix.
// A suite is the block from `  suite('<title>` to the next line that is exactly `  });` at two-space
// indentation (the file's unvarying style). Also drops a comment block directly above the suite when it
// is separated from the previous code by a blank line. Usage: node scripts/_suitecut.tmp.mjs tests/selftest.js titles.json
import { readFileSync, writeFileSync } from "node:fs";
const [file, specPath] = process.argv.slice(2);
const titles = JSON.parse(readFileSync(specPath, "utf8"));
let lines = readFileSync(file, "utf8").split("\n");
const before = lines.length;
let removedSuites = 0;
for (const t of titles) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("  suite('" + t.replace(/'/g, "\\'")) || lines[i].startsWith("  suite(\"" + t)) starts.push(i);
  if (starts.length === 0) { console.log(`MISSING: ${t}`); continue; }
  if (starts.length > 1) throw new Error(`title prefix matches ${starts.length} suites: ${t}`);
  let s = starts[0], e = s;
  while (e < lines.length && lines[e] !== "  });") e++;
  if (e >= lines.length) throw new Error(`no closing for ${t}`);
  // Swallow a leading comment block (lines starting with two spaces and //) back to a blank line.
  let cs = s;
  while (cs - 1 >= 0 && /^  \/\//.test(lines[cs - 1])) cs--;
  if (cs - 1 >= 0 && lines[cs - 1].trim() !== "") cs = s; // comment glued to code above: leave it
  // Swallow one trailing blank line.
  let ee = e + 1;
  if (ee < lines.length && lines[ee].trim() === "") ee++;
  console.log(`cut ${ee - cs} lines: ${t.slice(0, 70)}`);
  lines.splice(cs, ee - cs);
  removedSuites++;
}
writeFileSync(file, lines.join("\n"));
console.log(`${before} -> ${lines.length} lines, ${removedSuites} suites removed`);
