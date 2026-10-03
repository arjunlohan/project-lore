/**
 * Release the cells behind the deployment audits.
 *
 * The deployment audits (exp11b-verify.json; Table 9 and Appendix C) compare
 * the cached v1 value of every reused row that also holds an oracle-computed
 * cell of the target version (v2 for the August snapshot, v4 for September).
 * Most of those rows are in the released evaluation vector or in exp16's
 * stored draws; the rest existed only in the system's database, so a reader
 * could rebuild the audits on the released vector but not the full audits
 * the manuscript prints. This script writes, for every row any printed audit
 * reads, the three values the audit compares: the cached v1 value and the
 * oracle-computed v2 and v4 values (status done or cached only, never a
 * certificate copy), null where the row holds no such cell.
 *
 * It then recomputes every audit from the written artifact alone and stops if
 * one disagrees with exp11b-verify.json, so the release is known to carry
 * the audits. `EXP_CELLS=docs/research/experiments/deployment-audit-cells.json
 * pnpm tsx scripts/experiments/exp11b-verify.ts` repeats that check without a
 * database.
 *
 * Zero API cost (reads stored cells only; writes no cell or ledger row).
 *
 * Run: pnpm tsx scripts/experiments/export-deployment-audit-cells.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getCellsForVersion, listColumns } from "../../lib/lore/column-store";
import { AUDIT_SOURCES, recomputeAudits, type AuditCells } from "./deployment-audit";

const DIR = "docs/research/experiments";
const OUT = `${DIR}/deployment-audit-cells.json`;

async function main() {
  const lab = (await listColumns("profiles")).find((c) => c.name.includes("(lab)"));
  if (!lab) throw new Error("the lab column is missing");

  // Every row any printed audit reads.
  const ids = new Set<string>();
  for (const source of AUDIT_SOURCES) {
    const artifact = JSON.parse(readFileSync(`${DIR}/${source.file}`, "utf8")) as {
      sweeps: Array<{ status?: string; auditedRowIds?: string[] }>;
    };
    for (const sweep of artifact.sweeps) {
      if (sweep.status !== undefined && sweep.status !== "ok") continue;
      for (const id of sweep.auditedRowIds ?? []) ids.add(String(id));
    }
  }
  const rowIds = [...ids].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

  // Oracle-computed cells only: a certificate copy (reused_certified) is a
  // verbatim copy of v1 and would read as a non-flip by construction.
  const computed = async (version: number) =>
    new Map(
      (await getCellsForVersion(lab.id, version, rowIds))
        .filter((c) => c.status === "done" || c.status === "cached")
        .map((c) => [String(c.row_id), c.value]),
    );
  const v1 = await computed(1);
  const v2 = await computed(2);
  const v4 = await computed(4);

  const cells: AuditCells = {
    artifact: "deployment-audit-cells",
    note:
      "every row a printed deployment audit reads (the union of the auditedRowIds of exp11-fullscale.json, exp11c-deployment-bounds.json, and exp11c-deployment-bounds-v4.json), with the cached v1 value and the oracle-computed v2 (August snapshot) and v4 (September snapshot) values of the lab column; null where the row holds no oracle-computed cell of that version (certificate copies excluded)",
    column: lab.name,
    rows: rowIds.map((id) => ({
      id,
      v1: v1.has(id) ? v1.get(id) : null,
      v2: v2.has(id) ? v2.get(id) : null,
      v4: v4.has(id) ? v4.get(id) : null,
    })),
  };
  writeFileSync(OUT, JSON.stringify(cells) + "\n");
  console.log(
    `${OUT}: ${cells.rows.length} rows; v1 ${v1.size}, v2 ${v2.size}, v4 ${v4.size} oracle-computed cells`,
  );

  // The artifact alone must reproduce every audit exp11b printed.
  const recorded = JSON.parse(readFileSync(`${DIR}/exp11b-verify.json`, "utf8"));
  const n = recomputeAudits(cells, recorded, DIR);
  console.log(`reproduced ${n} audits of exp11b-verify.json from ${OUT} alone`);
  console.log("EXPORT_AUDIT_CELLS_DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
