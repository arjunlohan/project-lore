/**
 * Experiment 11: deployment-scale certification on the FULL corpus.
 *
 * Materializes the lab column v1 across all 89,184 profiles (the realistic
 * deployed state), then runs LIVE adaptive certification of the formatting
 * edit v1 -> v2 at alpha in {0.2, 0.1}: the oracle is the real model on
 * sampled rows only. Reports wall-clock, oracle calls, ledger dollars, and
 * reuse at scale; realized error is verified on the overlap with the
 * n=2,000 ground-truth subset. The headline claim under test: sample size
 * is table-size-independent, so savings grow with table size.
 *
 * Cost: ~$9.7 one-time v1 materialization (89K cells) + cents for oracle
 * samples. Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp11-fullscale.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
  totalSpendUsd,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { runColumn } from "../../lib/lore/run-column";

const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY missing: refusing to run (would silently error every cell)");
  }
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) =>
    c.name.includes("(lab)"),
  )!;
  const v1 = await getColumnVersion(lab.id, 1);
  const v2 = await getColumnVersion(lab.id, 2);
  if (!v1 || !v2) throw new Error("versions missing");

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(`SELECT * FROM profiles`);
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
  console.log(`corpus rows: ${rows.length}`);

  // Phase A: materialize v1 across the full corpus (skip existing).
  const spendBefore = await totalSpendUsd();
  const have = new Set(
    (await getCellsForVersion(lab.id, 1))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => c.row_id),
  );
  const missing = rows.filter(
    (r) => !have.has(String(r[PROFILE_ID_FIELD])),
  );
  console.log(`v1 present ${have.size}, computing ${missing.length}`);
  const matStart = Date.now();
  if (missing.length > 0) {
    const res = await runColumn(lab, missing, PROFILE_ID_FIELD, {
      concurrency: CONCURRENCY,
      versionOverride: {
        promptTemplate: v1.prompt_template,
        promptVersion: 1,
      },
    });
    console.log(
      `v1 materialization: ran=${res.ran} errors=${res.errors} cost=$${res.costUsd.toFixed(4)} in ${(res.ms / 60000).toFixed(1)}min`,
    );
    if (res.errors > missing.length * 0.05) {
      throw new Error(`materialization error rate too high (${res.errors}/${missing.length}): aborting`);
    }
  }
  const matMs = Date.now() - matStart;

  // Ground-truth labels for the realized-error audit: ORACLE-COMPUTED v2
  // cells only (status done/cached). Certificate copies are excluded by
  // construction, since they are verbatim v1 values and would register as
  // non-flips. We also record which audited rows come from the released
  // n=2,000 evaluation vector versus from this run's own oracle sampling.
  const gt2k = new Map(
    (await getCellsForVersion(lab.id, 2))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value]),
  );
  const dbv = await mysql.createConnection({ uri: MYSQL_URL });
  // NOTE: the projection list changes which rows MySQL's seeded ordering
  // returns (scan-order dependence), so the canonical evaluation sample is
  // defined by this EXACT query string, matching exp2/exp8.
  const [relRaw] = await dbv.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [42, 2000],
  );
  await dbv.end();
  const releasedVector = new Set(
    (relRaw as Row[]).map((r) => String(r[PROFILE_ID_FIELD])),
  );

  const sweeps: Record<string, unknown>[] = [];
  for (const alpha of [0.2, 0.1]) {
    const t0 = Date.now();
    let oracleCalls = 0;
    const outcome = await certifyColumnEdit(
      lab,
      1,
      2,
      rows,
      PROFILE_ID_FIELD,
      async (rowIds) => {
        oracleCalls += rowIds.length;
        const sampleRows = rows.filter((r) =>
          rowIds.includes(String(r[PROFILE_ID_FIELD])),
        );
        await runColumn(lab, sampleRows, PROFILE_ID_FIELD, {
          concurrency: CONCURRENCY,
          versionOverride: {
            promptTemplate: v2.prompt_template,
            promptVersion: 2,
          },
        });
        const fresh = (await getCellsForVersion(lab.id, 2, rowIds)).filter(
          (c) => c.status === "done" || c.status === "cached",
        );
        return new Map(fresh.map((c) => [c.row_id, c.value]));
      },
      {
        alpha,
        delta: 0.1,
        seed: 42,
        // Persist the certificate and SERVE the reused cells for the
        // headline budget: the deployment claim is that the system does
        // this, so the run must actually do it (review r7, P1).
        apply: process.env.EXP_APPLY === "1" && alpha === 0.2,
        adaptive: true,
        maxLooks: 6,
      },
    );
    const certifyMs = Date.now() - t0;

    // Realized error verified on GT overlap among reused rows.
    const v1cells = new Map(
      (await getCellsForVersion(lab.id, 1)).map((c) => [c.row_id, c.value]),
    );
    const overlap = outcome.reusedRowIds.filter((id) => gt2k.has(id));
    const overlapFlips = overlap.filter(
      (id) =>
        JSON.stringify(v1cells.get(id)) !== JSON.stringify(gt2k.get(id)),
    ).length;
    const fromReleased = overlap.filter((id) => releasedVector.has(id));
    const releasedFlips = fromReleased.filter(
      (id) =>
        JSON.stringify(v1cells.get(id)) !== JSON.stringify(gt2k.get(id)),
    ).length;

    const rec = {
      alpha,
      n: rows.length,
      oracleCalls,
      reused: outcome.reusedRowIds.length,
      recompute: outcome.recomputeRowIds.length,
      covered:
        oracleCalls + outcome.reusedRowIds.length + outcome.recomputeRowIds.length,
      savings:
        1 -
        (oracleCalls + outcome.recomputeRowIds.length) /
          (oracleCalls + outcome.reusedRowIds.length + outcome.recomputeRowIds.length),
      certifyWallMs: certifyMs,
      applied: process.env.EXP_APPLY === "1" && alpha === 0.2,
      certificateId: outcome.certificateId,
      gtOverlapReused: overlap.length,
      gtOverlapFlips: overlapFlips,
      realizedOnOverlap:
        overlap.length > 0 ? overlapFlips / overlap.length : null,
      auditComposition: {
        fromReleasedVector: fromReleased.length,
        fromRunOracle: overlap.length - fromReleased.length,
        releasedOnlyFlips: releasedFlips,
        releasedOnlyRealized:
          fromReleased.length > 0 ? releasedFlips / fromReleased.length : null,
      },
      auditedRowIds: overlap,
      strata: outcome.strata,
    };
    sweeps.push(rec);
    console.log(
      `alpha=${alpha}: oracle=${oracleCalls} reused=${rec.reused} recompute=${rec.recompute} savings=${(rec.savings * 100).toFixed(1)}% certify=${(certifyMs / 1000).toFixed(0)}s realized(GT overlap ${overlap.length})=${rec.realizedOnOverlap === null ? "n/a" : (rec.realizedOnOverlap * 100).toFixed(2) + "%"}`,
    );
  }

  const spendAfter = await totalSpendUsd();
  const out = {
    experiment: "exp11-fullscale",
    pair: "lab formatting v1->v2, FULL corpus",
    n: rows.length,
    materializationMs: matMs,
    ledgerSpendDeltaUsd: spendAfter - spendBefore,
    sweeps,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp11-fullscale.json",
    JSON.stringify(out, null, 2),
  );
  console.log("EXP11_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
