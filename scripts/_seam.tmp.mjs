// Temporary helper for the local-only branch: drop test-seam exports (window.__FF = { ... }) whose VALUE
// mentions any of the given identifiers (deleted functions/vars), re-emitting the surviving entries.
// Usage: node scripts/_seam.tmp.mjs index.html name1 name2 ...
import { readFileSync, writeFileSync } from "node:fs";
const [file, ...names] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const start = src.indexOf("    window.__FF = {");
if (start < 0) throw new Error("seam start not found");
// Find the matching close of the object literal.
let i = src.indexOf("{", start), depth = 0, inStr = null, esc = false;
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
  if (c === "{" || c === "(" || c === "[") depth++;
  else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; }
}
const objStart = src.indexOf("{", start), objEnd = i; // src[objEnd] === '}'
const body = src.slice(objStart + 1, objEnd);
// Split at depth-0 commas.
const entries = []; let cur = "", d = 0; inStr = null; esc = false;
for (const c of body) {
  if (inStr) { cur += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === "'" || c === '"' || c === "`") { inStr = c; cur += c; continue; }
  if (c === "{" || c === "(" || c === "[") d++;
  else if (c === "}" || c === ")" || c === "]") d--;
  if (c === "," && d === 0) { entries.push(cur); cur = ""; continue; }
  cur += c;
}
if (cur.trim()) entries.push(cur);
const re = new RegExp("\\b(" + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b");
const kept = [], dropped = [];
for (const e of entries) {
  const t = e.replace(/^\s*\/\/[^\n]*\n/gm, "").trim(); // ignore comment-only prefixes when testing
  if (!t) continue;
  const valueText = t.replace(/^[A-Za-z_$][\w$]*\s*:/, "");
  if (re.test(valueText)) dropped.push(t.split(":")[0].trim()); else kept.push(e.trim());
}
// Re-emit: keep comment lines that were glued to entries by splitting them off.
const out = [];
for (const k of kept) {
  const parts = k.split("\n").map((s) => s.trim()).filter(Boolean);
  const comments = parts.filter((p) => p.startsWith("//")), code = parts.filter((p) => !p.startsWith("//")).join(" ");
  for (const c of comments) out.push("      " + c);
  if (code) out.push("      " + code + ",");
}
const rebuilt = src.slice(0, objStart + 1) + "\n" + out.join("\n") + "\n    " + src.slice(objEnd);
writeFileSync(file, rebuilt);
console.log(`seam: kept ${kept.length} entries, dropped ${dropped.length}: ${dropped.join(", ")}`);
