/**
 * Experiment 2: the edit-class savings curve, at pinned T=0.
 *
 * A dedicated LAB column (base prompt = the demo column's v2 text) receives
 * two REALISTIC localized edits:
 *   v1 -> v2  formatting-only (punctuation, line breaks, casing; no
 *             semantic content change)
 *   v2 -> v3  synonym rewording (meaning-preserving paraphrase)
 * Ground truth for all three versions on the same 2000-row draw as exp1
 * (seed 42), then certification sweeps for both transitions.
 *
 * Expected shape (the paper's central figure, with exp1 as the far end):
 *   formatting: flips ~ noise floor -> large certified reuse
 *   synonym:    slightly above noise -> substantial reuse
 *   widening (exp1): flips >> noise -> certifier refuses (safety)
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp2-editclass.ts
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
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { runColumn } from "../../lib/lore/run-column";

const N = Number(process.env.EXP_ROWS ?? 2000);
const ALPHAS = (process.env.EXP_ALPHAS ?? "0.05,0.1,0.2")
  .split(",")
  .map(Number);
const DELTA = 0.1;
const SEED = 42;
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const LAB_NAME = "Data-platform specialist (lab)";

type Row = Record<string, unknown>;

// v1 (base): the demo column's v2 prompt, verbatim.
const PROMPT_V1 = `Is this person a data-platform specialist? A data-platform specialist works primarily on data infrastructure: warehouses, lakes, pipelines, distributed data stores, ML data tooling, OR heavy analytics engineering. Judge from role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other tech {{misc_tech}}. Working with multiple analytical/distributed databases (BigQuery, Snowflake, Spark, Kafka, Elasticsearch) counts as evidence.`;

// v2: FORMATTING-ONLY edit — line breaks, punctuation, casing. Content words
// identical.
const PROMPT_V2 = `Is this person a data-platform specialist?

A data-platform specialist works primarily on data infrastructure: warehouses, lakes, pipelines, distributed data stores, ML data tooling, or heavy analytics engineering.

Judge from role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other tech {{misc_tech}}. Working with multiple analytical/distributed databases (BigQuery, Snowflake, Spark, Kafka, Elasticsearch) counts as evidence.`;

// v3: SYNONYM REWORDING of v2 — meaning-preserving paraphrase.
const PROMPT_V3 = `Is this individual a data-platform specialist?

A data-platform specialist chiefly builds and maintains data infrastructure: warehouses, lakes, pipelines, distributed data stores, ML data tooling, or intensive analytics engineering.

Decide using their role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other technologies {{misc_tech}}. Experience with several analytical/distributed databases (BigQuery, Snowflake, Spark, Kafka, Elasticsearch) is supporting evidence.`;

async function ensureLabColumn(): Promise<AiColumn> {
  const existing = (await listColumns("profiles")).find(
    (c) => c.name === LAB_NAME,
  );
  if (existing) return existing;
  const demo = (await listColumns("profiles")).find((c) =>
    c.name.startsWith("Data-platform specialist?"),
  );
  const col = await createColumn({
    tableId: "profiles",
    name: LAB_NAME,
    promptTemplate: PROMPT_V1,
    model: demo?.model ?? "deepseek/deepseek-v4-flash-0731",
    outputSpec: { kind: "boolean" },
  });
  await updateColumnPrompt(col.id, PROMPT_V2);
  await updateColumnPrompt(col.id, PROMPT_V3);
  return (await getColumn(col.id))!;
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
  const missing = rows.filter((r) => !have.has(String(r[PROFILE_ID_FIELD])));
  console.log(
    `lab v${version}: ${have.size} present, computing ${missing.length}`,
  );
  if (missing.length === 0) return;
  const v = await getColumnVersion(column.id, version);
  if (!v) throw new Error(`no lab version ${version}`);
  const res = await runColumn(column, missing, PROFILE_ID_FIELD, {
    concurrency: CONCURRENCY,
    versionOverride: {
      promptTemplate: v.prompt_template,
      promptVersion: version,
    },
  });
  console.log(
    `lab v${version}: ran=${res.ran} errors=${res.errors} cost=$${res.costUsd.toFixed(4)} in ${(res.ms / 1000).toFixed(0)}s`,
  );
  if (res.errors > res.ran * 0.1) throw new Error("too many errors");
}

async function sweep(
  column: AiColumn,
  fromV: number,
  toV: number,
  label: string,
  rows: Row[],
): Promise<Record<string, unknown>> {
  const rowIds = rows.map((r) => String(r[PROFILE_ID_FIELD]));
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
  const flips = usable.filter(
    (id) => JSON.stringify(cacheV.get(id)) !== JSON.stringify(truth.get(id)),
  );
  console.log(
    `\n=== ${label}: n=${usable.length}, true flips ${flips.length} (${((flips.length / usable.length) * 100).toFixed(2)}%)`,
  );

  const sweeps = [];
  for (const alpha of ALPHAS) {
    let oracleCalls = 0;
    const outcome = await certifyColumnEdit(
      column,
      fromV,
      toV,
      rows.filter((r) => usable.includes(String(r[PROFILE_ID_FIELD]))),
      PROFILE_ID_FIELD,
      async (ids) => {
        oracleCalls += ids.length;
        return new Map(ids.map((id) => [id, truth.get(id)]));
      },
      { alpha, delta: DELTA, seed: SEED, apply: false },
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
      `  alpha=${alpha}: sampled=${oracleCalls} reused=${outcome.reusedRowIds.length} recompute=${outcome.recomputeRowIds.length} realized=${(realized * 100).toFixed(2)}% ${realized <= alpha ? "OK" : "VIOLATED"} savings=${(savings * 100).toFixed(1)}%`,
    );
    for (const s of outcome.strata) {
      console.log(
        `    ${s.stratumId.padEnd(22)} size=${String(s.size).padStart(4)} sampled=${String(s.sampled).padStart(3)} flips=${s.flips} upper=${s.upperBound.toFixed(3)} ${s.certified ? "CERTIFIED" : "recompute"}`,
      );
    }
    sweeps.push({
      alpha,
      sampled: oracleCalls,
      reused: outcome.reusedRowIds.length,
      recompute: outcome.recomputeRowIds.length,
      falseReused,
      realizedFalseReuse: realized,
      savings,
      strata: outcome.strata,
    });
  }
  return {
    label,
    fromV,
    toV,
    n: usable.length,
    trueFlips: flips.length,
    trueFlipRate: flips.length / usable.length,
    sweeps,
  };
}

async function main() {
  const started = Date.now();
  const column = await ensureLabColumn();
  console.log(`lab column ${column.id} at v${column.prompt_version}`);

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
          /* keep */
        }
      }
    }
    return out;
  });

  await ensureVersionCells(column, 1, rows);
  await ensureVersionCells(column, 2, rows);
  await ensureVersionCells(column, 3, rows);

  const results = [
    await sweep(column, 1, 2, "formatting-only", rows),
    await sweep(column, 2, 3, "synonym-rewording", rows),
  ];

  const out = {
    experiment: "exp2-editclass",
    model: column.model,
    decode: "temperature=0",
    n: N,
    seed: SEED,
    delta: DELTA,
    noiseFloorRef: "exp0-stability.json (T0 self-flip 3.0%)",
    results,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp2-editclass.json",
    JSON.stringify(out, null, 2),
  );
  console.log("\nEXP2_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
