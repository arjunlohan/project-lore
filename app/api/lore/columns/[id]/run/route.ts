import { NextResponse } from "next/server";
import { z } from "zod";
import { adapterFor, type BackendId } from "@/lib/lore/adapters";
import { getColumn } from "@/lib/lore/column-store";
import { PROFILE_ID_FIELD } from "@/lib/lore/fields";
import { estimateRun, runColumn } from "@/lib/lore/run-column";

const RunSchema = z.object({
  rowIds: z.array(z.string()).min(1).max(500),
  backend: z.enum(["elasticsearch", "mysql", "hybrid"]).default("mysql"),
  confirm: z.boolean().default(false),
});

/**
 * Two-step cost gate (Clay-style): without confirm=true this only returns the
 * estimate; the run happens when the client confirms. Synchronous execution is
 * capped at 500 rows — larger scopes go through the (later) job runner.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = RunSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const column = await getColumn(id);
  if (!column) {
    return NextResponse.json({ error: "column not found" }, { status: 404 });
  }

  const rows = await adapterFor(parsed.data.backend as BackendId).hydrate(
    parsed.data.rowIds,
  );
  const estimate = estimateRun(column, rows);

  if (!parsed.data.confirm && estimate.requiresConfirmation) {
    return NextResponse.json({ estimate, needsConfirmation: true });
  }

  try {
    const result = await runColumn(column, rows, PROFILE_ID_FIELD);
    return NextResponse.json({ estimate, result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "run failed" },
      { status: 402 },
    );
  }
}
