/**
 * Experiment 17 (IEEE Access resubmission, reviewer 3): is Assumption 1's
 * independence across rows tenable under concurrent requests?
 *
 * The paper cites measurements showing that provider-side batching can
 * correlate concurrent responses. The runner issues independent requests,
 * but never tested whether the responses behave independently. Two arms on
 * the same seeded rows, same prompt (the lab column's v2 template, the
 * new-version oracle of the headline edit), same model, temperature 0:
 *   sequential  one request in flight at a time;
 *   concurrent  32 requests in flight (the deployment run's concurrency).
 * Draws are compared against the stored August v1 cache (the flip the
 * certifier measures) and against each other.
 *
 * Tests, all reported with their reference distribution:
 *   1. flip rate, sequential vs concurrent (two-proportion z-test; the same
 *      rows, so drift and row mix are held fixed);
 *   2. between-arm disagreement on the same row, against the within-snapshot
 *      self-flip floor of the cached-FALSE and cached-TRUE strata (exp10);
 *   3. serial dependence inside each arm: lag-1 autocorrelation of the flip
 *      indicator in completion order, with a permutation p-value (2,000
 *      shuffles), and a dispersion test of flip counts over consecutive
 *      blocks of 32 completions (variance ratio against the binomial, chi-
 *      square on the block counts). Correlation induced by co-batching would
 *      appear in the concurrent arm and not in the sequential one.
 * Draws are stored in the artifact only (no database writes; the model is
 * called with the runner's own framing). Cost: 2 x EXP_ROWS calls.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp17-independence.ts
 *
 * Extension (EXP_EXTEND_CONCURRENT=<rows>): a concurrent arm alone on the
 * next <rows> rows of the same seeded order, disjoint from the main run's
 * rows, so the block-dispersion test has enough blocks to resolve modest
 * overdispersion; written to exp17-independence-ext.json and compared
 * against the main run's sequential arm.
 *
 * Re-analysis (EXP_REANALYZE=1): no model calls. Recomputes the serial
 * statistics of both artifacts from the draws and completion times they
 * store, and writes them back. It exists because the first permutation test
 * compared floating-point autocorrelations: a 0/1 sequence takes few
 * distinct values of the statistic, a tenth to a quarter of the shuffles
 * tied the observed one exactly, and rounding noise split those ties. The
 * comparison is now made on an integer statistic. The re-analysis also adds
 * what the planned tests left out: the block test pooled over both
 * concurrent arms, the exclusion check in both directions, and two UNPLANNED
 * looks, marked as such in the artifact (flips by response latency, and the
 * block test with blocks formed in launch order instead of completion
 * order). It also gives every block-dispersion statistic a permutation
 * p-value beside its chi-square one: a block of 32 holds about three
 * expected flips, where the chi-square reference is only approximate, and
 * shuffling the arm's own flip sequence gives the statistic's reference
 * distribution without that approximation. And it records the flip counts
 * with a failed request counted as a flip, the rule the released certifier
 * applies to a sampled cell whose oracle call fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import type { ColumnOutputType } from "@lore/core";
import { mulberry32, seededShuffle } from "@lore/core/sivm";
import { getCellsForVersion, getColumnVersion, listColumns } from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate, systemFor, valueSchema } from "../../lib/lore/run-column";

const N = Number(process.env.EXP_ROWS ?? 600);
const CONC = Number(process.env.EXP_CONCURRENCY ?? 32);
// Per-call ceiling: a queued provider can hold a single request for minutes,
// which stalls the sequential arm; a call that exceeds it is recorded as an
// error (null) and excluded, exactly like a schema failure.
const CALL_TIMEOUT_MS = Number(process.env.EXP_CALL_TIMEOUT_MS ?? 90000);
const SEED = 42;
const EXTEND = Number(process.env.EXP_EXTEND_CONCURRENT ?? 0);
const MAIN_OUT = "docs/research/experiments/exp17-independence.json";
const OUT = EXTEND > 0 ? "docs/research/experiments/exp17-independence-ext.json" : MAIN_OUT;
const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;
type Call = { id: string; value: boolean | null; startedAt: number; endedAt: number; latencyMs: number };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
function normalTwoSided(z: number): number {
  // Complementary error function via Abramowitz-Stegun 7.1.26.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-(z * z) / 2);
  return Math.min(1, erfc);
}
function lag1(x: number[]): number {
  const n = x.length;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    den += (x[i]! - m) ** 2;
    if (i > 0) num += (x[i]! - m) * (x[i - 1]! - m);
  }
  return den > 0 ? num / den : 0;
}
/**
 * n^2 times the numerator of the lag-one autocorrelation of a 0/1 sequence,
 * which is an integer. The denominator depends only on the number of ones,
 * so it is the same for every permutation, and comparing this integer is
 * comparing the autocorrelation with exact ties.
 */
