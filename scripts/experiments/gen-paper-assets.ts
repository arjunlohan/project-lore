/**
 * Generate ALL paper assets MECHANICALLY from result JSONs + the live cost
 * ledger. Nothing in the paper may contain a hand-typed number: prose cites
 * macros defined here, so regenerating an experiment regenerates the prose.
 *
 * Emits:
 *  - paper/table1.tex   main results (incl. oracle-cost columns)
 *  - paper/figdata.tex  pgfplots coordinates
 *  - paper/macros.tex   every number the prose cites, as \newcommand
 *
 * Run: pnpm tsx scripts/experiments/gen-paper-assets.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  binomialUpperBound,
  ebUpperBound,
  exactUpperBound,
  mulberry32,
  worUpperBound,
  lookSchedule,
} from "@lore/core/sivm";
import mysql from "mysql2/promise";
import { PAIRS } from "./pairs";
import { recomputeAudits, type AuditCells } from "./deployment-audit";

const J = (f: string) =>
  JSON.parse(readFileSync(`docs/research/experiments/${f}`, "utf8"));
// Artifacts that may legitimately be absent from a checkout (paid runs the
// paper reports only when they exist); the prose is gated on the macro that
// says so rather than on a LaTeX error.
const JOpt = (f: string) =>
  existsSync(`docs/research/experiments/${f}`) ? J(f) : null;
// The per-look level of the pinned procedure (delta / K strata / 6 looks),
// used wherever a bound is re-evaluated on persisted evidence.
const PINNED_PER_LOOK = 0.1 / 2 / 6;
// exp12 reruns on further model families (see the model-family block below
// and the off-ledger cell count).
const FAMILY_FILES = [
  "exp12-secondmodel-google-gemini-2.5-flash-lite.json",
  "exp12-secondmodel-google-gemini-3-flash.json",
  "exp12-secondmodel-zai-glm-4.7-flash.json",
  "exp12-secondmodel-alibaba-qwen3.7-flash.json",
];
const exp0 = J("exp0-stability.json");
const exp0b = J("exp0b-djinni-stability.json");
const exp2 = J("exp2-editclass.json");
const exp4 = J("exp4-vote3.json");
const exp7 = J("exp7-baselines.json");
const exp8 = J("exp8-final-table.json");
// The total failure probability of a certification, as the main results
// were run, and the number of strata of each pair's column (its distinct
// cached values in the released labels): the per-stratum level is their
// ratio.
const DELTA_TOTAL = (() => {
  const m = String(exp8.procedure).match(/delta=([\d.]+)/);
  if (!m) throw new Error("exp8-final-table.json does not state its delta");
  return Number(m[1]);
})();
// Section III says the budget may be read after the draws, because the look
// schedule does not depend on it. The schedule sizes its last look from
// alpha, which bites only below the smallest budget of the article; hold the
// claim to the code for every budget the article uses, over a range of
// stratum sizes and for the stratum counts that occur (2, 4, and the pilot's 8).
{
  const budgets = [...new Set((exp8.results as Array<{ alpha: number }>).map((r) => r.alpha))];
  const sizes = [45, 60, 90, 169, 186, 360, 529, 743, 1440, 1441, 1814, 2000, 7715, 81469];
  for (const K of [1, 2, 4, 8]) {
    for (const size of sizes) {
      const ref = JSON.stringify(lookSchedule(size, budgets[0]!, DELTA_TOTAL / K, 45, 6));
      for (const alpha of budgets) {
        if (JSON.stringify(lookSchedule(size, alpha, DELTA_TOTAL / K, 45, 6)) !== ref) {
          throw new Error(`the look schedule depends on the budget at alpha=${alpha} (stratum ${size}, K=${K}); rewrite "What the test conditions on is fixed" in body.tex`);
        }
      }
    }
  }
}
const strataCountOf = (pairKey: string): number => {
  const pr = (J("benchmark-labels.json") as { pairs: Array<{ key: string; cached: unknown[] }> }).pairs.find((x) => x.key === pairKey);
  if (!pr) throw new Error(`benchmark-labels.json has no pair ${pairKey}`);
  return new Set(pr.cached.filter((v) => v !== null && v !== undefined).map((v) => String(v))).size;
};
const exp8ab = J("exp8-embed-ablation.json");
const exp9 = J("exp9-calibration.json");
const exp10 = J("exp10-multidraw.json");
const exp11 = J("exp11-fullscale.json");
const exp6 = J("exp6-djinni.json");
const exp14 = J("exp14-bounds.json");
const exp15 = J("exp15-betting-calibration.json");
// IEEE Access resubmission artifacts.
const exp11c = J("exp11c-deployment-bounds.json"); // August draws, every bound
const exp11cSep = J("exp11c-deployment-bounds-v4.json"); // September snapshot, live
const exp16 = J("exp16-snapshot-drift.json");
const exp17 = JOpt("exp17-independence.json");
// The concurrent-only extension of the independence check (a further 1,000
// rows the next day), present once it has run.
const exp17ext = JOpt("exp17-independence-ext.json") as
  | { n: number; ranAt: string; concurrency: number; concurrent: { usable: number; errors: number; flips: number; flipRate: number | null; wilson95: [number, number]; serial: { lag1: number; lag1PermutationP: number; blocks: number; blockVarianceRatio: number | null; dispersionChiSquare: number; dispersionDf: number } }; againstMainSequential: { twoSidedP: number } }
  | undefined;
const exp19 = JOpt("exp19-freetext.json") as Exp19 | undefined;
const pilotReady = !!exp19 && !!exp19.calibrationSummary && exp19.calibrationSummary.humanLabeled > 0 && exp19.calibrationSummary.missUcbConditional !== null;
const exp18Files = readdirSync("docs/research/experiments")
  .filter((f) => /^exp18-families-(widening|djinni)-.*\.json$/.test(f) && !f.endsWith(".partial.json"))
  .sort();

const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

const LABELS: Record<string, string> = {
  "so-formatting": "SO formatting-only",
  "so-synonym": "SO synonym rewording",
  "so-widening": "SO scope widening",
  "dj-formatting": "Djinni formatting-only",
  "dj-criteria": "Djinni criteria change",
};

const macros: string[] = [];
const def = (name: string, value: string | number) => {
  // LaTeX control sequences are letters only: a digit in the name makes
  // \newcommand fail with a confusing "Missing \begin{document}".
  if (!/^[A-Za-z]+$/.test(name)) {
    throw new Error(`macro name must be letters only, got "${name}"`);
  }
  macros.push(`\\newcommand{\\${name}}{${value}}`);
};
// Every figure this script prints is rounded half up on its decimal value.
// The native toFixed rounds the binary representation, so 6.35 printed as
// 6.3 while 9.55 printed as 9.6 (whichever side of the half the double fell),
// and a reader recomputing k/n could not reproduce the digits. The offset
// moves an exact half up and nothing else: it is far above the binary error
// of the values printed here and far below the last printed digit.
const nativeToFixed = Number.prototype.toFixed;
Number.prototype.toFixed = function (this: number, digits?: number): string {
  const v = Number(this);
  return nativeToFixed.call(v + (v >= 0 ? 1e-9 : -1e-9), digits);
};
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}\\%`;
/** A rate that is a count over a few thousand cells, printed to `d` decimals,
 * or to one more when it sits exactly half way between two printable values
 * (509 of 2,000 is 25.45%): the extra digit shows the count exactly, and a
 * figure printed as 25.4% in the first submission gains a digit instead of
 * moving to 25.5%. */
const pctRate = (x: number, d = 1) => {
  const scaled = Math.abs(x) * 100 * 10 ** d;
  const half = Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-7;
  return pct(x, half ? d + 1 : d);
};
/** A lower bound printed as a percentage: rounded down, so "at least X" stays
 * true of the value it summarizes. */
const pctFloor = (x: number, d = 1) => `${(Math.floor(x * 100 * 10 ** d + 1e-9) / 10 ** d).toFixed(d)}\\%`;
/** An upper bound printed as a percentage: rounded up, never to nearest, so
 * "at most X" stays true of the value it summarizes. */
const pctCeil = (x: number, d = 1) => `${(Math.ceil(x * 100 * 10 ** d - 1e-9) / 10 ** d).toFixed(d)}\\%`;
// A ratio printed from its integer counts, so the same k/n prints the same
// digits whichever artifact carries it (one stores 1047/2000 as
// 0.5235000000000001, another as 0.5235).
const ratioPct = (k: number, n: number, d = 1) => pct(k / n, d);
const num = (x: number) => x.toLocaleString("en-US").replace(/,/g, "{,}");
// Run dates: a stamp that carries a time of day is printed in the paper's
// own time zone (an evening run must not read as the next day), while a
// date-only stamp (midnight UTC, or a bare YYYY-MM-DD) is a calendar date
// and is printed as such.
const fmtRunDate = (iso: string) => {
  const dateOnly = !/T/.test(iso) || /T00:00:00(\.0+)?Z$/.test(iso);
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: dateOnly ? "UTC" : "America/Los_Angeles" });
};
// One-sided Clopper-Pearson upper bound at level delta: the largest p whose
// binomial lower tail at k still exceeds delta (bisection on the exact CDF).
const lnGammaFn = (z: number): number => {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z;
  let t = z + 5.5;
  t -= (z + 0.5) * Math.log(t);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -t + Math.log((2.5066282746310005 * ser) / z);
};
const binomialLowerTail = (k: number, n: number, p: number): number => {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lnGammaFn(n + 1) - lnGammaFn(i + 1) - lnGammaFn(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
};
const cpUpper = (k: number, n: number, delta: number): number => {
  if (k >= n) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (binomialLowerTail(k, n, mid) > delta) lo = mid;
    else hi = mid;
  }
  return hi;
};
/** Wilson score interval; every interval in the paper is Wilson. */
const wilsonInterval = (k: number, n: number, z = 1.96): [number, number] => {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
};
const prices = J("gateway-prices.json") as { fetchedAt: string; models: Record<string, { inputPerToken: number; outputPerToken: number }> };

// ---------------------------------------------------------------------------
// Table 1
// ---------------------------------------------------------------------------
interface Row8 {
  pair: string;
  alpha: number;
  estimand: string;
  n: number;
  trueFlipRate: number;
  main: {
    sampled: number;
    reused: number;
    recompute: number;
    realizedPresented: number;
    realizedReuse: number;
    savings: number;
  };
  bootstrap: {
    certificationRate: number;
    violationRateReuseSet: number;
    savingsMean: number;
    savingsSd: number;
    savingsLo: number;
    savingsHi: number;
  };
}
const rows = (exp8.results as Row8[]).filter((r) => r.estimand === "presented");
const texRows = rows.map((r) => {
  const m = r.main;
  const b = r.bootstrap;
  const cert = m.reused > 0;
  return (
    [
      LABELS[r.pair] ?? r.pair,
      r.alpha.toFixed(2),
      pct(r.trueFlipRate, 2),
      num(m.sampled),
      cert ? num(m.reused) : "0",
      cert ? pct(m.realizedPresented, 2) : "--",
      // The main seed's realized reuse-set rate is a count over all the cells
      // it reused, not a sample of them, so it carries no interval.
      cert ? pct(m.realizedReuse, 2) : "--",
      `${(b.savingsMean * 100).toFixed(1)} [${((b as unknown as {savingsLo:number}).savingsLo * 100).toFixed(1)},${((b as unknown as {savingsHi:number}).savingsHi * 100).toFixed(1)}]`,
      // One decimal: at zero decimals a 99.9% share printed as "100%" beside
      // prose that quotes these shares to one decimal.
      `${(b.certificationRate * 100).toFixed(1)}\\%`,
      b.certificationRate > 0
        ? `${(b.violationRateReuseSet * 100).toFixed(1)}\\%`
        : "--",
    ].join(" & ") + " \\\\"
  );
});
writeFileSync(
  "paper/table1.tex",
  `% GENERATED by scripts/experiments/gen-paper-assets.ts from
% exp8-final-table.json (${exp8.procedure}). Do not edit by hand.
\\begin{tabular}{lrrrrrrrrr}
\\toprule
Edit & $\\alpha$ & flip & oracle & reused & FR$_{\\text{pres}}$ & FR$_{\\text{reuse}}$ & savings \\% [95\\% PI] & cert. & exceed. \\\\
\\midrule
${texRows.join("\n")}
\\bottomrule
\\end{tabular}
`,
);

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------
const frontierPlots = Object.keys(LABELS)
  .map((pair) => {
    const pts = rows
      .filter((r) => r.pair === pair)
      .sort((a, b) => a.alpha - b.alpha)
      .map((r) => {
        // The bar is the 95% percentile interval of Table 1, not mean +- sd:
        // the replications are a certify/refuse mixture, and a symmetric bar
        // reaches below zero savings. Where a configuration certifies in a
        // few replications only, the interval is [0, 0] and the mean sits
        // above it; the bar then runs from the mean down to zero.
        const mean = r.bootstrap.savingsMean * 100;
        const up = Math.max(0, r.bootstrap.savingsHi * 100 - mean);
        const down = Math.max(0, mean - r.bootstrap.savingsLo * 100);
        return `(${r.alpha},${mean.toFixed(1)}) += (0,${up.toFixed(1)}) -= (0,${down.toFixed(1)})`;
      })
      .join(" ");
    return `\\addplot+[error bars/.cd, y dir=both, y explicit] coordinates { ${pts} }; \\addlegendentry{${LABELS[pair]}}`;
  })
  .join(" ");
const calRows = (exp9.results as Array<{
  alpha: number;
  size: number;
  p: number;
  estimand: string;
  certificationRate: number;
}>).filter((r) => r.estimand === "presented" && r.alpha === 0.05);
const powerPlots = [600, 1800, 5000]
  .map((size) => {
    const pts = calRows
      .filter((r) => r.size === size)
      .sort((a, b) => a.p - b.p)
      .map((r) => `(${r.p},${(r.certificationRate * 100).toFixed(1)})`)
      .join(" ");
    return `\\addplot coordinates { ${pts} }; \\addlegendentry{$n_j{=}${num(size)}$}`;
  })
  .join(" ");
writeFileSync(
  "paper/figdata.tex",
  `% GENERATED. Do not edit.
% Series colors of the frontier figure (a color-blind-safe set; the series
% also differ in mark and dash pattern).
\\definecolor{frontierA}{RGB}{0,114,178}
\\definecolor{frontierB}{RGB}{213,94,0}
\\definecolor{frontierC}{RGB}{0,158,115}
\\definecolor{frontierD}{RGB}{204,121,167}
\\newcommand{\\frontierplots}{${frontierPlots}}
\\newcommand{\\powerplots}{${powerPlots}}
`,
);

// ---------------------------------------------------------------------------
// Macros for every prose number
// ---------------------------------------------------------------------------
const pick = (pair: string, alpha: number) =>
  rows.find((r) => r.pair === pair && r.alpha === alpha)!;

// Noise floors, computed from the raw label draws (NOT hand-typed).
// WITHIN-version draw pairs = self-flip floor; ACROSS-version pairs =
// edit flip rate with fresh labels on both sides. Conflating them
// inverts the narrative, so both are derived here explicitly.
const rawLabels = J("exp10-labels.json") as Record<
  string,
  { d1: Array<boolean | null>; d2: Array<boolean | null> }
