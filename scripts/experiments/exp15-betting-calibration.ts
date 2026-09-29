/**
 * Experiment 15: is the betting bound VALID here, before we believe it is
 * tighter?
 *
 * exp14 measures power. This measures validity, and it runs first in the
 * argument: a bound that certifies more is only interesting if it never
 * certifies something unsafe. The Waudby-Smith & Ramdas capital process is
 * anytime-valid in theory, but the implementation in packages/core is ours,
 * and the first draft of it bet in the wrong direction and returned 1.0 for
 * every input. A theorem does not protect you from your own arithmetic.
 *
 * Protocol mirrors exp9: plant a known flip rate, run the FULL pinned adaptive
 * procedure with the betting bound substituted, and count how often it
 * certifies a stratum whose true rate exceeds the budget. Nulls are placed
 * just above each budget (1.05x, 1.25x), which is where a broken bound would
 * show first, plus a 2x null as a coarse check.
 *
 * Zero API cost.
 *
 * Run: pnpm tsx scripts/experiments/exp15-betting-calibration.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { adaptiveCertifyStratum, mulberry32 } from "@lore/core/sivm";

const ALPHAS = [0.05, 0.1, 0.2];
const RATIOS = [0, 0.4, 0.8, 1.05, 1.25, 2.0];
const SIZES = [600, 1800];
const TRIALS = Number(process.env.EXP_TRIALS ?? 1000);
const PER_STRATUM_DELTA = 0.05; // delta=0.1 over K=2 strata, as pinned
// "exact" added for the IEEE Access resubmission: the finite-population
// bound is now the pinned certifier, so its null certification rate at
// tight nulls is measured beside the two it replaces or is compared with.
const BOUNDS = ["eb", "betting", "exact"] as const;

const rand = mulberry32(20260805);

/**
 * Wilson interval for a binomial proportion. The first version of this script
 * asked whether the null certification rate was ZERO, which is the wrong bar:
 * a bound valid at level delta is ALLOWED to certify a true null up to delta
 * of the time, and Maurer-Pontil scores zero only because Bonferroni plus its
 * own slack leave most of the budget unspent. The question is whether the
 * rate is above delta, which needs an interval, not a point estimate.
 */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)];
}


async function main() {
  const started = Date.now();
  const results: Record<string, unknown>[] = [];

  for (const bound of BOUNDS) {
    for (const alpha of ALPHAS) {
      for (const size of SIZES) {
        for (const ratio of RATIOS) {
          const p = Number((alpha * ratio).toFixed(4));
          let certified = 0;
          let violations = 0;
          let sampledSum = 0;
          for (let t = 0; t < TRIALS; t++) {
            const flips = Array.from({ length: size }, () =>
              rand() < p ? 1 : 0,
            );
            const o = await adaptiveCertifyStratum(
              size,
              alpha,
              PER_STRATUM_DELTA,
              async (n) => flips.slice(0, n),
              45,
              6,
              "presented",
              bound,
            );
            sampledSum += o.sampled;
            if (o.certified) {
              certified++;
              const rest = flips.slice(o.sampled);
              const restFlips = rest.reduce((a: number, b) => a + b, 0);
              // Presented-cells error: stale-and-wrong over ALL cells shown.
              if (restFlips / size > alpha) violations++;
            }
          }
          const [ciLo, ciHi] = wilson(certified, TRIALS);
          results.push({
            bound,
            alpha,
            size,
            p,
            isNull: p > alpha,
            certificationRate: certified / TRIALS,
            certificationCi: [ciLo, ciHi],
            // Evidence AGAINST validity: the whole interval sits above delta.
            exceedsDelta: p > alpha && ciLo > PER_STRATUM_DELTA,
            violationRate: certified > 0 ? violations / certified : 0,
            avgSampled: sampledSum / TRIALS,
          });
        }
      }
      const rows = results.slice(-RATIOS.length * SIZES.length);
      console.log(
        `${bound} alpha=${alpha}: ` +
          rows
            .filter((r) => r.size === 1800)
            .map(
              (r) =>
                `p=${r.p}${r.isNull ? "*" : ""}:${((r.certificationRate as number) * 100).toFixed(0)}%`,
            )
            .join(" "),
      );
    }
  }

  const summary = Object.fromEntries(
    BOUNDS.map((b) => {
      const rs = results.filter((r) => r.bound === b);
      const nulls = rs.filter((r) => r.isNull);
      return [
        b,
        {
          worstNullCertificationRate: nulls.reduce(
            (a, r) => Math.max(a, r.certificationRate as number),
            0,
          ),
          // Configurations where the 95% interval is entirely above delta.
          nullsExceedingDelta: nulls.filter((r) => r.exceedsDelta).length,
          nullConfigurations: nulls.length,
          worstViolationRate: rs.reduce(
            (a, r) => Math.max(a, r.violationRate as number),
            0,
          ),
          // Power at the cleanest point, where the two bounds separate most.
          certRateAtCleanBig:
            (rs.find((r) => r.p === 0 && r.size === 1800 && r.alpha === 0.05)
              ?.certificationRate as number) ?? null,
          avgSampledAtCleanBig:
            (rs.find((r) => r.p === 0 && r.size === 1800 && r.alpha === 0.05)
              ?.avgSampled as number) ?? null,
        },
      ];
    }),
  );

  const out = {
    experiment: "exp15-betting-calibration",
    note: "validity of the WSR betting bound as implemented, against the same pinned procedure; nulls planted just above each budget. Compared head to head with Maurer-Pontil on identical planted data.",
    trials: TRIALS,
    perStratumDelta: PER_STRATUM_DELTA,
    summary,
    results,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp15-betting-calibration.json",
    JSON.stringify(out, null, 2),
  );
  console.log("\nsummary:", JSON.stringify(summary, null, 2));
  // Valid means: no null configuration whose certification rate is
  // demonstrably above delta. Certifying a near-null occasionally is what a
  // level-delta procedure is entitled to do.
  const safe = BOUNDS.every(
    (b) => (summary[b] as { nullsExceedingDelta: number }).nullsExceedingDelta === 0,
  );
  console.log(
    safe
      ? `EXP15_CALIBRATION_OK (no null certification rate demonstrably above delta=${PER_STRATUM_DELTA})`
      : "EXP15_UNSAFE_CERTIFICATION",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
