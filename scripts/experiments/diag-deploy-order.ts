/**
 * Diagnostic: which row order did the reported deployment run (exp11,
 * 225 calls, cached-FALSE 5 flips in 180 and 25 in 720, cached-TRUE 13 in
 * 45) shuffle over? certifyColumnEdit seeds the shuffle but takes the
 * stratum's row order from the cell query's return order, which is not
 * pinned. Each candidate order is walked with the same seeded shuffle and
 * scored against the stored oracle cells: the true order has every prefix
 * row present and the recorded flip counts.
 */
import mysql from "mysql2/promise";
import { seededShuffle } from "@lore/core/sivm";
import { getCellsForVersion, listColumns } from "../../lib/lore/column-store";

const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

async function main() {
  const lab = (await listColumns("profiles")).find((c) => c.name.includes("(lab)"))!;
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const [prof] = await db.query(`SELECT response_id FROM profiles`);
  const profilesOrder = (prof as Array<{ response_id: unknown }>).map((r) => String(r.response_id));
  const [byHash] = await db.query(
    `SELECT row_id FROM ai_cells WHERE column_id=? AND prompt_version=1 ORDER BY model, row_content_hash, row_id`,
    [lab.id],
  );
  const hashOrder = (byHash as Array<{ row_id: string }>).map((r) => r.row_id);
  const [byPk] = await db.query(
    `SELECT row_id FROM ai_cells FORCE INDEX (PRIMARY) WHERE column_id=? AND prompt_version=1`,
    [lab.id],
  );
  const pkOrder = (byPk as Array<{ row_id: string }>).map((r) => r.row_id);
  await db.end();

  const v1 = (await getCellsForVersion(lab.id, 1)).filter(
    (c) => c.status === "done" || c.status === "cached",
  );
  const defaultOrder = v1.map((c) => c.row_id);
  const value = new Map(v1.map((c) => [c.row_id, JSON.stringify(c.value)]));
  const v2 = new Map(
    (await getCellsForVersion(lab.id, 2))
      .filter((c) => c.status === "done" || c.status === "cached")
      .map((c) => [c.row_id, JSON.stringify(c.value)]),
  );
  const present = new Set(value.keys());
  const candidates: Record<string, string[]> = {
    "db-default": defaultOrder,
    "pk-forced": pkOrder.filter((id) => present.has(id)),
    "lexicographic": [...defaultOrder].sort(),
    "numeric": [...defaultOrder].sort((a, b) => Number(a) - Number(b)),
    "numeric-desc": [...defaultOrder].sort((a, b) => Number(b) - Number(a)),
    "profiles-scan": profilesOrder.filter((id) => present.has(id)),
    "secondary-hash": hashOrder.filter((id) => present.has(id)),
  };
  for (const [name, order] of Object.entries(candidates)) {
    const line: string[] = [];
    for (const val of ["false", "true"]) {
      const members = order.filter((id) => value.get(id) === val);
      const shuffled = seededShuffle(members, 42);
      const prefixStats = (n: number) => {
        const pre = shuffled.slice(0, n);
        const missing = pre.filter((id) => !v2.has(id)).length;
        const flips = pre.filter((id) => v2.has(id) && v2.get(id) !== value.get(id)).length;
        return `${n}:k=${flips}${missing ? `(miss ${missing})` : ""}`;
      };
      const looks = val === "false" ? [45, 90, 180, 360, 720] : [45];
      line.push(`${val}[${members.length}] ` + looks.map(prefixStats).join(" "));
    }
    console.log(`${name.padEnd(15)} ${line.join(" | ")}`);
  }
  console.log("target: false 180:k=5 720:k=25 (no miss), true 45:k=13");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
