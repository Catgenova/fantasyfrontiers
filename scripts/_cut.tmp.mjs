// Temporary helper for the local-only branch: delete line ranges of a file by UNIQUE text markers,
// so the cuts never depend on line numbers that drift between edits. Each range is
//   { start: '<text on the first line to delete>', end: '<text on the first line to KEEP after the range>' }
// or { start, endInclusive: '<text on the last line to delete>' }. Every marker must occur exactly once
// after the previous ranges were applied, and ranges are applied in order. Prints the line counts.
import { readFileSync, writeFileSync } from "node:fs";
const [file, specPath] = process.argv.slice(2);
const ranges = JSON.parse(readFileSync(specPath, "utf8"));
let lines = readFileSync(file, "utf8").split("\n");
const before = lines.length;
function findOnce(marker, from = 0) {
  const hits = [];
  for (let i = from; i < lines.length; i++) if (lines[i].includes(marker)) hits.push(i);
  if (hits.length !== 1) throw new Error(`marker occurs ${hits.length} times (want 1): ${marker}`);
  return hits[0];
}
for (const r of ranges) {
  const s = findOnce(r.start);
  let e;
  if (r.endInclusive !== undefined) e = findOnce(r.endInclusive, s) + 1;
  else e = findOnce(r.end, s);
  if (e <= s) throw new Error(`end before start for ${r.start}`);
  console.log(`cut ${e - s} lines: ${r.start.slice(0, 60)} ...`);
  lines.splice(s, e - s, ...(r.replace ? [r.replace] : []));
}
writeFileSync(file, lines.join("\n"));
console.log(`${before} -> ${lines.length} lines`);
