import { NextResponse } from "next/server";
import { z } from "zod";
import type { FilterSpec, SortSpec } from "@lore/core";
import { adapterFor, type BackendId } from "@/lib/lore/adapters";
import { compileQuery } from "@/lib/lore/compile-query";

/**
 * One endpoint, two modes:
 * - { q } compiles natural language to a FilterSpec (the only LLM step),
 *   then executes it deterministically;
 * - { filter } executes a (possibly user-edited) FilterSpec directly with
 *   no LLM involved. Same filter always returns the same results.
 */

const BodySchema = z.object({
  q: z.string().optional(),
  filter: z.custom<FilterSpec>().optional(),
  cursor: z.string().optional(),
  sort: z.custom<SortSpec>().optional(),
  backend: z.enum(["elasticsearch", "mysql", "hybrid"]).default("elasticsearch"),
  facets: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { q, cursor, sort, backend, facets, limit } = parsed.data;

  try {
    const started = Date.now();
    let filter = parsed.data.filter;
    let unmapped: string[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let compileMs = 0;

    if (!filter) {
      if (!q || q.trim() === "") {
        filter = { schemaVersion: 1, all: [] };
      } else {
        const t0 = Date.now();
        const compiled = await compileQuery(q);
        compileMs = Date.now() - t0;
        filter = compiled.filter;
        unmapped = compiled.unmapped;
        usage = compiled.usage;
      }
    }

    const adapter = adapterFor(backend as BackendId);
    const t1 = Date.now();
    const [page, facetData] = await Promise.all([
      adapter.search(filter, { limit, cursor, sort }),
      facets.length > 0
        ? adapter.aggregate(filter, facets)
        : Promise.resolve({}),
    ]);

    return NextResponse.json({
      filter,
      unmapped,
      usage,
      backend: adapter.id,
      total: page.total,
      rows: page.rows,
      cursor: page.cursor,
      facets: facetData,
      timing: {
        compileMs,
        executeMs: Date.now() - t1,
        totalMs: Date.now() - started,
      },
    });
  } catch (err) {
    console.error("lore/search error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "search failed" },
      { status: 500 },
    );
  }
}
