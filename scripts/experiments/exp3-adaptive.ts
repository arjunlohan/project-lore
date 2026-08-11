/**
 * Experiment 3: grid-adaptive certification vs fixed-sample, on the SAME
 * ground truth as exp1/exp2 (no new LLM calls). The adaptive certifier peeks
 * at a doubling look schedule (delta Bonferroni-split across looks): it
 * should (a) unlock alpha=0.05 on the formatting edit where fixed refused,
 * (b) stop early and cheaply on hopeless strata, (c) never violate a bound.
 *
 * Run: pnpm tsx scripts/experiments/exp3-adaptive.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  getCellsForVersion,
  listColumns,
  type AiColumn,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";

const ALPHAS = (process.env.EXP_ALPHAS ?? "0.02,0.05,0.1").split(",").map(Number);
const DELTA = 0.1;
const SEED = 42;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

async function rowSample(n: number): Promise<Row[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [SEED, n],
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
  const usableRows = rows.filter((r) =>
    usable.includes(String(r[PROFILE_ID_FIELD])),
  );
  const sweeps = [];
  console.log(`\n=== ${label} (n=${usable.length})`);
  for (const alpha of ALPHAS) {
    let oracleCalls = 0;
    const outcome = await certifyColumnEdit(
      column,
      fromV,
      toV,
      usableRows,
      PROFILE_ID_FIELD,
      async (ids) => {
        oracleCalls += ids.length;
        return new Map(ids.map((id) => [id, truth.get(id)]));
      },
      { alpha, delta: DELTA, seed: SEED, apply: false, adaptive: true, maxLooks: Number(process.env.EXP_MAXLOOKS ?? 4) },
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
      `  alpha=${alpha}: oracle=${oracleCalls} reused=${outcome.reusedRowIds.length} recompute=${outcome.recomputeRowIds.length} realized=${(realized * 100).toFixed(2)}% ${realized <= alpha ? "OK" : "VIOLATED"} savings=${(savings * 100).toFixed(1)}%`,
    );
    for (const s of outcome.strata) {
      console.log(
        `    ${s.stratumId.padEnd(22)} size=${String(s.size).padStart(4)} sampled=${String(s.sampled).padStart(3)} flips=${s.flips} upper=${s.upperBound.toFixed(3)} ${s.certified ? "CERTIFIED" : "recompute"}`,
      );
    }
    sweeps.push({
      alpha,
      oracleCalls,
      reused: outcome.reusedRowIds.length,
      recompute: outcome.recomputeRowIds.length,
      falseReused,
      realizedFalseReuse: realized,
      savings,
      strata: outcome.strata,
    });
  }
  return { label, fromV, toV, n: usable.length, sweeps };
}

async function main() {
  const columns = await listColumns("profiles");
  const lab = columns.find((c) => c.name.includes("(lab)"))!;
  const demo = columns.find(
    (c) => c.name.startsWith("Data-platform specialist?"),
  )!;
  const rows = await rowSample(2000);

  const results = [
    await sweep(lab, 1, 2, "formatting-only (adaptive)", rows),
    await sweep(lab, 2, 3, "synonym-rewording (adaptive)", rows),
    await sweep(demo, 1, 2, "scope-widening (adaptive)", rows),
  ];

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    process.env.EXP_OUT ?? "docs/research/experiments/exp3-adaptive.json",
    JSON.stringify(
      { experiment: "exp3-adaptive", alphas: ALPHAS, delta: DELTA, results },
      null,
      2,
    ),
  );
  console.log("\nEXP3_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
