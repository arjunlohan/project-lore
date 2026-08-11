/**
 * Experiment 7: baseline comparisons on existing ground truth (SO corpus,
 * formatting + widening pairs). No new oracle spend beyond embeddings.
 *
 * B1. Flip-prediction signal: ROC-AUC of (a) sIVM's interaction score
 *     cosine(edit delta, row content) vs (b) a vCache-style cross-version
 *     score cosine(bound prompt v1, bound prompt v2) per row. A verified
 *     cache compares query-vs-entry similarity; across a definition change
 *     that similarity is dominated by the shared row text, so it should
 *     carry ~no signal about which cells flip.
 * B2. Aggregate-only certification (stale-cache-as-proxy, no strata):
 *     one global stratum with the same adaptive EB machinery. Valid for the
 *     aggregate estimand, but conceals subgroup error and loses tight-alpha
 *     power; we report per-value-subgroup realized error to expose it.
 * B3. Guarantee-free embedding transfer (GPTCache-adapted): reuse all
 *     cached cells when prompt-level similarity >= tau. Reports realized
 *     error with no bound.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp7-baselines.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { adaptiveCertifyStratum, diffPrompts, seededShuffle } from "@lore/core/sivm";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
  type AiColumn,
} from "../../lib/lore/column-store";
import { cosine, embedTexts } from "../../lib/lore/embed";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate } from "../../lib/lore/run-column";

const SEED = 42;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

function auc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i]! }));
  pairs.sort((a, b) => a.s - b.s);
  let rank = 1;
  let sumRankPos = 0;
  let nPos = 0;
  let nNeg = 0;
  for (const p of pairs) {
    if (p.y === 1) {
      sumRankPos += rank;
      nPos++;
    } else {
      nNeg++;
    }
    rank++;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (sumRankPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

async function rowSample(): Promise<Row[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT 2000`,
    [SEED],
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

async function analyzeEdit(
  column: AiColumn,
  fromV: number,
  toV: number,
  label: string,
  rows: Row[],
): Promise<Record<string, unknown>> {
  const vFrom = await getColumnVersion(column.id, fromV);
  const vTo = await getColumnVersion(column.id, toV);
  if (!vFrom || !vTo) throw new Error("versions missing");
  const rowIds = rows.map((r) => String(r[PROFILE_ID_FIELD]));
  const cache = new Map(
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
  const usableRows = rows.filter((r) => {
    const id = String(r[PROFILE_ID_FIELD]);
    return cache.has(id) && truth.has(id);
  });
  const flipOf = (id: string) =>
    JSON.stringify(cache.get(id)) !== JSON.stringify(truth.get(id)) ? 1 : 0;
  const labels = usableRows.map((r) => flipOf(String(r[PROFILE_ID_FIELD])));
  const flipRate = labels.reduce((a: number, b) => a + b, 0) / labels.length;

  // Embeddings: delta text, per-row bound v1 and v2 prompts.
  const delta = diffPrompts(vFrom.prompt_template, vTo.prompt_template);
  const deltaText = [...delta.added, ...delta.removed].join(" ") || "(none)";
  const bound1 = usableRows.map(
    (r) => bindTemplate(vFrom.prompt_template, r).text,
  );
  const bound2 = usableRows.map(
    (r) => bindTemplate(vTo.prompt_template, r).text,
  );
  const [deltaEmb, ...rest] = await embedTexts([
    deltaText,
    ...bound1,
    ...bound2,
  ]);
  const emb1 = rest.slice(0, bound1.length);
  const emb2 = rest.slice(bound1.length);

  // B1: AUCs.
  const interactionScores = emb1.map((e) => cosine(deltaEmb!, e));
  const vcacheScores = emb1.map((e, i) => cosine(e, emb2[i]!));
  const aucInteraction = auc(interactionScores, labels);
  const aucVcache = auc(
    vcacheScores.map((s) => -s), // lower similarity should mean more likely flip
    labels,
  );
  const simMin = Math.min(...vcacheScores);
  const simMax = Math.max(...vcacheScores);

  // B2: aggregate-only certification with the same adaptive machinery.
  const order = seededShuffle(
    usableRows.map((r) => String(r[PROFILE_ID_FIELD])),
    SEED,
  );
  const aggregate: Record<string, unknown> = {};
  for (const alpha of [0.05, 0.1, 0.2]) {
    const outcome = await adaptiveCertifyStratum(
      order.length,
      alpha,
      0.1,
      async (n) => order.slice(0, n).map(flipOf),
      45,
      6, // match the pinned primary schedule exactly (review r5, F10r)
    );
    const sampledSet = new Set(order.slice(0, outcome.sampled));
    const reused = outcome.certified
      ? order.filter((id) => !sampledSet.has(id))
      : [];
    const realized =
      reused.length > 0
        ? reused.map(flipOf).reduce((a: number, b) => a + b, 0) / reused.length
        : 0;
    // Subgroup exposure: realized error among reused rows whose cached
    // value is TRUE (the minority class stratified sIVM protects).
    const reusedTrue = reused.filter((id) => cache.get(id) === true);
    const realizedTrue =
      reusedTrue.length > 0
        ? reusedTrue.map(flipOf).reduce((a: number, b) => a + b, 0) /
          reusedTrue.length
        : null;
    aggregate[`alpha${alpha}`] = {
      certified: outcome.certified,
      sampled: outcome.sampled,
      reused: reused.length,
      realized,
      realizedTrueSubgroup: realizedTrue,
      savings: outcome.certified
        ? 1 - outcome.sampled / order.length
        : 0,
    };
  }

  // B3: guarantee-free embedding transfer, REAL tau sweep over per-row
  // similarities (reuse row i iff sim_i >= tau).
  const meanSim =
    vcacheScores.reduce((a: number, b) => a + b, 0) / vcacheScores.length;
  const tauSweep = [0.9, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99].map((tau) => {
    const reusedIdx = vcacheScores
      .map((s, i) => (s >= tau ? i : -1))
      .filter((i) => i >= 0);
    const err =
      reusedIdx.length > 0
        ? reusedIdx.reduce((a: number, i) => a + labels[i]!, 0) /
          reusedIdx.length
        : 0;
    return {
      tau,
      reusedFraction: reusedIdx.length / vcacheScores.length,
      realizedErrorAmongReused: err,
    };
  });
  const b3 = {
    meanPromptSimilarity: meanSim,
    simRange: [simMin, simMax],
    tauSweep,
  };

  console.log(`\n=== ${label}: flip ${(flipRate * 100).toFixed(2)}%`);
  console.log(
    `  B1 AUC: interaction=${aucInteraction.toFixed(3)} vcache-style=${aucVcache.toFixed(3)} (sim range ${simMin.toFixed(4)}-${simMax.toFixed(4)})`,
  );
  console.log(`  B2 aggregate-only:`, JSON.stringify(aggregate));
  console.log(`  B3 embedding transfer:`, JSON.stringify(b3));
  return {
    label,
    flipRate,
    aucInteraction,
    aucVcache,
    vcacheSimRange: [simMin, simMax],
    aggregate,
    b3,
  };
}

async function main() {
  const columns = await listColumns("profiles");
  const lab = columns.find((c) => c.name.includes("(lab)"))!;
  const demo = columns.find(
    (c) => c.name.startsWith("Data-platform specialist?"),
  )!;
  const rows = await rowSample();
  const results = [
    await analyzeEdit(lab, 1, 2, "formatting-only", rows),
    await analyzeEdit(demo, 1, 2, "scope-widening", rows),
  ];
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp7-baselines.json",
    JSON.stringify({ experiment: "exp7-baselines", results }, null, 2),
  );
  console.log("\nEXP7_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
