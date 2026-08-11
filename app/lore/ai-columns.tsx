"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ColumnOutputType } from "@lore/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface AiColumnDto {
  id: string;
  name: string;
  prompt_template: string;
  prompt_version: number;
  model: string;
  output_spec: ColumnOutputType;
}

export interface AiCellDto {
  column_id: string;
  row_id: string;
  status: string;
  value: unknown;
  rationale: string | null;
  error: string | null;
}

export function cellKey(columnId: string, rowId: string): string {
  return `${columnId}:${rowId}`;
}

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

export function useAiColumns(visibleRowIds: string[]) {
  const [columns, setColumns] = React.useState<AiColumnDto[]>([]);
  const [cells, setCells] = React.useState<Record<string, AiCellDto>>({});
  const [running, setRunning] = React.useState<Set<string>>(new Set());

  const refreshColumns = React.useCallback(async () => {
    const r = await fetch("/api/lore/columns?tableId=profiles");
    const data = await r.json();
    setColumns(data.columns ?? []);
  }, []);

  React.useEffect(() => {
    void refreshColumns();
  }, [refreshColumns]);

  const refreshCells = React.useCallback(async () => {
    if (columns.length === 0 || visibleRowIds.length === 0) return;
    const r = await fetch("/api/lore/cells", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        columnIds: columns.map((c) => c.id),
        rowIds: visibleRowIds,
      }),
    });
    const data = await r.json();
    setCells((prev) => {
      const next = { ...prev };
      for (const cell of (data.cells ?? []) as AiCellDto[]) {
        next[cellKey(cell.column_id, cell.row_id)] = cell;
      }
      return next;
    });
  }, [columns, visibleRowIds]);

  React.useEffect(() => {
    void refreshCells();
  }, [refreshCells]);

  const runColumn = React.useCallback(
    async (column: AiColumnDto, rowIds: string[]) => {
      if (rowIds.length === 0) return;
      setRunning((prev) => new Set(prev).add(column.id));
      try {
        let r = await fetch(`/api/lore/columns/${column.id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rowIds }),
        });
        let data = await r.json();
        if (data.needsConfirmation) {
          const ok = window.confirm(
            `This run covers ${data.estimate.rowCount} rows, estimated $${data.estimate.estCostUsd.toFixed(4)}. Proceed?`,
          );
          if (!ok) return;
          r = await fetch(`/api/lore/columns/${column.id}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rowIds, confirm: true }),
          });
          data = await r.json();
        }
        if (!r.ok) {
          window.alert(data.error ?? "run failed");
        }
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(column.id);
          return next;
        });
        await refreshCells();
      }
    },
    [refreshCells],
  );

  const certifyColumn = React.useCallback(
    async (column: AiColumnDto, filter: unknown, backend: string) => {
      setRunning((prev) => new Set(prev).add(column.id));
      try {
        const r = await fetch(`/api/lore/columns/${column.id}/certify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter, backend, alpha: 0.1, limit: 500 }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "certify failed");
        window.alert(
          `Certificate over ${data.scope} rows (α=${data.alpha}):\n` +
            `sampled ${data.sampled} · reused ${data.reused} · recompute ${data.recompute}\n` +
            `observed flips in sample: ${data.observedFlips}`,
        );
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "certify failed");
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(column.id);
          return next;
        });
        await refreshCells();
      }
    },
    [refreshCells],
  );

  return {
    columns,
    cells,
    running,
    refreshColumns,
    refreshCells,
    runColumn,
    certifyColumn,
  };
}

// ---------------------------------------------------------------------------
// Add / edit column dialog
// ---------------------------------------------------------------------------

const FIELD_HINTS =
  "{{dev_type}} {{languages}} {{webframes}} {{platforms}} {{tools_tech}} {{years_code_pro}} {{country}} {{industry}} {{ed_level}} {{converted_comp_yearly}}";

export function ColumnDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: AiColumnDto | null;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [kind, setKind] = React.useState<string>("boolean");
  const [options, setOptions] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setPrompt(editing?.prompt_template ?? "");
      setKind(editing?.output_spec.kind ?? "boolean");
      setOptions(
        editing?.output_spec.kind === "select"
          ? editing.output_spec.options.join(", ")
          : "",
      );
      setError(null);
    }
  }, [open, editing]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const outputSpec =
      kind === "select"
        ? {
            kind,
            options: options
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean),
          }
        : { kind };
    try {
      const r = editing
        ? await fetch(`/api/lore/columns/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptTemplate: prompt }),
          })
        : await fetch("/api/lore/columns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              promptTemplate: prompt,
              outputSpec,
            }),
          });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "save failed");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit prompt · v${editing.prompt_version} → v${editing.prompt_version + 1}`
              : "Add AI column"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Editing the prompt creates a new version. Cached cells from the old version stay until recomputed (or certified for reuse)."
              : "Each row is evaluated by a sub-agent with typed output. Reference row fields with {{field}}."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!editing && (
            <Input
              placeholder="Column name, e.g. Data-platform specialist?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <Textarea
            placeholder={`Instruction, e.g. Is this person a data-platform specialist? Consider role {{dev_type}}, databases {{databases}}, and tools {{tools_tech}}.`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
          />
          <p className="text-xs text-muted-foreground">
            Available fields: {FIELD_HINTS}
          </p>
          {!editing && (
            <div className="flex gap-2">
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boolean">Yes / No</SelectItem>
                  <SelectItem value="select">Select</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                </SelectContent>
              </Select>
              {kind === "select" && (
                <Input
                  placeholder="Options, comma-separated"
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                />
              )}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            onClick={() => void save()}
            disabled={saving || !prompt.trim() || (!editing && !name.trim())}
          >
            {saving ? <Spinner className="size-4" /> : null}
            {editing ? "Save as new version" : "Create column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Header + cell renderers
// ---------------------------------------------------------------------------

export function AiColumnHeader({
  column,
  running,
  onRunVisible,
  onEdit,
  onCertify,
}: {
  column: AiColumnDto;
  running: boolean;
  onRunVisible: () => void;
  onEdit: () => void;
  onCertify: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 font-medium hover:text-foreground">
        <span className="text-violet-500">✦</span>
        {column.name}
        {running ? (
          <Spinner className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">
          v{column.prompt_version} · {column.model.split("/")[1]}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onRunVisible}>
          <Play className="size-3.5" /> Run visible rows
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="size-3.5" /> Edit prompt (new version)
        </DropdownMenuItem>
        {column.prompt_version > 1 && (
          <DropdownMenuItem onClick={onCertify}>
            <ShieldCheck className="size-3.5" /> Certify reuse from v
            {column.prompt_version - 1}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AiCellView({ cell }: { cell: AiCellDto | undefined }) {
  if (!cell) return <span className="text-muted-foreground/40">·</span>;
  if (cell.status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger>
          <span className="text-destructive">!</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{cell.error}</TooltipContent>
      </Tooltip>
    );
  }
  if (
    cell.status !== "done" &&
    cell.status !== "cached" &&
    cell.status !== "reused_certified"
  ) {
    return <Spinner className="size-3" />;
  }
  const inner =
    typeof cell.value === "boolean" ? (
      cell.value ? (
        <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" /> Yes
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <X className="size-3" /> No
        </Badge>
      )
    ) : typeof cell.value === "number" ? (
      <span className="tabular-nums">{cell.value}</span>
    ) : (
      <Badge variant="secondary" className="max-w-40 truncate font-normal">
        {String(cell.value)}
      </Badge>
    );
  return (
    <Tooltip>
      <TooltipTrigger className="cursor-default">
        <span className="inline-flex items-center gap-1">
          {inner}
          {cell.status === "reused_certified" && (
            <ShieldCheck className="size-3 text-violet-500" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {cell.rationale ?? "no rationale"}
        {cell.status === "cached" && (
          <span className="block text-[10px] opacity-70">cache hit</span>
        )}
        {cell.status === "reused_certified" && (
          <span className="block text-[10px] opacity-70">
            reused from previous version under a statistical certificate
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function AddColumnButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="gap-1" onClick={onClick}>
      <Plus className="size-3.5" /> AI column
    </Button>
  );
}
