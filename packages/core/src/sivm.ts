/**
 * sIVM — statistically certified reuse-set selection for stochastic
 * LLM-computed views.
 *
 * Guarantee shape: strata are frozen before sampling; each tested stratum
 * gets an upper confidence bound on its flip rate at confidence
 * 1 - delta/K/looks (Bonferroni across the K tested strata and the looks
 * of the adaptive schedule). A stratum is certified iff its upper bound
 * <= alpha. Then, with probability >= 1 - delta over sampling and oracle
 * draws, EVERY certified stratum's whole-stratum flip count is <= alpha
 * times its size, hence the false-reuse fraction among all reused cells
 * (any size-weighted mixture of certified strata) is <= alpha.
 *
 * The default bound is the exact finite-population (hypergeometric) bound
 * (`exactUpperBound`): flips are binary and the sample is drawn without
 * replacement from a frozen stratum, which is exactly the setting that
 * bound is exact for. The first submission certified with the Maurer-Pontil
 * empirical-Bernstein bound, which is stated for independent draws and pays
 * a range term binary data never needs; it, the Bardenet-Maillard
 * without-replacement bound, the binomial Clopper-Pearson bound, and a
 * betting confidence sequence remain as ablation arms (`BoundKind`).
 *
 * Known limitations (tracked for the paper, do not silently claim more):
 * - Bonferroni across strata and looks, not e-BH or a confidence sequence:
 *   costs power, never validity.
 * - No monotonicity shortcuts: every stratum is sampled (the
 *   scope-narrowing "deterministic safety" claim was refuted by our own
 *   adversarial review; direction is only a stratification HINT).
 * - Flip = disagreement under the column's equivalence spec at the model's
 *   sampling randomness; certificates are scoped to the pinned model +
 *   decode params at certification time.
 */

// ---------------------------------------------------------------------------
// Deterministic randomness (exact 32-bit ops; naive LCGs written with JS
// number multiplication silently lose low bits past 2^53 and are NOT valid)
// ---------------------------------------------------------------------------

/** mulberry32: fast, well-distributed, exact under JS semantics. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a mulberry32 stream; deterministic per seed. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Prompt delta
// ---------------------------------------------------------------------------

export interface PromptDeltaV1 {
  added: string[];
  removed: string[];
  /** Content words (lowercased, deduped) from added+removed spans. */
  deltaTerms: string[];
}

const STOPWORDS = new Set(
  "a an the is are was were be been being do does did of in on at to from by for with without and or not no nor but if then else this that these those it its as such into over under out up down about between per each every any all some most more less than only merely just also very really consider considering judge judging based work works working person people row data one who whose".split(
    " ",
  ),
);

