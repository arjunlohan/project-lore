"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import type { FilterSpec, SortSpec } from "@lore/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { buildChips } from "@/lib/lore/chips";
import {
  AddColumnButton,
  AiCellView,
  AiColumnHeader,
  cellKey,
  ColumnDialog,
  useAiColumns,
  type AiColumnDto,
} from "./ai-columns";

type Row = Record<string, unknown>;
type Backend = "elasticsearch" | "mysql" | "hybrid";

interface SearchResponse {
  filter: FilterSpec;
  unmapped: string[];
  backend: string;
  total: number | { relation: string; value: number };
  rows: Row[];
  cursor?: string;
  timing: { compileMs: number; executeMs: number; totalMs: number };
  error?: string;
}

const DISPLAY_COLUMNS: Array<{
  key: string;
  label: string;
  numeric?: boolean;
  sortable?: boolean;
}> = [
  { key: "response_id", label: "#", numeric: true },
  { key: "dev_type", label: "Role" },
  { key: "country", label: "Country" },
  { key: "years_code_pro", label: "Yrs Pro", numeric: true, sortable: true },
  { key: "languages", label: "Languages" },
  { key: "remote_work", label: "Work Mode" },
  {
    key: "converted_comp_yearly",
    label: "Comp (USD)",
    numeric: true,
    sortable: true,
  },
  { key: "ed_level", label: "Education" },
];

const EXAMPLES = [
  "senior Rust developers in Germany or France making over $100k",
  "students who know Python but not Java",
  "remote data scientists with 3 to 8 years of experience using PostgreSQL",
];

