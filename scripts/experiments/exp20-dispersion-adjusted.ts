/**
 * Experiment 20: the deployment certificates under a bound widened for the
 * dispersion the independence check measured (second review round of the
 * IEEE Access resubmission, Reviewer 2's first concern).
 *
 * The live certifications of Section V-E drew their oracle cells 32 at a
 * time, and the independence check (exp17) could not rule out dependence
 * among draws issued together: pooled over both concurrent arms, flip counts
 * over blocks of 32 vary 1.42 times as much as independent draws would
 * (95% interval up to 2.37). This script asks what the certificates become
 * if that dispersion is real and the bound is widened for it, using
 * `dispersionAdjustedUpperBound` (the Clopper-Pearson limit at the effective
 * sample size n/phi; Korn and Graubard). It replays the pinned procedure
 * (value strata, doubling looks from 45, at most six, delta = 0.1, futility
 * rule) over each snapshot's stored sample path, at each budget and ratio.
 *
 * Retrospective by construction: the ratio comes from a check run after the
 * draws. It is a sensitivity analysis of Assumption 1. Wherever the widened
 * bound issues a certificate here it sits at or above the exact bound, so
 * Theorem 1 covers that certificate under its assumptions; the protection
 * the widening adds under dependence rests on the block model alone.
 *
 * Korn and Graubard also shrink the effective sample size by a
 * degrees-of-freedom factor, (t_{n-1} / t_d)^2, for the noise in an
 * estimated design effect. The replay runs once more at the pooled estimate
 * with that factor folded into phi, at the pooled estimate's d degrees of
 * freedom and at the schedule's deepest look, where the factor is largest.
 *
 * Inputs: the per-look flip counts the deployment replays recorded
 * (exp11c-deployment-bounds.json for August, -v4 for September; the
 * Maurer-Pontil arms reach the deepest looks, and every arm walks the same
 * seeded path), the dispersion ratios exp9c read from exp17, and the pooled
 * estimate's degrees of freedom (exp17-independence-ext.json). A look the
 * stored draws do not reach is reported as such, never filled in.
 *
 * Zero API cost. Run: pnpm tsx scripts/experiments/exp20-dispersion-adjusted.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  adaptiveCertifyStratum,
  binomialUpperBound,
  dispersionAdjustedUpperBound,
  exactUpperBound,
  regularizedBeta,
} from "@lore/core/sivm";

const DELTA = 0.1;
const N0 = 45;
const MAX_LOOKS = 6;
const ALPHAS = [0.2, 0.1, 0.05];
const OUT = "docs/research/experiments/exp20-dispersion-adjusted.json";

type Look = { n: number; flips: number };
type Stratum = { stratumId: string; size: number; looks?: Look[] };
type Sweep = { bound: string; alpha: number; status: string; oracleCalls: number; reused: number; n: number; strata?: Stratum[] };
type Deploy = { snapshot: string; n: number; sweeps: Sweep[] };

const read = (f: string) => JSON.parse(readFileSync(`docs/research/experiments/${f}`, "utf8"));

/** Every (look size -> flips) a snapshot's arms recorded, per stratum. */
function samplePath(d: Deploy): Map<string, { size: number; flipsAt: Map<number, number> }> {
  const path = new Map<string, { size: number; flipsAt: Map<number, number> }>();
  for (const sw of d.sweeps) {
    // An arm that stopped for want of stored draws records no strata.
    for (const s of sw.strata ?? []) {
      const entry = path.get(s.stratumId) ?? { size: s.size, flipsAt: new Map<number, number>() };
      for (const l of s.looks ?? []) {
        const seen = entry.flipsAt.get(l.n);
        // Every arm walks one seeded path, so two arms that reached the same
        // look must have seen the same flips there.
        if (seen !== undefined && seen !== l.flips) {
          throw new Error(`${d.snapshot} ${s.stratumId}: look ${l.n} recorded ${seen} and ${l.flips} flips`);
        }
        entry.flipsAt.set(l.n, l.flips);
      }
      path.set(s.stratumId, entry);
    }
  }
  return path;
}

