/**
 * Experiment 9c: what block-scale dependence among oracle draws would cost.
 *
 * Theorem 1 assumes the draws of sampled rows do not interfere. The
 * independence check (exp17) finds the flip RATE of completed requests
 * unmoved by concurrency but cannot exclude overdispersion of flip counts
 * among draws issued together: the variance of counts over blocks of 32
 * reads 1.26 times its binomial value in the larger concurrent arm (95%
 * interval up to 2.26), 1.61 there with blocks formed in launch order, 2.08
 * in the first concurrent arm (eight blocks; interval up to 8.62), and 1.42
 * pooled over both arms (interval up to 2.37). This script asks what each
 * of those ratios would do to the certifier's error probability, under a
 * simple model of dependence.
 *
 * Model. The sample is issued in blocks of 32 draws. Each block has its own
 * flip probability, drawn from a Beta distribution with mean p and
 * intraclass correlation rho, so that block counts are beta-binomial with
 * variance ratio phi = 1 + (32 - 1) rho against the binomial. phi = 1 is
 * independent draws. The stratum's rate p is set one flip past the budget
 * (the least favourable rate), so every certificate issued is an error, and
 * the pinned procedure (exact bound, doubling looks from 45, at most six
 * looks, futility rule) runs on the draws as they arrive.
 *
 * Scope. The stratum is the deployment stratum (81,469 cells), at the two
 * budgets certified there: the live certifications are where the assumption
 * matters (replications over frozen labels are hypergeometric however the
 * labels were drawn). The size also keeps the error event honest. The
 * simulation fixes the RATE and counts every certificate as an error; the
 * theorem is about the REALIZED count. In a stratum this large the two
 * coincide. In a small one the certifier's finite-population correction
 * tracks the realized count, which under a fixed rate falls at or below the
 * budget about half the time, so a rate-based error rate would overstate the
 * theorem's event even with independent draws.
 *
 * It is a model, not a measurement: it says how much error a given amount of
 * block dependence would buy, not how much dependence there is.
 *
 * Zero API cost.
 *
 * Run: pnpm tsx scripts/experiments/exp9c-overdispersion.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { adaptiveCertifyStratum, mulberry32 } from "@lore/core/sivm";

const BLOCK = 32;
const PER_STRATUM_DELTA = 0.05; // delta = 0.1 over K = 2 strata
const N0 = 45;
const MAX_LOOKS = 6;
const TRIALS = 100000;
// The deployment stratum (its size is read from the deployment artifact) at
// the two budgets certified there.
const BUDGETS = [0.2, 0.1];

/** Marsaglia-Tsang gamma sampler (shape >= 1; boosted below 1). */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller normal.
      const u1 = Math.max(rand(), 1e-12);
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a: number, b: number, rand: () => number): number => {
  const x = gamma(a, rand);
  return x / (x + gamma(b, rand));
};

async function errorProbability(alpha: number, size: number, phi: number, seed: number) {
  const rand = mulberry32(seed);
  const p = (Math.floor(alpha * size + 1e-9) + 1) / size;
  const rho = (phi - 1) / (BLOCK - 1);
  const a = rho > 0 ? (p * (1 - rho)) / rho : 0;
  const b = rho > 0 ? ((1 - p) * (1 - rho)) / rho : 0;
  let certified = 0;
  for (let t = 0; t < TRIALS; t++) {
    const draws: number[] = [];
    let blockP = p;
    const prefix = async (n: number) => {
      while (draws.length < n) {
        if (draws.length % BLOCK === 0) blockP = rho > 0 ? beta(a, b, rand) : p;
        draws.push(rand() < blockP ? 1 : 0);
      }
      return draws.slice(0, n);
    };
    const o = await adaptiveCertifyStratum(size, alpha, PER_STRATUM_DELTA, prefix, N0, MAX_LOOKS, "presented");
    if (o.certified) certified++;
  }
  return { rate: p, errorProbability: certified / TRIALS };
}

