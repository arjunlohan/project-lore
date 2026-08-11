/**
 * Experiment 11b (review r4, finding R5): a REPRODUCIBLE audit of the
 * deployment run's realized error.
 *
 * The r4 panel correctly objected that exp11's inline check read v2 cells
 * without a status filter, so certificate-copied values (`reused_certified`,
 * verbatim copies of v1) could register as non-flips by construction, and
 * the audited set (2,047 rows) exceeded the released 2,000-row label
 * vector. This script recomputes the audit under explicit constraints:
 *
 *   - label set: EXACTLY the released n=2,000 evaluation sample (seed 42),
 *   - v2 labels: status in (done, cached) ONLY - never reused_certified,
 *   - audited rows: those labels intersected with the deployment reuse set,
 *   - reported: realized error, the audited count, and the composition.
 *
 * Zero API cost (reads stored cells only).
 *
 * Run: pnpm tsx scripts/experiments/exp11b-verify.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import {
  getCellsForVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";

const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const SEED = 42;

async function main() {
  const lab = (await listColumns("profiles")).find((c) =>
    c.name.includes("(lab)"),
  )!;

  // The released evaluation sample: same query/seed as exp8.
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  // Canonical sample: EXACT query string of exp2/exp8 (the projection list
  // changes which rows a seeded ORDER BY RAND returns).
  const [sampleRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [SEED, 2000],
  );
  await db.end();
  const labelSet = new Set(
    (sampleRaw as Array<Record<string, unknown>>).map((r) =>
      String(r[PROFILE_ID_FIELD]),
    ),
  );

  // v1 cache and v2 ORACLE labels (computed only; never certificate copies).
  const v1 = new Map(
    (await getCellsForVersion(lab.id, 1))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value]),
  );
  const v2All = await getCellsForVersion(lab.id, 2);
  const v2Oracle = new Map(
    v2All
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value]),
  );
  const excludedCopies = v2All.filter(
    (c) => c.status === "reused_certified",
  ).length;

  const deploy = JSON.parse(
    readFileSync("docs/research/experiments/exp11-fullscale.json", "utf8"),
  );

  const out: Record<string, unknown>[] = [];
  for (const sweep of deploy.sweeps as Array<{
    alpha: number;
    strata: Array<{ stratumId: string; size: number; sampled: number; certified: boolean }>;
  }>) {
    // Audit the PERSISTED reuse set recorded by the run (reconstructing it
    // from a shuffle is not faithful: the run's row order comes from the
    // corpus query, not from a sorted id list).
    const certified = sweep.strata.filter((s) => s.certified);
    const persisted = (sweep as unknown as { auditedRowIds?: string[] })
      .auditedRowIds;
    if (!persisted) {
      throw new Error(
        "exp11 artifact predates persisted auditedRowIds; re-run exp11",
      );
    }
    const flipsIn = (ids: string[]) =>
      ids.filter(
        (id) => JSON.stringify(v1.get(id)) !== JSON.stringify(v2Oracle.get(id)),
      ).length;

    // The paper reports TWO audit figures and claims this script reproduces
    // both, so compute both here rather than only the narrower one:
    //   full     - every reused row that carries an oracle-computed v2 label,
    //   released - that set intersected with the released n=2,000 vector,
    //              which is the subset a third party can rebuild from the
    //              published artifacts alone.
    const auditAll = persisted.filter((id) => v2Oracle.has(id));
    const auditRows = auditAll.filter((id) => labelSet.has(id));
    const flipsAll = flipsIn(auditAll);
    const flips = flipsIn(auditRows);
    const rec = {
      alpha: sweep.alpha,
      auditedRowsAll: auditAll.length,
      flipsAll,
      realizedErrorAll: auditAll.length > 0 ? flipsAll / auditAll.length : null,
      auditedRows: auditRows.length,
      flips,
      realizedError: auditRows.length > 0 ? flips / auditRows.length : null,
      certifiedStrata: certified.map((s) => s.stratumId),
    };
    out.push(rec);
    const p = (x: number | null) =>
      x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
    console.log(
      `alpha=${sweep.alpha}: full audit ${rec.auditedRowsAll} rows (reuse set ∩ oracle-computed v2), flips ${flipsAll}, realized ${p(rec.realizedErrorAll)} | released-vector subset ${rec.auditedRows} rows, flips ${flips}, realized ${p(rec.realizedError)}`,
    );
  }
  console.log(
    `excluded ${excludedCopies} reused_certified cells from labels (would be non-flips by construction)`,
  );

  writeFileSync(
    "docs/research/experiments/exp11b-verify.json",
    JSON.stringify(
      {
        experiment: "exp11b-verify",
        note: "reproducible audit of deployment realized error; labels restricted to the released n=2000 vector and to oracle-computed v2 cells (status done/cached), excluding certificate copies",
        labelVectorSize: labelSet.size,
        excludedCertificateCopies: excludedCopies,
        sweeps: out,
      },
      null,
      2,
    ),
  );
  console.log("EXP11B_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
