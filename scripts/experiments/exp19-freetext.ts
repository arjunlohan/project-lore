/**
 * Experiment 19 (IEEE Access resubmission, reviewer 1): a free-text column
 * with a judge-based equivalence relation, the judge's error calibrated on
 * human labels and folded into the budget.
 *
 * Column (over the Stack Overflow profiles, same seeded 2,000-row evaluation
 * vector as the Boolean lab column): a short noun phrase naming the
 * respondent's primary technical specialty. Three versions, mirroring the
 * lab column's edit classes: v1 -> v2 is formatting-only (two paragraph
 * breaks inserted, no word changed) and v2 -> v3 is a synonym rewording.
 * Draws: a1 = v1, b1 = v1 again (floor), a2 = v2, a3 = v3, one fresh draw
 * per cell from the primary model with the production runner's framing,
 * temperature 0, all inside one snapshot (one run).
 *
 * Equivalence: a judge (the primary model, temperature 0) compares two
 * phrases and answers SAME or DIFFERENT; the pair is equivalent only if both
 * orders answer SAME. Flip indicators for the three comparisons (floor:
 * a1 vs b1; formatting: a1 vs a2; synonym: a2 vs a3) are the judge's
 * verdicts.
 *
 * Strata (frozen before certification): a single stratum, and a second
 * stratification by a coarse specialty category the judge assigns to the
 * CACHED phrase (Assumption 2: any frozen stratifier is validity-free).
 *
 * Calibration: the judge can miss a true flip (say SAME for a pair a human
 * would call different), which would inflate the certified reuse's true
 * error. A seeded calibration sample of judge-SAME and judge-DIFFERENT pairs
 * across the three comparisons is exported for hand labeling (the author
 * labels it; a second model labels it as an adjudicator and the agreement is
 * reported). With labels, the miss rate P(judge SAME and human DIFFERENT) is
 * bounded above by a Clopper-Pearson bound m at level delta_cal, and the
 * procedure certifies at alpha - m; the total error budget is delta_cal +
 * delta.
 *
 * Modes:
 *   (default)                 draw, judge, stratify, certify at the raw
 *                             budgets, export the calibration sample
 *   EXP_LABELS=<labels.json>  reload the artifact, apply the human labels
 *                             (and adjudicator labels if present), recompute
 *                             the deflated certification
 *   EXP_REPLAY_FROM=<json>    recompute everything from stored draws/verdicts
 * Run: set -a; source .env.local; set +a; pnpm tsx scripts/experiments/exp19-freetext.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateObject, generateText } from "ai";
import mysql from "mysql2/promise";
import { z } from "zod";
import { adaptiveCertifyStratum, binomialUpperBound, mulberry32, seededShuffle, type BoundKind } from "@lore/core/sivm";
import { PROFILE_ID_FIELD } from "../../lib/lore/fields";
import { bindTemplate, systemFor } from "../../lib/lore/run-column";

const MODEL = process.env.EXP_MODEL ?? "deepseek/deepseek-v4-flash-0731";
const JUDGE = process.env.EXP_JUDGE ?? MODEL;
const ADJUDICATOR = process.env.EXP_ADJUDICATOR ?? "meta/muse-spark-1.3-contributor";
const N = Number(process.env.EXP_ROWS ?? 2000);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 16);
const SEED = 42;
const DELTA = 0.1;
const DELTA_CAL = 0.05;
const ALPHAS = [0.1, 0.2];
const BOUND = (process.env.EXP_BOUND ?? "exact") as BoundKind;
const LABELS = process.env.EXP_LABELS;
const REPLAY_FROM = process.env.EXP_REPLAY_FROM;
const OUT = process.env.EXP_OUT ?? "docs/research/experiments/exp19-freetext.json";
const CAL_SAME = Number(process.env.EXP_CAL_SAME ?? 150);
const CAL_DIFF = Number(process.env.EXP_CAL_DIFF ?? 50);
const MYSQL_URL = process.env.LORE_MYSQL_URL ?? "mysql://root@localhost:3306/lore";

// The three versions. v2 differs from v1 by two paragraph breaks only; v3
// rewords v2 without changing what is asked.
export const TEMPLATES = {
  1: `Describe this respondent's primary technical specialty in at most eight words, as a noun phrase (for example, "backend web services in Java"). Judge from role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other tech {{misc_tech}}.`,
  2: `Describe this respondent's primary technical specialty in at most eight words, as a noun phrase (for example, "backend web services in Java").

Judge from role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other tech {{misc_tech}}.

`,
  3: `Describe this person's main technical specialization in no more than eight words, as a noun phrase (for instance, "backend web services in Java").

Decide using their role {{dev_type}}, databases {{databases}}, platforms {{platforms}}, tools {{tools_tech}}, and other technologies {{misc_tech}}.

`,
} as const;
const CATEGORIES = [
  "data engineering and analytics",
  "backend services",
  "frontend and web UI",
  "mobile",
  "devops, cloud, and infrastructure",
  "machine learning and AI",
  "embedded and systems",
  "other",
] as const;

type Row = Record<string, unknown>;
type Verdict = "SAME" | "DIFFERENT" | null;
type Pair = { comparison: "floor" | "formatting" | "synonym"; index: number; a: string; b: string; judge: boolean | null };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

const JUDGE_SYSTEM = `You compare two short phrases that each describe a person's primary technical specialty. Answer SAME if they describe the same specialty (the same field and the same focus of work, differences of wording aside). Answer DIFFERENT if they name a different field, a different focus within a field, or if one is clearly more specific in a way that changes what the person does. Answer with exactly one word: SAME or DIFFERENT.`;

async function judgeOnce(model: string, a: string, b: string): Promise<Verdict> {
  try {
    const r = await generateText({
      model,
      system: JUDGE_SYSTEM,
      prompt: `A: ${a}\nB: ${b}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(120000),
    });
    const t = r.text.trim().toUpperCase();
    if (/^SAME\b/.test(t)) return "SAME";
    if (/^DIFFERENT\b/.test(t)) return "DIFFERENT";
    if (t.includes("DIFFERENT")) return "DIFFERENT";
    if (t.includes("SAME")) return "SAME";
    return null;
  } catch {
    return null;
  }
}
/** Equivalent only if both orders say SAME; null if either order failed. */
async function judgePair(model: string, a: string, b: string): Promise<boolean | null> {
  if (a === b) return true;
  const [ab, ba] = await Promise.all([judgeOnce(model, a, b), judgeOnce(model, b, a)]);
  if (ab === null || ba === null) return null;
  return ab === "SAME" && ba === "SAME";
}

