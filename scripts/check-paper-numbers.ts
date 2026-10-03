/**
 * Enforcement for the availability statement: fail if the paper's prose
 * contains hand-typed quantities, or if the generator defines macros the
 * prose never uses (orphans invite exactly the drift this check exists to
 * prevent).
 *
 * Allowed literals are enumerated explicitly below; anything else is a
 * finding. Run in CI and before any submission.
 *
 * Run: pnpm tsx scripts/check-paper-numbers.ts
 */
import { readFileSync } from "node:fs";

// The prose is single-sourced in paper/body.tex (main text) and
// paper/appendix.tex (appendices), included by two venue shells (acmart for
// arXiv/PVLDB; ieeeaccess for IEEE Access, whose Supplementary Material
// prints the appendices). Scan them all so every guard covers every
// manuscript that can be built, not just the one at the historical path.
const tex = ["paper/main.tex", "paper/body.tex", "paper/appendix.tex", "paper/ieee/main.tex", "paper/ieee/supplement.tex"]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const macroSrc = readFileSync("paper/macros.tex", "utf8");

// Strip comments and the parts that legitimately carry numbers.
const body = tex
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("%"))
  .join("\n")
  .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, "")
  // Author biography: degree years are biographical facts, not measurements.
  // \biostart ... \bioend open and close it with or without a photograph.
  .replace(/\\biostart\n[\s\S]*?\\bioend/g, "")
  .replace(/\\includegraphics\[[^\]]*\]\{author-photo\.jpg\}/g, "")
  .replace(/\\input\{[^}]*\}/g, "")
  .replace(/\\(documentclass|usepackage|pgfplotsset|newtheorem|newcommand|label|ref|cite)\{[^}]*\}/g, "")
  .replace(/\\begin\{axis\}\[[\s\S]*?\]/g, "")
  .replace(/\\(width|height|xmin|xmax|ymin|ymax|xtick)=[^,\]]*/g, "")
  // IEEE shell topmatter: production placeholders and the mailing address
  // legitimately carry digits (dates "xxxx 00, 0000", the DOI, a zip code).
  .replace(/\\(history|doi|corresp|tfootnote)\{[^}]*\}/g, "")
  .replace(/\\markboth\s*\{[^}]*\}\s*\{[^}]*\}/g, "")
  .replace(/\\address\[[^\]]*\]\{[^}]*\}/g, "")
  .replace(/\\begin\{IEEEbiography(nophoto)?\}[\s\S]*?\\end\{IEEEbiography(nophoto)?\}/g, "");

