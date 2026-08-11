/**
 * The per-cell sub-agent runner: binds a column's prompt template to each
 * row, runs a typed structured-output call, and persists results with
 * caching, a cost ledger, and a pre-run estimate gate.
 *
 * Content hash covers ONLY the row fields the template actually binds — the
 * base of sIVM's cross-version reuse (an edit that adds a bound field changes
 * the hash population; an unrelated row field change does not).
 */
import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { ColumnOutputType, RunEstimate } from "@lore/core";
import {
  findCachedByHash,
  recordLedger,
  totalSpendUsd,
  writeCell,
  type AiColumn,
} from "./column-store";
import { CELL_DECODE, EXPERIMENT_BUDGET_USD, MODEL_PRICES } from "./models";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Template binding + content hash
// ---------------------------------------------------------------------------

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function templateFields(template: string): string[] {
  return [...template.matchAll(VAR_RE)].map((m) => m[1]!);
}

export function bindTemplate(
  template: string,
  row: Row,
): { text: string; contentHash: string } {
  const bound: Record<string, unknown> = {};
  const text = template.replaceAll(VAR_RE, (_, field: string) => {
    const v = row[field];
    bound[field] = v ?? null;
    if (v === null || v === undefined) return "(unknown)";
    return Array.isArray(v) ? v.join(", ") : String(v);
  });
  const contentHash = createHash("sha256")
    .update(JSON.stringify(bound))
    .digest("hex");
  return { text, contentHash };
}

// ---------------------------------------------------------------------------
// Output schema per column type (+ exact-shape example for budget models)
// ---------------------------------------------------------------------------

function valueSchema(spec: ColumnOutputType): z.ZodType {
  switch (spec.kind) {
    case "boolean":
      return z.boolean();
    case "number": {
      let n = z.number();
      if (spec.min !== undefined) n = n.min(spec.min);
      if (spec.max !== undefined) n = n.max(spec.max);
      return n;
    }
    case "select":
      return z.enum(spec.options as [string, ...string[]]);
    case "url":
      return z.string();
    case "json":
      return z.record(z.string(), z.unknown());
    case "text":
      return z.string();
  }
}

function exampleFor(spec: ColumnOutputType): string {
  const v =
    spec.kind === "boolean"
      ? "true"
      : spec.kind === "number"
        ? "7"
        : spec.kind === "select"
          ? JSON.stringify(spec.options[0])
          : '"short answer"';
  return `{"value":${v},"rationale":"one short sentence of evidence"}`;
}

function systemFor(spec: ColumnOutputType): string {
  return `You evaluate ONE row of a data table against the user's column
instruction. Judge only from the provided row data; if the data is
insufficient, still commit to the most defensible answer.
Return a JSON object with EXACTLY two keys: "value" and "rationale"
(<= 140 chars). ${
    spec.kind === "select"
      ? `"value" must be exactly one of: ${spec.options.map((o) => JSON.stringify(o)).join(", ")}.`
      : spec.kind === "boolean"
        ? `"value" must be a JSON boolean (true/false), not a string.`
        : spec.kind === "number"
          ? `"value" must be a JSON number${spec.min !== undefined || spec.max !== undefined ? ` between ${spec.min ?? "-inf"} and ${spec.max ?? "inf"}` : ""}.`
          : `"value" must be a string.`
  }
Example shape: ${exampleFor(spec)}`;
}

// ---------------------------------------------------------------------------
// Estimate + run
// ---------------------------------------------------------------------------

const EST_OVERHEAD_TOKENS = 160; // system + schema framing
const EST_OUTPUT_TOKENS = 60;

export function estimateRun(column: AiColumn, rows: Row[]): RunEstimate {
  const price = MODEL_PRICES[column.model] ?? { in: 1, out: 4 };
  let inputTokens = 0;
  for (const row of rows) {
    const { text } = bindTemplate(column.prompt_template, row);
    inputTokens += EST_OVERHEAD_TOKENS + Math.ceil(text.length / 4);
  }
  const outputTokens = rows.length * EST_OUTPUT_TOKENS;
  const estCostUsd =
    (inputTokens * price.in + outputTokens * price.out) / 1e6;
  return {
    rowCount: rows.length,
    estInputTokens: inputTokens,
    estOutputTokens: outputTokens,
    estCostUsd,
    requiresConfirmation: rows.length > 100 || estCostUsd > 0.5,
    ...(rows.length > 100 || estCostUsd > 0.5
      ? { reason: "over_absolute_threshold" as const }
      : {}),
  };
}