>;
const pairRate = (pairs: Array<[boolean | null, boolean | null]>) => {
  let n = 0;
  let d = 0;
  for (const [a, b] of pairs) {
    if (a === null || b === null) continue;
    n++;
    if (a !== b) d++;
  }
  return n > 0 ? d / n : 0;
};
const within: Array<[boolean | null, boolean | null]> = [];
const across: Array<[boolean | null, boolean | null]> = [];
for (const r of Object.values(rawLabels)) {
  for (const ds of [r.d1, r.d2]) {
    for (let i = 0; i < ds.length; i++)
      for (let j = i + 1; j < ds.length; j++) within.push([ds[i]!, ds[j]!]);
  }
  for (let k = 0; k < r.d1.length; k++) across.push([r.d1[k]!, r.d2[k]!]);
}
const floorBoolValue = pairRate(within);
def("floorBool", pct(floorBoolValue, 1));
def("editFlipFreshBoth", pct(pairRate(across), 1));
// F11: the floor is a PER-STRATUM quantity. The column-level average is a
// mixture and bounds neither stratum; the stratum floors explain the
// ceiling, the never-certified stratum, and the subgroup result.
// Bucket by the STORED v1 cell (the label the certifier actually
// stratifies on), never by the majority of the same draws we then
// measure: that would guarantee an agreeing pair inside each bucket and
// bias both floors downward (review r7, P4).
const dbf = await mysql.createConnection({ uri: MYSQL_URL });
const [storedRows] = (await dbf.query(
  `SELECT c.row_id, c.value FROM ai_cells c
   JOIN ai_columns col ON col.id = c.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles'
     AND c.prompt_version = 1 AND c.status IN ('done','cached')`,
)) as unknown as [Array<{ row_id: string; value: unknown }>];
// The evaluation vector's stored v2 cells were not all drawn at once: most of
// them were re-drawn the day after the first labeling, which is why the
// relabeling experiment (exp10) recorded a different single-draw flip count
// than Table 1's label instrument reads today. Dump the write days so the
// reconciliation table can say so from the release.
const [vecRaw] = (await dbf.query(`SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`, [42, 2000])) as unknown as [Array<Record<string, unknown>>];
const vecIds = vecRaw.map((r) => String(r.response_id));
const [vecWrites] = (await dbf.query(
  `SELECT DATE_FORMAT(c.updated_at, '%Y-%m-%d') AS day, COUNT(*) AS cells FROM ai_cells c
   JOIN ai_columns col ON col.id = c.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles'
     AND c.prompt_version = 2 AND c.status IN ('done','cached') AND c.row_id IN (?)
   GROUP BY day ORDER BY day`,
  [vecIds],
)) as unknown as [Array<{ day: string; cells: number }>];
await dbf.end();
const evalVectorV2WriteDays = vecWrites.map((r) => ({ day: String(r.day), cells: Number(r.cells) }));
if (evalVectorV2WriteDays.length !== 2) {
  throw new Error(`the evaluation vector's v2 cells were written on ${evalVectorV2WriteDays.length} days, not two; rewrite the reconciliation row for the earlier labeling`);
}
def("vectorRedrawnCells", num(evalVectorV2WriteDays[1]!.cells));
def(
  "vectorRedrawnDate",
  new Date(`${evalVectorV2WriteDays[1]!.day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
);
const storedVal = new Map(
  storedRows.map((r) => [
    r.row_id,
    typeof r.value === "string" ? JSON.parse(r.value) : r.value,
  ]),
);
const byVal: Record<string, Array<[boolean | null, boolean | null]>> = {
  t: [],
  f: [],
};
// Row-cluster bootstrap: pairs within a row are dependent, so resample
// ROWS, not pairs, for the interval.
const rowPairs: Record<string, Array<Array<[boolean | null, boolean | null]>>> =
  { t: [], f: [] };
for (const [rowId, r] of Object.entries(rawLabels)) {
  const v = storedVal.get(rowId);
  if (v === undefined || v === null) continue;
  const key = v === true ? "t" : "f";
  // The floor is the IDENTITY-EDIT flip rate, which is what the certifier
  // would measure for an unedited prompt: the stored cached value against
  // each fresh draw. Pairs of fresh draws bucketed by the cached value are a
  // different quantity (3.1% and 24.1% here, against 2.6% and 23.0%),
  // because the cached draw is the one that put the cell in its stratum.
  const pairs: Array<[boolean | null, boolean | null]> = r.d1.map((d) => [v as boolean, d ?? null]);
  byVal[key]!.push(...pairs);
  rowPairs[key]!.push(pairs);
}
const clusterCi = (clusters: Array<Array<[boolean | null, boolean | null]>>) => {
  const rand = mulberry32(20260805);
  const draws: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const sample: Array<[boolean | null, boolean | null]> = [];
    for (let i = 0; i < clusters.length; i++)
      sample.push(...clusters[Math.floor(rand() * clusters.length)]!);
    draws.push(pairRate(sample));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * draws.length)]!, draws[Math.floor(0.975 * draws.length)]!];
};
const ciT = clusterCi(rowPairs.t!);
const ciF = clusterCi(rowPairs.f!);
def("floorTrueStratum", pct(pairRate(byVal.t!), 1));
def("floorFalseStratum", pct(pairRate(byVal.f!), 1));
def("floorTrueCi", `[${(ciT[0] * 100).toFixed(1)}, ${(ciT[1] * 100).toFixed(1)}]`);
def("floorFalseCi", `[${(ciF[0] * 100).toFixed(1)}, ${(ciF[1] * 100).toFixed(1)}]`);
// The same comparison pooled over both strata, so the reader can see the
// two stratum floors mix to it and not to the fresh-pair figure.
def("floorIdentityPooled", pct(pairRate([...byVal.t!, ...byVal.f!]), 1));
def("floorBoolVote", pct(exp10.vote3FlipRate, 2));
def("floorBoolStored", pct(exp10.singleDrawFlipRate, 1));
def("labelChurn", pct(exp10.labelDisagreementRate, 1));
// r8/M10: the paper reports 6.0% and 6.3% for what a reader takes to be one
// measurement and never reconciles them. They are two DRAWS of the same
// quantity on the same 2,000 rows: exp10 draws v2 fresh, Table 1 uses the
// stored v2 labels. Emit the gap in rows so the prose can say so exactly.
{
  const t1 = (exp8.results as Array<{
    pair: string;
    estimand: string;
    n: number;
    trueFlipRate: number;
  }>).find((r) => r.pair === "so-formatting" && r.estimand === "presented")!;
  // The two instruments differ by a handful of rows; the prose says so
  // without a count, because the one-decimal rates printed beside it cannot
  // reproduce one.
  if (Math.round(t1.trueFlipRate * t1.n) === Math.round(exp10.singleDrawFlipRate * exp10.n)) {
    throw new Error("the two single-draw instruments agree exactly; rewrite the label-noise sentence in body.tex");
  }
  // The three single-quantity labelings read 6.35%, 6.0% and 6.30%; the flip
  // counts behind them are cited beside the rates.
  def("fmtStoredFlips", String(Math.round(t1.trueFlipRate * t1.n)));
  def("fmtEarlierFlips", String(Math.round(exp10.singleDrawFlipRate * exp10.n)));
  def("fmtVoteFlips", String(Math.round(exp10.vote3FlipRate * exp10.n)));
}
def("floorSelect", pct(exp0b.selfFlipRate, 1));
def("floorDefaultT", pct(exp0.regimes["default-T"].selfFlipRate, 1));
def("floorTzeroProbe", pct(exp0.regimes["T0"].selfFlipRate, 1));

// Edit flip rates
// The five pairs' flip rates are counts over 2,000 cells, so two decimals
// print them exactly (127 of 2,000 is 6.35%, which one decimal cannot show).
def("flipSoFormatting", pct(pick("so-formatting", 0.2).trueFlipRate, 2));
def("flipSoSynonym", pct(pick("so-synonym", 0.2).trueFlipRate, 2));
def("flipSoWidening", pct(pick("so-widening", 0.2).trueFlipRate, 2));
def("flipDjFormatting", pct(pick("dj-formatting", 0.2).trueFlipRate, 2));
def("flipDjCriteria", pct(pick("dj-criteria", 0.2).trueFlipRate, 2));

// Benchmark headline (n=2000)
const bench = pick("so-formatting", 0.2);
def("benchN", num(bench.n));
def("benchSavings", `${(bench.bootstrap.savingsMean * 100).toFixed(1)}\\%`);
def("benchSavingsMain", ratioPct(bench.main.reused, bench.n, 1));
const bci = bench.bootstrap as unknown as {
  savingsLo: number; savingsHi: number;
  realizedReuseCiLo: number; realizedReuseCiHi: number; B: number;
};
def("bootB", num(bci.B));
def("benchRealized", pct(bench.main.realizedPresented, 2));
// The abstract quotes this one realized figure after both headline budgets,
// which is right only while the main seed reuses the same cells at the two.
if (pick("so-formatting", 0.1).main.realizedPresented !== bench.main.realizedPresented) {
  throw new Error("the main seed's realized false-reuse differs between alpha=0.1 and alpha=0.2; the abstract quotes one figure for both, rewrite it");
}
def("benchRealizedReuse", pct(bench.main.realizedReuse, 2));
def("synTightCertRate", pct(pick("so-synonym", 0.1).bootstrap.certificationRate, 1));
def("benchOracleMain", String(pick("so-formatting", 0.2).main.sampled));
const frontier = [0.2, 0.1, 0.05, 0.02].map(
  (a) => `${(pick("so-formatting", a).bootstrap.savingsMean * 100).toFixed(1)}\\%`,
);
def("frontierA", frontier[0]!);
def("frontierB", frontier[1]!);
def("frontierC", frontier[2]!);
const edge = pick("so-formatting", 0.05);
// One decimal: this rate is 0.8%, and toFixed(0) printed it as "1%", a
// 25% overstatement of the paper's single nonzero exceedance cell.
def("edgeCertRate", `${(edge.bootstrap.certificationRate * 100).toFixed(1)}\\%`);
def("edgeSavingsMean", pct(edge.bootstrap.savingsMean, 1));
// Under the exact bound the certifier spends its budget, so Table 1 can
// contain a configuration whose rare certifications are unsafe (a stratum
// whose flip rate sits just above alpha). An unsafe certificate is counted
// as Theorem 1 defines it and per stratum: a certificate for a stratum whose
// whole realized flip count exceeds alpha n_j (in the strict mode, alpha
// times the cells it reuses). A union of certified strata can sit inside the
// budget while one of them does not, so a union-level rate undercounts.
{
  type RV = Row8 & { bootstrap: Row8["bootstrap"] & { violationRatePresented: number; unsafeCertificateRate?: number } };
  const unsafeRate = (r: RV) => {
    if (r.bootstrap.unsafeCertificateRate === undefined) throw new Error("exp8-final-table.json lacks the per-stratum unsafe-certificate rate; re-run exp8-final-table.ts");
    return r.bootstrap.unsafeCertificateRate;
  };
  // Per-stratum level of the column a configuration belongs to.
  const levelOf = (r: RV) => DELTA_TOTAL / strataCountOf(r.pair);
  const pres = rows as RV[];
  const unsafe = pres.map((r) => ({ r, u: unsafeRate(r) })).filter((x) => x.u > 0);
  // The main-results paragraph says the table contains one configuration
  // with unsafe certificates, that every certificate it issues is unsafe,
  // and that the share sits inside the per-stratum level.
  if (unsafe.length !== 1) {
    throw new Error(`the default mode has ${unsafe.length} configurations with unsafe certificates, not one; rewrite "Certificates that exceed the budget" in body.tex`);
  }
  const worst = unsafe[0]!;
  if (!(worst.u === worst.r.bootstrap.certificationRate && worst.u < levelOf(worst.r))) {
    throw new Error("the default mode's unsafe configuration no longer has every certificate unsafe, or its rate left the per-stratum level; rewrite the paragraph in body.tex");
  }
  def("tableUnsafeWorstPair", LABELS[worst.r.pair] ?? worst.r.pair);
  def("tableUnsafeWorstAlpha", worst.r.alpha.toString());
  def("tableUnsafeWorstCert", pct(worst.r.bootstrap.certificationRate, 1));
  const exceed = pres.filter(
    (r) => r.bootstrap.certificationRate > 0 && r.bootstrap.violationRateReuseSet > 0,
  );
  def("tableExceedConfigs", String(exceed.length));
  // The strict mode's unsafe certificates, by the same per-stratum count.
  // The appendix names how many configurations have any, the largest rate,
  // and where it occurs, and says each sits inside its per-stratum level.
  const strictUnsafe = (exp8.results as RV[])
    .filter((r) => (r as unknown as { estimand: string }).estimand === "reuse-set")
    .map((r) => ({ r, u: unsafeRate(r) }))
    .filter((x) => x.u > 0);
  if (strictUnsafe.length === 0) throw new Error("the strict mode has no configuration with unsafe certificates; rewrite the sentence in the strict-mode appendix");
  if (!strictUnsafe.every((x) => x.u < levelOf(x.r))) {
    throw new Error("a strict-mode unsafe rate is not inside its per-stratum level; rewrite the sentence in the strict-mode appendix");
  }
  const strictWorst = strictUnsafe.reduce((a, b) => (b.u > a.u ? b : a));
  if (strictUnsafe.filter((x) => x.u === strictWorst.u).length !== 1) {
    throw new Error("the largest strict-mode unsafe rate is shared by two configurations; rewrite the sentence, which names one");
  }
  def("strictUnsafeConfigs", String(strictUnsafe.length));
  def("strictUnsafePair", LABELS[strictWorst.r.pair] ?? strictWorst.r.pair);
  def("strictUnsafeAlpha", strictWorst.r.alpha.toString());
  def("strictUnsafeRate", pct(strictWorst.u, 1));
}

// Sampling fractions across reliably-certifying configs
const reliable = rows.filter(
  (r) => r.bootstrap.certificationRate > 0.5 && r.main.reused > 0,
);
const fracs = reliable.map((r) => r.main.sampled / r.n);
def("sampleFracLo", `${(Math.min(...fracs) * 100).toFixed(0)}\\%`);
def("sampleFracHi", `${(Math.max(...fracs) * 100).toFixed(0)}\\%`);

// Oracle-call distribution for the headline config (R6: one seeded run is
// one draw; the replication distribution is the honest quantity).
interface Boot { oracleMean: number; oracleP50: number; oracleMin: number; oracleMax: number }
const bb = bench.bootstrap as unknown as Boot;
def("benchOracleMean", bb.oracleMean.toFixed(0));
def("benchOracleMedian", String(bb.oracleP50));
def("benchOracleRange", `${bb.oracleMin}--${bb.oracleMax}`);
const bt = (pick("so-formatting", 0.1).bootstrap as unknown as Boot);
def("benchOracleTightMean", bt.oracleMean.toFixed(0));
def("benchOracleTightRange", `${bt.oracleMin}--${bt.oracleMax}`);
def("benchOracleTightMedian", String(bt.oracleP50));


// Ablation
const ab = (exp8ab.results as Row8[]).find(
  (r) => r.pair === "so-formatting" && r.alpha === 0.2 && r.estimand === "presented",
)!;
// r9b/M4: Contribution 2 advertises TWO guarantee targets but the paper
// printed benchmark numbers for only one, while the strict reuse-set arm sat
// complete in the artifact. Emit it beside the default mode's own figures,
// so the prose compares like with like: under the exact bound the strict
// mode is free where the flip rate sits well below the budget and its
// price rises as the budget approaches the flip rate.
{
  type R8s = {
    pair: string;
    alpha: number;
    estimand: string;
    n: number;
    trueFlipRate: number;
    main: { reused: number };
    bootstrap: { savingsMean: number; certificationRate: number };
  };
  const strict = (exp8.results as R8s[]).filter((r) => r.estimand === "reuse-set");
  const dflt = (exp8.results as R8s[]).filter((r) => r.estimand === "presented");
  const at = (pair: string, alpha: number) =>
    strict.find((r) => r.pair === pair && r.alpha === alpha)!;
  const atD = (pair: string, alpha: number) =>
    dflt.find((r) => r.pair === pair && r.alpha === alpha)!;
  const mean = (r: R8s) => pct(r.bootstrap.savingsMean, 1);
  const cert = (r: R8s) => pct(r.bootstrap.certificationRate, 1);
  def("reuseSetSavingsTight", mean(at("so-formatting", 0.1)));
  def("reuseSetCertEdge", cert(at("so-formatting", 0.05)));
  def(
    "reuseSetDjCertTightMax",
    pctCeil(
      strict
        .filter((r) => r.pair.startsWith("dj-") && Math.abs(r.alpha - 0.1) < 1e-9)
        .reduce((a, r) => Math.max(a, r.bootstrap.certificationRate), 0),
      1,
    ),
  );
  // The prose states relations between these figures ("free", "two points",
  // "within a point", "far below"); a regenerated artifact that breaks one
  // must fail here rather than print a stale sentence.
  const relation = (name: string, ok: boolean) => {
    if (!ok) throw new Error(`main-results and strict-mode paragraphs: relation no longer holds (${name}); rewrite the sentence in body.tex`);
  };
  const pts = (x: number) => x * 100;
  relation("free at the loose budget", Math.abs(pts(at("so-formatting", 0.2).bootstrap.savingsMean - atD("so-formatting", 0.2).bootstrap.savingsMean)) < 0.05 && at("so-formatting", 0.2).bootstrap.certificationRate === 1);
  relation("two points at the tight budget", Math.round(pts(atD("so-formatting", 0.1).bootstrap.savingsMean - at("so-formatting", 0.1).bootstrap.savingsMean)) === 2 && pts(atD("so-formatting", 0.1).bootstrap.certificationRate - at("so-formatting", 0.1).bootstrap.certificationRate) < 1);
  relation("strict mode far below the default at 0.05", at("so-formatting", 0.05).bootstrap.certificationRate < atD("so-formatting", 0.05).bootstrap.certificationRate / 4);
  for (const pair of ["so-synonym", "so-widening"]) {
    relation(`${pair} within a point at 0.2`, Math.abs(pts(at(pair, 0.2).bootstrap.savingsMean - atD(pair, 0.2).bootstrap.savingsMean)) < 1);
    relation(`${pair} far below at 0.1`, at(pair, 0.1).bootstrap.savingsMean < atD(pair, 0.1).bootstrap.savingsMean / 2);
  }
  for (const pair of ["dj-formatting", "dj-criteria"]) {
    relation(`${pair} strict savings well below default at 0.2`, at(pair, 0.2).bootstrap.savingsMean < atD(pair, 0.2).bootstrap.savingsMean * 0.75);
    // "Which budgets are usable" (Limitations) states these of the select column.
    relation(`${pair} default mode certifies in most replications at 0.1`, atD(pair, 0.1).bootstrap.certificationRate > 0.5);
    relation(`${pair} refused at 0.05 in both modes`, atD(pair, 0.05).bootstrap.certificationRate === 0 && at(pair, 0.05).bootstrap.certificationRate === 0);
    relation(`${pair} flip rate above 0.05`, atD(pair, 0.05).trueFlipRate > 0.05);
  }
  // Main results (Section V-B): "The synonym and scope-widening edits certify
  // at alpha=0.1 in most replications and are refused below it, apart from
  // the few scope-widening certificates accounted for below." An earlier
  // sentence ("semantic edits are refused at tight budgets") outlived the
  // bound it was written under, so the reading is asserted here.
  for (const pair of ["so-synonym", "so-widening"]) {
    relation(`${pair} default mode certifies in most replications at 0.1`, atD(pair, 0.1).bootstrap.certificationRate > 0.5);
    relation(`${pair} refused at 0.02`, atD(pair, 0.02).bootstrap.certificationRate === 0);
  }
  relation("so-synonym refused at 0.05", atD("so-synonym", 0.05).bootstrap.certificationRate === 0);
  // The same paragraph: "in every replication at 0.2 ... in nearly every
  // replication at 0.1"; on the select column "in every replication, for
  // about half the column" at 0.2 and "for less than a sixth of it" at 0.1.
  relation("so-formatting certifies in every replication at 0.2 and nearly every one at 0.1", atD("so-formatting", 0.2).bootstrap.certificationRate === 1 && atD("so-formatting", 0.1).bootstrap.certificationRate > 0.98);
  for (const pair of ["dj-formatting", "dj-criteria"]) {
    relation(`${pair} certifies in every replication at 0.2 for about half the column`, atD(pair, 0.2).bootstrap.certificationRate === 1 && atD(pair, 0.2).bootstrap.savingsMean > 0.45 && atD(pair, 0.2).bootstrap.savingsMean < 0.55);
    relation(`${pair} saves less than a sixth of the column at 0.1`, atD(pair, 0.1).bootstrap.savingsMean < 1 / 6);
  }
  relation(
    "so-widening certifies in only a few replications at 0.05",
    atD("so-widening", 0.05).bootstrap.certificationRate > 0 && atD("so-widening", 0.05).bootstrap.certificationRate < 0.05,
  );
  // How much of the grid certifies at all, so the abstract can disclose that
  // the headline economics live at the loose end of the frontier.
  const pres = (exp8.results as Array<{
    estimand: string;
    bootstrap: { certificationRate: number };
  }>).filter((r) => r.estimand === "presented");
  def("tableConfigs", String(pres.length));
  def(
    "certifyingConfigs",
    String(pres.filter((r) => r.bootstrap.certificationRate > 0).length),
  );
}
def("ablationSavings", `${(ab.bootstrap.savingsMean * 100).toFixed(1)}\\%`);
// r8/M3: contribution 4 claimed the refinement RECOVERS refused savings.
// Joining all shared configurations says the opposite, so the direction is
// counted here rather than asserted in prose.
{
  const keyOf = (r: { pair: string; alpha: number; estimand: string }) =>
    `${r.pair}|${r.alpha}|${r.estimand}`;
  const fine = new Map(
    (exp8ab.results as Array<{
      pair: string;
      alpha: number;
      estimand: string;
      bootstrap: { savingsMean: number };
    }>).map((r) => [keyOf(r), r.bootstrap.savingsMean]),
  );
  const fineCert = new Map(
    (exp8ab.results as Array<{ pair: string; alpha: number; estimand: string; bootstrap: { certificationRate: number } }>).map((r) => [keyOf(r), r.bootstrap.certificationRate]),
  );
  let better = 0;
  let worse = 0;
  let total = 0;
  type Win = { pair: string; alpha: number; fineMean: number; baseMean: number; fineCert: number; baseCert: number };
  const wins: Win[] = [];
  for (const r of exp8.results as Array<{
    pair: string;
    alpha: number;
    estimand: string;
    bootstrap: { savingsMean: number; certificationRate: number };
  }>) {
    const f = fine.get(keyOf(r));
    if (f === undefined) continue;
    total++;
    if (f > r.bootstrap.savingsMean + 1e-9) {
      better++;
      wins.push({ pair: r.pair, alpha: r.alpha, fineMean: f, baseMean: r.bootstrap.savingsMean, fineCert: fineCert.get(keyOf(r)) ?? 0, baseCert: r.bootstrap.certificationRate });
    } else if (f < r.bootstrap.savingsMean - 1e-9) worse++;
  }
  def("ablationTotal", String(total));
  def("ablationBetter", String(better));
  def("ablationWorse", String(worse));
  // Where the wins sit: the value-only certification rate they occur at,
  // and the largest of them, so the prose describes the wins it counts.
  if (wins.length === 0) throw new Error("stratifier ablation: no win to describe; rewrite the sentence in body.tex");
  const top = wins.reduce((a, w) => (w.fineMean - w.baseMean > a.fineMean - a.baseMean ? w : a));
  def("ablationWinBaseCertMax", pctCeil(Math.max(...wins.map((w) => w.baseCert)), 1));
}

// exp7 baselines (regenerate B2/B1/B3 prose)
interface E7 {
  label: string;
  flipRate: number;
  aucInteraction: number;
  aucVcache: number;
  vcacheSimRange: [number, number];
  aggregate: Record<
    string,
    {
      certified: boolean;
      sampled: number;
      reused: number;
      realized: number;
      realizedTrueSubgroup: number | null;
      savings: number;
    }
  >;
  b3: { tauSweep: Array<{ tau: number; reusedFraction: number; realizedErrorAmongReused: number }> };
}
const e7f = (exp7.results as E7[]).find((r) => r.label === "formatting-only")!;
const e7w = (exp7.results as E7[]).find((r) => r.label === "scope-widening")!;
def("aucVcacheF", e7f.aucVcache.toFixed(3));
def("aucVcacheW", e7w.aucVcache.toFixed(3));
def("aucInterF", e7f.aucInteraction.toFixed(3));
def("aucInterW", e7w.aucInteraction.toFixed(3));
def("simLo", e7f.vcacheSimRange[0].toFixed(2));
def("simHi", e7f.vcacheSimRange[1].toFixed(2));
const aggF = e7f.aggregate["alpha0.2"]!;
const aggW = e7w.aggregate["alpha0.2"]!;
def("aggFsavings", pct(aggF.savings));
def("aggFrealized", pct(aggF.realized, 2));
def("aggFsubgroup", pct(aggF.realizedTrueSubgroup ?? 0, 1));
def("aggWsubgroup", pct(aggW.realizedTrueSubgroup ?? 0, 1));
def("aggWsavings", pct(aggW.savings));
def("aggWrealized", pct(aggW.realized, 2));
def("aggWsampled", String(aggW.sampled));
const aggFt = e7f.aggregate["alpha0.1"]!;
def("aggTightCertF", aggFt.certified ? "certifies" : "certifies nothing");
def("aggFtSavings", pct(aggFt.savings));
def("aggFtRealized", pct(aggFt.realized, 2));
def("aggFtSubgroup", pct(aggFt.realizedTrueSubgroup ?? 0, 1));
def("aggFsampled", String(aggF.sampled));
def("aggFtSampled", String(aggFt.sampled));
def("aggTightCertW", e7w.aggregate["alpha0.1"]!.certified ? "certifies" : "refuses");
const tauF = e7f.b3.tauSweep;
const tauW = e7w.b3.tauSweep;
const at = (sweep: typeof tauF, tau: number) => sweep.find((t) => t.tau === tau)!;
def("tauFmid", pct(at(tauF, 0.96).reusedFraction, 0));
def("tauFhi", pct(at(tauF, 0.98).reusedFraction, 1));
def("tauFerrLo", pct(Math.min(...tauF.filter((t) => t.reusedFraction > 0).map((t) => t.realizedErrorAmongReused)), 1));
def("tauFerrHi", pct(Math.max(...tauF.map((t) => t.realizedErrorAmongReused)), 1));
def("tauWmid", pct(at(tauW, 0.94).reusedFraction, 1));
def("tauWhi", pct(at(tauW, 0.96).reusedFraction, 1));
def("tauWerrLo", pct(Math.min(...tauW.filter((t) => t.reusedFraction > 0).map((t) => t.realizedErrorAmongReused)), 1));
def("tauWerrHi", pct(Math.max(...tauW.map((t) => t.realizedErrorAmongReused)), 1));
// The prose gives the width of the window in which the baseline collapses:
// nearly every row reused at one threshold, none 0.03 above it.
for (const [name, sweep, lo, hi] of [["formatting", tauF, 0.96, 0.99], ["widening", tauW, 0.94, 0.97]] as const) {
  if (!(at(sweep, lo).reusedFraction >= 0.99 && at(sweep, hi).reusedFraction === 0)) {
    throw new Error(`threshold sweep (${name}): the baseline no longer falls from nearly every row at ${lo} to none at ${hi}; rewrite "a window about 0.03 wide"`);
  }
}

// exp4 minority stratum
def("minoritySingle", pct(exp4.singleShotFlipRate, 1));
def("minorityVote", pct(exp4.vote3FlipRate, 1));
def("minorityNoise", pct(1 - exp4.vote3ConfirmsStoredTrue, 1));

// The vote, measured a second time, and a cache built by it. exp4 voted three
// draws on each side for the cached-TRUE rows in a run of its own. The
// three-draw labels (exp10) hold three draws of each version for every row of
// the vector, so the same statistic can be recomputed from stored draws, and
// so can the stratum a voted cache would hand the certifier: the rows whose
// three v1 draws have a TRUE majority, with the floor measured against the
// stored v1 value (a fourth draw the vote never saw) and the edit's flip rate
// against each fresh v2 draw.
{
  const majority = (ds: Array<boolean | null>) => {
    const valid = ds.filter((d): d is boolean => d !== null);
    if (valid.length === 0) throw new Error("a row of exp10-labels.json has no valid draw, so its vote is undefined");
    return valid.filter(Boolean).length * 2 > valid.length;
  };
  let storedTrue = 0;
  let rerunFlips = 0;
  let rerunOverturned = 0;
  let storedEditDraws = 0;
  let storedEditFlips = 0;
  let votedTrue = 0;
  let floorFlips = 0;
  let editDraws = 0;
  let editFlips = 0;
  for (const [rowId, r] of Object.entries(rawLabels)) {
    const stored = storedVal.get(rowId);
    if (stored !== true && stored !== false) throw new Error(`row ${rowId} of the three-draw labels has no stored v1 value`);
    const m1 = majority(r.d1);
    const m2 = majority(r.d2);
    if (stored) {
      storedTrue++;
      if (m1 !== m2) rerunFlips++;
      if (!m1) rerunOverturned++;
      for (const d of r.d2) {
        if (d === null) continue;
        storedEditDraws++;
        if (d !== stored) storedEditFlips++;
      }
    }
    if (m1) {
      votedTrue++;
      if (stored !== m1) floorFlips++;
      for (const d of r.d2) {
        if (d === null) continue;
        editDraws++;
        if (d !== m1) editFlips++;
      }
    }
  }
  const rerunRate = rerunFlips / storedTrue;
  const votedFloor = floorFlips / votedTrue;
  const votedEdit = editFlips / editDraws;
  const storedEdit = storedEditFlips / storedEditDraws;
  // What the prose says of these figures, enforced: the two vote measurements
  // are over the same rows and print differently; neither brings the stratum
  // under the loosest budget of the evaluation; the voted cache has the lower
  // floor; and under the edit it flips no less than the single-draw cache
  // does against the same fresh draws.
  const loosestBudget = Math.max(...rows.map((r) => r.alpha));
  if (storedTrue !== exp4.n) {
    throw new Error(`exp4 voted on ${exp4.n} cached-TRUE rows and the three-draw labels hold ${storedTrue}; the anatomy paragraph calls them the same rows`);
  }
  if (pct(rerunRate, 1) === pct(exp4.vote3FlipRate, 1)) {
    throw new Error("the two vote-of-3 measurements now print the same; rewrite the anatomy paragraph, which reports them as two figures");
  }
  if (!(exp4.vote3FlipRate > loosestBudget && rerunRate > loosestBudget)) {
    throw new Error("a vote-of-3 flip rate is now at or under the loosest budget; rewrite the anatomy paragraph");
  }
  if (!(exp4.vote3FlipRate < exp4.singleShotFlipRate && rerunRate < exp4.singleShotFlipRate)) {
    throw new Error("a vote-of-3 flip rate is no longer below the single-draw rate; the anatomy paragraph says the vote brought the rate down to it");
  }
  if (!(votedFloor < pairRate(byVal.t!))) {
    throw new Error("the voted cache's TRUE stratum no longer has the lower floor; rewrite the anatomy paragraph and the floor paragraph of Section II");
  }
  if (!(votedEdit > loosestBudget && votedEdit >= storedEdit)) {
    throw new Error("the voted cache's TRUE stratum now flips less under the edit than the single-draw cache's; rewrite the anatomy paragraph and the floor paragraph of Section II");
  }
  def("minorityVoteRerun", pct(rerunRate, 1));
  def("minorityNoiseRerun", pct(rerunOverturned / storedTrue, 1));
  def("votedStoredTrueN", String(storedTrue));
  def("votedTrueN", String(votedTrue));
  def("votedTrueFloor", pct(votedFloor, 1));
  def("votedTrueEditFlip", pct(votedEdit, 1));
}

// exp9 calibration
def("calTrials", num(exp9.results.length * exp9.trials));
def("calConfigs", String(exp9.results.length));
// Validity under the exact bound is a RATE, not a zero: the guarantee is on
// the realized whole-stratum flip count, so at a planted p just above alpha
// the realized population rate is often below alpha and certifying it is
// correct. The metric is P(certify and realized presented-cells error >
// alpha), unconditional, against the per-stratum delta the study plants.
{
  type C9 = {
    alpha: number;
    size: number;
    p: number;
    estimand: string;
    certificationRate: number;
    violationRatePresented: number;
    violationRateReuseSet: number;
  };
  const cal = exp9.results as C9[];
  const T = Number(exp9.trials);
  // Theorem 1's event: certified AND realized whole-stratum flip count above
  // alpha n_j (sampled flips included); in strict mode, above alpha times
  // the reused count, which is what that mode certifies.
  const unsafeOf = (r: C9 & { violationRateTheorem?: number; violationRateTheoremStrict?: number }) => {
    const cond = r.estimand === "presented" ? r.violationRateTheorem : r.violationRateTheoremStrict;
    if (cond === undefined) throw new Error(`exp9 lacks the Theorem 1 event rate for ${r.estimand}; re-run exp9-calibration`);
    return r.certificationRate * cond;
  };
  const worst = cal.reduce((a, b) => (unsafeOf(b) > unsafeOf(a) ? b : a));
  const u = unsafeOf(worst);
  const [wlo, whi] = wilsonInterval(Math.round(u * T), T);
  def("calUnsafeWorst", pctCeil(u, 2));
  def("calUnsafeWorstCi", `[${(wlo * 100).toFixed(2)}, ${(whi * 100).toFixed(2)}]\\%`);
  // The presented-cells event (a strict subset of the theorem's event), for
  // the reader who wants the user-facing quantity.
  const presentedWorst = cal.filter((r) => r.estimand === "presented").reduce((a, r) => Math.max(a, r.certificationRate * r.violationRatePresented), 0);
  def("calUnsafePresentedWorst", pctCeil(presentedWorst, 2));
  def("calUnsafeStrictWorst", pctCeil(cal.filter((r) => r.estimand !== "presented").reduce((a, r) => Math.max(a, unsafeOf(r)), 0), 2));
  // The least favourable FIXED population (one flip past the budget), where
  // the error probability is an exact finite sum (exp9b).
  {
    type Cell = { alpha: number; size: number; looks: number[]; presented: { unsafeProbability: number }; reuseSet: { unsafeProbability: number } };
    const b = J("exp9b-boundary.json") as { perStratumDelta: number; cells: Cell[] };
    const pres = b.cells.map((c) => c.presented.unsafeProbability);
    const strictWorst = Math.max(...b.cells.map((c) => c.reuseSet.unsafeProbability));
    if (!(Math.max(...pres) < b.perStratumDelta && strictWorst < b.perStratumDelta && b.perStratumDelta === Number(exp9.perStratumDelta))) {
      throw new Error("exp9b: the boundary-population error probability is not inside the per-stratum delta; rewrite the calibration paragraph");
    }
    def("calBoundaryCells", String(b.cells.length));
    // Quoted as upper bounds ("at most"), so rounded up, never to nearest.
    def("calBoundaryHi", pctCeil(Math.max(...pres), 1));
    def("calBoundaryStrictHi", pctCeil(strictWorst, 1));
  }
  def("calUnsafeWorstAlpha", worst.alpha.toString());
  def("calUnsafeWorstP", worst.p.toString());
  def("calUnsafeWorstSize", num(worst.size));
  def("calUnsafeWorstEstimand", worst.estimand === "presented" ? "default" : "strict");
  def("calNominalDelta", pct(Number(exp9.perStratumDelta), 0));
  const tight = cal.filter((r) => r.p > r.alpha && r.p <= r.alpha * 1.3);
  def("calUnsafeTightMean", pct(tight.reduce((a, r) => a + unsafeOf(r), 0) / tight.length, 2));
  const tightCertWorst = tight.reduce((a, r) => Math.max(a, r.certificationRate), 0);
  def("calTightCertWorst", pctCeil(tightCertWorst, 1));
  // A clean stratum's cost under the schedule, per stratum size.
  const cleanAt = (size: number) =>
    cal.find((r) => r.alpha === 0.05 && r.p === 0 && r.size === size && r.estimand === "presented")!;
  // Grid sizes come from the artifact itself (smallest and largest size).
  const sizes = [...new Set(cal.map((r) => r.size))].sort((a, b) => a - b);
  const cleanSmall = Math.round((cleanAt(sizes[0]!) as unknown as { avgSampled: number }).avgSampled);
  const cleanLarge = Math.round((cleanAt(sizes[sizes.length - 1]!) as unknown as { avgSampled: number }).avgSampled);
  def("minZeroFlipRealizedSmall", String(cleanSmall));
  def("minZeroFlipRealizedLarge", String(cleanLarge));
  def("minZeroFlipLargeSize", num(sizes[sizes.length - 1]!));
}
// r8/M6: the grid now probes JUST ABOVE each budget, which is the only
// regime where the without-replacement gap in Assumption 3 could bite; the
// old grid's tightest null was 1.5*alpha, where futility stops at look 1 and
// refusing is trivial. Count that regime explicitly so the prose cannot
// claim coverage the grid does not have.
{
  const cal = exp9.results as Array<{
    alpha: number;
    p: number;
    certificationRate: number;
  }>;
  const tight = cal.filter((r) => r.p > r.alpha && r.p <= r.alpha * 1.3);
  // r8/M10: B3 at tau=0.95 does NOT reuse everything on both edits; the prose
// said so while the artifact records 84% on the widening edit.
{
  const w = (exp7.results as Array<{
    label: string;
    b3: { tauSweep: Array<{ tau: number; reusedFraction: number }> };
  }>).find((r) => r.label === "scope-widening")!;
  const at95 = w.b3.tauSweep.find((t) => t.tau === 0.95)!;
  def("bThreeReuseW", pct(at95.reusedFraction, 1));
  def("bThreeErrW", pct((at95 as unknown as { realizedErrorAmongReused: number }).realizedErrorAmongReused, 1));
}
  // r9: the prose hardcoded "p in [0, 0.15]", which the alpha=0.2 tight nulls
// (planted at 0.21, 0.22, 0.25) silently falsified. Emit the range.
def(
  "calPRange",
  `[${Math.min(...cal.map((r) => r.p))}, ${Math.max(...cal.map((r) => r.p))}]`,
);
def("calTightNulls", String(tight.length));
  def(
    "calAlphaGrid",
    [...new Set(cal.map((r) => r.alpha))]
      .sort((a, b) => a - b)
      .map((a) => a.toString())
      .join(", "),
  );
}
const worstReuseMetric = Math.max(
  ...(exp9.results as Array<{ estimand: string; violationRateReuseSet: number }>)
    .filter((r) => r.estimand === "presented")
    .map((r) => r.violationRateReuseSet),
);
const worstCfg = (exp9.results as Array<{
  estimand: string;
  violationRateReuseSet: number;
  alpha: number;
  p: number;
  certificationRate: number;
}>)
  .filter((r) => r.estimand === "presented")
  .reduce((a, b) => (b.violationRateReuseSet > a.violationRateReuseSet ? b : a));
def("calWorstReuseMetric", pct(worstReuseMetric, 1));
def("calWorstP", String(worstCfg.p));
def("calWorstAlpha", String(worstCfg.alpha));
// Two decimals: 9 of 2,000 trials is 0.45%, and one decimal printed
// "0.4%", which is arithmetically impossible beside the 33.3% exceedance
// share (a third of 8 is not an integer).
def("calWorstCertRate", pct(worstCfg.certificationRate, 2));

// Deployment scale. Three sources, one sample path:
//   exp11     the live August run under Maurer-Pontil (the applied
//             certificate; its numbers are the "MP" macros);
//   exp11c    the same August oracle draws re-certified under every bound
//             (the "exact" macros the paper now headlines are a replay over
//             the stored draws; the eb arm reproduces exp11 exactly);
//   exp11cSep the certification run live again inside the September 2026
//             snapshot (version 4), all bounds and budgets.
type S11 = { stratumId: string; size: number; sampled: number; flips: number; certified: boolean; upperBound: number; looks?: Array<{ n: number; flips: number; upperBound: number; certified: boolean }> };
type W11c = { bound: string; alpha: number; status: string; oracleCalls: number; reused: number; recompute: number; savings: number; realizedOnOverlap: number | null; gtOverlapReused: number; replayWallMs: number; liveDrawsThisArm?: number; strata: S11[]; auditComposition: { fromReleasedVector: number; releasedOnlyRealized: number | null } };
const arm = (file: { sweeps: W11c[] }, bound: string, alpha: number): W11c => {
  const w = file.sweeps.find((s) => s.bound === bound && Math.abs(s.alpha - alpha) < 1e-9);
  if (!w || w.status !== "ok") throw new Error(`deployment arm ${bound}@${alpha} missing or incomplete`);
  return w;
};
const d2 = exp11.sweeps.find((s: { alpha: number }) => s.alpha === 0.2)!;
const d1 = exp11.sweeps.find((s: { alpha: number }) => s.alpha === 0.1)!;
// The replay must walk the live run's path; the script asserts it, and the
// generator asserts it again so a stale artifact cannot slip through.
for (const [a, live] of [[0.2, d2], [0.1, d1]] as const) {
  const r = arm(exp11c, "eb", a);
  if (r.oracleCalls !== live.oracleCalls || r.reused !== live.reused) {
    throw new Error(`exp11c eb@${a} (${r.oracleCalls}/${r.reused}) does not reproduce exp11 (${live.oracleCalls}/${live.reused})`);
  }
}
const dx2 = arm(exp11c, "exact", 0.2);
const dx1 = arm(exp11c, "exact", 0.1);
def("deployN", num(exp11.n));
// Headline (exact bound, August draws).
def("deployOracle", String(dx2.oracleCalls));
def("deployReused", num(dx2.reused));
def("deployRecompute", num(dx2.recompute));
def("deploySavings", pct(dx2.savings, 1));
def("deployRealized", pct(dx2.realizedOnOverlap ?? 0, 2));
def("deployOverlap", num(dx2.gtOverlapReused));
def("deployAuditReleased", num(dx2.auditComposition.fromReleasedVector));
def("deployAuditReleasedErr", pct(dx2.auditComposition.releasedOnlyRealized ?? 0, 2));
def("deployOracleTight", String(dx1.oracleCalls));
def("deployReusedTight", num(dx1.reused));
def("deploySavingsTight", pct(dx1.savings, 1));
const dxF2 = dx2.strata.find((s) => s.certified)!;
const dxF1 = dx1.strata.find((s) => s.certified)!;
def("deployLookLoose", String(dxF2.sampled));
def("deployFlipsLoose", String(dxF2.flips));
def("deployBoundLoose", dxF2.upperBound.toFixed(3));
def("deployLookTight", String(dxF1.sampled));
def("deployFlipsTight", String(dxF1.flips));
def("deployBoundTight", dxF1.upperBound.toFixed(3));
// The live August run under Maurer-Pontil: what was actually applied.
def("deployMpOracle", String(d2.oracleCalls));
def("deployMpReused", num(d2.reused));
def("deployMpSavings", pct(d2.savings, 1));
def("deployMpOracleTight", String(d1.oracleCalls));
def("deployMpSavingsTight", pct(d1.savings, 1));
// The applied certificate's audited error comes from the same replay and
// the same oracle set as every other Table 7 row (exp11c's eb arm walks the
// live run's path exactly), so one quantity has one value.
const dmp2 = arm(exp11c, "eb", 0.2);
def("deployMpRealized", pct(dmp2.realizedOnOverlap ?? 0, 2));
def("deployMpAuditRows", num(dmp2.gtOverlapReused));
def("deployAuditFlips", num((dx2 as unknown as { gtOverlapFlips: number }).gtOverlapFlips));
const mpF2 = (d2.strata as S11[]).find((s) => s.certified)!;
const mpF1 = (d1.strata as S11[]).find((s) => s.certified)!;
def("deployMpLookLoose", String(mpF2.sampled));
def("deployMpFlipsLoose", String(mpF2.flips));
def("deployMpLookTight", String(mpF1.sampled));
def("deployMpFlipsTight", String(mpF1.flips));
// The August evidence at alpha=0.05 stops where the stored draws stop.
{
  const a05 = exp11c.sweeps.find((s: W11c) => s.bound === "exact" && Math.abs(s.alpha - 0.05) < 1e-9) as
    | { status: string; missingFreshDraws?: number; oracleCallsRequestedSoFar?: number }
    | undefined;
  def("deployAugustFiveMissing", num(Number(a05?.missingFreshDraws ?? 0)));
  {
    // The look the August draws could not reach: the cumulative request count
    // at the failing look, which is the cached-FALSE stratum's look size
    // because that stratum is certified first. Assert the schedule shape.
    const look = Number(a05?.oracleCallsRequestedSoFar ?? 0);
    if (look <= 0 || Math.log2(look / 45) % 1 !== 0) throw new Error(`deployAugustFiveLook ${look} is not a schedule look`);
    def("deployAugustFiveLook", num(look));
  }
}
// r8/M10: the refused stratum's SIZE, which is NOT the recompute count; the
// recompute count is the size minus the cells the futility stop already spent.
const refused = (d2.strata as Array<{ certified: boolean; size: number }>).find(
  (st) => !st.certified,
)!;
def("deployTrueStratum", num(Number(refused.size)));
// r8/M10: the ceiling is a property of the COLUMN (the stratum that can never
// be certified), so it must come from that stratum's size, not from a realised
// recompute count that happens to exclude the cells futility already sampled.
def("deployCeiling", pct(1 - Number(refused.size) / exp11.n, 1));
// The September 2026 live certification (same cache, oracle inside the new
// snapshot), exact bound at the three budgets, plus MP for the comparison.
const sx2 = arm(exp11cSep, "exact", 0.2);
const sx1 = arm(exp11cSep, "exact", 0.1);
const sx05 = arm(exp11cSep, "exact", 0.05);
def(
  "sepSnapshotDate",
  new Date(String(exp11cSep.snapshot)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
);
{
  const days = Math.round(
    (Date.parse(String(exp11cSep.snapshot)) - Date.parse(String(exp11c.snapshot))) / 86400000,
  );
  def("driftDaysLater", String(days));
}
if (sx2.oracleCalls !== dx2.oracleCalls || sx2.reused !== dx2.reused) {
  throw new Error("the September loose certificate no longer matches the August replay in calls and reuse; rewrite the running example in the introduction");
}
def("sepOracleLoose", String(sx2.oracleCalls));
def("sepReusedLoose", num(sx2.reused));
def("sepSavingsLoose", pct(sx2.savings, 1));
def("sepOracleTight", String(sx1.oracleCalls));
def("sepReusedTight", num(sx1.reused));
def("sepSavingsTight", pct(sx1.savings, 1));
def("sepOracleFive", String(sx05.oracleCalls));
const sxF2 = sx2.strata.find((s) => s.certified) ?? sx2.strata[0]!;
const sxF1 = sx1.strata.find((s) => s.certified) ?? sx1.strata[0]!;
const sxF05 = sx05.strata.find((s) => s.stratumId.startsWith("v=false"))!;
const sxT = sx2.strata.find((s) => s.stratumId.startsWith("v=true"))!;
def("sepLookLoose", String(sxF2.sampled));
def("sepFlipsLoose", String(sxF2.flips));
def("sepLookTight", String(sxF1.sampled));
def("sepFlipsTight", String(sxF1.flips));
def("sepBoundTight", sxF1.upperBound.toFixed(3));
def("sepLookFive", String(sxF05.sampled));
// The abstract says the September run "certified both budgets again"; the
// deployment summary adds that the tight budget went one look deeper than on
// the August draws and that alpha=0.05 was refused. Assert each.
{
  const falseOf = (w: W11c) => w.strata.find((s) => s.stratumId.startsWith("v=false"))!;
  if (!(falseOf(sx2).certified && falseOf(sx1).certified)) {
    throw new Error("the September run no longer certifies both headline budgets; rewrite the abstract and the deployment summary");
  }
  if (falseOf(sx05).certified) {
    throw new Error("the September run certifies alpha=0.05; rewrite the deployment summary");
  }
  if (falseOf(sx1).sampled !== 2 * dxF1.sampled) {
    throw new Error("the September tight certificate is no longer one look deeper than the August replay's; rewrite the deployment summary");
  }
}
def("sepFlipsFive", String(sxF05.flips));
def("sepRateFive", pct(sxF05.flips / Math.max(1, sxF05.sampled), 1));
def("sepTrueFlips", String(sxT.flips));
def("sepTrueLook", String(sxT.sampled));
const secondsOf = (ms: number) => (ms / 1e3).toFixed(0);
// The live run's accounting survives audit replays in the artifact's liveRun
// block; a replay's own counters read zero and must not be quoted.
type LiveRun = { liveCalls: number; liveRequested: number; liveCached: number; ledgerSpendDeltaUsd: number; arms: Array<{ bound: string; alpha: number; liveDrawsThisArm: number; wallMs: number | null }> };
const sepLive = (exp11cSep as { liveRun?: LiveRun }).liveRun;
if (!sepLive || sepLive.liveCalls <= 0) throw new Error("exp11c-deployment-bounds-v4.json carries no liveRun accounting");
const sepArmWall = (b: string, a: number): number => {
  const w = sepLive.arms.find((x) => x.bound === b && Math.abs(x.alpha - a) < 1e-9)?.wallMs;
  if (w === null || w === undefined) throw new Error(`no live wall clock for ${b} alpha=${a}`);
  return w;
};
def("sepWallLoose", secondsOf(sepArmWall("exact", 0.2)));
def("sepWallTight", secondsOf(sepArmWall("exact", 0.1)));
// The tight arm ran after the loose one and drew only the cells beyond it, so
// its wall clock times those extra calls, not the arm's full call count.
{
  const drawsOf = (a: number) => sepLive.arms.find((x) => x.bound === "exact" && Math.abs(x.alpha - a) < 1e-9)?.liveDrawsThisArm ?? -1;
  if (drawsOf(0.2) !== sx2.oracleCalls || drawsOf(0.2) + drawsOf(0.1) !== sx1.oracleCalls) {
    throw new Error(`September live draws (${drawsOf(0.2)} then ${drawsOf(0.1)}) do not add up to the arms' call counts (${sx2.oracleCalls}, ${sx1.oracleCalls}); reword the wall-clock sentence`);
  }
  def("sepTightExtraDraws", num(drawsOf(0.1)));
}
def("sepLiveDraws", num(sepLive.liveCalls));
def("sepLiveRequested", num(sepLive.liveRequested));
def("sepLiveCached", num(sepLive.liveCached));
def("sepLedgerUsd", `\\$${sepLive.ledgerSpendDeltaUsd.toFixed(2)}`);
def("sepPerCell", `\\$${(sepLive.ledgerSpendDeltaUsd / sepLive.liveCalls).toPrecision(3)}`);
{
  const needed = Math.max(...(exp11cSep.sweeps as W11c[]).map((s) => s.oracleCalls));
  def("sepOracleCellsNeeded", num(needed));
  def("sepStoredBefore", num(needed - sepLive.liveRequested));
}
def("sepAuditRowsLoose", num(sx2.gtOverlapReused));
def("sepAuditRowsTight", num(sx1.gtOverlapReused));
def("sepRealizedLoose", pct(sx2.realizedOnOverlap ?? 0, 2));
def("sepRealizedTight", pct(sx1.realizedOnOverlap ?? 0, 2));
{
  const smp2 = arm(exp11cSep, "eb", 0.2);
  def("sepMpOracleLoose", num(smp2.oracleCalls));
  const smp1 = exp11cSep.sweeps.find((s: W11c) => s.bound === "eb" && Math.abs(s.alpha - 0.1) < 1e-9) as W11c;
  // Completes "the same September draws certify the loose budget after N calls and ...".
  def("sepMpTightOutcome", smp1.status === "ok" && smp1.reused > 0 ? `certify the tight budget after ${num(smp1.oracleCalls)} calls` : smp1.status === "ok" ? `are refused at the tight budget after ${num(smp1.oracleCalls)} calls` : "never reach the tight budget");
}
// The manuscript says a separate verifier recomputes the audits it prints.
// Hold it to that: every printed audit must equal what exp11b-verify.ts
// recomputed from the persisted row identifiers, without the certifier.
{
  type Verified = { source: string; bound: string; alpha: number; auditedRowsAll: number; flipsAll: number; auditedRows: number; flips: number };
  const verified = (J("exp11b-verify.json") as { audits?: Verified[] }).audits;
  if (!verified) throw new Error("exp11b-verify.json predates per-artifact audits; re-run scripts/experiments/exp11b-verify.ts");
  const check = (source: string, w: W11c, released: boolean) => {
    const v = verified.find((x) => x.source === source && x.bound === w.bound && Math.abs(x.alpha - w.alpha) < 1e-9);
    const comp = (w as unknown as { auditComposition: { fromReleasedVector: number; releasedOnlyFlips: number } }).auditComposition;
    const flips = (w as unknown as { gtOverlapFlips: number }).gtOverlapFlips;
    if (
      !v || v.auditedRowsAll !== w.gtOverlapReused || v.flipsAll !== flips ||
      (released && (v.auditedRows !== comp.fromReleasedVector || v.flips !== comp.releasedOnlyFlips))
    ) {
      throw new Error(`the verifier does not reproduce the printed audit of ${source} ${w.bound}@${w.alpha}; re-run scripts/experiments/exp11b-verify.ts`);
    }
  };
  check("exp11c-deployment-bounds.json", dx2, true);
  check("exp11c-deployment-bounds.json", dx1, false);
  check("exp11c-deployment-bounds.json", dmp2, false);
  check("exp11c-deployment-bounds.json", arm(exp11c, "eb", 0.1), false);
  check("exp11c-deployment-bounds-v4.json", sx2, false);
  check("exp11c-deployment-bounds-v4.json", sx1, false);
  check("exp11c-deployment-bounds-v4.json", arm(exp11cSep, "eb", 0.2), false);
  // The Availability section says nothing in the evaluation path is withheld.
  // The cells the audits read are released in deployment-audit-cells.json;
  // hold the release to it: every recorded audit recomputes from that file
  // and the persisted row identifiers alone, with no database.
  const reproduced = recomputeAudits(J("deployment-audit-cells.json") as AuditCells, { audits: verified }, "docs/research/experiments");
  def("auditCellRows", num((J("deployment-audit-cells.json") as AuditCells).rows.length));
  if (reproduced !== verified.length) throw new Error("deployment-audit-cells.json does not reproduce every recorded audit");
}
// Snapshot drift (exp16): the same rows under both snapshots.
{
  type Cmp = { n: number; disagreements: number; rate: number | null; wilson95: [number, number] };
  type Strat = { prefix: number; augEdit: Cmp; sepEdit: Cmp; promptDrift: Cmp; cacheDrift: Cmp; sepFresh: Cmp; augVsSepEditPaired: { onlyFirstFlips: number; onlySecondFlips: number; mcnemarP: number } };
  const st = exp16.strata as { false: Strat; true: Strat };
  const ci = (c: Cmp) => `[${(c.wilson95[0] * 100).toFixed(1)}, ${(c.wilson95[1] * 100).toFixed(1)}]`;
  for (const [tag, s] of [["False", st.false], ["True", st.true]] as const) {
    def(`drift${tag}Rows`, num(s.prefix));
    def(`drift${tag}AugEdit`, pct(s.augEdit.rate ?? 0, 1));
    def(`drift${tag}SepEdit`, pct(s.sepEdit.rate ?? 0, 1));
    def(`drift${tag}Prompt`, pct(s.promptDrift.rate ?? 0, 1));
    def(`drift${tag}PromptCi`, ci(s.promptDrift));
    if (tag === "False") {
      def(`drift${tag}Cache`, pct(s.cacheDrift.rate ?? 0, 1));
      def(`drift${tag}CacheCi`, ci(s.cacheDrift));
      def(`drift${tag}Fresh`, pct(s.sepFresh.rate ?? 0, 1));
      def(`drift${tag}FreshCi`, ci(s.sepFresh));
    }
    const p = s.augVsSepEditPaired.mcnemarP;
    def(`drift${tag}McNemarP`, p < 0.001 ? "<0.001" : p.toFixed(2));
    def(`drift${tag}OnlyAug`, String(s.augVsSepEditPaired.onlyFirstFlips));
    def(`drift${tag}OnlySep`, String(s.augVsSepEditPaired.onlySecondFlips));
  }
  def("driftLiveDraws", num(Number(exp16.liveCalls)));
}
// The snapshot moved in behavior as well as in answers: output tokens per
// cell (reasoning included) and latency of the v2 template in August
// (version 2) against its September re-issue (version 4), from the stored
// cells; dumped beside the other database-derived inputs.
const dbt = await mysql.createConnection({ uri: MYSQL_URL });
const [tokRows] = (await dbt.query(
  `SELECT c.prompt_version AS v, COUNT(*) AS n, AVG(c.output_tokens) AS out_tok, AVG(c.latency_ms) AS ms
   FROM ai_cells c JOIN ai_columns col ON col.id = c.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles'
     AND c.status = 'done' AND c.output_tokens > 0 AND c.prompt_version IN (2, 4)
   GROUP BY c.prompt_version`,
)) as unknown as [Array<{ v: number; n: number; out_tok: number; ms: number }>];
await dbt.end();
const tokAug = tokRows.find((r) => Number(r.v) === 2)!;
const tokSep = tokRows.find((r) => Number(r.v) === 4)!;
def("driftTokensAug", String(Math.round(Number(tokAug.out_tok))));
def("driftTokensSep", String(Math.round(Number(tokSep.out_tok))));
def("driftLatencyAug", (Number(tokAug.ms) / 1e3).toFixed(0));
def("driftLatencySep", (Number(tokSep.ms) / 1e3).toFixed(0));

