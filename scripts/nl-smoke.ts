/**
 * NL->FilterSpec smoke test: compile three recruiter-style queries, execute
 * each on BOTH adapters, and show filter + counts + cost.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/nl-smoke.ts
 */
import { adapterFor } from "../lib/lore/adapters";
import { compileQuery } from "../lib/lore/compile-query";
import { MODEL_PRICES, DEFAULT_MODEL } from "../lib/lore/models";
import { mysqlAdapter } from "../lib/lore/adapters";

const QUERIES = [
  "senior Rust developers in Germany or France making over $100k",
  "students who know Python but not Java",
  "remote data scientists with 3 to 8 years of professional experience using PostgreSQL",
];

async function main() {
  const price = MODEL_PRICES[DEFAULT_MODEL]!;
  for (const q of QUERIES) {
    const t0 = Date.now();
    const { filter, unmapped, usage } = await compileQuery(q);
    const compileMs = Date.now() - t0;
    const [esCount, myCount] = await Promise.all([
      adapterFor("elasticsearch").count(filter),
      adapterFor("mysql").count(filter),
    ]);
    const cost =
      (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1e6;
    console.log(`\nQ: ${q}`);
    console.log(`  all: ${JSON.stringify(filter.all)}`);
    if (filter.any) console.log(`  any: ${JSON.stringify(filter.any)}`);
    if (unmapped.length > 0) console.log(`  unmapped: ${JSON.stringify(unmapped)}`);
    console.log(
      `  counts: es=${esCount} mysql=${myCount} ${esCount === myCount ? "MATCH" : "MISMATCH"} | compile ${compileMs}ms, ~$${cost.toFixed(5)}`,
    );
  }
  await mysqlAdapter().close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
