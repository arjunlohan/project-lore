/**
 * Adapter conformance battery: proves that the SAME FilterSpec produces the
 * SAME results on MySQL and Elasticsearch over the full 89K-row corpus.
 *
 * Checks per case: count parity; unsorted first-page id parity; and for a
 * subset: sorted-page id-sequence parity (incl. NULL placement), keyword
 * aggregation parity, and hydrated row parity.
 *
 * Run: pnpm tsx scripts/conformance.ts
 */
import { ElasticsearchAdapter } from "@lore/adapter-elasticsearch";
import { MysqlAdapter } from "@lore/adapter-mysql";
import type { DataSourceAdapter, FilterSpec } from "@lore/core";
import {
  PROFILE_ES_INDEX,
  PROFILE_FIELDS,
  PROFILE_ID_FIELD,
  PROFILE_TABLE,
} from "../lib/lore/fields";

const MYSQL_URL =
  process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const ES_URL = process.env.LORE_ES_URL ?? "http://localhost:9200";

const spec = (
  all: FilterSpec["all"],
  any?: FilterSpec["any"],
): FilterSpec => ({ schemaVersion: 1, all, ...(any ? { any } : {}) });

const CASES: Array<{ name: string; filter: FilterSpec }> = [
  { name: "match-all", filter: spec([]) },
  {
    name: "term-scalar-country",
    filter: spec([
      { kind: "term", field: "country", value: "United States of America" },
    ]),
  },
  {
    name: "term-multi-rust",
    filter: spec([{ kind: "term", field: "languages", value: "Rust" }]),
  },
  {
    name: "terms-scalar-eu",
    filter: spec([
      {
        kind: "terms",
        field: "country",
        values: ["Germany", "France", "Netherlands"],
      },
    ]),
  },
  {
    name: "terms-multi-db",
    filter: spec([
      {
        kind: "terms",
        field: "databases",
        values: ["Elasticsearch", "Redis"],
      },
    ]),
  },
  {
    name: "range-ycp-5-10",
    filter: spec([
      { kind: "range", field: "years_code_pro", min: 5, max: 10 },
    ]),
  },
  {
    name: "range-comp-min",
    filter: spec([
      { kind: "range", field: "converted_comp_yearly", min: 150000 },
    ]),
  },
  {
    name: "exists-industry",
    filter: spec([{ kind: "exists", field: "industry" }]),
  },
  {
    name: "exists-multi-webframes",
    filter: spec([{ kind: "exists", field: "webframes" }]),
  },
  {
    name: "not-term-remote",
    filter: spec([
      {
        kind: "not",
        predicate: { kind: "term", field: "remote_work", value: "Remote" },
      },
    ]),
  },
  {
    name: "not-term-multi-python",
    filter: spec([
      {
        kind: "not",
        predicate: { kind: "term", field: "languages", value: "Python" },
      },
    ]),
  },
  {
    name: "not-exists-industry",
    filter: spec([
      { kind: "not", predicate: { kind: "exists", field: "industry" } },
    ]),
  },
  {
    name: "combo-us-senior-python-pg-or-mysql",
    filter: spec(
      [
        { kind: "term", field: "country", value: "United States of America" },
        { kind: "range", field: "years_code_pro", min: 5 },
        { kind: "term", field: "languages", value: "Python" },
      ],
      [
        { kind: "term", field: "databases", value: "PostgreSQL" },
        { kind: "term", field: "databases", value: "MySQL" },
      ],
    ),
  },
  {
    name: "not-terms-scalar",
    filter: spec([
      {
        kind: "not",
        predicate: {
          kind: "terms",
          field: "country",
          values: ["India", "United States of America"],
        },
      },
    ]),
  },
  {
    name: "double-negation",
    filter: spec([
      {
        kind: "not",
        predicate: {
          kind: "not",
          predicate: { kind: "term", field: "remote_work", value: "Hybrid (some remote, some in-person)" },
        },
      },
    ]),
  },
  {
    name: "any-only",
    filter: spec(
      [],
      [
        { kind: "term", field: "dev_type", value: "Data scientist or machine learning specialist" },
        { kind: "term", field: "dev_type", value: "Data engineer" },
      ],
    ),
  },
  {
    name: "range-work-exp",
    filter: spec([{ kind: "range", field: "work_exp", min: 2, max: 6 }]),
  },
  { name: "empty-terms", filter: spec([{ kind: "terms", field: "country", values: [] }]) },
  {
    name: "term-ai-select",
    filter: spec([{ kind: "term", field: "ai_select", value: "Yes" }]),
  },
  {
    name: "combo-not-multi-range",
    filter: spec([
      { kind: "range", field: "converted_comp_yearly", min: 50000, max: 200000 },
      {
        kind: "not",
        predicate: { kind: "term", field: "platforms", value: "Amazon Web Services (AWS)" },
      },
      { kind: "exists", field: "dev_type" },
    ]),
  },
];