export function tokenizeContent(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replaceAll(/\{\{[^}]*\}\}/g, " ")
        .split(/[^a-z0-9+#.]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ];
}

/**
 * Word-level LCS diff over the two prompts; returns added/removed spans and
 * the content-term delta used for row-interaction scoring.
 */
export function diffPrompts(a: string, b: string): PromptDeltaV1 {
  const aw = a.split(/\s+/).filter(Boolean);
  const bw = b.split(/\s+/).filter(Boolean);
  const m = aw.length;
  const n = bw.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        aw[i] === bw[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aw[i] === bw[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      removed.push(aw[i]!);
      i++;
    } else {
      added.push(bw[j]!);
      j++;
    }
  }
  removed.push(...aw.slice(i));
  added.push(...bw.slice(j));
  const deltaTerms = [
    ...new Set([
      ...tokenizeContent(added.join(" ")),
      ...tokenizeContent(removed.join(" ")),
    ]),
  ];
  return { added, removed, deltaTerms };
}

/** How many delta terms appear in this row's bound content. */
export function overlapScore(boundText: string, delta: PromptDeltaV1): number {
  if (delta.deltaTerms.length === 0) return 0;
  const rowTerms = new Set(tokenizeContent(boundText));
  let hits = 0;
  for (const t of delta.deltaTerms) if (rowTerms.has(t)) hits++;
  return hits;
}

// ---------------------------------------------------------------------------
// Strata
// ---------------------------------------------------------------------------

export interface SivmCellInput {
  rowId: string;
  /** Cached value under V (v1), serialized comparably. */
  cachedValue: unknown;
  /** The bound row content (template variables joined). */
  boundText: string;
}

export interface SivmStratum {
  id: string;
  rowIds: string[];
  meta: { cachedValue: string; overlapBucket: string };
}

function overlapBucket(score: number): string {
  if (score === 0) return "0";
  if (score <= 2) return "1-2";
  return "3+";
}

/**
 * Freeze strata BEFORE sampling from any bucketing function: any stratifier
 * is validity-safe (a bad one only costs power, never the bound), so
 * stratifier quality is purely a savings lever.
 */
export function assignStrataWith(
  cells: SivmCellInput[],
  bucketOf: (cell: SivmCellInput) => string,
): SivmStratum[] {
  const map = new Map<string, SivmStratum>();
  for (const c of cells) {
    const v = JSON.stringify(c.cachedValue);
    const b = bucketOf(c);
    const id = `v=${v}|${b}`;
    let s = map.get(id);
    if (!s) {
      s = { id, rowIds: [], meta: { cachedValue: v, overlapBucket: b } };
      map.set(id, s);
    }
    s.rowIds.push(c.rowId);
  }
  return [...map.values()].sort((a, b2) => b2.rowIds.length - a.rowIds.length);
}

/** Default stratifier: cached-value x lexical delta-term overlap buckets. */
export function assignStrata(
  cells: SivmCellInput[],
  delta: PromptDeltaV1,
): SivmStratum[] {
  return assignStrataWith(
    cells,
    (c) => `o=${overlapBucket(overlapScore(c.boundText, delta))}`,
  );
}

// ---------------------------------------------------------------------------
// Bounds + selection
// ---------------------------------------------------------------------------

/**
 * Maurer-Pontil empirical-Bernstein upper confidence bound on the mean of
 * [0,1] variables at confidence 1 - delta.
 */
export function ebUpperBound(flips: number[], delta: number): number {
  const n = flips.length;
  if (n < 2) return 1;
  const mean = flips.reduce((a, b) => a + b, 0) / n;
  const variance =
    flips.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const logTerm = Math.log(2 / delta);
  const bound =
    mean +
    Math.sqrt((2 * variance * logTerm) / n) +
    (7 * logTerm) / (3 * (n - 1));
  return Math.min(1, bound);
}

/**
 * Waudby-Smith & Ramdas hedged-capital confidence sequence: a one-sided upper
 * bound on the mean of bounded observations, valid at every sample size
 * simultaneously (so no Bonferroni split across looks is needed).
 *
 * The paper's proof sketch ASSERTS that betting bounds are not uniformly
 * tighter than Maurer-Pontil at our sample sizes. That assertion was never
 * measured across the grid, which is what exp14 now does. Implemented here so
 * the comparison runs through the same certifier rather than a side script.
 *
 * Capital process for a candidate mean m: K_t(m) = prod (1 + lam_i (X_i - m)),
 * with a predictable lambda from the running variance. The confidence set is
 * the set of m never rejected; the upper bound is its supremum. Because the
 * process is a nonnegative martingale under H_0, the bound is anytime-valid.
 */
export function bettingUpperBound(
  flips: number[],
  delta: number,
  grid = 400,
): number {
  const n = flips.length;
  if (n < 1) return 1;
  const threshold = 1 / delta;
  const rejected = (m: number): boolean => {
    // Predictable plug-in: lambda_i depends only on X_1..X_{i-1}.
    let sum = 0;
    let sumSq = 0;
    let capital = 1;
    let maxCapital = 1;
    for (let i = 0; i < n; i++) {
      const t = i + 1;
      const muHat = (0.5 + sum) / (1 + i);
      const sigmaSq = (0.25 + sumSq - i * muHat * muHat) / (1 + i);
      let lam = Math.sqrt(
        (2 * Math.log(1 / delta)) / (Math.max(sigmaSq, 1e-6) * t * Math.log(1 + t)),
      );
      // Bet that the mean is BELOW m: the capital must grow when observations
      // come in under m, so the payoff is (m - X), not (X - m). Betting the
      // other way makes every large m survive and the bound collapses to 1,
      // which is what the first draft of this function did.
      // Truncate lambda so 1 + lam*(m - X) stays positive for any X in [0,1].
      lam = Math.min(lam, 0.5 / Math.max(1 - m, 1e-9));
      capital *= 1 + lam * (m - flips[i]!);
      if (capital <= 0) return true;
      if (capital > maxCapital) maxCapital = capital;
      sum += flips[i]!;
      sumSq += flips[i]! * flips[i]!;
    }
    return maxCapital >= threshold;
  };
  // The capital process is monotone in m over the region that matters (larger
  // candidate means are rejected sooner), so the confidence set is an initial
  // interval and its right endpoint can be bisected instead of scanned. This
  // is ~40x fewer evaluations at grid=400, which is what makes a calibration
  // with enough trials to bound the null certification rate affordable.
  if (!rejected(1)) return 1;
  let lo = 0;
  let hi = 1;
  const steps = Math.ceil(Math.log2(grid));
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (rejected(mid)) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.round(hi * grid) / grid);
}

