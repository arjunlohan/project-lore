import { ElasticsearchAdapter } from "@lore/adapter-elasticsearch";
import { MysqlAdapter } from "@lore/adapter-mysql";
import type { DataSourceAdapter } from "@lore/core";
import {
  PROFILE_ES_INDEX,
  PROFILE_FIELDS,
  PROFILE_ID_FIELD,
  PROFILE_TABLE,
} from "./fields";

/**
 * Server-side adapter registry. Both backends stay live so the demo can
 * switch between them per request and prove parity; `hybrid` searches ES and
 * hydrates rows from MySQL (source-of-truth pattern).
 */
export type BackendId = "elasticsearch" | "mysql" | "hybrid";

type Row = Record<string, unknown>;

const globals = globalThis as unknown as {
  __loreEs?: ElasticsearchAdapter<Row>;
  __loreMy?: MysqlAdapter<Row>;
};

export function esAdapter(): ElasticsearchAdapter<Row> {
  globals.__loreEs ??= new ElasticsearchAdapter<Row>({
    node: process.env.LORE_ES_URL ?? "http://localhost:9200",
    index: PROFILE_ES_INDEX,
    fields: PROFILE_FIELDS,
    idField: PROFILE_ID_FIELD,
  });
  return globals.__loreEs;
}

export function mysqlAdapter(): MysqlAdapter<Row> {
  globals.__loreMy ??= new MysqlAdapter<Row>({
    uri: process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore",
    table: PROFILE_TABLE,
    fields: PROFILE_FIELDS,
    idField: PROFILE_ID_FIELD,
  });
  return globals.__loreMy;
}

/** Hybrid: ES answers search/counts/facets; MySQL hydrates full rows by id. */
class HybridAdapter implements DataSourceAdapter<Row> {
  readonly id = "hybrid:es-search+mysql-hydrate";
  get capabilities() {
    return esAdapter().capabilities;
  }
  fields() {
    return esAdapter().fields();
  }
  count(filter: Parameters<DataSourceAdapter<Row>["count"]>[0]) {
    return esAdapter().count(filter);
  }
  async search(
    ...args: Parameters<DataSourceAdapter<Row>["search"]>
  ): ReturnType<DataSourceAdapter<Row>["search"]> {
    const page = await esAdapter().search(...args);
    const ids = page.rows.map((r) => String(r[PROFILE_ID_FIELD]));
    const hydrated = await mysqlAdapter().hydrate(ids);
    const byId = new Map(hydrated.map((r) => [String(r[PROFILE_ID_FIELD]), r]));
    return {
      ...page,
      rows: page.rows.map((r) => byId.get(String(r[PROFILE_ID_FIELD])) ?? r),
    };
  }
  aggregate(...args: Parameters<DataSourceAdapter<Row>["aggregate"]>) {
    return esAdapter().aggregate(...args);
  }
  hydrate(ids: string[]) {
    return mysqlAdapter().hydrate(ids);
  }
}

const hybrid = new HybridAdapter();

export function adapterFor(backend: BackendId): DataSourceAdapter<Row> {
  if (backend === "mysql") return mysqlAdapter();
  if (backend === "hybrid") return hybrid;
  return esAdapter();
}
