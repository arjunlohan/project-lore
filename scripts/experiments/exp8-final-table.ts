/**
 * Experiment 8: THE final table, one pinned procedure, mechanically
 * generated (review r1 mandatory items 1, 2, 4).
 *
 * Pinned procedure: strata = cached value x embedding-interaction tertile;
 * adaptive doubling looks n0=45, maxLooks=6; delta=0.1; alpha in
 * {0.02,0.05,0.1,0.2}; both estimands (presented cells: primary;
 * strict reuse-set with deflated threshold: secondary).
 *
 * Replication (zero API cost): B=500 reshuffle replays per configuration on
 * the frozen ground-truth labels: the full sampling distribution of the
 * procedure, giving certification rates, savings CIs, and realized
 * violation rates to compare against nominal delta.
 *
 * Outputs: exp8-final-table.json + paper/table1.tex (generated, not typed).
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp8-final-table.ts
 *
 * From the released labels alone (no database, no model endpoint):
 *   EXP_STRATIFIER=value-only EXP_LABELS=docs/research/experiments/benchmark-labels.json \
 *     pnpm tsx scripts/experiments/exp8-final-table.ts
 * reads the evaluation vectors and both sides' cell values from the artifact
 * that export-benchmark-labels.ts writes, and reproduces the same output.
 *
 * A graded relation on the ordinal select column (adjacent tiers taken as
 * equivalent), from the same labels and under the same pinned procedure:
 *   EXP_STRATIFIER=value-only EXP_LABELS=docs/research/experiments/benchmark-labels.json \
 *     EXP_EQUIV=adjacent-tier EXP_OUT=docs/research/experiments/exp8-graded.json \
 *     pnpm tsx scripts/experiments/exp8-final-table.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { PAIRS, type PairDef as Pair } from "./pairs";
import {
  adaptiveCertifyStratum,
  assignStrataWith,
  diffPrompts,
  seededShuffle,
  type BoundKind,
  type SivmCellInput,
} from "@lore/core/sivm";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { cosine, embedTexts } from "../../lib/lore/embed";
import { bindTemplate } from "../../lib/lore/run-column";

const ALPHAS = [0.02, 0.05, 0.1, 0.2];
const STRATIFIER = process.env.EXP_STRATIFIER;
if (!STRATIFIER) {
  throw new Error(
    "EXP_STRATIFIER must be set explicitly (value-only = pinned primary; " +
      "value-embed = ablation). Refusing to guess: a wrong default here " +
      "silently rewrites Table 1, the figures, and ~30 prose macros.",
  );
}
if (STRATIFIER === "value-embed" && !process.env.EXP_OUT) {
  throw new Error("ablation runs must set EXP_OUT to a non-headline path");
}
const OUT = process.env.EXP_OUT ?? "docs/research/experiments/exp8-final-table.json";
// The bound the pinned procedure certifies with. "exact" is the default of
// the core certifier (IEEE Access resubmission); EXP_BOUND=eb reproduces the
// first submission's Table 1 for the response letter.
const BOUND = (process.env.EXP_BOUND ?? "exact") as BoundKind;
// Read the labels from the released artifact instead of the database.
const LABELS = process.env.EXP_LABELS;
if (LABELS && STRATIFIER !== "value-only") {
  throw new Error("EXP_LABELS supports the pinned value-only stratifier only (the ablation needs prompts and embeddings)");
}
type ReleasedPair = {
  key: string;
  rowIds: string[];
  cached: unknown[];
  fresh: unknown[];
  outputSpec?: { kind: string; options?: string[] };
};
const released: ReleasedPair[] | null = LABELS
  ? (JSON.parse(readFileSync(LABELS, "utf8")) as { pairs: ReleasedPair[] }).pairs
  : null;
// The column's equivalence relation. "exact" is the relation every headline
// result uses. "adjacent-tier" re-scores an ORDINAL select column with
// neighbouring options taken as equivalent (a graded relation): a flip is a
// fresh value more than one option away from the cached one. It reads the
// option order from the released labels, runs on the select pairs only, and
// must write to a path of its own.
const EQUIV = process.env.EXP_EQUIV ?? "exact";
if (EQUIV !== "exact" && EQUIV !== "adjacent-tier") {
  throw new Error(`unknown EXP_EQUIV ${EQUIV}`);
}
if (EQUIV !== "exact" && (!LABELS || !process.env.EXP_OUT || process.env.EXP_WRITE_TEX === "1")) {
  throw new Error("a graded relation runs from EXP_LABELS, writes to its own EXP_OUT, and never writes paper assets");
}
const DELTA = 0.1;
const MAIN_SEED = 42;
const B = Number(process.env.EXP_B ?? 1000);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;



async function loadRows(pair: Pair): Promise<Row[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] =
    pair.corpus === "profiles"
      ? await db.query(`SELECT * FROM profiles ORDER BY RAND(?) LIMIT 2000`, [
          pair.rowSeed,
        ])
      : await db.query(
          `SELECT id, position, experience_years, SUBSTRING(cv,1,4000) AS cv
           FROM djinni_profiles WHERE cv IS NOT NULL AND position IS NOT NULL
           ORDER BY RAND(?) LIMIT 2000`,
          [pair.rowSeed],
        );
  await db.end();
  return (rowsRaw as Row[]).map((r) => {
    const out: Row = { ...r };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === "string" && v.startsWith("[")) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          /* keep */
        }
      }
    }
    return out;
  });
}

