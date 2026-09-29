/**
 * Experiment 18 (IEEE Access resubmission, reviewer 1): the remaining edit
 * pairs on further model families, so every family in the model-family
 * table carries the full edit set, not only the lab column's two pairs.
 *
 * exp12 covers the lab column (formatting v1->v2, synonym v2->v3). This
 * covers the other three benchmark pairs (pairs.ts) with the same protocol:
 * the same seeded evaluation rows as the primary model, the production
 * runner's own system framing and typed schema, temperature 0, one fresh
 * draw per cell, the pinned value-stratified adaptive procedure.
 *
 *   EXP_PAIRSET=widening  production Boolean column, v1->v2 (scope widening):
 *                         a1 = v1 draw (cache), b1 = second v1 draw (floor),
 *                         a2 = v2 draw.
 *   EXP_PAIRSET=djinni    seniority-tier select column, v1->v2 (formatting)
 *                         and v2->v3 (criteria change): a1, b1 = v1 draws,
 *                         a2 = v2, a3 = v3; the formatting pair's cache is a1,
 *                         the criteria pair's cache is a2, as pairs.ts defines
 *                         the benchmark.
 *
 * Draw bookkeeping is exp12's: per-row draws are dumped so every derived
 * quantity can be recomputed, the run checkpoints every 100 draws to
 * <out>.partial.json, EXP_FILL_FROM completes a partial artifact by querying
 * only null slots, and EXP_REPLAY_FROM recomputes everything from stored
 * draws with no model calls.
 *
 * Run: set -a; source .env.local; set +a; \
 *   EXP_MODEL=<gateway id> EXP_PAIRSET=widening|djinni EXP_ROWS=2000 \
 *   pnpm tsx scripts/experiments/exp18-families-pairs.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import type { ColumnOutputType } from "@lore/core";
import { adaptiveCertifyStratum, seededShuffle, type BoundKind } from "@lore/core/sivm";
import { getColumnVersion, listColumns } from "../../lib/lore/column-store";
import { bindTemplate, systemFor, valueSchema } from "../../lib/lore/run-column";
import { pairByKey } from "./pairs";

const MODEL = process.env.EXP_MODEL;
const PAIRSET = process.env.EXP_PAIRSET as "widening" | "djinni" | undefined;
const N = Number(process.env.EXP_ROWS ?? 2000);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 16);
const REPLAY_FROM = process.env.EXP_REPLAY_FROM;
const FILL_FROM = process.env.EXP_FILL_FROM;
const BOUND = (process.env.EXP_BOUND ?? "exact") as BoundKind;
const DELTA = 0.1;
const ALPHAS = [0.1, 0.2];
const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

if (!REPLAY_FROM && (!MODEL || !PAIRSET)) {
  throw new Error("EXP_MODEL and EXP_PAIRSET (widening|djinni) are required");
}
const slug = (m: string) => m.replace(/[^a-z0-9.]+/gi, "-");
const OUT =
  process.env.EXP_OUT ??
  REPLAY_FROM ??
  `docs/research/experiments/exp18-families-${PAIRSET}-${slug(MODEL ?? "")}.json`;

type Row = Record<string, unknown>;
type Draw = { id: unknown; a1: unknown; b1: unknown; a2: unknown; a3?: unknown };
type DrawKey = "a1" | "b1" | "a2" | "a3";

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

interface PairSetDef {
  corpus: "profiles" | "djinni";
  columnMatch: (name: string) => boolean;
  rowsQuery: [string, unknown[]];
  idField: string;
  versions: number[]; // versions drawn, in order a1(+b1), a2, a3...
  pairs: Array<{ key: string; cache: DrawKey; fresh: DrawKey }>;
}
const SETS: Record<"widening" | "djinni", PairSetDef> = {
  widening: {
    corpus: "profiles",
    columnMatch: pairByKey("so-widening").columnMatch,
    rowsQuery: [`SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`, [pairByKey("so-widening").rowSeed, N]],
    idField: pairByKey("so-widening").idField,
    versions: [1, 2],
    pairs: [{ key: "so-widening", cache: "a1", fresh: "a2" }],
  },
  djinni: {
    corpus: "djinni",
    columnMatch: pairByKey("dj-formatting").columnMatch,
    rowsQuery: [
      `SELECT id, position, experience_years, SUBSTRING(cv,1,4000) AS cv
       FROM djinni_profiles WHERE cv IS NOT NULL AND position IS NOT NULL
       ORDER BY RAND(?) LIMIT ?`,
      [pairByKey("dj-formatting").rowSeed, N],
    ],
    idField: pairByKey("dj-formatting").idField,
    versions: [1, 2, 3],
    pairs: [
      { key: "dj-formatting", cache: "a1", fresh: "a2" },
      { key: "dj-criteria", cache: "a2", fresh: "a3" },
    ],
  },
};

async function main() {
  const started = Date.now();
  if (REPLAY_FROM) {
    const prior = JSON.parse(readFileSync(REPLAY_FROM, "utf8")) as {
      model: string;
      pairset: "widening" | "djinni";
      outputSpec: ColumnOutputType;
      ranAt?: string;
      draws: Draw[];
    };
    await finish({
      model: prior.model,
      pairset: prior.pairset,
      outputSpec: prior.outputSpec,
      draws: prior.draws,
      started,
      ranAt: prior.ranAt ?? new Date(started).toISOString(),
      out: process.env.EXP_OUT ?? REPLAY_FROM,
    });
    return;
  }
  const set = SETS[PAIRSET!];
  const column = (await listColumns(set.corpus)).find((c) => set.columnMatch(c.name));
  if (!column) throw new Error(`column for pair set ${PAIRSET} not found`);
  const versions = await Promise.all(set.versions.map((v) => getColumnVersion(column.id, v)));
  if (versions.some((v) => !v)) throw new Error("column versions missing");
  const prior = FILL_FROM
    ? (JSON.parse(readFileSync(FILL_FROM, "utf8")) as { model: string; pairset: string; n: number; ranAt?: string; draws: Draw[] })
    : null;
  if (prior && (prior.model !== MODEL || prior.pairset !== PAIRSET)) {
    throw new Error(`fill: artifact is ${prior.model}/${prior.pairset}, not ${MODEL}/${PAIRSET}`);
  }
  if (prior && prior.n !== N) throw new Error(`fill: artifact n ${prior.n} != EXP_ROWS ${N}`);

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(set.rowsQuery[0], set.rowsQuery[1]);
  await db.end();
  const rows = (rowsRaw as Row[]).map((r) => {
    const out: Row = { ...r };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v === "string" && v.startsWith("[")) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          /* keep */
        }
      }
    }
    return out;
  });
  const ids = rows.map((r) => r[set.idField]);
  if (prior) {
    for (let i = 0; i < ids.length; i++) {
      if (String(prior.draws[i]?.id) !== String(ids[i])) throw new Error(`fill: row order differs at ${i}`);
    }
  }

  const spec = column.output_spec as ColumnOutputType;
  const schema = z.object({ value: valueSchema(spec), rationale: z.string() });
  const system = systemFor(spec);
  let completedSinceCheckpoint = 0;
  let onProgress: (() => void) | null = null;
  const judge = async (prompt: string): Promise<unknown> => {
    let value: unknown = null;
    try {
      const res = await generateObject({ model: MODEL!, schema, system, prompt, temperature: 0 });
      value = res.object.value;
    } catch {
      value = null;
    }
    completedSinceCheckpoint++;
    if (completedSinceCheckpoint >= 100 && onProgress) {
      completedSinceCheckpoint = 0;
      onProgress();
    }
    return value;
  };

  const partial: Partial<Record<DrawKey, unknown[]>> = {};
  const outPath = process.env.EXP_OUT ?? FILL_FROM ?? OUT;
  const checkpoint = () => {
    const keys = Object.keys(partial) as DrawKey[];
    const draws = ids.map((id, i) => {
      const d: Record<string, unknown> = { id };
      for (const k of keys) d[k] = partial[k]![i] ?? null;
      return d;
    });
    writeFileSync(
      `${outPath}.partial.json`,
      JSON.stringify({ experiment: "exp18-families-pairs", model: MODEL, pairset: PAIRSET, outputSpec: spec, ranAt: prior?.ranAt ?? new Date(started).toISOString(), n: rows.length, partial: true, draws }),
    );
  };
  const drawOrKeep = async (prompts: string[], key: DrawKey) => {
    const out: unknown[] = prior ? prior.draws.map((r) => (r[key] as unknown) ?? null) : new Array(prompts.length).fill(null);
    const missing = out.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    if (prior) console.log(`fill ${key}: ${missing.length} of ${out.length} draws missing`);
    partial[key] = out;
    onProgress = () => {
      console.log(`  ${key}: ${out.filter((v) => v !== null).length}/${out.length} done`);
      checkpoint();
    };
    await mapLimit(missing, CONCURRENCY, async (i) => {
      out[i] = await judge(prompts[i]!);
      return null;
    });
    onProgress = null;
    checkpoint();
    return out;
  };

  const promptsFor = (v: number) => rows.map((r) => bindTemplate(versions[set.versions.indexOf(v)]!.prompt_template, r).text);
  const a1 = await drawOrKeep(promptsFor(set.versions[0]!), "a1");
  const b1 = await drawOrKeep(promptsFor(set.versions[0]!), "b1");
  const a2 = await drawOrKeep(promptsFor(set.versions[1]!), "a2");
  const a3 = set.versions.length > 2 ? await drawOrKeep(promptsFor(set.versions[2]!), "a3") : null;

  await finish({
    model: MODEL!,
    pairset: PAIRSET!,
    outputSpec: spec,
    draws: ids.map((id, i) => ({ id, a1: a1[i], b1: b1[i], a2: a2[i], ...(a3 ? { a3: a3[i] } : {}) })),
    started,
    ranAt: prior?.ranAt ?? new Date(started).toISOString(),
    out: outPath,
  });
}

