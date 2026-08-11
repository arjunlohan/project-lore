import { NextResponse } from "next/server";
import { z } from "zod";
import type { FilterSpec } from "@lore/core";
import { adapterFor, type BackendId } from "@/lib/lore/adapters";
import { certifyColumnEdit } from "@/lib/lore/certify";
import {
  getCellsForVersion,
  getColumn,
  getColumnVersion,
  recordLedger,
} from "@/lib/lore/column-store";
import { PROFILE_ID_FIELD } from "@/lib/lore/fields";
import { runColumn } from "@/lib/lore/run-column";

const BodySchema = z.object({
  filter: z.custom<FilterSpec>().optional(),
  backend: z.enum(["elasticsearch", "mysql", "hybrid"]).default("mysql"),
  alpha: z.number().min(0.01).max(0.5).default(0.1),
  delta: z.number().min(0.01).max(0.5).default(0.1),
  /** Scope cap: how many rows of the current filter the certificate covers. */
  limit: z.number().int().min(50).max(2000).default(500),
});

/**
 * Production sIVM: certify reuse of the previous version's cached cells for
 * the current version over the given filter scope. The oracle is the live
 * runner (sampled rows get real fresh v_to computations, which also
 * materializes them). Certified rows get reused_certified cells; the rest
 * stay empty pending recompute.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const column = await getColumn(id);
  if (!column) {
    return NextResponse.json({ error: "column not found" }, { status: 404 });
  }
  if (column.prompt_version < 2) {
    return NextResponse.json(
      { error: "no previous version to reuse from" },
      { status: 400 },
    );
  }
  const fromVersion = column.prompt_version - 1;
  const toVersion = column.prompt_version;
  const vTo = await getColumnVersion(id, toVersion);
  if (!vTo) {
    return NextResponse.json({ error: "version missing" }, { status: 500 });
  }

  try {
    const adapter = adapterFor(parsed.data.backend as BackendId);
    const filter: FilterSpec = parsed.data.filter ?? {
      schemaVersion: 1,
      all: [],
    };
    const page = await adapter.search(filter, { limit: parsed.data.limit });
    const rows = page.rows;
    const rowById = new Map(
      rows.map((r) => [String(r[PROFILE_ID_FIELD]), r]),
    );

    const outcome = await certifyColumnEdit(
      column,
      fromVersion,
      toVersion,
      rows,
      PROFILE_ID_FIELD,
      async (rowIds) => {
        // Live oracle: really compute v_to for the sample.
        const sampleRows = rowIds
          .map((rid) => rowById.get(rid))
          .filter((r): r is NonNullable<typeof r> => r !== undefined);
        await runColumn(column, sampleRows, PROFILE_ID_FIELD, {
          concurrency: 8,
          versionOverride: {
            promptTemplate: vTo.prompt_template,
            promptVersion: toVersion,
          },
        });
        const fresh = (
          await getCellsForVersion(column.id, toVersion, rowIds)
        ).filter((c) => c.status === "done" || c.status === "cached");
        return new Map(fresh.map((c) => [c.row_id, c.value]));
      },
      {
        alpha: parsed.data.alpha,
        delta: parsed.data.delta,
        apply: true,
      },
    );

    await recordLedger({
      kind: "verify",
      columnId: column.id,
      model: column.model,
      cells: outcome.oracleCalls,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });

    return NextResponse.json({
      certificateId: outcome.certificateId,
      scope: rows.length,
      sampled: outcome.oracleCalls,
      reused: outcome.reusedRowIds.length,
      recompute: outcome.recomputeRowIds.length,
      observedFlips: outcome.observedFlips,
      strata: outcome.strata,
      alpha: parsed.data.alpha,
    });
  } catch (err) {
    console.error("certify error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "certify failed" },
      { status: 500 },
    );
  }
}
