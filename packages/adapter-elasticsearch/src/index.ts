/**
 * Elasticsearch DataSourceAdapter: compiles a FilterSpec into a deterministic
 * `bool` query (hard predicates in filter context, so results are cacheable
 * and reproducible) and serves counts, pages, and facet aggregations.
 *
 * Null semantics contract (must match adapter-mysql exactly):
 * - a predicate never matches a row whose field is missing/null/empty-array;
 * - `not(p)` matches every row p does not match, INCLUDING rows where the
 *   field is missing.
 */
import { Client } from "@elastic/elasticsearch";
import type {
  AggregationsAggregationContainer,
  SortCombinations,
} from "@elastic/elasticsearch/lib/api/types";
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

export interface EsAdapterOptions {
  node: string;
  index: string;
  fields: FieldDef[];
  /** Primary-key field used for hydrate()/mget. */
  idField: string;
}

type EsQuery = Record<string, unknown>;

export function compilePredicate(p: FilterPredicate): EsQuery {
  switch (p.kind) {
    case "term":
      return { term: { [p.field]: p.value } };
    case "terms":
      return { terms: { [p.field]: p.values } };
    case "range": {
      const range: Record<string, number> = {};
      if (p.min !== undefined) range.gte = p.min;
      if (p.max !== undefined) range.lte = p.max;
      return { range: { [p.field]: range } };
    }
    case "geo":
      return {
        geo_distance: {
          distance: `${p.radiusMiles}mi`,
          [p.field]: { lat: p.lat, lon: p.lon },
        },
      };
    case "text":
      return {
        multi_match: { query: p.query, fields: p.fields },
      };
    case "exists":
      return { exists: { field: p.field } };
    case "not":
      return { bool: { must_not: [compilePredicate(p.predicate)] } };
  }
}

export function compileFilterSpec(spec: FilterSpec): EsQuery {
  const filter = spec.all.map(compilePredicate);
  const bool: Record<string, unknown> = { filter };
  if (spec.any && spec.any.length > 0) {
    bool.should = spec.any.map(compilePredicate);
    bool.minimum_should_match = 1;
  }
  return { bool };
}

export class ElasticsearchAdapter<Row extends Record<string, unknown>>
  implements DataSourceAdapter<Row>
{
  readonly id: string;
  readonly capabilities: AdapterCapabilities = {
    liveCounts: true,
    aggregations: true,
    geo: true,
    fullText: true,
    vectorSearch: false,
  };
  private client: Client;
  private index: string;
  private fieldDefs: FieldDef[];
  private idField: string;

  constructor(opts: EsAdapterOptions) {
    this.id = `elasticsearch:${opts.index}`;
    this.client = new Client({ node: opts.node });
    this.index = opts.index;
    this.fieldDefs = opts.fields;
    this.idField = opts.idField;
  }

  async fields(): Promise<FieldDef[]> {
    return this.fieldDefs;
  }

  async count(filter: FilterSpec): Promise<number> {
    const res = await this.client.count({
      index: this.index,
      query: compileFilterSpec(filter),
    });
    return res.count;
  }

  async search(
    filter: FilterSpec,
    opts?: { limit?: number; cursor?: string; sort?: SortSpec },
  ): Promise<SearchPage<Row>> {
    const limit = opts?.limit ?? 50;
    const from = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const sort: SortCombinations[] = [];
    if (opts?.sort?.kind === "field") {
      // Mirror MySQL native NULL ordering (NULLs first ASC, last DESC) so
      // sorted pages are identical across adapters.
      sort.push({
        [opts.sort.field]: {
          order: opts.sort.dir,
          missing: opts.sort.dir === "asc" ? "_first" : "_last",
        },
      });
    }
    sort.push({ [this.idField]: { order: "asc" } });

    const res = await this.client.search<Row>({
      index: this.index,
      query: compileFilterSpec(filter),
      size: limit,
      from,
      sort,
      track_total_hits: true,
    });
    const total =
      typeof res.hits.total === "number"
        ? res.hits.total
        : (res.hits.total?.value ?? 0);
    const rows = res.hits.hits
      .map((h) => h._source)
      .filter((s): s is Row => s !== undefined);
    const next = from + rows.length;
    return {
      rows,
      total,
      cursor: next < total ? String(next) : undefined,
    };
  }

  async aggregate(
    filter: FilterSpec,
    fields: string[],
  ): Promise<Record<string, Array<{ value: FacetValue; count: number }>>> {
    const aggs: Record<string, AggregationsAggregationContainer> = {};
    for (const f of fields) {
      aggs[f] = { terms: { field: f, size: 50 } };
    }
    const res = await this.client.search({
      index: this.index,
      query: compileFilterSpec(filter),
      size: 0,
      aggs,
    });
    const out: Record<string, Array<{ value: FacetValue; count: number }>> =
      {};
    for (const f of fields) {
      const agg = res.aggregations?.[f] as
        | { buckets: Array<{ key: FacetValue; doc_count: number }> }
        | undefined;
      out[f] =
        agg?.buckets.map((b) => ({ value: b.key, count: b.doc_count })) ?? [];
    }
    return out;
  }

  async hydrate(ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    const res = await this.client.mget<Row>({
      index: this.index,
      ids,
    });
    return res.docs
      .map((d) => ("_source" in d ? d._source : undefined))
      .filter((s): s is Row => s !== undefined);
  }
}