async function finish(x: {
  model: string;
  pairset: "widening" | "djinni";
  outputSpec: ColumnOutputType;
  draws: Draw[];
  started: number;
  ranAt: string;
  out: string;
}) {
  const set = SETS[x.pairset];
  const key = (v: unknown) => JSON.stringify(v);
  const col = (k: DrawKey) => x.draws.map((d) => (d[k] === undefined ? null : d[k]));
  const rate = (cache: unknown[], fresh: unknown[]) => {
    let n = 0;
    let k = 0;
    for (let i = 0; i < cache.length; i++) {
      if (cache[i] === null || fresh[i] === null) continue;
      n++;
      if (key(cache[i]) !== key(fresh[i])) k++;
    }
    return { usable: n, flip: n > 0 ? k / n : null };
  };
  // Pinned procedure: strata by cached value, adaptive six looks, per-stratum
  // delta/K, seeded shuffle per stratum (id-length seed as in exp8).
  const certify = async (cache: unknown[], fresh: unknown[]) => {
    const values = [...new Set(cache.filter((v) => v !== null).map(key))];
    const strata = values
      .map((v) => {
        const idx = cache.map((_, i) => i).filter((i) => cache[i] !== null && key(cache[i]) === v && fresh[i] !== null);
        const flips: number[] = idx.map((i) => (key(cache[i]) !== key(fresh[i]) ? 1 : 0));
        return { id: `v=${v}|all`, flips };
      })
      .filter((s) => s.flips.length > 0);
    const total = strata.reduce((a, s) => a + s.flips.length, 0);
    const sweeps = [];
    for (const alpha of ALPHAS) {
      let sampled = 0;
      let reused = 0;
      let reusedFlips = 0;
      let certTotal = 0;
      const certified: string[] = [];
      const perStratum: Record<string, unknown> = {};
      for (const st of strata) {
        const order = seededShuffle(st.flips.map((_, i) => i), 42 + st.id.length * 7919);
        const o = await adaptiveCertifyStratum(st.flips.length, alpha, DELTA / strata.length, async (n) => order.slice(0, n).map((i) => st.flips[i]!), 45, 6, "presented", BOUND);
        sampled += o.sampled;
        perStratum[st.id] = { size: st.flips.length, flipRate: st.flips.reduce((a, b) => a + b, 0) / st.flips.length, certified: o.certified, sampled: o.sampled, looks: o.looks };
        if (o.certified) {
          certified.push(st.id);
          const rest = order.slice(o.sampled);
          reused += rest.length;
          reusedFlips += rest.reduce((a, i) => a + st.flips[i]!, 0);
          certTotal += st.flips.length;
        }
      }
      sweeps.push({ alpha, certifiedStrata: certified, sampled, reused, realizedPresented: reused > 0 ? reusedFlips / certTotal : null, savings: total > 0 ? reused / total : 0, strata: perStratum });
    }
    return { strataCount: strata.length, sweeps };
  };

  const floor = rate(col("a1"), col("b1"));
  const pairs: Record<string, unknown> = {};
  for (const p of set.pairs) {
    const cache = col(p.cache);
    const fresh = col(p.fresh);
    pairs[p.key] = { cache: p.cache, fresh: p.fresh, ...rate(cache, fresh), ...(await certify(cache, fresh)) };
  }
  const out = {
    experiment: "exp18-families-pairs",
    model: x.model,
    pairset: x.pairset,
    outputSpec: x.outputSpec,
    ranAt: x.ranAt,
    bound: BOUND,
    n: x.draws.length,
    selfFlipFloor: floor.flip,
    usableFloor: floor.usable,
    pairs,
    draws: x.draws,
    wallMs: Date.now() - x.started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(x.out, JSON.stringify(out, null, 2));
  console.log(`${out.model} ${out.pairset} n=${out.n} floor=${out.selfFlipFloor === null ? "n/a" : (out.selfFlipFloor * 100).toFixed(2) + "%"}`);
  for (const [k, v] of Object.entries(pairs)) {
    const p = v as { flip: number | null; sweeps: Array<{ alpha: number; certifiedStrata: string[]; sampled: number; savings: number }> };
    const cells = p.sweeps
      .map((t) => `${t.alpha}:${t.certifiedStrata.length ? `${(t.savings * 100).toFixed(1)}%` : "refused"}(${t.sampled})`)
      .join(" ");
    console.log(`  ${k}: flip=${p.flip === null ? "n/a" : (p.flip * 100).toFixed(2) + "%"} ${cells}`);
  }
  console.log("EXP18_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