// How many cells the certificate ACTUALLY stamped, read from the database
// rather than from the certificate's own reused_count. These differ, and the
// difference is the point: applyCertificateReuse refuses to overwrite a cell
// that already holds a freshly computed value at the target version, so the
// audited rows we had recomputed for ground truth keep their computed value
// and are not restamped. Claiming the certificate stamps every reused cell
// was false; this macro makes the real number un-driftable.
const dbs = await mysql.createConnection({ uri: MYSQL_URL });
const [[cert]] = (await dbs.query(
  `SELECT c.id, c.reused_count,
          (SELECT COUNT(*) FROM ai_cells a WHERE a.certificate_id = c.id)
            AS stamped
   FROM reuse_certificates c
   ORDER BY stamped DESC LIMIT 1`,
)) as unknown as [[{ id: string; reused_count: number; stamped: number }]];
await dbs.end();
if (Number(cert.reused_count) !== Number(d2.reused)) {
  throw new Error(
    `deployment certificate reused_count=${cert.reused_count} does not match ` +
      `exp11 alpha=0.2 reused=${d2.reused}; the applied certificate is not ` +
      `the run the paper reports`,
  );
}
// The stamp count is a fact about the apply step at the time it ran. Later
// experiments legitimately compute fresh cells on rows the certificate had
// stamped (a fresh value always wins over a reused one), so the live count
// can only fall from its value at apply time; the dump made at the first
// generation freezes it, and a live count that disagrees is reported, not
// silently substituted.
const priorDump = existsSync("docs/research/experiments/db-derived-inputs.json")
  ? (J("db-derived-inputs.json") as { deploymentCertificate?: { id: string; stampedCells: number } })
  : null;
const stampedAtApply =
  priorDump?.deploymentCertificate?.id === cert.id
    ? Number(priorDump.deploymentCertificate.stampedCells)
    : Number(cert.stamped);
if (stampedAtApply !== Number(cert.stamped)) {
  console.log(`NOTE: certificate ${cert.id} stamped ${stampedAtApply} cells at apply time; ${cert.stamped} remain stamped now`);
}
def("deployStamped", num(stampedAtApply));
def("deployUnstamped", num(Number(cert.reused_count) - stampedAtApply));