/**
 * Bardenet & Maillard (2015) empirical-Bernstein-Serfling bound: the
 * without-replacement analogue of Maurer-Pontil, and the bound Assumption 3
 * says we do not prove we can skip.
 *
 * Stated as in their Theorem 4.3 (the empirical Bernstein-Serfling
 * inequality; the delta below is their delta/5, hence log(5/delta)): with
 * probability at least 1 - delta,
 *   mu - mean_n <= sigma_n sqrt(2 rho_n log(5/delta) / n)
 *                  + kappa (b - a) log(5/delta) / n,
 * with kappa = 7/3 + 3/sqrt(2) and the Serfling factor
 *   rho_n = 1 - (n-1)/N            for n <= N/2,
 *   rho_n = (1 - n/N)(1 + 1/n)     otherwise.
 * Their sigma_n is the biased (1/n) empirical standard deviation; the
 * (1/(n-1)) estimator used here is never smaller, so the bound below is
 * conservative relative to the theorem, never anti-conservative.
 *
 * Constants matter here and have been wrong twice. An early draft used
 * Maurer-Pontil's log(2/delta) and 1/(n-1); a later one used
 * Maurer-Pontil's kappa = 7/3 inside this formula (their Remark 4.4
 * explicitly relates the two constants; they are not equal). Both errors
 * make the bound tighter than the theorem licenses, and any power gain
 * measured against such a version is an artifact of an unsound constant.
 * The 2026-08-15 IEEE Access review round caught the second, and the bound
 * ablation (exp14) was re-run with the published constant.
 */
export function worUpperBound(
  flips: number[],
  delta: number,
  populationSize: number,
): number {
  const n = flips.length;
  const N = populationSize;
  if (n < 2) return 1;
  const mean = flips.reduce((a, b) => a + b, 0) / n;
  if (n >= N) return mean; // the whole population is observed
  const variance =
    flips.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const L = Math.log(5 / delta);
  const rho = n <= N / 2 ? 1 - (n - 1) / N : (1 - n / N) * (1 + 1 / n);
  const KAPPA = 7 / 3 + 3 / Math.SQRT2; // Bardenet-Maillard Theorem 4.3
  const bound =
    mean + Math.sqrt((2 * variance * rho * L) / n) + (KAPPA * L) / n;
  return Math.min(1, bound);
}

