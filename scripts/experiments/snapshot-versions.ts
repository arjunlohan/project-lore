/**
 * Register the September 2026 model snapshot of the lab column as prompt
 * versions of its own, and repair the cells an earlier replay wrote under
 * the August version.
 *
 * Why versions: the certifier keys every cell by (column, row, prompt
 * version). Assumption 1 of the paper scopes a certificate to the model
 * snapshot its oracle draws came from, so oracle draws taken 55 days after
 * the deployment run must not share a version with the August draws, or a
 * replay would silently mix two snapshots in one certification path (a
 * 2026-09-29 replay did exactly that, and the mixed path read 25 flips in
 * the August half and 55 in the September half of one 1,440-draw prefix).
 * A snapshot is therefore a version: version 4 is the v2 template re-issued
 * on 2026-09-29, version 5 the v1 template re-issued the same day.
 *
 * Repair: the replay's 699 September draws were written as version-2 cells
 * over reused_certified copies stamped by the August certificate. They are
 * moved to version 4 (they are valid September draws of the v2 template),
 * and the certified copies are restored through applyCertificateReuse,
 * which is additive and re-stamps exactly the rows that lost their copy.
 *
 * Idempotent: safe to rerun.
 *
 * Run: pnpm tsx scripts/experiments/snapshot-versions.ts
 */
import mysql from "mysql2/promise";
import { applyCertificateReuse, getColumnVersion, listColumns } from "../../lib/lore/column-store";

const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const SNAPSHOT_DAY = "2026-09-29";
const AUGUST_CERTIFICATE = "d7c197c9-bf4f-4fac-bac3-2c0d713792ff";

async function main() {
  const lab = (await listColumns("profiles")).find((c) => c.name.includes("(lab)"))!;
  const v1 = await getColumnVersion(lab.id, 1);
  const v2 = await getColumnVersion(lab.id, 2);
  if (!v1 || !v2) throw new Error("v1/v2 missing");
  const db = await mysql.createConnection({ uri: MYSQL_URL });

  for (const [version, tpl] of [
    [4, v2.prompt_template],
    [5, v1.prompt_template],
  ] as const) {
    const [existing] = await db.query(
      `SELECT prompt_template FROM ai_column_versions WHERE column_id=? AND version=?`,
      [lab.id, version],
    );
    const row = (existing as Array<{ prompt_template: string }>)[0];
    if (row && row.prompt_template !== tpl) {
      throw new Error(`version ${version} exists with a different template; refusing`);
    }
    if (!row) {
      await db.query(
        `INSERT INTO ai_column_versions (column_id, version, prompt_template, model) VALUES (?, ?, ?, ?)`,
        [lab.id, version, tpl, v2.model],
      );
      console.log(`registered version ${version} (${version === 4 ? "v2" : "v1"} template, snapshot ${SNAPSHOT_DAY})`);
    }
  }

  // Move the September draws written under version 2 to version 4.
  const [moved] = await db.query(
    `SELECT row_id FROM ai_cells
     WHERE column_id=? AND prompt_version=2 AND status IN ('done','cached')
       AND updated_at >= ?`,
    [lab.id, SNAPSHOT_DAY],
  );
  const movedIds = (moved as Array<{ row_id: string }>).map((r) => r.row_id);
  if (movedIds.length > 0) {
    const marks = movedIds.map(() => "?").join(",");
    const [conflict] = await db.query(
      `SELECT COUNT(*) AS c FROM ai_cells WHERE column_id=? AND prompt_version=4 AND row_id IN (${marks})`,
      [lab.id, ...movedIds],
    );
    if (Number((conflict as Array<{ c: number }>)[0]!.c) > 0) {
      throw new Error("version 4 already holds some of these rows; refusing to move");
    }
    await db.query(
      `UPDATE ai_cells SET prompt_version=4, certificate_id=NULL
       WHERE column_id=? AND prompt_version=2 AND status IN ('done','cached')
         AND updated_at >= ? AND row_id IN (${marks})`,
      [lab.id, SNAPSHOT_DAY, ...movedIds],
    );
    console.log(`moved ${movedIds.length} September draws from version 2 to version 4`);
    const restored = await applyCertificateReuse(lab.id, 1, 2, lab.model, movedIds, AUGUST_CERTIFICATE);
    console.log(`restored ${restored} certified copies under the August certificate`);
  } else {
    console.log("no September draws under version 2; nothing to move");
  }

  const [[state]] = (await db.query(
    `SELECT
       SUM(prompt_version=2 AND status='reused_certified') AS v2_reused,
       SUM(prompt_version=2 AND status IN ('done','cached')) AS v2_oracle,
       SUM(prompt_version=2 AND status IN ('done','cached') AND updated_at >= ?) AS v2_september,
       SUM(prompt_version=4 AND status IN ('done','cached')) AS v4_oracle,
       SUM(prompt_version=5 AND status IN ('done','cached')) AS v5_oracle,
       SUM(certificate_id = ?) AS stamped
     FROM ai_cells WHERE column_id=?`,
    [SNAPSHOT_DAY, AUGUST_CERTIFICATE, lab.id],
  )) as unknown as [[Record<string, number>]];
  await db.end();
  console.log(JSON.stringify(state));
  if (Number(state.v2_september) !== 0) throw new Error("September draws remain under version 2");
  console.log("SNAPSHOT_VERSIONS_OK");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
