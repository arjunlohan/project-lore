/**
 * Experiment 9b: the certifier's error probability at the least favourable
 * population, computed exactly.
 *
 * The calibration study (exp9) plants a flip RATE, so the realized flip
 * count of a planted stratum scatters around its mean and often falls on
 * the safe side of the budget. Theorem 1's event is hardest to avoid at a
 * FIXED population whose realized count sits one flip past the budget. For
 * such a population the pinned procedure's probability of issuing an
 * unsafe certificate is a finite sum: each look's cumulative flip count is
 * hypergeometric given the previous look's, and the certifier's decision at
 * each look is a threshold on that count. This script evaluates the sum
 * for every (budget, stratum size) cell of the calibration grid, in both
 * modes, with the decision thresholds taken from the released certifier's
 * own bound and schedule, and cross-checks one cell per budget by running
 * the released certifier on shuffled populations.
 *
 *   default mode  unsafe iff certified and M > alpha N; the probability is
 *                 non-increasing in M, so the worst case is
 *                 M = floor(alpha N) + 1;
 *   strict mode   unsafe iff certified at a look of n cells and
 *                 M > alpha (N - n); the worst case is found by scanning M.
 *
 * Zero API cost.
 *
 * Run: pnpm tsx scripts/experiments/exp9b-boundary.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  adaptiveCertifyStratum,
  exactUpperBound,
  lookSchedule,
  mulberry32,
} from "@lore/core/sivm";

const ALPHAS = [0.05, 0.1, 0.2];
const SIZES = [600, 1800, 5000];
const PER_STRATUM_DELTA = 0.05; // delta = 0.1 over K = 2 strata, as in exp9
const N0 = 45;
const MAX_LOOKS = 6;
const CHECK_TRIALS = 40000;

const logFact: number[] = [0];
const lf = (n: number): number => {
  for (let i = logFact.length; i <= n; i++) logFact.push(logFact[i - 1]! + Math.log(i));
  return logFact[n]!;
};
const logChoose = (a: number, b: number): number =>
  b < 0 || b > a ? -Infinity : lf(a) - lf(b) - lf(a - b);
/** P(x flips among `draw` cells taken from `pop` cells of which `marked` flip). */
const hypPmf = (pop: number, marked: number, draw: number, x: number): number =>
  Math.exp(logChoose(marked, x) + logChoose(pop - marked, draw - x) - logChoose(pop, draw));

type Mode = "presented" | "reuse-set";

/** Per look: the largest flip count that still certifies (-1 if none). */
function thresholds(N: number, alpha: number, mode: Mode) {
  const schedule = lookSchedule(N, alpha, PER_STRATUM_DELTA, N0, MAX_LOOKS);
  const perLook = PER_STRATUM_DELTA / schedule.length;
  return schedule.map((n) => {
    const target = mode === "reuse-set" ? (alpha * Math.max(0, N - n)) / N : alpha;
    let maxCertifying = -1;
    if (n < N) {
      for (let k = 0; k <= n; k++) {
        if (exactUpperBound(k, n, N, perLook) <= target) maxCertifying = k;
        else break;
      }
    }
    return { n, maxCertifying };
  });
}

/** Exact P(certified at each look | realized count M), futility rule included. */
function certifyByLook(N: number, M: number, alpha: number, mode: Mode): number[] {
  const th = thresholds(N, alpha, mode);
  let running = new Map<number, number>([[0, 1]]);
  let prev = 0;
  const out: number[] = [];
  for (const { n, maxCertifying } of th) {
    const next = new Map<number, number>();
    const draw = n - prev;
    for (const [k, pr] of running) {
      const pop = N - prev;
      const marked = M - k;
      for (let x = Math.max(0, draw - (pop - marked)); x <= Math.min(draw, marked); x++) {
        const q = hypPmf(pop, marked, draw, x);
        if (q > 0) next.set(k + x, (next.get(k + x) ?? 0) + pr * q);
      }
    }
    let certified = 0;
    running = new Map();
    for (const [k, pr] of next) {
      if (k <= maxCertifying) certified += pr;
      else if (k / n > alpha) continue; // futility stop
      else running.set(k, pr);
    }
    out.push(certified);
    prev = n;
  }
  return out;
}