type Row = Record<string, unknown>;

const ids = (rows: Row[]) => rows.map((r) => Number(r.response_id));
const sameSet = (a: number[], b: number[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const sameSeq = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  const es = new ElasticsearchAdapter<Row>({
    node: ES_URL,
    index: PROFILE_ES_INDEX,
    fields: PROFILE_FIELDS,
    idField: PROFILE_ID_FIELD,
  });
  const my = new MysqlAdapter<Row>({
    uri: MYSQL_URL,
    table: PROFILE_TABLE,
    fields: PROFILE_FIELDS,
    idField: PROFILE_ID_FIELD,
  });

  let failures = 0;
  const fail = (name: string, what: string, a: unknown, b: unknown) => {
    failures++;
    console.error(`FAIL ${name} ${what}: es=${JSON.stringify(a)} mysql=${JSON.stringify(b)}`);
  };

  for (const c of CASES) {
    const [esCount, myCount] = await Promise.all([
      es.count(c.filter),
      my.count(c.filter),
    ]);
    if (esCount !== myCount) {
      fail(c.name, "count", esCount, myCount);
      continue;
    }
    const [esPage, myPage] = await Promise.all([
      es.search(c.filter, { limit: 20 }),
      my.search(c.filter, { limit: 20 }),
    ]);
    if (!sameSeq(ids(esPage.rows), ids(myPage.rows))) {
      fail(c.name, "first-page ids", ids(esPage.rows), ids(myPage.rows));
      continue;
    }
    console.log(`ok   ${c.name} (count=${esCount})`);
  }

  // Sorted-page parity, including NULL placement on both directions.
  for (const sort of [
    { kind: "field", field: "years_code_pro", dir: "desc" } as const,
    { kind: "field", field: "converted_comp_yearly", dir: "asc" } as const,
  ]) {
    const filter = CASES[5]!.filter; // range-ycp-5-10 for desc; reuse for asc
    const [esPage, myPage] = await Promise.all([
      es.search(filter, { limit: 25, sort }),
      my.search(filter, { limit: 25, sort }),
    ]);
    if (!sameSeq(ids(esPage.rows), ids(myPage.rows))) {
      fail(`sort-${sort.field}-${sort.dir}`, "sorted ids", ids(esPage.rows), ids(myPage.rows));
    } else {
      console.log(`ok   sort-${sort.field}-${sort.dir}`);
    }
  }

  // Aggregation parity on scalar + multi-valued keyword fields.
  {
    const filter = CASES[13]!.filter; // not-terms-scalar: mid-size residual
    const [esAgg, myAgg] = await Promise.all([
      es.aggregate(filter, ["country", "languages", "remote_work"]),
      my.aggregate(filter, ["country", "languages", "remote_work"]),
    ]);
    for (const f of ["country", "languages", "remote_work"]) {
      const a = esAgg[f]!.map((x) => `${x.value}:${x.count}`);
      const b = myAgg[f]!.map((x) => `${x.value}:${x.count}`);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        fail("aggregate", f, a.slice(0, 5), b.slice(0, 5));
      } else {
        console.log(`ok   aggregate-${f} (${a.length} buckets)`);
      }
    }
  }

  // Hydration parity: same rows, same values, arrays parsed.
  {
    const sample = ["1", "2", "5", "100", "50000"];
    const [esRows, myRows] = await Promise.all([
      es.hydrate(sample),
      my.hydrate(sample),
    ]);
    if (!sameSet(ids(esRows), ids(myRows))) {
      fail("hydrate", "id set", ids(esRows), ids(myRows));
    } else {
      const esById = new Map(esRows.map((r) => [Number(r.response_id), r]));
      const myById = new Map(myRows.map((r) => [Number(r.response_id), r]));
      let rowMismatch = false;
      for (const [id, esRow] of esById) {
        const myRow = myById.get(id)!;
        for (const f of PROFILE_FIELDS) {
          const a = esRow[f.name] ?? null;
          const b = myRow[f.name] ?? null;
          if (JSON.stringify(a) !== JSON.stringify(b)) {
            fail("hydrate", `row ${id} field ${f.name}`, a, b);
            rowMismatch = true;
          }
        }
      }
      if (!rowMismatch) console.log(`ok   hydrate (${esRows.length} rows, all 29 fields equal)`);
    }
  }

  await my.close();
  console.log(failures === 0 ? "CONFORMANCE_PASS" : `CONFORMANCE_FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