async function main() {
  const started = Date.now();
  // The ratios the independence check reports: its planned estimate in the
  // larger arm, the launch-order estimate there, and the upper end of the
  // planned test's 95% interval. Read from the artifact, not typed.
  const ext = JSON.parse(readFileSync("docs/research/experiments/exp17-independence-ext.json", "utf8"));
  const first = JSON.parse(readFileSync("docs/research/experiments/exp17-independence.json", "utf8"));
  const planned = Number(ext.concurrent.serial.blockVarianceRatio);
  const launch = Number(ext.concurrent.unplanned.launchOrderBlocks.blockVarianceRatio);
  const df = Number(ext.concurrent.serial.dispersionDf);
  // Lower chi-square quantile by bisection on the regularized gamma (series).
  const gammaP = (s: number, x: number): number => {
    let sum = 1 / s;
    let term = 1 / s;
    for (let k = 1; k < 2000; k++) {
      term *= x / (s + k);
      sum += term;
      if (term < sum * 1e-15) break;
    }
    const lg = (z: number): number => {
      const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      let y = z;
      let tmp = z + 5.5;
      tmp -= (z + 0.5) * Math.log(tmp);
      let ser = 1.000000000190015;
      for (const c of g) ser += c / ++y;
      return -tmp + Math.log((2.5066282746310005 * ser) / z);
    };
    return sum * Math.exp(-x + s * Math.log(x) - lg(s));
  };
  /** The 2.5% point of a chi-square with `d` degrees of freedom. */
  const chiLow = (d: number): number => {
    let lo = 0;
    let hi = d * 10;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (gammaP(d / 2, mid / 2) < 0.025) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const upper = (planned * df) / chiLow(df);
  const ratios = [
    { label: "independent", phi: 1 },
    { label: "planned estimate (larger arm)", phi: planned },
    { label: "launch-order estimate (larger arm)", phi: launch },
    { label: "upper end of the planned test's 95% interval", phi: upper },
  ];
  // Added after the first run of this script: the same planned statistic in
  // the first concurrent arm and pooled over both arms, each with the upper
  // end of its interval. Simulated with seeds of their own, after the four
  // ratios above, so those cells keep the values first reported.
  const firstRatio = Number(first.concurrent.serial.blockVarianceRatio);
  const firstDf = Number(first.concurrent.serial.dispersionDf);
  const pooledChi = Number(ext.pooledWithMainConcurrent.dispersionChiSquare);
  const pooledDf = Number(ext.pooledWithMainConcurrent.dispersionDf);
  const extraRatios = [
    { label: "pooled estimate (both concurrent arms)", phi: pooledChi / pooledDf },
    { label: "upper end of the pooled 95% interval", phi: pooledChi / chiLow(pooledDf) },
    { label: "planned estimate (first concurrent arm)", phi: firstRatio },
    { label: "upper end of the first arm's 95% interval", phi: (firstRatio * firstDf) / chiLow(firstDf) },
  ];
  const deploy = JSON.parse(readFileSync("docs/research/experiments/exp11c-deployment-bounds-v4.json", "utf8"));
  const stratum = (deploy.sweeps[0].strata as Array<{ stratumId: string; size: number }>).find((s) => s.stratumId.startsWith("v=false"))!;
  const CELLS = BUDGETS.map((alpha) => ({ alpha, size: stratum.size }));
  const results: Record<string, unknown>[] = [];
  let seed = 20261001;
  for (const cell of CELLS) {
    for (const r of ratios) {
      const out = await errorProbability(cell.alpha, cell.size, r.phi, seed++);
      results.push({ ...cell, ratio: r.phi, ratioLabel: r.label, ...out });
      console.log(`alpha=${cell.alpha} N=${cell.size} phi=${r.phi.toFixed(2)} (${r.label}): error probability ${(out.errorProbability * 100).toFixed(2)}% at rate ${out.rate.toFixed(5)}`);
    }
  }
  seed = 20261101;
  for (const cell of CELLS) {
    for (const r of extraRatios) {
      const out = await errorProbability(cell.alpha, cell.size, r.phi, seed++);
      results.push({ ...cell, ratio: r.phi, ratioLabel: r.label, ...out });
      console.log(`alpha=${cell.alpha} N=${cell.size} phi=${r.phi.toFixed(2)} (${r.label}): error probability ${(out.errorProbability * 100).toFixed(2)}% at rate ${out.rate.toFixed(5)}`);
    }
  }
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp9c-overdispersion.json",
    JSON.stringify(
      {
        experiment: "exp9c-overdispersion",
        note: "the pinned certifier's per-stratum error probability on the deployment stratum, at the least favourable rate, when draws arrive in blocks of 32 with beta-binomial dependence; phi is the block-count variance ratio against the binomial (1 = independent); a model of dependence, not a measurement of it",
        stratumSize: stratum.size,
        block: BLOCK,
        perStratumDelta: PER_STRATUM_DELTA,
        trials: TRIALS,
        ratios: [...ratios, ...extraRatios],
        results,
        wallMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  console.log("EXP9C_DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
