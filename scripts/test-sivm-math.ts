/**
 * Synthetic validity + power check for the sIVM v1 math (no LLM calls).
 * - Validity: across trials, P(any certified stratum has true flip rate
 *   > alpha) must be <= delta (should be far below, EB+Bonferroni are
 *   conservative).
 * - Power: strata with true rate 0 and size >> minSample should certify.
 *
 * Run: pnpm tsx scripts/test-sivm-math.ts
 */
import {
  adaptiveCertifyStratum,
  minSampleForZeroFlips,
  planSampleSizes,
  selectReuse,
} from "@lore/core/sivm";

import { mulberry32 } from "@lore/core/sivm";

// Deterministic PRNG (exact 32-bit ops) so the test is reproducible.
const rand = mulberry32(123456789);

interface TrueStratum {
  id: string;
  size: number;
  trueRate: number;
}

const SCENARIO: TrueStratum[] = [
  { id: "safe-large", size: 20000, trueRate: 0 },
  { id: "safe-noise", size: 8000, trueRate: 0.005 },
  { id: "borderline", size: 5000, trueRate: 0.05 },
  { id: "risky", size: 3000, trueRate: 0.35 },
  { id: "tiny", size: 60, trueRate: 0 },
];

const ALPHA = 0.05;
const DELTA = 0.1;
const TRIALS = 2000;

async function main() {
  const plan = planSampleSizes(SCENARIO, ALPHA, DELTA);
  console.log(
    "min zero-flip sample:",
    minSampleForZeroFlips(ALPHA, DELTA / SCENARIO.length),
  );
  console.log("plan:", [...plan.entries()]);

  let violationTrials = 0;
  const certifyCount = new Map<string, number>();

  for (let t = 0; t < TRIALS; t++) {
    const strata = SCENARIO.map((s) => ({
      id: s.id,
      size: s.size,
      flipSample: Array.from({ length: plan.get(s.id)! }, () =>
        rand() < s.trueRate ? 1 : 0,
      ),
    }));
    const results = selectReuse({ strata, alpha: ALPHA, delta: DELTA });
    let violated = false;
    for (const r of results) {
      if (r.certified) {
        certifyCount.set(r.stratumId, (certifyCount.get(r.stratumId) ?? 0) + 1);
        const truth = SCENARIO.find((s) => s.id === r.stratumId)!;
        if (truth.trueRate > ALPHA) violated = true;
      }
    }
    if (violated) violationTrials++;
  }

  console.log("\nper-stratum certification rate over", TRIALS, "trials:");
  for (const s of SCENARIO) {
    console.log(
      `  ${s.id.padEnd(12)} true=${s.trueRate} size=${s.size} certified ${(
        ((certifyCount.get(s.id) ?? 0) / TRIALS) * 100
      ).toFixed(1)}%`,
    );
  }
  const violationRate = violationTrials / TRIALS;
  console.log(
    `\nvalidity: trials with an unsafe certification = ${(violationRate * 100).toFixed(2)}% (must be <= ${DELTA * 100}%)`,
  );

  // Adaptive procedure: validity under peeking + power at alpha=0.05 where
  // the fixed-sample plan refused, plus expected-sample savings on clean
  // strata (early stop at the first certifying look).
  const ADAPT_ALPHA = 0.05;
  const perStratum = DELTA / 2;
  let adaptViolations = 0;
  let adaptCleanCertified = 0;
  let adaptCleanSampled = 0;
  let adaptRiskyCertified = 0;
  const ADAPT_TRIALS = 800;
  const runAdaptive = async (trueRate: number, size: number) => {
    const draws: number[] = [];
    return adaptiveCertifyStratum(size, ADAPT_ALPHA, perStratum, async (n) => {
      while (draws.length < n) draws.push(rand() < trueRate ? 1 : 0);
      return draws.slice(0, n);
    });
  };
  for (let t = 0; t < ADAPT_TRIALS; t++) {
    const clean = await runAdaptive(0.004, 5000);
    if (clean.certified) {
      adaptCleanCertified++;
      adaptCleanSampled += clean.sampled;
    }
    const risky = await runAdaptive(0.12, 5000);
    if (risky.certified) {
      adaptRiskyCertified++;
      adaptViolations++;
    }
  }
  console.log(
    `adaptive @ alpha=0.05: clean(0.4%) certified ${((adaptCleanCertified / ADAPT_TRIALS) * 100).toFixed(1)}% (avg sampled ${(adaptCleanSampled / Math.max(1, adaptCleanCertified)).toFixed(0)}), risky(12%) certified ${((adaptRiskyCertified / ADAPT_TRIALS) * 100).toFixed(2)}% (must be ~0)`,
  );
  const adaptOk =
    adaptRiskyCertified / ADAPT_TRIALS <= DELTA / 2 &&
    adaptCleanCertified / ADAPT_TRIALS > 0.5;
  // Assert what the math promises: clean large strata certify reliably;
  // low-noise power is reported (needs adaptive top-up, a tracked upgrade),
  // and at/above-alpha strata must essentially never certify.
  const powerOk =
    (certifyCount.get("safe-large") ?? 0) / TRIALS > 0.95 &&
    (certifyCount.get("borderline") ?? 0) / TRIALS < 0.01 &&
    (certifyCount.get("risky") ?? 0) === 0;
  const validityOk = violationRate <= DELTA;
  console.log(
    validityOk && powerOk && adaptOk ? "SIVM_MATH_OK" : "SIVM_MATH_FAIL",
  );
  process.exit(validityOk && powerOk && adaptOk ? 0 : 1);
}

void main();
