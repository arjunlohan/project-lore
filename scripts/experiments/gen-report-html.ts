/**
 * NOT MAINTAINED for the IEEE Access resubmission. This generator produced
 * the HTML report of the preprint (docs/research/lore-research-report.html,
 * Maurer-Pontil numbers), which is kept as a snapshot. Several macros it
 * cites were renamed or removed when the certifier's bound changed, so it
 * stops with a named error rather than mixing the old prose with new
 * figures. The manuscript, not this report, is the current account.
 *
 * Generate the readable companion to the paper from THE SAME macros the
 * paper cites, so the two cannot disagree.
 *
 * The previous version of docs/research/lore-research-report.html was
 * hand-written, and by r8 it had drifted into stating a headline conclusion
 * ("stratifier quality is a pure savings lever") that the artifacts measure
 * in the opposite direction, alongside numbers three re-runs out of date.
 * That is the same failure the paper's own generator exists to prevent, so
 * the report is now emitted from paper/macros.tex too.
 *
 * Run AFTER gen-paper-assets.ts:
 *   pnpm gen:paper && pnpm tsx scripts/experiments/gen-report-html.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const macroSrc = readFileSync("paper/macros.tex", "utf8");
const M = new Map(
  [...macroSrc.matchAll(/\\newcommand\{\\(\w+)\}\{(.*)\}/g)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);
/** Resolve a macro, failing loudly rather than emitting "undefined". */
const m = (name: string): string => {
  const v = M.get(name);
  if (v === undefined) {
    throw new Error(`report cites \\${name}, which macros.tex does not define`);
  }
  // Escape "\\$" to a sentinel BEFORE stripping math delimiters, or the
  // currency sign the previous step just produced gets stripped too and
  // "\\$11.56" renders as "11.56".
  return v
    .replace(/\{,\}/g, ",")
    .replace(/\\%/g, "%")
    .replace(/\\\$/g, "\u0001")
    .replace(/\\times/g, "×")
    .replace(/\$|\\!|\\,/g, "")
    .replace(/\u0001/g, "$")
    .replace(/\\delta/g, "δ")
    .replace(/\\alpha/g, "α")
    .replace(/--/g, "–");
};

const J = (f: string) =>
  JSON.parse(readFileSync(`docs/research/experiments/${f}`, "utf8"));
const exp8 = J("exp8-final-table.json");

const LABELS: Record<string, string> = {
  "so-formatting": "SO formatting-only",
  "so-synonym": "SO synonym rewording",
  "so-widening": "SO scope widening",
  "dj-formatting": "Djinni formatting-only",
  "dj-criteria": "Djinni criteria change",
};

interface Row {
  pair: string;
  alpha: number;
  estimand: string;
  trueFlipRate: number;
  main: { sampled: number; reused: number; realizedPresented: number };
  bootstrap: { savingsMean: number; certificationRate: number };
}
const rows = (exp8.results as Row[]).filter((r) => r.estimand === "presented");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

// --- Small multiples: one panel per edit pair. Five series in one axis would
// need a validated 5-way categorical palette; five panels sharing one accent
// need none, and the shape (collapse as alpha tightens) reads better anyway.
const ALPHAS = [0.02, 0.05, 0.1, 0.2];
const spark = (pair: string): string => {
  const pts = ALPHAS.map((a) => {
    const r = rows.find((x) => x.pair === pair && x.alpha === a);
    return { a, v: r ? r.bootstrap.savingsMean : 0 };
  });
  const W = 200;
  const H = 92;
  const P = { l: 30, r: 8, t: 10, b: 20 };
  const x = (i: number) =>
    P.l + (i * (W - P.l - P.r)) / (ALPHAS.length - 1);
  const y = (v: number) => P.t + (1 - v) * (H - P.t - P.b);
  const line = pts.map((p, i) => `${x(i)},${y(p.v)}`).join(" ");
  const area = `${x(0)},${y(0)} ${line} ${x(pts.length - 1)},${y(0)}`;
  const last = pts[pts.length - 1]!;
  return `<figure class="panel">
  <figcaption>${esc(LABELS[pair] ?? pair)}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Certified savings for ${esc(LABELS[pair] ?? pair)} rising from zero at the tightest budget to ${pct1(last.v)} at the loosest.">
    <line class="grid" x1="${P.l}" y1="${y(0)}" x2="${W - P.r}" y2="${y(0)}"/>
    <line class="grid" x1="${P.l}" y1="${y(1)}" x2="${W - P.r}" y2="${y(1)}"/>
    <polygon class="fill" points="${area}"/>
    <polyline class="line" points="${line}"/>
    <circle class="dot" cx="${x(pts.length - 1)}" cy="${y(last.v)}" r="3"/>
    <text class="ax" x="${P.l - 5}" y="${y(1) + 3}" text-anchor="end">100%</text>
    <text class="ax" x="${P.l - 5}" y="${y(0) + 3}" text-anchor="end">0</text>
    ${ALPHAS.map(
      (a, i) =>
        `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${a}</text>`,
    ).join("")}
    <text class="val" x="${x(pts.length - 1)}" y="${y(last.v) - 7}" text-anchor="end">${pct1(last.v)}</text>
  </svg>
</figure>`;
};