export interface RunResult {
  ran: number;
  cached: number;
  skipped: number;
  errors: number;
  costUsd: number;
  ms: number;
}

/** Tiny semaphore: bounded concurrency without a dependency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function runColumn(
  column: AiColumn,
  rows: Row[],
  idField: string,
  opts?: {
    concurrency?: number;
    /** Run against a specific historical version (sIVM ground truth/verify). */
    versionOverride?: { promptTemplate: string; promptVersion: number };
  },
): Promise<RunResult> {
  const started = Date.now();
  const price = MODEL_PRICES[column.model] ?? { in: 1, out: 4 };
  if (opts?.versionOverride) {
    column = {
      ...column,
      prompt_template: opts.versionOverride.promptTemplate,
      prompt_version: opts.versionOverride.promptVersion,
    };
  }

  // Budget guard: never start a run that would push total spend past the cap.
  const est = estimateRun(column, rows);
  const spent = await totalSpendUsd();
  if (spent + est.estCostUsd > EXPERIMENT_BUDGET_USD) {
    throw new Error(
      `budget guard: $${spent.toFixed(2)} spent + $${est.estCostUsd.toFixed(2)} estimated exceeds the $${EXPERIMENT_BUDGET_USD} cap`,
    );
  }

  let ran = 0;
  let cached = 0;
  let errors = 0;
  let costUsd = 0;
  let inTok = 0;
  let outTok = 0;

  await mapLimit(rows, opts?.concurrency ?? 8, async (row) => {
    const rowId = String(row[idField]);
    const { text, contentHash } = bindTemplate(column.prompt_template, row);

    const hit = await findCachedByHash(
      column.id,
      column.prompt_version,
      column.model,
      contentHash,
    );
    if (hit) {
      if (hit.row_id !== rowId) {
        await writeCell({
          columnId: column.id,
          rowId,
          promptVersion: column.prompt_version,
          model: column.model,
          contentHash,
          status: "cached",
          value: hit.value,
          rationale: hit.rationale,
        });
      }
      cached++;
      return;
    }

    const t0 = Date.now();
    try {
      const res = await generateObject({
        model: column.model,
        schema: z.object({
          value: valueSchema(column.output_spec),
          rationale: z.string(),
        }),
        system: systemFor(column.output_spec),
        prompt: text,
        temperature: CELL_DECODE.temperature,
      });
      const cellIn = res.usage.inputTokens ?? 0;
      const cellOut = res.usage.outputTokens ?? 0;
      const cellCost = (cellIn * price.in + cellOut * price.out) / 1e6;
      inTok += cellIn;
      outTok += cellOut;
      costUsd += cellCost;
      await writeCell({
        columnId: column.id,
        rowId,
        promptVersion: column.prompt_version,
        model: column.model,
        contentHash,
        status: "done",
        value: res.object.value,
        rationale: res.object.rationale.slice(0, 500),
        inputTokens: cellIn,
        outputTokens: cellOut,
        costUsd: cellCost,
        latencyMs: Date.now() - t0,
      });
      ran++;
    } catch (err) {
      errors++;
      await writeCell({
        columnId: column.id,
        rowId,
        promptVersion: column.prompt_version,
        model: column.model,
        contentHash,
        status: "error",
        error: err instanceof Error ? err.message.slice(0, 800) : String(err),
        latencyMs: Date.now() - t0,
      });
    }
  });

  await recordLedger({
    kind: "run",
    columnId: column.id,
    model: column.model,
    cells: ran,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
  });

  return {
    ran,
    cached,
    skipped: 0,
    errors,
    costUsd,
    ms: Date.now() - started,
  };
}