// Log-factorial table, grown on demand; hypergeometric and binomial tails
// below are sums of a few hundred terms of exact log-space probabilities,
// which is both faster and more accurate than a Lanczos lgamma here.
let logFact = new Float64Array([0]);
function logFactorial(m: number): number {
  if (m >= logFact.length) {
    const next = new Float64Array(Math.max(m + 1, logFact.length * 2));
    next.set(logFact);
    for (let i = logFact.length; i < next.length; i++) {
      next[i] = next[i - 1]! + Math.log(i);
    }
    logFact = next;
  }
  return logFact[m]!;
}
function logChoose(a: number, b: number): number {
  if (b < 0 || b > a) return -Infinity;
  return logFactorial(a) - logFactorial(b) - logFactorial(a - b);
}

/** P(X <= k) for X ~ Hypergeometric(population N, successes M, draws n). */
export function hypergeometricCdf(
  k: number,
  N: number,
  M: number,
  n: number,
): number {
  const denom = logChoose(N, n);
  let acc = 0;
  for (let x = Math.max(0, n - (N - M)); x <= Math.min(k, M, n); x++) {
    acc += Math.exp(logChoose(M, x) + logChoose(N - M, n - x) - denom);
  }
  return Math.min(1, acc);
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let acc = 0;
  for (let x = 0; x <= Math.min(k, n); x++) {
    acc += Math.exp(
      logChoose(n, x) + x * Math.log(p) + (n - x) * Math.log(1 - p),
    );
  }
  return Math.min(1, acc);
}

/**
 * Exact finite-population upper confidence bound on a stratum's flip rate:
 * k flips observed among n cells drawn uniformly without replacement from
 * the stratum's N cells.
 *
 * Model. Fix the N fresh-draw outcomes of the stratum (one hypothetical
 * fresh draw per cell, the same coupling the presented-cells estimand is
 * defined on); the sampling is independent of them, so conditional on that
 * population with M flips the sampled count is Hypergeometric(N, M, n), and
 * P(X <= k | M) is non-increasing in M. The (1 - delta) upper confidence
 * bound for M is the largest M whose lower tail at k still exceeds delta
 * (the Clopper-Pearson construction for a finite population); the rate
 * bound is that M over N. Because it holds conditionally on every
 * population realisation it holds unconditionally, over sampling and draw
 * randomness together, and it bounds the REALISED whole-stratum flip count,
 * not only its expectation. As N grows it tends to the binomial
 * Clopper-Pearson bound (`binomialUpperBound`).
 *
 * This is the bound the pinned procedure certifies with from the IEEE
 * Access resubmission on. Empirical-Bernstein bounds pay a range term of
 * order log(1/delta)/n that a binary loss never needs; on a clean sample of
 * 90 draws at the pinned per-look level they read 0.14 (Maurer-Pontil) and
 * 0.32 (Bardenet-Maillard) where this bound reads 0.05.
 */
export function exactUpperBound(
  k: number,
  n: number,
  N: number,
  delta: number,
): number {
  if (n <= 0 || N <= 0) return 1;
  if (n >= N) return k / N; // the whole population is observed
  const tail = (M: number) => hypergeometricCdf(k, N, M, n);
  let lo = k; // P(X <= k | M = k) = 1 > delta
  let hi = N - (n - k); // every unsampled cell a flip
  if (tail(hi) > delta) return hi / N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tail(mid) > delta) lo = mid;
    else hi = mid;
  }
  return lo / N;
}

/**
 * Clopper-Pearson one-sided upper confidence bound for a binomial
 * proportion (k of n), the infinite-population limit of `exactUpperBound`;
 * kept as a comparison arm for the bound ablation.
 */
export function binomialUpperBound(k: number, n: number, delta: number): number {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > delta) lo = mid;
    else hi = mid;
  }
  return hi;
}

export type BoundKind = "exact" | "cp" | "eb" | "betting" | "wor";

