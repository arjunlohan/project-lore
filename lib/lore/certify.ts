/**
 * sIVM certification worker: given a column's v_from -> v_to edit, decide
 * which cached v_from cells can be reused as v_to values such that, with
 * probability >= 1-delta, the realized false-reuse of every certified
 * stratum is <= alpha, sampling only what the bound needs.
 *
 * The oracle (fresh v_to computation for sampled rows) is injectable so
 * experiments can serve it from a precomputed ground-truth table while
 * production serves it from the live runner. Every oracle call is counted;
 * that count IS the verification cost. A sampled row for which the oracle
 * returns no value (a failed or timed-out call) counts as a flip and is left
 * for recomputation: dropping it would thin the sample on the slow rows that
 * flip most, so a failure may only ever make the certifier refuse.
 */
import { randomUUID } from "node:crypto";
import {
  adaptiveCertifyStratum,
  assignStrata,
  diffPrompts,
  planSampleSizes,
  seededShuffle,
  selectReuse,
  type BoundKind,
  type PromptDeltaV1,
  type SivmCellInput,
  type StratumResult,
} from "@lore/core/sivm";
import {
  applyCertificateReuse,
  getCellsForVersion,
  getColumnVersion,
  saveCertificate,
  type AiColumn,
} from "./column-store";
import { bindTemplate } from "./run-column";

type Row = Record<string, unknown>;

/** Returns fresh v_to values for the requested rows. */
export type Oracle = (rowIds: string[]) => Promise<Map<string, unknown>>;

export interface CertifyOptions {
  alpha: number;
  delta: number;
  /**
   * Seed of the stratified sample. Fixed before the first oracle call. When
   * omitted it is derived from the column and the two versions (see
   * `certificationSeed`), so each certification has a seed of its own.
   */
  seed?: number;
  /** Persist certificate + apply reuse rows (off for experiments). */
  apply?: boolean;
  /**
   * Grid-adaptive sampling: peek at a doubling look schedule (delta split
   * across looks, so peeking stays valid), stop early on certify or
   * futility. Unlocks small alpha without paying the worst-case sample.
   */
  adaptive?: boolean;
  /** Look-schedule depth for adaptive mode (default 4: 45/90/180/360). */
  maxLooks?: number;
  /**
   * Custom stratifier (e.g. embedding-interaction buckets). Must be frozen
   * before sampling; stratifier quality affects power only, never validity.
   */
  stratifier?: (
    cells: SivmCellInput[],
    delta: PromptDeltaV1,
  ) => ReturnType<typeof assignStrata>;
  /** Guarantee target: user-facing presented cells (default) or the strict
   * unsampled reuse set (deflated threshold). */
  estimand?: "presented" | "reuse-set";
  /** Upper confidence bound the adaptive certifier spends the budget on. */
  bound?: BoundKind;
}

export interface CertifyOutcome {
  certificateId: string;
  delta: PromptDeltaV1;
  strata: StratumResult[];
  sampledRowIds: string[];
  reusedRowIds: string[];
  recomputeRowIds: string[];
  oracleCalls: number;
  /** Sampled rows whose fresh value disagreed with cache (by stratum). */
  observedFlips: number;
}

/**
 * Default sampling seed of a certification: a 32-bit FNV-1a hash of the
 * column and the two versions. Successive certifications of one column then
 * draw different samples. That matters because the rows one certification
 * sampled hold oracle cells drawn at its time, which the rest of their
 * stratum may not, so they must not be the sample of the next one as well.
 * The seed is a function of what the certificate record already stores
 * (column, from version, to version), so the sample stays reproducible.
 */