function lag1Integer(x: number[]): number {
  const n = x.length;
  let ones = 0;
  let adjacent = 0;
  for (let i = 0; i < n; i++) {
    ones += x[i]!;
    if (i > 0 && x[i] === 1 && x[i - 1] === 1) adjacent++;
  }
  const ends = x[0]! + x[n - 1]!;
  return n * n * adjacent - n * ones * (2 * ones - ends) + (n - 1) * ones * ones;
}
/** Block dispersion: counts per consecutive block against Binomial(block, p). */
function blockDispersion(flips: number[], block = 32) {
  const p = flips.reduce((a, b) => a + b, 0) / flips.length;
  const blocks: number[] = [];
  for (let i = 0; i + block <= flips.length; i += block) {
    blocks.push(flips.slice(i, i + block).reduce((a, b) => a + b, 0));
  }
  const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const variance = blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, blocks.length - 1);
  const expectedVar = block * p * (1 - p);
  // Dispersion statistic: sum (x - np)^2 / (np(1-p)) ~ chi-square(blocks - 1) under independence.
  const chi = expectedVar > 0 ? blocks.reduce((a, b) => a + (b - block * p) ** 2, 0) / expectedVar : 0;
  return {
    blocks: blocks.length,
    blockSize: block,
    blockVarianceRatio: expectedVar > 0 ? variance / expectedVar : null,
    dispersionChiSquare: chi,
    dispersionDf: Math.max(1, blocks.length - 1),
  };
}
/**
 * Permutation p-value of the block-dispersion statistic: the share of
 * shuffles of the arm's own flip sequence whose statistic is at least the
 * observed one. With several sequences (the pooled test) each is shuffled on
 * its own and the statistics are added, as the pooled chi-square adds them.
 */
function dispersionPermutationP(sequences: number[][], rand: () => number, perms = 20000, block = 32): number {
  const stat = (xs: number[][]) => xs.reduce((a, x) => a + blockDispersion(x, block).dispersionChiSquare, 0);
  const observed = stat(sequences);
  const arrs = sequences.map((x) => [...x]);
  let atLeast = 0;
  for (let p = 0; p < perms; p++) {
    for (const arr of arrs) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
    }
    if (stat(arrs) >= observed - 1e-9) atLeast++;
  }
  return (atLeast + 1) / (perms + 1);
}
function serialTests(flips: number[], rand: () => number, perms = 2000, block = 32) {
  const observed = Math.abs(lag1Integer(flips));
  let atLeast = 0;
  const arr = [...flips];
  for (let p = 0; p < perms; p++) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    if (Math.abs(lag1Integer(arr)) >= observed) atLeast++;
  }
  return {
    lag1: lag1(flips),
    lag1PermutationP: (atLeast + 1) / (perms + 1),
    ...blockDispersion(flips, block),
  };
}

/**
 * EXP_REANALYZE=1: recompute the serial statistics from the stored draws.
 * The flip sequences are rebuilt exactly as the live run built them (usable
 * calls in completion order), and every statistic the artifacts already
 * hold except the permutation p-values must come out unchanged.
 */