// Deployment economics from the LEDGER (single source of truth for money):
// the per-cell rate measured on this column, applied to the full-corpus
// materialization and to the certified-maintenance workload.
const dbc = await mysql.createConnection({ uri: MYSQL_URL });
// The materialization is ONE ledger entry: the single largest run on this
// column. Summing the column's lifetime would fold the certification
// passes' own oracle calls into the baseline they are compared against
// (review r6, M2).
const [[colLed]] = (await dbc.query(
  `SELECT l.cost_usd AS s, l.cells AS c
   FROM cost_ledger l JOIN ai_columns col ON col.id = l.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles'
   ORDER BY l.cells DESC LIMIT 1`,
)) as unknown as [[{ s: number; c: number }]];
await dbc.end();
const perCell = Number(colLed.s) / Number(colLed.c);
def("perCellCost", `\\$${perCell.toPrecision(3)}`);
def("deployMatCost", `\\$${Number(colLed.s).toFixed(2)}`);
def("deployMatCells", num(Number(colLed.c)));
// Corpus size comes from the artifact, never a literal: a hardcoded 89184
// here would survive the checker (which only scans string literals) and
// silently disagree with \deployN if the corpus were ever re-cut.
def("deployFreeRows", num(Number(exp11.n) - Number(colLed.c)));
// Wall-clock from STORED per-cell latencies at the run's concurrency,
// not from a remembered stopwatch.
const dbl = await mysql.createConnection({ uri: MYSQL_URL });
const [[lat]] = (await dbl.query(
  `SELECT COALESCE(SUM(latency_ms),0) AS ms, COUNT(*) AS c
   FROM ai_cells c JOIN ai_columns col ON col.id = c.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles'
     AND c.prompt_version = 1 AND c.latency_ms IS NOT NULL`,
)) as unknown as [[{ ms: number; c: number }]];
await dbl.end();
const CONC = 32;
// The run's MEASURED wall clock: from its first cell write to its last. Its
// cells are the version-1 cells written after the column's previous ledger
// entry and no later than its own; the computed ones among them must be
// exactly the cells the ledger billed, or the window is not the run.
const dbSpan = await mysql.createConnection({ uri: MYSQL_URL });
const [[matRun]] = (await dbSpan.query(
  `SELECT l.at, l.cells, l.column_id FROM cost_ledger l JOIN ai_columns col ON col.id = l.column_id
   WHERE col.name LIKE '%(lab)%' AND col.table_id = 'profiles' ORDER BY l.cells DESC LIMIT 1`,
)) as unknown as [[{ at: Date; cells: number; column_id: string }]];
const [[matPrev]] = (await dbSpan.query(
  `SELECT MAX(l.at) AS at FROM cost_ledger l WHERE l.column_id = ? AND l.at < ?`,
  [matRun.column_id, matRun.at],
)) as unknown as [[{ at: Date }]];
const [[matSpan]] = (await dbSpan.query(
  `SELECT MIN(c.updated_at) AS first, MAX(c.updated_at) AS last, COUNT(*) AS n, SUM(c.status = 'done') AS computed
   FROM ai_cells c WHERE c.column_id = ? AND c.prompt_version = 1 AND c.updated_at > ? AND c.updated_at <= ?`,
  [matRun.column_id, matPrev.at, matRun.at],
)) as unknown as [[{ first: Date; last: Date; n: number; computed: number }]];
await dbSpan.end();
if (Number(matSpan.computed) !== Number(colLed.c)) {
  throw new Error(`the materialization window holds ${matSpan.computed} computed cells, the ledger billed ${colLed.c}; the measured wall clock would not be the run's`);
}
const matSpanHours = (new Date(matSpan.last).getTime() - new Date(matSpan.first).getTime()) / 3.6e6;
def("deployMatSpanHours", matSpanHours.toFixed(1));
const matHours = Number(lat.ms) / CONC / 3600000;
// The prose says the latency estimate agrees with the measured span.
if (Math.abs(matHours - matSpanHours) > 0.1 * matSpanHours) {
  throw new Error("the latency estimate of the materialization wall clock no longer agrees with the measured span; rewrite the sentence in body.tex");
}
def("deployMatHours", matHours.toFixed(1));
def("deployConcurrency", String(CONC));
def("deployMatMeanLatencyS", (Number(lat.ms) / Number(lat.c) / 1e3).toFixed(1));
def("deployMatLatencyCells", num(Number(lat.c)));
const maintCells = dx2.oracleCalls + dx2.recompute;
def("deployMaintCells", num(maintCells));
def("deployMaintCost", `\\$${(maintCells * perCell).toFixed(2)}`);
def(
  "deployMaintMinutes",
  String(Math.round((maintCells / Number(lat.c)) * matHours * 60)),
);

// exp6 cross-corpus
const dj = exp6.results;

// exp2 corroboration

// exp13: SUPG-style head-to-head at identical oracle budgets.
const exp13 = J("exp13-supg.json");
const h2h = (exp13.results as Array<{
  pair: string;
  sweeps: Array<{
    alpha: number;
    sivm: { oracle: number; reused: number; realizedPresented: number | null };
    supg: {
      reused: number;
      realizedAmongReused: number | null;
      reusedTrueSubgroup: number;
      realizedTrueSubgroup: number | null;
    };
  }>;
}>).find((r) => r.pair === "so-formatting")!.sweeps.find((x) => x.alpha === 0.2)!;
type H2H = {
  sivm: { oracle: number; reused: number; realizedAmongReused: number | null };
  supgValueProxy: {
    reused: number;
    realizedAmongReused: number | null;
    reusedTrueSubgroup: number;
  };
  supg: { reused: number };
};
const hh = h2h as unknown as H2H;
def("hhBudget", String(hh.sivm.oracle));
def("hhSivmReused", num(hh.sivm.reused));
def("hhSivmErr", pct(hh.sivm.realizedAmongReused ?? 0, 2));
def("hhSupgReused", num(hh.supgValueProxy.reused));
def("hhSupgErr", pct(hh.supgValueProxy.realizedAmongReused ?? 0, 2));
def("hhSupgTrueRows", String(hh.supgValueProxy.reusedTrueSubgroup));
const mult = (h2h as unknown as {
  multiplicity: { sivmPerTestDelta: number; valueArmPerTestDelta: number };
}).multiplicity;
def("hhSivmPerTest", `\\delta/${Math.round(0.1 / mult.sivmPerTestDelta)}`);
def("hhValuePerTest", `\\delta/${Math.round(0.1 / mult.valueArmPerTestDelta)}`);
const hhW = (exp13.results as Array<{
  pair: string;
  sweeps: Array<{
    alpha: number;
    sivm: { reused: number; realizedAmongReused: number | null };
    supgValueProxy: { reused: number; realizedAmongReused: number | null; reusedTrueSubgroup: number };
  }>;
}>).find((r) => r.pair === "so-widening")!.sweeps.find((x) => x.alpha === 0.2)!;
def("hhSivmErrW", pct(hhW.sivm.realizedAmongReused ?? 0, 2));
def("hhSupgErrW", pct(hhW.supgValueProxy.realizedAmongReused ?? 0, 2));
def("hhSupgTrueRowsW", String(hhW.supgValueProxy.reusedTrueSubgroup));
def("hhSivmReusedW", num(hhW.sivm.reused));
def("hhSupgReusedW", num(hhW.supgValueProxy.reused));
// Reused counts as fractions of the evaluation vector, for the policy table
// (Table 2), whose other rows are fractions; n comes from the same exp13
// records the counts do.
{
  const nF = (exp13.results as Array<{ pair: string; n: number }>).find((r) => r.pair === "so-formatting")!.n;
  const nW = (exp13.results as Array<{ pair: string; n: number }>).find((r) => r.pair === "so-widening")!.n;
  def("hhSivmReusedFrac", pct(hh.sivm.reused / nF, 1));
  def("hhSupgReusedFrac", pct(hh.supgValueProxy.reused / nF, 1));
  def("hhSivmReusedFracW", pct(hhW.sivm.reused / nW, 1));
  def("hhSupgReusedFracW", pct(hhW.supgValueProxy.reused / nW, 1));
}
// r8/M8: the matched competitor selects essentially every row it is allowed
// to, so it is the guarantee-free baseline wearing a certificate. Reporting
// "wins on volume" without this fraction reads as a tuning outcome rather
// than the degenerate one it is.
const e13 = exp13.results as Array<{
  pair: string;
  n: number;
  sweeps: Array<{
    alpha: number;
    sivm: { oracle: number };
    supgValueProxy: { reused: number };
  }>;
}>;
const selFrac = (pair: string) => {
  const r = e13.find((x) => x.pair === pair)!;
  const sw = r.sweeps.find((x) => x.alpha === 0.2)!;
  return pct(sw.supgValueProxy.reused / (r.n - sw.sivm.oracle), 1);
};
def("hhSupgSelFrac", selFrac("so-formatting"));
def("hhSupgSelFracW", selFrac("so-widening"));
// The competitor run with the embedding-interaction proxy instead of the
// cached value. Under the earlier bound this arm found no threshold in any
// cell and the prose said so; under the exact bound it certifies in most of
// them. State what the artifact holds, and stop if the stated relation (the
// arm's reuse draws on cached-TRUE cells whose error exceeds the budget)
// stops being true.
{
  type Emb = { reused: number; realizedAmongReused: number | null; thresholdFound: boolean; reusedTrueSubgroup: number; realizedTrueSubgroup: number | null };
  const cells = (exp13.results as Array<{ pair: string; sweeps: Array<{ alpha: number; supg: Emb }> }>).flatMap((r) =>
    r.sweeps.map((w) => ({ pair: r.pair, alpha: w.alpha, e: w.supg })),
  );
  const certifying = cells.filter((c) => c.e.thresholdFound && c.e.reused > 0);
  if (certifying.length === 0) throw new Error("exp13: the embedding-proxy arm certifies nothing; restore the earlier caveat in body.tex");
  for (const c of certifying) {
    if (!(c.e.reusedTrueSubgroup > 0 && (c.e.realizedTrueSubgroup ?? 0) > c.alpha)) {
      throw new Error(`exp13: the embedding-proxy arm at ${c.pair} alpha=${c.alpha} no longer reuses cached-TRUE cells above the budget; rewrite the caveat in body.tex`);
    }
  }
  // The second caveat says the embedding arm is tested at a stricter level
  // than sIVM and still reuses more at the loose budget.
  for (const r of exp13.results as Array<{ pair: string; sweeps: Array<{ alpha: number; multiplicity: { sivmPerTestDelta: number; embeddingArmPerTestDelta: number }; sivm: { reused: number }; supg: Emb }> }>) {
    const w = r.sweeps.find((x) => Math.abs(x.alpha - 0.2) < 1e-9)!;
    if (!(w.multiplicity.embeddingArmPerTestDelta < w.multiplicity.sivmPerTestDelta && w.supg.reused > w.sivm.reused)) {
      throw new Error(`exp13 ${r.pair}: the embedding arm no longer reuses more than sIVM at a stricter per-test level; rewrite the second caveat in body.tex`);
    }
  }
  def("hhEmbCertCells", String(certifying.length));
  def("hhEmbCells", String(cells.length));
  const at = (pair: string) => cells.find((c) => c.pair === pair && Math.abs(c.alpha - 0.2) < 1e-9)!.e;
  const f = at("so-formatting");
  const w = at("so-widening");
  def("hhEmbReused", num(f.reused));
  def("hhEmbErr", pct(f.realizedAmongReused ?? 0, 2));
  def("hhEmbTrueRows", String(f.reusedTrueSubgroup));
  def("hhEmbTrueErr", pct(f.realizedTrueSubgroup ?? 0, 1));
  def("hhEmbReusedW", num(w.reused));
  def("hhEmbErrW", pct(w.realizedAmongReused ?? 0, 2));
  def("hhEmbTrueRowsW", String(w.reusedTrueSubgroup));
  def("hhEmbTrueErrW", pct(w.realizedTrueSubgroup ?? 0, 1));
}

// The August MP certificates' evidence re-evaluated under the other bounds
// at the pinned per-look level: the reviewer's re-derivation (5 flips in
// 180 under Bardenet-Maillard reads above 0.2) and what the exact bound
// reads on the same evidence. No new oracle calls.
{
  const flipsVec = (st: S11) => Array.from({ length: st.sampled }, (_, i) => (i < st.flips ? 1 : 0));
  for (const [tag, st, alpha] of [["Loose", mpF2, 0.2], ["Tight", mpF1, 0.1]] as const) {
    const wor = worUpperBound(flipsVec(st), PINNED_PER_LOOK, st.size);
    const ex = exactUpperBound(st.flips, st.sampled, st.size, PINNED_PER_LOOK);
    def(`deployWor${tag}`, wor.toFixed(3));
    def(`deployWor${tag}Clears`, wor <= alpha ? "clears" : "does not clear");
    def(`deployExact${tag}`, ex.toFixed(3));
    def(`deployExact${tag}Clears`, ex <= alpha ? "clears" : "does not clear");
  }
  def("deployFalseStratum", num(mpF2.size));
  // What a budget tolerates in that stratum, in cells: the largest realized
  // flip count a certificate at alpha allows (floor of alpha times the size).
  // The limitations paragraph sets the loose one beside the size of the
  // cached-TRUE class, and says "about twice"; stop if that stops holding.
  const tolerated = (alpha: number) => Math.floor(alpha * mpF2.size + 1e-9);
  def("budgetCellsLoose", num(tolerated(0.2)));
  const positives = Number(refused.size);
  if (!(tolerated(0.2) / positives > 1.6 && tolerated(0.2) / positives < 2.5 && tolerated(0.1) > positives)) {
    throw new Error("the tolerated-cells sentence of the limitations paragraph no longer matches the strata sizes; rewrite it in body.tex");
  }
}

// exp12: the gpt-5-nano probe of an earlier draft (formatting pair, n=500).
// If the family was later run at full size on both lab pairs, that artifact
// promotes it to a full row of the family table and the probe row is dropped;
// the probe macros are then not defined, so any prose still citing them fails
// the orphan guard's mirror image (an undefined macro) at compile time.
const exp12 = J("exp12-secondmodel.json");
const NANO_FULL = "exp12-secondmodel-openai-gpt-5-nano.json";
const nanoPromoted = existsSync(`docs/research/experiments/${NANO_FULL}`);
// The sixth family of the revision (google/gemini-3.8-flash) joins the table
// the same way, once its lab-pair artifact exists.
const GEMINI38_FULL = "exp12-secondmodel-google-gemini-3.8-flash.json";
const gemini38Present = existsSync(`docs/research/experiments/${GEMINI38_FULL}`);
if (!nanoPromoted) {
  def("altModelName", String(exp12.model).replace(/_/g, "\\_"));
  def("altModelFloor", pct(exp12.selfFlipFloor, 1));
  def("altModelEditFlip", pct(exp12.formattingEditFlip, 1));
  def("altModelN", num(exp12.n));
}

// The zero-flip minimum sample under the pinned procedure: the smallest n at
// which a clean sample clears alpha at the per-look level, for the exact
// bound in a large stratum (its binomial limit, (1-alpha)^n <= delta') and
// for the Maurer-Pontil bound the first submission used.
{
  const alphaRef = 0.05;
  let nExact = 1;
  while (binomialUpperBound(0, nExact, PINNED_PER_LOOK) > alphaRef) nExact++;
  const nEb = Math.ceil((7 * Math.log(2 / PINNED_PER_LOOK)) / (3 * alphaRef)) + 1;
  def("minZeroFlipSample", `$n^{*}{=}${nExact}$`);
  def("minZeroFlipSampleEb", String(nEb));
}