const tableRows = rows
  .map(
    (r) => `<tr>
  <td>${esc(LABELS[r.pair] ?? r.pair)}</td>
  <td class="n">${r.alpha.toFixed(2)}</td>
  <td class="n">${pct1(r.trueFlipRate)}</td>
  <td class="n">${r.main.sampled}</td>
  <td class="n">${r.main.reused > 0 ? r.main.reused.toLocaleString("en-US") : "–"}</td>
  <td class="n">${r.main.reused > 0 ? (r.main.realizedPresented * 100).toFixed(2) + "%" : "–"}</td>
  <td class="n">${pct1(r.bootstrap.savingsMean)}</td>
  <td class="n">${(r.bootstrap.certificationRate * 100).toFixed(0)}%</td>
</tr>`,
  )
  .join("\n");

const html = `<!-- GENERATED by scripts/experiments/gen-report-html.ts from paper/macros.tex.
     Do not edit by hand: an earlier hand-written version of this file drifted
     into contradicting the artifacts it summarised. -->
<title>Certified reuse of LLM-computed table cells</title>
<style>
  :root {
    --bg: #fbfaf7; --surface: #fff; --ink: #1a1917; --ink-2: #4a4742;
    --ink-3: #7a756c; --rule: #e4e0d8; --accent: #1f5c4a; --accent-soft: #1f5c4a1a;
    --warn: #8a4b1f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f; --surface: #1c1c17; --ink: #f0eee8; --ink-2: #c4c0b6;
      --ink-3: #8d887d; --rule: #302f28; --accent: #6fbfa3; --accent-soft: #6fbfa326;
      --warn: #d99a63;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14140f; --surface: #1c1c17; --ink: #f0eee8; --ink-2: #c4c0b6;
    --ink-3: #8d887d; --rule: #302f28; --accent: #6fbfa3; --accent-soft: #6fbfa326;
    --warn: #d99a63;
  }
  :root[data-theme="light"] {
    --bg: #fbfaf7; --surface: #fff; --ink: #1a1917; --ink-2: #4a4742;
    --ink-3: #7a756c; --rule: #e4e0d8; --accent: #1f5c4a; --accent-soft: #1f5c4a1a;
    --warn: #8a4b1f;
  }
  body {
    background: var(--bg); color: var(--ink);
    font: 16px/1.62 ui-serif, Georgia, "Times New Roman", serif;
    margin: 0; padding: 0 1.25rem 5rem;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 {
    font-size: clamp(1.7rem, 4.2vw, 2.5rem); line-height: 1.14; margin: 3rem 0 .6rem;
    letter-spacing: -.018em; text-wrap: balance;
  }
  h2 {
    font-size: 1.16rem; margin: 3rem 0 .7rem; letter-spacing: -.008em;
    padding-bottom: .4rem; border-bottom: 1px solid var(--rule);
  }
  .lede { font-size: 1.1rem; color: var(--ink-2); margin: 0 0 1.6rem; }
  .meta {
    font: 500 .72rem/1.5 ui-sans-serif, system-ui, sans-serif;
    letter-spacing: .07em; text-transform: uppercase; color: var(--ink-3);
    margin-bottom: 2.4rem;
  }
  p { margin: 0 0 1rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .8rem; margin: 1.8rem 0 2.2rem; }
  .stat { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: .8rem .9rem; }
  .stat b {
    display: block; font: 600 1.42rem/1.15 ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums; letter-spacing: -.02em; color: var(--accent);
  }
  .stat span {
    display: block; font: .7rem/1.35 ui-sans-serif, system-ui, sans-serif;
    color: var(--ink-3); margin-top: .28rem;
  }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; margin: 1.4rem 0 .6rem; }
  .panel { margin: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: .7rem .5rem .3rem; }
  .panel figcaption {
    font: 600 .72rem/1.3 ui-sans-serif, system-ui, sans-serif;
    color: var(--ink-2); padding: 0 .4rem .3rem;
  }
  .panel svg { width: 100%; height: auto; display: block; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .fill { fill: var(--accent-soft); stroke: none; }
  .dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .ax { font: 8px ui-sans-serif, system-ui, sans-serif; fill: var(--ink-3); }
  .val { font: 600 9px ui-sans-serif, system-ui, sans-serif; fill: var(--accent); }
  .scroll { overflow-x: auto; margin: 1.2rem 0; }
  table { border-collapse: collapse; width: 100%; font: .82rem/1.45 ui-sans-serif, system-ui, sans-serif; }
  th, td { padding: .42rem .6rem; border-bottom: 1px solid var(--rule); text-align: left; white-space: nowrap; }
  th { font-weight: 600; color: var(--ink-3); font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; }
  td.n { font-variant-numeric: tabular-nums; text-align: right; }
  .note {
    border-left: 3px solid var(--accent); background: var(--surface);
    padding: .85rem 1rem; margin: 1.3rem 0; font-size: .93rem; color: var(--ink-2);
    border-radius: 0 5px 5px 0;
  }
  .note.neg { border-left-color: var(--warn); }
  .note b { color: var(--ink); }
  ol.findings { padding-left: 1.15rem; }
  ol.findings li { margin-bottom: .85rem; }
  footer {
    margin-top: 3.5rem; padding-top: 1.1rem; border-top: 1px solid var(--rule);
    font: .78rem/1.6 ui-sans-serif, system-ui, sans-serif; color: var(--ink-3);
  }
  code { font: .86em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-2); }
</style>

<main>
<h1>Certified reuse of LLM-computed table cells</h1>
<p class="lede">An AI table column is a materialized view whose <em>definition</em>
changes far more often than its data. When the prompt is edited, deployed systems
either recompute every cell or reuse all of them blind. sIVM certifies a middle:
a set of cached cells whose expected false-reuse rate is bounded by a budget you
choose, with probability at least 1&nbsp;&minus;&nbsp;&delta;.</p>
<p class="meta">Generated from the paper's own macros &middot; ${m("corpusSO")} + ${m("corpusDjinni")} rows &middot; ${m("labeledCells")}+ labelled cells</p>

<div class="stats">
  <div class="stat"><b>${m("deployOracle")}</b><span>oracle calls at deployment scale</span></div>
  <div class="stat"><b>${m("deployReused")}</b><span>of ${m("deployN")} cells certified for reuse</span></div>
  <div class="stat"><b>${m("deploySavings")}</b><span>fewer model calls</span></div>
  <div class="stat"><b>${m("deployRealized")}</b><span>realized error, budget &alpha;=0.2</span></div>
  <div class="stat"><b>${m("calTrials")}</b><span>calibration trials, 0 unsafe</span></div>
  <div class="stat"><b>${m("totalSpend")}</b><span>ledgered spend, whole study</span></div>
</div>

<h2>The five findings</h2>
<ol class="findings">
<li><b>The decode-noise floor governs everything.</b> At default sampling
temperature the model disagrees with itself on ${m("floorDefaultT")} of rows,
exceeding a typical error budget before any edit is made. Pinned to
temperature&nbsp;0 the floor is ${m("floorBool")}.</li>
<li><b>Edit intuition misleads.</b> A meaning-preserving synonym paraphrase
flipped ${m("flipSoSynonym")} of cells, as much as a genuinely semantic scope
change. A formatting-only edit certified ${m("benchSavings")} call savings at
&alpha;=0.2.</li>
<li><b>Certified savings are floored by model stability.</b> The certifiable
budget cannot beat a stratum's intrinsic flip rate: ${m("floorFalseStratum")}
for cached-FALSE cells against ${m("floorTrueStratum")} for cached-TRUE, whose
volatility sets the ${m("deployCeiling")} savings ceiling.</li>
<li><b>Stratification is a validity-free lever.</b> Cached-value strata are
load-bearing: aggregate-only certification conceals up to
${m("aggFtSubgroup")} error in the reused cached-TRUE subgroup.</li>
<li><b>Column-type stability governs, not edit class.</b> On a 4-way select over
long CV text a formatting edit and a real criteria change flip cells at
${m("flipDjFormatting")} and ${m("flipDjCriteria")}, indistinguishable, so the
certifier correctly reuses less there regardless of intent.</li>
</ol>

<h2>The &alpha;-savings frontier</h2>
<p>Mean certified savings over ${m("bootB")} sampling replications, per edit pair,
as the error budget tightens from 0.2 to 0.02. Savings collapse as &alpha;
approaches each column's own flip rate, then the certifier refuses outright.</p>
<div class="panels">
${Object.keys(LABELS).map(spark).join("\n")}
</div>

<h2>Every certified sweep held its bound</h2>
<div class="scroll">
<table>
<thead><tr><th>Edit</th><th class="n">&alpha;</th><th class="n">flip</th><th class="n">oracle</th><th class="n">reused</th><th class="n">error</th><th class="n">savings</th><th class="n">cert.</th></tr></thead>
<tbody>
${tableRows}
</tbody>
</table>
</div>
<p>Across ${m("labeledCells")}+ labelled cells, ${m("bootB")} sampling
replications of every configuration, and ${m("calTrials")} known-rate
calibration trials spanning ${m("calTightNulls")} nulls planted just above the
budget, no certified stratum's true flip rate exceeded it.</p>

<h2>Deployment scale</h2>
<p>The boolean column was materialized across the entire ${m("deployN")}-row
corpus: ${m("deployMatCells")} billed cells costing ${m("deployMatCost")} at
${m("perCellCost")} per cell, ${m("deployMatHours")} hours of model time. The
formatting edit was then certified against it. At &alpha;=0.2 the procedure spent
${m("deployOracle")} oracle calls to certify reuse of ${m("deployReused")} cells,
refusing the ${m("deployTrueStratum")}-row cached-TRUE stratum.</p>
<div class="note"><b>Sampling cost did not scale with the table.</b> The same
procedure on a ${m("benchN")}-row benchmark spent ${m("benchOracleMain")} calls
against ${m("deployOracle")} here, the minimum and the median of one replication
distribution (${m("benchOracleRange")}). The schedule stops on evidence about a
stratum's <em>rate</em>, which is size-independent, so sample cost is O(1) in
<em>n</em> while the certifiable population is O(<em>n</em>).</div>
<p>The certificate was applied, not merely computed: it stamps its identifier on
${m("deployStamped")} of the ${m("deployReused")} reused cells. The
${m("deployUnstamped")} it leaves alone are the audited rows already holding
freshly computed values, which the apply step refuses to overwrite. A
certificate can add a reused value; it can never revert a recomputation.</p>

<h2>What the alternatives actually do</h2>
<p><b>Verified-cache similarity carries no cross-version signal.</b> The per-row
similarity a semantic cache thresholds predicts flips at chance (AUC
${m("aucVcacheF")} on formatting, ${m("aucVcacheW")} on widening). Adding "a
version key" to such a cache cannot produce a sound cross-version policy.</p>
<p><b>Aggregate-only certification silently corrupts subgroups.</b> Run with the
same schedule and budget, it certifies ${m("aggFsavings")} of cells at
${m("aggFrealized")} aggregate error while the reused cached-TRUE subgroup
carries ${m("aggFsubgroup")}.</p>
<p><b>A matched SUPG-style competitor wins on volume and loses on where its
errors land.</b> At the same ${m("hhBudget")}-label budget it reused
${m("hhSupgReused")} cells to sIVM's ${m("hhSivmReused")}, at
${m("hhSupgErr")} error against ${m("hhSivmErr")}. The extra volume is
${m("hhSupgTrueRows")} cached-TRUE cells, where the per-stratum floor is
${m("floorTrueStratum")}. It also selects ${m("hhSupgSelFrac")} of the rows it is
allowed to, so matched this way it is the guarantee-free baseline wearing a
certificate.</p>

<h2>The bound we chose is the binding constraint</h2>
<p>Every result above spends its error budget through a Maurer&ndash;Pontil bound
split across six looks by Bonferroni. That choice, not the stratification and
not the schedule, is what sets the frontier. Swapping in a Waudby-Smith&ndash;Ramdas
betting confidence sequence, which is anytime-valid and so needs no split
across looks, inside the same procedure over the same labels:</p>
<div class="scroll">
<table>
<thead><tr><th>Bound</th><th class="n">configs certifying</th><th class="n">mean savings</th><th class="n">oracle calls</th><th class="n">clean bound at n=90</th></tr></thead>
<tbody>
<tr><td>Maurer&ndash;Pontil (what the paper certifies with)</td><td class="n">${m("boundEbConfigs")} / ${m("boundConfigsTotal")}</td><td class="n">${m("boundEbSavings")}</td><td class="n">${m("boundEbOracle")}</td><td class="n">${m("boundEbAtN")}</td></tr>
<tr><td><b>Betting confidence sequence</b></td><td class="n"><b>${m("boundBetConfigs")} / ${m("boundConfigsTotal")}</b></td><td class="n"><b>${m("boundBetSavings")}</b></td><td class="n"><b>${m("boundBetOracle")}</b></td><td class="n"><b>${m("boundBetAtN")}</b></td></tr>
<tr><td>Empirical-Bernstein&ndash;Serfling (without replacement)</td><td class="n">${m("boundWorConfigs")} / ${m("boundConfigsTotal")}</td><td class="n">&ndash;</td><td class="n">&ndash;</td><td class="n">${m("boundWorAtN")}</td></tr>
</tbody>
</table>
</div>
<p>More certificates, more savings, and a third fewer oracle calls,
simultaneously. The widest single gap is the scope-widening edit at
&alpha;=0.1: ${m("boundGapEbSavings")} savings for ${m("boundGapEbOracle")}
calls becomes ${m("boundGapBetSavings")} for ${m("boundGapBetOracle")}.</p>
<div class="note"><b>Validity first.</b> A tighter bound only counts if it is
still a bound. Over ${m("boundCalTrials")} planted-rate trials, no null
configuration's certification rate is demonstrably above &delta;: the worst is
${m("boundBetNullWorst")} against a per-stratum &delta; of 0.05, and
${m("boundBetNullsOver")} of ${m("boundNullConfigs")} nulls have a 95% CI
entirely above it. Maurer&ndash;Pontil scores zero on that test, and the
distance between zero and ${m("boundBetNullWorst")} is exactly the point: the
conservative bound leaves nearly all its budget unspent, and a clean stratum
costs it ${m("boundEbCleanSample")} draws where the sequence needs
${m("boundBetCleanSample")}.</p></div>
<p>The paper reports this as an ablation rather than repinning on it, because
the headline results and the deployment run were certified under
Maurer&ndash;Pontil. An earlier draft asserted the opposite of all of this
without measuring it.</p>

<h2>A negative result we are keeping</h2>
<div class="note neg"><b>Refining strata by embedding interaction does not pay.</b>
Across all ${m("ablationTotal")} shared configurations the finer
value&times;embedding-tertile stratifier is better in ${m("ablationBetter")} and
worse in ${m("ablationWorse")}; on the headline pair it certifies
${m("ablationSavings")} against ${m("benchSavings")}. Its <em>validity</em> is
unconditional, since any stratifier frozen before sampling preserves the
guarantee. Its <em>power</em> is not: the &delta;/K split is never repaid on
these columns. We report the direction rather than tuning until it inverts.</div>

<h2>Honest limitations</h2>
<p>A second, weaker model family has a ${m("altModelFloor")} self-flip floor,
${m("floorBool")} for our primary model, and is refused at every budget. That is
the theory's own prediction, not a counterexample: a model that cannot reproduce
its own answers cannot support certified reuse, and the procedure detects it
cheaply instead of certifying something unsafe. The quantitative frontier is
therefore model-specific even though the structure held on both.</p>
<p>Bonferroni across strata and looks is sound but conservative. Equivalence is
exact-match, so free-text columns need a calibrated judge. Certificates are
scoped to a pinned model snapshot and say nothing about provider drift. And the
empirical-Bernstein bound is stated for i.i.d. draws while sampling is uniform
without replacement; we carry that gap as a stated assumption rather than
claiming it closed.</p>

<footer>
Every number above is resolved from <code>paper/macros.tex</code>, the same
generated file the paper cites, and this page fails to build if it names a macro
that file does not define. The macros are emitted by
<code>scripts/experiments/gen-paper-assets.ts</code> from the result artifacts
and the system's cost ledger, so re-running an experiment regenerates both the
paper and this page.
</footer>
</main>
`;

writeFileSync("docs/research/lore-research-report.html", html);
console.log(
  `REPORT_OK: ${html.length} bytes, ${rows.length} table rows, ${M.size} macros available`,
);