function reanalyze() {
  type Timed = { id: string; startedAt?: number; endedAt: number; latencyMs: number };
  type Draw = { id: string; cached: boolean | null; sequential?: boolean | null; concurrent: boolean | null };
  const EXT_OUT = "docs/research/experiments/exp17-independence-ext.json";
  const main = JSON.parse(readFileSync(MAIN_OUT, "utf8"));
  const ext = JSON.parse(readFileSync(EXT_OUT, "utf8"));
  const sequence = (draws: Draw[], order: Timed[], arm: "sequential" | "concurrent", by: "endedAt" | "startedAt") => {
    const byId = new Map(draws.map((d) => [d.id, d]));
    return [...order]
      .sort((a, b) => (a[by] ?? 0) - (b[by] ?? 0))
      .map((c) => ({ c, d: byId.get(c.id)! }))
      .filter(({ d }) => d[arm] !== null && d[arm] !== undefined && d.cached !== null)
      .map(({ c, d }) => ({ flip: d[arm] !== d.cached ? 1 : 0, latencyMs: c.latencyMs }));
  };
  const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 1e-9;
  const refresh = (stored: Record<string, number | null>, flips: number[], rand: () => number, label: string) => {
    const fresh = serialTests(flips, rand);
    for (const k of ["lag1", "blockVarianceRatio", "dispersionChiSquare"] as const) {
      if (!same(stored[k] ?? null, fresh[k])) throw new Error(`${label}: recomputed ${k} ${fresh[k]} differs from the stored ${stored[k]}`);
    }
    if (stored.blocks !== fresh.blocks) throw new Error(`${label}: block count changed`);
    return fresh;
  };
  const latencySplit = (seq: Array<{ flip: number; latencyMs: number }>) => {
    const sorted = [...seq].sort((a, b) => a.latencyMs - b.latencyMs);
    const half = Math.floor(sorted.length / 2);
    const count = (xs: typeof sorted) => ({ n: xs.length, flips: xs.reduce((a, x) => a + x.flip, 0) });
    return { fasterHalf: count(sorted.slice(0, half)), slowerHalf: count(sorted.slice(half)) };
  };
  // The live runs seeded one generator per artifact and consumed it in this order.
  const randMain = mulberry32(20260929);
  const seq = sequence(main.draws, main.completionOrder.sequential, "sequential", "endedAt");
  const conc = sequence(main.draws, main.completionOrder.concurrent, "concurrent", "endedAt");
  main.sequential.serial = refresh(main.sequential.serial, seq.map((x) => x.flip), randMain, "sequential");
  main.concurrent.serial = refresh(main.concurrent.serial, conc.map((x) => x.flip), randMain, "concurrent");
  const concLaunch = sequence(main.draws, main.completionOrder.concurrent, "concurrent", "startedAt");
  main.concurrent.unplanned = {
    note: "not in the analysis plan; added after the planned tests were read",
    launchOrderBlocks: blockDispersion(concLaunch.map((x) => x.flip)),
    latencySplit: latencySplit(conc),
  };
  // The exclusion check, in both directions.
  const draws = main.draws as Draw[];
  const flipped = (d: Draw, arm: "sequential" | "concurrent") => d[arm] !== null && d[arm] !== undefined && d.cached !== null && d[arm] !== d.cached;
  const concDropped = draws.filter((d) => d.concurrent === null && d.sequential !== null && d.sequential !== undefined);
  const seqDropped = draws.filter((d) => (d.sequential === null || d.sequential === undefined) && d.concurrent !== null);
  main.exclusions = {
    concurrentDroppedRows: concDropped.length,
    ofWhichFlippedSequentially: concDropped.filter((d) => flipped(d, "sequential")).length,
    sequentialDroppedRows: seqDropped.length,
    ofWhichFlippedConcurrently: seqDropped.filter((d) => flipped(d, "concurrent")).length,
  };
  const randExt = mulberry32(20260929);
  const extSeq = sequence(ext.draws, ext.completionOrder, "concurrent", "endedAt");
  ext.concurrent.serial = refresh(ext.concurrent.serial, extSeq.map((x) => x.flip), randExt, "concurrent-ext");
  const extLaunch = sequence(ext.draws, ext.completionOrder, "concurrent", "startedAt");
  ext.concurrent.unplanned = {
    note: "not in the analysis plan; added after the planned tests were read",
    launchOrderBlocks: blockDispersion(extLaunch.map((x) => x.flip)),
    latencySplit: latencySplit(extSeq),
  };
  // The planned block test over both concurrent arms: independent arms, so
  // the chi-square statistics and their degrees of freedom add.
  ext.pooledWithMainConcurrent = {
    dispersionChiSquare: main.concurrent.serial.dispersionChiSquare + ext.concurrent.serial.dispersionChiSquare,
    dispersionDf: main.concurrent.serial.dispersionDf + ext.concurrent.serial.dispersionDf,
    blocks: main.concurrent.serial.blocks + ext.concurrent.serial.blocks,
  };
  // Permutation reference for every block-dispersion statistic, from a
  // generator of its own so the lag-one p-values above keep their values.
  const randDisp = mulberry32(20261002);
  main.sequential.serial.dispersionPermutationP = dispersionPermutationP([seq.map((x) => x.flip)], randDisp);
  main.concurrent.serial.dispersionPermutationP = dispersionPermutationP([conc.map((x) => x.flip)], randDisp);
  main.concurrent.unplanned.launchOrderBlocks.dispersionPermutationP = dispersionPermutationP([concLaunch.map((x) => x.flip)], randDisp);
  ext.concurrent.serial.dispersionPermutationP = dispersionPermutationP([extSeq.map((x) => x.flip)], randDisp);
  ext.concurrent.unplanned.launchOrderBlocks.dispersionPermutationP = dispersionPermutationP([extLaunch.map((x) => x.flip)], randDisp);
  ext.pooledWithMainConcurrent.dispersionPermutationP = dispersionPermutationP([conc.map((x) => x.flip), extSeq.map((x) => x.flip)], randDisp);
  // The released certifier counts a sampled cell whose oracle call failed as
  // a flip. The planned comparison above drops such requests; this is the
  // same comparison under the certifier's rule, over every requested row.
  {
    const failedOrFlipped = (d: Draw, arm: "sequential" | "concurrent") => d[arm] === null || d[arm] === undefined || (d.cached !== null && d[arm] !== d.cached);
    const usableRows = draws.filter((d) => d.cached !== null);
    const sF = usableRows.filter((d) => failedOrFlipped(d, "sequential")).length;
    const cF = usableRows.filter((d) => failedOrFlipped(d, "concurrent")).length;
    const n = usableRows.length;
    const pooledRate = (sF + cF) / (2 * n);
    const z = (cF / n - sF / n) / Math.sqrt(pooledRate * (1 - pooledRate) * (2 / n));
    main.failureAsFlip = {
      note: "a request that errored or exceeded the time ceiling is counted as a flip, the released certifier's rule; not in the analysis plan",
      rows: n,
      sequential: sF,
      concurrent: cF,
      z,
      twoSidedP: normalTwoSided(z),
      onlySequential: usableRows.filter((d) => failedOrFlipped(d, "sequential") && !failedOrFlipped(d, "concurrent")).length,
      onlyConcurrent: usableRows.filter((d) => failedOrFlipped(d, "concurrent") && !failedOrFlipped(d, "sequential")).length,
    };
  }
  const stamp = { at: new Date().toISOString(), note: "serial statistics recomputed from the stored draws with exact ties in the permutation test (EXP_REANALYZE=1); no model calls" };
  main.reanalysis = stamp;
  ext.reanalysis = stamp;
  writeFileSync(MAIN_OUT, JSON.stringify(main, null, 2));
  writeFileSync(EXT_OUT, JSON.stringify(ext, null, 2));
  console.log(JSON.stringify({ sequential: main.sequential.serial, concurrent: main.concurrent.serial, concurrentUnplanned: main.concurrent.unplanned, exclusions: main.exclusions, ext: ext.concurrent.serial, extUnplanned: ext.concurrent.unplanned, pooled: ext.pooledWithMainConcurrent }, null, 1));
  console.log("EXP17_REANALYZED");
}