// Corpus + scope constants (so no size is typed in prose)
// r8/M9: these were literals, invisible to the hardcode check the paper
// cites. Corpus sizes come from the tables themselves; the labelled-cell
// count is summed from the label artifacts rather than rounded by hand.
const dbn = await mysql.createConnection({ uri: MYSQL_URL });
const [[cnt]] = (await dbn.query(
  `SELECT (SELECT COUNT(*) FROM profiles) AS so,
          (SELECT COUNT(*) FROM djinni_profiles) AS dj`,
)) as unknown as [[{ so: number; dj: number }]];
await dbn.end();
if (Number(cnt.so) !== Number(exp11.n)) {
  throw new Error(
    `profiles table has ${cnt.so} rows but exp11 ran on ${exp11.n}`,
  );
}
def("corpusSO", num(Number(cnt.so)));
def("corpusDjinni", num(Number(cnt.dj)));
// Ground-truth labels: one oracle cell per row per version for each edit
// pair, plus the multi-draw relabelling study's own draws.
const editPairs = new Map(
  (exp8.results as Array<{ pair: string; estimand: string; n: number }>)
    .filter((r) => r.estimand === "presented")
    .map((r) => [r.pair, r.n]),
);
const editLabels = (() => {
  // Distinct (column, version) cells: the lab columns' middle version is
  // shared by two pairs and must be counted once.
  const seen = new Set<string>();
  let total = 0;
  for (const p of PAIRS) {
    const n = editPairs.get(p.key) ?? 0;
    for (const v of [p.fromV, p.toV]) {
      const id = `${p.corpus}|${p.columnMatch.toString()}|${v}`;
      if (!seen.has(id)) {
        seen.add(id);
        total += n;
      }
    }
  }
  return total;
})();
const drawLabels = Object.values(
  rawLabels as Record<string, { d1: unknown[]; d2: unknown[] }>,
).reduce((a, r) => a + r.d1.length + r.d2.length, 0);
def("labeledCells", num(editLabels + drawLabels));
def("editLabelCells", num(editLabels));
def("drawLabelCells", num(drawLabels));
const dbw = await mysql.createConnection({ uri: MYSQL_URL });
const [[wt]] = (await dbw.query(
  `SELECT
     SUM(CAST(a.value AS CHAR) <> CAST(b.value AS CHAR)) AS flips,
     COUNT(*) AS n
   FROM ai_cells a
   JOIN ai_cells b ON b.column_id = a.column_id AND b.row_id = a.row_id
                  AND b.prompt_version = 2
   JOIN ai_columns col ON col.id = a.column_id
   WHERE col.name = 'Data-platform specialist?' AND a.prompt_version = 1
     AND a.status IN ('done','cached') AND b.status IN ('done','cached')
     AND CAST(a.value AS CHAR) = 'true'`,
)) as unknown as [[{ flips: number; n: number }]];
await dbw.end();
const wk = Number(wt.flips);
const wn = Math.max(1, Number(wt.n));
const wilsonCi = (k: number, n: number) => {
  const z = 1.96, pp = k / n, d = 1 + (z * z) / n;
  const c = pp + (z * z) / (2 * n);
  const h = z * Math.sqrt((pp * (1 - pp)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d] as const;
};
const [wlo, whi] = wilsonCi(wk, wn);
def("wideningTrueFlip", pct(wk / wn, 1));
def("wideningTrueCi", `[${(wlo * 100).toFixed(1)}, ${(whi * 100).toFixed(1)}]`);
def("wideningTrueN", num(wn));

// Ledger (single source of truth for spend)
const db = await mysql.createConnection({ uri: MYSQL_URL });
const [[led]] = (await db.query(
  `SELECT COALESCE(SUM(cost_usd),0) AS s, COALESCE(SUM(cells),0) AS c FROM cost_ledger`,
)) as unknown as [[{ s: number; c: number }]];
// The main program's window: ledger rows before the September snapshot
// (the re-certification and its checks are ledgered too, and dated
// separately by \sepSnapshotDate).
const [[ledgerWindow]] = (await db.query(
  `SELECT DATE_FORMAT(MIN(at), '%e %M %Y') AS s, DATE_FORMAT(MAX(at), '%e %M %Y') AS e
   FROM cost_ledger WHERE at < ?`,
  [String(exp11cSep.snapshot)],
)) as unknown as [[{ s: string; e: string }]];
await db.end();
// The bound ablation (exp14): five bounds swapped inside the same pinned
// procedure over the same stored labels. The exact finite-population bound
// is the pinned certifier from the IEEE Access resubmission on; Maurer-
// Pontil ("eb") is what the first submission certified with; Bardenet-
// Maillard ("wor") is the proven empirical-Bernstein alternative a reviewer
// asked for; Clopper-Pearson ("cp") the exact bound another reviewer named;
// the betting sequence is the anytime-valid arm.
{
  type Sum = { configurationsCertifying: number; totalConfigurations: number; meanSavings: number; totalOracle: number };
  const sum = exp14.summaryByBound as Record<string, Sum>;
  const TAG: Record<string, string> = { exact: "Exact", eb: "Eb", wor: "Wor", cp: "Cp", betting: "Bet" };
  def("boundConfigsTotal", String(sum.exact!.totalConfigurations));
  for (const [b, tag] of Object.entries(TAG)) {
    def(`bound${tag}Configs`, String(sum[b]!.configurationsCertifying));
    def(`bound${tag}Savings`, pct(sum[b]!.meanSavings, 1));
    def(`bound${tag}Oracle`, num(sum[b]!.totalOracle));
  }
  const at90 = exp14.cleanSampleAtN90 as Record<string, number>;
  def("boundExactAtNLarge", exactUpperBound(0, 90, mpF2.size, PINNED_PER_LOOK).toFixed(3));
  def("boundExactAtNStratum", num(Number((exp14.cleanSampleAtN90 as { N: number }).N)));
  const atDeploy = exp14.deploymentEvidence as Record<string, number>;
  for (const [b, tag] of Object.entries(TAG)) {
    // The section on the bound quotes the clean-sample reading of three
    // bounds; the table prints all five.
    if (["exact", "eb", "wor"].includes(b)) def(`bound${tag}AtN`, at90[b]!.toFixed(3));
  }
  // Pairwise: how each alternative relates to the exact bound per (pair, alpha).
  type R14 = { bound: string; pair: string; alpha: number; oracle: number; certifiedStrata: string[]; savings: number };
  const rows14 = exp14.results as R14[];
  const key = (r: R14) => `${r.pair}@${r.alpha}`;
  const exactBy = new Map(rows14.filter((r) => r.bound === "exact").map((r) => [key(r), r]));
  for (const [b, tag] of Object.entries(TAG)) {
    if (b === "exact") continue;
    let same = 0, earlier = 0, later = 0, lost = 0, extra = 0;
    for (const o of rows14.filter((r) => r.bound === b)) {
      const e = exactBy.get(key(o))!;
      const ec = e.certifiedStrata.length > 0;
      const oc = o.certifiedStrata.length > 0;
      if (ec && !oc) lost++; // the alternative loses a certificate the exact bound issues
      else if (!ec && oc) extra++;
      else if (ec && oc) {
        if (o.oracle === e.oracle) same++;
        else if (o.oracle < e.oracle) earlier++;
        else later++;
      }
    }
    def(`bound${tag}SameLook`, String(same));
    def(`bound${tag}Earlier`, String(earlier));
    def(`bound${tag}Later`, String(later));
    def(`bound${tag}Lost`, String(lost));
    def(`bound${tag}Extra`, String(extra));
  }
  // The widest single gain of the exact bound over Maurer-Pontil, named in prose.
  {
    let best: { e: R14; m: R14 } | null = null;
    for (const e of rows14.filter((r) => r.bound === "exact")) {
      const m = rows14.find((r) => r.bound === "eb" && key(r) === key(e))!;
      if (!best || e.savings - m.savings > best.e.savings - best.m.savings) best = { e, m };
    }
    def("boundGapPair", LABELS[best!.e.pair] ?? best!.e.pair);
    def("boundGapAlpha", best!.e.alpha.toString());
    def("boundGapEbSavings", pct(best!.m.savings, 1));
    def("boundGapExactSavings", pct(best!.e.savings, 1));
    def("boundGapEbOracle", num(best!.m.oracle));
    def("boundGapExactOracle", num(best!.e.oracle));
  }
  // Where the betting sequence beats the exact bound (it spends no Bonferroni
  // split), and by how much at most.
  {
    let best: { e: R14; b: R14 } | null = null;
    for (const b of rows14.filter((r) => r.bound === "betting")) {
      const e = exactBy.get(key(b))!;
      if (!best || b.savings - e.savings > best.b.savings - best.e.savings) best = { e, b };
    }
    def("boundBetOverExactPair", LABELS[best!.b.pair] ?? best!.b.pair);
    def("boundBetOverExactAlpha", best!.b.alpha.toString());
    def("boundBetOverExactSavings", pct(best!.b.savings, 1));
    def("boundBetOverExactExactSavings", pct(best!.e.savings, 1));
    // Configuration by configuration: the prose says where the sequence
    // beats the exact bound, where it loses, and that it matches elsewhere.
    const gaps = rows14.filter((r) => r.bound === "betting").map((b) => b.savings - exactBy.get(key(b))!.savings);
    def("boundBetBetter", String(gaps.filter((g) => g > 1e-12).length));
    def("boundBetWorse", String(gaps.filter((g) => g < -1e-12).length));
    if (!(gaps.filter((g) => Math.abs(g) <= 1e-12).length > gaps.length / 2)) {
      throw new Error("the betting sequence no longer matches the exact bound on most configurations; rewrite the sentence in body.tex");
    }
  }
  // Null calibration per bound (exp15): the worst certification rate at a
  // planted null, whether any null's interval sits above delta, and the
  // draws a clean stratum costs.
  const cal = exp15.summary as Record<
    string,
    { worstNullCertificationRate: number; nullsExceedingDelta: number; nullConfigurations: number; avgSampledAtCleanBig: number }
  >;
  const betCfgs = (exp15.results as Array<{ bound: string }>).filter((r) => r.bound === "betting").length;
  def("boundCalTrials", num(Number(exp15.trials) * betCfgs));
  def("boundNullConfigs", String(cal.betting!.nullConfigurations));
  type R15 = { bound: string; isNull: boolean; alpha: number; size: number; p: number; certificationRate: number; violationRate: number; unsafeRateTheorem?: number };
  const nullUnsafe = (b: string) => {
    const rs = (exp15.results as R15[]).filter((r) => r.bound === b && r.isNull);
    return rs.reduce((a, r) => Math.max(a, r.unsafeRateTheorem ?? r.certificationRate * r.violationRate), 0);
  };
  const nullTrials = (exp15.results as R15[]).filter((r) => r.bound === "exact" && r.isNull).length * Number(exp15.trials);
  def("boundNullTrials", num(nullTrials));
  def("boundCleanStratum", num(Math.max(...(exp15.results as Array<{ size: number }>).map((r) => r.size))));
  def("boundNullDeltaS", pct(Number(exp15.perStratumDelta), 0));
  for (const [b, tag] of Object.entries(TAG)) {
    if (!cal[b]) continue;
    def(`bound${tag}NullWorst`, pctCeil(cal[b]!.worstNullCertificationRate, 1));
    if (b === "exact") def(`bound${tag}NullsOver`, String(cal[b]!.nullsExceedingDelta));
    def(`bound${tag}CleanSample`, String(Math.round(cal[b]!.avgSampledAtCleanBig)));
    // Theorem 1's event at planted nulls: certified AND realized count > alpha n.
    def(`bound${tag}NullUnsafe`, pctCeil(nullUnsafe(b), 2));
  }
  // The configuration behind the exact bound's worst unsafe rate.
  {
    const rs = (exp15.results as R15[]).filter((r) => r.bound === "exact" && r.isNull);
    const w = rs.reduce((a, r) => ((r.unsafeRateTheorem ?? 0) > (a.unsafeRateTheorem ?? 0) ? r : a));
    def("boundExactNullUnsafeAlpha", String(w.alpha));
    def("boundExactNullUnsafeP", String(w.p));
    def("boundExactNullUnsafeSize", num(w.size));
    const [lo, hi] = wilsonInterval(Math.round((w.unsafeRateTheorem ?? 0) * Number(exp15.trials)), Number(exp15.trials));
    def("boundExactNullUnsafeCi", `[${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]\\%`);
  }
  // Generated bound-comparison table (Section: the bound is the binding constraint).
  const row = (b: string, label: string) =>
    `${label} & ${at90[b]!.toFixed(3)} & ${typeof atDeploy[b] === "number" ? atDeploy[b]!.toFixed(3) : "--"} & ${sum[b]!.configurationsCertifying} & ${pct(sum[b]!.meanSavings, 1)} & ${num(sum[b]!.totalOracle)} & ${cal[b] ? pct(nullUnsafe(b), 2) : "--"} \\\\`;
  writeFileSync(
    "paper/tablebounds.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp14-bounds.json
% and exp15-betting-calibration.json. Do not edit by hand.
\\begin{tabular}{@{}lrrrrrr@{}}
\\toprule
 & \\multicolumn{2}{c}{upper bound on} & \\multicolumn{3}{c}{Table~\\ref{tab:main} grid (${sum.exact!.totalConfigurations} configurations)} & unsafe at nulls \\\\
\\cmidrule(lr){2-3}\\cmidrule(lr){4-6}
Bound & $0/90$, $N{=}1{,}800$ & $5/180$, $N{=}81{,}469$ & certifying & mean savings & oracle calls & worst \\\\
\\midrule
${row("exact", "Exact finite-population (pinned)")}
${row("cp", "Clopper--Pearson (binomial)")}
${row("betting", "Betting confidence sequence")}
${row("eb", "Maurer--Pontil")}
${row("wor", "Bardenet--Maillard (WoR)")}
\\bottomrule
\\multicolumn{7}{@{}p{\\linewidth}@{}}{\\footnotesize The betting sequence has no $5/180$ entry because its bound is a function of the whole draw sequence, not of $(k, n)$ alone.}
\\end{tabular}
`,
  );
}
def("totalSpend", `\\$${Number(led.s).toFixed(2)}`);
{
  def("ledgerStart", ledgerWindow.s);
  def("ledgerEnd", ledgerWindow.e);
  // Off-ledger family runs: date range from the artifacts' own ranAt stamps
  // (the lab-pair runs, the gpt-5-nano completion if present, and the
  // remaining-pair runs if present).
  const fmtDate = fmtRunDate;
  const stamps = [
    ...FAMILY_FILES.map((f) => String((J(f) as { ranAt: string }).ranAt)),
    ...exp18Files.map((f) => String((J(f) as { ranAt: string }).ranAt)),
  ].sort();
  const first = fmtDate(stamps[0]!);
  const last = fmtDate(stamps[stamps.length - 1]!);
  def("famRunDate", first === last ? `on ${first}` : `from ${first} to ${last}`);
}
def("totalCells", num(Number(led.c)));
// r8/M9: the ledger only sees cells written through the column runner. The
// probe scripts call the model directly, so the ledgered figure is a lower
// bound and the off-ledger volume must be stated, not silently folded in.
const offLedgerCells =
  Object.values(
    rawLabels as Record<string, { d1: unknown[]; d2: unknown[] }>,
  ).reduce((a, r) => a + r.d1.length + r.d2.length, 0) +
  Number(exp12.n) * 3 +
  // Model-family runs (IEEE Access revision): 3 draws for floor+formatting,
  // +1 for the synonym pair, +2 for the decomposition where run.
    [...FAMILY_FILES, ...(nanoPromoted ? [NANO_FULL] : []), ...(gemini38Present ? [GEMINI38_FULL] : [])].reduce((acc, f) => {
    const d = J(f) as { draws: Array<Record<string, unknown>> };
    return acc + d.draws.reduce((a, r) =>
      a + ["a1", "b1", "a2", "a3", "a4", "a5"].filter((k) => r[k] !== undefined && r[k] !== null).length, 0);
  }, 0) +
  // exp0 drew every row twice under each of its regimes.
  Number(exp0.n) * 2 * Object.keys(exp0.regimes).length +
  Number(exp0b.n) * 2 +
  Number(exp4.validPairs) * 6 +
  // Independence check (two arms, direct calls) and the remaining-pair
  // family runs, both off the ledger.
  (exp17 ? Number(exp17.n) * 2 : 0) +
  (exp17ext ? Number(exp17ext.n) : 0) +
    // The pilot's draws count once the pilot ships (its labels applied), and
  // only the draws that returned a phrase.
  (exp19 && pilotReady ? Object.values(exp19.draws).reduce((a, arr) => a + arr.filter((x) => x !== null).length, 0) : 0) +
  exp18Files.reduce((acc, f) => {
    const d = J(f) as { draws: Array<Record<string, unknown>> };
    return acc + d.draws.reduce((a, r) => a + ["a1", "b1", "a2", "a3"].filter((k) => r[k] !== undefined && r[k] !== null).length, 0);
  }, 0);
def("offLedgerCells", num(offLedgerCells));

// r8/M12: several load-bearing macros (the per-stratum floors, the ledger
// economics, the materialization wall clock, the certificate stamp counts,
// the widening-TRUE figures) are computed from LIVE MySQL, so a third party
// holding only docs/research/experiments/ cannot regenerate them. Dump every
// database-derived input beside the other artifacts so the release is
// self-contained and any of these numbers can be recomputed without the
// database.
writeFileSync(
  "docs/research/experiments/db-derived-inputs.json",
  JSON.stringify(
    {
      note: "every value gen-paper-assets.ts reads from MySQL, dumped so the paper's DB-derived macros can be recomputed from the release alone",
      corpusCounts: { profiles: Number(cnt.so), djinni: Number(cnt.dj) },
      storedV1Cells: (storedRows as Array<{ row_id: string; value: unknown }>)
        .map((r) => ({ row_id: r.row_id, value: r.value })),
      materializationLedgerRun: { costUsd: Number(colLed.s), cells: Number(colLed.c) },
      ledgerTotal: { costUsd: Number(led.s), cells: Number(led.c), window: ledgerWindow },
      materializationLatency: { sumMs: Number(lat.ms), cells: Number(lat.c) },
      materializationSpan: { firstCellWrite: new Date(matSpan.first).toISOString(), lastCellWrite: new Date(matSpan.last).toISOString(), cellsWritten: Number(matSpan.n), computed: Number(matSpan.computed) },
      deploymentCertificate: {
        id: cert.id,
        reusedCount: Number(cert.reused_count),
        stampedCells: stampedAtApply,
        stampedCellsNow: Number(cert.stamped),
      },
      wideningTrue: wt,
      evalVectorV2WriteDays,
      snapshotTokens: tokRows.map((r) => ({ version: Number(r.v), cells: Number(r.n), avgOutputTokens: Number(r.out_tok), avgLatencyMs: Number(r.ms) })),
    },
  ),
);

// r9-verify: four separate prose sentences asserted two flip rates came from
// the same column when they did not. Emit the pair-to-column mapping beside
// the macros so check-paper-numbers.ts can verify a "same column" claim
// instead of the author re-deriving it by hand.
const FLIP_MACRO_OF: Record<string, string> = {
  "so-formatting": "flipSoFormatting",
  "so-synonym": "flipSoSynonym",
  "so-widening": "flipSoWidening",
  "dj-formatting": "flipDjFormatting",
  "dj-criteria": "flipDjCriteria",
};
writeFileSync(
  "paper/macro-provenance.json",
  JSON.stringify(
    {
      note: "which materialized column and corpus each flip-rate macro is measured on; consumed by scripts/check-paper-numbers.ts",
      macros: Object.fromEntries(
        PAIRS.map((p) => [
          FLIP_MACRO_OF[p.key]!,
          {
            pair: p.key,
            corpus: p.corpus,
            column: p.column,
            columnType: p.columnType,
            versions: `v${p.fromV}->v${p.toV}`,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------
// Model families (IEEE Access revision): exp12 rerun on further families,
// positive direction. One row per family in paper/tablefam.tex; per-family
// macros for the prose. Every artifact must exist: a missing family is a
// release defect, not something to paper over with a smaller table.
// ---------------------------------------------------------------------------
interface Exp12 {
  model: string;
  n: number;
  selfFlipFloor: number;
  formattingEditFlip: number;
  sweeps: Array<{ alpha: number; certifiedStrata: string[]; sampled: number; reused: number; realizedPresented: number | null; savings: number }>;
  synonym?: { usableEdit: number; synonymEditFlip: number; sweeps: Exp12["sweeps"] };
  decomposition?: {
    caseOnly: { flip: number | null; sweeps: Exp12["sweeps"] };
    whitespaceOnly: { flip: number | null; sweeps: Exp12["sweeps"] };
  };
  draws?: Array<{ a1: boolean | null; b1: boolean | null; a2: boolean | null; a3?: boolean | null }>;
}
// anatomy: emit per-stratum flip and direction macros (the prose discusses
// the flip anatomy of the two families whose formatting edit is not benign).
const FAMILIES: Array<{ key: string; file: string; label: string; anatomy: boolean }> = [
  { key: "Gemini", file: FAMILY_FILES[0]!, label: "Gemini 2.5 Flash-Lite", anatomy: true },
  { key: "GeminiThree", file: FAMILY_FILES[1]!, label: "Gemini 3 Flash", anatomy: false },
  { key: "Glm", file: FAMILY_FILES[2]!, label: "GLM-4.7-Flash", anatomy: true },
  { key: "Qwen", file: FAMILY_FILES[3]!, label: "Qwen3.7-Flash", anatomy: false },
  ...(nanoPromoted ? [{ key: "Nano", file: NANO_FULL, label: "GPT-5 nano", anatomy: false }] : []),
  ...(gemini38Present ? [{ key: "GeminiEight", file: GEMINI38_FULL, label: "Gemini 3.8 Flash", anatomy: false }] : []),
];
const famRows: string[] = [];
// Per-model figures the model study's prose cites. The loop below can emit
// the same figure for every model; a macro nobody cites is a macro that can
// drift unseen, so only these are defined.
const FAM_CITED = new Set(["famGeminiFloor", "famGeminiFmt", "famGlmFmtFalseStratum", "famNanoFloor"]);
const defCited = (name: string, value: string) => {
  if (FAM_CITED.has(name)) def(name, value);
};
/** Net change in the share of TRUE answers under the formatting edit, per model. */
const famTrueShift = new Map<string, number>();
// The replication analysis of the main results table, repeated on every
// further model's stored draws (exp18b). The two model tables print it, so a
// single seed no longer stands for a model: one cell is "mean savings
// (certification rate)", both in percent over the replications.
type RepCell = {
  model: string;
  pair: string;
  alpha: number;
  strata: number;
  mainSeed: { sampled: number; reused: number; certified: boolean };
  replications: { B: number; certificationRate: number; savingsMean: number; unsafePresentedRate: number; unsafeCertificateRate?: number };
};
const famRep = (J("exp18b-family-replications.json") as { results: RepCell[] }).results;
const repOf = (model: string, pair: string, alpha: number) =>
  famRep.find((r) => r.model === model && r.pair === pair && Math.abs(r.alpha - alpha) < 1e-9);
const repFmt = (savingsMean: number, certificationRate: number) =>
  `${(savingsMean * 100).toFixed(1)} (${(certificationRate * 100).toFixed(1)})`;
const repCell = (model: string, pair: string, alpha: number) => {
  const r = repOf(model, pair, alpha);
  return r ? repFmt(r.replications.savingsMean, r.replications.certificationRate) : "--";
};
// The replications must be of the artifacts the tables describe: each stored
// main-seed sweep has a replicated cell that reproduced it (exp18b checks the
// counts when it runs; this checks that no sweep was left out).
const requireRep = (model: string, pair: string, sweeps: Array<{ alpha: number; sampled: number; reused: number }> | undefined) => {
  for (const sw of sweeps ?? []) {
    const r = repOf(model, pair, sw.alpha);
    if (!r || r.mainSeed.sampled !== sw.sampled || r.mainSeed.reused !== sw.reused) {
      throw new Error(`exp18b-family-replications.json does not cover ${model} ${pair} alpha=${sw.alpha}; re-run scripts/experiments/exp18b-family-replications.ts`);
    }
  }
};
// Primary model row from the main-seed benchmark artifact (exp8), same
// pairs, same evaluation vector, so the table compares like with like.
{
  type R8 = { pair: string; alpha: number; estimand: string; n: number; trueFlipRate: number; bootstrap: { savingsMean: number; certificationRate: number } };
  const r8 = (exp8.results as R8[]).filter((r) => r.estimand === "presented");
  const cell = (pair: string, alpha: number) => {
    const r = r8.find((x) => x.pair === pair && Math.abs(x.alpha - alpha) < 1e-9)!;
    return repFmt(r.bootstrap.savingsMean, r.bootstrap.certificationRate);
  };
  const fmtFlip = r8.find((x) => x.pair === "so-formatting")!.trueFlipRate;
  const synFlip = r8.find((x) => x.pair === "so-synonym")!.trueFlipRate;
  famRows.push(
    `DeepSeek V4 Flash (primary) & ${num(r8[0]!.n)} & ${pct(floorBoolValue, 1)} & ${pct(fmtFlip, 2)} & ${cell("so-formatting", 0.1)} & ${cell("so-formatting", 0.2)} & ${pct(synFlip, 2)} & ${cell("so-synonym", 0.1)} & ${cell("so-synonym", 0.2)} \\\\`,
  );
}
if (!nanoPromoted) {
  // The weaker probe (formatting pair only, n=500): a single seeded run,
  // which has no stored draws to replicate, printed as its outcome.
  const probe = (alpha: number) => {
    const x = (exp12.sweeps as Exp12["sweeps"]).find((y) => Math.abs(y.alpha - alpha) < 1e-9);
    if (!x) return "--";
    return x.certifiedStrata.length === 0 ? `refused (${x.sampled})` : `${pct(x.savings, 1)} (one run)`;
  };
  famRows.push(
    `\\texttt{${String(exp12.model).replace(/_/g, "\\_")}} & ${num(exp12.n)} & ${pct(exp12.selfFlipFloor, 1)} & ${pct(exp12.formattingEditFlip, 1)} & ${probe(0.1)} & ${probe(0.2)} & -- & -- & -- \\\\`,
  );
}
let famCertifying = 0;
// Usable rows per measurement (a few requests per family fail and are excluded).
const famUsable: number[] = [];
const famFloors: number[] = [];
const famRefused: string[] = [];
for (const f of FAMILIES) {
  const d = J(f.file) as Exp12;
  // Report the synonym pair only if it completed: a run cut off mid-batch
  // (gateway budget cap) leaves a random prefix, unbiased but under-sized,
  // and the table must not silently mix sample sizes.
  const syn = d.synonym && d.synonym.usableEdit >= 0.95 * d.n ? d.synonym : undefined;
  if (d.synonym && !syn) console.log(`NOTE: ${f.file} synonym pair partial (${d.synonym.usableEdit}/${d.n}); reported as --`);
  // A family whose floor and flip differ only in the second decimal is
  // printed to two, so the table shows the relation the prose states.
  // The caption gives one rule for a two-decimal entry (a rate on a half);
  // two rates that print alike at one decimal would need another.
  if (d.selfFlipFloor !== d.formattingEditFlip && pctRate(d.selfFlipFloor, 1) === pctRate(d.formattingEditFlip, 1)) {
    throw new Error(`${f.label}: floor and flip differ but print alike; give the caption of the model table a rule for it`);
  }
  famRows.push(
    `${f.label} & ${num(d.n)} & ${pctRate(d.selfFlipFloor, 1)} & ${pctRate(d.formattingEditFlip, 1)} & ${repCell(d.model, "so-formatting", 0.1)} & ${repCell(d.model, "so-formatting", 0.2)} & ${syn ? pctRate(syn.synonymEditFlip, 1) : "--"} & ${syn ? repCell(d.model, "so-synonym", 0.1) : "--"} & ${syn ? repCell(d.model, "so-synonym", 0.2) : "--"} \\\\`,
  );
  requireRep(d.model, "so-formatting", d.sweeps);
  if (syn) requireRep(d.model, "so-synonym", syn.sweeps);
  // The prose cites a few of these figures; the rest are in the table.
  defCited(`fam${f.key}Floor`, pctRate(d.selfFlipFloor, 1));
  defCited(`fam${f.key}Fmt`, pctRate(d.formattingEditFlip, 1));
  famUsable.push(...[(d as unknown as { usableFloor?: number }).usableFloor, (d as unknown as { usableEdit?: number }).usableEdit, syn?.usableEdit].filter((x): x is number => typeof x === "number"));
  famFloors.push(d.selfFlipFloor);
  const anyCert = d.sweeps.some((x) => x.certifiedStrata.length > 0) ||
    (syn?.sweeps ?? []).some((x) => x.certifiedStrata.length > 0);
  if (anyCert) famCertifying++;
  else famRefused.push(`${f.label} (floor ${pct(d.selfFlipFloor, 1)})`);
  // Flip anatomy from the per-row draws: which stratum flips, and which way.
  if (f.anatomy && d.draws && d.draws.length > 0) {
    let tN = 0, tF = 0, fN = 0, fF = 0, toFalse = 0, flips = 0;
    for (const r of d.draws) {
      if (r.a1 === null || r.a2 === null) continue;
      if (r.a1) { tN++; if (r.a2 !== r.a1) tF++; } else { fN++; if (r.a2 !== r.a1) fF++; }
      if (r.a2 !== r.a1) { flips++; if (r.a1 && !r.a2) toFalse++; }
    }
    if (tN > 0) defCited(`fam${f.key}FmtTrueStratum`, pct(tF / tN, 1));
    if (fN > 0) defCited(`fam${f.key}FmtFalseStratum`, pct(fF / fN, 1));
    // The share of TRUE answers under the old version and under the edited
    // one, over the rows both draws answered. Self-disagreement moves cells
    // both ways and leaves this share where it was; an edit that shifts the
    // model's decision moves it.
    if (tN + fN > 0) {
      def(`fam${f.key}TrueShareOld`, pct(tN / (tN + fN), 1));
      def(`fam${f.key}TrueShareNew`, pct((tN - tF + fF) / (tN + fN), 1));
      famTrueShift.set(f.key, (fF - tF) / (tN + fN));
    }
    void toFalse;
    void flips;
  }
  if (d.decomposition) {
    const c = d.decomposition.caseOnly;
    const w = d.decomposition.whitespaceOnly;
    if (c.flip !== null) def(`fam${f.key}CaseOnlyFlip`, pct(c.flip, 1));
    if (w.flip !== null) def(`fam${f.key}SpaceOnlyFlip`, pct(w.flip, 1));
  }
}
def("famCount", String(FAMILIES.length));
void famCertifying;
// The reading of the replication tables that the model study states.
{
  const models = [...new Set(famRep.map((r) => r.model))];
  if (models.length !== FAMILIES.length) throw new Error("exp18b-family-replications.json does not cover every further model");
  if (famRep.some((r) => r.replications.B !== Number(bci.B))) throw new Error("the model replications use another B than the main results table");
  const reading = (name: string, ok: boolean) => {
    if (!ok) throw new Error(`model study: "${name}" no longer holds; rewrite the subsection in body.tex`);
  };
  const cert = (model: string, pair: string, alpha: number) => {
    const r = repOf(model, pair, alpha);
    if (!r) throw new Error(`no replication cell for ${model} ${pair} ${alpha}`);
    return r.replications;
  };
  def("famRepCells", String(famRep.length));
  def("famRepUnsafeMax", pctCeil(Math.max(...famRep.map((r) => r.replications.unsafePresentedRate)), 1));
  // Unsafe certificates as Theorem 1 defines them, per stratum (a certificate
  // for a null), beside the presented-cells event above, which is a subset.
  const unsafeCert = (r: (typeof famRep)[number]) => {
    if (r.replications.unsafeCertificateRate === undefined) throw new Error("exp18b lacks the per-stratum unsafe-certificate rate; re-run exp18b-family-replications.ts");
    return r.replications.unsafeCertificateRate;
  };
  def("famRepUnsafeCertMax", pctCeil(Math.max(...famRep.map(unsafeCert)), 1));
  reading("unsafe certificates stay inside the per-stratum level in every cell", famRep.every((r) => unsafeCert(r) < DELTA_TOTAL / r.strata && r.replications.unsafePresentedRate <= unsafeCert(r)));
  // "On each further model at least one edit certifies in at least X of
  // replications at the loose budget": the minimum over models of the best cell.
  const best = models.map((m) =>
    Math.max(...famRep.filter((r) => r.model === m && Math.abs(r.alpha - 0.2) < 1e-9).map((r) => r.replications.certificationRate)),
  );
  def("famRepBestMin", pctFloor(Math.min(...best), 1));
  reading("every further model has an edit that certifies in nearly every replication", Math.min(...best) > 0.99);
  // "At least one edit certifies on X of Y further models": a model counts
  // when its best cell at the loose budget certifies in nearly every
  // replication, not when one seeded run happened to certify.
  def("famCertCount", String(best.filter((b) => b > 0.99).length));
  for (const m of ["google/gemini-3-flash", "google/gemini-3.8-flash"]) {
    for (const a of [0.1, 0.2]) reading(`${m} certifies the formatting edit in every replication at ${a}`, cert(m, "so-formatting", a).certificationRate === 1);
  }
  for (const m of ["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"]) {
    for (const a of [0.1, 0.2]) reading(`${m} certifies the formatting edit in almost no replication at ${a}`, cert(m, "so-formatting", a).certificationRate <= 0.01);
  }
  const glmFmt = cert("zai/glm-4.7-flash", "so-formatting", 0.2);
  reading("GLM-4.7-Flash certifies only a small stratum under the formatting edit", glmFmt.savingsMean < 0.05 && cert("zai/glm-4.7-flash", "so-formatting", 0.1).certificationRate <= 0.01);
  def("famGlmFmtRepSavings", pct(glmFmt.savingsMean, 1));
  for (const m of ["google/gemini-2.5-flash-lite", "openai/gpt-5-nano", "zai/glm-4.7-flash"]) {
    reading(`${m} certifies the synonym rewording in most replications at the loose budget`, cert(m, "so-synonym", 0.2).certificationRate > 0.5 && cert(m, "so-synonym", 0.2).savingsMean > 4 * cert(m, "so-formatting", 0.2).savingsMean);
  }
  // The formatting edit moves the share of TRUE answers up on one model and
  // down on another.
  reading("the formatting edit shifts Gemini 2.5 Flash-Lite toward TRUE and GLM-4.7-Flash toward FALSE", (famTrueShift.get("Gemini") ?? 0) > 0.05 && (famTrueShift.get("Glm") ?? 0) < -0.05);
}
def("priceFetchedAt", new Date(prices.fetchedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Los_Angeles" }));
if (gemini38Present) {
  // The sixth family's flip and floor round to the same digit; the counts
  // behind them are cited so the relation stays visible.
  const d38 = J(GEMINI38_FULL) as { n: number; usableFloor?: number; selfFlipFloor: number; formattingEditFlip: number };
}
def("famFloorLo", pct(Math.min(...famFloors), 1));
def("famFloorHi", pct(Math.max(...famFloors), 1));
def("famUsableMin", num(Math.min(...famUsable)));
// The floor is a bound for the identity edit only. Two strata of the family
// study flip LESS under an edit than under no edit at all, and one family
// certifies below its pooled floor; the prose cites them as the
// counterexamples, so each relation is asserted here.
{
  type D = { a1: boolean | null; b1: boolean | null; a2: boolean | null };
  const stratum = (file: string, value: boolean) => {
    const dr = ((J(file) as { draws?: D[] }).draws ?? []).filter((r) => r.a1 === value);
    const rate = (other: "b1" | "a2") => {
      const xs = dr.filter((r) => r[other] !== null);
      return xs.filter((r) => r[other] !== r.a1).length / Math.max(1, xs.length);
    };
    return { floor: rate("b1"), formatting: rate("a2") };
  };
  const glm = FAMILIES.find((f) => f.key === "Glm");
  const nano = FAMILIES.find((f) => f.key === "Nano");
  if (!glm || !nano) throw new Error("the model study lost GLM-4.7-Flash or GPT-5 nano; rewrite the floor counterexamples in body.tex");
  const g = stratum(glm.file, false);
  const n = stratum(nano.file, true);
  if (!(g.formatting < g.floor && n.formatting < n.floor)) {
    throw new Error("the model study's strata no longer flip less under the formatting edit than under the identity edit; rewrite the floor counterexamples in body.tex");
  }
  def("famGlmFloorFalseStratum", pct(g.floor, 1));
  def("famNanoFmtTrueStratum", pct(n.formatting, 1));
  def("famNanoFloorTrueStratum", pct(n.floor, 1));
  const nd = J(nano.file) as Exp12;
  const loose = nd.synonym?.sweeps.find((x) => Math.abs(x.alpha - 0.2) < 1e-9);
  if (!(loose && loose.certifiedStrata.length > 0 && nd.selfFlipFloor > 0.2)) {
    throw new Error("GPT-5 nano no longer certifies the synonym pair below its pooled floor; rewrite that sentence in body.tex");
  }
}
writeFileSync(
  "paper/tablefam.tex",
  `% GENERATED by scripts/experiments/gen-paper-assets.ts from the
% exp12-secondmodel-*.json artifacts (same lab column, same seeded rows as
% the primary evaluation vector, T=0, pinned procedure). Do not edit by hand.
\\begin{tabular}{lrrrllrll}
\\toprule
 & & & \\multicolumn{3}{c}{formatting-only (v1$\\to$v2)} & \\multicolumn{3}{c}{synonym rewording (v2$\\to$v3)} \\\\
\\cmidrule(lr){4-6}\\cmidrule(lr){7-9}
Model & $n$ & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ \\\\
\\midrule
${famRows.join("\n")}
\\bottomrule
\\end{tabular}
`,
);

def("famProbeRow", nanoPromoted ? "0" : "1");
// The certify action's per-request scope cap, read from the released route
// so the sentence in the implementation section cannot drift from the code.
{
  const route = readFileSync("app/api/lore/columns/[id]/certify/route.ts", "utf8");
  const cap = route.match(/limit:\s*z\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)/);
  if (!cap) throw new Error("could not read the scope cap from the certify route");
  if (!/adaptive:\s*true/.test(route) || !/maxLooks:\s*6/.test(route) || !/bound:\s*"exact"/.test(route) || !/assignStrataWith\(cells, \(\) => "all"\)/.test(route)) {
    throw new Error("the certify route no longer runs the pinned procedure (adaptive, six looks, exact bound, value strata); rewrite the implementation section or fix the route");
  }
  def("routeScopeCap", num(Number(cap[1])));
}

// ---------------------------------------------------------------------------
// Independence across rows (exp17): sequential against concurrent requests
// on the same rows. Gated on the artifact (a paid run).
// ---------------------------------------------------------------------------
def("indepAvailable", exp17 ? "1" : "0");
// Regularized lower incomplete gamma P(a, x) (series for x < a+1, continued
// fraction otherwise) and the chi-square quantile by bisection, for the
// dispersion-ratio interval below.
const gammaP = (a: number, x: number): number => {
  if (x <= 0) return 0;
  const lgamma = (z: number): number => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = z;
    let t = z + 5.5;
    t -= (z + 0.5) * Math.log(t);
    let ser = 1.000000000190015;
    for (const cj of c) ser += cj / ++y;
    return -t + Math.log((2.5066282746310005 * ser) / z);
  };
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let i = 0; i < 500; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
};
const chiSquareQuantile = (prob: number, df: number): number => {
  let lo = 0;
  let hi = Math.max(10, df * 10);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(df / 2, mid / 2) < prob) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};
if (exp17) {
  type Arm = { usable: number; errors: number; flips: number; flipRate: number | null; wilson95: [number, number]; medianLatencyMs: number | null; serial: { lag1: number; lag1PermutationP: number; blocks: number; blockSize: number; blockVarianceRatio: number | null; dispersionChiSquare: number; dispersionDf: number } };
  const e = exp17 as { n: number; concurrency: { concurrent: number }; sequential: Arm; concurrent: Arm; flipRateDifference: { z: number; twoSidedP: number }; betweenArmAgreement: { rows: number; disagreements: number; rate: number | null; wilson95: [number, number]; byCachedValue: Record<string, { rate: number | null; n: number }> }; wallMs: { sequential: number; concurrent: number } };
  const ci = (w: [number, number]) => `[${(w[0] * 100).toFixed(1)}, ${(w[1] * 100).toFixed(1)}]`;
  def("indepN", num(e.n));
  def("indepConcurrency", String(e.concurrency.concurrent));
  def("indepSeqRate", pct(e.sequential.flipRate ?? 0, 1));
  def("indepSeqCi", ci(e.sequential.wilson95));
  def("indepConcRate", pct(e.concurrent.flipRate ?? 0, 1));
  def("indepConcCi", ci(e.concurrent.wilson95));
  const p = e.flipRateDifference.twoSidedP;
  def("indepDiffP", p < 0.001 ? "<0.001" : p.toFixed(2));
  def("indepAgreeDisagree", pct(e.betweenArmAgreement.rate ?? 0, 1));
  def("indepAgreeCi", ci(e.betweenArmAgreement.wilson95));
  def("indepAgreeFalse", pct(e.betweenArmAgreement.byCachedValue.false?.rate ?? 0, 1));
  def("indepAgreeTrue", pct(e.betweenArmAgreement.byCachedValue.true?.rate ?? 0, 1));
  def("indepAgreeFalseN", String(e.betweenArmAgreement.byCachedValue.false?.n ?? 0));
  def("indepAgreeTrueN", String(e.betweenArmAgreement.byCachedValue.true?.n ?? 0));
  const lagP = (x: number) => (x < 0.001 ? "<0.001" : x.toFixed(2));
  // A negative sign printed as a text hyphen is a line-break point; set it in math.
  const signed = (x: number) => (x < 0 ? `$${x.toFixed(3)}$` : x.toFixed(3));
  def("indepSeqLag", signed(e.sequential.serial.lag1));
  def("indepSeqLagP", lagP(e.sequential.serial.lag1PermutationP));
  def("indepConcLag", signed(e.concurrent.serial.lag1));
  def("indepConcLagP", lagP(e.concurrent.serial.lag1PermutationP));
  def("indepSeqDispersion", (e.sequential.serial.blockVarianceRatio ?? 0).toFixed(2));
  def("indepConcDispersion", (e.concurrent.serial.blockVarianceRatio ?? 0).toFixed(2));
  def("indepBlocks", String(e.concurrent.serial.blocks));
  const minutesOf = (ms: number, d: number) => (ms / 6e4).toFixed(d);
  def("indepSeqMinutes", minutesOf(e.wallMs.sequential, 0));
  def("indepConcMinutes", minutesOf(e.wallMs.concurrent, 1));
  // Resolution of the tests, stated beside the results: the minimum
  // detectable difference of the two-proportion test at 80% power and the
  // 95% interval on the block variance ratio (chi-square with blocks-1 df).
  // Two-sample power calculation: the null SE uses the pooled rate over the
  // two arm sizes, the alternative SE the rates p1 and p1 + d; solve
  // 1.96 SE0 + 0.84 SE1(d) = d by iteration.
  {
    const n1 = Math.max(1, e.sequential.usable);
    const n2 = Math.max(1, e.concurrent.usable);
    const p1 = e.sequential.flips / n1;
    const pooled = (e.sequential.flips + e.concurrent.flips) / (n1 + n2);
    const se0 = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    let d = 1.96 * se0;
    for (let i = 0; i < 100; i++) {
      const p2 = Math.min(1, p1 + d);
      const se1 = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
      d = 1.96 * se0 + 0.84 * se1;
    }
    // A difference of rates: quoted in percentage points.
    def("indepMdd", (d * 100).toFixed(1));
  }
  def("indepPowerTarget", "80\\%");
  def("indepLevel", "5\\%");
  const dfc = e.concurrent.serial.dispersionDf;
  const ratio = e.concurrent.serial.blockVarianceRatio ?? 0;
  def("indepConcDispersionCi", `[${((ratio * dfc) / chiSquareQuantile(0.975, dfc)).toFixed(2)}, ${((ratio * dfc) / chiSquareQuantile(0.025, dfc)).toFixed(2)}]`);
  def("indepBlockSize", String(e.concurrent.serial.blockSize ?? e.concurrency.concurrent));
  def("indepCallCeiling", String(Math.round(Number((exp17 as { callTimeoutMs?: number }).callTimeoutMs ?? 0) / 1e3)));
  def("indepSeqErrors", String(e.sequential.errors));
  def("indepConcErrors", String(e.concurrent.errors));
  // Upper-tail p-values of the block-dispersion chi-square statistics.
  const chiP = (x: number, df: number) => 1 - gammaP(df / 2, x / 2);
  const fmtP = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(2));
  def("indepSeqDispersionP", fmtP(chiP(e.sequential.serial.dispersionChiSquare, e.sequential.serial.dispersionDf)));
  def("indepConcDispersionP", fmtP(chiP(e.concurrent.serial.dispersionChiSquare, e.concurrent.serial.dispersionDf)));
  def("indepSeqBlocks", String(e.sequential.serial.blocks));
  // Do the excluded requests hide flips? The rows both arms kept, and the
  // sequential arm's verdict on the rows the concurrent arm dropped.
  type Draw = { cached: boolean | null; sequential: boolean | null; concurrent: boolean | null };
  const draws = (exp17 as { draws: Draw[] }).draws;
  const both = draws.filter((r) => r.sequential !== null && r.concurrent !== null);
  const droppedByConc = draws.filter((r) => r.sequential !== null && r.concurrent === null);
  def("indepBothRows", num(both.length));
  def("indepBothSeqRate", pct(both.filter((r) => r.sequential !== r.cached).length / both.length, 1));
  def("indepBothConcRate", pct(both.filter((r) => r.concurrent !== r.cached).length / both.length, 1));
  def("indepConcDroppedRows", String(droppedByConc.length));
  def("indepConcDroppedSeqFlips", String(droppedByConc.filter((r) => r.sequential !== r.cached).length));
  const droppedBySeq = draws.filter((r) => r.sequential === null && r.concurrent !== null);
  def("indepSeqDroppedRows", String(droppedBySeq.length));
  def("indepSeqDroppedConcFlips", String(droppedBySeq.filter((r) => r.concurrent !== r.cached).length));
  // Two looks outside the analysis plan (exp17's re-analysis marks them as
  // such): the block test with blocks formed in launch order.
  type Unplanned = { launchOrderBlocks: { blocks: number; blockVarianceRatio: number | null; dispersionChiSquare: number; dispersionDf: number }; latencySplit: { fasterHalf: { n: number; flips: number }; slowerHalf: { n: number; flips: number } } };
  const fmtP3 = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
  const unplannedMain = (e.concurrent as unknown as { unplanned?: Unplanned }).unplanned;
  if (!unplannedMain) throw new Error("exp17-independence.json predates the re-analysis; run EXP_REANALYZE=1 scripts/experiments/exp17-independence.ts");
  const launchMainP = chiP(unplannedMain.launchOrderBlocks.dispersionChiSquare, unplannedMain.launchOrderBlocks.dispersionDf);
  def("indepLaunchDispersion", (unplannedMain.launchOrderBlocks.blockVarianceRatio ?? 0).toFixed(2));
  def("indepLaunchP", fmtP(launchMainP));
  // The design is paired (same rows in both arms): discordant counts and an
  // exact two-sided McNemar p on the rows both arms kept.
  const onlySeq = both.filter((r) => r.sequential !== r.cached && r.concurrent === r.cached).length;
  const onlyConc = both.filter((r) => r.concurrent !== r.cached && r.sequential === r.cached).length;
  const disc = onlySeq + onlyConc;
  const mcnemar = disc === 0 ? 1 : Math.min(1, 2 * binomialLowerTail(Math.min(onlySeq, onlyConc), disc, 0.5));
  def("indepOnlySeqFlips", String(onlySeq));
  def("indepOnlyConcFlips", String(onlyConc));
  def("indepPairedP", mcnemar < 0.001 ? "<0.001" : mcnemar.toFixed(2));
  // The concurrent-only extension: enough blocks for the dispersion test.
  def("indepExtAvailable", exp17ext ? "1" : "0");
  if (exp17ext) {
    const x = exp17ext.concurrent;
    const dfx = x.serial.dispersionDf;
    const ratio = x.serial.blockVarianceRatio ?? 0;
    def("indepExtRows", num(exp17ext.n));
    def("indepExtErrors", String(x.errors));
    def("indepExtBlocks", String(x.serial.blocks));
    def("indepExtDispersion", ratio.toFixed(2));
    def("indepExtDispersionCi", `[${((ratio * dfx) / chiSquareQuantile(0.975, dfx)).toFixed(2)}, ${((ratio * dfx) / chiSquareQuantile(0.025, dfx)).toFixed(2)}]`);
    def("indepExtDispersionP", fmtP(chiP(x.serial.dispersionChiSquare, dfx)));
    def("indepExtLag", signed(x.serial.lag1));
    def("indepExtLagP", lagP(x.serial.lag1PermutationP));
    def("indepExtRate", pct(x.flipRate ?? 0, 1));
    def("indepExtCi", ci(x.wilson95));
    def("indepExtVsSeqP", fmtP(exp17ext.againstMainSequential.twoSidedP));
    def("indepExtDate", fmtRunDate(exp17ext.ranAt));
    // The larger arm ran under faster serving than the first concurrent arm;
    // the prose says so, since the two arms are pooled in one test.
    {
      const first = Number(e.concurrent.medianLatencyMs ?? 0);
      const later = Number((x as unknown as { medianLatencyMs?: number }).medianLatencyMs ?? 0);
      if (!(first > 0 && later > 0 && later < first / 2)) {
        throw new Error("independence check: the larger arm no longer ran at under half the first arm's median latency; rewrite the sentence in body.tex");
      }
      def("indepConcMedianLatency", (first / 1e3).toFixed(1));
      def("indepExtMedianLatency", (later / 1e3).toFixed(1));
    }
    // The upper end of the larger arm's interval: the ratio the test cannot exclude.
    const extHi = (ratio * dfx) / chiSquareQuantile(0.025, dfx);
    // The planned block test pooled over both concurrent arms.
    const pooledX = (exp17ext as unknown as { pooledWithMainConcurrent?: { dispersionChiSquare: number; dispersionDf: number } }).pooledWithMainConcurrent;
    const unplannedExt = (x as unknown as { unplanned?: Unplanned }).unplanned;
    if (!pooledX || !unplannedExt) throw new Error("exp17-independence-ext.json predates the re-analysis; run EXP_REANALYZE=1 scripts/experiments/exp17-independence.ts");
    const pooledP = chiP(pooledX.dispersionChiSquare, pooledX.dispersionDf);
    def("indepPooledChi", pooledX.dispersionChiSquare.toFixed(1));
    def("indepPooledDf", String(pooledX.dispersionDf));
    def("indepPooledP", fmtP3(pooledP));
    const launchExtP = chiP(unplannedExt.launchOrderBlocks.dispersionChiSquare, unplannedExt.launchOrderBlocks.dispersionDf);
    def("indepExtLaunchDispersion", (unplannedExt.launchOrderBlocks.blockVarianceRatio ?? 0).toFixed(2));
    def("indepExtLaunchP", fmtP3(launchExtP));
    def("indepExtSlowFlips", String(unplannedExt.latencySplit.slowerHalf.flips));
    def("indepExtFastFlips", String(unplannedExt.latencySplit.fasterHalf.flips));
    def("indepExtHalfRows", num(unplannedExt.latencySplit.slowerHalf.n));
    // The reading of these tests is written out in body.tex; hold it to the data.
    const firstP = chiP(e.concurrent.serial.dispersionChiSquare, e.concurrent.serial.dispersionDf);
    const extP = chiP(x.serial.dispersionChiSquare, dfx);
    const reading: Array<[string, boolean]> = [
      ["the first concurrent arm rejects one-sided at 5%", firstP < 0.05],
      ["the larger arm alone does not reject", extP >= 0.05],
      ["the pooled test rejects narrowly", pooledP > 0.03 && pooledP < 0.05],
      ["the larger arm's interval admits ratios near 2", extHi > 2],
      ["flips concentrate in slow responses", unplannedExt.latencySplit.slowerHalf.flips > 3 * unplannedExt.latencySplit.fasterHalf.flips && unplannedExt.latencySplit.slowerHalf.n === unplannedExt.latencySplit.fasterHalf.n],
      ["the launch-order ratio rejects in the larger arm and not in the first", launchExtP < 0.05 && launchMainP >= 0.05],
      ["no lag test rejects", e.sequential.serial.lag1PermutationP >= 0.05 && e.concurrent.serial.lag1PermutationP >= 0.05 && x.serial.lag1PermutationP >= 0.05],
      ["the rate tests do not reject", e.flipRateDifference.twoSidedP >= 0.05 && exp17ext.againstMainSequential.twoSidedP >= 0.05],
    ];
    for (const [name, ok] of reading) {
      if (!ok) throw new Error(`independence check: "${name}" no longer holds; rewrite the paragraph "Reading the tests" in body.tex`);
    }
    // A third look outside the plan: where in each arm's own completion order
    // the flips fall, and how many rows flip in both paired arms. Block
    // overdispersion against one common rate arises from interference between
    // requests, and equally from flip-prone rows that sit together in the
    // order. The two paired arms share their rows and their order, so the
    // text may not read their overdispersion as an effect of concurrency.
    {
      type Order = Array<{ id: string }>;
      type Rowed = { id: string; cached: boolean | null; sequential?: boolean | null; concurrent: boolean | null };
      const main = exp17 as unknown as { draws: Rowed[]; completionOrder: { sequential: Order; concurrent: Order } };
      const ext = exp17ext as unknown as { draws: Rowed[]; completionOrder: Order };
      const halves = (rowsOf: Rowed[], order: Order, arm: "sequential" | "concurrent") => {
        const byId = new Map(rowsOf.map((r) => [r.id, r]));
        const seq = order
          .map((o) => byId.get(o.id)!)
          .filter((r) => r[arm] !== null && r[arm] !== undefined)
          .map((r) => (r[arm] !== r.cached ? 1 : 0));
        const h = Math.floor(seq.length / 2);
        const sum = (xs: number[]) => xs.reduce((acc: number, v) => acc + v, 0);
        const n1 = h;
        const n2 = seq.length - h;
        const k1 = sum(seq.slice(0, h));
        const k2 = sum(seq.slice(h));
        const pooled = (k1 + k2) / (n1 + n2);
        const z = (k2 / n2 - k1 / n1) / Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
        return { n1, n2, k1, k2, p: chiP(z * z, 1) };
      };
      const hSeq = halves(main.draws, main.completionOrder.sequential, "sequential");
      const hConc = halves(main.draws, main.completionOrder.concurrent, "concurrent");
      const hExt = halves(ext.draws, ext.completionOrder, "concurrent");
      const flipsBoth = both.filter((r) => r.sequential !== r.cached && r.concurrent !== r.cached).length;
      const expectedBoth =
        (both.filter((r) => r.sequential !== r.cached).length * both.filter((r) => r.concurrent !== r.cached).length) / both.length;
      const seqRatio = e.sequential.serial.blockVarianceRatio ?? 0;
      const look3: Array<[string, boolean]> = [
        ["the first concurrent arm had about three times the sequential arm's failed requests", e.concurrent.errors >= 2.5 * e.sequential.errors && e.concurrent.errors <= 3.5 * e.sequential.errors],
        ["the larger concurrent arm had no failed request", x.errors === 0],
        ["the sequential arm shows block excess on the same rows", seqRatio > 1.2 && seqRatio < (e.concurrent.serial.blockVarianceRatio ?? 0)],
        ["far more rows flip in both paired arms than chance would give", flipsBoth > 3 * expectedBoth],
        ["the first concurrent arm's flips concentrate late in its completion order", hConc.p < 0.01 && hConc.k2 > hConc.k1 && hConc.n1 === hConc.n2],
        ["the sequential arm shows the same direction on the same rows", hSeq.k2 > hSeq.k1],
        ["the larger arm shows no such trend", hExt.p > 0.5 && hExt.n1 === hExt.n2],
      ];
      for (const [name, ok] of look3) {
        if (!ok) throw new Error(`independence check: "${name}" no longer holds; rewrite the independence paragraphs in body.tex (Section V-F and Appendix D)`);
      }
      def("indepBothFlipRows", String(flipsBoth));
      def("indepBothFlipExpected", expectedBoth.toFixed(0));
      def("indepConcFirstHalfFlips", String(hConc.k1));
      def("indepConcSecondHalfFlips", String(hConc.k2));
      def("indepConcHalfN", String(hConc.n1));
      def("indepConcHalfP", hConc.p < 0.001 ? "<0.001" : hConc.p.toFixed(3));
      def("indepSeqFirstHalfFlips", String(hSeq.k1));
      def("indepSeqFirstHalfN", String(hSeq.n1));
      def("indepSeqSecondHalfFlips", String(hSeq.k2));
      def("indepSeqSecondHalfN", String(hSeq.n2));
      def("indepExtFirstHalfFlips", String(hExt.k1));
      def("indepExtSecondHalfFlips", String(hExt.k2));
      def("indepExtHalfN", num(hExt.n1));
    }
    // What dependence of that size would cost (exp9c): the certifier's
    // per-stratum error probability at the least favourable rate, simulated
    // under beta-binomial dependence within blocks, at every dispersion ratio
    // the check reports.
    {
      type R9c = { alpha: number; size: number; ratio: number; ratioLabel: string; errorProbability: number };
      const c = J("exp9c-overdispersion.json") as { perStratumDelta: number; block: number; ratios: Array<{ label: string; phi: number }>; results: R9c[] };
      const at = (label: string, alpha: number) => {
        const r = c.results.find((y) => y.ratioLabel === label && Math.abs(y.alpha - alpha) < 1e-9);
        if (!r) throw new Error(`exp9c-overdispersion.json has no cell "${label}" at alpha=${alpha}; re-run scripts/experiments/exp9c-overdispersion.ts`);
        return r.errorProbability;
      };
      const worst = (label: string) => Math.max(at(label, 0.2), at(label, 0.1));
      const phiOf = (label: string) => {
        const r = c.ratios.find((y) => y.label === label);
        if (!r) throw new Error(`exp9c-overdispersion.json has no ratio "${label}"`);
        return r.phi;
      };
      const firstRatio = e.concurrent.serial.blockVarianceRatio ?? 0;
      const firstHi = (firstRatio * dfc) / chiSquareQuantile(0.025, dfc);
      const pooledRatio = pooledX.dispersionChiSquare / pooledX.dispersionDf;
      const pooledLo = pooledX.dispersionChiSquare / chiSquareQuantile(0.975, pooledX.dispersionDf);
      const pooledHi = pooledX.dispersionChiSquare / chiSquareQuantile(0.025, pooledX.dispersionDf);
      // One row per ratio, in increasing order of the ratio; each simulated
      // ratio must be the one the check reports for that source.
      const SOURCES: Array<{ label: string; row: string; reported: number }> = [
        { label: "independent", row: "Independent draws", reported: 1 },
        { label: "planned estimate (larger arm)", row: "Larger concurrent arm, estimate", reported: ratio },
        { label: "pooled estimate (both concurrent arms)", row: "Both concurrent arms pooled, estimate", reported: pooledRatio },
        { label: "launch-order estimate (larger arm)", row: "Larger arm, blocks in launch order (unplanned)", reported: unplannedExt.launchOrderBlocks.blockVarianceRatio ?? 0 },
        { label: "planned estimate (first concurrent arm)", row: "First concurrent arm, estimate", reported: firstRatio },
        { label: "upper end of the planned test's 95% interval", row: "Larger arm, upper end of its interval", reported: extHi },
        { label: "upper end of the pooled 95% interval", row: "Both arms pooled, upper end of the interval", reported: pooledHi },
        { label: "upper end of the first arm's 95% interval", row: "First arm, upper end of its interval", reported: firstHi },
      ];
      const same = (x1: number, x2: number) => Math.abs(x1 - x2) < 5e-3;
      if (c.ratios.length !== SOURCES.length || c.block !== e.concurrent.serial.blockSize || SOURCES.some((src) => !same(phiOf(src.label), src.reported))) {
        throw new Error("exp9c-overdispersion.json was simulated at other dispersion ratios than the independence check now reports; re-run scripts/experiments/exp9c-overdispersion.ts");
      }
      const ordered = [...SOURCES].sort((x1, x2) => x1.reported - x2.reported);
      for (let i = 1; i < ordered.length; i++) {
        if (!(worst(ordered[i]!.label) > worst(ordered[i - 1]!.label))) {
          throw new Error("exp9c: the simulated error probability no longer rises with the dispersion ratio; rewrite the paragraphs on dependence in body.tex");
        }
      }
      const indep = worst("independent");
      const pooledErr = worst("pooled estimate (both concurrent arms)");
      const pooledHiErr = worst("upper end of the pooled 95% interval");
      const firstErr = worst("planned estimate (first concurrent arm)");
      const dependenceReading: Array<[string, boolean]> = [
        ["independent draws stay inside the per-stratum level", indep < c.perStratumDelta],
        ["the pooled estimate puts the error probability near the nominal level", pooledErr > 0.04 && pooledErr < 0.065],
        ["the pooled interval's upper end and the first arm's estimate put it at two to three times nominal", pooledHiErr > 2 * c.perStratumDelta && pooledHiErr < 3 * c.perStratumDelta && firstErr > 2 * c.perStratumDelta && firstErr < 3 * c.perStratumDelta],
        ["the first arm alone admits much stronger dependence", firstHi > 2 * pooledHi && worst("upper end of the first arm's 95% interval") > 0.25],
      ];
      for (const [name, ok] of dependenceReading) {
        if (!ok) throw new Error(`independence check: "${name}" no longer holds; rewrite the paragraphs on dependence in body.tex`);
      }
      def("indepPooledDispersion", pooledRatio.toFixed(2));
      def("indepPooledDispersionCi", `[${pooledLo.toFixed(2)}, ${pooledHi.toFixed(2)}]`);
      def("overdispIndep", pctCeil(indep, 1));
      def("overdispPooled", pct(pooledErr, 1));
      def("overdispPooledUpper", pct(pooledHiErr, 1));
      def("overdispTrials", num((c as unknown as { trials: number }).trials));
      writeFileSync(
        "paper/tabledependence.tex",
        `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp9c-overdispersion.json
% (ratios read from exp17-independence.json and exp17-independence-ext.json). Do not edit by hand.
\\begin{tabular}{@{}>{\\raggedright\\arraybackslash}p{4.3cm}rrr@{}}
\\toprule
Source of the dispersion ratio & ratio & $\\alpha{=}0.2$ & $\\alpha{=}0.1$ \\\\
\\midrule
${ordered.map((src) => `${src.row} & ${phiOf(src.label).toFixed(2)} & ${pct(at(src.label, 0.2), 1)} & ${pct(at(src.label, 0.1), 1)} \\\\`).join("\n")}
\\bottomrule
\\end{tabular}
`,
      );
    }
    // The planned comparison drops requests that failed or timed out; the
    // released certifier counts a failed call as a flip. The same comparison
    // under that rule, from the re-analysis stored in the artifact.
    {
      const f = (exp17 as { failureAsFlip?: { rows: number; sequential: number; concurrent: number; twoSidedP: number; onlySequential: number; onlyConcurrent: number } }).failureAsFlip;
      if (!f) throw new Error("exp17-independence.json carries no failureAsFlip block; run EXP_REANALYZE=1 scripts/experiments/exp17-independence.ts");
      def("indepSeqFailRate", pct(f.sequential / f.rows, 1));
      def("indepConcFailRate", pct(f.concurrent / f.rows, 1));
      def("indepSeqFailCount", String(f.sequential));
      def("indepConcFailCount", String(f.concurrent));
      def("indepFailP", f.twoSidedP < 0.001 ? "<0.001" : f.twoSidedP.toFixed(3));
      const discordant = f.onlySequential + f.onlyConcurrent;
      const paired = discordant === 0 ? 1 : Math.min(1, 2 * binomialLowerTail(Math.min(f.onlySequential, f.onlyConcurrent), discordant, 0.5));
      def("indepFailOnlySeq", String(f.onlySequential));
      def("indepFailOnlyConc", String(f.onlyConcurrent));
      def("indepFailPairedP", paired < 0.001 ? "<0.001" : paired.toFixed(3));
      const failReading: Array<[string, boolean]> = [
        ["concurrency tripled the failed requests", e.concurrent.errors >= 3 * e.sequential.errors && e.sequential.errors > 0],
        ["with failures counted as flips the arms differ at the 5% level", f.twoSidedP < 0.05 && paired < 0.05 && f.concurrent > f.sequential],
        ["the larger arm had no failed request", x.errors === 0],
      ];
      for (const [name, ok] of failReading) {
        if (!ok) throw new Error(`independence check: "${name}" no longer holds; rewrite the paragraph in body.tex`);
      }
    }
    // Permutation reference for each block-dispersion statistic (about three
    // expected flips per block, where the chi-square reference is approximate).
    {
      const permOf = (o: unknown) => {
        const v = (o as { dispersionPermutationP?: number }).dispersionPermutationP;
        if (typeof v !== "number") throw new Error("the independence artifacts carry no permutation p-values; run EXP_REANALYZE=1 scripts/experiments/exp17-independence.ts");
        return v;
      };
      const pairs: Array<[number, number]> = [
        [permOf(e.sequential.serial), chiP(e.sequential.serial.dispersionChiSquare, e.sequential.serial.dispersionDf)],
        [permOf(e.concurrent.serial), chiP(e.concurrent.serial.dispersionChiSquare, e.concurrent.serial.dispersionDf)],
        [permOf(x.serial), chiP(x.serial.dispersionChiSquare, dfx)],
        [permOf(pooledX), pooledP],
        [permOf(unplannedMain.launchOrderBlocks), launchMainP],
        [permOf(unplannedExt.launchOrderBlocks), launchExtP],
      ];
      const gap = Math.max(...pairs.map(([perm, chi]) => Math.abs(perm - chi)));
      if (!(gap < 0.02)) throw new Error(`a permutation p-value differs from its chi-square p-value by ${gap.toFixed(3)}; rewrite the sentence on the chi-square reference in body.tex`);
      if (pairs.some(([perm, chi]) => (perm < 0.05) !== (chi < 0.05))) throw new Error("a permutation p-value and its chi-square p-value fall on different sides of 5%; rewrite the reading of the dispersion tests in body.tex");
      // Quoted as "by at most": rounded up to two decimals.
      const roundedUp = Math.ceil(gap / 0.01 - 1e-9) * 0.01;
      def("indepPermGap", roundedUp.toFixed(2));
    }
  }
}

// Full bound-by-configuration grid (exp14) for the appendix: savings and
// oracle calls per (pair, alpha, bound).
{
  type R14 = { bound: string; pair: string; alpha: number; n: number; oracle: number; reused: number; savings: number; certifiedStrata: string[] };
  const rows14 = exp14.results as R14[];
  const order = ["exact", "cp", "betting", "eb", "wor"];
  const lines: string[] = [];
  for (const pair of Object.keys(LABELS)) {
    for (const alpha of [0.02, 0.05, 0.1, 0.2]) {
      const cells = order.map((b) => {
        const r = rows14.find((x) => x.bound === b && x.pair === pair && Math.abs(x.alpha - alpha) < 1e-9)!;
        return r.certifiedStrata.length > 0 ? `${ratioPct(r.reused, r.n, 1)} (${num(r.oracle)})` : `refused (${num(r.oracle)})`;
      });
      lines.push(`${LABELS[pair]} & ${alpha.toFixed(2)} & ${cells.join(" & ")} \\\\`);
    }
  }
  writeFileSync(
    "paper/tableboundsgrid.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp14-bounds.json. Do not edit by hand.
\\begin{tabular}{@{}lrlllll@{}}
\\toprule
Edit & $\\alpha$ & exact & Clopper--Pearson & betting & Maurer--Pontil & Bardenet--Maillard \\\\
\\midrule
${lines.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
}

// ---------------------------------------------------------------------------
// Remaining edit pairs on further families (exp18): the production column's
// scope-widening pair and the two Djinni pairs, so a family can carry all
// five pairs. Reported only when the artifacts exist (paid runs); the prose
// is gated on \famPairsAvailable.
// ---------------------------------------------------------------------------
{
  type P18 = { usable: number; flip: number | null; strataCount: number; sweeps: Array<{ alpha: number; certifiedStrata: string[]; sampled: number; reused: number; realizedPresented: number | null; savings: number }> };
  type E18 = { model: string; pairset: "widening" | "djinni"; n: number; selfFlipFloor: number | null; usableFloor: number; ranAt: string; pairs: Record<string, P18> };
  const arts = exp18Files.map((f) => J(f) as E18);
  const byModel = new Map<string, Partial<Record<"widening" | "djinni", E18>>>();
  for (const a of arts) {
    const m = byModel.get(a.model) ?? {};
    m[a.pairset] = a;
    byModel.set(a.model, m);
  }
  const LABEL: Record<string, string> = {
    "google/gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
    "google/gemini-3-flash": "Gemini 3 Flash",
    "zai/glm-4.7-flash": "GLM-4.7-Flash",
    "alibaba/qwen3.7-flash": "Qwen3.7-Flash",
    "openai/gpt-5-nano": "GPT-5 nano",
    "google/gemini-3.8-flash": "Gemini 3.8 Flash",
  };
  // Cells are the replication analysis of exp18b, as in the lab-column table.
  const cell18 = (model: string, pair: string, p: P18 | undefined, alpha: number) => {
    if (!p) return "--";
    requireRep(model, pair, p.sweeps);
    return repCell(model, pair, alpha);
  };
  // Primary-model rows for the same three pairs, from the replications of exp8.
  type R8p = { pair: string; alpha: number; estimand: string; n: number; trueFlipRate: number; bootstrap: { savingsMean: number; certificationRate: number } };
  const r8 = (exp8.results as R8p[]).filter((r) => r.estimand === "presented");
  const primaryCell = (pair: string, alpha: number) => {
    const r = r8.find((x) => x.pair === pair && Math.abs(x.alpha - alpha) < 1e-9)!;
    return repFmt(r.bootstrap.savingsMean, r.bootstrap.certificationRate);
  };
  const flipOf = (pair: string) => pct(r8.find((x) => x.pair === pair)!.trueFlipRate, 2);
  const rows18: string[] = [];
  rows18.push(
    `DeepSeek V4 Flash (primary) & -- & ${flipOf("so-widening")} & ${primaryCell("so-widening", 0.1)} & ${primaryCell("so-widening", 0.2)} & ${pct(exp0b.selfFlipRate, 1)} & ${flipOf("dj-formatting")} & ${primaryCell("dj-formatting", 0.1)} & ${primaryCell("dj-formatting", 0.2)} & ${flipOf("dj-criteria")} & ${primaryCell("dj-criteria", 0.1)} & ${primaryCell("dj-criteria", 0.2)} \\\\`,
  );
  let complete = 0;
  const completeLabels: string[] = [];
  for (const [model, sets] of byModel) {
    const w = sets.widening;
    const d = sets.djinni;
    const label = LABEL[model] ?? `\\texttt{${model.replace(/_/g, "\\_")}}`;
    const fl = (v: number | null | undefined) => (v === null || v === undefined ? "--" : pctRate(v, 1));
    rows18.push(
      `${label} & ${fl(w?.selfFlipFloor)} & ${fl(w?.pairs["so-widening"]?.flip)} & ${cell18(model, "so-widening", w?.pairs["so-widening"], 0.1)} & ${cell18(model, "so-widening", w?.pairs["so-widening"], 0.2)} & ${fl(d?.selfFlipFloor)} & ${fl(d?.pairs["dj-formatting"]?.flip)} & ${cell18(model, "dj-formatting", d?.pairs["dj-formatting"], 0.1)} & ${cell18(model, "dj-formatting", d?.pairs["dj-formatting"], 0.2)} & ${fl(d?.pairs["dj-criteria"]?.flip)} & ${cell18(model, "dj-criteria", d?.pairs["dj-criteria"], 0.1)} & ${cell18(model, "dj-criteria", d?.pairs["dj-criteria"], 0.2)} \\\\`,
    );
    if (w && d) {
      complete++;
      completeLabels.push(LABEL[model] ?? model);
    }
  }
  def("famPairsAvailable", arts.length > 0 ? "1" : "0");
  // "Every model has a measurable floor" holds on the lab column only: on the
  // production column a model can show no self-flip at all. The prose names
  // the one that does, so it must be exactly one.
  {
    const zero = [...byModel].filter(([, sets]) => sets.widening && sets.widening.selfFlipFloor === 0).map(([model]) => LABEL[model] ?? model);
    if (zero.length !== 1) {
      throw new Error(`${zero.length} further models show a zero floor on the production column (${zero.join(", ")}); rewrite "What transfers" in body.tex, which names one`);
    }
    def("famZeroFloorModel", zero[0]!);
    if (!(Math.min(...famFloors) > 0)) {
      throw new Error("a further model has a zero floor on the lab column; \"Every model has a measurable self-flip floor on the lab Boolean column\" no longer holds");
    }
  }
  // A cached-value stratum smaller than the first look is drawn in full,
  // so its draws count toward the family's calls on that pair and it is
  // never certified (nothing is left to reuse); the caption says so where
  // it happens, since the refusal count is then not a schedule look.
  {
    type Strat = { size: number };
    const notes: string[] = [];
    for (const a of arts) {
      for (const [pairKey, pr] of Object.entries(a.pairs)) {
        const strata = ((pr as unknown as { sweeps: Array<{ strata?: Record<string, Strat> }> }).sweeps[0]?.strata ?? {}) as Record<string, Strat>;
        for (const [sk, s] of Object.entries(strata)) {
          if (s.size >= 45) continue;
          const value = sk.startsWith("v=true") ? "cached-TRUE" : sk.startsWith("v=false") ? "cached-FALSE" : `cached-${sk.replace(/^v=/, "").replace(/\|all$/, "")}`;
          const column = pairKey === "so-widening" ? "widening" : "select";
          notes.push(`${LABEL[a.model] ?? a.model} holds ${s.size} ${value} cells on the ${column} column`);
        }
      }
    }
    def("famPairsSmallStrataNote", notes.length ? ` A stratum smaller than the first look is drawn in full and cannot be certified: ${notes.join("; ")}.` : "");
  }
  def("famFivePairFamilies", String(complete));
  // Certification outcomes across the remaining pairs, for the prose.
  {
    let certAny = 0;
    let families = 0;
    for (const [, sets] of byModel) {
      families++;
      const ps = [sets.widening?.pairs["so-widening"], sets.djinni?.pairs["dj-formatting"], sets.djinni?.pairs["dj-criteria"]];
      if (ps.some((p) => p?.sweeps.some((s) => s.certifiedStrata.length > 0))) certAny++;
    }
    def("famPairsFamilies", String(families));
  }
  writeFileSync(
    "paper/tablefampairs.tex",
    arts.length === 0
      ? `% GENERATED by scripts/experiments/gen-paper-assets.ts: no exp18 artifacts present.\n`
      : `% GENERATED by scripts/experiments/gen-paper-assets.ts from the
% exp18-families-*.json artifacts (same seeded rows as the primary evaluation
% vectors, runner framing, T=0, pinned procedure). Do not edit by hand.
\\begin{tabular}{@{}lrrll rrll rll@{}}
\\toprule
 & \\multicolumn{4}{c}{SO scope widening (production column)} & \\multicolumn{7}{c}{Djinni seniority tier (four-way select)} \\\\
\\cmidrule(lr){2-5}\\cmidrule(lr){6-12}
 & & & & & & \\multicolumn{3}{c}{formatting-only (v1$\\to$v2)} & \\multicolumn{3}{c}{criteria change (v2$\\to$v3)} \\\\
\\cmidrule(lr){7-9}\\cmidrule(lr){10-12}
Model & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ \\\\
\\midrule
${rows18.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
}

// ---------------------------------------------------------------------------
// Reconciliation of the flip-rate figures (a reviewer listed four values for
// the headline edit and three for the cached-TRUE stratum): one row per
// figure, naming the edit, the population, and the instrument. Values are
// the same macros the prose cites.
// ---------------------------------------------------------------------------
writeFileSync(
  "paper/tablerates.tex",
  `% GENERATED by scripts/experiments/gen-paper-assets.ts. Every value is a
% macro defined in macros.tex from the artifact named in the last column.
\\begin{tabular}{@{}lp{2.2cm}p{2.3cm}p{5.6cm}@{}}
\\toprule
Rate & Edit & Cells & Instrument (artifact) \\\\
\\midrule
\\multicolumn{4}{@{}l}{\\emph{Headline pair: SO formatting-only, Boolean lab column}} \\\\
\\flipSoFormatting & formatting v1$\\to$v2 & $n{=}\\benchN$ evaluation vector & stored v2 oracle cells against the stored v1 cache, one draw each side (\\fmtStoredFlips\\ flips); the Table~\\ref{tab:main} label instrument (\\texttt{exp8}) \\\\
\\floorBoolStored & formatting v1$\\to$v2 & same rows & the same comparison on the v2 cells as first drawn (\\fmtEarlierFlips\\ flips), recorded before \\vectorRedrawnCells\\ of them were re-drawn on \\vectorRedrawnDate\\ (\\texttt{exp10}) \\\\
\\floorBoolVote & formatting v1$\\to$v2 & same rows & majority of three draws on each side (\\fmtVoteFlips\\ flips; \\texttt{exp10}) \\\\
\\editFlipFreshBoth & formatting v1$\\to$v2 & same rows & fresh single draws on both sides, neither the cache (\\texttt{exp10}) \\\\
\\floorBool & identity (no edit) & same rows & pairs of fresh draws of one version: the column-level self-flip rate (\\texttt{exp10}) \\\\
\\floorFalseStratum, \\floorTrueStratum & identity & cached-FALSE, cached-TRUE rows & the stratum floors: the stored v1 value against each of three fresh v1 draws (\\floorIdentityPooled\\ pooled; \\texttt{exp10}) \\\\
\\midrule
\\multicolumn{4}{@{}l}{\\emph{Cached-TRUE stratum figures}} \\\\
\\minoritySingle & formatting v1$\\to$v2 & cached-TRUE rows of the vector & single fresh draw against the cache (\\texttt{exp4}) \\\\
\\minorityVote & formatting v1$\\to$v2 & same & vote-of-3 on both sides (\\texttt{exp4}) \\\\
\\minorityVoteRerun & formatting v1$\\to$v2 & same & vote-of-3 on both sides, recomputed from the three-draw labels of a separate run (\\texttt{exp10}) \\\\
\\votedTrueFloor & identity & \\votedTrueN\\ rows whose three-draw v1 majority is TRUE & the stored v1 value against that majority: the floor of a cache built by vote (\\texttt{exp10}) \\\\
\\votedTrueEditFlip & formatting v1$\\to$v2 & same & each fresh v2 draw against that majority (\\texttt{exp10}) \\\\
\\wideningTrueFlip & widening v1$\\to$v2, production column & \\wideningTrueN\\ cached-TRUE rows & single fresh draw against the cache (Wilson \\wideningTrueCi) \\\\
\\aggFtSubgroup & formatting v1$\\to$v2 & cached-TRUE cells B2 reused at $\\alpha{=}0.1$ & realized error among the cells the aggregate-only baseline reused, an adversely selected subset, not a population rate (\\texttt{exp7}) \\\\
\\aggFsubgroup & formatting v1$\\to$v2 & same at $\\alpha{=}0.2$ & same (\\texttt{exp7}) \\\\
\\aggWsubgroup & widening v1$\\to$v2, production column & cached-TRUE cells B2 reused at $\\alpha{=}0.2$ & same (\\texttt{exp7}) \\\\
\\bottomrule
\\end{tabular}
`,
);

// ---------------------------------------------------------------------------
// Free-text pilot (exp19): judge-based equivalence, the judge's miss rate
// calibrated on hand labels and folded into alpha. The macros exist only
// once the labels have been applied; the paragraph that cites them is gated.
// ---------------------------------------------------------------------------
type Exp19Sweep = { alpha: number; alphaEffective: number; certifiedStrata: string[]; sampled: number; reused: number; savings: number; realizedJudge: number | null };
type Exp19 = {
  model: string;
  judge: string;
  adjudicator: string;
    ranAt: string;
  adjudicatedAt?: string;
  n: number;
  categories: string[];
  deltaCal: number;
    draws: Record<string, Array<string | null>>;
  calibration: Array<{ comparison: string; judge: boolean | null; human?: string | null; adjudicator?: boolean | null }>;
  calibrationSummary: {
    labeledJudgeSame: number;
    missesAmongJudgeSame: number;
    missUcbConditional: number | null;
    labeledJudgeDifferent: number;
    falseFlipsAmongJudgeDifferent: number;
    humanLabeled: number;
    adjudicatorVsHuman: { n: number; agree: number; rate: number | null };
    judgeVsHuman: { n: number; agree: number; rate: number | null };
  };
  results: Record<string, { usable: number; judgeFlips: number; judgeFlipRate: number; wilson95: [number, number]; judgeSameShare: number; missBound: number | null; sweeps: Record<string, Exp19Sweep> }>;
};
def("pilotAvailable", pilotReady ? "1" : "0");
if (pilotReady && exp19) {
  const cs = exp19.calibrationSummary;
  const wil = (w: [number, number]) => `[${(w[0] * 100).toFixed(1)}, ${(w[1] * 100).toFixed(1)}]`;
  const res = (name: string) => {
    const r = exp19.results[name];
    if (!r) throw new Error(`exp19 has no comparison ${name}`);
    return r;
  };
  def("pilotRows", num(exp19.n));
  def("pilotJudgeModel", `\\texttt{${exp19.judge.replace(/_/g, "\\_")}}`);
  def("pilotAdjudicator", `\\texttt{${exp19.adjudicator.replace(/_/g, "\\_")}}`);
  def("pilotCategories", String(exp19.categories.length));
  def("pilotDeltaCal", pct(exp19.deltaCal, 0));
  def("pilotFloorRate", pct(res("floor").judgeFlipRate, 1));
  def("pilotFloorCi", wil(res("floor").wilson95));
  def("pilotFmtRate", pct(res("formatting").judgeFlipRate, 1));
  def("pilotFmtCi", wil(res("formatting").wilson95));
  def("pilotSynRate", pct(res("synonym").judgeFlipRate, 1));
  def("pilotSynCi", wil(res("synonym").wilson95));
    def("pilotFloorUsable", num(res("floor").usable));
  def("pilotFmtUsable", num(res("formatting").usable));
  def("pilotSynUsable", num(res("synonym").usable));
  def("pilotLabeled", String(cs.humanLabeled));
  def("pilotLabeledSame", String(cs.labeledJudgeSame));
  def("pilotMisses", String(cs.missesAmongJudgeSame));
  def("pilotMissUcb", pct(cs.missUcbConditional ?? 0, 1));
  def("pilotLabeledDiff", String(cs.labeledJudgeDifferent));
  def("pilotFalseFlips", String(cs.falseFlipsAmongJudgeDifferent));
  def("pilotAdjAgree", pct(cs.adjudicatorVsHuman.rate ?? 0, 1));
  def("pilotJudgeAgree", pct(cs.judgeVsHuman.rate ?? 0, 1));
      {
    // The pooled bound against each comparison's own labels, the second
    // labeler's verdicts on the judge-equivalent pairs, and the budgets the
    // deflation leaves.
    const calE = exp19.calibration;
    const labeled = (x: { human?: string | null }) => x.human === "SAME" || x.human === "DIFFERENT";
    const byComp = ["floor", "formatting", "synonym"].map((c) => {
      const same = calE.filter((x) => x.comparison === c && x.judge === true && labeled(x));
      return { c, n: same.length, misses: same.filter((x) => x.human === "DIFFERENT").length };
    });
    def("pilotLabeledSamePerComparison", [...new Set(byComp.map((b) => b.n))].join("/"));
    def("pilotMissUcbPerComparison", pct(Math.max(...byComp.map((b) => cpUpper(b.misses, b.n, exp19.deltaCal))), 1));
    const adjMissOnSame = calE.filter((x) => x.judge === true && labeled(x) && x.adjudicator === false).length;
    def("pilotAdjMissesOnJudgeSame", String(adjMissOnSame));
    def("pilotAdjMissUcb", pct(cpUpper(adjMissOnSame, cs.labeledJudgeSame, exp19.deltaCal), 1));
    // The deflation is a subtraction from alpha, so it is quoted in percentage points.
    def("pilotMissUcbPts", ((cs.missUcbConditional ?? 0) * 100).toFixed(1));
    def("pilotAdjMissUcbPts", (cpUpper(adjMissOnSame, cs.labeledJudgeSame, exp19.deltaCal) * 100).toFixed(1));
    def("pilotAdjDiffOnJudgeDiff", String(calE.filter((x) => x.judge === false && labeled(x) && x.adjudicator === false).length));
    // The prose says the second labeler's bound leaves nothing of the tight budget.
    if (!(cpUpper(adjMissOnSame, cs.labeledJudgeSame, exp19.deltaCal) > 0.1)) {
      throw new Error("pilot: the second labeler's miss bound no longer exceeds the tight budget; rewrite the sentence");
    }
    const eff = (key: string) => {
      const s = res("formatting").sweeps[key];
      if (!s) throw new Error(`exp19 formatting has no sweep ${key}`);
      return s.alphaEffective.toFixed(3);
    };
    def("pilotAlphaLooseEff", eff("category@0.2:calibrated"));
    def("pilotAlphaTightEff", eff("category@0.1:calibrated"));
  }
  {
    // What the labels say the judge's verdicts are worth: the share of
    // judge-DIFFERENT pairs a reader also calls different, and of
    // judge-equivalent pairs a reader calls different, applied to the
    // judge's floor. A label-weighted estimate, not a certificate; the band
    // takes the Wilson limits of the two shares.
    const confirmed = cs.labeledJudgeDifferent - cs.falseFlipsAmongJudgeDifferent;
    const pD = confirmed / cs.labeledJudgeDifferent;
    const pS = cs.missesAmongJudgeSame / cs.labeledJudgeSame;
    const [pDlo, pDhi] = wilsonInterval(confirmed, cs.labeledJudgeDifferent);
    const [, pShi] = wilsonInterval(cs.missesAmongJudgeSame, cs.labeledJudgeSame);
    const F = res("floor").judgeFlipRate;
    def("pilotImpliedFloor", pct(F * pD + (1 - F) * pS, 1));
    def("pilotImpliedFloorBand", `[${(F * pDlo * 100).toFixed(1)}, ${((F * pDhi + (1 - F) * pShi) * 100).toFixed(1)}]\\%`);
  }
  const outcome = (name: string, key: string) => {
    const s = res(name).sweeps[key];
        if (!s) throw new Error(`exp19 ${name} has no sweep ${key}`);
    if (s.alphaEffective <= 0) return "is not attempted, since the deflation alone exceeds the budget";
    return s.certifiedStrata.length > 0
      ? `certifies ${pct(s.savings, 1)} savings (realized judge-scored error ${s.realizedJudge === null ? "--" : pct(s.realizedJudge, 2)}, ${s.sampled} oracle calls)`
      : `is refused on every stratum after ${s.sampled} oracle calls`;
  };
  // One sentence for the four calibrated runs. When every run refuses every
  // stratum after the same number of calls, say so once instead of four
  // times; otherwise spell the four outcomes out.
  const runs: Array<[string, string, string]> = [
    ["formatting", "category@0.2:calibrated", "0.2"],
    ["formatting", "category@0.1:calibrated", "0.1"],
    ["synonym", "category@0.2:calibrated", "0.2"],
    ["synonym", "category@0.1:calibrated", "0.1"],
  ];
  const sweeps = runs.map(([n, k]) => res(n).sweeps[k]);
  const allRefused = sweeps.every((s) => s && s.alphaEffective > 0 && s.certifiedStrata.length === 0);
  const sameCalls = allRefused && sweeps.every((s) => s.sampled === sweeps[0].sampled);
  const nCategories = (exp19.categories as string[]).length;
  const firstLookOnly = sameCalls && sweeps[0].sampled === nCategories * 45;
  // "Pilot outcome and reading" says the certifier refused every stratum.
  if (!allRefused) throw new Error("the pilot no longer refuses every stratum; rewrite the pilot's reading in body.tex");
  def(
    "pilotOutcomes",
    sameCalls
      ? `both edits are refused on every stratum at both budgets, each run stopping after ${num(sweeps[0].sampled)} oracle calls${firstLookOnly ? " (every stratum at its first look)" : ""}`
      : `the formatting edit ${outcome("formatting", "category@0.2:calibrated")} at $\\alpha{=}0.2$ and ${outcome("formatting", "category@0.1:calibrated")} at $\\alpha{=}0.1$; the synonym edit ${outcome("synonym", "category@0.2:calibrated")} at $\\alpha{=}0.2$ and ${outcome("synonym", "category@0.1:calibrated")} at $\\alpha{=}0.1$`,
  );
}

// ---------------------------------------------------------------------------
// Model identifiers and run dates, one row per model the paper uses.
// ---------------------------------------------------------------------------
{
  const fmt = fmtRunDate;
  const pairsOf = (model: string) => {
    const has18 = exp18Files.filter((f) => (J(f) as { model: string }).model === model);
    const sets = new Set(has18.map((f) => (J(f) as { pairset: string }).pairset));
    return sets.has("widening") && sets.has("djinni") ? "all five pairs" : sets.size > 0 ? "lab pairs and part of the rest" : "lab column's two pairs";
  };
  const priceOf = (m: string) => {
    const p = prices.models[m];
    if (!p) return "--";
    const perM = (x: number) => (x * 1e6).toFixed(2).replace(/\\.?0+$/, "");
    return `${perM(p.inputPerToken)} / ${perM(p.outputPerToken)}`;
  };
  const rowsM: string[] = [
    `\\texttt{deepseek/deepseek-v4-flash-0731} & primary model: every cell of the main program, the deployment run, the drift and independence checks${pilotReady ? ", the free-text pilot's cells and its judge" : ""} & \\ledgerStart\\ to \\ledgerEnd; \\sepSnapshotDate${exp17ext ? "; \\indepExtDate" : ""} & ${priceOf("deepseek/deepseek-v4-flash-0731")} \\\\`,
    `\\texttt{openai/text-embedding-3-small} & embedding proxy (baselines B1, B3; interaction stratifier) & with the main program & ${priceOf("openai/text-embedding-3-small")} \\\\`,
  ];
  for (const f of FAMILIES) {
    const d = J(f.file) as { model: string };
    const dates = [
      ...new Set(
        [f.file, ...exp18Files.filter((x) => (J(x) as { model: string }).model === d.model)]
          .map((x) => String((J(x) as { ranAt: string }).ranAt))
          .sort()
          .map((iso) => fmt(iso)),
      ),
    ].join("; ");
    rowsM.push(`\\texttt{${d.model.replace(/_/g, "\\_")}} & model study, ${pairsOf(d.model)} & ${dates} & ${priceOf(d.model)} \\\\`);
  }
  if (!nanoPromoted) {
    rowsM.push(`\\texttt{${String(exp12.model).replace(/_/g, "\\_")}} & earlier probe, formatting pair only ($n{=}\\altModelN$) & August 2026 & ${priceOf(String(exp12.model))} \\\\`);
  }
  if (pilotReady && exp19) {
    rowsM.push(`\\texttt{${exp19.adjudicator.replace(/_/g, "\\_")}} & free-text pilot: second labeler of the calibration pairs, reported beside the hand labels & ${fmt(exp19.adjudicatedAt ?? exp19.ranAt)} & ${priceOf(exp19.adjudicator)} \\\\`);
  }
  writeFileSync(
    "paper/tablemodels.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts. Do not edit by hand.
\\begin{tabular}{@{}lp{5.6cm}p{3.6cm}r@{}}
\\toprule
Gateway identifier & Role & Run dates & \\$/M tokens in / out \\\\
\\midrule
${rowsM.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
}

// ---------------------------------------------------------------------------
// Deployment table: the same sample path under three (snapshot, bound)
// regimes at three budgets.
// ---------------------------------------------------------------------------
{
  const fmtRow = (label: string, w: W11c | { status: string; missingFreshDraws?: number } | undefined, applied = false) => {
    if (!w || w.status !== "ok") {
      const m = (w as { missingFreshDraws?: number } | undefined)?.missingFreshDraws;
      return `${label} & \\multicolumn{5}{l}{not reachable from the stored draws${m ? ` (${num(m)} further draws needed)` : ""}} \\\\`;
    }
    const x = w as W11c & { gtOverlapFlips: number };
    const f = x.strata.find((s) => s.stratumId.startsWith("v=false"))!;
    const audit = x.realizedOnOverlap === null ? "--" : `${pct(x.realizedOnOverlap, 2)} (${num(x.gtOverlapFlips)}/${num(x.gtOverlapReused)})`;
    return `${label} & ${num(x.oracleCalls)} & ${num(f.sampled)} / ${f.flips}${f.certified ? "" : " (refused)"} & ${num(x.reused)} & ${pct(x.savings, 1)} & ${audit}${applied ? " (applied)" : ""} \\\\`;
  };
  const find = (file: { sweeps: W11c[] }, bound: string, alpha: number) =>
    file.sweeps.find((s) => s.bound === bound && Math.abs(s.alpha - alpha) < 1e-9) as W11c | undefined;
  // The main table carries the exact bound only, the bound Theorem 1 covers.
  // The Maurer--Pontil rows (the certificate the system applied in August,
  // and the same bound on the September draws) go to an appendix table.
  const lines = [
    `\\multicolumn{6}{@{}l}{\\emph{August 2026 snapshot: the stored oracle draws of the live run, replayed}} \\\\`,
    fmtRow("$\\alpha{=}0.2$", find(exp11c, "exact", 0.2)),
    fmtRow("$\\alpha{=}0.1$", find(exp11c, "exact", 0.1)),
    fmtRow("$\\alpha{=}0.05$", find(exp11c, "exact", 0.05)),
    `\\midrule`,
    `\\multicolumn{6}{@{}l}{\\emph{September 2026 snapshot: oracle drawn live, same cache}} \\\\`,
    fmtRow("$\\alpha{=}0.2$", find(exp11cSep, "exact", 0.2)),
    fmtRow("$\\alpha{=}0.1$", find(exp11cSep, "exact", 0.1)),
    fmtRow("$\\alpha{=}0.05$", find(exp11cSep, "exact", 0.05)),
  ];
  const linesMp = [
    `\\multicolumn{6}{@{}l}{\\emph{August 2026 snapshot: the live run}} \\\\`,
    fmtRow("$\\alpha{=}0.2$", find(exp11c, "eb", 0.2), true),
    fmtRow("$\\alpha{=}0.1$", find(exp11c, "eb", 0.1)),
    `\\midrule`,
    `\\multicolumn{6}{@{}l}{\\emph{September 2026 snapshot: the draws of Table~\\ref{tab:deploy}}} \\\\`,
    fmtRow("$\\alpha{=}0.2$", find(exp11cSep, "eb", 0.2)),
    fmtRow("$\\alpha{=}0.1$", find(exp11cSep, "eb", 0.1)),
  ];
  const deployTable = (file: string, rows: string[]) =>
    writeFileSync(
      file,
      `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp11c-deployment-bounds.json
% and exp11c-deployment-bounds-v4.json. Do not edit by hand.
\\begin{tabular}{@{}lrrrrr@{}}
\\toprule
Budget & oracle calls & FALSE look / flips & reused & savings & audited error (flips/rows) \\\\
\\midrule
${rows.join("\n")}
\\bottomrule
\\end{tabular}
`,
    );
  deployTable("paper/tabledeploy.tex", lines);
  deployTable("paper/tabledeploymp.tex", linesMp);
}

// ---------------------------------------------------------------------------
// A graded relation on the ordinal select column, re-scored from the released
// labels (exp8 with EXP_EQUIV=adjacent-tier): adjacent tiers are taken as
// equivalent, so a flip is a fresh value more than one tier from the cached
// one. No model call. The prose states that the formatting edit certifies in
// every replication at alpha = 0.05, where exact match certifies in none,
// and that the tolerance is the wrong relation for the criteria edit, whose
// purpose is a one-tier move: nearly all of its flips are one-tier moves.
// ---------------------------------------------------------------------------
{
  type G = { pair: string; alpha: number; estimand: string; n: number; trueFlipRate: number; bootstrap: { certificationRate: number; savingsMean: number; violationRatePresented: number } };
  const graded = J("exp8-graded.json") as { equivalence: string; results: G[] };
  if (graded.equivalence !== "adjacent-tier") throw new Error("exp8-graded.json is not the adjacent-tier re-score");
  const g = (pair: string, alpha: number) =>
    graded.results.find((r) => r.pair === pair && r.estimand === "presented" && Math.abs(r.alpha - alpha) < 1e-9)!;
  const e = (pair: string, alpha: number) =>
    (exp8.results as G[]).find((r) => r.pair === pair && r.estimand === "presented" && Math.abs(r.alpha - alpha) < 1e-9)!;
  for (const pair of ["dj-formatting"]) {
    const edge = g(pair, 0.05);
    if (!(edge.bootstrap.certificationRate === 1 && edge.bootstrap.violationRatePresented === 0)) {
      throw new Error(`graded ${pair}: no longer certified in every replication at alpha=0.05; rewrite the graded sentence in body.tex`);
    }
    if (e(pair, 0.05).bootstrap.certificationRate !== 0) {
      throw new Error(`exact-match ${pair} now certifies at alpha=0.05; rewrite the graded sentence in body.tex`);
    }
  }
  const flipsOf = (pair: string) => Math.round(g(pair, 0.05).trueFlipRate * g(pair, 0.05).n);
  def("gradedFlipsDjFmt", String(flipsOf("dj-formatting")));
  def("gradedSavingsEdgeDjFmt", pct(g("dj-formatting", 0.05).bootstrap.savingsMean, 1));
  // The criteria edit: how many of its exact-match flips are moves of one tier.
  {
    const exactFlips = Math.round(e("dj-criteria", 0.05).trueFlipRate * e("dj-criteria", 0.05).n);
    const oneTier = exactFlips - flipsOf("dj-criteria");
    if (!(oneTier / exactFlips > 0.9)) throw new Error("fewer than nine in ten of the criteria edit's flips are one-tier moves; rewrite the graded paragraph in body.tex");
    def("gradedCritExactFlips", String(exactFlips));
    def("gradedCritOneTier", String(oneTier));
  }
}

// ---------------------------------------------------------------------------
// The strata of the five pairs, from the released labels: cells and flip rate
// by cached value. The procedure's unit of decision is the stratum, so the
// table shows what each certificate or refusal in the main results is about.
// ---------------------------------------------------------------------------
{
  type LP = { key: string; cached: unknown[]; fresh: unknown[]; outputSpec?: { options?: string[] } };
  const labels = J("benchmark-labels.json") as { pairs: LP[] };
  const lines: string[] = [];
  const rateOf: Record<string, Record<string, { n: number; k: number }>> = {};
  for (const key of Object.keys(LABELS)) {
    const pr = labels.pairs.find((x) => x.key === key);
    if (!pr) throw new Error(`benchmark-labels.json has no pair ${key}`);
    const strata = new Map<string, { n: number; k: number }>();
    pr.cached.forEach((c, i) => {
      const f = pr.fresh[i];
      if (c === null || f === null || c === undefined || f === undefined) return;
      const v = String(c);
      const s = strata.get(v) ?? { n: 0, k: 0 };
      s.n++;
      if (JSON.stringify(c) !== JSON.stringify(f)) s.k++;
      strata.set(v, s);
    });
    // Booleans as FALSE then TRUE; select options in their declared order.
    const order = pr.outputSpec?.options ?? ["false", "true"];
    const total = [...strata.values()].reduce((a, s) => a + s.n, 0);
    const flips = [...strata.values()].reduce((a, s) => a + s.k, 0);
    const main = pick(key, 0.2);
    if (total !== main.n || Math.abs(flips / total - main.trueFlipRate) > 1e-9) {
      throw new Error(`the released labels of ${key} (${flips}/${total}) do not reproduce the main table's flip rate`);
    }
    rateOf[key] = {};
    order.forEach((v, i) => {
      const s = strata.get(v);
      if (!s) throw new Error(`pair ${key} has no cells cached as ${v}`);
      rateOf[key]![v] = s;
      const name = v === "true" ? "TRUE" : v === "false" ? "FALSE" : v;
      lines.push(`${i === 0 ? LABELS[key] : ""} & ${name} & ${num(s.n)} & ${num(s.k)} & ${pct(s.k / s.n, 1)} \\\\`);
    });
    if (key !== Object.keys(LABELS).at(-1)) lines.push("\\addlinespace");
  }
  writeFileSync(
    "paper/tablestrata.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from benchmark-labels.json. Do not edit by hand.
\\begin{tabular}{@{}llrrr@{}}
\\toprule
Edit & cached value & cells & flips & flip rate \\\\
\\midrule
${lines.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
  // The reading of this table in the main results.
  const boolPairs = ["so-formatting", "so-synonym", "so-widening"];
  const reading: Array<[string, boolean]> = [
    ["on the Boolean columns the cached-FALSE stratum holds about nine cells in ten", boolPairs.every((k) => { const f = rateOf[k]!.false!; const t = rateOf[k]!.true!; return f.n / (f.n + t.n) > 0.88 && f.n / (f.n + t.n) < 0.93; })],
    ["the cached-FALSE strata flip at a few percent", boolPairs.every((k) => rateOf[k]!.false!.k / rateOf[k]!.false!.n < 0.07)],
    ["the cached-TRUE strata flip at a third or more", boolPairs.every((k) => rateOf[k]!.true!.k / rateOf[k]!.true!.n >= 1 / 3)],
    ["on the select column the Junior tier flips least, below the tight budget", ["dj-formatting", "dj-criteria"].every((k) => { const r = rateOf[k]!; const j = r.Junior!.k / r.Junior!.n; return j < 0.1 && Object.entries(r).every(([v, s]) => v === "Junior" || s.k / s.n > j); })],
    ["the other three tiers flip at rates between the two headline budgets", ["dj-formatting", "dj-criteria"].every((k) => Object.entries(rateOf[k]!).every(([v, s]) => v === "Junior" || (s.k / s.n > 0.1 && s.k / s.n < 0.2)))],
  ];
  for (const [name, ok] of reading) {
    if (!ok) throw new Error(`strata table: "${name}" no longer holds; rewrite the sentence in the main results`);
  }
}

// ---------------------------------------------------------------------------
// The strict mode beside the default mode on every configuration that either
// certifies (appendix table): certification rate, mean savings, and the
// strict mode's own unsafe certificates (reuse-set rate above the budget).
// ---------------------------------------------------------------------------
{
  type RS = { pair: string; alpha: number; estimand: string; bootstrap: { certificationRate: number; savingsMean: number; violationRateReuseSet: number; unsafeCertificateRate?: number } };
  const all = exp8.results as RS[];
  const at = (pair: string, alpha: number, estimand: string) => all.find((r) => r.pair === pair && r.estimand === estimand && Math.abs(r.alpha - alpha) < 1e-9)!;
  const one = (x: number) => (x * 100).toFixed(1);
  const lines: string[] = [];
  // The table holds "the three budgets where either mode certifies"; the
  // budget it leaves out must be one at which neither ever does.
  const tabulated = [0.05, 0.1, 0.2];
  for (const r of all) {
    if (tabulated.some((a) => Math.abs(a - r.alpha) < 1e-9)) continue;
    if (r.bootstrap.certificationRate > 0) {
      throw new Error(`the strict-mode table omits alpha=${r.alpha}, where ${r.pair} certifies (${r.estimand}); add the budget or rewrite "the three budgets where either certifies"`);
    }
  }
  for (const pair of Object.keys(LABELS)) {
    for (const alpha of tabulated) {
      const d = at(pair, alpha, "presented").bootstrap;
      const st = at(pair, alpha, "reuse-set").bootstrap;
      if (st.unsafeCertificateRate === undefined) throw new Error("exp8-final-table.json lacks the per-stratum unsafe-certificate rate; re-run exp8-final-table.ts");
      lines.push(`${LABELS[pair]} & ${alpha.toFixed(2)} & ${one(d.certificationRate)} & ${one(d.savingsMean)} & ${one(st.certificationRate)} & ${one(st.savingsMean)} & ${one(st.unsafeCertificateRate)} \\\\`);
    }
  }
  writeFileSync(
    "paper/tablestrict.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp8-final-table.json. Do not edit by hand.
\\begin{tabular}{@{}lr rr rrr@{}}
\\toprule
 & & \\multicolumn{2}{c}{default mode} & \\multicolumn{3}{c}{strict mode} \\\\
\\cmidrule(lr){3-4}\\cmidrule(lr){5-7}
Edit & $\\alpha$ & cert. & savings & cert. & savings & unsafe \\\\
\\midrule
${lines.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
  // The two relations the main text states of the select column in strict mode.
  for (const pair of ["dj-formatting", "dj-criteria"]) {
    if (!(at(pair, 0.2, "reuse-set").bootstrap.savingsMean < (2 / 3) * at(pair, 0.2, "presented").bootstrap.savingsMean)) {
      throw new Error(`strict mode on ${pair} at 0.2 no longer cuts mean savings by more than a third; rewrite the strict-mode paragraph in body.tex`);
    }
  }
}

// ---------------------------------------------------------------------------
// What each budget tolerates and what it buys (Limitations table): the cells
// a budget tolerates in the corpus-scale cached-FALSE stratum, the live
// September certification at that budget, and the benchmark's certification
// rate and mean savings for the formatting-only edit on both column types.
// ---------------------------------------------------------------------------
{
  type RB = { pair: string; alpha: number; estimand: string; bootstrap: { certificationRate: number; savingsMean: number } };
  const all = exp8.results as RB[];
  const cell = (pair: string, alpha: number, estimand: string) => {
    const b = all.find((r) => r.pair === pair && r.estimand === estimand && Math.abs(r.alpha - alpha) < 1e-9)!.bootstrap;
    return `${(b.certificationRate * 100).toFixed(1)} & ${(b.savingsMean * 100).toFixed(1)}`;
  };
  const falseSize = mpF2.size;
  const positives = Number(refused.size);
  const sepArm: Record<string, W11c> = { "0.2": sx2, "0.1": sx1, "0.05": sx05 };
  const lines = [0.2, 0.1, 0.05].map((alpha) => {
    const tolerated = Math.floor(alpha * falseSize + 1e-9);
    const w = sepArm[String(alpha)]!;
    const certified = w.strata.some((st) => st.certified);
    const run = certified
      ? `${num(w.oracleCalls)} & ${num(w.reused)} & ${pct(w.realizedOnOverlap ?? 0, 2)}`
      : `${num(w.oracleCalls)} & refused & --`;
    return `$\\alpha{=}${alpha}$ & ${num(tolerated)} & ${(tolerated / positives).toFixed(1)} & ${run} & ${cell("so-formatting", alpha, "presented")} & ${cell("so-formatting", alpha, "reuse-set")} & ${cell("dj-formatting", alpha, "presented")} \\\\`;
  });
  writeFileSync(
    "paper/tablebudgets.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp8-final-table.json and
% exp11c-deployment-bounds-v4.json. Do not edit by hand.
\\begin{tabular}{@{}l rr rrr rr rr rr@{}}
\\toprule
 & \\multicolumn{2}{c}{tolerated, corpus scale} & \\multicolumn{3}{c}{corpus-scale run (September)} & \\multicolumn{2}{c}{Boolean, default} & \\multicolumn{2}{c}{Boolean, strict} & \\multicolumn{2}{c}{select, default} \\\\
\\cmidrule(lr){2-3}\\cmidrule(lr){4-6}\\cmidrule(lr){7-8}\\cmidrule(lr){9-10}\\cmidrule(lr){11-12}
Budget & cells & $\\times$ TRUE rows & calls & reused & audited & cert. & savings & cert. & savings & cert. & savings \\\\
\\midrule
${lines.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
  // Audited error rates carried to the whole reuse set: the hidden positives
  // a certificate's reused cells would hold if the audited rows are typical.
  const hidden = (w: W11c) => Math.round(((w.realizedOnOverlap ?? 0) * w.reused) / 100) * 100;
  def("deployHiddenLoose", num(hidden(dx2)));
  def("sepHiddenLoose", num(hidden(sx2)));
  // An audit is a sample of the reused cells, so the extrapolation carries
  // its sampling error: the Wilson interval of the audited rate, carried to
  // the reuse set in the same way.
  const hiddenRange = (w: W11c) => {
    const rows = w.gtOverlapReused;
    const [lo, hi] = wilsonInterval(Math.round((w.realizedOnOverlap ?? 0) * rows), rows);
    const hundreds = (x: number) => Math.round((x * w.reused) / 100) * 100;
    return [hundreds(lo), hundreds(hi)] as const;
  };
  const [dLo, dHi] = hiddenRange(dx2);
  const [sLo, sHi] = hiddenRange(sx2);
  if (!(dHi < sLo)) throw new Error("the August and September hidden-positive intervals now overlap; rewrite the limitations paragraph, which sets them apart");
  def("deployHiddenLooseLo", num(dLo));
  def("deployHiddenLooseHi", num(dHi));
  def("sepHiddenLooseLo", num(sLo));
  def("sepHiddenLooseHi", num(sHi));
  // The reading the limitations paragraph gives of this table.
  const b = (pair: string, alpha: number, estimand: string) => all.find((r) => r.pair === pair && r.estimand === estimand && Math.abs(r.alpha - alpha) < 1e-9)!.bootstrap;
  const reading: Array<[string, boolean]> = [
    ["the tight budget tolerates more cells than the column marks TRUE", Math.floor(0.1 * falseSize + 1e-9) > positives],
    ["at 0.05 the Boolean column certifies in most replications for less than half the loose budget's savings", b("so-formatting", 0.05, "presented").certificationRate > 0.5 && b("so-formatting", 0.05, "presented").savingsMean < 0.5 * b("so-formatting", 0.2, "presented").savingsMean],
    ["at 0.05 the strict mode certifies almost never", b("so-formatting", 0.05, "reuse-set").certificationRate < 0.05],
    ["the select column certifies nothing below 0.1 and little at it", b("dj-formatting", 0.05, "presented").certificationRate === 0 && b("dj-criteria", 0.05, "presented").certificationRate === 0 && b("dj-formatting", 0.1, "presented").savingsMean < 1 / 6 && b("dj-criteria", 0.1, "presented").savingsMean < 1 / 6],
    ["the September audit extrapolates to fewer hidden positives than the loose budget tolerates and more than the August one", hidden(sx2) < Math.floor(0.2 * falseSize) && hidden(sx2) > hidden(dx2)],
  ];
  for (const [name, ok] of reading) {
    if (!ok) throw new Error(`usable budgets: "${name}" no longer holds; rewrite the limitations paragraph in body.tex`);
  }
}

// ---------------------------------------------------------------------------
// The exact error probability at the least favourable population (exp9b),
// per (budget, stratum size) cell of the calibration grid, both modes.
// ---------------------------------------------------------------------------
{
  type Cell = { alpha: number; size: number; presented: { leastFavourableCount: number; unsafeProbability: number }; reuseSet: { unsafeProbability: number } };
  const b = J("exp9b-boundary.json") as { cells: Cell[] };
  const sizes = [...new Set(b.cells.map((c) => c.size))].sort((x, y) => x - y);
  const alphas = [...new Set(b.cells.map((c) => c.alpha))].sort((x, y) => x - y);
  const at = (alpha: number, size: number) => b.cells.find((c) => c.alpha === alpha && c.size === size)!;
  // Printed to two decimals and rounded up, as upper bounds are.
  const lines = alphas.map(
    (alpha) =>
      `$\\alpha{=}${alpha}$ & ${sizes.map((n) => pctCeil(at(alpha, n).presented.unsafeProbability, 2)).join(" & ")} & ${sizes.map((n) => pctCeil(at(alpha, n).reuseSet.unsafeProbability, 2)).join(" & ")} \\\\`,
  );
  writeFileSync(
    "paper/tableboundary.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp9b-boundary.json. Do not edit by hand.
\\begin{tabular}{@{}l ${sizes.map(() => "r").join("")} ${sizes.map(() => "r").join("")}@{}}
\\toprule
 & \\multicolumn{${sizes.length}}{c}{default mode, $n_j$} & \\multicolumn{${sizes.length}}{c}{strict mode, $n_j$} \\\\
\\cmidrule(lr){2-${1 + sizes.length}}\\cmidrule(lr){${2 + sizes.length}-${1 + 2 * sizes.length}}
Budget & ${sizes.map((n) => `$${num(n)}$`).join(" & ")} & ${sizes.map((n) => `$${num(n)}$`).join(" & ")} \\\\
\\midrule
${lines.join("\n")}
\\bottomrule
\\end{tabular}
`,
  );
}

writeFileSync(
  "paper/macros.tex",
  `% GENERATED by scripts/experiments/gen-paper-assets.ts. Do not edit.
% Every number cited in prose is defined here from result artifacts.
${macros.join("\n")}
`,
);
console.log(`ASSETS_OK: ${texRows.length} table rows, ${macros.length} macros`);
process.exit(0);
