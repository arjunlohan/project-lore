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
} from "@lore/core/sivm";
import mysql from "mysql2/promise";
import { PAIRS } from "./pairs";

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
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}\\%`;
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
      pct(r.trueFlipRate),
      num(m.sampled),
      cert ? num(m.reused) : "0",
      cert ? pct(m.realizedPresented, 2) : "--",
      cert
        ? `${(m.realizedReuse * 100).toFixed(2)} [${(((b as unknown as {realizedReuseCiLo:number}).realizedReuseCiLo) * 100).toFixed(1)},${(((b as unknown as {realizedReuseCiHi:number}).realizedReuseCiHi) * 100).toFixed(1)}]`
        : "--",
      `${(b.savingsMean * 100).toFixed(1)} [${((b as unknown as {savingsLo:number}).savingsLo * 100).toFixed(1)},${((b as unknown as {savingsHi:number}).savingsHi * 100).toFixed(1)}]`,
      `${(b.certificationRate * 100).toFixed(0)}\\%`,
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
Edit & $\\alpha$ & flip & oracle & reused & FR$_{\\text{pres}}$ & FR$_{\\text{reuse}}$ [95\\% CI] & savings \\% [95\\% PI] & cert. & exceed. \\\\
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
      .map(
        (r) =>
          `(${r.alpha},${(r.bootstrap.savingsMean * 100).toFixed(1)}) +- (0,${(r.bootstrap.savingsSd * 100).toFixed(1)})`,
      )
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
    return `\\addplot coordinates { ${pts} }; \\addlegendentry{$n_j{=}${size}$}`;
  })
  .join(" ");
writeFileSync(
  "paper/figdata.tex",
  `% GENERATED. Do not edit.
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
await dbf.end();
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
  const pairs: Array<[boolean | null, boolean | null]> = [];
  for (let i = 0; i < r.d1.length; i++)
    for (let j = i + 1; j < r.d1.length; j++) pairs.push([r.d1[i]!, r.d1[j]!]);
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
  const gap = Math.abs(
    Math.round(t1.trueFlipRate * t1.n) -
      Math.round(exp10.singleDrawFlipRate * exp10.n),
  );
  def("flipInstrumentGapRows", String(gap));
}
def("floorSelect", pct(exp0b.selfFlipRate, 1));
def("floorDefaultT", pct(exp0.regimes["default-T"].selfFlipRate, 1));
def("floorTzeroProbe", pct(exp0.regimes["T0"].selfFlipRate, 1));

// Edit flip rates
def("flipSoFormatting", pct(pick("so-formatting", 0.2).trueFlipRate));
def("flipSoSynonym", pct(pick("so-synonym", 0.2).trueFlipRate, 1));
def("flipSoWidening", pct(pick("so-widening", 0.2).trueFlipRate, 1));
def("flipDjFormatting", pct(pick("dj-formatting", 0.2).trueFlipRate, 1));
def("flipDjCriteria", pct(pick("dj-criteria", 0.2).trueFlipRate, 1));

