/**
 * NL -> FilterSpec compiler: the ONLY probabilistic step in the retrieval
 * plane. One structured-output call maps free text onto the versioned filter
 * schema, grounded in the live field catalog + value vocabulary (schema
 * linking). Execution of the result is fully deterministic and replayable;
 * users edit the result as chips without re-invoking the LLM.
 */
import { generateObject } from "ai";
import { z } from "zod";
import type { FilterPredicate, FilterSpec } from "@lore/core";
import { esAdapter } from "./adapters";
import { buildChips } from "./chips";
import { PROFILE_FIELDS } from "./fields";
import { CELL_DECODE, DEFAULT_MODEL } from "./models";

const KEYWORD_FIELDS = PROFILE_FIELDS.filter((f) => f.type === "keyword").map(
  (f) => f.name,
);
const NUMERIC_FIELDS = PROFILE_FIELDS.filter((f) => f.type === "float").map(
  (f) => f.name,
);

const keywordField = z.enum(KEYWORD_FIELDS as [string, ...string[]]);
const numericField = z.enum(NUMERIC_FIELDS as [string, ...string[]]);

const TermSchema = z.object({
  kind: z.literal("term"),
  field: keywordField,
  value: z.string(),
});
const TermsSchema = z.object({
  kind: z.literal("terms"),
  field: keywordField,
  values: z.array(z.string()).min(1),
});
const RangeSchema = z.object({
  kind: z.literal("range"),
  field: numericField,
  min: z.number().optional(),
  max: z.number().optional(),
});
const ExistsSchema = z.object({
  kind: z.literal("exists"),
  field: z.enum([...KEYWORD_FIELDS, ...NUMERIC_FIELDS] as [string, ...string[]]),
});
const InnerPredicate = z.discriminatedUnion("kind", [
  TermSchema,
  TermsSchema,
  RangeSchema,
  ExistsSchema,
]);
const NotSchema = z.object({
  kind: z.literal("not"),
  predicate: InnerPredicate,
});
const PredicateSchema = z.discriminatedUnion("kind", [
  TermSchema,
  TermsSchema,
  RangeSchema,
  ExistsSchema,
  NotSchema,
]);

const CompileOutput = z.object({
  all: z
    .array(PredicateSchema)
    .describe("Predicates that must ALL hold (AND semantics)"),
  any: z
    .array(PredicateSchema)
    .describe("Optional OR group: at least one must hold; empty if unused"),
  unmapped: z
    .array(z.string())
    .describe(
      "Parts of the query that could not be mapped to any field; empty if none",
    ),
});

export interface CompiledQuery {
  filter: FilterSpec;
  unmapped: string[];
  usage: { inputTokens: number; outputTokens: number };
}

// ---------------------------------------------------------------------------
// Vocabulary: top values per keyword field, computed live and cached.
// ---------------------------------------------------------------------------

let vocabCache: { at: number; text: string } | null = null;
const VOCAB_TTL_MS = 60 * 60 * 1000;

async function vocabulary(): Promise<string> {
  if (vocabCache && Date.now() - vocabCache.at < VOCAB_TTL_MS) {
    return vocabCache.text;
  }
  const agg = await esAdapter().aggregate(
    { schemaVersion: 1, all: [] },
    KEYWORD_FIELDS,
  );
  const lines = PROFILE_FIELDS.map((f) => {
    const base = `- ${f.name} (${f.type}${f.multiValued ? ", multi-valued" : ""}): ${f.description ?? ""}`;
    const buckets = agg[f.name];
    if (!buckets || buckets.length === 0) return base;
    const vals = buckets
      .slice(0, 40)
      .map((b) => JSON.stringify(b.value))
      .join(", ");
    return `${base}\n  values: ${vals}`;
  });
  vocabCache = { at: Date.now(), text: lines.join("\n") };
  return vocabCache.text;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const SYSTEM = `You compile a recruiter-style natural-language query over a table of
89,184 developer profiles (Stack Overflow Survey 2023) into structured filter
predicates. Use ONLY the fields and, for keyword fields, ONLY values from the
vocabulary below (values are exact, case-sensitive strings). Rules:
- "senior"/"experienced" means years_code_pro >= 5 unless a number is given;
  "junior" means years_code_pro <= 2.
- Salary/compensation amounts map to converted_comp_yearly (USD).
- Students: main_branch "I am learning to code" OR employment containing
  "Student, full-time" / "Student, part-time" (use the any group).
- Negations ("not", "without", "excluding") compile to kind:"not".
- Multiple alternatives of the same facet ("Germany or France") compile to one
  kind:"terms" predicate, not an any-group.
- Use the any group ONLY for genuine cross-field OR requirements.
- Anything unmappable to these fields goes into unmapped, verbatim; never
  invent fields or values. Prefer precision over recall.

OUTPUT SHAPE — return a JSON object with EXACTLY these top-level keys:
"all" (array of predicates, AND), "any" (array of predicates, OR group, [] if
unused), "unmapped" (array of strings, [] if none). Predicate shapes, exactly:
  {"kind":"term","field":<field>,"value":<string>}
  {"kind":"terms","field":<field>,"values":[<string>,...]}
  {"kind":"range","field":<numeric field>,"min":<number>,"max":<number>} (min and/or max)
  {"kind":"exists","field":<field>}
  {"kind":"not","predicate":<one of the above>}
No other keys. Ranges use "min"/"max", never gt/gte/lt/lte.

<example>
Query: "remote TypeScript devs in Canada, not managers, 4+ years pro, or anyone at a 10k+ company"
{"all":[{"kind":"term","field":"remote_work","value":"Remote"},{"kind":"term","field":"languages","value":"TypeScript"},{"kind":"term","field":"country","value":"Canada"},{"kind":"not","predicate":{"kind":"term","field":"ic_or_pm","value":"People manager"}},{"kind":"range","field":"years_code_pro","min":4}],"any":[{"kind":"term","field":"org_size","value":"10,000 or more employees"}],"unmapped":[]}
</example>`;

export async function compileQuery(query: string): Promise<CompiledQuery> {
  const vocab = await vocabulary();
  const res = await generateObject({
    model: DEFAULT_MODEL,
    schema: CompileOutput,
    // Pinned like CELL_DECODE: at default sampling temperature this model
    // self-disagrees on 9.5% of draws vs 5.0% at T=0 (measured in the
    // paper), and an unpinned compile occasionally emits degenerate specs
    // (e.g. "NOT 38 languages" instead of "languages = Rust").
    ...CELL_DECODE,
    system: `${SYSTEM}\n\nFIELD CATALOG AND VOCABULARY:\n${vocab}`,
    prompt: `Query: ${JSON.stringify(query)}`,
  });
  const { all, any, unmapped } = res.object;
  const filter: FilterSpec = {
    schemaVersion: 1,
    all: all as FilterPredicate[],
    ...(any.length > 0 ? { any: any as FilterPredicate[] } : {}),
    chips: buildChips(all as FilterPredicate[], any as FilterPredicate[]),
  };
  return {
    filter,
    unmapped,
    usage: {
      inputTokens: res.usage.inputTokens ?? 0,
      outputTokens: res.usage.outputTokens ?? 0,
    },
  };
}

// Chip building lives in ./chips (pure, shared with the client UI).
