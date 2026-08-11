/**
 * MySQL DataSourceAdapter: compiles a FilterSpec into deterministic SQL.
 *
 * Semantics contract (must match adapter-elasticsearch exactly):
 * - a predicate never matches a row whose field is NULL / empty array;
 * - `not(p)` matches every row p does not match, INCLUDING NULL-field rows.
 * To make `NOT (...)` compose under SQL three-valued logic, every compiled
 * predicate is guaranteed to evaluate to TRUE or FALSE, never NULL
 * (null-safe `<=>`, explicit IS NOT NULL guards).
 *
 * Multi-valued fields are stored as JSON arrays (never NULL, possibly empty):
 * term -> JSON_CONTAINS, terms -> JSON_OVERLAPS, exists -> JSON_LENGTH > 0,
 * aggregate -> JSON_TABLE explode.
 */
import mysql from "mysql2/promise";
import type {
  AdapterCapabilities,
  DataSourceAdapter,
  FacetValue,
  FieldDef,
  FilterPredicate,
  FilterSpec,
  SearchPage,
  SortSpec,
} from "@lore/core";

export interface MysqlAdapterOptions {
  uri: string;
  table: string;
  fields: FieldDef[];
  /** Primary-key column used for hydrate() and stable sort tiebreaks. */
  idField: string;
  /**
   * How `text` predicates behave: "like" compiles to LIKE '%q%' (portable but
   * NOT equivalent to Elasticsearch analysis; excluded from conformance) or
   * "unsupported" to throw.
   */
  textMode?: "like" | "unsupported";
}

export class UnsupportedPredicateError extends Error {
  constructor(kind: string, adapterId: string) {
    super(`Predicate kind "${kind}" is not supported by ${adapterId}`);
    this.name = "UnsupportedPredicateError";
  }
}

interface Compiled {
  sql: string;
  params: unknown[];
}

const ident = (name: string) => `\`${name.replaceAll("`", "")}\``;