function unsafeProbability(N: number, M: number, alpha: number, mode: Mode): number {
  const th = thresholds(N, alpha, mode);
  const byLook = certifyByLook(N, M, alpha, mode);
  let unsafe = 0;
  byLook.forEach((pr, i) => {
    const limit = mode === "reuse-set" ? alpha * (N - th[i]!.n) : alpha * N;
    if (M > limit + 1e-9) unsafe += pr;
  });
  return unsafe;
}

async function simulate(N: number, M: number, alpha: number, mode: Mode, seed: number) {
  const rand = mulberry32(seed);
  const base: number[] = Array.from({ length: N }, (_, i) => (i < M ? 1 : 0));
  let unsafe = 0;
  for (let t = 0; t < CHECK_TRIALS; t++) {
    const arr = base.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    const o = await adaptiveCertifyStratum(N, alpha, PER_STRATUM_DELTA, async (n) => arr.slice(0, n), N0, MAX_LOOKS, mode);
    if (!o.certified) continue;
    const limit = mode === "reuse-set" ? alpha * (N - o.sampled) : alpha * N;
    if (M > limit + 1e-9) unsafe++;
  }
  return unsafe / CHECK_TRIALS;
}

async function main() {
  const started = Date.now();
  const cells: Record<string, unknown>[] = [];
  for (const alpha of ALPHAS) {
    for (const N of SIZES) {
      const boundary = Math.floor(alpha * N + 1e-9) + 1;
      // Default mode: the unsafe probability is non-increasing in M.
      const presented = unsafeProbability(N, boundary, alpha, "presented");
      // Strict mode: scan every count that some look could certify unsafely.
      const th = thresholds(N, alpha, "reuse-set");
      const deepest = th[th.length - 1]!.n;
      let strict = 0;
      let strictAt = boundary;
      for (let M = Math.floor(alpha * (N - deepest) + 1e-9) + 1; M <= boundary; M++) {
        const u = unsafeProbability(N, M, alpha, "reuse-set");
        if (u > strict) {
          strict = u;
          strictAt = M;
        }
      }
      cells.push({
        alpha,
        size: N,
        looks: th.map((t) => t.n),
        perLookDelta: PER_STRATUM_DELTA / th.length,
        presented: { leastFavourableCount: boundary, unsafeProbability: presented },
        reuseSet: { worstCount: strictAt, unsafeProbability: strict },
      });
      console.log(
        `alpha=${alpha} N=${N}: default mode M=${boundary} unsafe ${(presented * 100).toFixed(2)}% | strict mode worst M=${strictAt} unsafe ${(strict * 100).toFixed(2)}%`,
      );
    }
  }
  // Cross-check against the released certifier on shuffled populations.
  const checks: Record<string, unknown>[] = [];
  for (const [i, alpha] of ALPHAS.entries()) {
    const N = 1800;
    const M = Math.floor(alpha * N + 1e-9) + 1;
    const exact = unsafeProbability(N, M, alpha, "presented");
    const simulated = await simulate(N, M, alpha, "presented", 20261001 + i);
    const se = Math.sqrt((exact * (1 - exact)) / CHECK_TRIALS);
    if (Math.abs(simulated - exact) > 4 * se) {
      throw new Error(`alpha=${alpha}: simulated ${simulated} is not within four standard errors of the exact ${exact}`);
    }
    checks.push({ alpha, size: N, count: M, exact, simulated, trials: CHECK_TRIALS });
    console.log(`check alpha=${alpha} N=${N}: exact ${(exact * 100).toFixed(2)}% vs released certifier ${(simulated * 100).toFixed(2)}% over ${CHECK_TRIALS} shuffles`);
  }
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp9b-boundary.json",
    JSON.stringify(
      {
        experiment: "exp9b-boundary",
        note: "exact probability of an unsafe certificate at the least favourable fixed population (one flip past the budget), pinned schedule, exact bound; thresholds from the released certifier's bound and schedule; cross-checked by running the released certifier on shuffled populations",
        perStratumDelta: PER_STRATUM_DELTA,
        n0: N0,
        maxLooks: MAX_LOOKS,
        cells,
        checks,
        wallMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  console.log("EXP9B_DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
