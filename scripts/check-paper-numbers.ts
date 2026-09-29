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

// The prose is single-sourced in paper/body.tex and included by two venue
// shells (acmart for arXiv/PVLDB; ieeeaccess for IEEE Access). Scan all
// three so every guard covers every manuscript that can be built, not just
// the one at the historical path.
const tex = ["paper/main.tex", "paper/body.tex", "paper/ieee/main.tex"]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const macroSrc = readFileSync("paper/macros.tex", "utf8");

// Strip comments and the parts that legitimately carry numbers.
const body = tex
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("%"))
  .join("\n")
  .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, "")
  .replace(/\\input\{[^}]*\}/g, "")
  .replace(/\\(documentclass|usepackage|pgfplotsset|newtheorem|newcommand|label|ref|cite)\{[^}]*\}/g, "")
  .replace(/\\begin\{axis\}\[[\s\S]*?\]/g, "")
  .replace(/\\(width|height|xmin|xmax|ymin|ymax|xtick)=[^,\]]*/g, "")
  // IEEE shell topmatter: production placeholders and the mailing address
  // legitimately carry digits (dates "xxxx 00, 0000", the DOI, a zip code).
  .replace(/\\(history|doi|corresp|tfootnote)\{[^}]*\}/g, "")
  .replace(/\\markboth\s*\{[^}]*\}\s*\{[^}]*\}/g, "")
  .replace(/\\address\[[^\]]*\]\{[^}]*\}/g, "")
  // Author biography: degree years are biographical facts, not measurements.
  .replace(/\\begin\{IEEEbiographynophoto\}[\s\S]*?\\end\{IEEEbiographynophoto\}/g, "");

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
  [/\$n_j\{=\}\d+\$/g, "calibration grid label"],
  [/\\\{600, 1800, 5000\\\}/g, "calibration grid, a protocol constant"],
  [/ODbL~1\.0|DbCL~1\.0|\$\\S\d/g, "license and section refs"],
  [/\d+pt|\d+cm|\d+em/g, "typesetting"],
  [/\$\\delta\/\(?K/g, "notation"],
  [/90 oracle calls/g, "schedule first look"],
  [/95\\%\s*(percentile interval|confidence interval|Wilson confidence interval|CI|PI)|\(95\\%|with 95\\%/g, "nominal interval coverage, a protocol constant"],
  [/2023|2026|17 USC/g, "years and statutes"],
  [/main seed 42, sampling\s+replications 1000 to 1999/g, "PRNG seed protocol constants (also in table1's generated header)"],
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
  "paper/tablefampairs.tex",
  "paper/tableboundsgrid.tex",
];
for (const f of genFiles) {
  const txt = readFileSync(f, "utf8");
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
  (name) => !new RegExp(`\\\\${name}(?![A-Za-z])`).test(tex),
);

console.log(`hand-typed quantity candidates: ${suspects.length}`);
for (const m of suspects.slice(0, 25)) {
  const at = m.index ?? 0;
  console.log(`  ${JSON.stringify(m[0])} :: ...${scrubbed.slice(Math.max(0, at - 55), at + 25).replace(/\s+/g, " ")}...`);
}
console.log(`\nmacros defined: ${defined.length}, unused: ${orphans.length}`);
if (orphans.length > 0) console.log(`  ${orphans.join(", ")}`);

const ok =
  suspects.length === 0 &&
  orphans.length === 0 &&
  genHardcodes.length === 0 &&
  swallowed.length === 0 &&
  badCompare.length === 0 &&
  badMult.length === 0 &&
  badRange.length === 0 &&
  unjustified.length === 0 &&
  badScope.length === 0;
console.log(ok ? "PAPER_NUMBERS_OK" : "PAPER_NUMBERS_FINDINGS");
process.exit(ok ? 0 : 1);
