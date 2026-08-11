import { NextResponse } from "next/server";
import { z } from "zod";
import { getCells } from "@/lib/lore/column-store";

const BodySchema = z.object({
  columnIds: z.array(z.string()).max(50),
  rowIds: z.array(z.string()).max(200),
});

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const cells = await getCells(parsed.data.columnIds, parsed.data.rowIds);
  return NextResponse.json({ cells });
}
