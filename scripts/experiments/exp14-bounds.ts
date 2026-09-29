/**
 * Experiment 14: is Maurer-Pontil actually the right bound?
 *
 * The paper's proof sketch ASSERTS, without measuring it, that finite-
 * population and betting bounds "are not uniformly tighter than
 * Maurer-Pontil at our sample sizes (at n=90 their linear term alone exceeds
 * alpha=0.2), so adopting them would refuse certificates this procedure
 * currently issues." That is a load-bearing claim: it is the stated reason
 * the paper does not close the without-replacement gap in Assumption 3, and
 * it is the reason the economics live only at alpha=0.2.
 *
 * This measures it. Three bounds, swapped inside the SAME pinned procedure
 * over the SAME stored labels:
 *   eb      Maurer-Pontil empirical-Bernstein (what the paper certifies with),
 *           spent at delta/K/looks (Bonferroni across looks),
 *   betting Waudby-Smith & Ramdas hedged capital, a confidence SEQUENCE, so
 *           it is anytime-valid and spends delta/K with NO split across looks,
 *   wor     Bardenet & Maillard empirical-Bernstein-Serfling, which tightens
 *           as the sampling fraction grows.
 *
 * The betting arm is the interesting one: it pays a wider per-look interval
 * but avoids the Bonferroni split, and the paper's schedule takes up to six
 * looks, so the comparison is not obvious a priori.
 *
 * Zero API cost: replays stored ground-truth labels.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp14-bounds.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import {
  adaptiveCertifyStratum,
  bettingUpperBound,
  binomialUpperBound,
  ebUpperBound,
  exactUpperBound,
  seededShuffle,
  worUpperBound,
} from "@lore/core/sivm";
import { getCellsForVersion, listColumns } from "../../lib/lore/column-store";
import { PAIRS } from "./pairs";

const ALPHAS = [0.02, 0.05, 0.1, 0.2];
// Resubmission arms: "exact" is the finite-population (hypergeometric)
// bound the procedure now certifies with; "cp" is its binomial
// Clopper-Pearson limit, the exact bound a reviewer named.
const BOUNDS = ["eb", "betting", "wor", "exact", "cp"] as const;
const DELTA = 0.1;
const SEED = 42;
const N0 = 45;
const MAX_LOOKS = 6;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

async function loadRows(corpus: string, seed: number): Promise<Row[]> {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [raw] =
    corpus === "profiles"
      ? await db.query(`SELECT * FROM profiles ORDER BY RAND(?) LIMIT 2000`, [
          seed,
        ])
      : await db.query(
          `SELECT * FROM djinni_profiles ORDER BY RAND(?) LIMIT 2000`,
          [seed],
        );
  await db.end();
  return raw as Row[];
}

async function main() {
  const started = Date.now();
  const results: Record<string, unknown>[] = [];

  for (const pair of PAIRS) {
    const cols = await listColumns(
      pair.corpus === "profiles" ? "profiles" : "djinni",
    );
    const col = cols.find((c) => pair.columnMatch(c.name));
    if (!col) {
      console.log(`skip ${pair.key}: column not found`);
      continue;
    }
    const rows = await loadRows(pair.corpus, pair.rowSeed);
    const ids = rows.map((r) => String(r[pair.idField]));
    const oracleOnly = (
      cs: Array<{ row_id: string; value: unknown; status: string }>,
    ) =>
      new Map(
        cs
          .filter((c) => c.status === "done" || c.status === "cached")
          .map((c) => [c.row_id, c.value]),
      );
    const cache = oracleOnly(
      await getCellsForVersion(col.id, pair.fromV, ids),
    );
    const truth = oracleOnly(await getCellsForVersion(col.id, pair.toV, ids));
    const usable = ids.filter((id) => cache.has(id) && truth.has(id));
    const flipOf = (id: string) =>
      JSON.stringify(cache.get(id)) !== JSON.stringify(truth.get(id)) ? 1 : 0;

    // The pinned stratification: cached value only.
    const strata = [...new Set(usable.map((id) => JSON.stringify(cache.get(id))))]
      .map((v) => ({
        id: `v=${v}|all`,
        members: usable.filter((id) => JSON.stringify(cache.get(id)) === v),
      }))
      .filter((s) => s.members.length > 0);

    for (const alpha of ALPHAS) {
      for (const bound of BOUNDS) {
        let sampled = 0;
        let reused = 0;
        let reusedFlips = 0;
        let certifiedCells = 0;
        const certified: string[] = [];
        const looksByStratum: Record<string, unknown> = {};
        for (const st of strata) {
          const order = seededShuffle(st.members, SEED + st.id.length * 7919);
          const o = await adaptiveCertifyStratum(
            st.members.length,
            alpha,
            DELTA / strata.length,
            async (n) => order.slice(0, n).map(flipOf),
            N0,
            MAX_LOOKS,
            "presented",
            bound,
          );
          sampled += o.sampled;
          if (o.certified) {
            certified.push(st.id);
            const rest = order.slice(o.sampled);
            reused += rest.length;
            reusedFlips += rest.reduce((a, id) => a + flipOf(id), 0);
            certifiedCells += st.members.length;
          }
          looksByStratum[st.id] = o.looks;
        }
        results.push({
          pair: pair.key,
          alpha,
          bound,
          n: usable.length,
          oracle: sampled,
          reused,
          certifiedStrata: certified,
          savings: usable.length > 0 ? reused / usable.length : 0,
          realizedPresented:
            certifiedCells > 0 ? reusedFlips / certifiedCells : null,
          looks: looksByStratum,
        });
      }
      const row = results.slice(-BOUNDS.length);
      console.log(
        `${pair.key} a=${alpha}: ` +
          row
            .map(
              (r) =>
                `${r.bound}=${((r.savings as number) * 100).toFixed(1)}%(${r.oracle})`,
            )
            .join("  "),
      );
    }
  }

  // The proof sketch's specific claim: at n=90, is the betting/WoR linear term
  // alone already above alpha=0.2? Test it on a clean (all-zero) sample.
  const perLook = DELTA / 2 / 6;
  const clean90 = new Array<number>(90).fill(0);
  const CLEAN_N = 1800;
  const atN90 = {
    n: 90,
    N: CLEAN_N,
    perLookDelta: perLook,
    eb: ebUpperBound(clean90, perLook),
    betting: bettingUpperBound(clean90, DELTA / 2),
    wor: worUpperBound(clean90, perLook, CLEAN_N),
    exact: exactUpperBound(0, 90, CLEAN_N, perLook),
    cp: binomialUpperBound(0, 90, perLook),
  };
  // The deployment certificate a reviewer re-derived: 5 flips in 180 draws
  // from the 81,469-cell cached-FALSE stratum, at the pinned per-look level.
  const deploymentEvidence = {
    k: 5,
    n: 180,
    N: 81469,
    perLookDelta: perLook,
    eb: ebUpperBound([...new Array(175).fill(0), ...new Array(5).fill(1)], perLook),
    wor: worUpperBound([...new Array(175).fill(0), ...new Array(5).fill(1)], perLook, 81469),
    exact: exactUpperBound(5, 180, 81469, perLook),
    cp: binomialUpperBound(5, 180, perLook),
  };

  const byBound = Object.fromEntries(
    BOUNDS.map((b) => {
      const rs = results.filter((r) => r.bound === b);
      return [
        b,
        {
          configurationsCertifying: rs.filter((r) => (r.reused as number) > 0)
            .length,
          totalConfigurations: rs.length,
          meanSavings:
            rs.reduce((a, r) => a + (r.savings as number), 0) / rs.length,
          totalOracle: rs.reduce((a, r) => a + (r.oracle as number), 0),
        },
      ];
    }),
  );

  const out = {
    experiment: "exp14-bounds",
    note: "Maurer-Pontil vs WSR betting confidence sequence vs Bardenet-Maillard WoR, swapped inside the pinned procedure over identical stored labels; tests the proof sketch's un-measured claim that betting/WoR are not uniformly tighter here",
    delta: DELTA,
    schedule: { n0: N0, maxLooks: MAX_LOOKS },
    cleanSampleAtN90: atN90,
    deploymentEvidence,
    summaryByBound: byBound,
    results,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp14-bounds.json",
    JSON.stringify(out, null, 2),
  );
  console.log("\nclean n=90 upper bounds:", JSON.stringify(atN90));
  console.log("deployment evidence (5/180, N=81469):", JSON.stringify(deploymentEvidence));
  console.log("summary:", JSON.stringify(byBound, null, 2));
  console.log("EXP14_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
