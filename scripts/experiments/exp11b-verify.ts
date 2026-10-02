/**
 * Experiment 11b (review r4, finding R5): a REPRODUCIBLE audit of the
 * deployment runs' realized error.
 *
 * The r4 panel correctly objected that exp11's inline check read v2 cells
 * without a status filter, so certificate-copied values (`reused_certified`,
 * verbatim copies of v1) could register as non-flips by construction, and
 * the audited set (2,047 rows) exceeded the released 2,000-row label
 * vector. This script recomputes each audit under explicit constraints:
 *
 *   - audited rows: the row identifiers the run persisted (its reuse set
 *     intersected with the oracle-computed cells of the target version),
 *   - oracle labels: status in (done, cached) ONLY - never reused_certified,
 *   - reported: the audited count, the flips among them, and the same two
 *     figures on the released n=2,000 evaluation sample (seed 42).
 *
 * It covers every deployment artifact whose audit the paper prints: the live
 * August run (exp11), its replays under each bound (exp11c, version 2), and
 * the September re-certification (exp11c, version 4). It imports nothing
 * from the certifier, and it fails if a recomputed audit disagrees with the
 * one the artifact records.
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
const DIR = "docs/research/experiments";
// exp11 recorded its audit when the run finished; the replays audit against
// every oracle cell that exists now, so their audited sets are larger.
const SOURCES: Array<{ file: string; toVersion: number; recordedAudit: boolean }> = [
  { file: "exp11-fullscale.json", toVersion: 2, recordedAudit: false },
  { file: "exp11c-deployment-bounds.json", toVersion: 2, recordedAudit: true },
  { file: "exp11c-deployment-bounds-v4.json", toVersion: 4, recordedAudit: true },
];

type Sweep = {
  bound?: string;
  alpha: number;
  status?: string;
  auditedRowIds?: string[];
  gtOverlapReused?: number;
  gtOverlapFlips?: number;
  auditComposition?: { fromReleasedVector: number; releasedOnlyFlips: number };
  strata?: Array<{ stratumId: string; certified: boolean }>;
};

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

  // v1 cache and ORACLE labels per target version (computed only; never
  // certificate copies).
  const v1 = new Map(
    (await getCellsForVersion(lab.id, 1))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value]),
  );
  const oracle = new Map<number, Map<string, unknown>>();
  const excludedCopies: Record<string, number> = {};
  for (const version of new Set(SOURCES.map((s) => s.toVersion))) {
    const cells = await getCellsForVersion(lab.id, version);
    oracle.set(
      version,
      new Map(
        cells
          .filter((c) => c.status === "done" || c.status === "cached")
          .map((c) => [c.row_id, c.value]),
      ),
    );
    excludedCopies[`v${version}`] = cells.filter(
      (c) => c.status === "reused_certified",
    ).length;
  }

  const p = (x: number | null) =>
    x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
  const audits: Record<string, unknown>[] = [];
  for (const source of SOURCES) {
    const labels = oracle.get(source.toVersion)!;
    const artifact = JSON.parse(readFileSync(`${DIR}/${source.file}`, "utf8"));
    for (const sweep of artifact.sweeps as Sweep[]) {
      if (sweep.status !== undefined && sweep.status !== "ok") continue;
      // Audit the PERSISTED row identifiers recorded by the run
      // (reconstructing the reuse set from a shuffle would need the
      // certifier's row order, and so the certifier).
      const persisted = sweep.auditedRowIds;
      if (!persisted) {
        throw new Error(
          `${source.file} predates persisted auditedRowIds; re-run it`,
        );
      }
      if (persisted.length === 0) continue;
      const flipsIn = (ids: string[]) =>
        ids.filter(
          (id) => JSON.stringify(v1.get(id)) !== JSON.stringify(labels.get(id)),
        ).length;

      // The paper reports TWO audit figures per certificate and claims this
      // script reproduces both, so compute both:
      //   full     - every reused row that carries an oracle-computed label,
      //   released - that set intersected with the released n=2,000 vector,
      //              which is the subset a third party can rebuild from the
      //              published artifacts alone.
      const auditAll = persisted.filter((id) => labels.has(id));
      const auditRows = auditAll.filter((id) => labelSet.has(id));
      const flipsAll = flipsIn(auditAll);
      const flips = flipsIn(auditRows);
      if (
        source.recordedAudit &&
        (auditAll.length !== sweep.gtOverlapReused ||
          flipsAll !== sweep.gtOverlapFlips ||
          auditRows.length !== sweep.auditComposition?.fromReleasedVector ||
          flips !== sweep.auditComposition?.releasedOnlyFlips)
      ) {
        throw new Error(
          `${source.file} ${sweep.bound}@${sweep.alpha}: recomputed audit ${flipsAll}/${auditAll.length} (released ${flips}/${auditRows.length}) disagrees with the recorded ${sweep.gtOverlapFlips}/${sweep.gtOverlapReused}`,
        );
      }
      const rec = {
        source: source.file,
        toVersion: source.toVersion,
        bound: sweep.bound ?? "eb",
        alpha: sweep.alpha,
        auditedRowsAll: auditAll.length,
        flipsAll,
        realizedErrorAll: auditAll.length > 0 ? flipsAll / auditAll.length : null,
        auditedRows: auditRows.length,
        flips,
        realizedError: auditRows.length > 0 ? flips / auditRows.length : null,
        certifiedStrata: (sweep.strata ?? [])
          .filter((s) => s.certified)
          .map((s) => s.stratumId),
      };
      audits.push(rec);
      console.log(
        `${source.file} ${rec.bound} alpha=${sweep.alpha}: full audit ${rec.auditedRowsAll} rows (reuse set ∩ oracle-computed v${source.toVersion}), flips ${flipsAll}, realized ${p(rec.realizedErrorAll)} | released-vector subset ${rec.auditedRows} rows, flips ${flips}, realized ${p(rec.realizedError)}`,
      );
    }
  }
  for (const [version, n] of Object.entries(excludedCopies)) {
    console.log(
      `${version}: excluded ${n} reused_certified cells from labels (would be non-flips by construction)`,
    );
  }

  writeFileSync(
    `${DIR}/exp11b-verify.json`,
    JSON.stringify(
      {
        experiment: "exp11b-verify",
        note: "audit of deployment realized error recomputed from each run's persisted row identifiers and the stored cells, without the certifier; labels restricted to oracle-computed cells (status done/cached), excluding certificate copies; the released-vector figures restrict further to the released n=2000 sample",
        labelVectorSize: labelSet.size,
        excludedCertificateCopies: excludedCopies,
        audits,
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
