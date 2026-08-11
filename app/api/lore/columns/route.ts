import { NextResponse } from "next/server";
import { z } from "zod";
import { createColumn, listColumns } from "@/lib/lore/column-store";
import { DEFAULT_MODEL } from "@/lib/lore/models";
import { templateFields } from "@/lib/lore/run-column";
import { PROFILE_FIELDS } from "@/lib/lore/fields";

const OutputSpecSchema = z.union([
  z.object({ kind: z.literal("text") }),
  z.object({
    kind: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ kind: z.literal("boolean") }),
  z.object({ kind: z.literal("select"), options: z.array(z.string()).min(2) }),
]);

const CreateSchema = z.object({
  tableId: z.string().default("profiles"),
  name: z.string().min(1).max(120),
  promptTemplate: z.string().min(1),
  model: z.string().default(DEFAULT_MODEL),
  outputSpec: OutputSpecSchema,
});

const KNOWN_FIELDS = new Set(PROFILE_FIELDS.map((f) => f.name));

export async function GET(req: Request) {
  const tableId =
    new URL(req.url).searchParams.get("tableId") ?? "profiles";
  return NextResponse.json({ columns: await listColumns(tableId) });
}

export async function POST(req: Request) {
  const parsed = CreateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const unknown = templateFields(parsed.data.promptTemplate).filter(
    (f) => !KNOWN_FIELDS.has(f),
  );
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `unknown template fields: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }
  const column = await createColumn(parsed.data);
  return NextResponse.json({ column });
}