export class MysqlAdapter<Row extends Record<string, unknown>>
  implements DataSourceAdapter<Row>
{
  readonly id: string;
  readonly capabilities: AdapterCapabilities = {
    liveCounts: true,
    aggregations: true,
    geo: false,
    fullText: true,
    vectorSearch: false,
  };
  private pool: mysql.Pool;
  private table: string;
  private fieldDefs: FieldDef[];
  private multi: Set<string>;
  private idField: string;
  private textMode: "like" | "unsupported";

  constructor(opts: MysqlAdapterOptions) {
    this.id = `mysql:${opts.table}`;
    this.pool = mysql.createPool({
      uri: opts.uri,
      decimalNumbers: true,
      connectionLimit: 10,
    });
    this.table = opts.table;
    this.fieldDefs = opts.fields;
    this.multi = new Set(
      opts.fields.filter((f) => f.multiValued).map((f) => f.name),
    );
    this.idField = opts.idField;
    this.textMode = opts.textMode ?? "like";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async fields(): Promise<FieldDef[]> {
    return this.fieldDefs;
  }

  // -- FilterSpec -> SQL ----------------------------------------------------

  compilePredicate(p: FilterPredicate): Compiled {
    switch (p.kind) {
      case "term": {
        if (this.multi.has(p.field)) {
          return {
            sql: `JSON_CONTAINS(${ident(p.field)}, JSON_QUOTE(?))`,
            params: [String(p.value)],
          };
        }
        return { sql: `(${ident(p.field)} <=> ?)`, params: [p.value] };
      }
      case "terms": {
        if (p.values.length === 0) return { sql: "FALSE", params: [] };
        if (this.multi.has(p.field)) {
          return {
            sql: `JSON_OVERLAPS(${ident(p.field)}, CAST(? AS JSON))`,
            params: [JSON.stringify(p.values.map(String))],
          };
        }
        const marks = p.values.map(() => "?").join(",");
        return {
          sql: `(${ident(p.field)} IS NOT NULL AND ${ident(p.field)} IN (${marks}))`,
          params: [...p.values],
        };
      }
      case "range": {
        const parts: string[] = [`${ident(p.field)} IS NOT NULL`];
        const params: unknown[] = [];
        if (p.min !== undefined) {
          parts.push(`${ident(p.field)} >= ?`);
          params.push(p.min);
        }
        if (p.max !== undefined) {
          parts.push(`${ident(p.field)} <= ?`);
          params.push(p.max);
        }
        return { sql: `(${parts.join(" AND ")})`, params };
      }
      case "exists": {
        if (this.multi.has(p.field)) {
          return { sql: `(JSON_LENGTH(${ident(p.field)}) > 0)`, params: [] };
        }
        return { sql: `(${ident(p.field)} IS NOT NULL)`, params: [] };
      }
      case "not": {
        const inner = this.compilePredicate(p.predicate);
        return { sql: `(NOT ${inner.sql})`, params: inner.params };
      }
      case "text": {
        if (this.textMode === "unsupported") {
          throw new UnsupportedPredicateError("text", this.id);
        }
        const clauses = p.fields.map(
          (f) => `(${ident(f)} IS NOT NULL AND ${ident(f)} LIKE ?)`,
        );
        return {
          sql: `(${clauses.join(" OR ")})`,
          params: p.fields.map(() => `%${p.query}%`),
        };
      }
      case "geo":
        throw new UnsupportedPredicateError("geo", this.id);
    }
  }

  compileFilterSpec(spec: FilterSpec): Compiled {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const p of spec.all) {
      const c = this.compilePredicate(p);
      parts.push(c.sql);
      params.push(...c.params);
    }
    if (spec.any && spec.any.length > 0) {
      const anyParts = spec.any.map((p) => this.compilePredicate(p));
      parts.push(`(${anyParts.map((c) => c.sql).join(" OR ")})`);
      params.push(...anyParts.flatMap((c) => c.params));
    }
    return {
      sql: parts.length > 0 ? parts.join(" AND ") : "TRUE",
      params,
    };
  }

  // -- Queries --------------------------------------------------------------

  async count(filter: FilterSpec): Promise<number> {
    const where = this.compileFilterSpec(filter);
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS c FROM ${ident(this.table)} WHERE ${where.sql}`,
      where.params,
    );
    return (rows as Array<{ c: number }>)[0]?.c ?? 0;
  }

  async search(
    filter: FilterSpec,
    opts?: { limit?: number; cursor?: string; sort?: SortSpec },
  ): Promise<SearchPage<Row>> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const where = this.compileFilterSpec(filter);

    let orderBy = `${ident(this.idField)} ASC`;
    if (opts?.sort?.kind === "field") {
      const dir = opts.sort.dir === "desc" ? "DESC" : "ASC";
      // MySQL sorts NULLs first ASC / last DESC natively; the ES adapter
      // mirrors this via `missing: _first/_last` so pages line up.
      orderBy = `${ident(opts.sort.field)} ${dir}, ${ident(this.idField)} ASC`;
    }

    const [total, rows] = await Promise.all([
      this.count(filter),
      this.pool
        .query(
          `SELECT * FROM ${ident(this.table)} WHERE ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
          [...where.params, limit, offset],
        )
        .then(([r]) => (r as Row[]).map((row) => this.normalizeRow(row))),
    ]);
    const next = offset + rows.length;
    return { rows, total, cursor: next < total ? String(next) : undefined };
  }

  async aggregate(
    filter: FilterSpec,
    fields: string[],
  ): Promise<Record<string, Array<{ value: FacetValue; count: number }>>> {
    const where = this.compileFilterSpec(filter);
    const out: Record<string, Array<{ value: FacetValue; count: number }>> =
      {};
    for (const f of fields) {
      const isMulti = this.multi.has(f);
      const sql = isMulti
        ? `SELECT jt.v AS value, COUNT(*) AS c
           FROM ${ident(this.table)},
                JSON_TABLE(${ident(f)}, '$[*]' COLUMNS (v VARCHAR(512) PATH '$')) AS jt
           WHERE ${where.sql}
           GROUP BY jt.v ORDER BY c DESC, value ASC LIMIT 50`
        : `SELECT ${ident(f)} AS value, COUNT(*) AS c
           FROM ${ident(this.table)}
           WHERE ${where.sql} AND ${ident(f)} IS NOT NULL
           GROUP BY ${ident(f)} ORDER BY c DESC, value ASC LIMIT 50`;
      const [rows] = await this.pool.query(sql, where.params);
      out[f] = (rows as Array<{ value: FacetValue; c: number }>).map((r) => ({
        value: r.value,
        count: r.c,
      }));
    }
    return out;
  }

  async hydrate(ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const [rows] = await this.pool.query(
      `SELECT * FROM ${ident(this.table)} WHERE ${ident(this.idField)} IN (${marks})`,
      ids,
    );
    return (rows as Row[]).map((row) => this.normalizeRow(row));
  }

  /** mysql2 may return JSON columns as strings depending on config. */
  private normalizeRow(row: Row): Row {
    const out: Record<string, unknown> = { ...row };
    for (const f of this.multi) {
      const v = out[f];
      if (typeof v === "string") out[f] = JSON.parse(v);
    }
    return out as Row;
  }
}
