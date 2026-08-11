/**
 * Experiment 1 (pilot): sIVM certified reuse on a REAL prompt edit.
 *
 * Column: "Data-platform specialist?" v1 (strict) -> v2 (scope-widening:
 * analytics-engineering evidence counts). Corpus: SO2023 profiles.
 *
 * Protocol:
 *  A. Deterministic row sample (MySQL RAND(seed)) of N rows.
 *  B. Materialize v1 cells for all N (the "cache").
 *  C. Materialize v2 cells for all N (GROUND TRUTH; hidden from certifier).
 *  D. For each alpha: certify using only v1 cache + an oracle that reveals
 *     v2 values for sampled rows (calls counted). Measure REALIZED
 *     false-reuse among reused cells against ground truth, cost, savings.
 *  E. Baselines: full recompute (cost N, error 0), blind reuse (cost 0,
 *     error = true flip rate).
 *
 * Run: set -a; source .env.local; set +a; \
 *      EXP_ROWS=120 pnpm tsx scripts/experiments/exp1-pilot.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  getCellsForVersion,
  getColumn,
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { runColumn } from "../../lib/lore/run-column";

const N = Number(process.env.EXP_ROWS ?? 800);
const ALPHAS = (process.env.EXP_ALPHAS ?? "0.05,0.1,0.2")
  .split(",")
  .map(Number);
const DELTA = Number(process.env.EXP_DELTA ?? 0.1);
const SEED = 42;
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 24);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

async function ensureVersionCells(
  column: NonNullable<Awaited<ReturnType<typeof getColumn>>>,
  version: number,
  rows: Row[],
): Promise<void> {
  const have = new Set(
    (await getCellsForVersion(column.id, version)).
      filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => c.row_id),
  );
  const missing = rows.filter(
    (r) => !have.has(String(r[PROFILE_ID_FIELD])),
  );
  console.log(
    `v${version}: ${have.size} cells present, computing ${missing.length}`,
  );
  if (missing.length === 0) return;
  const v = await getColumnVersion(column.id, version);
  if (!v) throw new Error(`no version ${version}`);
  const res = await runColumn(column, missing, PROFILE_ID_FIELD, {
    concurrency: CONCURRENCY,
    versionOverride: {
      promptTemplate: v.prompt_template,
      promptVersion: version,
    },
  });
  console.log(
    `v${version}: ran=${res.ran} cached=${res.cached} errors=${res.errors} cost=$${res.costUsd.toFixed(4)} in ${(res.ms / 1000).toFixed(0)}s`,
  );
  if (res.errors > res.ran * 0.1) {
    throw new Error(`too many errors materializing v${version}`);
  }
}

async function main() {
  const started = Date.now();
  const columns = await listColumns("profiles");
  const column = columns.find((c) => c.name.startsWith("Data-platform"));
  if (!column) throw new Error("pilot column not found");
  console.log(
    `column ${column.name} (${column.id}), current v${column.prompt_version}`,
  );

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [SEED, N],
  );
  await db.end();
  const rows = (rowsRaw as Row[]).map((r) => {
    const out: Row = { ...r };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === "string" && v.startsWith("[")) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          /* keep string */
        }
      }
    }
    return out;
  });
  console.log(`row sample: ${rows.length}`);

  // B + C: materialize both versions (ground truth for v2).
  await ensureVersionCells(column, 1, rows);
  await ensureVersionCells(column, 2, rows);

  const rowIds = rows.map((r) => String(r[PROFILE_ID_FIELD]));
  const v1cells = new Map(
    (await getCellsForVersion(column.id, 1, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );
  const truth = new Map(
    (await getCellsForVersion(column.id, 2, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );

  const usableIds = rowIds.filter(
    (id) => v1cells.has(id) && truth.has(id),
  );
  const trueFlips = usableIds.filter(
    (id) => JSON.stringify(v1cells.get(id)) !== JSON.stringify(truth.get(id)),
  );
  const trueFlipRate = trueFlips.length / usableIds.length;
  console.log(
    `\nground truth: ${usableIds.length} usable rows, ${trueFlips.length} flips (${(trueFlipRate * 100).toFixed(1)}%)`,
  );

  // D: certification sweep. Oracle reveals ground truth, counts calls.
  const report: Record<string, unknown>[] = [];
  for (const alpha of ALPHAS) {
    let oracleCalls = 0;
    const outcome = await certifyColumnEdit(
      column,
      1,
      2,
      rows.filter((r) => usableIds.includes(String(r[PROFILE_ID_FIELD]))),
      PROFILE_ID_FIELD,
      async (ids) => {
        oracleCalls += ids.length;
        return new Map(ids.map((id) => [id, truth.get(id)]));
      },
      { alpha, delta: DELTA, seed: SEED, apply: false },
    );

    const falseReused = outcome.reusedRowIds.filter(
      (id) =>
        JSON.stringify(v1cells.get(id)) !== JSON.stringify(truth.get(id)),
    ).length;
    const realizedFalseReuse =
      outcome.reusedRowIds.length > 0
        ? falseReused / outcome.reusedRowIds.length
        : 0;
    const totalCost = oracleCalls + outcome.recomputeRowIds.length;
    const savings = 1 - totalCost / usableIds.length;

    console.log(
      `\nalpha=${alpha}: sampled=${oracleCalls} reused=${outcome.reusedRowIds.length} recompute=${outcome.recomputeRowIds.length}`,
    );
    console.log(
      `  realized false-reuse = ${(realizedFalseReuse * 100).toFixed(2)}% (bound ${alpha * 100}%) ${realizedFalseReuse <= alpha ? "WITHIN BOUND" : "VIOLATED"}`,
    );
    console.log(
      `  LLM-call savings vs full recompute = ${(savings * 100).toFixed(1)}%`,
    );
    for (const s of outcome.strata) {
      console.log(
        `    stratum ${s.stratumId.padEnd(22)} size=${String(s.size).padStart(4)} sampled=${String(s.sampled).padStart(3)} flips=${s.flips} upper=${s.upperBound.toFixed(3)} ${s.certified ? "CERTIFIED" : "recompute"}`,
      );
    }
    report.push({
      alpha,
      delta: DELTA,
      sampled: oracleCalls,
      reused: outcome.reusedRowIds.length,
      recompute: outcome.recomputeRowIds.length,
      falseReused,
      realizedFalseReuse,
      savings,
      strata: outcome.strata,
    });
  }

  const out = {
    experiment: "exp1-pilot",
    column: column.name,
    edit: "v1 strict -> v2 scope-widening (analytics-engineering evidence)",
    n: usableIds.length,
    trueFlipRate,
    trueFlips: trueFlips.length,
    model: column.model,
    delta: DELTA,
    seed: SEED,
    baselines: {
      fullRecompute: { cost: usableIds.length, error: 0 },
      blindReuse: { cost: 0, error: trueFlipRate },
    },
    sweeps: report,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  const path = `docs/research/experiments/exp1-pilot-n${usableIds.length}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
  console.log("EXP1_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