async function main() {
  const started = Date.now();
  let art: Record<string, unknown>;
  if (REPLAY_FROM || LABELS) {
    art = JSON.parse(readFileSync(REPLAY_FROM ?? OUT, "utf8"));
  } else {
    if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY missing");
    const db = await mysql.createConnection({ uri: MYSQL_URL });
    const [raw] = await db.query(`SELECT * FROM profiles ORDER BY RAND(?) LIMIT ?`, [SEED, N]);
    await db.end();
    const rows = (raw as Row[]).map((r) => {
      const o: Row = { ...r };
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === "string" && v.startsWith("[")) {
          try {
            o[k] = JSON.parse(v);
          } catch {
            /* keep */
          }
        }
      }
      return o;
    });
    const ids = rows.map((r) => String(r[PROFILE_ID_FIELD]));
    const spec = { kind: "text" } as const;
    const schema = z.object({ value: z.string(), rationale: z.string() });
    const system = systemFor(spec);
    // Draws are paid for once: a checkpoint holds every completed draw so
    // far, and a restart over the same seeded rows redraws only the gaps.
    const partialPath = `${OUT}.partial.json`;
    const prior = existsSync(partialPath)
      ? (JSON.parse(readFileSync(partialPath, "utf8")) as { ids?: string[]; draws?: Record<string, Array<string | null>> })
      : null;
    const priorDraws = prior && JSON.stringify(prior.ids) === JSON.stringify(ids) ? (prior.draws ?? {}) : {};
    const partial: Record<string, Array<string | null>> = {};
    const checkpoint = () =>
      writeFileSync(partialPath, JSON.stringify({ experiment: "exp19-freetext", model: MODEL, partial: true, ids, draws: partial }));
    const draw = async (version: 1 | 2 | 3, key: string) => {
      const prompts = rows.map((r) => bindTemplate(TEMPLATES[version], r).text);
      const cur: Array<string | null> = prompts.map((_, i) => priorDraws[key]?.[i] ?? null);
      const reused = cur.filter((x) => x !== null).length;
      if (reused > 0) console.log(`  ${key}: ${reused}/${prompts.length} draws reused from the checkpoint`);
      partial[key] = cur;
      let done = 0;
      const out = await mapLimit(
        prompts.map((prompt, i) => ({ prompt, i })),
        CONCURRENCY,
        async ({ prompt, i }) => {
          if (cur[i] !== null) return cur[i];
          let v: string | null = null;
          try {
            const r = await generateObject({ model: MODEL, schema, system, prompt, temperature: 0, abortSignal: AbortSignal.timeout(120000) });
            v = r.object.value.trim();
          } catch {
            v = null;
          }
          cur[i] = v;
          done++;
          if (done % 200 === 0) {
            console.log(`  ${key}: ${done}/${prompts.length - reused}`);
            checkpoint();
          }
          return v;
        },
      );
      partial[key] = out;
      checkpoint();
      console.log(`${key}: ${out.filter((x) => x !== null).length}/${out.length} draws`);
      return out;
    };
    const a1 = await draw(1, "a1");
    const b1 = await draw(1, "b1");
    const a2 = await draw(2, "a2");
    const a3 = await draw(3, "a3");

    // Judge the three comparisons.
    const comparisons: Array<["floor" | "formatting" | "synonym", Array<string | null>, Array<string | null>]> = [
      ["floor", a1, b1],
      ["formatting", a1, a2],
      ["synonym", a2, a3],
    ];
    const pairs: Pair[] = [];
    for (const [name, x, y] of comparisons) {
      let done = 0;
      const verdicts = await mapLimit(
        x.map((_, i) => i),
        CONCURRENCY,
        async (i) => {
          const a = x[i];
          const b = y[i];
          const v = a === null || b === null ? null : await judgePair(JUDGE, a, b);
          done++;
          if (done % 200 === 0) console.log(`  judge ${name}: ${done}/${x.length}`);
          return v;
        },
      );
      for (let i = 0; i < x.length; i++) {
        pairs.push({ comparison: name, index: i, a: x[i] ?? "", b: y[i] ?? "", judge: verdicts[i]! });
      }
      const k = verdicts.filter((v) => v === false).length;
      const n = verdicts.filter((v) => v !== null).length;
      console.log(`${name}: judge flips ${k}/${n} = ${((100 * k) / Math.max(1, n)).toFixed(2)}%`);
    }
    // Frozen category stratifier on the cached phrase of each comparison.
    const catSchema = z.object({ category: z.enum(CATEGORIES as unknown as [string, ...string[]]) });
    const categorize = async (phrases: Array<string | null>) =>
      mapLimit(phrases, CONCURRENCY, async (p) => {
        if (p === null) return null;
        try {
          const r = await generateObject({
            model: JUDGE,
            schema: catSchema,
            system: `Assign the phrase, which names a person's primary technical specialty, to exactly one of these categories: ${CATEGORIES.join("; ")}.`,
            prompt: p,
            temperature: 0,
            abortSignal: AbortSignal.timeout(120000),
          });
          return r.object.category;
        } catch {
          return null;
        }
      });
    const catA1 = await categorize(a1);
    const catA2 = await categorize(a2);
    console.log(`categories assigned: a1 ${catA1.filter(Boolean).length}, a2 ${catA2.filter(Boolean).length}`);

    // Calibration sample: judge-SAME and judge-DIFFERENT pairs, seeded,
    // pooled across the three comparisons (equal numbers per comparison).
    const rand = mulberry32(20260930);
    const pick = (pool: Pair[], k: number) => seededShuffle(pool, Math.floor(rand() * 1e9)).slice(0, k);
    const cal: Pair[] = [];
    for (const name of ["floor", "formatting", "synonym"] as const) {
      const same = pairs.filter((p) => p.comparison === name && p.judge === true && p.a !== p.b);
      const diff = pairs.filter((p) => p.comparison === name && p.judge === false);
      cal.push(...pick(same, Math.round(CAL_SAME / 3)), ...pick(diff, Math.round(CAL_DIFF / 3)));
    }
    const calibration = seededShuffle(cal, 7).map((p, i) => ({ calId: i + 1, ...p }));
    art = {
      experiment: "exp19-freetext",
      model: MODEL,
      judge: JUDGE,
      adjudicator: ADJUDICATOR,
      ranAt: new Date(started).toISOString(),
      bound: BOUND,
      n: rows.length,
      templates: TEMPLATES,
      categories: CATEGORIES,
      ids,
      draws: { a1, b1, a2, a3 },
      categoriesOfCache: { a1: catA1, a2: catA2 },
      pairs,
      calibration,
      poolSizes: Object.fromEntries(
        (["floor", "formatting", "synonym"] as const).map((name) => [
          name,
          {
            judgeSame: pairs.filter((p) => p.comparison === name && p.judge === true).length,
            judgeDifferent: pairs.filter((p) => p.comparison === name && p.judge === false).length,
            failed: pairs.filter((p) => p.comparison === name && p.judge === null).length,
          },
        ]),
      ),
    };
  }

  // Human labels and adjudicator labels, if provided.
  if (LABELS) {
    const lab = JSON.parse(readFileSync(LABELS, "utf8")) as { labels: Array<{ calId: number; human: "SAME" | "DIFFERENT" }> };
    const byId = new Map(lab.labels.map((l) => [l.calId, l.human]));
    art.calibration = (art.calibration as Array<Record<string, unknown>>).map((c) => ({ ...c, human: byId.get(Number(c.calId)) ?? null }));
    if (!process.env.EXP_SKIP_ADJUDICATOR) {
      const cal = art.calibration as Array<{ calId: number; a: string; b: string; adjudicator?: boolean | null }>;
      const need = cal.filter((c) => c.adjudicator === undefined || c.adjudicator === null);
      const verdicts = await mapLimit(need, 8, async (c) => judgePair(ADJUDICATOR, c.a, c.b));
      need.forEach((c, i) => {
        c.adjudicator = verdicts[i]!;
      });
      console.log(`adjudicator labeled ${verdicts.filter((v) => v !== null).length}/${need.length}`);
    }
  }

  // Miss-rate bound from human labels: P(judge SAME and human DIFFERENT),
  // estimated over the judge-SAME pool with a one-sided Clopper-Pearson
  // bound at delta_cal, times the judge-SAME share of each comparison.
  const cal = (art.calibration as Array<{ judge: boolean | null; human?: string | null; adjudicator?: boolean | null; comparison: string }>) ?? [];
  const labeledSame = cal.filter((c) => c.judge === true && (c.human === "SAME" || c.human === "DIFFERENT"));
  const misses = labeledSame.filter((c) => c.human === "DIFFERENT").length;
  const labeledDiff = cal.filter((c) => c.judge === false && (c.human === "SAME" || c.human === "DIFFERENT"));
  const falseFlips = labeledDiff.filter((c) => c.human === "SAME").length;
  const missUcb = labeledSame.length > 0 ? binomialUpperBound(misses, labeledSame.length, DELTA_CAL) : null;
  const agreement = (() => {
    const both = cal.filter((c) => (c.human === "SAME" || c.human === "DIFFERENT") && typeof c.adjudicator === "boolean");
    const agree = both.filter((c) => (c.human === "SAME") === c.adjudicator).length;
    const judgeAgree = cal.filter((c) => (c.human === "SAME" || c.human === "DIFFERENT") && typeof c.judge === "boolean").filter((c) => (c.human === "SAME") === c.judge).length;
    const judgeN = cal.filter((c) => (c.human === "SAME" || c.human === "DIFFERENT") && typeof c.judge === "boolean").length;
    return {
      humanLabeled: cal.filter((c) => c.human === "SAME" || c.human === "DIFFERENT").length,
      adjudicatorVsHuman: { n: both.length, agree, rate: both.length > 0 ? agree / both.length : null },
      judgeVsHuman: { n: judgeN, agree: judgeAgree, rate: judgeN > 0 ? judgeAgree / judgeN : null },
    };
  })();

  // Certification per comparison: single stratum, and category strata.
  const pairs = art.pairs as Pair[];
  const cats = art.categoriesOfCache as { a1: Array<string | null>; a2: Array<string | null> };
  const results: Record<string, unknown> = {};
  for (const name of ["floor", "formatting", "synonym"] as const) {
    const ps = pairs.filter((p) => p.comparison === name && p.judge !== null);
    const flips: number[] = ps.map((p) => (p.judge ? 0 : 1));
    const cache = name === "synonym" ? cats.a2 : cats.a1;
    const judgeSameShare = ps.filter((p) => p.judge === true).length / Math.max(1, ps.length);
    const missBound = missUcb === null ? null : missUcb * judgeSameShare;
    const run = async (strata: Array<{ id: string; flips: number[] }>, alpha: number, deflate: number) => {
      const aEff = alpha - deflate;
      if (aEff <= 0) return { alpha, alphaEffective: aEff, certifiedStrata: [], sampled: 0, reused: 0, savings: 0, realizedJudge: null };
      let sampled = 0;
      let reused = 0;
      let reusedFlips = 0;
      let certTotal = 0;
      const certified: string[] = [];
      for (const st of strata) {
        if (st.flips.length === 0) continue;
        const order = seededShuffle(st.flips.map((_, i) => i), SEED + st.id.length * 7919);
        const o = await adaptiveCertifyStratum(st.flips.length, aEff, DELTA / strata.length, async (n) => order.slice(0, n).map((i) => st.flips[i]!), 45, 6, "presented", BOUND);
        sampled += o.sampled;
        if (o.certified) {
          certified.push(st.id);
          const rest = order.slice(o.sampled);
          reused += rest.length;
          reusedFlips += rest.reduce((a, i) => a + st.flips[i]!, 0);
          certTotal += st.flips.length;
        }
      }
      const total = strata.reduce((a, s) => a + s.flips.length, 0);
      return { alpha, alphaEffective: aEff, certifiedStrata: certified, sampled, reused, savings: total > 0 ? reused / total : 0, realizedJudge: certTotal > 0 ? reusedFlips / certTotal : null };
    };
    const single = [{ id: "all", flips }];
    const byCat: Array<{ id: string; flips: number[] }> = [...new Set(ps.map((p) => cache[p.index] ?? "unassigned"))].map((c) => ({
      id: `c=${c}`,
      flips: ps.filter((p) => (cache[p.index] ?? "unassigned") === c).map((p) => (p.judge ? 0 : 1)),
    }));
    const sweeps: Record<string, unknown> = {};
    for (const alpha of ALPHAS) {
      sweeps[`single@${alpha}`] = await run(single, alpha, 0);
      sweeps[`category@${alpha}`] = await run(byCat, alpha, 0);
      if (missBound !== null) {
        sweeps[`single@${alpha}:calibrated`] = await run(single, alpha, missBound);
        sweeps[`category@${alpha}:calibrated`] = await run(byCat, alpha, missBound);
      }
    }
    const k = flips.reduce((a, b) => a + b, 0);
    results[name] = {
      usable: ps.length,
      judgeFlips: k,
      judgeFlipRate: k / Math.max(1, ps.length),
      wilson95: wilson(k, ps.length),
      judgeSameShare,
      missBound,
      categoryStrata: byCat.map((s) => ({ id: s.id, size: s.flips.length, flipRate: s.flips.reduce((a, b) => a + b, 0) / Math.max(1, s.flips.length) })),
      sweeps,
    };
  }
  const out = {
    ...art,
    deltaCal: DELTA_CAL,
    calibrationSummary: {
      labeledJudgeSame: labeledSame.length,
      missesAmongJudgeSame: misses,
      missUcbConditional: missUcb,
      labeledJudgeDifferent: labeledDiff.length,
      falseFlipsAmongJudgeDifferent: falseFlips,
      ...agreement,
    },
    results,
    wallMs: Date.now() - started,
  };
  mkdirSync("docs/research/experiments", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  // Labeling page: self-contained, keyboard-driven, exports JSON.
  if (!LABELS) {
    const items = (art.calibration as Pair[]).map((p) => ({ calId: (p as unknown as { calId: number }).calId, a: p.a, b: p.b }));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Free-text pilot labels</title>
<style>body{font:16px/1.4 -apple-system,Helvetica,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222}
.pair{border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0}.a,.b{font-size:20px;margin:6px 0}.k{color:#666;font-size:13px}
button{font:inherit;padding:8px 14px;margin-right:8px;border-radius:6px;border:1px solid #888;background:#fafafa;cursor:pointer}
.same{background:#e7f5e7}.diff{background:#fdeaea}#bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ddd}</style></head><body>
<div id="bar"><b>Same specialty or different?</b> Keys: <kbd>S</kbd> same, <kbd>D</kbd> different, <kbd>U</kbd> undo. <span id="count"></span>
<button onclick="exportJson()">Export labels JSON</button></div>
<p class="k">Question for each pair: do the two phrases describe the same primary technical specialty (same field, same focus of work), wording aside? Judge only the meaning; ignore capitalization, punctuation, and word order.</p>
<div id="pair" class="pair"></div>
<script>
const items=${JSON.stringify(items)};let i=0;const labels={};
try{Object.assign(labels,JSON.parse(localStorage.getItem('exp19labels')||'{}'));}catch(e){}
function next(){while(i<items.length&&labels[items[i].calId])i++;render();}
function render(){const el=document.getElementById('pair');document.getElementById('count').textContent=Object.keys(labels).length+'/'+items.length+' labeled';
if(i>=items.length){el.innerHTML='<b>All labeled. Click Export.</b>';return;}const it=items[i];
el.innerHTML='<div class="k">pair '+(i+1)+' of '+items.length+'</div><div class="a">A: '+esc(it.a)+'</div><div class="b">B: '+esc(it.b)+'</div>'+
'<div style="margin-top:12px"><button class="same" onclick="mark(\\'SAME\\')">Same (S)</button><button class="diff" onclick="mark(\\'DIFFERENT\\')">Different (D)</button><button onclick="undo()">Undo (U)</button></div>';}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function mark(v){labels[items[i].calId]=v;try{localStorage.setItem('exp19labels',JSON.stringify(labels));}catch(e){}i++;next();}
function undo(){if(i>0){i--;delete labels[items[i].calId];try{localStorage.setItem('exp19labels',JSON.stringify(labels));}catch(e){}render();}}
document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(k==='s')mark('SAME');else if(k==='d')mark('DIFFERENT');else if(k==='u')undo();});
function exportJson(){const out={labeler:'author',labeledAt:new Date().toISOString(),labels:Object.entries(labels).map(([calId,human])=>({calId:Number(calId),human}))};
const b=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='exp19-freetext-labels.json';a.click();}
next();
</script></body></html>`;
    writeFileSync("docs/research/experiments/exp19-freetext-labeling.html", html);
  }
  for (const name of ["floor", "formatting", "synonym"]) {
    const r = results[name] as { judgeFlips: number; usable: number; judgeFlipRate: number; missBound: number | null; sweeps: Record<string, { certifiedStrata: string[]; sampled: number; savings: number }> };
    console.log(
      `${name}: judge flip ${r.judgeFlips}/${r.usable} (${(r.judgeFlipRate * 100).toFixed(2)}%) missBound=${r.missBound === null ? "n/a" : (r.missBound * 100).toFixed(2) + "%"} ` +
        Object.entries(r.sweeps)
          .map(([k, s]) => `${k}:${s.certifiedStrata.length ? (s.savings * 100).toFixed(1) + "%" : "refused"}(${s.sampled})`)
          .join(" "),
    );
  }
  console.log(JSON.stringify(out.calibrationSummary));
  console.log("EXP19_DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