/** Upper confidence bound on a stratum's flip rate under the named bound. */
export function upperBoundFor(
  bound: BoundKind,
  flips: number[],
  delta: number,
  populationSize: number,
): number {
  const k = flips.reduce((a, b) => a + b, 0);
  switch (bound) {
    case "exact":
      return exactUpperBound(k, flips.length, populationSize, delta);
    case "cp":
      return binomialUpperBound(k, flips.length, delta);
    case "betting":
      return bettingUpperBound(flips, delta);
    case "wor":
      return worUpperBound(flips, delta, populationSize);
    case "eb":
      return ebUpperBound(flips, delta);
  }
}

export interface StratumResult {
  stratumId: string;
  size: number;
  sampled: number;
  flips: number;
  empiricalFlipRate: number;
  upperBound: number;
  certified: boolean;
  /** Per-look trace when the adaptive schedule produced it. */
  looks?: AdaptiveLook[];
}

export interface CertifyMathInput {
  strata: Array<{ id: string; size: number; flipSample: number[] }>;
  alpha: number;
  /** Total failure probability across all strata (Bonferroni split). */
  delta: number;
}

export function selectReuse(
  input: CertifyMathInput,
  bound: BoundKind = "exact",
): StratumResult[] {
  const K = input.strata.length;
  const perStratumDelta = input.delta / Math.max(1, K);
  return input.strata.map((s) => {
    const upper = upperBoundFor(bound, s.flipSample, perStratumDelta, s.size);
    const flips = s.flipSample.reduce((a, b) => a + b, 0);
    return {
      stratumId: s.id,
      size: s.size,
      sampled: s.flipSample.length,
      flips,
      empiricalFlipRate:
        s.flipSample.length > 0 ? flips / s.flipSample.length : 1,
      upperBound: upper,
      certified: upper <= input.alpha,
    };
  });
}

/**
 * Per-stratum sample size needed for EB to certify a ZERO-observed-flip
 * stratum at alpha with per-stratum confidence delta_s: with variance 0 the
 * bound reduces to 7 log(2/delta_s) / (3 (n-1)) <= alpha.
 */
export function minSampleForZeroFlips(
  alpha: number,
  perStratumDelta: number,
): number {
  return Math.ceil((7 * Math.log(2 / perStratumDelta)) / (3 * alpha)) + 1;
}

// ---------------------------------------------------------------------------
// Grid-adaptive certification (anytime over a doubling look schedule)
// ---------------------------------------------------------------------------

/**
 * Doubling look schedule n0, 2*n0, ... capped at the stratum size, sized so
 * the final look can certify a zero-flip stratum at alpha.
 */
export function lookSchedule(
  stratumSize: number,
  alpha: number,
  perStratumDelta: number,
  n0 = 45,
  maxLooks = 4,
): number[] {
  const perLookDelta = perStratumDelta / maxLooks;
  const need = minSampleForZeroFlips(alpha, perLookDelta);
  const looks: number[] = [];
  let n = n0;
  for (let j = 0; j < maxLooks; j++) {
    looks.push(Math.min(n, stratumSize));
    if (n >= Math.max(need, stratumSize)) break;
    n *= 2;
  }
  // Ensure the final look is large enough to certify when clean (or the
  // whole stratum, whichever is smaller).
  const last = looks[looks.length - 1]!;
  if (last < Math.min(need, stratumSize)) {
    looks[looks.length - 1] = Math.min(need, stratumSize);
  }
  return [...new Set(looks)];
}

export interface AdaptiveLook {
  look: number;
  n: number;
  flips: number;
  upperBound: number;
  certified: boolean;
}