async function main() {
  if (process.env.EXP_REANALYZE === "1") {
    reanalyze();
    process.exit(0);
  }
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY missing");
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) => c.name.includes("(lab)"))!;
  const v2 = await getColumnVersion(lab.id, 2);
  if (!v2) throw new Error("v2 missing");
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  // The evaluation vector's exact query, then a seeded subset of it.
  const [raw] = await db.query(`SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`, [SEED, 2000]);
  await db.end();
  const all = (raw as Row[]).map((r) => {
    const out: Row = { ...r };
    for (const k of Object.keys(out)) {
      const x = out[k];
      if (typeof x === "string" && x.startsWith("[")) {
        try {
          out[k] = JSON.parse(x);
        } catch {
          /* keep */
        }
      }
    }
    return out;
  });
  const order = seededShuffle(all, SEED + 17);
  const rows = EXTEND > 0 ? order.slice(N, N + EXTEND) : order.slice(0, N);
  const ids = rows.map((r) => String(r[PROFILE_ID_FIELD]));
  const cache = new Map(
    (await getCellsForVersion(lab.id, 1, ids))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, c.value as boolean]),
  );
  const spec = lab.output_spec as ColumnOutputType;
  const schema = z.object({ value: valueSchema(spec), rationale: z.string() });
  const system = systemFor(spec);
  const prompts = rows.map((r) => bindTemplate(v2.prompt_template, r).text);

  const arm = async (limit: number, label: string): Promise<Call[]> => {
    const calls: Call[] = [];
    let done = 0;
    await mapLimit(
      rows.map((_, i) => i),
      limit,
      async (i) => {
        const t0 = Date.now();
        let value: boolean | null = null;
        try {
          const res = await generateObject({
            model: lab.model,
            schema,
            system,
            prompt: prompts[i]!,
            temperature: 0,
            abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
          value = res.object.value as boolean;
        } catch {
          value = null;
        }
        const t1 = Date.now();
        calls.push({ id: ids[i]!, value, startedAt: t0, endedAt: t1, latencyMs: t1 - t0 });
        done++;
        if (done % 25 === 0 || done === rows.length) {
          const errs = calls.filter((c) => c.value === null).length;
          const med = [...calls].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(calls.length / 2)]!.latencyMs;
          console.log(`  ${label}: ${done}/${rows.length} done, ${errs} errors, median latency ${(med / 1000).toFixed(1)}s`);
          writeFileSync(`${OUT}.${label}.partial.json`, JSON.stringify(calls));
        }
      },
    );
    return calls;
  };
  console.log(`rows ${rows.length}; cached v1 present ${cache.size}; model ${lab.model}`);
  const rand = mulberry32(20260929);
  if (EXTEND > 0) {
    // Concurrent arm only, on rows disjoint from the main run; the main
    // run's sequential arm is the comparison for the rate.
    const { readFileSync } = await import("node:fs");
    const main = JSON.parse(readFileSync(MAIN_OUT, "utf8")) as { sequential: { flips: number; usable: number }; concurrency: { concurrent: number } };
    const tConc = Date.now();
    const concurrent = await arm(CONC, "concurrent-ext");
    const concMs = Date.now() - tConc;
    const byCompletion = [...concurrent].sort((a, b) => a.endedAt - b.endedAt);
    const usable = byCompletion.filter((c) => c.value !== null && cache.has(c.id));
    const flips: number[] = usable.map((c) => (cache.get(c.id) !== c.value ? 1 : 0));
    const k = flips.reduce((a, b) => a + b, 0);
    const p2 = usable.length > 0 ? k / usable.length : 0;
    const p1 = main.sequential.flips / Math.max(1, main.sequential.usable);
    const pooled = (main.sequential.flips + k) / Math.max(1, main.sequential.usable + usable.length);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, main.sequential.usable) + 1 / Math.max(1, usable.length)));
    const zStat = se > 0 ? (p1 - p2) / se : 0;
    const out = {
      experiment: "exp17-independence-ext",
      note: `concurrent arm only, on the ${rows.length} rows of the seeded order after the main run's ${N}; same v2 prompt, same model, T=0; flips against the August v1 cache`,
      model: lab.model,
      rowsOffset: N,
      n: rows.length,
      concurrency: CONC,
      callTimeoutMs: CALL_TIMEOUT_MS,
      wallMs: concMs,
      ranAt: new Date().toISOString(),
      concurrent: {
        calls: concurrent.length,
        errors: concurrent.filter((c) => c.value === null).length,
        usable: usable.length,
        flips: k,
        flipRate: usable.length > 0 ? p2 : null,
        wilson95: wilson(k, usable.length),
        medianLatencyMs: [...concurrent].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(concurrent.length / 2)]?.latencyMs ?? null,
        serial: serialTests(flips, rand),
      },
      againstMainSequential: { sequentialRate: p1, z: zStat, twoSidedP: normalTwoSided(zStat) },
      draws: ids.map((id) => ({ id, cached: cache.get(id) ?? null, concurrent: concurrent.find((c) => c.id === id)?.value ?? null })),
      completionOrder: byCompletion.map((c) => ({ id: c.id, startedAt: c.startedAt, endedAt: c.endedAt, latencyMs: c.latencyMs })),
      totalWallMs: Date.now() - started,
    };
    mkdirSync("docs/research/experiments", { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ rate: out.concurrent.flipRate, serial: out.concurrent.serial, againstMainSequential: out.againstMainSequential }, null, 1));
    console.log("EXP17_EXT_DONE");
    process.exit(0);
  }
  const tSeq = Date.now();
  const sequential = await arm(1, "sequential");
  const seqMs = Date.now() - tSeq;
  console.log(`sequential arm done in ${(seqMs / 1000).toFixed(0)}s`);
  const tConc = Date.now();
  const concurrent = await arm(CONC, "concurrent");
  const concMs = Date.now() - tConc;
  console.log(`concurrent arm done in ${(concMs / 1000).toFixed(0)}s`);

  const summarize = (calls: Call[]) => {
    const byCompletion = [...calls].sort((a, b) => a.endedAt - b.endedAt);
    const usable = byCompletion.filter((c) => c.value !== null && cache.has(c.id));
    const flips: number[] = usable.map((c) => (cache.get(c.id) !== c.value ? 1 : 0));
    const k = flips.reduce((a, b) => a + b, 0);
    const byStratum = (v: boolean) => {
      const sub = usable.filter((c) => cache.get(c.id) === v);
      const kk = sub.filter((c) => cache.get(c.id) !== c.value).length;
      return { n: sub.length, flips: kk, rate: sub.length > 0 ? kk / sub.length : null, wilson95: wilson(kk, sub.length) };
    };
    return {
      calls: calls.length,
      errors: calls.filter((c) => c.value === null).length,
      usable: usable.length,
      flips: k,
      flipRate: usable.length > 0 ? k / usable.length : null,
      wilson95: wilson(k, usable.length),
      cachedFalse: byStratum(false),
      cachedTrue: byStratum(true),
      medianLatencyMs: [...calls].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(calls.length / 2)]?.latencyMs ?? null,
      serial: serialTests(flips, rand),
    };
  };
  const seq = summarize(sequential);
  const conc = summarize(concurrent);
  // Two-proportion z-test on the flip rates.
  const p1 = seq.flipRate ?? 0;
  const p2 = conc.flipRate ?? 0;
  const pooled = (seq.flips + conc.flips) / Math.max(1, seq.usable + conc.usable);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, seq.usable) + 1 / Math.max(1, conc.usable)));
  const zStat = se > 0 ? (p1 - p2) / se : 0;
  // Between-arm agreement on the same row.
  const seqBy = new Map(sequential.map((c) => [c.id, c.value]));
  let both = 0;
  let disagree = 0;
  const disagreeByStratum: Record<string, { n: number; d: number }> = { false: { n: 0, d: 0 }, true: { n: 0, d: 0 } };
  for (const c of concurrent) {
    const s = seqBy.get(c.id);
    if (s === null || s === undefined || c.value === null || !cache.has(c.id)) continue;
    both++;
    const key = String(cache.get(c.id));
    disagreeByStratum[key]!.n++;
    if (s !== c.value) {
      disagree++;
      disagreeByStratum[key]!.d++;
    }
  }
  const out = {
    experiment: "exp17-independence",
    note: "same rows, same v2 prompt, same model, T=0; one request in flight versus 32; flips against the August v1 cache; both arms drawn 2026-09-29",
    model: lab.model,
    n: rows.length,
    concurrency: { sequential: 1, concurrent: CONC },
    callTimeoutMs: CALL_TIMEOUT_MS,
    wallMs: { sequential: seqMs, concurrent: concMs },
    sequential: seq,
    concurrent: conc,
    flipRateDifference: { sequentialMinusConcurrent: p1 - p2, z: zStat, twoSidedP: normalTwoSided(zStat) },
    betweenArmAgreement: {
      rows: both,
      disagreements: disagree,
      rate: both > 0 ? disagree / both : null,
      wilson95: wilson(disagree, both),
      byCachedValue: Object.fromEntries(
        Object.entries(disagreeByStratum).map(([k, v]) => [k, { ...v, rate: v.n > 0 ? v.d / v.n : null, wilson95: wilson(v.d, v.n) }]),
      ),
    },
    draws: ids.map((id) => ({
      id,
      cached: cache.get(id) ?? null,
      sequential: seqBy.get(id) ?? null,
      concurrent: concurrent.find((c) => c.id === id)?.value ?? null,
    })),
    completionOrder: {
      sequential: [...sequential].sort((a, b) => a.endedAt - b.endedAt).map((c) => ({ id: c.id, endedAt: c.endedAt, latencyMs: c.latencyMs })),
      concurrent: [...concurrent].sort((a, b) => a.endedAt - b.endedAt).map((c) => ({ id: c.id, startedAt: c.startedAt, endedAt: c.endedAt, latencyMs: c.latencyMs })),
    },
    totalWallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ seq: { rate: seq.flipRate, serial: seq.serial }, conc: { rate: conc.flipRate, serial: conc.serial }, diff: out.flipRateDifference, agreement: out.betweenArmAgreement.rate }, null, 1));
  console.log("EXP17_DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
