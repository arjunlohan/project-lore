/**
 * Experiment 18b: the replication analysis of the main results table,
 * repeated on every further model.
 *
 * The family study (exp12, exp18) reports one seeded run per model and edit
 * pair. One seed can mislead: on the primary model the synonym pair at
 * alpha = 0.1 is refused on the main seed and certified in most sampling
 * replications. This script therefore resamples the stored per-row draws of
 * every further model exactly as exp8 resamples the primary model's labels:
 * the labels stay frozen, the within-stratum sample order is redrawn from
 * seeds 1000..1999, and the pinned procedure (strata by cached value, exact
 * bound, doubling looks from 45, at most six looks, futility rule,
 * delta = 0.1 split over the strata) runs on each.
 *
 * It first reproduces the main-seed outcome each artifact stores (calls and
 * cells reused), with that artifact's own seed convention, and stops if any
 * differs, so the replications are known to run on the same strata.
 *
 * Zero API cost; reads the committed artifacts only.
 *
 * Run: pnpm tsx scripts/experiments/exp18b-family-replications.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { adaptiveCertifyStratum, seededShuffle } from "@lore/core/sivm";

const DIR = "docs/research/experiments";
const OUT = `${DIR}/exp18b-family-replications.json`;
const DELTA = 0.1;
const ALPHAS = [0.1, 0.2];
const B = Number(process.env.EXP_B ?? 1000);
const MAIN_SEED = 42;

type Stratum = { id: string; flips: number[] };
type StoredSweep = { alpha: number; certifiedStrata: string[]; sampled: number; reused: number };

const key = (v: unknown) => JSON.stringify(v);

/** One run of the pinned procedure over frozen labels. */
async function run(strata: Stratum[], alpha: number, seedOf: (s: Stratum) => number) {
  let sampled = 0;
  let reused = 0;
  let reusedFlips = 0;
  let certTotal = 0;
  const total = strata.reduce((a, s) => a + s.flips.length, 0);
  for (const s of strata) {
    const order = seededShuffle(s.flips.map((_, i) => i), seedOf(s));
    const o = await adaptiveCertifyStratum(
      s.flips.length,
      alpha,
      DELTA / strata.length,
      async (n) => order.slice(0, n).map((i) => s.flips[i]!),
      45,
      6,
      "presented",
      "exact",
    );
    sampled += o.sampled;
    if (o.certified) {
      const rest = order.slice(o.sampled);
      reused += rest.length;
      reusedFlips += rest.reduce((a, i) => a + s.flips[i]!, 0);
      certTotal += s.flips.length;
    }
  }
  return { sampled, reused, reusedFlips, certTotal, savings: total > 0 ? reused / total : 0 };
}

async function replicate(strata: Stratum[], alpha: number) {
  let certRuns = 0;
  let unsafePresented = 0;
  const savings: number[] = [];
  for (let b = 0; b < B; b++) {
    // The same seed convention as exp8's replications.
    const o = await run(strata, alpha, (s) => 1000 + b + s.id.length * 7919);
    savings.push(o.savings);
    if (o.reused > 0) {
      certRuns++;
      if (o.reusedFlips / o.certTotal > alpha) unsafePresented++;
    }
  }
  const sorted = [...savings].sort((x, y) => x - y);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
  return {
    B,
    certificationRate: certRuns / B,
    savingsMean: savings.reduce((a, x) => a + x, 0) / B,
    savingsLo: q(0.025),
    savingsHi: q(0.975),
    // Unconditional: the share of all replications that certify with a
    // realized presented-cells error above the budget.
    unsafePresentedRate: unsafePresented / B,
  };
}