export function certificationSeed(
  columnId: string,
  fromVersion: number,
  toVersion: number,
): number {
  let h = 0x811c9dc5;
  for (const ch of `${columnId}:${fromVersion}:${toVersion}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function equivalent(a: unknown, b: unknown): boolean {
  // v1 equivalence: exact for booleans/selects/numbers-as-emitted; the
  // free-text judge path is a Phase 3 upgrade with its own calibrated error.
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function certifyColumnEdit(
  column: AiColumn,
  fromVersion: number,
  toVersion: number,
  rows: Row[],
  idField: string,
  oracle: Oracle,
  opts: CertifyOptions,
): Promise<CertifyOutcome> {
  const vFrom = await getColumnVersion(column.id, fromVersion);
  const vTo = await getColumnVersion(column.id, toVersion);
  if (!vFrom || !vTo) throw new Error("missing column version");

  const delta = diffPrompts(vFrom.prompt_template, vTo.prompt_template);

  const rowById = new Map(rows.map((r) => [String(r[idField]), r]));
  const cached = await getCellsForVersion(column.id, fromVersion, [
    ...rowById.keys(),
  ]);
  // Canonical row order BEFORE stratification: the seeded shuffle below is
  // a permutation of each stratum's member list, so the sample path is
  // pinned only if that list's order is. The cell query has no ORDER BY and
  // MySQL has served it through different indexes at different times (the
  // deployment run of 2026-08-05 came back in idx_cache order, i.e. by
  // content hash; the same query today comes back in primary-key order,
  // and the same seed then draws a different sample). Sorting by content
  // hash, then row id, reproduces the reported run and makes the path a
  // function of the seed and the data alone.
  const usable = cached
    .filter(
      (c) =>
        (c.status === "done" || c.status === "cached") && rowById.has(c.row_id),
    )
    .sort((a, b) =>
      a.row_content_hash < b.row_content_hash
        ? -1
        : a.row_content_hash > b.row_content_hash
          ? 1
          : a.row_id < b.row_id
            ? -1
            : a.row_id > b.row_id
              ? 1
              : 0,
    );

  // Freeze strata from v_from cache + the prompt delta (pre-sampling).
  const inputs: SivmCellInput[] = usable.map((c) => ({
    rowId: c.row_id,
    cachedValue: c.value,
    boundText: bindTemplate(vFrom.prompt_template, rowById.get(c.row_id)!)
      .text,
  }));
  const strata = (opts.stratifier ?? assignStrata)(inputs, delta);
  const plan = planSampleSizes(
    strata.map((s) => ({ id: s.id, size: s.rowIds.length })),
    opts.alpha,
    opts.delta,
  );

  // Stratified deterministic sample order.
  const seed =
    opts.seed ?? certificationSeed(column.id, fromVersion, toVersion);
  const cacheByRow = new Map(usable.map((c) => [c.row_id, c.value]));
  const fresh = new Map<string, unknown>();
  const revealed = new Set<string>();
  const reveal = async (rowIds: string[]) => {
    const need = rowIds.filter((id) => !revealed.has(id));
    if (need.length > 0) {
      const got = await oracle(need);
      for (const [k, v] of got) fresh.set(k, v);
      for (const id of need) revealed.add(id);
    }
  };

  let results: StratumResult[];
  const sampledByStratum = new Map<string, string[]>();

  if (opts.adaptive) {
    const K = Math.max(1, strata.length);
    const perStratumDelta = opts.delta / K;
    results = [];
    for (const s of strata) {
      const order = seededShuffle(s.rowIds, seed);
      const outcome = await adaptiveCertifyStratum(
        s.rowIds.length,
        opts.alpha,
        perStratumDelta,
        async (n) => {
          const prefix = order.slice(0, n);
          await reveal(prefix);
          return prefix.map((id) =>
            fresh.has(id) && equivalent(cacheByRow.get(id), fresh.get(id))
              ? 0
              : 1,
          );
        },
        45,
        opts.maxLooks ?? 4,
        opts.estimand ?? "presented",
        opts.bound,
      );
      sampledByStratum.set(s.id, order.slice(0, outcome.sampled));
      const last = outcome.looks[outcome.looks.length - 1]!;
      results.push({
        stratumId: s.id,
        size: s.rowIds.length,
        sampled: outcome.sampled,
        flips: last.flips,
        empiricalFlipRate: last.n > 0 ? last.flips / last.n : 1,
        upperBound: last.upperBound,
        certified: outcome.certified,
        looks: outcome.looks,
        perStratumDelta,
        estimand: opts.estimand ?? "presented",
        bound: opts.bound ?? "exact",
      });
    }
  } else {
    for (const s of strata) {
      const take = plan.get(s.id) ?? 0;
      sampledByStratum.set(s.id, seededShuffle(s.rowIds, seed).slice(0, take));
    }
    await reveal([...sampledByStratum.values()].flat());
    const mathInput = strata.map((s) => ({
      id: s.id,
      size: s.rowIds.length,
      flipSample: (sampledByStratum.get(s.id) ?? []).map((rowId) =>
        fresh.has(rowId) &&
        equivalent(cacheByRow.get(rowId), fresh.get(rowId))
          ? 0
          : 1,
      ),
    }));
    results = selectReuse({
      strata: mathInput,
      alpha: opts.alpha,
      delta: opts.delta,
    }).map((r) => ({
      ...r,
      perStratumDelta: opts.delta / Math.max(1, mathInput.length),
      estimand: "presented" as const,
      bound: "exact" as const,
    }));
  }
  const sampledRowIds = [...sampledByStratum.values()].flat();

  const certifiedIds = new Set(
    results.filter((r) => r.certified).map((r) => r.stratumId),
  );
  const sampledSet = new Set(sampledRowIds);
  const reusedRowIds: string[] = [];
  const recomputeRowIds: string[] = [];
  for (const s of strata) {
    for (const rowId of s.rowIds) {
      // Sampled rows are already freshly computed - they are neither reused
      // nor recomputed again, unless their oracle call failed.
      if (sampledSet.has(rowId)) {
        if (!fresh.has(rowId)) recomputeRowIds.push(rowId);
        continue;
      }
      if (certifiedIds.has(s.id)) reusedRowIds.push(rowId);
      else recomputeRowIds.push(rowId);
    }
  }

  const certificateId = randomUUID();
  if (opts.apply) {
    await saveCertificate({
      id: certificateId,
      columnId: column.id,
      fromVersion,
      toVersion,
      alpha: opts.alpha,
      delta,
      strata: results,
      reusedCount: reusedRowIds.length,
      recomputeCount: recomputeRowIds.length,
      sampledCount: sampledRowIds.length,
      verificationCostUsd: 0,
    });
    await applyCertificateReuse(
      column.id,
      fromVersion,
      toVersion,
      column.model,
      reusedRowIds,
      certificateId,
    );
  }

  return {
    certificateId,
    delta,
    strata: results,
    sampledRowIds,
    reusedRowIds,
    recomputeRowIds,
    oracleCalls: revealed.size,
    observedFlips: results.reduce((a, r) => a + r.flips, 0),
  };
}