/**
 * Adaptive per-stratum certification: peek at each scheduled look with the
 * per-stratum delta split evenly across looks (Bonferroni over looks, so
 * peeking is valid); stop as soon as certified. `flipsPrefix(n)` returns the
 * flip indicators for the first n sampled rows (one fixed shuffled order).
 *
 * Validity: P(certify a stratum whose true flip rate > alpha) <= perStratumDelta,
 * because each look's test has level perStratumDelta/looks and certification
 * requires at least one look to pass.
 */
export async function adaptiveCertifyStratum(
  stratumSize: number,
  alpha: number,
  perStratumDelta: number,
  flipsPrefix: (n: number) => Promise<number[]>,
  n0 = 45,
  maxLooks = 4,
  /**
   * Estimand mode. "presented" (default): certify when the whole-stratum
   * rate bound clears alpha; the guarantee then covers ALL cells shown from
   * the stratum (sampled ones are fresh, so the user-facing stale-error is
   * at most the stratum rate). "reuse-set": certify only when the bound
   * clears alpha * (size - n) / size, so the mean of the UNSAMPLED
   * remainder alone is certified at alpha (whole-stratum flips ≤ u * size
   * implies remainder flips ≤ u * size, i.e. remainder rate ≤
   * u * size / (size - n)). Stricter; kills deep-sampled certifications.
   */
  estimand: "presented" | "reuse-set" = "presented",
  /**
   * Which upper confidence bound to spend the budget on. The pinned
   * procedure's default is the exact finite-population bound; the other
   * arms exist so the bound ablation (exp14) measures the alternatives
   * inside the same procedure over the same labels: Maurer-Pontil ("eb",
   * the bound the first submission certified with), Bardenet-Maillard
   * ("wor"), Clopper-Pearson ("cp"), and the betting confidence SEQUENCE
   * ("betting"), which is anytime-valid and is therefore spent at the
   * per-stratum level rather than split across looks.
   */
  bound: BoundKind = "exact",
): Promise<{ certified: boolean; looks: AdaptiveLook[]; sampled: number }> {
  const schedule = lookSchedule(stratumSize, alpha, perStratumDelta, n0, maxLooks);
  const perLookDelta =
    bound === "betting" ? perStratumDelta : perStratumDelta / schedule.length;
  const looks: AdaptiveLook[] = [];
  for (let j = 0; j < schedule.length; j++) {
    const n = schedule[j]!;
    const flips = await flipsPrefix(n);
    const upper = upperBoundFor(bound, flips, perLookDelta, stratumSize);
    const threshold =
      estimand === "reuse-set"
        ? alpha * Math.max(0, stratumSize - n) / stratumSize
        : alpha;
    const certified = n < stratumSize && upper <= threshold;
    looks.push({
      look: j + 1,
      n,
      flips: flips.reduce((a, b) => a + b, 0),
      upperBound: upper,
      certified,
    });
    if (certified) {
      return { certified: true, looks, sampled: n };
    }
    // Futility stop: even a further clean doubling cannot get under alpha
    // when the empirical rate alone already exceeds it.
    const mean = flips.reduce((a, b) => a + b, 0) / Math.max(1, flips.length);
    if (mean > alpha) {
      return { certified: false, looks, sampled: n };
    }
  }
  return {
    certified: false,
    looks,
    sampled: schedule[schedule.length - 1]!,
  };
}

/**
 * Sample enough to certify a clean stratum (the zero-flip minimum), capped by
 * the stratum size. Strata smaller than the minimum get fully sampled — they
 * cannot yield reuse savings, which is the honest cost of small strata; the
 * savings come from strata much larger than the minimum, i.e. large tables.
 */
export function planSampleSizes(
  strata: Array<{ id: string; size: number }>,
  alpha: number,
  delta: number,
): Map<string, number> {
  const K = strata.length;
  const perStratumDelta = delta / Math.max(1, K);
  const base = minSampleForZeroFlips(alpha, perStratumDelta);
  const plan = new Map<string, number>();
  for (const s of strata) {
    plan.set(s.id, Math.min(s.size, Math.max(30, base)));
  }
  return plan;
}