export function LoreSearch() {
  const [query, setQuery] = React.useState("");
  const [backend, setBackend] = React.useState<Backend>("elasticsearch");
  const [sort, setSort] = React.useState<SortSpec | undefined>();
  const [res, setRes] = React.useState<SearchResponse | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [columnDialog, setColumnDialog] = React.useState<{
    open: boolean;
    editing: AiColumnDto | null;
  }>({ open: false, editing: null });

  const visibleRowIds = React.useMemo(
    () => rows.map((r) => String(r.response_id)),
    [rows],
  );
  const ai = useAiColumns(visibleRowIds);

  const run = React.useCallback(
    async (body: Record<string, unknown>, append = false) => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch("/api/lore/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await r.json()) as SearchResponse;
        if (!r.ok) throw new Error(data.error ?? "search failed");
        setRes(data);
        setRows((prev) => (append ? [...prev, ...data.rows] : data.rows));
      } catch (e) {
        setError(e instanceof Error ? e.message : "search failed");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const search = (q: string) => {
    setSort(undefined);
    void run({ q, backend });
  };

  const rerun = (filter: FilterSpec, opts?: { sort?: SortSpec; backend?: Backend }) =>
    void run({
      filter,
      backend: opts?.backend ?? backend,
      sort: opts?.sort ?? sort,
    });

  const removeChip = (chipId: string) => {
    if (!res) return;
    const { filter } = res;
    let all = filter.all;
    let any = filter.any ?? [];
    if (chipId === "any-group") {
      any = [];
    } else {
      const idx = Number(chipId.replace("all-", ""));
      all = all.filter((_, i) => i !== idx);
    }
    const next: FilterSpec = {
      schemaVersion: 1,
      all,
      ...(any.length > 0 ? { any } : {}),
      chips: buildChips(all, any),
    };
    rerun(next);
  };

  const toggleSort = (field: string) => {
    const next: SortSpec | undefined =
      sort?.kind === "field" && sort.field === field && sort.dir === "desc"
        ? { kind: "field", field, dir: "asc" }
        : sort?.kind === "field" && sort.field === field && sort.dir === "asc"
          ? undefined
          : { kind: "field", field, dir: "desc" };
    setSort(next);
    if (res) rerun(res.filter, { sort: next });
  };

  const switchBackend = (b: Backend) => {
    setBackend(b);
    if (res) rerun(res.filter, { backend: b });
  };

  const total =
    typeof res?.total === "number" ? res.total : (res?.total?.value ?? 0);
  const chips = res?.filter.chips ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">lore</h1>
          <p className="text-sm text-muted-foreground">
            Ask in plain language · runs as deterministic filters · 89,184 real
            developer profiles
          </p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={backend}
          onValueChange={(v) => v && switchBackend(v as Backend)}
        >
          <ToggleGroupItem value="elasticsearch">Elasticsearch</ToggleGroupItem>
          <ToggleGroupItem value="mysql">MySQL</ToggleGroupItem>
          <ToggleGroupItem value="hybrid">Hybrid</ToggleGroupItem>
        </ToggleGroup>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search(query.trim());
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Try "senior Rust developers in Germany or France making over $100k"'
          className="h-10"
        />
        <Button type="submit" disabled={loading} className="h-10 gap-2">
          {loading ? <Spinner className="size-4" /> : <Search className="size-4" />}
          Search
        </Button>
      </form>

      {!res && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setQuery(ex);
                search(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {res && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <Badge key={chip.id} variant="secondary" className="gap-1 pr-1">
              {chip.label}
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => removeChip(chip.id)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          {chips.length === 0 && (
            <span className="text-sm text-muted-foreground">
              No filters · showing everyone
            </span>
          )}
          {res.unmapped.length > 0 && (
            <span className="text-xs text-muted-foreground">
              couldn&apos;t map: {res.unmapped.join(", ")}
            </span>
          )}
          <span className="ml-auto flex items-center gap-3 text-sm tabular-nums text-muted-foreground">
            <strong className="text-foreground">{total.toLocaleString()}</strong>{" "}
            matches
            <AddColumnButton
              onClick={() => setColumnDialog({ open: true, editing: null })}
            />
          </span>
        </div>
      )}

      {res && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {DISPLAY_COLUMNS.map((c) => (
                  <TableHead
                    key={c.key}
                    className={c.numeric ? "text-right" : undefined}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => toggleSort(c.key)}
                      >
                        {c.label}
                        {sort?.kind === "field" && sort.field === c.key ? (
                          sort.dir === "desc" ? (
                            <ArrowDown className="size-3" />
                          ) : (
                            <ArrowUp className="size-3" />
                          )
                        ) : null}
                      </button>
                    ) : (
                      c.label
                    )}
                  </TableHead>
                ))}
                {ai.columns.map((col) => (
                  <TableHead key={col.id}>
                    <AiColumnHeader
                      column={col}
                      running={ai.running.has(col.id)}
                      onRunVisible={() => void ai.runColumn(col, visibleRowIds)}
                      onEdit={() =>
                        setColumnDialog({ open: true, editing: col })
                      }
                      onCertify={() =>
                        void ai.certifyColumn(col, res?.filter, backend)
                      }
                    />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={String(row.response_id)}>
                  {DISPLAY_COLUMNS.map((c) => (
                    <TableCell
                      key={c.key}
                      className={
                        c.numeric
                          ? "text-right tabular-nums"
                          : "max-w-56 truncate"
                      }
                    >
                      <CellValue value={row[c.key]} column={c.key} />
                    </TableCell>
                  ))}
                  {ai.columns.map((col) => (
                    <TableCell key={col.id}>
                      <AiCellView
                        cell={
                          ai.cells[cellKey(col.id, String(row.response_id))]
                        }
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell
                    colSpan={DISPLAY_COLUMNS.length + ai.columns.length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No matches. Loosen a chip and try again.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {res && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {rows.length.toLocaleString()} of {total.toLocaleString()} ·{" "}
            {res.backend}
            {res.timing.compileMs > 0 &&
              ` · compiled ${res.timing.compileMs}ms`}{" "}
            · executed {res.timing.executeMs}ms
          </span>
          {res.cursor && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() =>
                void run(
                  { filter: res.filter, backend, sort, cursor: res.cursor },
                  true,
                )
              }
            >
              Load more
            </Button>
          )}
        </div>
      )}

      <ColumnDialog
        open={columnDialog.open}
        onOpenChange={(open) =>
          setColumnDialog((s) => ({ ...s, open }))
        }
        editing={columnDialog.editing}
        onSaved={() => void ai.refreshColumns()}
      />
    </div>
  );
}

function CellValue({ value, column }: { value: unknown; column: string }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/50">—</span>;
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3);
    return (
      <span className="flex flex-wrap gap-1">
        {shown.map((v) => (
          <Badge key={String(v)} variant="outline" className="font-normal">
            {String(v)}
          </Badge>
        ))}
        {value.length > 3 && (
          <span className="text-xs text-muted-foreground">
            +{value.length - 3}
          </span>
        )}
      </span>
    );
  }
  if (column === "converted_comp_yearly") {
    return <>{`$${Number(value).toLocaleString()}`}</>;
  }
  return <>{String(value)}</>;
}