async function main() {
  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  const check = (file: string, pair: string, stored: StoredSweep, got: { sampled: number; reused: number }) => {
    if (stored.sampled !== got.sampled || stored.reused !== got.reused) {
      throw new Error(`${file} ${pair} alpha=${stored.alpha}: main seed gives ${got.sampled}/${got.reused}, the artifact stores ${stored.sampled}/${stored.reused}`);
    }
  };
  const files = readdirSync(DIR).filter((f) => !f.endsWith(".partial.json")).sort();

  // The Boolean lab column's two pairs (exp12): formatting v1 -> v2 and
  // synonym v2 -> v3, strata "v=true" / "v=false", main seed 42 unshifted.
  for (const file of files.filter((f) => /^exp12-secondmodel-.+\.json$/.test(f))) {
    const a = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as {
      model: string;
      sweeps: StoredSweep[];
      synonym?: { usableEdit: number; sweeps: StoredSweep[] };
      n: number;
      draws?: Array<{ a1: boolean | null; a2: boolean | null; a3?: boolean | null }>;
    };
    if (!a.draws || a.draws.length === 0) continue;
    const strataOf = (cache: Array<boolean | null>, fresh: Array<boolean | null>): Stratum[] =>
      [true, false]
        .map((val) => ({
          id: `v=${val}`,
          flips: cache.map((_, i) => i).filter((i) => cache[i] === val && fresh[i] !== null).map((i) => (cache[i] !== fresh[i] ? 1 : 0)),
        }))
        .filter((s) => s.flips.length > 0);
    const col = (k: "a1" | "a2" | "a3") => a.draws!.map((d) => (d[k] === undefined ? null : d[k]!));
    const pairs: Array<{ pair: string; strata: Stratum[]; stored: StoredSweep[] }> = [
      { pair: "so-formatting", strata: strataOf(col("a1"), col("a2")), stored: a.sweeps },
    ];
    // A synonym pair that did not complete is not reported (as in Table 6).
    if (a.synonym && a.synonym.usableEdit >= 0.95 * a.n) {
      pairs.push({ pair: "so-synonym", strata: strataOf(col("a2"), col("a3")), stored: a.synonym.sweeps });
    }
    for (const p of pairs) {
      for (const alpha of ALPHAS) {
        const stored = p.stored.find((s) => Math.abs(s.alpha - alpha) < 1e-9);
        if (!stored) continue;
        const mainRun = await run(p.strata, alpha, () => MAIN_SEED);
        check(file, p.pair, stored, mainRun);
        const rep = await replicate(p.strata, alpha);
        results.push({ model: a.model, file, pair: p.pair, alpha, n: p.strata.reduce((x, s) => x + s.flips.length, 0), strata: p.strata.length, mainSeed: { sampled: mainRun.sampled, reused: mainRun.reused, certified: mainRun.reused > 0 }, replications: rep });
        console.log(`${a.model} ${p.pair} alpha=${alpha}: main ${mainRun.reused > 0 ? "certifies" : "refused"}; replications certify ${(rep.certificationRate * 100).toFixed(1)}%, mean savings ${(rep.savingsMean * 100).toFixed(1)}%`);
      }
    }
  }

  // The remaining three pairs (exp18): strata "v=<value>|all", main seed
  // shifted by the stratum id's length, as exp8 shifts it.
  for (const file of files.filter((f) => /^exp18-families-(widening|djinni)-.+\.json$/.test(f))) {
    const a = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as {
      model: string;
      pairs: Record<string, { cache: string; fresh: string; sweeps: StoredSweep[] }>;
      draws: Array<Record<string, unknown>>;
    };
    for (const [pair, spec] of Object.entries(a.pairs)) {
      const cache = a.draws.map((d) => (d[spec.cache] === undefined ? null : d[spec.cache]));
      const fresh = a.draws.map((d) => (d[spec.fresh] === undefined ? null : d[spec.fresh]));
      const values = [...new Set(cache.filter((v) => v !== null).map(key))];
      const strata: Stratum[] = values
        .map((v) => ({
          id: `v=${v}|all`,
          flips: cache
            .map((_, i) => i)
            .filter((i) => cache[i] !== null && key(cache[i]) === v && fresh[i] !== null)
            .map((i) => (key(cache[i]) !== key(fresh[i]) ? 1 : 0)),
        }))
        .filter((s) => s.flips.length > 0);
      for (const alpha of ALPHAS) {
        const stored = spec.sweeps.find((s) => Math.abs(s.alpha - alpha) < 1e-9);
        if (!stored) continue;
        const mainRun = await run(strata, alpha, (s) => MAIN_SEED + s.id.length * 7919);
        check(file, pair, stored, mainRun);
        const rep = await replicate(strata, alpha);
        results.push({ model: a.model, file, pair, alpha, n: strata.reduce((x, s) => x + s.flips.length, 0), strata: strata.length, mainSeed: { sampled: mainRun.sampled, reused: mainRun.reused, certified: mainRun.reused > 0 }, replications: rep });
        console.log(`${a.model} ${pair} alpha=${alpha}: main ${mainRun.reused > 0 ? "certifies" : "refused"}; replications certify ${(rep.certificationRate * 100).toFixed(1)}%, mean savings ${(rep.savingsMean * 100).toFixed(1)}%`);
      }
    }
  }

  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        experiment: "exp18b-family-replications",
        procedure: `strata=value-only; bound=exact; adaptive n0=45 maxLooks=6; delta=${DELTA}; prng=mulberry32; replication seeds 1000..${1000 + B - 1}; labels frozen (the stored draws of exp12 and exp18)`,
        results,
        wallMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  console.log(`EXP18B_DONE ${results.length} cells`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
