import { NextResponse } from "next/server";
import { z } from "zod";
import { getColumn, updateColumnPrompt } from "@/lib/lore/column-store";

const PatchSchema = z.object({
  promptTemplate: z.string().min(1),
  model: z.string().optional(),
});

/** Prompt/model edit — bumps prompt_version and records history (sIVM trigger). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const existing = await getColumn(id);
  if (!existing) {
    return NextResponse.json({ error: "column not found" }, { status: 404 });
  }
  const column = await updateColumnPrompt(
    id,
    parsed.data.promptTemplate,
    parsed.data.model,
  );
  return NextResponse.json({ column });
}