// Benchmark headline (n=2000)
const bench = pick("so-formatting", 0.2);
def("benchN", num(bench.n));
def("benchSavings", `${(bench.bootstrap.savingsMean * 100).toFixed(1)}\\%`);
def("benchSavingsMain", ratioPct(bench.main.reused, bench.n, 1));
const bci = bench.bootstrap as unknown as {
  savingsLo: number; savingsHi: number;
  realizedReuseCiLo: number; realizedReuseCiHi: number; B: number;
};
def("benchSavingsPi", `[${(bci.savingsLo * 100).toFixed(1)}, ${(bci.savingsHi * 100).toFixed(1)}]`);
def("benchRealizedCi", `[${(bci.realizedReuseCiLo * 100).toFixed(1)}, ${(bci.realizedReuseCiHi * 100).toFixed(1)}]`);
def("bootB", num(bci.B));
def("benchRealized", pct(bench.main.realizedPresented, 2));
def("benchRealizedReuse", pct(bench.main.realizedReuse, 2));
def("benchOracleTight", String(pick("so-formatting", 0.1).main.sampled));
def("synTightCertRate", pct(pick("so-synonym", 0.1).bootstrap.certificationRate, 0));
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
// whose flip rate sits just above alpha). Report the worst unconditional
// rate, P(certify and realized presented-cells error > alpha), against the
// nominal delta, and every cell with nonzero reuse-set exceedance, instead
// of asserting that no such cell exists.
{
  type RV = Row8 & { bootstrap: Row8["bootstrap"] & { violationRatePresented: number } };
  const pres = rows as RV[];
  const unsafe = pres.map((r) => ({
    r,
    u: r.bootstrap.certificationRate * r.bootstrap.violationRatePresented,
  }));
  const worst = unsafe.reduce((a, b) => (b.u > a.u ? b : a));
  def("tableUnsafeWorst", pct(worst.u, 2));
  def("tableUnsafeWorstPair", LABELS[worst.r.pair] ?? worst.r.pair);
  def("tableUnsafeWorstAlpha", worst.r.alpha.toString());
  def("tableUnsafeWorstCert", pct(worst.r.bootstrap.certificationRate, 1));
  def("tableUnsafeWorstViol", pct(worst.r.bootstrap.violationRatePresented, 0));
  def("tableUnsafeConfigs", String(unsafe.filter((x) => x.u > 0).length));
  const exceed = pres.filter(
    (r) => r.bootstrap.certificationRate > 0 && r.bootstrap.violationRateReuseSet > 0,
  );
  def("tableExceedConfigs", String(exceed.length));
  def(
    "tableExceedList",
    exceed
      .map(
        (r) =>
          // The shares themselves are the exceed. and cert. columns of the
          // main table; the prose names the cells and points there.
          `${LABELS[r.pair] ?? r.pair} at $\\alpha{=}${r.alpha}$`,
      )
      .join("; "),
  );
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
  def("reuseSetSavingsMain", mean(at("so-formatting", 0.2)));
  def("reuseSetSavingsMainSeed", ratioPct(at("so-formatting", 0.2).main.reused, at("so-formatting", 0.2).n, 1));
  def("reuseSetSavingsTight", mean(at("so-formatting", 0.1)));
  def("reuseSetCertTight", cert(at("so-formatting", 0.1)));
  def("benchCertTight", cert(atD("so-formatting", 0.1)));
  def("reuseSetCertEdge", cert(at("so-formatting", 0.05)));
  def("reuseSetSynLoose", mean(at("so-synonym", 0.2)));
  def("reuseSetWidLoose", mean(at("so-widening", 0.2)));
  def("defaultSynLoose", mean(atD("so-synonym", 0.2)));
  def("defaultWidLoose", mean(atD("so-widening", 0.2)));
  def("reuseSetDjFmtCertLoose", cert(at("dj-formatting", 0.2)));
  def("reuseSetDjCritCertLoose", cert(at("dj-criteria", 0.2)));
  def("reuseSetDjFmtSavLoose", mean(at("dj-formatting", 0.2)));
  def("reuseSetDjCritSavLoose", mean(at("dj-criteria", 0.2)));
  def("defaultDjFmtSavLoose", mean(atD("dj-formatting", 0.2)));
  def("defaultDjCritSavLoose", mean(atD("dj-criteria", 0.2)));
  def(
    "reuseSetDjCertTightMax",
    pct(
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
    if (!ok) throw new Error(`strict-mode paragraph: relation no longer holds (${name}); rewrite the sentence in body.tex`);
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
  }
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
  def("ablationTies", String(total - better - worse));
  // Where the wins sit: the value-only certification rate they occur at,
  // and the largest of them, so the prose describes the wins it counts.
  if (wins.length === 0) throw new Error("stratifier ablation: no win to describe; rewrite the sentence in body.tex");
  const top = wins.reduce((a, w) => (w.fineMean - w.baseMean > a.fineMean - a.baseMean ? w : a));
  def("ablationWinBaseCertMax", pct(Math.max(...wins.map((w) => w.baseCert)), 1));
  def("ablationTopWinLabel", `${LABELS[top.pair] ?? top.pair} at $\\alpha{=}${top.alpha}$`);
  def("ablationTopWinFine", pct(top.fineMean, 1));
  def("ablationTopWinBase", pct(top.baseMean, 1));
  def("ablationTopWinFineCert", pct(top.fineCert, 1));
  def("ablationTopWinBaseCert", pct(top.baseCert, 1));
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

// exp4 minority stratum
def("minoritySingle", pct(exp4.singleShotFlipRate, 1));
def("minorityVote", pct(exp4.vote3FlipRate, 1));
def("minorityNoise", pct(1 - exp4.vote3ConfirmsStoredTrue, 1));

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
  def("calUnsafeWorst", pct(u, 2));
  def("calUnsafeWorstCi", `[${(wlo * 100).toFixed(2)}, ${(whi * 100).toFixed(2)}]\\%`);
  // The presented-cells event (a strict subset of the theorem's event), for
  // the reader who wants the user-facing quantity.
  const presentedWorst = cal.filter((r) => r.estimand === "presented").reduce((a, r) => Math.max(a, r.certificationRate * r.violationRatePresented), 0);
  def("calUnsafePresentedWorst", pct(presentedWorst, 2));
  def("calUnsafeWorstAlpha", worst.alpha.toString());
  def("calUnsafeWorstP", worst.p.toString());
  def("calUnsafeWorstSize", num(worst.size));
  def("calUnsafeWorstEstimand", worst.estimand === "presented" ? "presented-cells" : "reuse-set");
  def("calNominalDelta", pct(Number(exp9.perStratumDelta), 0));
  const tight = cal.filter((r) => r.p > r.alpha && r.p <= r.alpha * 1.3);
  def("calUnsafeTightMean", pct(tight.reduce((a, r) => a + unsafeOf(r), 0) / tight.length, 2));
  const tightCertWorst = tight.reduce((a, r) => Math.max(a, r.certificationRate), 0);
  def("calTightCertWorst", pct(tightCertWorst, 1));
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
def("sepLiveDraws", num(sepLive.liveCalls));
def("sepLiveRequested", num(sepLive.liveRequested));
def("sepLiveCached", num(sepLive.liveCached));
def("sepLedgerUsd", `\\$${sepLive.ledgerSpendDeltaUsd.toFixed(2)}`);
def("sepPerCell", `\\$${(sepLive.ledgerSpendDeltaUsd / sepLive.liveCalls).toFixed(5)}`);
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
  def("sepMpTightOutcome", smp1.status === "ok" && smp1.reused > 0 ? `certifies after ${num(smp1.oracleCalls)} calls` : smp1.status === "ok" ? `refuses after ${num(smp1.oracleCalls)} calls` : "is not reached");
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
def("perCellCost", `\\$${perCell.toFixed(5)}`);
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
const matHours = Number(lat.ms) / CONC / 3600000;
def("deployMatHours", matHours.toFixed(1));
def("deployConcurrency", String(CONC));
def("deployMatMeanLatencyS", (Number(lat.ms) / Number(lat.c) / 1e3).toFixed(1));
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
    def(`bound${tag}AtN`, at90[b]!.toFixed(3));
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
    def(`bound${tag}NullWorst`, pct(cal[b]!.worstNullCertificationRate, 1));
    if (b === "exact") def(`bound${tag}NullsOver`, String(cal[b]!.nullsExceedingDelta));
    def(`bound${tag}CleanSample`, String(Math.round(cal[b]!.avgSampledAtCleanBig)));
    // Theorem 1's event at planted nulls: certified AND realized count > alpha n.
    def(`bound${tag}NullUnsafe`, pct(nullUnsafe(b), 2));
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
Bound & $0/90$, $N{=}1800$ & $5/180$, $N{=}81469$ & certifying & mean savings & oracle calls & worst \\\\
\\midrule
${row("exact", "Exact finite-population (pinned)")}
${row("cp", "Clopper--Pearson (binomial)")}
${row("betting", "Betting confidence sequence")}
${row("eb", "Maurer--Pontil (earlier version)")}
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
  Number(exp0.n) * 2 +
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
      deploymentCertificate: {
        id: cert.id,
        reusedCount: Number(cert.reused_count),
        stampedCells: stampedAtApply,
        stampedCellsNow: Number(cert.stamped),
      },
      wideningTrue: wt,
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
// One cell per (pair, alpha): "refused (calls)" or "savings (realized)".
const outcome = (sw: Exp12["sweeps"] | undefined, alpha: number) => {
  const x = sw?.find((y) => Math.abs(y.alpha - alpha) < 1e-9);
  if (!x) return "--";
  if (x.certifiedStrata.length === 0) return `refused (${x.sampled})`;
  const err = x.realizedPresented === null ? "--" : pct(x.realizedPresented, 2);
  return `${pct(x.savings, 1)} (${err})`;
};
// Primary model row from the main-seed benchmark artifact (exp8), same
// pairs, same evaluation vector, so the table compares like with like.
{
  type R8 = { pair: string; alpha: number; estimand: string; n: number; trueFlipRate: number; main: { certifiedStrata: number; sampled: number; reused: number; realizedPresented: number; savings: number } };
  const r8 = (exp8.results as R8[]).filter((r) => r.estimand === "presented");
  const cell = (pair: string, alpha: number) => {
    const r = r8.find((x) => x.pair === pair && Math.abs(x.alpha - alpha) < 1e-9)!;
    return r.main.certifiedStrata === 0
      ? `refused (${num(r.main.sampled)})`
      : `${ratioPct(r.main.reused, r.n, 1)} (${pct(r.main.realizedPresented, 2)})`;
  };
  const fmtFlip = r8.find((x) => x.pair === "so-formatting")!.trueFlipRate;
  const synFlip = r8.find((x) => x.pair === "so-synonym")!.trueFlipRate;
  famRows.push(
    `DeepSeek V4 Flash (primary; main seed) & ${num(r8[0]!.n)} & ${pct(floorBoolValue, 1)} & ${pct(fmtFlip, 1)} & ${cell("so-formatting", 0.1)} & ${cell("so-formatting", 0.2)} & ${pct(synFlip, 1)} & ${cell("so-synonym", 0.1)} & ${cell("so-synonym", 0.2)} \\\\`,
  );
}
if (!nanoPromoted) {
  // The weaker-family probe (formatting pair only, n=500).
  famRows.push(
    `\\texttt{${String(exp12.model).replace(/_/g, "\\_")}} & ${num(exp12.n)} & ${pct(exp12.selfFlipFloor, 1)} & ${pct(exp12.formattingEditFlip, 1)} & ${outcome(exp12.sweeps, 0.1)} & ${outcome(exp12.sweeps, 0.2)} & -- & -- & -- \\\\`,
  );
}
let famCertifying = 0;
const famFloors: number[] = [];
const famRefused: string[] = [];
for (const f of FAMILIES) {
  const d = J(f.file) as Exp12;
  // Report the synonym pair only if it completed: a run cut off mid-batch
  // (gateway budget cap) leaves a random prefix, unbiased but under-sized,
  // and the table must not silently mix sample sizes.
  const syn = d.synonym && d.synonym.usableEdit >= 0.95 * d.n ? d.synonym : undefined;
  if (d.synonym && !syn) console.log(`NOTE: ${f.file} synonym pair partial (${d.synonym.usableEdit}/${d.n}); reported as --`);
  famRows.push(
    `${f.label} & ${num(d.n)} & ${pct(d.selfFlipFloor, 1)} & ${pct(d.formattingEditFlip, 1)} & ${outcome(d.sweeps, 0.1)} & ${outcome(d.sweeps, 0.2)} & ${syn ? pct(syn.synonymEditFlip, 1) : "--"} & ${outcome(syn?.sweeps, 0.1)} & ${outcome(syn?.sweeps, 0.2)} \\\\`,
  );
  def(`fam${f.key}Floor`, pct(d.selfFlipFloor, 1));
  def(`fam${f.key}Fmt`, pct(d.formattingEditFlip, 1));
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
    if (tN > 0) def(`fam${f.key}FmtTrueStratum`, pct(tF / tN, 1));
    if (fN > 0) def(`fam${f.key}FmtFalseStratum`, pct(fF / fN, 1));
    if (flips > 0) def(`fam${f.key}FmtToFalseShare`, pct(toFalse / flips, 1));
  }
  if (d.decomposition) {
    const c = d.decomposition.caseOnly;
    const w = d.decomposition.whitespaceOnly;
    if (c.flip !== null) def(`fam${f.key}CaseOnlyFlip`, pct(c.flip, 1));
    if (w.flip !== null) def(`fam${f.key}SpaceOnlyFlip`, pct(w.flip, 1));
  }
}
def("famCount", String(FAMILIES.length));
def("famCertCount", String(famCertifying));
def("famRefusedClause", famRefused.length ? ` (every stratum refused on ${famRefused.join(", ")})` : "");
def("priceFetchedAt", new Date(prices.fetchedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Los_Angeles" }));
if (gemini38Present) {
  // The sixth family's flip and floor round to the same digit; the counts
  // behind them are cited so the relation stays visible.
  const d38 = J(GEMINI38_FULL) as { n: number; usableFloor?: number; selfFlipFloor: number; formattingEditFlip: number };
  def("famGeminiEightFmtCount", String(Math.round(d38.formattingEditFlip * d38.n)));
  def("famGeminiEightFloorCount", String(Math.round(d38.selfFlipFloor * (d38.usableFloor ?? d38.n))));
  def("famGeminiEightFmtFine", pct(d38.formattingEditFlip, 2));
  def("famGeminiEightFloorFine", pct(d38.selfFlipFloor, 2));
}
def("famFloorLo", pct(Math.min(...famFloors), 1));
def("famFloorHi", pct(Math.max(...famFloors), 1));
writeFileSync(
  "paper/tablefam.tex",
  `% GENERATED by scripts/experiments/gen-paper-assets.ts from the
% exp12-secondmodel-*.json artifacts (same lab column, same seeded rows as
% the primary evaluation vector, T=0, pinned procedure). Do not edit by hand.
\\begin{tabular}{lrrrllrll}
\\toprule
 & & & \\multicolumn{3}{c}{formatting-only (v1$\\to$v2)} & \\multicolumn{3}{c}{synonym rewording (v2$\\to$v3)} \\\\
\\cmidrule(lr){4-6}\\cmidrule(lr){7-9}
Family & $n$ & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ \\\\
\\midrule
${famRows.join("\n")}
\\bottomrule
\\end{tabular}
`,
);

def("famProbeRow", nanoPromoted ? "0" : "1");

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
    def("indepMdd", pct(d, 1));
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
  const cell18 = (p: P18 | undefined, alpha: number) => {
    const x = p?.sweeps.find((s) => Math.abs(s.alpha - alpha) < 1e-9);
    if (!x) return "--";
    if (x.certifiedStrata.length === 0) return `refused (${x.sampled})`;
    return `${pct(x.savings, 1)} (${x.realizedPresented === null ? "--" : pct(x.realizedPresented, 2)})`;
  };
  // Primary-model rows for the same three pairs, from the main seed of exp8.
  type R8p = { pair: string; alpha: number; estimand: string; n: number; trueFlipRate: number; main: { certifiedStrata: number; sampled: number; reused: number; realizedPresented: number; savings: number } };
  const r8 = (exp8.results as R8p[]).filter((r) => r.estimand === "presented");
  const primaryCell = (pair: string, alpha: number) => {
    const r = r8.find((x) => x.pair === pair && Math.abs(x.alpha - alpha) < 1e-9)!;
    return r.main.certifiedStrata === 0 ? `refused (${num(r.main.sampled)})` : `${ratioPct(r.main.reused, r.n, 1)} (${pct(r.main.realizedPresented, 2)})`;
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
    const fl = (v: number | null | undefined) => (v === null || v === undefined ? "--" : pct(v, 1));
    rows18.push(
      `${label} & ${fl(w?.selfFlipFloor)} & ${fl(w?.pairs["so-widening"]?.flip)} & ${cell18(w?.pairs["so-widening"], 0.1)} & ${cell18(w?.pairs["so-widening"], 0.2)} & ${fl(d?.selfFlipFloor)} & ${fl(d?.pairs["dj-formatting"]?.flip)} & ${cell18(d?.pairs["dj-formatting"], 0.1)} & ${cell18(d?.pairs["dj-formatting"], 0.2)} & ${fl(d?.pairs["dj-criteria"]?.flip)} & ${cell18(d?.pairs["dj-criteria"], 0.1)} & ${cell18(d?.pairs["dj-criteria"], 0.2)} \\\\`,
    );
    if (w && d) {
      complete++;
      completeLabels.push(LABEL[model] ?? model);
    }
  }
  def("famPairsAvailable", arts.length > 0 ? "1" : "0");
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
          notes.push(`${LABEL[a.model] ?? a.model} holds ${s.size} ${value} cells on the ${column} column, fewer than the first look; that stratum is drawn in full, so its ${s.size} draws count toward the family's calls on that pair and, with nothing left to reuse, it is never certified`);
        }
      }
    }
    def("famPairsSmallStrataNote", notes.length ? ` ${notes.join("; ")}.` : "");
  }
  def("famFivePairFamilies", String(complete));
  def("famFivePairList", completeLabels.join(", ") || "--");
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
    def("famPairsCertifying", String(certAny));
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
 & \\multicolumn{4}{c}{SO scope widening (production column)} & \\multicolumn{7}{c}{Djinni seniority tier (4-way select)} \\\\
