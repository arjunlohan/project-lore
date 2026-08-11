/**
 * The five evaluated edit pairs, defined ONCE.
 *
 * Why this file exists: the pair-to-column mapping used to live only inside
 * exp8-final-table.ts as match predicates, and nothing downstream could see
 * it. Four separate times a prose sentence in the paper asserted that two
 * flip rates came from the same column when they did not: `so-synonym` runs
 * on the lab replica and `so-widening` on the production column, which is
 * invisible unless you read the predicates. Making the mapping data, and
 * emitting it as provenance beside the macros, lets check-paper-numbers.ts
 * verify a "same column" claim instead of the author re-deriving it by hand
 * and getting it wrong again.
 */
export interface PairDef {
  key: string;
  label: string;
  corpus: "profiles" | "djinni";
  /** Stable identifier for the materialized column the pair is measured on. */
  column: string;
  columnType: "boolean" | "select";
  columnMatch: (name: string) => boolean;
  fromV: number;
  toV: number;
  rowSeed: number;
  idField: string;
}

export const PAIRS: PairDef[] = [
  {
    key: "so-formatting",
    label: "SO formatting-only",
    corpus: "profiles",
    column: "so-lab",
    columnType: "boolean",
    columnMatch: (n) => n.includes("(lab)"),
    fromV: 1,
    toV: 2,
    rowSeed: 42,
    idField: "response_id",
  },
  {
    key: "so-synonym",
    label: "SO synonym rewording",
    corpus: "profiles",
    column: "so-lab",
    columnType: "boolean",
    columnMatch: (n) => n.includes("(lab)"),
    fromV: 2,
    toV: 3,
    rowSeed: 42,
    idField: "response_id",
  },
  {
    key: "so-widening",
    label: "SO scope widening",
    corpus: "profiles",
    // NOT so-lab: this is the production column, whose v2 seeded the replica.
    column: "so-demo",
    columnType: "boolean",
    columnMatch: (n) => n.startsWith("Data-platform specialist?"),
    fromV: 1,
    toV: 2,
    rowSeed: 42,
    idField: "response_id",
  },
  {
    key: "dj-formatting",
    label: "Djinni formatting-only",
    corpus: "djinni",
    column: "dj-lab",
    columnType: "select",
    columnMatch: (n) => n.includes("djinni lab"),
    fromV: 1,
    toV: 2,
    rowSeed: 7,
    idField: "id",
  },
  {
    key: "dj-criteria",
    label: "Djinni criteria change",
    corpus: "djinni",
    column: "dj-lab",
    columnType: "select",
    columnMatch: (n) => n.includes("djinni lab"),
    fromV: 2,
    toV: 3,
    rowSeed: 7,
    idField: "id",
  },
];

export const pairByKey = (key: string): PairDef => {
  const p = PAIRS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown edit pair "${key}"`);
  return p;
};