interface StratumLabels {
  id: string;
  flips: number[]; // aligned with a canonical row order (pre-shuffle)
}

interface RunOutcome {
  certifiedStrata: number;
  sampled: number;
  reused: number;
  reusedFlips: number;
  certTotal: number; // total rows in certified strata
  recompute: number;
  /** Certified strata for which the event Theorem 1 bounds occurred. */
  unsafeStrata: number;
  /** Certified strata whose own reuse-set rate exceeds alpha (a subset of
   * the theorem's event in the strict mode; not certified by the default). */
  reuseExceedStrata: number;
}

async function replay(
  strata: StratumLabels[],
  alpha: number,
  estimand: "presented" | "reuse-set",
  seed: number,
): Promise<RunOutcome> {
  const K = Math.max(1, strata.length);
  const perStratumDelta = DELTA / K;
  let sampled = 0;
  let reused = 0;
  let reusedFlips = 0;
  let certTotal = 0;
  let recompute = 0;
  let certifiedStrata = 0;
  let unsafeStrata = 0;
  let reuseExceedStrata = 0;
  for (const s of strata) {
    const order = seededShuffle(
      s.flips.map((_, i) => i),
      seed + s.id.length * 7919,
    );
    const outcome = await adaptiveCertifyStratum(
      s.flips.length,
      alpha,
      perStratumDelta,
      async (n) => order.slice(0, n).map((i) => s.flips[i]!),
      45,
      6,
      estimand,
      BOUND,
    );
    sampled += outcome.sampled;
    if (outcome.certified) {
      certifiedStrata++;
      certTotal += s.flips.length;
      const rest = order.slice(outcome.sampled);
      const restFlips = rest.reduce((a, i) => a + s.flips[i]!, 0);
      reused += rest.length;
      reusedFlips += restFlips;
      // The event the theorem bounds is per stratum, so it is counted per
      // stratum: a union of certified strata can sit inside the budget while
      // one of them does not. Default mode: the stratum is a null, its whole
      // realized flip count M_j above alpha * n_j. Strict mode: M_j above
      // alpha * (n_j - m_j), the reused count; the stratum's own reuse-set
      // rate exceeding alpha is a subset of that event.
      const stratumFlips = s.flips.reduce((a, x) => a + x, 0);
      const unsafe =
        estimand === "presented"
          ? stratumFlips > alpha * s.flips.length + 1e-9
          : stratumFlips > alpha * rest.length + 1e-9;
      if (unsafe) unsafeStrata++;
      if (restFlips > alpha * rest.length + 1e-9) reuseExceedStrata++;
    } else {
      recompute += s.flips.length - outcome.sampled;
    }
  }
  return { certifiedStrata, sampled, reused, reusedFlips, certTotal, recompute, unsafeStrata, reuseExceedStrata };
}

