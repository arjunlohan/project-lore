/**
 * Export the benchmark's per-cell labels: for each of the five edit pairs,
 * the seeded evaluation vector's row identifiers in sampling order, the
 * cached value of each row under the pair's old version, and the fresh
 * oracle value under its new version (16,000 distinct version cells over
 * the eight column versions the pairs use).
 *
 * The labels live in the running system's database. This writes them to a
 * tracked artifact so that the benchmark is usable, and Table 1 of the paper
 * recomputable, from the repository alone:
 *
 *   EXP_STRATIFIER=value-only EXP_LABELS=docs/research/experiments/benchmark-labels.json \
 *     pnpm tsx scripts/experiments/exp8-final-table.ts
 *
 * needs neither the database nor a model endpoint. A value is null where the
 * row holds no oracle-computed cell of that version (status done or cached;
 * a certificate copy is not a label).
 *
 * Zero API cost.
 *
 * Run: pnpm tsx scripts/experiments/export-benchmark-labels.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { PAIRS, type PairDef } from "./pairs";
import { getCellsForVersion, listColumns } from "../../lib/lore/column-store";

const OUT = "docs/research/experiments/benchmark-labels.json";
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

/** The evaluation vector, by the exact queries exp8 uses (the projection
 * list changes which rows a seeded ORDER BY RAND returns). */
async function vector(pair: PairDef): Promise<string[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rows] =
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
  return (rows as Array<Record<string, unknown>>).map((r) =>
    String(r[pair.idField]),
  );
}

async function main() {
  const pairs: Record<string, unknown>[] = [];
  const versions = new Set<string>();
  for (const pair of PAIRS) {
    const column = (await listColumns(pair.corpus)).find((c) =>
      pair.columnMatch(c.name),
    );
    if (!column) throw new Error(`column for ${pair.key} not found`);
    const rowIds = await vector(pair);
    const oracle = async (version: number) =>
      new Map(
        (await getCellsForVersion(column.id, version, rowIds))
          .filter((c) => c.status === "done" || c.status === "cached")
          .map((c) => [c.row_id, c.value]),
      );
    const from = await oracle(pair.fromV);
    const to = await oracle(pair.toV);
    const aligned = (m: Map<string, unknown>) =>
      rowIds.map((id) => (m.has(id) ? m.get(id) : null));
    const usable = rowIds.filter((id) => from.has(id) && to.has(id));
    const flips = usable.filter(
      (id) => JSON.stringify(from.get(id)) !== JSON.stringify(to.get(id)),
    ).length;
    versions.add(`${pair.column}:v${pair.fromV}`);
    versions.add(`${pair.column}:v${pair.toV}`);
    pairs.push({
      key: pair.key,
      label: pair.label,
      corpus: pair.corpus,
      column: pair.column,
      columnType: pair.columnType,
      fromVersion: pair.fromV,
      toVersion: pair.toV,
      rowSeed: pair.rowSeed,
      idField: pair.idField,
      usable: usable.length,
      flips,
      rowIds,
      cached: aligned(from),
      fresh: aligned(to),
    });
    console.log(
      `${pair.key}: ${rowIds.length} rows, ${usable.length} usable, ${flips} flips (${((flips / usable.length) * 100).toFixed(2)}%)`,
    );
  }
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      artifact: "benchmark-labels",
      note: "per-cell labels of the five versioned edit pairs: rowIds is the seeded evaluation vector in sampling order; cached[i] is row i's value under the old version and fresh[i] its oracle value under the new version (one draw each, temperature 0); a flip is cached[i] != fresh[i]",
      columnVersions: [...versions].sort(),
      pairs,
    }),
  );
  console.log(
    `wrote ${OUT}: ${pairs.length} pairs over ${versions.size} column versions`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
