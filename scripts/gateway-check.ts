/**
 * One-shot AI Gateway sanity check: a single tiny structured call on the
 * default model, printing token usage and estimated cost. Never prints env.
 *
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/gateway-check.ts
 */
import { generateText } from "ai";
import { DEFAULT_MODEL, MODEL_PRICES } from "../lib/lore/models";

async function main() {
  const started = Date.now();
  const res = await generateText({
    model: DEFAULT_MODEL,
    prompt:
      "Reply with exactly the word: ok",
  });
  const usage = res.usage;
  const price = MODEL_PRICES[DEFAULT_MODEL]!;
  const cost =
    ((usage.inputTokens ?? 0) * price.in +
      (usage.outputTokens ?? 0) * price.out) /
    1_000_000;
  console.log(
    JSON.stringify({
      model: DEFAULT_MODEL,
      text: res.text.slice(0, 40),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estCostUsd: Number(cost.toFixed(6)),
      ms: Date.now() - started,
    }),
  );
}

main().catch((err) => {
  console.error("GATEWAY_CHECK_FAILED:", err?.message ?? err);
  process.exit(1);
});
