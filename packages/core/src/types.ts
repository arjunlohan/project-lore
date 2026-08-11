/**
 * @lore/core SPI — the contracts that make the framework portable.
 *
 * Three planes, deliberately decoupled:
 *  1. Retrieval plane: a versioned FilterSpec compiled deterministically by a
 *     DataSourceAdapter (MySQL, Elasticsearch, or ES-search + SQL-hydrate).
 *     The NL compiler is the only probabilistic step; execution is replayable.
 *  2. Enrichment plane: AI columns as materialized views V = (prompt, model,
 *     tools). Each cell is a cached, cost-gated job keyed by content hash.
 *  3. Maintenance plane (sIVM): when V changes, certify which cached cells can
 *     be reused under an FDR bound instead of recomputing everything.
 */

// ---------------------------------------------------------------------------
// Retrieval plane
// ---------------------------------------------------------------------------

/** Scalar facet value. */
export type FacetValue = string | number | boolean;

export type FilterPredicate =
  | { kind: "term"; field: string; value: FacetValue }
  | { kind: "terms"; field: string; values: FacetValue[] }
  | { kind: "range"; field: string; min?: number; max?: number }
  | {
      kind: "geo";
      field: string;
      lat: number;
      lon: number;
      radiusMiles: number;
    }
  | { kind: "text"; fields: string[]; query: string }
  | { kind: "exists"; field: string }
  | { kind: "not"; predicate: FilterPredicate };

/**
 * The versioned contract between the NL compiler (probabilistic) and adapters
 * (deterministic). Same FilterSpec must always produce the same result set on
 * the same data. `chips` carries UI-editable provenance (e.g. synonym
 * expansions) without affecting execution.
 */
export interface FilterSpec {
  schemaVersion: 1;
  all: FilterPredicate[];
  any?: FilterPredicate[];
  /** Free-text semantic query for hybrid BM25/kNN retrieval, if supported. */
  semantic?: { query: string; topK?: number };
  chips?: FilterChip[];
}

/** UI-editable provenance for one extracted predicate. */
export interface FilterChip {
  id: string;
  label: string;
  /** Predicate indices in `all`/`any` this chip controls. */
  predicates: number[];
  source: "extracted" | "expanded" | "user";
  /** e.g. title synonym expansion members shown as "+9". */
  expansions?: string[];
}

export interface FieldDef {
  name: string;
  type: "keyword" | "text" | "integer" | "float" | "boolean" | "date" | "geo";
  /** True when a row holds a set of values (ES array / SQL JSON array). */
  multiValued?: boolean;
  /** Enumerable vocabulary (fed to the NL compiler for schema linking). */
  values?: FacetValue[];
  description?: string;
}

/** What a backend can do; the planner routes work accordingly. */
export interface AdapterCapabilities {
  liveCounts: boolean;
  aggregations: boolean;
  geo: boolean;
  fullText: boolean;
  vectorSearch: boolean;
}

export interface SearchPage<Row> {
  rows: Row[];
  total: number | { relation: "gte"; value: number };
  cursor?: string;
}

/**
 * The pluggable backend. Implementations: adapter-mysql, adapter-elasticsearch,
 * and the hybrid wrapper (ES for search/counts, SQL as source-of-truth
 * hydration by id).
 */
export interface DataSourceAdapter<Row = Record<string, unknown>> {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  fields(): Promise<FieldDef[]>;
  count(filter: FilterSpec): Promise<number>;
  search(
    filter: FilterSpec,
    opts?: { limit?: number; cursor?: string; sort?: SortSpec },
  ): Promise<SearchPage<Row>>;
  /** Facet value histograms for live drill-down counts. */
  aggregate(
    filter: FilterSpec,
    fields: string[],
  ): Promise<Record<string, Array<{ value: FacetValue; count: number }>>>;
  /** Fetch full rows by primary id (hybrid hydration path). */
  hydrate(ids: string[]): Promise<Row[]>;
}

export type SortSpec =
  | { kind: "field"; field: string; dir: "asc" | "desc" }
  | { kind: "column"; columnId: string; dir: "asc" | "desc" };

