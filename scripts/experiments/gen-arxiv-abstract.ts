/**
 * Emit the arXiv metadata abstract as plain text, resolved from the SAME
 * macros the paper cites, so the submission form and the PDF cannot
 * disagree. arXiv's abstract field caps at 1,920 characters; this script
 * fails if the resolved text exceeds it.
 *
 * Run AFTER gen-paper-assets.ts:
 *   pnpm gen:paper && pnpm tsx scripts/experiments/gen-arxiv-abstract.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const ARXIV_ABSTRACT_LIMIT = 1920;

const macroSrc = readFileSync("paper/macros.tex", "utf8");
const M = new Map(
  [...macroSrc.matchAll(/\\newcommand\{\\(\w+)\}\{(.*)\}/g)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);

const tex = readFileSync("paper/main.tex", "utf8");
const m = tex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
if (!m) throw new Error("no abstract block in paper/main.tex");

let a = m[1]!;
// Order matters: resolve macros first (their bodies contain TeX), then
// strip TeX from the whole text.
a = a.replace(/\\sivm\{\}/g, "sIVM");
a = a.replace(/\\(\w+)\\?(?=[\s.,;:)}+])/g, (full, name: string) => {
  const v = M.get(name);
  return v !== undefined ? v : full;
});
a = a
  .replace(/\{,\}/g, ",")
  .replace(/\\%/g, "%")
  .replace(/\\\$/g, "$")
  .replace(/\\alpha/g, "alpha")
  .replace(/\\delta/g, "delta")
  .replace(/\\emph\{([^}]*)\}/g, "$1")
  .replace(/\{=\}/g, "=")
  .replace(/\$([^$]*)\$/g, "$1")
  .replace(/1-delta/g, "1 - delta")
  .replace(/\\!|\\,|[{}]/g, "")
  .replace(/---?/g, "-")
  .replace(/``|''/g, '"')
  .replace(/\s+/g, " ")
  .trim();
if (/\\[a-zA-Z]/.test(a)) {
  throw new Error(`unresolved TeX remains: ${a.match(/\\[a-zA-Z]+/g)?.join(", ")}`);
}
writeFileSync("paper/arxiv-abstract.txt", a + "\n");
console.log(a);
console.log(
  `\nARXIV_ABSTRACT_${a.length <= ARXIV_ABSTRACT_LIMIT ? "OK" : "TOO_LONG"}: ${a.length}/${ARXIV_ABSTRACT_LIMIT} chars, ${a.split(/\s+/).length} words`,
);
if (a.length > ARXIV_ABSTRACT_LIMIT) process.exit(1);
