/**
 * Ingest the Stack Overflow 2023 Developer Survey (ODbL 1.0 / DbCL 1.0,
 * StackExchange/Survey GitHub archive) into MySQL and Elasticsearch as the
 * `profiles` corpus for lore.
 *
 * Idempotent: drops and recreates the MySQL table and the ES index, then
 * verifies row counts in both stores match the parsed record count.
 *
 * Run: pnpm tsx scripts/ingest/so2023.ts
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import mysql from "mysql2/promise";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { MappingTypeMapping } from "@elastic/elasticsearch/lib/api/types";

const CSV_PATH = new URL(
  "../../.local-infra/data/so2023.csv",
  import.meta.url,
).pathname;
const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const ES_URL = process.env.LORE_ES_URL ?? "http://localhost:9200";
const ES_INDEX = "lore-profiles";
const TABLE = "profiles";

// ---------------------------------------------------------------------------
// Field mapping: curated facet subset of the 84 survey columns.
// ---------------------------------------------------------------------------

const NA = new Set(["", "NA", "N/A", "null"]);

function str(v: string | undefined): string | null {
  if (v === undefined || NA.has(v)) return null;
  return v;
}

function multi(v: string | undefined): string[] {
  const s = str(v);
  return s ? s.split(";").map((x) => x.trim()).filter(Boolean) : [];
}

function years(v: string | undefined): number | null {
  const s = str(v);
  if (s === null) return null;
  if (/^less than 1/i.test(s)) return 0.5;
  if (/^more than 50/i.test(s)) return 51;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function num(v: string | undefined): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface Profile {
  response_id: number;
  main_branch: string | null;
  age: string | null;
  employment: string[];
  remote_work: string | null;
  coding_activities: string[];
  ed_level: string | null;
  learn_code: string[];
  years_code: number | null;
  years_code_pro: number | null;
  dev_type: string | null;
  org_size: string | null;
  country: string | null;
  comp_total: number | null;
  converted_comp_yearly: number | null;
  languages: string[];
  databases: string[];
  platforms: string[];
  webframes: string[];
  misc_tech: string[];
  tools_tech: string[];
  op_sys_pro: string[];
  ai_search: string[];
  ai_dev: string[];
  ai_select: string | null;
  ai_sent: string | null;
  ic_or_pm: string | null;
  work_exp: number | null;
  industry: string | null;
}

function toProfile(rec: Record<string, string>): Profile {
  return {
    response_id: Number(rec["ResponseId"]),
    main_branch: str(rec["MainBranch"]),
    age: str(rec["Age"]),
    employment: multi(rec["Employment"]),
    remote_work: str(rec["RemoteWork"]),
    coding_activities: multi(rec["CodingActivities"]),
    ed_level: str(rec["EdLevel"]),
    learn_code: multi(rec["LearnCode"]),
    years_code: years(rec["YearsCode"]),
    years_code_pro: years(rec["YearsCodePro"]),
    dev_type: str(rec["DevType"]),
    org_size: str(rec["OrgSize"]),
    country: str(rec["Country"]),
    comp_total: num(rec["CompTotal"]),
    converted_comp_yearly: num(rec["ConvertedCompYearly"]),
    languages: multi(rec["LanguageHaveWorkedWith"]),
    databases: multi(rec["DatabaseHaveWorkedWith"]),
    platforms: multi(rec["PlatformHaveWorkedWith"]),
    webframes: multi(rec["WebframeHaveWorkedWith"]),
    misc_tech: multi(rec["MiscTechHaveWorkedWith"]),
    tools_tech: multi(rec["ToolsTechHaveWorkedWith"]),
    op_sys_pro: multi(rec["OpSysProfessional use"]),
    ai_search: multi(rec["AISearchHaveWorkedWith"]),
    ai_dev: multi(rec["AIDevHaveWorkedWith"]),
    ai_select: str(rec["AISelect"]),
    ai_sent: str(rec["AISent"]),
    ic_or_pm: str(rec["ICorPM"]),
    work_exp: years(rec["WorkExp"]),
    industry: str(rec["Industry"]),
  };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const DDL = `CREATE TABLE ${TABLE} (
  response_id INT PRIMARY KEY,
  main_branch VARCHAR(255),
  age VARCHAR(255),
  employment JSON NOT NULL,
  remote_work VARCHAR(255),
  coding_activities JSON NOT NULL,
  ed_level VARCHAR(255),
  learn_code JSON NOT NULL,
  years_code DECIMAL(4,1),
  years_code_pro DECIMAL(4,1),
  dev_type VARCHAR(255),
  org_size VARCHAR(255),
  country VARCHAR(255),
  comp_total DOUBLE,
  converted_comp_yearly DOUBLE,
  languages JSON NOT NULL,
  \`databases\` JSON NOT NULL,
  platforms JSON NOT NULL,
  webframes JSON NOT NULL,
  misc_tech JSON NOT NULL,
  tools_tech JSON NOT NULL,
  op_sys_pro JSON NOT NULL,
  ai_search JSON NOT NULL,
  ai_dev JSON NOT NULL,
  ai_select VARCHAR(255),
  ai_sent VARCHAR(255),
  ic_or_pm VARCHAR(255),
  work_exp DECIMAL(4,1),
  industry VARCHAR(255),
  INDEX idx_country (country),
  INDEX idx_dev_type (dev_type),
  INDEX idx_ed_level (ed_level),
  INDEX idx_remote (remote_work),
  INDEX idx_industry (industry),
  INDEX idx_ycp (years_code_pro),
  INDEX idx_comp (converted_comp_yearly)
) CHARACTER SET utf8mb4`;

const COLS = [
  "response_id",
  "main_branch",
  "age",
  "employment",
  "remote_work",
  "coding_activities",
  "ed_level",
  "learn_code",
  "years_code",
  "years_code_pro",
  "dev_type",
  "org_size",
  "country",
  "comp_total",
  "converted_comp_yearly",
  "languages",
  "databases",
  "platforms",
  "webframes",
  "misc_tech",
  "tools_tech",
  "op_sys_pro",
  "ai_search",
  "ai_dev",
  "ai_select",
  "ai_sent",
  "ic_or_pm",
  "work_exp",
  "industry",
] as const;

function mysqlRow(p: Profile): unknown[] {
  return COLS.map((c) => {
    const v = p[c];
    return Array.isArray(v) ? JSON.stringify(v) : v;
  });
}

// ---------------------------------------------------------------------------
// Elasticsearch
// ---------------------------------------------------------------------------

const ES_MAPPINGS: MappingTypeMapping = {
  dynamic: "strict",
  properties: {
    response_id: { type: "integer" },
    main_branch: { type: "keyword" },
    age: { type: "keyword" },
    employment: { type: "keyword" },
    remote_work: { type: "keyword" },
    coding_activities: { type: "keyword" },
    ed_level: { type: "keyword" },
    learn_code: { type: "keyword" },
    years_code: { type: "float" },
    years_code_pro: { type: "float" },
    dev_type: { type: "keyword" },
    org_size: { type: "keyword" },
    country: { type: "keyword" },
    comp_total: { type: "double" },
    converted_comp_yearly: { type: "double" },
    languages: { type: "keyword" },
    databases: { type: "keyword" },
    platforms: { type: "keyword" },
    webframes: { type: "keyword" },
    misc_tech: { type: "keyword" },
    tools_tech: { type: "keyword" },
    op_sys_pro: { type: "keyword" },
    ai_search: { type: "keyword" },
    ai_dev: { type: "keyword" },
    ai_select: { type: "keyword" },
    ai_sent: { type: "keyword" },
    ic_or_pm: { type: "keyword" },
    work_exp: { type: "float" },
    industry: { type: "keyword" },
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = await mysql.createConnection({ uri: MYSQL_URL });
  const es = new EsClient({ node: ES_URL });

  await db.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.query(DDL);
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

  const parser = createReadStream(CSV_PATH).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true }),
  );

  const BATCH = 1000;
  let batch: Profile[] = [];
  let total = 0;

  const placeholders = `(${COLS.map(() => "?").join(",")})`;
  const insertSql = `INSERT INTO ${TABLE} (${COLS.map((c) => `\`${c}\``).join(",")}) VALUES `;

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    await Promise.all([
      db.query(
        insertSql + rows.map(() => placeholders).join(","),
        rows.flatMap(mysqlRow),
      ),
      es.bulk({
        operations: rows.flatMap((p) => [
          { index: { _index: ES_INDEX, _id: String(p.response_id) } },
          p,
        ]),
      }).then((res) => {
        if (res.errors) {
          const first = res.items.find((i) => i.index?.error);
          throw new Error(
            `ES bulk error: ${JSON.stringify(first?.index?.error)}`,
          );
        }
      }),
    ]);
    total += rows.length;
    if (total % 10000 === 0) console.log(`  ${total} rows ingested`);
  }

  for await (const rec of parser) {
    batch.push(toProfile(rec as Record<string, string>));
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  await es.indices.refresh({ index: ES_INDEX });
  await es.indices.putSettings({
    index: ES_INDEX,
    settings: { refresh_interval: "1s" },
  });

  const [[sqlCount]] = (await db.query(
    `SELECT COUNT(*) AS c FROM ${TABLE}`,
  )) as unknown as [[{ c: number }]];
  const esCount = await es.count({ index: ES_INDEX });

  console.log(`Parsed records: ${total}`);
  console.log(`MySQL ${TABLE}: ${sqlCount.c}`);
  console.log(`ES ${ES_INDEX}: ${esCount.count}`);

  const ok = sqlCount.c === total && esCount.count === total;
  console.log(ok ? "INGEST_OK" : "INGEST_MISMATCH");
  await db.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
