/**
 * Experiment 13 (review r5, N10/F13): head-to-head against a SUPG-style
 * proxy-certified selection baseline, transported to maintenance.
 *
 * SUPG (Kang et al.) selects a set with a target precision/recall by
 * thresholding a cheap PROXY score against an expensive oracle, using a
 * labelled sample to pick the threshold. Transported here, the natural
 * instantiation is: proxy score = the stale cached value (or an
 * embedding-interaction score), oracle = fresh computation under the new
 * prompt, target = "reuse as many cells as possible with false-reuse
 * <= alpha". A threshold is chosen from a labelled sample so that the
 * estimated false-reuse rate among selected (reused) cells clears alpha.
 *
 * Two competitors implemented on identical ground truth and identical
 * oracle budgets:
 *   SUPG-style: spend the same number of oracle labels as sIVM did, fit a
 *     threshold on the interaction score with a one-sided binomial upper
 *     bound on the selected set's flip rate, reuse everything above it.
 *   sIVM (ours): the pinned value-stratified adaptive procedure.
 *
 * Zero API cost (reuses stored labels + embeddings recomputed once).
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp13-supg.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import {
  adaptiveCertifyStratum,
  diffPrompts,
  seededShuffle,
  upperBoundFor,
  type BoundKind,
} from "@lore/core/sivm";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { cosine, embedTexts } from "../../lib/lore/embed";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate } from "../../lib/lore/run-column";

const ALPHAS = [0.1, 0.2];
const DELTA = 0.1;
const SEED = 42;
// Both arms spend their budget through the same bound, so the comparison
// isolates per-stratum against aggregate certification and nothing else.
const BOUND = (process.env.EXP_BOUND ?? "exact") as BoundKind;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

const PAIRS = [
  { key: "so-formatting", match: (n: string) => n.includes("(lab)"), from: 1, to: 2 },
  { key: "so-widening", match: (n: string) => n.startsWith("Data-platform specialist?"), from: 1, to: 2 },
];

async function main() {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [SEED, 2000],
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

  const results: Record<string, unknown>[] = [];
  for (const pair of PAIRS) {
    const col = (await listColumns("profiles")).find((c) => pair.match(c.name))!;
    const vF = await getColumnVersion(col.id, pair.from);
    const vT = await getColumnVersion(col.id, pair.to);
    if (!vF || !vT) continue;
    const ids = rows.map((r) => String(r[PROFILE_ID_FIELD]));
    const cache = new Map(
      (await getCellsForVersion(col.id, pair.from, ids))
        .filter((c) => c.status === "done" || c.status === "cached")
        .map((c) => [c.row_id, c.value]),
    );
    const truth = new Map(
      (await getCellsForVersion(col.id, pair.to, ids))
        .filter((c) => c.status === "done" || c.status === "cached")
        .map((c) => [c.row_id, c.value]),
    );
    const usable = rows.filter((r) => {
      const id = String(r[PROFILE_ID_FIELD]);
      return cache.has(id) && truth.has(id);
    });
    const flip = (id: string) =>
      JSON.stringify(cache.get(id)) !== JSON.stringify(truth.get(id)) ? 1 : 0;

    // Proxy score for the SUPG-style competitor: embedding interaction.
    const delta = diffPrompts(vF.prompt_template, vT.prompt_template);
    const deltaText = [...delta.added, ...delta.removed].join(" ") || "(none)";
    const bound = usable.map((r) => bindTemplate(vF.prompt_template, r).text);
    const [dEmb, ...rEmb] = await embedTexts([deltaText, ...bound]);
    const score = new Map<string, number>();
    usable.forEach((r, i) =>
      score.set(String(r[PROFILE_ID_FIELD]), -cosine(dEmb!, rEmb[i]!)),
    ); // higher = less interaction = safer to reuse

    const perPair: Record<string, unknown>[] = [];
    for (const alpha of ALPHAS) {
      // --- sIVM (ours): pinned value strata, adaptive.
      const strata = [true, false].map((v) => {
        const members = usable
          .map((r) => String(r[PROFILE_ID_FIELD]))
          .filter((id) => cache.get(id) === v);
        // Same id format as assignStrataWith ("v=<value>|<bucket>"), so
        // the id-derived seed matches exp8 exactly (review r7, M1).
        return { id: `v=${v}|all`, members };
      });
      let sivmOracle = 0;
      let sivmReused = 0;
      let sivmReusedFlips = 0;
      let sivmCertTotal = 0;
      for (const st of strata) {
        if (st.members.length === 0) continue;
        // Seed exactly as the pinned procedure does in exp8, so this arm
        // reproduces Table 1 rather than a differently-shuffled variant.
        const order = seededShuffle(st.members, SEED + st.id.length * 7919);
        const o = await adaptiveCertifyStratum(
          st.members.length,
          alpha,
          DELTA / strata.length,
          async (n) => order.slice(0, n).map(flip),
          45,
          6,
          "presented",
          BOUND,
        );
        sivmOracle += o.sampled;
        if (o.certified) {
          const rest = order.slice(o.sampled);
          sivmReused += rest.length;
          sivmReusedFlips += rest.reduce((a, id) => a + flip(id), 0);
          sivmCertTotal += st.members.length;
        }
      }

      // --- SUPG-style: same oracle budget, threshold on the proxy.
      const budget = sivmOracle;
      const all = seededShuffle(
        usable.map((r) => String(r[PROFILE_ID_FIELD])),
        SEED + 1,
      );
      const labelled = all.slice(0, budget);
      const rest = all.slice(budget);
      // Candidate thresholds = quantiles of the proxy on the labelled set.
      const sorted = [...labelled].sort(
        (a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0),
      );
      let bestTau: number | null = null;
      let bestSelected = 0;
      // Match sIVM's multiplicity handling: sIVM spends DELTA/(strata*looks)
      // per test, so SUPG gets DELTA/(number of thresholds it searches).
      const nThresholds = Math.max(1, sorted.length - 9);
      const supgDelta = DELTA / nThresholds;
      for (let k = sorted.length; k >= 10; k--) {
        const tau = score.get(sorted[k - 1]!)!;
        const sel = labelled.filter((id) => (score.get(id) ?? 0) >= tau);
        const flips = sel.map(flip);
        const selectedAll = rest.filter((id) => (score.get(id) ?? 0) >= tau);
        // One-sided upper bound on the selected population's flip rate at
        // the multiplicity-corrected level, under the SAME bound sIVM uses
        // (the labelled rows above tau are a uniform without-replacement
        // sample of the population above tau, whose size the exact bound
        // takes as N).
        const ucb = upperBoundFor(BOUND, flips, supgDelta, sel.length + selectedAll.length);
        if (ucb <= alpha) {
          if (selectedAll.length > bestSelected) {
            bestSelected = selectedAll.length;
            bestTau = tau;
          }
        }
      }
      const supgReused = bestTau === null
        ? []
        : rest.filter((id) => (score.get(id) ?? 0) >= bestTau!);
      const supgFlips = supgReused.reduce((a, id) => a + flip(id), 0);
      // The decisive comparison: where does each method's error LAND?
      const supgTrue = supgReused.filter((id) => cache.get(id) === true);
      const supgTrueFlips = supgTrue.reduce((a, id) => a + flip(id), 0);

      // ARM 2: the cached VALUE as proxy, which is the reduction Section 3
      // names. Threshold search over the two value levels.
      let valueBest: string[] = [];
      for (const keep of [[false], [true], [false, true]]) {
        const sel = labelled.filter((id) => keep.includes(cache.get(id) === true));
        if (sel.length < 10) continue;
        const selAll = rest.filter((id) => keep.includes(cache.get(id) === true));
        if (upperBoundFor(BOUND, sel.map(flip), DELTA / 3, sel.length + selAll.length) <= alpha) {
          if (selAll.length > valueBest.length) valueBest = selAll;
        }
      }
      const valueFlips = valueBest.reduce((a, id) => a + flip(id), 0);
      const valueTrue = valueBest.filter((id) => cache.get(id) === true);

      perPair.push({
        alpha,
        multiplicity: {
          sivmTestsPerStratum: 6,
          sivmPerTestDelta: DELTA / strata.length / 6,
          valueArmTests: 3,
          valueArmPerTestDelta: DELTA / 3,
          embeddingArmTests: Math.max(1, budget - 9),
          embeddingArmPerTestDelta: DELTA / Math.max(1, budget - 9),
        },
        supgValueProxy: {
          reused: valueBest.length,
          realizedAmongReused:
            valueBest.length > 0 ? valueFlips / valueBest.length : null,
          reusedTrueSubgroup: valueTrue.length,
        },
        sivm: {
          // sIVM never reuses the volatile cached-TRUE stratum here, so its
          // subgroup exposure is zero by construction of the certificate.
          reusedTrueSubgroup: 0,
          oracle: sivmOracle,
          reused: sivmReused,
          realizedPresented:
            sivmCertTotal > 0 ? sivmReusedFlips / sivmCertTotal : null,
          // LIKE-FOR-LIKE with SUPG's reported quantity (review r6, M1).
          realizedAmongReused:
            sivmReused > 0 ? sivmReusedFlips / sivmReused : null,
          savings: 1 - (sivmOracle + (usable.length - sivmOracle - sivmReused)) / usable.length,
        },
        supg: {
          oracle: budget,
          reused: supgReused.length,
          realizedAmongReused:
            supgReused.length > 0 ? supgFlips / supgReused.length : null,
          savings:
            1 - (budget + (usable.length - budget - supgReused.length)) / usable.length,
          thresholdFound: bestTau !== null,
          reusedTrueSubgroup: supgTrue.length,
          realizedTrueSubgroup:
            supgTrue.length > 0 ? supgTrueFlips / supgTrue.length : null,
        },
      });
      const p = perPair[perPair.length - 1]! as {
        sivm: { reused: number; realizedPresented: number | null };
        supg: { reused: number; realizedAmongReused: number | null };
      };
      console.log(
        `${pair.key} α=${alpha}: sIVM reused=${p.sivm.reused} realized=${p.sivm.realizedPresented === null ? "n/a" : (p.sivm.realizedPresented * 100).toFixed(2) + "%"} | SUPG-style reused=${p.supg.reused} realized=${p.supg.realizedAmongReused === null ? "n/a" : (p.supg.realizedAmongReused * 100).toFixed(2) + "%"} (same ${budget}-call budget) | SUPG TRUE-subgroup: ${(perPair[perPair.length-1] as {supg:{reusedTrueSubgroup:number;realizedTrueSubgroup:number|null}}).supg.reusedTrueSubgroup} rows at ${(() => { const x=(perPair[perPair.length-1] as {supg:{realizedTrueSubgroup:number|null}}).supg.realizedTrueSubgroup; return x===null?"n/a":(x*100).toFixed(1)+"%";})()}`,
      );
    }
    results.push({ pair: pair.key, n: usable.length, sweeps: perPair });
  }

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp13-supg.json",
    JSON.stringify(
      {
        experiment: "exp13-supg",
        note: "head-to-head at identical oracle budgets: SUPG-style proxy thresholding vs sIVM value-stratified adaptive certification",
        delta: DELTA,
        results,
      },
      null,
      2,
    ),
  );
  console.log("EXP13_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
