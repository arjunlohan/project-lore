/**
 * Experiment 4: self-consistency (vote-of-3) stabilization of the minority
 * stratum. exp2 showed cached-TRUE cells flip ~36% under a formatting-only
 * edit at T=0, while exp0 showed TRUE-touching pairs self-flip 33% with NO
 * edit: the stratum's instability is mostly oracle noise. If so, majority-
 * of-3 values on BOTH sides should collapse the flip rate toward the true
 * edit effect and make the stratum certifiable.
 *
 * Scope: lab column, formatting pair (v1 -> v2), rows whose stored v1 value
 * is TRUE (the unstable stratum). 3 votes x 2 versions x ~186 rows.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp4-vote3.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import { ebUpperBound } from "@lore/core/sivm";
import {
  getCellsForVersion,
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate } from "../../lib/lore/run-column";

const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const SEED = 42;
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

async function vote3(
  model: string,
  prompt: string,
): Promise<boolean | null> {
  const votes: boolean[] = [];
  for (let k = 0; k < 3; k++) {
    try {
      const res = await generateObject({
        model,
        schema: z.object({ value: z.boolean(), rationale: z.string() }),
        system: SYSTEM,
        prompt,
        temperature: 0,
      });
      votes.push(res.object.value);
    } catch {
      /* skip failed vote */
    }
  }
  if (votes.length === 0) return null;
  const yes = votes.filter(Boolean).length;
  return yes * 2 > votes.length;
}

async function main() {
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) =>
    c.name.includes("(lab)"),
  )!;
  const v1 = await getColumnVersion(lab.id, 1);
  const v2 = await getColumnVersion(lab.id, 2);
  if (!v1 || !v2) throw new Error("lab versions missing");

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
  const rowIds = rows.map((r) => String(r[PROFILE_ID_FIELD]));

  const v1cells = new Map(
    (await getCellsForVersion(lab.id, 1, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );
  const v2cells = new Map(
    (await getCellsForVersion(lab.id, 2, rowIds)).map((c) => [
      c.row_id,
      c.value,
    ]),
  );

  const trueRows = rows.filter(
    (r) => v1cells.get(String(r[PROFILE_ID_FIELD])) === true,
  );
  console.log(`TRUE stratum size: ${trueRows.length}`);

  // Single-shot flip rate on the full stratum (from stored GT).
  const singleFlips = trueRows.filter(
    (r) =>
      v1cells.get(String(r[PROFILE_ID_FIELD])) !==
      v2cells.get(String(r[PROFILE_ID_FIELD])),
  ).length;
  console.log(
    `single-shot flip rate: ${singleFlips}/${trueRows.length} = ${((singleFlips / trueRows.length) * 100).toFixed(1)}%`,
  );

  // Vote-of-3 on both versions.
  const stable = await mapLimit(trueRows, CONCURRENCY, async (r) => {
    const p1 = bindTemplate(v1.prompt_template, r).text;
    const p2 = bindTemplate(v2.prompt_template, r).text;
    const [a, b] = await Promise.all([
      vote3(lab.model, p1),
      vote3(lab.model, p2),
    ]);
    return { id: String(r[PROFILE_ID_FIELD]), a, b };
  });

  const valid = stable.filter((s) => s.a !== null && s.b !== null);
  const voteFlips = valid.filter((s) => s.a !== s.b).length;
  const voteFlipRate = voteFlips / valid.length;
  // Also: how many single-shot v1 TRUE values did vote-3 confirm as TRUE?
  const v1Confirmed = valid.filter((s) => s.a === true).length;
  console.log(
    `vote-3 flip rate: ${voteFlips}/${valid.length} = ${(voteFlipRate * 100).toFixed(1)}%`,
  );
  console.log(
    `vote-3 confirms stored v1 TRUE: ${v1Confirmed}/${valid.length} = ${((v1Confirmed / valid.length) * 100).toFixed(1)}% (the rest were single-shot noise draws)`,
  );

  // Would the stratum certify on vote-3 values? Full census, so report the
  // exact rate and the EB bound a sampler would see at n = stratum size.
  const flipsArr = valid.map((s) => (s.a !== s.b ? 1 : 0));
  const upperFull = ebUpperBound(flipsArr, 0.05);
  console.log(
    `EB upper bound on vote-3 flip rate (delta=0.05, n=${valid.length}): ${upperFull.toFixed(3)}`,
  );

  const out = {
    experiment: "exp4-vote3",
    column: "lab formatting pair v1->v2",
    stratum: "cached TRUE",
    n: trueRows.length,
    validPairs: valid.length,
    singleShotFlipRate: singleFlips / trueRows.length,
    vote3FlipRate: voteFlipRate,
    vote3ConfirmsStoredTrue: v1Confirmed / valid.length,
    ebUpperAtDelta05: upperFull,
    certifiableAt: {
      alpha01: upperFull <= 0.1,
      alpha02: upperFull <= 0.2,
    },
    approxCalls: valid.length * 6,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp4-vote3.json",
    JSON.stringify(out, null, 2),
  );
  console.log("EXP4_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
