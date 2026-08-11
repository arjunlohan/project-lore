/**
 * Experiment 10 (review r1 mandatory): multi-draw oracle labels. Three
 * independent draws per cell per version for the SO formatting pair
 * (lab v1 -> v2), giving (a) majority-vote flip labels that de-noise the
 * ground truth, (b) a direct measurement of label noise's effect on every
 * downstream quantity (flip rate, certifiable savings, realized FR).
 *
 * Labels are stored in a JSON artifact (not ai_cells).
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp10-multidraw.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate } from "../../lib/lore/run-column";

const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const SEED = 42;
const DRAWS = 3;
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
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

async function draw(model: string, prompt: string): Promise<boolean | null> {
  try {
    const res = await generateObject({
      model,
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
    `SELECT * FROM profiles ORDER BY RAND(?) LIMIT 2000`,
    [SEED],
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

  // Existing single-draw labels for comparison.
  const rowIds = rows.map((r) => String(r[PROFILE_ID_FIELD]));
  const single1 = new Map(
    (await getCellsForVersion(lab.id, 1, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );
  const single2 = new Map(
    (await getCellsForVersion(lab.id, 2, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );

  const perRow = await mapLimit(rows, CONCURRENCY, async (r) => {
    const id = String(r[PROFILE_ID_FIELD]);
    const p1 = bindTemplate(v1.prompt_template, r).text;
    const p2 = bindTemplate(v2.prompt_template, r).text;
    const d1: Array<boolean | null> = [];
    const d2: Array<boolean | null> = [];
    for (let k = 0; k < DRAWS; k++) {
      const [a, b] = await Promise.all([
        draw(lab.model, p1),
        draw(lab.model, p2),
      ]);
      d1.push(a);
      d2.push(b);
    }
    return { id, d1, d2 };
  });

  const maj = (ds: Array<boolean | null>): boolean | null => {
    const v = ds.filter((x): x is boolean => x !== null);
    if (v.length === 0) return null;
    return v.filter(Boolean).length * 2 > v.length;
  };

  let usable = 0;
  let singleFlips = 0;
  let voteFlips = 0;
  let disagreeSingleVote = 0;
  const labels: Record<
    string,
    { d1: Array<boolean | null>; d2: Array<boolean | null> }
  > = {};
  for (const pr of perRow) {
    const m1 = maj(pr.d1);
    const m2 = maj(pr.d2);
    labels[pr.id] = { d1: pr.d1, d2: pr.d2 };
    const s1 = single1.get(pr.id);
    const s2 = single2.get(pr.id);
    if (m1 === null || m2 === null || s1 === undefined || s2 === undefined)
      continue;
    usable++;
    const sf = s1 !== s2 ? 1 : 0;
    const vf = m1 !== m2 ? 1 : 0;
    singleFlips += sf;
    voteFlips += vf;
    if (sf !== vf) disagreeSingleVote++;
  }

  const out = {
    experiment: "exp10-multidraw",
    pair: "SO formatting (lab v1->v2)",
    draws: DRAWS,
    n: usable,
    singleDrawFlipRate: singleFlips / usable,
    vote3FlipRate: voteFlips / usable,
    labelDisagreementRate: disagreeSingleVote / usable,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp10-multidraw.json",
    JSON.stringify(out, null, 2),
  );
  writeFileSync(
    "docs/research/experiments/exp10-labels.json",
    JSON.stringify(labels),
  );
  console.log(JSON.stringify(out, null, 2));
  console.log("EXP10_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
