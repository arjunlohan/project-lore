/**
 * Experiment 9 (review r1 mandatory): known-p calibration. Plant known
 * flip rates, run the FULL pinned adaptive procedure (both estimands) 2,000
 * times per configuration, and chart certification rate + realized
 * violation rate against the nominal guarantee. Zero API cost.
 *
 * Expected shape: violation probability <= delta_s everywhere (far below,
 * by conservatism); certification rate ~0 for p >= alpha, rising as p
 * drops below alpha with distance and stratum size.
 *
 * Run: pnpm tsx scripts/experiments/exp9-calibration.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { adaptiveCertifyStratum } from "@lore/core/sivm";

// r8/M6: alpha=0.2 was absent, yet every headline result and the entire
// deployment claim live there, and the tightest null was 1.5*alpha, where the
// futility rule kills the run at look 1 and certifying is trivially
// impossible. The grid now covers the deployed budget and probes just above
// each alpha, which is the only regime where the without-replacement gap in
// Assumption 3 could actually bite.
const ALPHAS = [0.05, 0.1, 0.2];
const P_GRID_ABS = [0, 0.005, 0.01, 0.02, 0.04, 0.05, 0.08, 0.15];
// Nulls placed just above each alpha, expressed as multiples of it.
const NULL_RATIOS = [1.05, 1.1, 1.25];
const SIZES = [600, 1800, 5000];
const TRIALS = 2000;
const PER_STRATUM_DELTA = 0.05; // delta=0.1 split over K=2 strata, typical

import { mulberry32 } from "@lore/core/sivm";
const rand = mulberry32(987654321);

async function main() {
  const results: Record<string, unknown>[] = [];
  for (const alpha of ALPHAS) {
    for (const size of SIZES) {
      const pGrid = [
        ...new Set([
          ...P_GRID_ABS,
          ...NULL_RATIOS.map((r) => Number((alpha * r).toFixed(4))),
        ]),
      ].sort((a, b) => a - b);
      for (const p of pGrid) {
        for (const estimand of ["presented", "reuse-set"] as const) {
          let certified = 0;
          let violPres = 0;
          let violReuse = 0;
          let sampledSum = 0;
          for (let t = 0; t < TRIALS; t++) {
            const flips = Array.from({ length: size }, () =>
              rand() < p ? 1 : 0,
            );
            const outcome = await adaptiveCertifyStratum(
              size,
              alpha,
              PER_STRATUM_DELTA,
              async (n) => flips.slice(0, n),
              45,
              6,
              estimand,
            );
            sampledSum += outcome.sampled;
            if (outcome.certified) {
              certified++;
              const rest = flips.slice(outcome.sampled);
              const restFlips = rest.reduce((a: number, b) => a + b, 0);
              if (restFlips / size > alpha) violPres++;
              if (rest.length > 0 && restFlips / rest.length > alpha)
                violReuse++;
            }
          }
          results.push({
            alpha,
            size,
            p,
            estimand,
            certificationRate: certified / TRIALS,
            violationRatePresented: certified > 0 ? violPres / certified : 0,
            violationRateReuseSet: certified > 0 ? violReuse / certified : 0,
            avgSampled: sampledSum / TRIALS,
          });
        }
      }
    }
  }

  // Console digest: worst-case violation per alpha x estimand.
  for (const alpha of ALPHAS) {
    for (const estimand of ["presented", "reuse-set"]) {
      const rows = results.filter(
        (r) => r.alpha === alpha && r.estimand === estimand,
      );
      const worstViol = Math.max(
        ...rows.map((r) =>
          Math.max(
            r.violationRatePresented as number,
            r.violationRateReuseSet as number,
          ),
        ),
      );
      const unsafeCert = rows
        .filter((r) => (r.p as number) > alpha)
        .reduce((a, r) => Math.max(a, r.certificationRate as number), 0);
      console.log(
        `alpha=${alpha} ${estimand}: worst realized violation rate=${(worstViol * 100).toFixed(2)}% (nominal delta_s=${PER_STRATUM_DELTA * 100}%), max cert-rate for p>alpha=${(unsafeCert * 100).toFixed(2)}%`,
      );
    }
  }
  // Power digest at alpha=0.05, presented.
  for (const size of SIZES) {
    const line = P_GRID_ABS.map((p) => {
      const r = results.find(
        (x) =>
          x.alpha === 0.05 &&
          x.size === size &&
          x.p === p &&
          x.estimand === "presented",
      )!;
      return `p=${p}:${((r.certificationRate as number) * 100).toFixed(0)}%`;
    }).join(" ");
    console.log(`alpha=0.05 size=${size} cert-rates: ${line}`);
  }

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp9-calibration.json",
    JSON.stringify(
      {
        experiment: "exp9-calibration",
        trials: TRIALS,
        perStratumDelta: PER_STRATUM_DELTA,
        results,
      },
      null,
      2,
    ),
  );
  console.log("EXP9_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