// ---------------------------------------------------------------------------
// Enrichment plane — AI columns
// ---------------------------------------------------------------------------

/** Typed output contract for a column (JSON-schema-constrained generation). */
export type ColumnOutputType =
  | { kind: "text" }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "select"; options: string[] }
  | { kind: "url" }
  | { kind: "json"; schema: Record<string, unknown> };

/**
 * An AI column is a materialized view V = (prompt, model, tools) over rows.
 * promptVersion increments on every edit; sIVM certifies reuse across
 * versions.
 */
export interface ColumnDef {
  id: string;
  tableId: string;
  name: string;
  kind: "source" | "formula" | "ai";
  /** Prompt template with {{field}} bindings to row fields / other columns. */
  promptTemplate?: string;
  promptVersion: number;
  model?: string;
  output: ColumnOutputType;
  /** Tool adapter ids the per-cell sub-agent may call. */
  tools?: string[];
  toolVersion?: number;
  /** "Only run if" predicate to skip rows (cost control). */
  runCondition?: FilterSpec;
  autoRunNewRows: boolean;
}

export type CellStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cached"
  | "reused_certified";

/** Cache identity for one computed cell. */
export interface CellKey {
  rowContentHash: string;
  columnId: string;
  promptVersion: number;
  model: string;
  toolVersion: number;
}

export interface CellRecord<Value = unknown> {
  key: CellKey;
  rowId: string;
  status: CellStatus;
  value?: Value;
  error?: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs?: number;
  /** Set when value was reused from a prior version under a certificate. */
  certificateId?: string;
  updatedAt: string;
}

/** Pre-run estimate surfaced to the user before any fan-out (Clay-style gate). */
export interface RunEstimate {
  rowCount: number;
  estInputTokens: number;
  estOutputTokens: number;
  estCostUsd: number;
  requiresConfirmation: boolean;
  reason?: "over_budget_fraction" | "over_absolute_threshold";
}

export interface CostLedgerEntry {
  at: string;
  tableId: string;
  columnId: string;
  model: string;
  cells: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Maintenance plane — sIVM
// ---------------------------------------------------------------------------

/**
 * Taxonomy of prompt edits. Some classes admit deterministic reuse (formatting)
 * or one-sided safety (scope_narrowing on boolean columns: cached FALSE stays
 * FALSE), which shrinks the certification domain before any sampling.
 */
export type EditClass =
  | "formatting_only"
  | "synonym_rewording"
  | "scope_narrowing"
  | "scope_widening"
  | "new_criterion"
  | "full_rewrite";

export interface PromptDelta {
  columnId: string;
  fromVersion: number;
  toVersion: number;
  editClass: EditClass;
  /** Span-level diff of the prompt text. */
  spans: Array<{ op: "insert" | "delete" | "replace"; text: string }>;
}

/** A stratum of rows sharing an interaction-risk level with the edit. */
export interface Stratum {
  id: string;
  /** Predicted P(cell flips) bucket, higher = more at risk. */
  riskBucket: number;
  rowIds: string[];
}

export interface StratumBound {
  stratumId: string;
  sampled: number;
  agreements: number;
  empiricalMean: number;
  empiricalVariance: number;
  /** Empirical-Bernstein lower confidence bound on agreement probability. */
  lowerBound: number;
  pValue: number;
}

/**
 * The output artifact of a certification run: which cached cells may be reused
 * across V -> V' with expected false-reuse rate <= alpha (BH-FDR across
 * strata).
 */
export interface ReuseCertificate {
  id: string;
  columnId: string;
  fromVersion: number;
  toVersion: number;
  alpha: number;
  delta: PromptDelta;
  strata: StratumBound[];
  reusedRowIds: string[];
  recomputeRowIds: string[];
  sampledRowIds: string[];
  /** Realized spend on verification sampling. */
  verificationCostUsd: number;
  createdAt: string;
}

/** Per-column-type equivalence used to score agreement A_i. */
export type EquivalenceSpec =
  | { kind: "exact" }
  | { kind: "numeric"; tolerance: number }
  | { kind: "semantic"; embedModel: string; minSimilarity: number };
