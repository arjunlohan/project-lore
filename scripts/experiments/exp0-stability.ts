/**
 * Experiment 0: decode-noise floor. Same prompt (column v2), same rows, two
 * independent replicates, at default temperature and at T=0. Self-flip rate
 * = P(replicate disagrees with itself). This separates EDIT-caused flips
 * from sampling noise in every other experiment, and justifies pinning T=0
 * in certificates.
 *
 * No cells are persisted; calls go straight to the model.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp0-stability.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import { getColumnVersion, listColumns } from "../../lib/lore/column-store";
import { MODEL_PRICES } from "../../lib/lore/models";
import { bindTemplate } from "../../lib/lore/run-column";

const N = Number(process.env.EXP_ROWS ?? 200);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const SEED = 43; // different draw than exp1
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
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function judge(
  model: string,
  prompt: string,
  temperature: number | undefined,
): Promise<boolean | null> {
  try {
    const res = await generateObject({
      model,
      schema: z.object({ value: z.boolean(), rationale: z.string() }),
      system: SYSTEM,
      prompt,
      ...(temperature === undefined ? {} : { temperature }),
    });
    return res.object.value;
  } catch {
    return null;
  }
}

async function main() {
  const started = Date.now();
  const columns = await listColumns("profiles");
  const column = columns.find((c) => c.name.startsWith("Data-platform"))!;
  const v2 = await getColumnVersion(column.id, 2);
  if (!v2) throw new Error("v2 missing");

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
  const prompts = rows.map(
    (r) => bindTemplate(v2.prompt_template, r).text,
  );

  const regimes: Array<{ name: string; temperature: number | undefined }> = [
    { name: "default-T", temperature: undefined },
    { name: "T0", temperature: 0 },
  ];

  const out: Record<string, unknown> = {};
  let calls = 0;
  for (const regime of regimes) {
    const a = await mapLimit(prompts, CONCURRENCY, (p) =>
      judge(column.model, p, regime.temperature),
    );
    const b = await mapLimit(prompts, CONCURRENCY, (p) =>
      judge(column.model, p, regime.temperature),
    );
    calls += 2 * prompts.length;
    let valid = 0;
    let selfFlips = 0;
    let positives = 0;
    let posFlips = 0;
    for (let i = 0; i < prompts.length; i++) {
      if (a[i] === null || b[i] === null) continue;
      valid++;
      if (a[i] !== b[i]) selfFlips++;
      if (a[i] === true || b[i] === true) {
        positives++;
        if (a[i] !== b[i]) posFlips++;
      }
    }
    const summary = {
      valid,
      selfFlipRate: selfFlips / valid,
      positiveInvolvedPairs: positives,
      positivePairFlipRate: positives > 0 ? posFlips / positives : 0,
    };
    out[regime.name] = summary;
    console.log(
      `${regime.name}: self-flip ${(summary.selfFlipRate * 100).toFixed(2)}% over ${valid} rows; among pairs touching TRUE: ${(summary.positivePairFlipRate * 100).toFixed(1)}% (${positives} pairs)`,
    );
  }

  const price = MODEL_PRICES[column.model]!;
  const result = {
    experiment: "exp0-stability",
    model: column.model,
    prompt: "v2",
    n: N,
    seed: SEED,
    regimes: out,
    approxCalls: calls,
    approxCostUsd: (calls * (250 * price.in + 220 * price.out)) / 1e6,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(
    "docs/research/experiments/exp0-stability.json",
    JSON.stringify(result, null, 2),
  );
  console.log("EXP0_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
