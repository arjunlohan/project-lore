/**
 * Experiment 16: model-snapshot drift, measured on the deployment sample.
 *
 * Assumption 1 scopes a certificate to the model snapshot its oracle draws
 * came from. This measures what that scope is worth. The deployment run of
 * 2026-08-05 drew fresh v2 cells for a seeded sample of the cached-FALSE
 * and cached-TRUE strata (version 2); on 2026-09-29 the same template was
 * re-issued as version 4 and the v1 template as version 5, and the same
 * sample rows were drawn again under both (scripts/experiments/
 * snapshot-versions.ts registers the versions; exp11c with EXP_TO_VERSION=4
 * draws version 4; this script draws version 5 for the rows it needs).
 *
 * On the same rows, same model identifier, same gateway, same prompts,
 * temperature 0, that gives four paired comparisons per stratum:
 *   augEdit      Aug v2 vs Aug v1   the edit's flip rate inside August
 *   sepEdit      Sep v4 vs Aug v1   the flip rate the September oracle
 *                                    measures against the August cache
 *   promptDrift  Sep v4 vs Aug v2   same prompt, two snapshots
 *   cacheDrift   Sep v5 vs Aug v1   same prompt, two snapshots
 *   sepFresh     Sep v4 vs Sep v5   the edit's flip rate inside September
 * The within-snapshot self-flip floors (exp10) are the reference: a
 * same-prompt disagreement rate across snapshots that exceeds the
 * within-snapshot floor is drift, not decode noise.
 *
 * Cost: one v5 draw per sampled row that lacks one (about 765 calls on
 * the primary model). Run:
 *   set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp16-snapshot-drift.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { diffPrompts, seededShuffle } from "@lore/core/sivm";
import { getCellsForVersion, getColumnVersion, listColumns, totalSpendUsd } from "../../lib/lore/column-store";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { runColumn } from "../../lib/lore/run-column";

const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 32);
const SEED = 42;
const FALSE_PREFIX = 720; // the August run's deepest look on the cached-FALSE stratum
const TRUE_PREFIX = 45;
const OUT = "docs/research/experiments/exp16-snapshot-drift.json";

type Row = Record<string, unknown>;

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/** Exact two-sided McNemar p-value from the discordant counts. */
function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY missing");
  const started = Date.now();
  const lab = (await listColumns("profiles")).find((c) => c.name.includes("(lab)"))!;
  const [v1, v2, v4, v5] = await Promise.all([1, 2, 4, 5].map((v) => getColumnVersion(lab.id, v)));
  if (!v1 || !v2 || !v4 || !v5) throw new Error("versions 1, 2, 4, 5 must exist (run snapshot-versions.ts)");
  if (v4.prompt_template !== v2.prompt_template || v5.prompt_template !== v1.prompt_template) {
    throw new Error("version 4 must carry the v2 template and version 5 the v1 template");
  }
  const delta = diffPrompts(v1.prompt_template, v2.prompt_template);
  if (delta.deltaTerms.length !== 0) {
    throw new Error("formatting edit is expected to have no content-term delta (single interaction bucket)");
  }

  // The pinned deployment sample path (lib/lore/certify.ts): cached v1
  // cells ordered by content hash then row id, value strata, seeded shuffle.
  const cached = (await getCellsForVersion(lab.id, 1))
    .filter((c) => c.status === "done" || c.status === "cached")
    .sort((a, b) =>
      a.row_content_hash < b.row_content_hash ? -1 : a.row_content_hash > b.row_content_hash ? 1 : a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0,
    );
  const val = new Map(cached.map((c) => [c.row_id, JSON.stringify(c.value)]));
  const prefixOf = (v: string, n: number) =>
    seededShuffle(cached.filter((c) => JSON.stringify(c.value) === v).map((c) => c.row_id), SEED).slice(0, n);
  const sample = {
    false: prefixOf("false", FALSE_PREFIX),
    true: prefixOf("true", TRUE_PREFIX),
  };
  const need = [...sample.false, ...sample.true];

  // September draws for every sample row: version 4 (v2 template) and
  // version 5 (v1 template). exp11c draws version 4 as far as its schedule
  // goes; whatever the paired comparison still lacks is drawn here.
  const oracleMap = async (version: number) =>
    new Map(
      (await getCellsForVersion(lab.id, version, need))
        .filter((c) => c.status === "done" || c.status === "cached")
        .map((c) => [c.row_id, JSON.stringify(c.value)]),
    );
  const loadRows = async (ids: string[]): Promise<Row[]> => {
    const db = await mysql.createConnection({ uri: MYSQL_URL });
    const [raw] = await db.query(
      `SELECT * FROM profiles WHERE ${PROFILE_ID_FIELD} IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    await db.end();
    return (raw as Row[]).map((r) => {
      const out: Row = { ...r };
      for (const k of Object.keys(out)) {
        const x = out[k];
        if (typeof x === "string" && x.startsWith("[")) {
          try {
            out[k] = JSON.parse(x);
          } catch {
            /* keep */
          }
        }
      }
      return out;
    });
  };
  const spendBefore = await totalSpendUsd();
  let liveCalls = 0;
  for (const [version, tpl] of [
    [4, v2.prompt_template],
    [5, v1.prompt_template],
  ] as const) {
    const have = await oracleMap(version);
    const missing = need.filter((id) => !have.has(id));
    if (missing.length === 0) continue;
    const res = await runColumn(lab, await loadRows(missing), PROFILE_ID_FIELD, {
      concurrency: CONCURRENCY,
      versionOverride: { promptTemplate: tpl, promptVersion: version },
    });
    liveCalls += res.ran;
    console.log(`version ${version}: computed ${res.ran} cells (cached ${res.cached}, errors ${res.errors})`);
  }
  const aug2 = await oracleMap(2);
  const sep4 = await oracleMap(4);
  const sep5 = await oracleMap(5);

  const compare = (ids: string[], a: Map<string, string>, b: Map<string, string>) => {
    let n = 0;
    let k = 0;
    const dir: Record<string, number> = {};
    for (const id of ids) {
      const x = a.get(id);
      const y = b.get(id);
      if (x === undefined || y === undefined) continue;
      n++;
      if (x !== y) {
        k++;
        dir[`${x}->${y}`] = (dir[`${x}->${y}`] ?? 0) + 1;
      }
    }
    const [lo, hi] = wilson(k, n);
    return { n, disagreements: k, rate: n > 0 ? k / n : null, wilson95: [lo, hi], directions: dir };
  };
  const paired = (ids: string[], refA: Map<string, string>, x: Map<string, string>, y: Map<string, string>) => {
    // Flip indicators against the same cache under two oracles; McNemar on
    // the discordant rows.
    let b = 0;
    let c = 0;
    let n = 0;
    for (const id of ids) {
      const r = refA.get(id);
      const fx = x.get(id);
      const fy = y.get(id);
      if (r === undefined || fx === undefined || fy === undefined) continue;
      n++;
      const flipX = fx !== r;
      const flipY = fy !== r;
      if (flipX && !flipY) b++;
      if (!flipX && flipY) c++;
    }
    return { n, onlyFirstFlips: b, onlySecondFlips: c, mcnemarP: mcnemar(b, c) };
  };

  const report: Record<string, unknown> = {};
  for (const stratum of ["false", "true"] as const) {
    const ids = sample[stratum];
    report[stratum] = {
      prefix: ids.length,
      augEdit: compare(ids, val, aug2),
      sepEdit: compare(ids, val, sep4),
      promptDrift: compare(ids, aug2, sep4),
      cacheDrift: compare(ids, val, sep5),
      sepFresh: compare(ids, sep5, sep4),
      augVsSepEditPaired: paired(ids, val, aug2, sep4),
    };
  }
  const draws = (["false", "true"] as const).flatMap((stratum) =>
    sample[stratum].map((id, i) => ({
      stratum,
      position: i + 1,
      row_id: id,
      aug_v1: val.get(id) ?? null,
      aug_v2: aug2.get(id) ?? null,
      sep_v4: sep4.get(id) ?? null,
      sep_v5: sep5.get(id) ?? null,
    })),
  );
  const spendAfter = await totalSpendUsd();
  const out = {
    experiment: "exp16-snapshot-drift",
    note: "same rows, same model id, same gateway, same prompts, T=0: August (versions 1, 2) against September 2026 (versions 5, 4) on the deployment sample path",
    model: lab.model,
    snapshots: { august: "2026-08-04/05", september: "2026-09-29" },
    seed: SEED,
    sample: { false: FALSE_PREFIX, true: TRUE_PREFIX },
    liveCalls,
    ledgerSpendDeltaUsd: spendAfter - spendBefore,
    strata: report,
    draws,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  for (const s of ["false", "true"]) {
    const r = report[s] as Record<string, { rate: number | null; n: number; disagreements: number }>;
    console.log(
      `${s}: ` +
        ["augEdit", "sepEdit", "promptDrift", "cacheDrift", "sepFresh"]
          .map((k) => `${k}=${r[k]!.disagreements}/${r[k]!.n} (${((r[k]!.rate ?? 0) * 100).toFixed(2)}%)`)
          .join("  "),
      JSON.stringify((report[s] as Record<string, unknown>).augVsSepEditPaired),
    );
  }
  console.log("EXP16_DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
