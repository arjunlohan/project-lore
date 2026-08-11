/**
 * Experiment 5: does a better interaction model (embedding cosine between
 * the prompt delta and the row's bound content) beat the lexical stratifier
 * on the edits it REFUSED (synonym, widening)?
 *
 * Stratifier quality cannot affect validity (strata are frozen pre-sampling)
 * so any certified stratum it finds is pure savings recovered from a
 * refusal. Ground truth is reused from exp1/exp2; only embeddings are new
 * spend (~$0.01).
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp5-embed-stratifier.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { assignStrataWith, type SivmCellInput } from "@lore/core/sivm";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
  type AiColumn,
} from "../../lib/lore/column-store";
import { cosine, embedTexts } from "../../lib/lore/embed";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";

const ALPHAS = [0.05, 0.1, 0.2];
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

  // Precompute the embedding interaction score for every usable row against
  // this edit's delta text, then bucket by tertile WITHIN this population.
  const vFrom = await getColumnVersion(column.id, fromV);
  const vTo = await getColumnVersion(column.id, toV);
  if (!vFrom || !vTo) throw new Error("versions missing");

  const { diffPrompts } = await import("@lore/core/sivm");
  const { bindTemplate } = await import("../../lib/lore/run-column");
  const delta = diffPrompts(vFrom.prompt_template, vTo.prompt_template);
  const deltaText = [...delta.added, ...delta.removed].join(" ") || "(none)";

  const boundTexts = usableRows.map(
    (r) => bindTemplate(vFrom.prompt_template, r).text,
  );
  const [deltaEmb, ...rowEmbs] = await embedTexts([deltaText, ...boundTexts]);
  const scoreByRow = new Map<string, number>();
  usableRows.forEach((r, i) => {
    scoreByRow.set(
      String(r[PROFILE_ID_FIELD]),
      cosine(deltaEmb!, rowEmbs[i]!),
    );
  });
  const sorted = [...scoreByRow.values()].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)]!;
  const t2 = sorted[Math.floor((2 * sorted.length) / 3)]!;
  const bucketOf = (c: SivmCellInput) => {
    const s = scoreByRow.get(c.rowId) ?? 0;
    return `e=${s <= t1 ? "low" : s <= t2 ? "mid" : "high"}`;
  };

  const sweeps = [];
  console.log(`\n=== ${label} (n=${usable.length}) embed-stratified`);
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
      {
        alpha,
        delta: DELTA,
        seed: SEED,
        apply: false,
        adaptive: true,
        maxLooks: 5,
        stratifier: (cells) => assignStrataWith(cells, bucketOf),
      },
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
    for (const s of outcome.strata) {
      console.log(
        `    ${s.stratumId.padEnd(24)} size=${String(s.size).padStart(4)} sampled=${String(s.sampled).padStart(3)} flips=${s.flips} upper=${s.upperBound.toFixed(3)} ${s.certified ? "CERTIFIED" : "recompute"}`,
      );
    }
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
  return { label, n: usable.length, sweeps };
}

async function main() {
  const columns = await listColumns("profiles");
  const lab = columns.find((c) => c.name.includes("(lab)"))!;
  const demo = columns.find(
    (c) => c.name.startsWith("Data-platform specialist?"),
  )!;
  const rows = await rowSample(2000);

  const results = [
    await sweep(lab, 2, 3, "synonym-rewording (embed)", rows),
    await sweep(demo, 1, 2, "scope-widening (embed)", rows),
  ];

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp5-embed-stratifier.json",
    JSON.stringify(
      { experiment: "exp5-embed-stratifier", alphas: ALPHAS, delta: DELTA, results },
      null,
      2,
    ),
  );
  console.log("\nEXP5_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