\\cmidrule(lr){2-5}\\cmidrule(lr){6-12}
 & & & & & & \\multicolumn{3}{c}{formatting-only (v1$\\to$v2)} & \\multicolumn{3}{c}{criteria change (v2$\\to$v3)} \\\\
\\cmidrule(lr){7-9}\\cmidrule(lr){10-12}
Family & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & floor & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ & flip & $\\alpha{=}0.1$ & $\\alpha{=}0.2$ \\\\
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
Figure & Edit & Cells & Instrument (artifact) \\\\
\\midrule
\\multicolumn{4}{@{}l}{\\emph{Headline pair: SO formatting-only, Boolean lab column}} \\\\
\\flipSoFormatting & formatting v1$\\to$v2 & $n{=}\\benchN$ evaluation vector & stored v2 oracle cells against the stored v1 cache, one draw each side; the Table~\\ref{tab:main} label instrument (\\texttt{exp8}) \\\\
\\floorBoolStored & formatting v1$\\to$v2 & same rows & a second, independent v2 draw against the same frozen v1 cache (\\texttt{exp10}); differs from the row above by \\flipInstrumentGapRows\\ rows \\\\
\\floorBoolVote & formatting v1$\\to$v2 & same rows & majority of three draws on each side (\\texttt{exp10}) \\\\
\\editFlipFreshBoth & formatting v1$\\to$v2 & same rows & fresh single draws on both sides, neither the cache (\\texttt{exp10}) \\\\
\\floorBool & identity (no edit) & same rows & within-version draw pairs: the self-flip floor, pooled over both cached values (\\texttt{exp10}) \\\\
\\floorFalseStratum, \\floorTrueStratum & identity & cached-FALSE, cached-TRUE rows & the same floor per cached-value stratum (\\texttt{exp10}, stored v1 value) \\\\
\\midrule
\\multicolumn{4}{@{}l}{\\emph{Cached-TRUE stratum figures}} \\\\
\\minoritySingle & formatting v1$\\to$v2 & cached-TRUE rows of the vector & single fresh draw against the cache (\\texttt{exp4}) \\\\
\\minorityVote & formatting v1$\\to$v2 & same & vote-of-3 on both sides (\\texttt{exp4}) \\\\
\\wideningTrueFlip & widening v1$\\to$v2, production column & \\wideningTrueN\\ cached-TRUE rows & single fresh draw against the cache (Wilson \\wideningTrueCi) \\\\
\\aggFtSubgroup & formatting v1$\\to$v2 & cached-TRUE cells B2 reused at $\\alpha{=}0.1$ & realized error among the cells the aggregate-only baseline reused, an adversely selected subset, not a population rate (\\texttt{exp7}) \\\\
\\aggFsubgroup & formatting v1$\\to$v2 & same at $\\alpha{=}0.2$ & same (\\texttt{exp7}) \\\\
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
    rowsM.push(`\\texttt{${d.model.replace(/_/g, "\\_")}} & family study, ${pairsOf(d.model)} & ${dates} & ${priceOf(d.model)} \\\\`);
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
  const lines = [
    `\\multicolumn{6}{@{}l}{\\emph{August 2026 snapshot, oracle draws of the live run (version 2)}} \\\\`,
    fmtRow("Maurer--Pontil, $\\alpha{=}0.2$ (live)", find(exp11c, "eb", 0.2), true),
    fmtRow("Maurer--Pontil, $\\alpha{=}0.1$ (live)", find(exp11c, "eb", 0.1)),
    fmtRow("exact, $\\alpha{=}0.2$ (replay)", find(exp11c, "exact", 0.2)),
    fmtRow("exact, $\\alpha{=}0.1$ (replay)", find(exp11c, "exact", 0.1)),
    fmtRow("exact, $\\alpha{=}0.05$", find(exp11c, "exact", 0.05)),
    `\\midrule`,
    `\\multicolumn{6}{@{}l}{\\emph{September 2026 snapshot, oracle drawn live (version 4), same cache}} \\\\`,
    fmtRow("exact, $\\alpha{=}0.2$", find(exp11cSep, "exact", 0.2)),
    fmtRow("exact, $\\alpha{=}0.1$", find(exp11cSep, "exact", 0.1)),
    fmtRow("exact, $\\alpha{=}0.05$", find(exp11cSep, "exact", 0.05)),
    fmtRow("Maurer--Pontil, $\\alpha{=}0.2$", find(exp11cSep, "eb", 0.2)),
    fmtRow("Maurer--Pontil, $\\alpha{=}0.1$", find(exp11cSep, "eb", 0.1)),
  ];
  writeFileSync(
    "paper/tabledeploy.tex",
    `% GENERATED by scripts/experiments/gen-paper-assets.ts from exp11c-deployment-bounds.json
% and exp11c-deployment-bounds-v4.json. Do not edit by hand.
\\begin{tabular}{@{}lrrrrr@{}}
\\toprule
Regime & oracle calls & FALSE look / flips & reused & savings & audited error (flips/rows) \\\\
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
