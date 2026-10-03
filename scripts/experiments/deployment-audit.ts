/**
 * The deployment audits, recomputed from released files alone.
 *
 * Shared by exp11b-verify.ts (offline mode), export-deployment-audit-cells.ts
 * (which writes the cells and checks them), and the paper's generator (which
 * checks them on every run). An audit compares, for every reused row that
 * holds an oracle-computed cell of the target version, the cached v1 value
 * with that cell; its "released" figure restricts the same rows to the
 * released n=2,000 evaluation vector.
 */
import { readFileSync } from "node:fs";

/** Every deployment artifact whose audit the paper prints, with the version
 * its oracle cells belong to (v2: August snapshot; v4: September). */
export const AUDIT_SOURCES: Array<{ file: string; toVersion: 2 | 4 }> = [
  { file: "exp11-fullscale.json", toVersion: 2 },
  { file: "exp11c-deployment-bounds.json", toVersion: 2 },
  { file: "exp11c-deployment-bounds-v4.json", toVersion: 4 },
];

export type AuditCells = {
  artifact: string;
  note: string;
  column: string;
  rows: Array<{ id: string; v1: unknown; v2: unknown; v4: unknown }>;
};

type RecordedAudit = {
  source: string;
  bound: string;
  alpha: number;
  auditedRowsAll: number;
  flipsAll: number;
  auditedRows: number;
  flips: number;
};

/**
 * Recompute every audit from `cells` and the persisted row identifiers of the
 * source artifacts, and compare it with the audits exp11b-verify.json
 * recorded from the database. Throws on any disagreement; returns the number
 * of audits reproduced.
 */
export function recomputeAudits(
  cells: AuditCells,
  recorded: { audits: RecordedAudit[] },
  dir: string,
): number {
  const present = (v: unknown) => v !== null && v !== undefined;
  const v1 = new Map(cells.rows.filter((r) => present(r.v1)).map((r) => [r.id, r.v1]));
  const oracle = {
    2: new Map(cells.rows.filter((r) => present(r.v2)).map((r) => [r.id, r.v2])),
    4: new Map(cells.rows.filter((r) => present(r.v4)).map((r) => [r.id, r.v4])),
  } as const;
  const labels = JSON.parse(readFileSync(`${dir}/benchmark-labels.json`, "utf8")) as {
    pairs: Array<{ key: string; rowIds: string[] }>;
  };
  const vector = labels.pairs.find((p) => p.key === "so-formatting");
  if (!vector) throw new Error("benchmark-labels.json has no so-formatting pair");
  const released = new Set(vector.rowIds.map(String));

  let i = 0;
  for (const source of AUDIT_SOURCES) {
    const artifact = JSON.parse(readFileSync(`${dir}/${source.file}`, "utf8")) as {
      sweeps: Array<{ bound?: string; alpha: number; status?: string; auditedRowIds?: string[] }>;
    };
    const target = oracle[source.toVersion];
    for (const sweep of artifact.sweeps) {
      if (sweep.status !== undefined && sweep.status !== "ok") continue;
      const persisted = (sweep.auditedRowIds ?? []).map(String);
      if (persisted.length === 0) continue;
      const flipsIn = (ids: string[]) =>
        ids.filter((id) => JSON.stringify(v1.get(id)) !== JSON.stringify(target.get(id))).length;
      const all = persisted.filter((id) => target.has(id));
      const rel = all.filter((id) => released.has(id));
      const got = { auditedRowsAll: all.length, flipsAll: flipsIn(all), auditedRows: rel.length, flips: flipsIn(rel) };
      const want = recorded.audits[i];
      if (
        !want ||
        want.source !== source.file ||
        want.bound !== (sweep.bound ?? "eb") ||
        Math.abs(want.alpha - sweep.alpha) > 1e-9 ||
        want.auditedRowsAll !== got.auditedRowsAll ||
        want.flipsAll !== got.flipsAll ||
        want.auditedRows !== got.auditedRows ||
        want.flips !== got.flips
      ) {
        throw new Error(
          `${source.file} ${sweep.bound ?? "eb"}@${sweep.alpha}: the released cells give ${got.flipsAll}/${got.auditedRowsAll} (released vector ${got.flips}/${got.auditedRows}), exp11b-verify.json records ${want ? `${want.flipsAll}/${want.auditedRowsAll} (${want.flips}/${want.auditedRows})` : "no audit here"}`,
        );
      }
      i++;
    }
  }
  if (i !== recorded.audits.length) {
    throw new Error(`reproduced ${i} audits, exp11b-verify.json records ${recorded.audits.length}`);
  }
  return i;
}
