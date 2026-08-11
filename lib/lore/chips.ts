import type { FilterChip, FilterPredicate } from "@lore/core";
import { PROFILE_FIELDS } from "./fields";

/** Pure chip/label helpers shared by server compiler and client UI. */

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [
    f.name,
    f.name
      .split("_")
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(" "),
  ]),
);

export function predicateLabel(p: FilterPredicate): string {
  switch (p.kind) {
    case "term":
      return `${FIELD_LABELS[p.field]}: ${p.value}`;
    case "terms":
      return `${FIELD_LABELS[p.field]}: ${p.values.slice(0, 2).join(", ")}${
        p.values.length > 2 ? ` +${p.values.length - 2}` : ""
      }`;
    case "range": {
      const parts: string[] = [];
      if (p.min !== undefined) parts.push(`≥ ${p.min}`);
      if (p.max !== undefined) parts.push(`≤ ${p.max}`);
      return `${FIELD_LABELS[p.field]} ${parts.join(" and ")}`;
    }
    case "exists":
      return `Has ${FIELD_LABELS[p.field]}`;
    case "not":
      return `NOT ${predicateLabel(p.predicate)}`;
    case "geo":
      return `${FIELD_LABELS[p.field]} within ${p.radiusMiles}mi`;
    case "text":
      return `"${p.query}"`;
  }
}

export function buildChips(
  all: FilterPredicate[],
  any: FilterPredicate[],
): FilterChip[] {
  const chips: FilterChip[] = all.map((p, i) => ({
    id: `all-${i}`,
    label: predicateLabel(p),
    predicates: [i],
    source: "extracted" as const,
    ...(p.kind === "terms" && p.values.length > 2
      ? { expansions: p.values.map(String) }
      : {}),
  }));
  if (any.length > 0) {
    chips.push({
      id: "any-group",
      label: `Any of: ${any.map(predicateLabel).join(" · ")}`,
      predicates: any.map((_, i) => i),
      source: "extracted",
    });
  }
  return chips;
}
