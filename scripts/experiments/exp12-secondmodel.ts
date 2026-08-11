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

  // Pinned procedure: value strata, adaptive 6 looks.
  const strata = [true, false].map((val) => {
    const ids = rows
      .map((_, i) => i)
      .filter((i) => cache[i] === val && a2[i] !== null);
    return {
      id: `v=${val}`,
      flips: ids.map((i) => (cache[i] !== a2[i] ? 1 : 0)),
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
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp12-secondmodel.json",
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2));
  console.log("EXP12_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
