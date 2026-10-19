/**
 * Experiment 21: how much the replication results move with the labels
 * (second review round of the IEEE Access resubmission, Reviewer 1's third
 * technical concern).
 *
 * The replications of Table 2 rerun the certifier with other sampling seeds
 * over one frozen set of labels, so their intervals show sampling
 * variability only. A label is itself one draw of the edited prompt, and
 * another draw would label some rows differently. The three-draw relabeling
 * (exp10) holds three further fresh draws of the edited prompt for every row
 * of the headline pair's evaluation vector. This script reruns the same
 * replication analysis (exp8, pinned procedure, 1,000 seeds) on the headline
 * pair with each of those draws as the label in place of the stored one,
 * against the same cache, so the spread across labelings shows what one
 * fresh set of model draws does to the frontier.
 *
 * Zero API cost. Run: pnpm tsx scripts/experiments/exp21-label-noise.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAIR = "so-formatting";
const OUT = "docs/research/experiments/exp21-label-noise.json";

type Released = { key: string; rowIds: string[]; cached: unknown[]; fresh: unknown[] } & Record<string, unknown>;
type Result = {
  pair: string;
  alpha: number;
  estimand: string;
  n: number;
  trueFlipRate: number;
  main: { savings: number };
  bootstrap: { B: number; certificationRate: number; savingsMean: number; savingsLo: number; savingsHi: number; unsafeCertificateRate: number; oracleMean: number };
};

const labels = JSON.parse(readFileSync("docs/research/experiments/benchmark-labels.json", "utf8")) as { pairs: Released[] } & Record<string, unknown>;
const relabel = JSON.parse(readFileSync("docs/research/experiments/exp10-labels.json", "utf8")) as Record<string, { d1: unknown[]; d2: unknown[] }>;
const pair = labels.pairs.find((p) => p.key === PAIR);
if (!pair) throw new Error(`benchmark-labels.json has no pair ${PAIR}`);

const dir = mkdtempSync(join(tmpdir(), "exp21-"));
/** Run the replication analysis on the headline pair with the given labels. */
function replicate(name: string, fresh: unknown[]): Result[] {
  const file = join(dir, `${name}-labels.json`);
  const out = join(dir, `${name}-out.json`);
  writeFileSync(file, JSON.stringify({ ...labels, pairs: [{ ...pair!, fresh }] }));
  execFileSync("pnpm", ["-s", "tsx", "scripts/experiments/exp8-final-table.ts"], {
    env: { ...process.env, EXP_STRATIFIER: "value-only", EXP_LABELS: file, EXP_PAIRS: PAIR, EXP_OUT: out },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return (JSON.parse(readFileSync(out, "utf8")) as { results: Result[] }).results.filter((r) => r.estimand === "presented");
}

function stratumRates(fresh: unknown[]) {
  const rate = (cachedValue: boolean) => {
    let n = 0;
    let flips = 0;
    pair!.cached.forEach((c, i) => {
      if (c !== cachedValue || c === null || fresh[i] === null || fresh[i] === undefined) return;
      n++;
      if (JSON.stringify(c) !== JSON.stringify(fresh[i])) flips++;
    });
    return { n, flips, rate: flips / n };
  };
  return { cachedFalse: rate(false), cachedTrue: rate(true) };
}

const labelings = [
  { key: "stored", label: "the stored labels (Table 2)", fresh: pair.fresh },
  ...[0, 1, 2].map((j) => ({
    key: `redraw${j + 1}`,
    label: `fresh draw ${j + 1} of the three-draw relabeling`,
    fresh: pair.rowIds.map((id) => {
      const r = relabel[id];
      if (!r) throw new Error(`exp10-labels.json has no row ${id}`);
      return r.d2[j] ?? null;
    }),
  })),
];

const runs = labelings.map((l) => {
  const results = replicate(l.key, l.fresh);
  console.log(`${l.key}: flip rate ${(results[0]!.trueFlipRate * 100).toFixed(2)}%`);
  return { key: l.key, label: l.label, strata: stratumRates(l.fresh), results };
});

// The stored labels must reproduce Table 2's headline rows exactly, or this
// is not the replication analysis Table 2 reports.
const table = JSON.parse(readFileSync("docs/research/experiments/exp8-final-table.json", "utf8")) as { results: Result[] };
for (const r of runs[0]!.results) {
  const t = table.results.find((x) => x.pair === PAIR && x.alpha === r.alpha && x.estimand === "presented");
  if (!t || t.bootstrap.savingsMean !== r.bootstrap.savingsMean || t.bootstrap.certificationRate !== r.bootstrap.certificationRate) {
    throw new Error(`the stored labels do not reproduce Table 2 at alpha=${r.alpha}`);
  }
}

const alphas = runs[0]!.results.map((r) => r.alpha);
const spread = alphas.map((alpha) => {
  const at = runs.map((run) => run.results.find((r) => r.alpha === alpha)!);
  const savings = at.map((r) => r.bootstrap.savingsMean);
  const cert = at.map((r) => r.bootstrap.certificationRate);
  return {
    alpha,
    savingsMeanMin: Math.min(...savings),
    savingsMeanMax: Math.max(...savings),
    certificationRateMin: Math.min(...cert),
    certificationRateMax: Math.max(...cert),
    unsafeCertificateRateMax: Math.max(...at.map((r) => r.bootstrap.unsafeCertificateRate)),
  };
});
for (const s of spread) {
  console.log(
    `alpha=${s.alpha}: mean savings ${(s.savingsMeanMin * 100).toFixed(1)}-${(s.savingsMeanMax * 100).toFixed(1)}%, ` +
      `certification ${(s.certificationRateMin * 100).toFixed(1)}-${(s.certificationRateMax * 100).toFixed(1)}%`,
  );
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      experiment: "exp21-label-noise",
      note: "the replication analysis of Table 2 (exp8: pinned procedure, value strata, exact bound, 1,000 sampling seeds) rerun on the headline pair with each fresh draw of the edited prompt from the three-draw relabeling (exp10) as the label, against the same cache; the spread across labelings is the label noise the frozen-label replications leave out",
      pair: PAIR,
      runs,
      spread,
    },
    null,
    2,
  ),
);
console.log(`wrote ${OUT}`);