async function main() {
  const started = Date.now();
  const allResults: Record<string, unknown>[] = [];
  const texRows: string[] = [];

  for (const pair of PAIRS) {
    if (EQUIV === "adjacent-tier" && pair.columnType !== "select") continue;
    let rows: Row[];
    let cache: Map<string, unknown>;
    let truth: Map<string, unknown>;
    let options: string[] | null = null;
    let vFrom: { prompt_template: string } | null = null;
    let vTo: { prompt_template: string } | null = null;
    if (released) {
      // The released labels: the vector in sampling order and both sides'
      // values, null where the row holds no oracle cell of that version.
      const entry = released.find((p) => p.key === pair.key);
      if (!entry) throw new Error(`${LABELS} has no pair ${pair.key}`);
      rows = entry.rowIds.map((id) => ({ [pair.idField]: id }));
      const side = (values: unknown[]) =>
        new Map(
          entry.rowIds
            .map((id, i) => [id, values[i]] as [string, unknown])
            .filter(([, v]) => v !== null),
        );
      cache = side(entry.cached);
      truth = side(entry.fresh);
      options = entry.outputSpec?.options ?? null;
    } else {
      const columns = await listColumns(pair.corpus);
      const column = columns.find((c) => pair.columnMatch(c.name));
      if (!column) throw new Error(`column for ${pair.key} not found`);
      vFrom = await getColumnVersion(column.id, pair.fromV);
      vTo = await getColumnVersion(column.id, pair.toV);
      if (!vFrom || !vTo) throw new Error(`versions missing for ${pair.key}`);

      rows = await loadRows(pair);
      const rowIds = rows.map((r) => String(r[pair.idField]));
      // r8/M12: filter to ORACLE-computed cells, as exp11b-verify and exp13
      // already do. Certificates are now applied in this database, and a
      // `reused_certified` cell is a verbatim copy of the v1 value, so an
      // unfiltered read would score it as a non-flip by construction and
      // silently deflate every flip rate in Table 1.
      const oracleOnly = (cs: Array<{ row_id: string; value: unknown; status: string }>) =>
        new Map(
          cs
            .filter((c) => c.status === "done" || c.status === "cached")
            .map((c) => [c.row_id, c.value]),
        );
      cache = oracleOnly(
        await getCellsForVersion(column.id, pair.fromV, rowIds),
      );
      truth = oracleOnly(
        await getCellsForVersion(column.id, pair.toV, rowIds),
      );
    }
    const usableRows = rows.filter((r) => {
      const id = String(r[pair.idField]);
      return cache.has(id) && truth.has(id);
    });
    if (EQUIV === "adjacent-tier" && !options) {
      throw new Error(`${pair.key}: the labels carry no option order for a graded relation`);
    }
    const tier = (v: unknown) => {
      const i = options!.indexOf(String(v));
      if (i < 0) throw new Error(`${pair.key}: value ${JSON.stringify(v)} is not one of the column's options`);
      return i;
    };
    const flipOf = (id: string) =>
      EQUIV === "adjacent-tier"
        ? Math.abs(tier(cache.get(id)) - tier(truth.get(id))) > 1
          ? 1
          : 0
        : JSON.stringify(cache.get(id)) !== JSON.stringify(truth.get(id))
          ? 1
          : 0;

    // Embedding-interaction tertiles, only for the value-embed ablation: the
    // pinned value-only stratifier never reads them, and embedding 10,000
    // bound rows for a stratifier that ignores them is paid API traffic.
    const score = new Map<string, number>();
    let t1 = 0;
    let t2 = 0;
    if (STRATIFIER !== "value-only") {
      if (!vFrom || !vTo) throw new Error("the ablation needs the prompt templates");
      const delta = diffPrompts(vFrom.prompt_template, vTo.prompt_template);
      const deltaText = [...delta.added, ...delta.removed].join(" ") || "(none)";
      const fromTemplate = vFrom.prompt_template;
      const bound = usableRows.map(
        (r) => bindTemplate(fromTemplate, r).text,
      );
      const [deltaEmb, ...rowEmbs] = await embedTexts([deltaText, ...bound]);
      usableRows.forEach((r, i) =>
        score.set(String(r[pair.idField]), cosine(deltaEmb!, rowEmbs[i]!)),
      );
      const sortedScores = [...score.values()].sort((a, b) => a - b);
      t1 = sortedScores[Math.floor(sortedScores.length / 3)]!;
      t2 = sortedScores[Math.floor((2 * sortedScores.length) / 3)]!;
    }
    const inputs: SivmCellInput[] = usableRows.map((r) => ({
      rowId: String(r[pair.idField]),
      cachedValue: cache.get(String(r[pair.idField])),
      boundText: "",
    }));
    const strataRaw = assignStrataWith(
      inputs,
      STRATIFIER === "value-only"
        ? () => "all"
        : (c) => {
            const s = score.get(c.rowId) ?? 0;
            return `e=${s <= t1 ? "low" : s <= t2 ? "mid" : "high"}`;
          },
    );
    const strata: StratumLabels[] = strataRaw.map((s) => ({
      id: s.id,
      flips: s.rowIds.map(flipOf),
    }));
    const n = usableRows.length;
    const trueFlipRate =
      strata.reduce((a, s) => a + s.flips.reduce((x, y) => x + y, 0), 0) / n;

    for (const alpha of ALPHAS) {
      for (const estimand of ["presented", "reuse-set"] as const) {
        // Main seeded run.
        const main = await replay(strata, alpha, estimand, MAIN_SEED);
        const realizedPresented =
          main.certTotal > 0 ? main.reusedFlips / main.certTotal : 0;
        const realizedReuse =
          main.reused > 0 ? main.reusedFlips / main.reused : 0;
        const savings = 1 - (main.sampled + main.recompute) / n;

        // Bootstrap over sampling randomness (labels frozen).
        let certRuns = 0;
        const oracleCounts: number[] = [];
        const savingsAll: number[] = [];
        let violPresented = 0;
        let violReuse = 0;
        let unsafeRuns = 0;
        let reuseExceedRuns = 0;
        let savingsSum = 0;
        let savingsSq = 0;
        for (let b = 0; b < B; b++) {
          const o = await replay(strata, alpha, estimand, 1000 + b);
          oracleCounts.push(o.sampled);
          const sv = 1 - (o.sampled + o.recompute) / n;
          savingsSum += sv;
          savingsAll.push(sv);
          savingsSq += sv * sv;
          if (o.unsafeStrata > 0) unsafeRuns++;
          if (o.reuseExceedStrata > 0) reuseExceedRuns++;
          if (o.reused > 0) {
            certRuns++;
            if (o.reusedFlips / o.certTotal > alpha) violPresented++;
            if (o.reusedFlips / o.reused > alpha) violReuse++;
          }
        }
        const savingsMean = savingsSum / B;
        const savingsSd = Math.sqrt(
          Math.max(0, savingsSq / B - savingsMean * savingsMean),
        );
        // Percentile interval over replications (bimodal certify/refuse
        // mixtures make mean +- sd misleading on its own).
        const sortedSav = [...savingsAll].sort((x, y) => x - y);
        const q = (f: number) =>
          sortedSav[Math.min(sortedSav.length - 1, Math.floor(f * sortedSav.length))]!;
        const savingsLo = q(0.025);
        const savingsHi = q(0.975);
        // Wilson score interval for the main-seed realized reuse-set rate.
        const wilson = (k: number, n: number) => {
          if (n === 0) return [0, 0] as const;
          const z = 1.96;
          const p = k / n;
          const d = 1 + (z * z) / n;
          const c = p + (z * z) / (2 * n);
          const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
          return [(c - h) / d, (c + h) / d] as const;
        };
        const [frLo, frHi] = wilson(main.reusedFlips, Math.max(1, main.reused));

        allResults.push({
          pair: pair.key,
          alpha,
          estimand,
          n,
          trueFlipRate,
          main: {
            ...main,
            realizedPresented,
            realizedReuse,
            savings,
          },
          bootstrap: {
            B,
            oracleMean:
              oracleCounts.reduce((a, x) => a + x, 0) / oracleCounts.length,
            oracleMin: Math.min(...oracleCounts),
            oracleMax: Math.max(...oracleCounts),
            oracleP50: [...oracleCounts].sort((a, x) => a - x)[
              Math.floor(oracleCounts.length / 2)
            ]!,
            certificationRate: certRuns / B,
            violationRatePresented: certRuns > 0 ? violPresented / certRuns : 0,
            violationRateReuseSet: certRuns > 0 ? violReuse / certRuns : 0,
            // Share of ALL replications that issue at least one unsafe
            // certificate, counted per stratum (the event of Theorem 1).
            unsafeCertificateRate: unsafeRuns / B,
            // Share of ALL replications in which a certified stratum's own
            // reuse-set rate exceeds alpha.
            stratumReuseExceedRate: reuseExceedRuns / B,
            savingsMean,
            savingsSd,
            savingsLo,
            savingsHi,
            realizedReuseCiLo: frLo,
            realizedReuseCiHi: frHi,
          },
        });
        if (estimand === "presented") {
          texRows.push(
            `${pair.label} & ${alpha.toFixed(2)} & ${(trueFlipRate * 100).toFixed(1)}\\% & ${main.reused > 0 ? (realizedPresented * 100).toFixed(2) + "\\%" : "--"} & ${main.reused > 0 ? (realizedReuse * 100).toFixed(2) + "\\%" : "--"} & ${(savingsMean * 100).toFixed(1)}\\% $\\pm$ ${(savingsSd * 100).toFixed(1)} & ${(certRuns / B * 100).toFixed(0)}\\% & ${certRuns > 0 ? (violReuse / certRuns * 100).toFixed(1) + "\\%" : "--"} \\\\`,
          );
        }
        console.log(
          `${pair.key} α=${alpha} ${estimand}: cert=${main.certifiedStrata} reused=${main.reused} realizedP=${(realizedPresented * 100).toFixed(2)}% realizedR=${(realizedReuse * 100).toFixed(2)}% savings=${(savings * 100).toFixed(1)}% | boot: certRate=${((certRuns / B) * 100).toFixed(0)}% violR=${certRuns > 0 ? ((violReuse / certRuns) * 100).toFixed(1) : "-"}% savings=${(savingsMean * 100).toFixed(1)}±${(savingsSd * 100).toFixed(1)}`,
        );
      }
    }
  }

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        experiment: "exp8-final-table",
        procedure: `strata=${STRATIFIER}; bound=${BOUND}; adaptive n0=45 maxLooks=6; delta=0.1; prng=mulberry32; seeds: main=42, bootstrap=1000..${1000 + B - 1}${EQUIV === "exact" ? "" : `; equivalence=${EQUIV}`}`,
        bound: BOUND,
        ...(EQUIV === "exact" ? {} : { equivalence: EQUIV }),
        results: allResults,
        wallMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  const tex = `% GENERATED by scripts/experiments/exp8-final-table.ts — do not edit.
\\begin{tabular}{lrrrrrrr}
\\toprule
Edit & $\\alpha$ & flip & FR$_{\\text{pres}}$ & FR$_{\\text{reuse}}$ & savings (boot $\\pm$ sd) & cert.\\ rate & viol.\\ rate \\\\
\\midrule
${texRows.join("\n")}
\\bottomrule
\\end{tabular}
`;
  if (process.env.EXP_WRITE_TEX === "1") {
  if (STRATIFIER !== "value-only") {
    throw new Error("only the pinned primary procedure may write paper assets");
  }
  writeFileSync("paper/table1.tex", tex);
}
  console.log("\nEXP8_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
