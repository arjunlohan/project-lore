/**
 * Experiment 11c: the deployment-scale certificates re-derived under each
 * bound, from the oracle draws the live run (exp11) already stored.
 *
 * The live run certified the formatting edit on the full 89,184-row column
 * at alpha in {0.2, 0.1} under the Maurer-Pontil bound and persisted every
 * fresh v2 cell it drew. The certifier is deterministic given the seed and
 * those draws (same strata, same seeded order, same prefixes), so swapping
 * the bound is a replay over stored cells: zero model calls, unless a bound
 * asks for a deeper look than the live run took. In that case the replay
 * stops and reports how many fresh draws it would need; EXP_LIVE=1 lets it
 * compute exactly those cells with the real model (they persist, so a later
 * replay is free again).
 *
 * The "eb" arm must reproduce exp11 exactly (225 calls / 81,289 reused at
 * alpha=0.2; 765 / 80,749 at alpha=0.1); that equality is the check that the
 * replay walks the same path the live run did, and the script fails if it
 * does not. It did not, at first: the certifier took each stratum's row
 * order from the cell query's return order, which MySQL served through a
 * different index on 2026-08-05 (content-hash order) than it does now
 * (primary-key order), so the same seed drew a different sample. The
 * certifier now sorts by content hash before shuffling (lib/lore/certify.ts),
 * which is the order the reported run walked.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp11c-deployment-bounds.ts
 *   EXP_BOUNDS=eb,wor,exact,cp  EXP_ALPHAS=0.2,0.1,0.05  EXP_LIVE=0|1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { BoundKind } from "@lore/core/sivm";
import { certifyColumnEdit } from "../../lib/lore/certify";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
  totalSpendUsd,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { runColumn } from "../../lib/lore/run-column";

const BOUNDS = (process.env.EXP_BOUNDS ?? "eb,wor,exact,cp").split(",") as BoundKind[];
const ALPHAS = (process.env.EXP_ALPHAS ?? "0.2,0.1,0.05").split(",").map(Number);
const LIVE = process.env.EXP_LIVE === "1";
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
// Target version = model snapshot. Version 2 holds the August 2026 oracle
// draws of the v2 template (the live deployment run); version 4 holds the
// same template re-issued on 2026-09-29 (scripts/experiments/
// snapshot-versions.ts), so a certification against version 4 is a live
// certification inside the September snapshot, with the August cache.
const TO_VERSION = Number(process.env.EXP_TO_VERSION ?? 2);
const SNAPSHOT: Record<number, string> = { 2: "2026-08-05", 4: "2026-09-29" };
const OUT =
  process.env.EXP_OUT ??
  (TO_VERSION === 2
    ? "docs/research/experiments/exp11c-deployment-bounds.json"
    : `docs/research/experiments/exp11c-deployment-bounds-v${TO_VERSION}.json`);
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

class NeedsLiveDraws extends Error {
  constructor(
    public readonly missing: number,
    public readonly newRowsAtFailingLook: number,
  ) {
    super(`replay needs ${missing} fresh draws the live run never took (${newRowsAtFailingLook} new rows at the failing look)`);
  }
}

async function main() {
  if (LIVE && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error("EXP_LIVE=1 without AI_GATEWAY_API_KEY: refusing to run");
  }
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) =>
    c.name.includes("(lab)"),
  )!;
  const v2 = await getColumnVersion(lab.id, TO_VERSION);
  if (!v2) throw new Error(`version ${TO_VERSION} missing`);

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(`SELECT * FROM profiles`);
  // The released n=2,000 evaluation vector, by the exact query exp8 uses.
  const [relRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [42, 2000],
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
  const releasedVector = new Set(
    (relRaw as Row[]).map((r) => String(r[PROFILE_ID_FIELD])),
  );
  const v1cells = new Map(
    (await getCellsForVersion(lab.id, 1))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value]),
  );
  const oracleCells = () =>
    getCellsForVersion(lab.id, TO_VERSION).then(
      (cs) =>
        new Map(
          cs
            .filter((c) => c.status === "done" || c.status === "cached")
            .map((c) => [c.row_id, c.value]),
        ),
    );
  let stored = await oracleCells();
  console.log(
    `corpus ${rows.length} rows; target version ${TO_VERSION} (snapshot ${SNAPSHOT[TO_VERSION] ?? "?"}); stored oracle cells ${stored.size}; bounds ${BOUNDS.join(",")}; alphas ${ALPHAS.join(",")}; live=${LIVE}`,
  );

  const spendBefore = await totalSpendUsd();
  let liveCalls = 0;
  let liveRequested = 0;
  let liveCached = 0;
  const sweeps: Record<string, unknown>[] = [];
  // Reuse sets are kept so every arm can be audited at the END of the run
  // against every oracle cell of this snapshot, not against whatever cells
  // existed when the arm happened to run (an earlier version did the latter
  // and two arms with different reuse sets reported one audit pool).
  const reuseSets: Array<{ i: number; rowIds: string[] }> = [];
  for (const bound of BOUNDS) {
    for (const alpha of ALPHAS) {
      let oracleCalls = 0;
      let missingTotal = 0;
      const t0 = Date.now();
      try {
        const outcome = await certifyColumnEdit(
          lab,
          1,
          TO_VERSION,
          rows,
          PROFILE_ID_FIELD,
          async (rowIds) => {
            oracleCalls += rowIds.length;
            const missing = rowIds.filter((id) => !stored.has(id));
            if (missing.length > 0) {
              if (!LIVE) throw new NeedsLiveDraws(missing.length, rowIds.length);
              const missingSet = new Set(missing);
              const sampleRows = rows.filter((r) =>
                missingSet.has(String(r[PROFILE_ID_FIELD])),
              );
              const res = await runColumn(lab, sampleRows, PROFILE_ID_FIELD, {
                concurrency: CONCURRENCY,
                versionOverride: {
                  promptTemplate: v2.prompt_template,
                  promptVersion: TO_VERSION,
                },
              });
              liveCalls += res.ran;
              liveCached += res.cached;
              liveRequested += missing.length;
              missingTotal += missing.length;
              stored = await oracleCells();
              console.log(
                `  live: computed ${res.ran} fresh v2 cells (errors ${res.errors}) for ${bound} alpha=${alpha}`,
              );
            }
            const still = rowIds.filter((id) => !stored.has(id));
            if (still.length > 0) throw new NeedsLiveDraws(still.length, rowIds.length);
            return new Map(rowIds.map((id) => [id, stored.get(id)]));
          },
          {
            alpha,
            delta: 0.1,
            seed: 42,
            apply: false,
            adaptive: true,
            maxLooks: 6,
            bound,
          },
        );
        const covered =
          oracleCalls + outcome.reusedRowIds.length + outcome.recomputeRowIds.length;
        reuseSets.push({ i: sweeps.length, rowIds: outcome.reusedRowIds });
        const rec = {
          bound,
          alpha,
          status: "ok",
          n: rows.length,
          oracleCalls,
          liveDrawsThisArm: missingTotal,
          reused: outcome.reusedRowIds.length,
          recompute: outcome.recomputeRowIds.length,
          covered,
          savings: 1 - (oracleCalls + outcome.recomputeRowIds.length) / covered,
          replayWallMs: Date.now() - t0,
          gtOverlapReused: 0,
          gtOverlapFlips: 0,
          realizedOnOverlap: null as number | null,
          auditComposition: {
            fromReleasedVector: 0,
            fromRunOracle: 0,
            releasedOnlyFlips: 0,
            releasedOnlyRealized: null as number | null,
          },
          strata: outcome.strata,
        };
        sweeps.push(rec);
        console.log(
          `${bound} alpha=${alpha}: oracle=${oracleCalls} reused=${rec.reused} savings=${(rec.savings * 100).toFixed(2)}% ` +
            outcome.strata
              .map(
                (s) =>
                  `${s.stratumId}:${s.certified ? "cert" : "refused"}@${s.sampled}(k=${s.flips},u=${s.upperBound.toFixed(4)})`,
              )
              .join(" "),
        );
      } catch (err) {
        if (err instanceof NeedsLiveDraws) {
          sweeps.push({
            bound,
            alpha,
            status: "needs-live-draws",
            oracleCallsRequestedSoFar: oracleCalls,
            missingFreshDraws: err.missing,
            // The certifier asks for each look's new rows only, so the look
            // itself is the cumulative request count (this stratum is first).
            newRowsAtFailingLook: err.newRowsAtFailingLook,
          });
          console.log(
            `${bound} alpha=${alpha}: needs ${err.missing} fresh draws beyond the stored ones (requested ${oracleCalls}); rerun with EXP_LIVE=1`,
          );
        } else {
          throw err;
        }
      }
    }
  }
  // End-of-run audit: every arm's reuse set against every oracle cell of
  // this snapshot that exists now.
  stored = await oracleCells();
  const flipOf = (id: string) =>
    JSON.stringify(v1cells.get(id)) !== JSON.stringify(stored.get(id));
  for (const { i, rowIds } of reuseSets) {
    const rec = sweeps[i] as Record<string, unknown>;
    const overlap = rowIds.filter((id) => stored.has(id));
    const overlapFlips = overlap.filter(flipOf).length;
    const fromReleased = overlap.filter((id) => releasedVector.has(id));
    const releasedFlips = fromReleased.filter(flipOf).length;
    // Persisted so exp11b-verify.ts can recompute this audit from the row
    // identifiers and the stored cells alone, without the certifier.
    rec.auditedRowIds = overlap;
    rec.gtOverlapReused = overlap.length;
    rec.gtOverlapFlips = overlapFlips;
    rec.realizedOnOverlap = overlap.length > 0 ? overlapFlips / overlap.length : null;
    rec.auditComposition = {
      fromReleasedVector: fromReleased.length,
      fromRunOracle: overlap.length - fromReleased.length,
      releasedOnlyFlips: releasedFlips,
      releasedOnlyRealized: fromReleased.length > 0 ? releasedFlips / fromReleased.length : null,
    };
    console.log(`  audit ${rec.bound} alpha=${rec.alpha}: ${overlapFlips}/${overlap.length} = ${rec.realizedOnOverlap === null ? "n/a" : ((rec.realizedOnOverlap as number) * 100).toFixed(2) + "%"}`);
  }
  // Path check against the live run's persisted record (exp11-fullscale.json).
  const EXPECTED: Record<string, { oracleCalls: number; reused: number }> = {
    "eb@0.2": { oracleCalls: 225, reused: 81289 },
    "eb@0.1": { oracleCalls: 765, reused: 80749 },
  };
  for (const s of sweeps) {
    const exp = TO_VERSION === 2 ? EXPECTED[`${s.bound}@${s.alpha}`] : undefined;
    if (exp && s.status === "ok" && (s.oracleCalls !== exp.oracleCalls || s.reused !== exp.reused)) {
      throw new Error(
        `replay diverged from the live run at ${s.bound} alpha=${s.alpha}: got ${s.oracleCalls}/${s.reused}, expected ${exp.oracleCalls}/${exp.reused}`,
      );
    }
  }
  const spendAfter = await totalSpendUsd();
  // A replay over stored draws makes no calls, so its own accounting reads
  // zero; the accounting that matters is the live run's, and it must survive
  // the replays that add audits later. Carry it forward from the artifact on
  // disk unless this run itself drew live cells.
  type LiveRun = {
    ranAt: string;
    liveCalls: number;
    liveRequested: number;
    liveCached: number;
    ledgerSpendDeltaUsd: number;
    arms: Array<{ bound: string; alpha: number; liveDrawsThisArm: number; wallMs: number | null }>;
    source: string;
  };
  const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { liveRun?: LiveRun }) : {};
  const liveRun: LiveRun | null =
    liveCalls > 0
      ? {
          ranAt: new Date(started).toISOString(),
          liveCalls,
          liveRequested,
          liveCached,
          ledgerSpendDeltaUsd: spendAfter - spendBefore,
          arms: sweeps.map((w) => ({
            bound: String(w.bound),
            alpha: Number(w.alpha),
            liveDrawsThisArm: Number(w.liveDrawsThisArm ?? 0),
            wallMs: Number(w.replayWallMs ?? 0),
          })),
          source: "this run",
        }
      : (previous.liveRun ?? null);
  const out = {
    experiment: "exp11c-deployment-bounds",
    note:
      TO_VERSION === 2
        ? "deployment-scale certificates of the formatting edit re-derived under each bound from the live run's stored oracle draws (August 2026 snapshot); the eb arm reproduces exp11"
        : `deployment-scale certification of the formatting edit against the August cache, oracle drawn live inside the ${SNAPSHOT[TO_VERSION] ?? "later"} snapshot (version ${TO_VERSION})`,
    pair: `lab formatting v1->v${TO_VERSION}, FULL corpus`,
    toVersion: TO_VERSION,
    snapshot: SNAPSHOT[TO_VERSION] ?? null,
    n: rows.length,
    bounds: BOUNDS,
    alphas: ALPHAS,
    live: LIVE,
    liveCalls,
    liveRequested,
    liveCached,
    ledgerSpendDeltaUsd: spendAfter - spendBefore,
    liveRun,
    sweeps,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("EXP11C_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