/** Quantities the paper may state literally, with the reason. */
const ALLOWED: Array<[RegExp, string]> = [
  [/\$?\\alpha\{?=?\}?\s*0\.\d+/g, "alpha is a user parameter, not a measurement"],
  [/\$?\\delta\{?=?\}?\s*0\.\d+/g, "delta is a user parameter"],
  [/\balpha\b/g, "word"],
  [/\$5\\%\$|a \$5\\%\$ budget/g, "generic budget example"],
  [/\$100\\%\$|recomputing \$100\\%\$/g, "the trivial baseline"],
  [/\$0\.0\\%\$/g, "structural zero"],
  [/n\{=\}\\\w+/g, "macro-valued n"],
  [/\$n\{=\}200\$/g, "sample size of a superseded probe, stated as such"],
  [/\$T\{=\}0\$|temperature 0|temperature zero/g, "decode setting"],
  [/\$2\{,\}000\$ trials/g, "calibration protocol constant"],
  [/\$\\tau\{?[=\\le]*\}?\s*0\.\d+/g, "threshold sweep points"],
  [/\$0\.9\d\$/g, "threshold sweep points"],
  [/\$\\{0\.1, 0\.2\\}\$|\$\\alpha\{\\in\}/g, "budget sets"],
  [/\$1\-\\delta\$|\$1\\!-\\!\\delta\$/g, "notation"],
  [/\$n_0\{=\}45\$|six looks|\$45\$/g, "schedule constants"],
  [/\(45, 90, 180, \\dots\)/g, "the look schedule itself"],
  [/\$n_j\{=\}\d+(\{,\}\d+)?\$/g, "calibration grid label"],
  [/\\\{600, 1\{,\}800, 5\{,\}000\\\}/g, "calibration grid, a protocol constant"],
  [/10\.5281\/zenodo\.\d+/g, "the preprint's DOI, an identifier"],
  [/ODbL~1\.0|DbCL~1\.0|\$\\S\d/g, "license and section refs"],
  [/\d+pt|\d+cm|\d+em/g, "typesetting"],
  [/\$\\delta\/\(?K/g, "notation"],
  [/90 oracle calls/g, "schedule first look"],
  [/95\\%\s*(percentile interval|confidence interval|Wilson confidence interval|CI|PI)|\(95\\%|with 95\\%/g, "nominal interval coverage, a protocol constant"],
  [/2023|2026|17 USC/g, "years and statutes"],
  [/600-cell stratum/g, "calibration grid size, a protocol constant"],
  [/\$1\.05\$ to \$1\.25\$/g, "tight-null placement, a protocol constant"],
];

let scrubbed = body;
for (const [re] of ALLOWED) scrubbed = scrubbed.replace(re, " ");

// Any surviving percentage or thousands-separated figure is hand-typed.
const suspects = [
  ...scrubbed.matchAll(/(?<![\\{A-Za-z])\d[\d.]*\\%/g),
  ...scrubbed.matchAll(/\b\d{1,3}\{,\}\d{3}\b/g),
  ...scrubbed.matchAll(/\bAUC[^.]{0,40}?0\.\d+/g),
  ...scrubbed.matchAll(/\\\$\s?\d[\d.,]*/g),
  ...scrubbed.matchAll(/(?<![\\{A-Za-z\d.])\d{3,}(?![\d.}])/g),
];

// The generated files must themselves be free of hand-authored numbers:
// they are emitted, so any literal there is a generator hardcode.
const genFiles = [
  "paper/table1.tex",
  "paper/figdata.tex",
  "paper/tablefam.tex",
  "paper/tablebounds.tex",
  "paper/tablerates.tex",
  "paper/tablemodels.tex",
  "paper/tabledeploy.tex",
  "paper/tabledeploymp.tex",
  "paper/tablefampairs.tex",
  "paper/tableboundsgrid.tex",
  "paper/tabledependence.tex",
  "paper/tablestrict.tex",
  "paper/tablebudgets.tex",
  "paper/tableboundary.tex",
  "paper/tablestrata.tex",
];
// A generated table may cite macros (the reconciliation table is built
// from them), and a macro cited there is rendered in the article.
let genTex = "";
for (const f of genFiles) {
  const txt = readFileSync(f, "utf8");
  genTex += `\n${txt}`;
  if (!/^% GENERATED/m.test(txt)) {
    console.log(`WARNING: ${f} lacks a GENERATED provenance header`);
  }
}
const genSrc = readFileSync(
  "scripts/experiments/gen-paper-assets.ts",
  "utf8",
);
// r8/M9: this only matched STRING literals, so def("labeledCells", num(30000))
// and a bare `89184 - ...` were invisible to a check the paper cites as
// catching generator hardcodes. Scan the whole value expression for a literal
// of three or more digits, allowing only the percent factor and the digits
// that belong to formatting calls.
const genHardcodes = [
  ...genSrc.matchAll(/\bdef\(\s*"(\w+)"\s*,\s*([\s\S]*?)\);/g),
]
  .map((m) => {
    const expr = m[2]!
      .replace(/toFixed\(\d+\)/g, "")
      .replace(/\btoLocaleString\([^)]*\)/g, "")
      .replace(/\* ?100\b/g, "")
      .replace(/\b1e-?\d+\b/g, "");
    const lits = [...expr.matchAll(/(?<![\w.])(\d{3,})(?![\w.])/g)].map(
      (x) => x[1]!,
    );
    return lits.length > 0 ? [m[1]!, lits.join(", ")] : null;
  })
  .filter((x): x is string[] => x !== null);
if (genHardcodes.length > 0) {
  console.log(`\ngenerator hardcodes (must derive from artifacts):`);
  for (const m of genHardcodes) console.log(`  ${m[0]} <- literal ${m[1]}`);
}

// A macro followed by a bare space swallows it: "\\simHi because" typesets as
// "0.99because". This shipped once and was invisible in the source, so it is
// checked rather than watched for. Every macro use must be followed by "\\ ",
// punctuation, or a non-letter.
const macroNames = new Set(
  [
    ...macroSrc.matchAll(/\\newcommand\{\\(\w+)\}/g),
    ...readFileSync("paper/figdata.tex", "utf8").matchAll(
      /\\newcommand\{\\(\w+)\}/g,
    ),
  ].map((m) => m[1]!),
);
const swallowed = [...tex.matchAll(/\\([A-Za-z]+) [A-Za-z]/g)].filter((m) =>
  macroNames.has(m[1]!),
);
if (swallowed.length > 0) {
  console.log(`\nmacros swallowing their trailing space (need "\\ "):`);
  for (const m of swallowed) {
    const at = m.index ?? 0;
    console.log(`  \\${m[1]} :: ...${tex.slice(at, at + 60).replace(/\s+/g, " ")}...`);
  }
}

// r8/M1: the checker validated NUMBERS but not the SENTENCES THAT COMPARE
// them, so the paper shipped "stopped at different looks (765 and 765 calls)"
// under a green check: exp11 was re-run, two macros converged, and the prose
// interpreting them was never revisited. A sentence that asserts two
// quantities differ must cite two macros whose values differ.
const macroValue = new Map(
  [...macroSrc.matchAll(/\\newcommand\{\\(\w+)\}\{(.*)\}/g)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);
const DIFFER_CUE =
  /\b(differ|different|differently|rather than|instead of|versus|vs\.?|whereas|unlike|as against|not\b)/i;
const sentences = body
  .replace(/\n/g, " ")
  .split(/(?<=[.:;])\s+(?=[A-Z(\\])/);
const badCompare: string[] = [];
for (const sent of sentences) {
  if (!DIFFER_CUE.test(sent)) continue;
  const used = [...new Set([...sent.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]!))]
    .filter((n) => macroValue.has(n));
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      if (macroValue.get(used[i]!) === macroValue.get(used[j]!)) {
        badCompare.push(
          `\\${used[i]} and \\${used[j]} both = ${macroValue.get(used[i]!)} :: ${sent.trim().slice(0, 130).replace(/\s+/g, " ")}...`,
        );
      }
    }
  }
}
if (badCompare.length > 0) {
  console.log(`\nsentences asserting a difference between equal macros:`);
  for (const b of badCompare) console.log(`  ${b}`);
}

// r8/M10: a spelled-out multiplier is a comparison too, and the paper shipped
// "twice the noise floor" for a ratio of 1.26 and "an order of magnitude" for
// 7.3. Where a sentence claims a multiple and cites two macros, check it.
const MULT: Array<[RegExp, number]> = [
  [/\bhalf\b/i, 0.5],
  [/\btwice\b|\bdouble\b/i, 2],
  [/\bthree times\b|\btriple\b/i, 3],
  [/\bfour times\b/i, 4],
  [/\bfive times\b/i, 5],
  [/\bseven times\b/i, 7],
  [/\bten times\b|\ban order of magnitude\b/i, 10],
];
const numOf = (v: string): number | null => {
  const m = v.replace(/\{,\}/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const badMult: string[] = [];
for (const sent of sentences) {
  const hit = MULT.find(([re]) => re.test(sent));
  if (!hit) continue;
  const vals = [...new Set([...sent.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]!))]
    .filter((n) => macroValue.has(n))
    .map((n) => [n, numOf(macroValue.get(n)!)] as const)
    .filter((x): x is readonly [string, number] => x[1] !== null && x[1] !== 0);
  if (vals.length < 2) continue;
  const ratios = [];
  for (const [an, av] of vals)
    for (const [bn, bv] of vals)
      if (an !== bn) ratios.push([`${an}/${bn}`, av / bv] as const);
  const claimed = hit[1];
  const ok = ratios.some(([, r]) => r >= claimed / 1.25 && r <= claimed * 1.25);
  if (!ok) {
    badMult.push(
      `claims x${claimed}, no macro pair matches (${ratios
        .map(([k, r]) => `${k}=${r.toFixed(2)}`)
        .join(", ")}) :: ${sent.trim().slice(0, 110).replace(/\s+/g, " ")}...`,
    );
  }
}
if (badMult.length > 0) {
  console.log(`\nspelled-out multipliers the macros do not support:`);
  for (const b of badMult) console.log(`  ${b}`);
}

// r9: the difference guard above only fires when two cited macros are EQUAL,
// so an abstract claiming a count was "no more than" what a smaller run spent
// sailed through: the sentence never named the macro it was really compared
// against. Containment claims ARE checkable, because several macros are
// ranges. Where a sentence says a value sits inside a range and cites both a
// scalar macro and a range macro, verify it.
const RANGE = /^\[?\s*(-?\d[\d.]*)\s*(?:--|,|–)\s*(-?\d[\d.]*)\s*\]?$/;
const scalarOf = (v: string): number | null => {
  const c = v.replace(/\{,\}/g, "").replace(/\\%/g, "").replace(/\\\$/g, "");
  if (RANGE.test(c.trim())) return null;
  const mm = c.match(/^-?\d[\d.]*$/) ? c : null;
  return mm ? Number(mm) : null;
};
const rangeOf = (v: string): [number, number] | null => {
  const c = v.replace(/\{,\}/g, "").replace(/\\%/g, "").replace(/\\\$/g, "").trim();
  const mm = c.match(RANGE);
  return mm ? [Number(mm[1]), Number(mm[2])] : null;
};
const CONTAIN = /\b(inside|within|in the range|lies in|falls in|no more than|at most|no fewer than|at least)\b/i;
const badRange: string[] = [];
for (const sent of sentences) {
  if (!CONTAIN.test(sent)) continue;
  const used = [...new Set([...sent.matchAll(/\\([A-Za-z]+)/g)].map((x) => x[1]!))].filter(
    (n) => macroValue.has(n),
  );
  const ranges = used
    .map((n) => [n, rangeOf(macroValue.get(n)!)] as const)
    .filter((x): x is readonly [string, [number, number]] => x[1] !== null);
  const scalars = used
    .map((n) => [n, scalarOf(macroValue.get(n)!)] as const)
    .filter((x): x is readonly [string, number] => x[1] !== null);
  if (ranges.length === 0 || scalars.length === 0) continue;
  for (const [rn, [lo, hi]] of ranges) {
    const anyInside = scalars.some(([, v]) => v >= lo && v <= hi);
    if (!anyInside) {
      badRange.push(
        `no cited scalar lies in \\${rn} = [${lo}, ${hi}] (cited: ${scalars
          .map(([n, v]) => `\\${n}=${v}`)
          .join(", ")}) :: ${sent.trim().slice(0, 110).replace(/\s+/g, " ")}...`,
      );
    }
  }
}
if (badRange.length > 0) {
  console.log(`\ncontainment claims the cited macros do not support:`);
  for (const b of badRange) console.log(`  ${b}`);
}

// r9b: the three worst findings of round 9 were not quantities, so no numeric
// guard could see them: a wrong estimand NAME in the abstract, a wrong
// absolute QUANTIFIER ("did not pay off anywhere" against a count of 1), and a
// wrong comparison SCOPE (across corpora, where the paper's own finding says
// the corpus dominates). Absolutes in the abstract and the contributions block
// are where those land, and they are the two things a reviewer reads hardest.
// Each one must be enumerated below with a reason, so writing a NEW absolute
// claim there fails the check until somebody justifies it.
// Two shells carry two abstracts (venue abstract rules differ); guard both,
// not just the first match.
const abstractBlock = [
  ...tex.matchAll(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g),
]
  .map((m) => m[1]!)
  .join("\n");
const contribBlock =
  tex.match(/\\subsection\{Contributions\}([\s\S]*?)\\section/)?.[1] ?? "";
/** Absolute claims allowed in the abstract / contributions, with why. */
const ABSOLUTES_OK: Array<[RegExp, string]> = [
  [/never certified an unsafe stratum/, "the central validity claim; measured"],
  [/no certified stratum's true flip rate exceeded/, "same claim, restated"],
  [/every seeded sweep/, "scope of the validity claim"],
  [/replications of every configuration/, "scope of the validity claim"],
  [/refused outright at both budgets we/, "exp12 ran alpha in {0.1, 0.2}; scope stated"],
  [/governs everything/, "rhetorical, immediately quantified"],
  [/Every savings figure above/, "the frontier disclosure, deliberate"],
  [/certify anything at all/, "part of the frontier disclosure"],
  [/Every certified sweep held the bound it certified/, "qualified by estimand"],
  [/never assumed/, "states what the procedure refuses to do"],
  [/every union of certified strata/, "a theorem's scope"],
  [/all five edit pairs/, "scope of Table 1"],
  [/only the fields/, "definition of the content hash"],
  [/every experiment script/, "scope of the release"],
  [/recompute every cell/, "describes the status quo it replaces, not a claim"],
  [/cannot beat the stratum's intrinsic flip rate/, "the impossibility floor; proven"],
  [/only \\certifyingConfigs/, "the frontier disclosure, and quantified"],
  [/affects power only, never validity/, "the validity-free-stratifier result"],
];
// "only" inside a compound adjective (formatting-only, aggregate-only) is a
// name, not a quantifier, and "guarantee" here is a noun; neither is a claim.
const ABSOLUTE_RE =
  /(?<!-)\b(never|always|anywhere|nowhere|every|everything|none|nothing|no other|the first|only|cannot|impossible)\b/gi;
const unjustified: string[] = [];
for (const [where, block] of [
  ["abstract", abstractBlock],
  ["contributions", contribBlock],
] as const) {
  for (const mm of block.matchAll(ABSOLUTE_RE)) {
    const at = mm.index ?? 0;
    // Anchor to the token's OWN sentence. A character window let any
    // allow-listed phrase within 70 chars suppress a brand-new absolute,
    // which measured out at roughly a quarter of the abstract.
    const start = Math.max(
      block.lastIndexOf(". ", at) + 1,
      block.lastIndexOf(": ", at) + 1,
      block.lastIndexOf("; ", at) + 1,
      0,
    );
    let end = block.length;
    for (const stop of [". ", ": ", "; "]) {
      const i = block.indexOf(stop, at);
      if (i !== -1 && i < end) end = i + 1;
    }
    const ctx = block.slice(start, end).replace(/\s+/g, " ");
    if (ABSOLUTES_OK.some(([re]) => re.test(ctx))) continue;
    unjustified.push(`${where}: "${mm[0]}" :: ...${ctx.trim()}...`);
  }
}
if (unjustified.length > 0) {
  console.log(
    `\nabsolute claims in the abstract/contributions not on the allow-list:`,
  );
  for (const u of unjustified) console.log(`  ${u}`);
}

// r9-verify: the dominant remaining defect class is a SCOPE claim, not a
// numeric one. Four times a sentence said two flip rates share a column when
// they do not (so-synonym is the lab replica; so-widening is the production
// column). paper/macro-provenance.json records which column each flip macro
// is measured on, so the claim is checkable.
type Prov = { pair: string; corpus: string; column: string };
let provenance: Record<string, Prov> = {};
try {
  provenance = (
    JSON.parse(readFileSync("paper/macro-provenance.json", "utf8")) as {
      macros: Record<string, Prov>;
    }
  ).macros;
} catch {
  console.log("WARNING: paper/macro-provenance.json missing; scope claims unchecked");
}
const SCOPE: Array<[RegExp, keyof Prov, string]> = [
  [/\b(same column|holding the column fixed|within-column|on that column|of that column)\b/i, "column", "column"],
  [/\b(same corpus|within a corpus|same table)\b/i, "corpus", "corpus"],
];
const badScope: string[] = [];
for (const sent of sentences) {
  for (const [re, field, label] of SCOPE) {
    if (!re.test(sent)) continue;
    const cited = [...new Set([...sent.matchAll(/\\([A-Za-z]+)/g)].map((x) => x[1]!))]
      .filter((n) => provenance[n]);
    if (cited.length < 2) continue;
    const vals = [...new Set(cited.map((n) => provenance[n]![field]))];
    if (vals.length > 1) {
      badScope.push(
        `claims same ${label} but cites ${cited
          .map((n) => `\\${n}(${provenance[n]![field]})`)
          .join(", ")} :: ${sent.trim().slice(0, 110).replace(/\s+/g, " ")}...`,
      );
    }
  }
}
if (badScope.length > 0) {
  console.log(`\nscope claims the macro provenance contradicts:`);
  for (const b of badScope) console.log(`  ${b}`);
}

const defined = [...macroSrc.matchAll(/\\newcommand\{\\(\w+)\}/g)].map(
  (m) => m[1]!,
);
const orphans = defined.filter(
  (name) => !new RegExp(`\\\\${name}(?![A-Za-z])`).test(tex + genTex),
);

console.log(`hand-typed quantity candidates: ${suspects.length}`);
for (const m of suspects.slice(0, 25)) {
  const at = m.index ?? 0;
  console.log(`  ${JSON.stringify(m[0])} :: ...${scrubbed.slice(Math.max(0, at - 55), at + 25).replace(/\s+/g, " ")}...`);
}
console.log(`\nmacros defined: ${defined.length}, unused: ${orphans.length}`);
if (orphans.length > 0) console.log(`  ${orphans.join(", ")}`);

// IEEE Access review round 1, Reviewer 3: "Many sentences are long and
// contain several numbers or points in parentheses. Please shorten the
// sentences." The prose of body.tex (tables, figures, the algorithm,
// displayed math, and the theorem environments removed; macros expanded)
// must contain no sentence longer than MAX_SENTENCE_WORDS words, and neither
// may a caption or the abstract; the offenders are listed so the writer can
// split them rather than argue with the count. Numbered lists are prose: each
// item starts a sentence of its own (the contributions list and the appendix
// enumerations were once skipped, and a 47-word sentence sat in one).
const MAX_SENTENCE_WORDS = 60;
/** The prose sentences of a body source, macros expanded from `macroTex`. */
function proseSentencesOf(src: string, macroTex: string): string[] {
  const values = new Map(
    [...macroTex.matchAll(/\\newcommand\{\\(\w+)\}\{(.*)\}/g)].map((m) => [m[1]!, m[2]!]),
  );
  let s = src;
  for (const env of ["table\\*?", "figure\\*?", "algorithm", "equation", "tikzpicture", "theorem", "assumption", "proof"]) {
    s = s.replace(new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g"), " ");
  }
  s = s
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("%"))
    .join("\n")
    .replace(/\\ifnum\\\w+=1\\relax|\\else|\\fi/g, " ")
    .replace(/\\sivm\{\}/g, "sIVM")
    // A heading ends the sentence before it, whatever letter the next one
    // starts with (a paragraph that opens on a lower-case name such as
    // "vCache" used to be glued to the sentence before its heading).
    .replace(/\\(section|subsection|paragraph)\*?\{[^}]*\}/g, " \u00b6 ")
    // So does a list: its lead-in ends where the list begins, and each item
    // is a sentence of its own.
    .replace(/\\(begin|end)\{(enumerate|itemize)\}|\\item\b/g, " \u00b6 ")
    .replace(/\\(cite|ref|secref|figref|eqref|label|texttt|url)\{[^}]*\}/g, "X")
    .replace(/\\\[[\s\S]*?\\\]/g, " X ")
    .replace(/\$[^$]*\$/g, "X")
    .replace(/\{,\}/g, ",");
  const names = [...values.keys()].sort((a, b) => b.length - a.length);
  if (names.length) {
    s = s.replace(new RegExp(`\\\\(${names.join("|")})(\\\\ |\\{\\}|(?=[^A-Za-z]))`, "g"), (_m, n: string) => `${values.get(n)} `);
  }
  s = s.replace(/\\[A-Za-z]+\*?/g, " ").replace(/[{}~]/g, " ").replace(/\s+/g, " ");
  return s
    .split("\u00b6")
    .flatMap((part) => part.trim().split(/(?<=[.?!])\s+(?=[A-Z(\[`]|sIVM)/))
    .filter((x) => x.split(" ").length > 2);
}
/** Length and number-density statistics of a set of prose sentences. Reviewer
 * 3 named "many extra numbers" beside the long sentences, so the count of
 * numeric tokens is reported with the lengths: tokens per 100 words of prose,
 * and the share of sentences that carry three or more. */
function proseStats(label: string, sents: string[]): void {
  const lens = sents.map((x) => x.split(" ").length);
  const words = lens.reduce((a, b) => a + b, 0);
  const over45 = lens.filter((x) => x > 45).length;
  const over60 = lens.filter((x) => x > MAX_SENTENCE_WORDS).length;
  const nums = sents.map((x) => (x.match(/(?<![A-Za-z])\$?\d[\d,]*(?:\.\d+)?%?/g) ?? []).length);
  const tokens = nums.reduce((a, b) => a + b, 0);
  const dense = nums.filter((n) => n >= 3).length;
  console.log(
    `${label}: ${lens.length} sentences, ${words} words, mean ${(words / Math.max(1, lens.length)).toFixed(1)} words, over 45 words: ${over45} (${((over45 / Math.max(1, lens.length)) * 100).toFixed(0)}%), over ${MAX_SENTENCE_WORDS}: ${over60}; numbers: ${tokens} (${((tokens / Math.max(1, words)) * 100).toFixed(1)} per 100 words), sentences with three or more: ${((dense / Math.max(1, lens.length)) * 100).toFixed(1)}%`,
  );
}
/** The text of every \\caption{...} of a source (braces balanced). The float
 * environments are removed from the prose above, so their captions are read
 * here and held to the same sentence bound. */
function captionsOf(src: string): string[] {
  const out: string[] = [];
  const re = /\\caption\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}
// Main text then appendices, as the preprint prints them; the main-text
// statistics below cut at \venueappendix, where appendix.tex begins.
const bodySrc = readFileSync("paper/body.tex", "utf8") + "\n" + readFileSync("paper/appendix.tex", "utf8");
const proseSentences = proseSentencesOf(bodySrc, macroSrc);
const captionSentences = captionsOf(bodySrc).flatMap((c) => proseSentencesOf(c, macroSrc));
// The abstract lives in the venue shell, outside body.tex, and is held to the
// same bound (the IEEE Access shell's is the one the reviewers read).
const abstractSentences = proseSentencesOf(
  readFileSync("paper/ieee/main.tex", "utf8").match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/)?.[1] ?? "",
  macroSrc,
);
const longSentences = [
  ...proseSentences.filter((x) => x.split(" ").length > MAX_SENTENCE_WORDS),
  ...captionSentences.filter((x) => x.split(" ").length > MAX_SENTENCE_WORDS).map((x) => `[caption] ${x}`),
  ...abstractSentences.filter((x) => x.split(" ").length > MAX_SENTENCE_WORDS).map((x) => `[abstract] ${x}`),
];
{
  console.log("");
  proseStats("prose sentences", proseSentences);
  // The main text is everything before the appendices; the response letter
  // quotes its number density beside the first submission's.
  const cut = bodySrc.indexOf("\\venueappendix");
  if (cut > 0) proseStats("main text only", proseSentencesOf(bodySrc.slice(0, cut), macroSrc));
  // The same statistics for another source, e.g. the first submission:
  //   git show ieee-access-submission-v1:paper/body.tex > /tmp/b.tex
  //   git show ieee-access-submission-v1:paper/macros.tex > /tmp/m.tex
  //   PROSE_STATS_BODY=/tmp/b.tex PROSE_STATS_MACROS=/tmp/m.tex pnpm check:paper
  if (process.env.PROSE_STATS_BODY && process.env.PROSE_STATS_MACROS) {
    proseStats(
      `compared source (${process.env.PROSE_STATS_BODY})`,
      proseSentencesOf(readFileSync(process.env.PROSE_STATS_BODY, "utf8"), readFileSync(process.env.PROSE_STATS_MACROS, "utf8")),
    );
  }
  console.log(
    `captions: ${captionsOf(bodySrc).length}, sentences: ${captionSentences.length}, longest: ${captionSentences.reduce((a, x) => Math.max(a, x.split(" ").length), 0)} words`,
  );
  console.log(
    `abstract: ${abstractSentences.length} sentences, longest: ${abstractSentences.reduce((a, x) => Math.max(a, x.split(" ").length), 0)} words`,
  );
  for (const x of longSentences.slice(0, 20)) console.log(`  (${x.split(" ").length}) ${x.slice(0, 110)}...`);
  // PROSE_LIST_OVER=45 lists every prose sentence longer than that, in full,
  // for the writer who has to split them.
  if (process.env.PROSE_LIST_OVER) {
    const limit = Number(process.env.PROSE_LIST_OVER);
    for (const x of proseSentences.filter((y) => y.split(" ").length > limit)) console.log(`  over ${limit} (${x.split(" ").length}): ${x}`);
  }
}

const ok =
  suspects.length === 0 &&
  orphans.length === 0 &&
  longSentences.length === 0 &&
  genHardcodes.length === 0 &&
  swallowed.length === 0 &&
  badCompare.length === 0 &&
  badMult.length === 0 &&
  badRange.length === 0 &&
  unjustified.length === 0 &&
  badScope.length === 0;
console.log(ok ? "PAPER_NUMBERS_OK" : "PAPER_NUMBERS_FINDINGS");
process.exit(ok ? 0 : 1);
