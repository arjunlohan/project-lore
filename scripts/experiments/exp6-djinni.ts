/**
 * Experiment 6: cross-corpus external validity. A seniority-tier SELECT
 * column over the Djinni free-text corpus (210K real CVs, MIT), judged from
 * position + experience + CV text (capped at 4,000 chars for cost control).
 *
 * Versions:
 *  v1 base -> v2 formatting-only -> v3 criteria change (leadership bumps
 *  the tier), i.e. one certifiable edit and one genuinely semantic edit,
 *  mirroring exp2 on a different corpus, output type, and text-heavy input.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp6-djinni.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  createColumn,
  getCellsForVersion,
  getColumn,
  getColumnVersion,
  listColumns,
  updateColumnPrompt,
  type AiColumn,
} from "../../lib/lore/column-store";
import { runColumn } from "../../lib/lore/run-column";

const N = Number(process.env.EXP_ROWS ?? 2000);
const ALPHAS = [0.05, 0.1, 0.2];
const DELTA = 0.1;
const SEED = 7;
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const LAB_NAME = "Seniority tier (djinni lab)";
const ID_FIELD = "id";

type Row = Record<string, unknown>;

const TIERS = ["Junior", "Mid", "Senior", "Lead/Principal"];

const PROMPT_V1 = `Classify this candidate's seniority tier. Position: {{position}}. Years of experience: {{experience_years}}. CV: {{cv}}. Base the tier on scope of responsibility and depth of experience shown in the CV, not just years.`;

const PROMPT_V2 = `Classify this candidate's seniority tier.

Position: {{position}}
Years of experience: {{experience_years}}
CV: {{cv}}

Base the tier on scope of responsibility and depth of experience shown in the CV, not just years.`;

const PROMPT_V3 = `Classify this candidate's seniority tier.

Position: {{position}}
Years of experience: {{experience_years}}
CV: {{cv}}

Base the tier on scope of responsibility and depth of experience shown in the CV, not just years. Evidence of team or people leadership (leading engineers, owning hiring, running a team) moves the candidate up one tier.`;

async function ensureLabColumn(): Promise<AiColumn> {
  const existing = (await listColumns("djinni")).find(
    (c) => c.name === LAB_NAME,
  );
  if (existing) return existing;
  const col = await createColumn({
    tableId: "djinni",
    name: LAB_NAME,
    promptTemplate: PROMPT_V1,
    model: "deepseek/deepseek-v4-flash-0731",
    outputSpec: { kind: "select", options: TIERS },
  });
  await updateColumnPrompt(col.id, PROMPT_V2);
  await updateColumnPrompt(col.id, PROMPT_V3);
  return (await getColumn(col.id))!;
}

async function rowSample(): Promise<Row[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT id, position, experience_years, SUBSTRING(cv, 1, 4000) AS cv
     FROM djinni_profiles
     WHERE cv IS NOT NULL AND position IS NOT NULL
     ORDER BY RAND(?) LIMIT ?`,
    [SEED, N],
  );
  await db.end();
  return rowsRaw as Row[];
}

async function ensureVersionCells(
  column: AiColumn,
  version: number,
  rows: Row[],
): Promise<void> {
  const have = new Set(
    (await getCellsForVersion(column.id, version))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => c.row_id),
  );
  const missing = rows.filter((r) => !have.has(String(r[ID_FIELD])));
  console.log(
    `djinni v${version}: ${have.size} present, computing ${missing.length}`,
  );
  if (missing.length === 0) return;
  const v = await getColumnVersion(column.id, version);
  if (!v) throw new Error(`no version ${version}`);
  const res = await runColumn(column, missing, ID_FIELD, {
    concurrency: CONCURRENCY,
    versionOverride: {
      promptTemplate: v.prompt_template,
      promptVersion: version,
    },
  });
  console.log(
    `djinni v${version}: ran=${res.ran} errors=${res.errors} cost=$${res.costUsd.toFixed(4)} in ${(res.ms / 1000).toFixed(0)}s`,
  );
  if (res.errors > res.ran * 0.15) throw new Error("too many errors");
}

async function sweep(
  column: AiColumn,
  fromV: number,
  toV: number,
  label: string,
  rows: Row[],
): Promise<Record<string, unknown>> {
  const rowIds = rows.map((r) => String(r[ID_FIELD]));
  const cacheV = new Map(
    (await getCellsForVersion(column.id, fromV, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );
  const truth = new Map(
    (await getCellsForVersion(column.id, toV, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );
  const usable = rowIds.filter((id) => cacheV.has(id) && truth.has(id));
  const usableRows = rows.filter((r) => usable.includes(String(r[ID_FIELD])));
  const flips = usable.filter(
    (id) => JSON.stringify(cacheV.get(id)) !== JSON.stringify(truth.get(id)),
  );
  console.log(
    `\n=== ${label}: n=${usable.length}, flips ${flips.length} (${((flips.length / usable.length) * 100).toFixed(2)}%)`,
  );
  const sweeps = [];
  for (const alpha of ALPHAS) {
    let oracleCalls = 0;
    const outcome = await certifyColumnEdit(
      column,
      fromV,
      toV,
      usableRows,
      ID_FIELD,
      async (ids) => {
        oracleCalls += ids.length;
        return new Map(ids.map((id) => [id, truth.get(id)]));
      },
      { alpha, delta: DELTA, seed: SEED, apply: false, adaptive: true, maxLooks: 5 },
    );
    const falseReused = outcome.reusedRowIds.filter(
      (id) =>
        JSON.stringify(cacheV.get(id)) !== JSON.stringify(truth.get(id)),
    ).length;
    const realized =
      outcome.reusedRowIds.length > 0
        ? falseReused / outcome.reusedRowIds.length
        : 0;
    const savings =
      1 - (oracleCalls + outcome.recomputeRowIds.length) / usable.length;
    console.log(
      `  alpha=${alpha}: oracle=${oracleCalls} reused=${outcome.reusedRowIds.length} realized=${(realized * 100).toFixed(2)}% ${realized <= alpha ? "OK" : "VIOLATED"} savings=${(savings * 100).toFixed(1)}%`,
    );
    sweeps.push({
      alpha,
      oracleCalls,
      reused: outcome.reusedRowIds.length,
      falseReused,
      realizedFalseReuse: realized,
      savings,
      strata: outcome.strata,
    });
  }
  return {
    label,
    n: usable.length,
    trueFlipRate: flips.length / usable.length,
    sweeps,
  };
}

async function main() {
  const started = Date.now();
  const column = await ensureLabColumn();
  console.log(`djinni lab column ${column.id} v${column.prompt_version}`);
  const rows = await rowSample();
  console.log(`sample: ${rows.length} rows`);

  await ensureVersionCells(column, 1, rows);
  await ensureVersionCells(column, 2, rows);
  await ensureVersionCells(column, 3, rows);

  const results = [
    await sweep(column, 1, 2, "djinni formatting-only", rows),
    await sweep(column, 2, 3, "djinni criteria-change (leadership)", rows),
  ];

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp6-djinni.json",
    JSON.stringify(
      {
        experiment: "exp6-djinni",
        corpus: "djinni (210,250 English candidate profiles, MIT)",
        outputType: "select(4 tiers)",
        n: N,
        seed: SEED,
        decode: "temperature=0",
        results,
        wallMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  console.log("\nEXP6_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
