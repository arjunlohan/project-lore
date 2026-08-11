/**
 * MySQL-backed store for AI columns, cells, versions, certificates, and the
 * cost ledger. Cache identity: (column_id, prompt_version, model,
 * row_content_hash) — content-identical rows share one computation.
 */
import { randomUUID } from "node:crypto";
import type { ColumnOutputType } from "@lore/core";
import mysql from "mysql2/promise";

const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

const g = globalThis as unknown as { __loreMetaPool?: mysql.Pool };
function pool(): mysql.Pool {
  g.__loreMetaPool ??= mysql.createPool({
    uri: MYSQL_URL,
    decimalNumbers: true,
    connectionLimit: 10,
  });
  return g.__loreMetaPool;
}


/** mysql2 may hand back JSON scalars pre-parsed or as raw strings. */
function parseCellValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export interface AiColumn {
  id: string;
  table_id: string;
  name: string;
  prompt_template: string;
  prompt_version: number;
  model: string;
  output_spec: ColumnOutputType;
  tool_version: number;
  auto_run_new_rows: boolean;
}

export interface AiCell {
  column_id: string;
  row_id: string;
  prompt_version: number;
  model: string;
  row_content_hash: string;
  status:
    | "pending"
    | "running"
    | "done"
    | "error"
    | "cached"
    | "reused_certified";
  value: unknown;
  rationale: string | null;
  error: string | null;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
}

function parseColumn(r: Record<string, unknown>): AiColumn {
  return {
    ...(r as unknown as AiColumn),
    output_spec:
      typeof r.output_spec === "string"
        ? (JSON.parse(r.output_spec) as ColumnOutputType)
        : (r.output_spec as ColumnOutputType),
    auto_run_new_rows: Boolean(r.auto_run_new_rows),
  };
}

export async function createColumn(input: {
  tableId: string;
  name: string;
  promptTemplate: string;
  model: string;
  outputSpec: ColumnOutputType;
}): Promise<AiColumn> {
  const id = randomUUID();
  await pool().query(
    `INSERT INTO ai_columns (id, table_id, name, prompt_template, model, output_spec)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tableId,
      input.name,
      input.promptTemplate,
      input.model,
      JSON.stringify(input.outputSpec),
    ],
  );
  await pool().query(
    `INSERT INTO ai_column_versions (column_id, version, prompt_template, model)
     VALUES (?, 1, ?, ?)`,
    [id, input.promptTemplate, input.model],
  );
  return (await getColumn(id))!;
}

export async function getColumn(id: string): Promise<AiColumn | null> {
  const [rows] = await pool().query(`SELECT * FROM ai_columns WHERE id = ?`, [
    id,
  ]);
  const r = (rows as Record<string, unknown>[])[0];
  return r ? parseColumn(r) : null;
}

export async function listColumns(tableId: string): Promise<AiColumn[]> {
  const [rows] = await pool().query(
    `SELECT * FROM ai_columns WHERE table_id = ? ORDER BY created_at`,
    [tableId],
  );
  return (rows as Record<string, unknown>[]).map(parseColumn);
}

/** Prompt (or model) edit: bump version, keep history. The sIVM trigger. */
export async function updateColumnPrompt(
  id: string,
  promptTemplate: string,
  model?: string,
): Promise<AiColumn> {
  const col = await getColumn(id);
  if (!col) throw new Error(`column ${id} not found`);
  const next = col.prompt_version + 1;
  const nextModel = model ?? col.model;
  await pool().query(
    `UPDATE ai_columns SET prompt_template = ?, model = ?, prompt_version = ? WHERE id = ?`,
    [promptTemplate, nextModel, next, id],
  );
  await pool().query(
    `INSERT INTO ai_column_versions (column_id, version, prompt_template, model)
     VALUES (?, ?, ?, ?)`,
    [id, next, promptTemplate, nextModel],
  );
  return (await getColumn(id))!;
}

export async function getColumnVersion(
  columnId: string,
  version: number,
): Promise<{ prompt_template: string; model: string } | null> {
  const [rows] = await pool().query(
    `SELECT prompt_template, model FROM ai_column_versions WHERE column_id = ? AND version = ?`,
    [columnId, version],
  );
  return (
    (rows as Array<{ prompt_template: string; model: string }>)[0] ?? null
  );
}

/** Cells for a SPECIFIC version (sIVM works across versions). */
export async function getCellsForVersion(
  columnId: string,
  version: number,
  rowIds?: string[],
): Promise<AiCell[]> {
  const rowFilter =
    rowIds && rowIds.length > 0
      ? ` AND row_id IN (${rowIds.map(() => "?").join(",")})`
      : "";
  const [rows] = await pool().query(
    `SELECT * FROM ai_cells WHERE column_id = ? AND prompt_version = ?${rowFilter}`,
    [columnId, version, ...(rowIds ?? [])],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as AiCell),
    value: parseCellValue(r.value),
  }));
}

export async function saveCertificate(cert: {
  id: string;
  columnId: string;
  fromVersion: number;
  toVersion: number;
  alpha: number;
  delta: unknown;
  strata: unknown;
  reusedCount: number;
  recomputeCount: number;
  sampledCount: number;
  verificationCostUsd: number;
}): Promise<void> {
  await pool().query(
    `INSERT INTO reuse_certificates
       (id, column_id, from_version, to_version, alpha, delta, strata,
        reused_count, recompute_count, sampled_count, verification_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cert.id,
      cert.columnId,
      cert.fromVersion,
      cert.toVersion,
      cert.alpha,
      JSON.stringify(cert.delta),
      JSON.stringify(cert.strata),
      cert.reusedCount,
      cert.recomputeCount,
      cert.sampledCount,
      cert.verificationCostUsd,
    ],
  );
}

