/**
 * Experiment 12 (review r5, external validity): do the paper's qualitative
 * findings survive a different model family?
 *
 * Replicates the three load-bearing measurements on a second model over a
 * 500-row subsample of the canonical evaluation vector:
 *   1. self-flip floor (within-version draw pairs at T=0),
 *   2. formatting-edit flip rate (v1 vs v2),
 *   3. certification outcome at alpha in {0.1, 0.2} under the pinned
 *      value-stratified adaptive procedure.
 *
 * The claim under test is NOT that numbers match, but that the STRUCTURE
 * holds: a measurable floor, formatting flips near it, and certification
 * that tracks the floor rather than the edit's label.
 *
 * Run: set -a; source .env.local; set +a; EXP_MODEL=<gateway-model> \
 *      pnpm tsx scripts/experiments/exp12-secondmodel.ts
 *
 * IEEE Access revision (2026-08-15): the paper's positive results all rode on
 * one model, so this now also runs in the POSITIVE direction on a family
 * stable enough to certify. Two additions, both opt-in so the original
 * gpt-5-nano artifact and its macros are untouched:
 *   EXP_SYNONYM=1  also draws v3 (synonym rewording) so the second family
 *                  replicates the edit-class comparison, not only the
 *                  formatting pair;
 *   EXP_DECOMPOSE=1 also draws the two components of the formatting edit
 *                  separately (case-only: v1 with "OR" lowercased;
 *                  whitespace-only: v2 with "OR" restored), so a family that
 *                  flips on the composite edit can be asked WHICH surface
 *                  change it reacts to;
 *   EXP_OUT=<file> output path; defaults to exp12-secondmodel-<model>.json
 *                  for any model other than the original gpt-5-nano, so a
 *                  rerun can never overwrite the artifact the paper cites.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import { adaptiveCertifyStratum, seededShuffle } from "@lore/core/sivm";
import { getColumnVersion, listColumns } from "../../lib/lore/column-store";
import { bindTemplate } from "../../lib/lore/run-column";

const MODEL = process.env.EXP_MODEL ?? "openai/gpt-5-nano";
const N = Number(process.env.EXP_ROWS ?? 500);
const WITH_SYNONYM = process.env.EXP_SYNONYM === "1";
const DECOMPOSE = process.env.EXP_DECOMPOSE === "1";
const OUT =
  process.env.EXP_OUT ??
  (MODEL === "openai/gpt-5-nano"
    ? "docs/research/experiments/exp12-secondmodel.json"
    : `docs/research/experiments/exp12-secondmodel-${MODEL.replace(/[^a-z0-9.]+/gi, "-")}.json`);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 24);
const SEED = 42;
const DELTA = 0.1;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

type Row = Record<string, unknown>;

const SYSTEM = `You evaluate ONE row of a data table against the user's column
instruction. Judge only from the provided row data; if the data is
insufficient, still commit to the most defensible answer.
Return a JSON object with EXACTLY two keys: "value" and "rationale"
(<= 140 chars). "value" must be a JSON boolean (true/false), not a string.
Example shape: {"value":true,"rationale":"one short sentence of evidence"}`;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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

async function judge(prompt: string): Promise<boolean | null> {
  try {
    const res = await generateObject({
      model: MODEL,
      schema: z.object({ value: z.boolean(), rationale: z.string() }),
      system: SYSTEM,
      prompt,
      temperature: 0,
    });
    return res.object.value;
  } catch {
    return null;
  }
}

async function main() {
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) =>
    c.name.includes("(lab)"),
  )!;
  const v1 = await getColumnVersion(lab.id, 1);
  const v2 = await getColumnVersion(lab.id, 2);
  if (!v1 || !v2) throw new Error("versions missing");
  const v3 = WITH_SYNONYM ? await getColumnVersion(lab.id, 3) : null;
  if (WITH_SYNONYM && !v3) throw new Error("v3 (synonym) missing");

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`,
    [SEED, N],
  );
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

  // Two draws of v1 (floor) and one draw of v2 (edit effect).
  const p1 = rows.map((r) => bindTemplate(v1.prompt_template, r).text);
  const p2 = rows.map((r) => bindTemplate(v2.prompt_template, r).text);
  const a1 = await mapLimit(p1, CONCURRENCY, judge);
  const b1 = await mapLimit(p1, CONCURRENCY, judge);
  const a2 = await mapLimit(p2, CONCURRENCY, judge);
  const p3 = v3 ? rows.map((r) => bindTemplate(v3.prompt_template, r).text) : [];
  const a3 = v3 ? await mapLimit(p3, CONCURRENCY, judge) : [];
  // Decomposition of the formatting edit into its two surface components.
  // Guarded so the derivation cannot silently no-op if the templates change.
  let a4: Array<boolean | null> = [];
  let a5: Array<boolean | null> = [];
  if (DECOMPOSE) {
    const caseOnly = v1.prompt_template.replace(" OR heavy", " or heavy");
    const spaceOnly = v2.prompt_template.replace(" or heavy", " OR heavy");
    if (caseOnly === v1.prompt_template || spaceOnly === v2.prompt_template) {
      throw new Error("decomposition anchors not found in v1/v2 templates");
    }
    a4 = await mapLimit(rows.map((r) => bindTemplate(caseOnly, r).text), CONCURRENCY, judge);
    a5 = await mapLimit(rows.map((r) => bindTemplate(spaceOnly, r).text), CONCURRENCY, judge);
  }

  let floorN = 0;
  let floorFlips = 0;
  let editN = 0;
  let editFlips = 0;
  const cache: Array<boolean | null> = a1;
  const flipLabels: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (a1[i] !== null && b1[i] !== null) {
      floorN++;
      if (a1[i] !== b1[i]) floorFlips++;
    }
    if (a1[i] !== null && a2[i] !== null) {
      editN++;
      if (a1[i] !== a2[i]) editFlips++;
    }
  }
  const floor = floorFlips / floorN;
  const editFlip = editFlips / editN;

  // Pinned procedure: value strata, adaptive 6 looks. Runs per edit pair.
  const certify = async (fresh: Array<boolean | null>) => {
  const strata = [true, false].map((val) => {
    const ids = rows
      .map((_, i) => i)
      .filter((i) => cache[i] === val && fresh[i] !== null);
    return {
      id: `v=${val}`,
      flips: ids.map((i) => (cache[i] !== fresh[i] ? 1 : 0)),
    };
  });
  const sweeps = [];
  for (const alpha of [0.1, 0.2]) {
    const perStratum = DELTA / strata.length;
    let sampled = 0;
    let reused = 0;
    let reusedFlips = 0;
    const certified: string[] = [];
    for (const st of strata) {
      if (st.flips.length === 0) continue;
      const order = seededShuffle(
        st.flips.map((_, i) => i),
        SEED,
      );
      const o = await adaptiveCertifyStratum(
        st.flips.length,
        alpha,
        perStratum,
        async (n) => order.slice(0, n).map((i) => st.flips[i]!),
        45,
        6,
      );
      sampled += o.sampled;
      if (o.certified) {
        certified.push(st.id);
        const rest = order.slice(o.sampled);
        reused += rest.length;
        reusedFlips += rest.reduce((acc, i) => acc + st.flips[i]!, 0);
      }
    }
    const total = strata.reduce((a, s) => a + s.flips.length, 0);
    sweeps.push({
      alpha,
      certifiedStrata: certified,
      sampled,
      reused,
      realizedPresented:
        reused > 0
          ? reusedFlips /
            strata
              .filter((s) => certified.includes(s.id))
              .reduce((a, s) => a + s.flips.length, 0)
          : null,
      savings: total > 0 ? reused / total : 0,
    });
    flipLabels.length = 0;
  }
  return sweeps;
  };
  const sweeps = await certify(a2);
  const flipRate = (fresh: Array<boolean | null>) => {
    let n = 0;
    let flips = 0;
    for (let i = 0; i < rows.length; i++) {
      if (a1[i] !== null && fresh[i] !== null) {
        n++;
        if (a1[i] !== fresh[i]) flips++;
      }
    }
    return { usableEdit: n, flip: n > 0 ? flips / n : null };
  };
  let decomposition: Record<string, unknown> | null = null;
  if (DECOMPOSE) {
    const c = flipRate(a4);
    const w = flipRate(a5);
    decomposition = {
      caseOnly: { ...c, sweeps: await certify(a4) },
      whitespaceOnly: { ...w, sweeps: await certify(a5) },
    };
  }
  let synonym: Record<string, unknown> | null = null;
  if (v3) {
    let n = 0;
    let flips = 0;
    for (let i = 0; i < rows.length; i++) {
      if (a1[i] !== null && a3[i] !== null) {
        n++;
        if (a1[i] !== a3[i]) flips++;
      }
    }
    synonym = {
      usableEdit: n,
      synonymEditFlip: flips / n,
      sweeps: await certify(a3),
    };
  }

  const out = {
    experiment: "exp12-secondmodel",
    model: MODEL,
    n: rows.length,
    usableFloor: floorN,
    usableEdit: editN,
    selfFlipFloor: floor,
    formattingEditFlip: editFlip,
    floorDominated: editFlip < 2 * floor,
    sweeps,
    ...(synonym ? { synonym } : {}),
    ...(decomposition ? { decomposition } : {}),
    // Per-row draws (v1 draw 1, v1 draw 2, v2, v3), so flip DIRECTION is
    // analyzable after the fact: a formatting edit that shifts the model's
    // decision threshold flips one way; noise flips both ways.
    draws: rows.map((r, i) => ({
      id: (r as { response_id?: unknown }).response_id ?? i,
      a1: a1[i],
      b1: b1[i],
      a2: a2[i],
      ...(v3 ? { a3: a3[i] } : {}),
      ...(DECOMPOSE ? { a4: a4[i], a5: a5[i] } : {}),
    })),
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("EXP12_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
