/**
 * Experiment 0b: decode-noise floor for the Djinni seniority column (4-way
 * select over long CV text), at T=0. If the self-flip rate matches the
 * ~12.3% "formatting flip rate" from exp6, then column-type stability (not
 * edit semantics) is what governs certifiable reuse on this corpus.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp0b-djinni-stability.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import {
  getColumnVersion,
  listColumns,
} from "../../lib/lore/column-store";
import { bindTemplate } from "../../lib/lore/run-column";

const N = 200;
const CONCURRENCY = 32;
const SEED = 11;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const TIERS = ["Junior", "Mid", "Senior", "Lead/Principal"] as const;

const SYSTEM = `You evaluate ONE row of a data table against the user's column
instruction. Judge only from the provided row data; if the data is
insufficient, still commit to the most defensible answer.
Return a JSON object with EXACTLY two keys: "value" and "rationale"
(<= 140 chars). "value" must be exactly one of: "Junior", "Mid", "Senior", "Lead/Principal".
Example shape: {"value":"Mid","rationale":"one short sentence of evidence"}`;

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

async function judge(model: string, prompt: string): Promise<string | null> {
  try {
    const res = await generateObject({
      model,
      schema: z.object({ value: z.enum(TIERS), rationale: z.string() }),
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
  const col = (await listColumns("djinni")).find((c) =>
    c.name.includes("djinni lab"),
  )!;
  const v2 = await getColumnVersion(col.id, 2);
  if (!v2) throw new Error("v2 missing");

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [rowsRaw] = await db.query(
    `SELECT id, position, experience_years, SUBSTRING(cv, 1, 4000) AS cv
     FROM djinni_profiles WHERE cv IS NOT NULL AND position IS NOT NULL
     ORDER BY RAND(?) LIMIT ?`,
    [SEED, N],
  );
  await db.end();
  const prompts = (rowsRaw as Record<string, unknown>[]).map(
    (r) => bindTemplate(v2.prompt_template, r).text,
  );

  const a = await mapLimit(prompts, CONCURRENCY, (p) => judge(col.model, p));
  const b = await mapLimit(prompts, CONCURRENCY, (p) => judge(col.model, p));
  let valid = 0;
  let flips = 0;
  const confusion = new Map<string, number>();
  for (let i = 0; i < prompts.length; i++) {
    if (a[i] === null || b[i] === null) continue;
    valid++;
    if (a[i] !== b[i]) {
      flips++;
      const key = [a[i], b[i]].sort().join("<->");
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
  }
  const rate = flips / valid;
  console.log(
    `djinni select self-flip @T0: ${flips}/${valid} = ${(rate * 100).toFixed(2)}%`,
  );
  console.log("flip pairs:", [...confusion.entries()]);
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp0b-djinni-stability.json",
    JSON.stringify(
      {
        experiment: "exp0b-djinni-stability",
        n: valid,
        selfFlipRate: rate,
        flipPairs: [...confusion.entries()],
        note: "compare to exp6 formatting flip 12.30% and criteria flip 12.45%",
      },
      null,
      2,
    ),
  );
  console.log("EXP0B_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