/** Copy certified-reused values from one version into another. */
export async function applyCertificateReuse(
  columnId: string,
  fromVersion: number,
  toVersion: number,
  model: string,
  rowIds: string[],
  certificateId: string,
): Promise<number> {
  if (rowIds.length === 0) return 0;
  const marks = rowIds.map(() => "?").join(",");
  const [res] = await pool().query(
    `INSERT INTO ai_cells
       (column_id, row_id, prompt_version, model, row_content_hash, status,
        value, rationale, certificate_id)
     SELECT src.column_id, src.row_id, ?, ?, src.row_content_hash,
            'reused_certified', src.value, src.rationale, ?
     FROM ai_cells src
     LEFT JOIN ai_cells tgt
       ON tgt.column_id = src.column_id AND tgt.row_id = src.row_id
      AND tgt.prompt_version = ?
     WHERE src.column_id = ? AND src.prompt_version = ?
       AND src.row_id IN (${marks})
       AND src.status IN ('done','cached')
       -- A certificate never clobbers an authoritative value: rows whose
       -- target version already holds a cell are left untouched, so a
       -- freshly computed value always wins over a reused stale one.
       AND tgt.row_id IS NULL`,
    [toVersion, model, certificateId, toVersion, columnId, fromVersion, ...rowIds],
  );
  return (res as { affectedRows: number }).affectedRows;
}

export async function getCells(
  columnIds: string[],
  rowIds: string[],
): Promise<AiCell[]> {
  if (columnIds.length === 0 || rowIds.length === 0) return [];
  const [rows] = await pool().query(
    `SELECT c.* FROM ai_cells c
     JOIN ai_columns col ON col.id = c.column_id AND col.prompt_version = c.prompt_version
     WHERE c.column_id IN (${columnIds.map(() => "?").join(",")})
       AND c.row_id IN (${rowIds.map(() => "?").join(",")})`,
    [...columnIds, ...rowIds],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as AiCell),
    value: parseCellValue(r.value),
  }));
}

/** Cache probe: any DONE cell with the same content identity, any row. */
export async function findCachedByHash(
  columnId: string,
  promptVersion: number,
  model: string,
  contentHash: string,
): Promise<AiCell | null> {
  const [rows] = await pool().query(
    `SELECT * FROM ai_cells
     WHERE column_id = ? AND prompt_version = ? AND model = ?
       AND row_content_hash = ? AND status IN ('done','cached')
     LIMIT 1`,
    [columnId, promptVersion, model, contentHash],
  );
  const r = (rows as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    ...(r as unknown as AiCell),
    value: parseCellValue(r.value),
  };
}

export async function writeCell(cell: {
  columnId: string;
  rowId: string;
  promptVersion: number;
  model: string;
  contentHash: string;
  status: AiCell["status"];
  value?: unknown;
  rationale?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}): Promise<void> {
  await pool().query(
    `INSERT INTO ai_cells
       (column_id, row_id, prompt_version, model, row_content_hash, status,
        value, rationale, error, attempts, input_tokens, output_tokens, cost_usd, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), value = VALUES(value), rationale = VALUES(rationale),
       error = VALUES(error), attempts = attempts + 1, model = VALUES(model),
       row_content_hash = VALUES(row_content_hash),
       input_tokens = input_tokens + VALUES(input_tokens),
       output_tokens = output_tokens + VALUES(output_tokens),
       cost_usd = cost_usd + VALUES(cost_usd), latency_ms = VALUES(latency_ms)`,
    [
      cell.columnId,
      cell.rowId,
      cell.promptVersion,
      cell.model,
      cell.contentHash,
      cell.status,
      cell.value === undefined ? null : JSON.stringify(cell.value),
      cell.rationale ?? null,
      cell.error ?? null,
      cell.inputTokens ?? 0,
      cell.outputTokens ?? 0,
      cell.costUsd ?? 0,
      cell.latencyMs ?? null,
    ],
  );
}

export async function recordLedger(entry: {
  kind: "run" | "estimate_confirmed" | "verify" | "compile";
  columnId?: string;
  model: string;
  cells: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): Promise<void> {
  await pool().query(
    `INSERT INTO cost_ledger (kind, column_id, model, cells, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.kind,
      entry.columnId ?? null,
      entry.model,
      entry.cells,
      entry.inputTokens,
      entry.outputTokens,
      entry.costUsd,
    ],
  );
}

export async function totalSpendUsd(): Promise<number> {
  const [rows] = await pool().query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM cost_ledger`,
  );
  return Number((rows as Array<{ s: number }>)[0]?.s ?? 0);
}
