/**
 * Ingest the Djinni English candidate profiles (MIT license, lang-uk on
 * HuggingFace; 210,250 rows) into MySQL `djinni_profiles` and ES
 * `lore-djinni`. This is lore's FREE-TEXT corpus: long CV text drives
 * semantic AI columns; structured facets are thin by design.
 *
 * Idempotent (drop + recreate). Verifies counts match parsed rows.
 *
 * Run: pnpm tsx scripts/ingest/djinni.ts
 */
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import mysql from "mysql2/promise";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { MappingTypeMapping } from "@elastic/elasticsearch/lib/api/types";

const PARQUET_PATH = new URL(
  "../../.local-infra/data/djinni.parquet",
  import.meta.url,
).pathname;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const ES_URL = process.env.LORE_ES_URL ?? "http://localhost:9200";
const ES_INDEX = "lore-djinni";
const TABLE = "djinni_profiles";

interface Candidate {
  id: string;
  position: string | null;
  primary_keyword: string | null;
  english_level: string | null;
  experience_years: number | null;
  cv: string | null;
  highlights: string | null;
  looking_for: string | null;
  moreinfo: string | null;
}

const s = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DDL = `CREATE TABLE ${TABLE} (
  id VARCHAR(64) PRIMARY KEY,
  position VARCHAR(512),
  primary_keyword VARCHAR(255),
  english_level VARCHAR(64),
  experience_years DECIMAL(5,2),
  cv MEDIUMTEXT,
  highlights TEXT,
  looking_for TEXT,
  moreinfo TEXT,
  INDEX idx_keyword (primary_keyword),
  INDEX idx_english (english_level),
  INDEX idx_exp (experience_years)
) CHARACTER SET utf8mb4`;

const ES_MAPPINGS: MappingTypeMapping = {
  dynamic: "strict",
  properties: {
    id: { type: "keyword" },
    position: {
      type: "text",
      fields: { kw: { type: "keyword", ignore_above: 256 } },
    },
    primary_keyword: { type: "keyword" },
    english_level: { type: "keyword" },
    experience_years: { type: "float" },
    cv: { type: "text" },
    highlights: { type: "text" },
    looking_for: { type: "text" },
    moreinfo: { type: "text" },
  },
};

async function main() {
  const file = await asyncBufferFromFile(PARQUET_PATH);
  console.log("reading parquet...");
  const records = (await parquetReadObjects({ file })) as Record<
    string,
    unknown
  >[];
  console.log(`parquet rows: ${records.length}`);

  const rows: Candidate[] = records.map((r) => ({
    id: String(r["id"]),
    position: s(r["Position"]),
    primary_keyword: s(r["Primary Keyword"]),
    english_level: s(r["English Level"]),
    experience_years: num(r["Experience Years"]),
    cv: s(r["CV"]),
    highlights: s(r["Highlights"]),
    looking_for: s(r["Looking For"]),
    moreinfo: s(r["Moreinfo"]),
  }));

  const db = await mysql.createConnection({ uri: MYSQL_URL });
  await db.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.query(DDL);
  const es = new EsClient({ node: ES_URL });
  if (await es.indices.exists({ index: ES_INDEX })) {
    await es.indices.delete({ index: ES_INDEX });
  }
  await es.indices.create({
    index: ES_INDEX,
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      refresh_interval: "-1",
    },
    mappings: ES_MAPPINGS,
  });

  const COLS = [
    "id",
    "position",
    "primary_keyword",
    "english_level",
    "experience_years",
    "cv",
    "highlights",
    "looking_for",
    "moreinfo",
  ] as const;
  const placeholders = `(${COLS.map(() => "?").join(",")})`;
  const insertSql = `INSERT INTO ${TABLE} (${COLS.join(",")}) VALUES `;

  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all([
      db.query(
        insertSql + batch.map(() => placeholders).join(","),
        batch.flatMap((r) => COLS.map((c) => r[c])),
      ),
      es
        .bulk({
          operations: batch.flatMap((r) => [
            { index: { _index: ES_INDEX, _id: r.id } },
            r,
          ]),
        })
        .then((res) => {
          if (res.errors) {
            const first = res.items.find((it) => it.index?.error);
            throw new Error(
              `ES bulk error: ${JSON.stringify(first?.index?.error)}`,
            );
          }
        }),
    ]);
    total += batch.length;
    if (total % 20000 === 0) console.log(`  ${total} ingested`);
  }

  await es.indices.refresh({ index: ES_INDEX });
  await es.indices.putSettings({
    index: ES_INDEX,
    settings: { refresh_interval: "1s" },
  });

  const [[sqlCount]] = (await db.query(
    `SELECT COUNT(*) AS c FROM ${TABLE}`,
  )) as unknown as [[{ c: number }]];
  const esCount = await es.count({ index: ES_INDEX });
  console.log(
    `MySQL ${sqlCount.c} · ES ${esCount.count} · parsed ${rows.length}`,
  );
  const ok = sqlCount.c === rows.length && esCount.count === rows.length;
  console.log(ok ? "DJINNI_INGEST_OK" : "DJINNI_INGEST_MISMATCH");
  await db.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