/** Student t quantile at probability p in (0.5, 1), by bisection on the CDF. */
function tQuantile(p: number, df: number): number {
  const cdf = (t: number) => 1 - 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

class BeyondStoredDraws extends Error {
  constructor(readonly look: number) {
    super(`look ${look} is beyond the stored draws`);
  }
}

async function main() {
  // The bound at phi = 1 is the binomial Clopper-Pearson limit, and at the
  // deployment stratum's size it must agree with the exact bound the
  // certificates were issued under (to three decimal places).
  for (const [k, n] of [[0, 90], [2, 45], [5, 180], [20, 360]] as const) {
    const adj = dispersionAdjustedUpperBound(k, n, DELTA / 12, 1);
    const cp = binomialUpperBound(k, n, DELTA / 12);
    const exact = exactUpperBound(k, n, 81469, DELTA / 12);
    if (Math.abs(adj - cp) > 1e-6) throw new Error(`phi=1 bound ${adj} differs from Clopper-Pearson ${cp} at ${k}/${n}`);
    if (Math.abs(adj - exact) > 5e-4) throw new Error(`phi=1 bound ${adj} differs from the exact bound ${exact} at ${k}/${n}`);
  }

  const exp9c = read("exp9c-overdispersion.json") as { ratios: Array<{ label: string; phi: number }> };
  const ratioOf = (label: string) => {
    const r = exp9c.ratios.find((x) => x.label === label);
    if (!r) throw new Error(`exp9c has no ratio labelled "${label}"`);
    return r.phi;
  };
  // Korn and Graubard's degrees-of-freedom factor at the pooled estimate:
  // phi * (t_d / t_{n-1})^2 at the per-look level, largest at the deepest
  // look of the schedule (t_{n-1} falls with n), so one ratio covers every
  // look conservatively. Both snapshots have two strata.
  const pooled = (read("exp17-independence-ext.json") as { pooledWithMainConcurrent?: { dispersionDf: number } }).pooledWithMainConcurrent;
  if (!pooled) throw new Error("exp17-independence-ext.json carries no pooled estimate; run EXP_REANALYZE=1 scripts/experiments/exp17-independence.ts");
  const PER_LOOK = DELTA / 2 / MAX_LOOKS;
  // The doubling schedule's deepest look (both deployment strata that reach
  // it are larger than this).
  const deepest = N0 * 2 ** (MAX_LOOKS - 1);
  const dfFactor = (tQuantile(1 - PER_LOOK, pooled.dispersionDf) / tQuantile(1 - PER_LOOK, deepest - 1)) ** 2;
  const RATIOS = [
    { key: "independent", label: "independent draws", phi: 1 },
    { key: "pooledEstimate", label: "both concurrent arms pooled, estimate", phi: ratioOf("pooled estimate (both concurrent arms)") },
    { key: "pooledUpper", label: "both concurrent arms pooled, upper end of the 95% interval", phi: ratioOf("upper end of the pooled 95% interval") },
    {
      key: "pooledEstimateDf",
      label: `both concurrent arms pooled, estimate, with the degrees-of-freedom factor (d = ${pooled.dispersionDf}, look ${deepest})`,
      phi: ratioOf("pooled estimate (both concurrent arms)") * dfFactor,
    },
  ];

  const snapshots: Array<{ key: string; file: string }> = [
    { key: "august", file: "exp11c-deployment-bounds.json" },
    { key: "september", file: "exp11c-deployment-bounds-v4.json" },
  ];
  const results: Record<string, unknown>[] = [];
  for (const snap of snapshots) {
    const d = read(snap.file) as Deploy;
    const path = samplePath(d);
    const strata = [...path.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const K = strata.length;
    for (const alpha of ALPHAS) {
      for (const r of RATIOS) {
        let calls = 0;
        let reused = 0;
        let reachable = true;
        const perStratum: Record<string, unknown>[] = [];
        for (const [id, s] of strata) {
          try {
            const outcome = await adaptiveCertifyStratum(
              s.size,
              alpha,
              DELTA / K,
              async (n) => {
                const k = s.flipsAt.get(n);
                if (k === undefined) throw new BeyondStoredDraws(n);
                // The exact and Clopper-Pearson bounds and the futility rule
                // read the count alone, so a prefix with the right count is
                // the stored prefix for every decision the replay takes.
                return Array.from({ length: n }, (_, i) => (i < k ? 1 : 0));
              },
              N0,
              MAX_LOOKS,
              "presented",
              "exact",
              r.phi,
            );
            calls += outcome.sampled;
            if (outcome.certified) reused += s.size - outcome.sampled;
            const last = outcome.looks[outcome.looks.length - 1]!;
            perStratum.push({
              stratumId: id,
              size: s.size,
              certified: outcome.certified,
              decidedAtLook: last.n,
              flips: last.flips,
              futility: !outcome.certified && last.flips / last.n > alpha,
              looks: outcome.looks.map((l) => ({ n: l.n, flips: l.flips, upperBound: l.upperBound, certified: l.certified })),
            });
          } catch (err) {
            if (!(err instanceof BeyondStoredDraws)) throw err;
            reachable = false;
            perStratum.push({ stratumId: id, size: s.size, reachable: false, needsLook: err.look });
          }
        }
        const rec = {
          snapshot: d.snapshot,
          snapshotKey: snap.key,
          alpha,
          ratioKey: r.key,
          ratioLabel: r.label,
          phi: r.phi,
          reachable,
          ...(reachable ? { oracleCalls: calls, reused, savings: reused / d.n } : {}),
          strata: perStratum,
        };
        results.push(rec);
        console.log(
          `${snap.key} alpha=${alpha} phi=${r.phi.toFixed(3)}: ` +
            (reachable
              ? `${reused > 0 ? "certified" : "refused"}; calls ${calls}; reused ${reused}`
              : "beyond the stored draws"),
        );
      }
    }
  }

  // At phi = 1 the replay must reproduce the exact-bound certificates the
  // deployment artifacts record (September: Table 6), or it is not walking
  // the stored path.
  const v4 = read("exp11c-deployment-bounds-v4.json") as Deploy;
  for (const sw of v4.sweeps.filter((x) => x.bound === "exact")) {
    const mine = results.find((x) => x.snapshotKey === "september" && x.alpha === sw.alpha && x.ratioKey === "independent") as { oracleCalls: number; reused: number };
    if (mine.oracleCalls !== sw.oracleCalls || mine.reused !== sw.reused) {
      throw new Error(`September alpha=${sw.alpha}: replay gives ${mine.oracleCalls} calls / ${mine.reused} reused, the artifact ${sw.oracleCalls} / ${sw.reused}`);
    }
  }

  // How much dependence each certificate tolerates: the largest ratio at
  // which the widened bound still clears its budget, at the look the
  // certificate was issued at (phi = 1) and at the best look the stored path
  // reaches. The bound grows with phi, so bisection finds it.
  const maxPhi = (k: number, n: number, alpha: number, perLook: number) => {
    if (dispersionAdjustedUpperBound(k, n, perLook, 1) > alpha) return 1;
    let lo = 1;
    let hi = 64;
    if (dispersionAdjustedUpperBound(k, n, perLook, hi) <= alpha) return hi;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (dispersionAdjustedUpperBound(k, n, perLook, mid) <= alpha) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const tolerance: Record<string, unknown>[] = [];
  for (const snap of snapshots) {
    const d = read(snap.file) as Deploy;
    const path = samplePath(d);
    const fals = [...path.entries()].find(([id]) => id.startsWith("v=false"))![1];
    const K = path.size;
    const looksSorted = [...fals.flipsAt.entries()].sort((a, b) => a[0] - b[0]);
    const perLook = DELTA / K / MAX_LOOKS;
    for (const alpha of [0.2, 0.1]) {
      const r = results.find((x) => x.snapshotKey === snap.key && x.alpha === alpha && x.ratioKey === "independent") as { reachable: boolean; strata: Array<{ stratumId: string; certified?: boolean; decidedAtLook?: number }> };
      const st = r.strata.find((x) => x.stratumId.startsWith("v=false"));
      if (!r.reachable || !st?.certified) continue;
      const issued = st.decidedAtLook!;
      const atIssued = maxPhi(fals.flipsAt.get(issued)!, issued, alpha, perLook);
      // Later looks count only while the futility rule would not have stopped
      // the stratum first (its empirical rate stays within the budget).
      let best = { look: issued, phi: atIssued };
      for (const [n, k] of looksSorted) {
        if (k / n > alpha) break;
        const phi = maxPhi(k, n, alpha, perLook);
        if (phi > best.phi) best = { look: n, phi };
      }
      tolerance.push({ snapshotKey: snap.key, alpha, issuedLook: issued, phiAtIssuedLook: atIssued, bestLook: best.look, phiAtBestLook: best.phi });
      console.log(`${snap.key} alpha=${alpha}: tolerates phi up to ${atIssued.toFixed(2)} at look ${issued}, ${best.phi.toFixed(2)} at look ${best.look}`);
    }
  }

  // The certificate the system applied in August (Maurer-Pontil, cached-FALSE
  // stratum certified at the look of 180 draws with 5 flips): the widened
  // bound on that same evidence, at the per-look level of the pinned schedule.
  const aug = samplePath(read("exp11c-deployment-bounds.json") as Deploy);
  const augFalse = [...aug.entries()].find(([id]) => id.startsWith("v=false"))![1];
  const appliedLook = 180;
  const appliedFlips = augFalse.flipsAt.get(appliedLook);
  if (appliedFlips === undefined) throw new Error("the August path lacks the applied certificate's look");
  const applied = RATIOS.map((r) => ({
    ratioKey: r.key,
    phi: r.phi,
    upperBound: dispersionAdjustedUpperBound(appliedFlips, appliedLook, DELTA / 2 / MAX_LOOKS, r.phi),
  }));

  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        experiment: "exp20-dispersion-adjusted",
        note: "the deployment certificates of Section V-E replayed under the pinned procedure with each look's bound widened for a dispersion ratio phi of the oracle draws (Clopper-Pearson at the effective sample size n/phi, Korn-Graubard; pooledEstimateDf folds in their degrees-of-freedom factor); retrospective, a sensitivity analysis of Assumption 1. Where a widened certificate is issued the widened bound is at or above the exact bound, so Theorem 1 covers the certificate under its assumptions; the protection under dependence rests on the block model",
        degreesOfFreedom: { d: pooled.dispersionDf, look: deepest, perLookDelta: PER_LOOK, factor: dfFactor },
        delta: DELTA,
        schedule: { n0: N0, maxLooks: MAX_LOOKS },
        ratios: RATIOS,
        results,
        appliedAugustCertificate: { look: appliedLook, flips: appliedFlips, perLookDelta: DELTA / 2 / MAX_LOOKS, bounds: applied, phiTolerated: maxPhi(appliedFlips, appliedLook, 0.2, DELTA / 2 / MAX_LOOKS) },
        tolerance,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
