/**
 * Experiment 19b: a second human labeler for the free-text pilot's
 * calibration (second review round of the IEEE Access resubmission:
 * Reviewer 1 asked for one "if feasible", Reviewer 2 for the paper to say
 * one is needed).
 *
 * The pilot calibrated its judge on 201 phrase pairs labeled by one person,
 * the author (exp19-freetext.json, field "calibration"; labels in
 * exp19-freetext-labels.json). A second model's labels disagreed on the
 * clean side of that calibration, and one human labeler cannot say which
 * reading is right. This script runs in two steps.
 *
 * 1. Without a labels file it writes a labeling page for a second person:
 *    docs/research/experiments/exp19-freetext-labeling-second.html. The page
 *    shows the same 201 pairs, with the question worded exactly as the
 *    author saw it, in a fresh seeded order, and carries nothing about the
 *    judge's verdict, the comparison a pair came from, or anyone's labels.
 *    It saves progress in the browser and exports the labels as JSON.
 *
 * 2. With EXP_LABELS2=<the exported JSON> it reads those labels and writes
 *    docs/research/experiments/exp19b-second-labeler.json: agreement with the
 *    author (raw and Cohen's kappa) and with the model labeler; the judge's
 *    missed flips among the pairs it called equivalent under the second
 *    labeler's reading, with the same upper confidence bound the pilot uses;
 *    and the same under a conservative reading that counts a pair as
 *    different when either human says so.
 *
 * Zero API cost. Run:
 *   pnpm tsx scripts/experiments/exp19b-second-labeler.ts
 *   EXP_LABELS2=path/to/labels.json pnpm tsx scripts/experiments/exp19b-second-labeler.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { binomialUpperBound, seededShuffle } from "@lore/core/sivm";

const PILOT = "docs/research/experiments/exp19-freetext.json";
const PAGE = "docs/research/experiments/exp19-freetext-labeling-second.html";
const OUT = process.env.EXP_OUT ?? "docs/research/experiments/exp19b-second-labeler.json";
const LABELS2 = process.env.EXP_LABELS2;
// A seed of its own, so the second labeler does not see the pairs in the
// order the author did.
const ORDER_SEED = 20261015;

type CalPair = { calId: number; comparison: string; a: string; b: string; judge: boolean; human: "SAME" | "DIFFERENT"; adjudicator: boolean };
const pilot = JSON.parse(readFileSync(PILOT, "utf8")) as { deltaCal: number; calibration: CalPair[] };
const cal = pilot.calibration;
if (cal.length === 0 || cal.some((p) => p.human !== "SAME" && p.human !== "DIFFERENT")) {
  throw new Error("exp19-freetext.json carries no complete hand-labeled calibration sample");
}

if (!LABELS2) {
  // Step 1: the labeling page. The seeded shuffle (mulberry32, as everywhere
  // in this repository) makes the order reproducible from the seed.
  const items = seededShuffle(
    cal.map((p) => ({ calId: p.calId, a: p.a, b: p.b })),
    ORDER_SEED,
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free-text pilot: second labeler</title>
<style>
:root{--bg:#fafafa;--fg:#1d232b;--muted:#5d6672;--line:#d4d9df;--same:#e5f3e8;--diff:#fbe7e6;--accent:#255d84}
@media (prefers-color-scheme: dark){:root{--bg:#14181d;--fg:#e4e8ed;--muted:#9aa4b0;--line:#2c343e;--same:#183022;--diff:#3a1d1b;--accent:#80b4dd}}
body{font:16px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 64px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 8px}.k{color:var(--muted);font-size:14px}
.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin:14px 0}
.a,.b{font-size:20px;margin:6px 0}
button{font:inherit;padding:9px 16px;margin:4px 8px 4px 0;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.same{background:var(--same)}.diff{background:var(--diff)}
#bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line)}
textarea{width:100%;min-height:120px;font:12px ui-monospace,Menlo,monospace;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
</style></head><body>
<h1>Same specialty or different?</h1>
<p class="k">You will see ${items.length} pairs of short phrases. Each phrase names the primary technical specialty of a software developer. For each pair, decide:</p>
<p><b>Do the two phrases describe the same primary technical specialty (same field, same focus of work), wording aside? Judge only the meaning; ignore capitalization, punctuation, and word order.</b></p>
<p class="k">There are no trick pairs and no right answer to look up. Use your own reading. Keys: <kbd>S</kbd> same, <kbd>D</kbd> different, <kbd>U</kbd> undo. Your progress is kept in this browser if you close the page. It takes about an hour.</p>
<p><label for="who">Your name (recorded with your labels): </label><input id="who" autocomplete="name"></p>
<div id="bar"><span id="count"></span></div>
<div id="pair" class="card"></div>
<div id="done" class="card" hidden>
<p><b>All pairs are labeled. Thank you.</b> Send the labels back in either way:</p>
<p><button id="dl">Download labels (JSON file)</button><button id="cp">Copy labels</button> <span id="cpmsg" class="k"></span></p>
<p class="k">If neither button works, select all the text below and paste it into an email.</p>
<textarea id="out" readonly></textarea>
</div>
<script>
const items=${JSON.stringify(items)};
const KEY='exp19-second-labeler';
let labels={};try{labels=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){labels={};}
let who='';try{who=localStorage.getItem(KEY+'-who')||'';}catch(e){}
const whoEl=document.getElementById('who');whoEl.value=who;
whoEl.addEventListener('input',()=>{who=whoEl.value;try{localStorage.setItem(KEY+'-who',who);}catch(e){}renderOut();});
let order=[];
function save(){try{localStorage.setItem(KEY,JSON.stringify(labels));}catch(e){}}
function firstOpen(){return items.findIndex(it=>!labels[it.calId]);}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function payload(){return {labeler:who||'second labeler',labeledAt:new Date().toISOString(),page:'exp19-freetext-labeling-second',orderSeed:${ORDER_SEED},labels:items.filter(it=>labels[it.calId]).map(it=>({calId:it.calId,human:labels[it.calId]}))};}
function renderOut(){document.getElementById('out').value=JSON.stringify(payload(),null,1);}
function render(){
  const n=Object.keys(labels).length;document.getElementById('count').textContent=n+' of '+items.length+' labeled';
  const i=firstOpen();const el=document.getElementById('pair');
  if(i<0){el.hidden=true;document.getElementById('done').hidden=false;renderOut();return;}
  el.hidden=false;document.getElementById('done').hidden=true;const it=items[i];
  el.innerHTML='<div class="k">pair '+(i+1)+' of '+items.length+'</div><div class="a">A: '+esc(it.a)+'</div><div class="b">B: '+esc(it.b)+'</div>'+
  '<div style="margin-top:12px"><button class="same" data-v="SAME">Same (S)</button><button class="diff" data-v="DIFFERENT">Different (D)</button><button data-v="UNDO">Undo (U)</button></div>';
  el.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>act(b.getAttribute('data-v'))));
}
function act(v){
  if(v==='UNDO'){if(order.length){delete labels[order.pop()];save();}render();return;}
  const i=firstOpen();if(i<0)return;labels[items[i].calId]=v;order.push(items[i].calId);save();render();
}
document.addEventListener('keydown',e=>{if(e.target===whoEl)return;const k=e.key.toLowerCase();if(k==='s')act('SAME');else if(k==='d')act('DIFFERENT');else if(k==='u')act('UNDO');});
document.getElementById('dl').addEventListener('click',()=>{const b=new Blob([JSON.stringify(payload(),null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='exp19-freetext-labels-second.json';document.body.appendChild(a);a.click();a.remove();});
document.getElementById('cp').addEventListener('click',()=>{const t=JSON.stringify(payload(),null,1);const m=document.getElementById('cpmsg');
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(()=>{m.textContent='Copied.';},()=>{m.textContent='Copy was blocked; use the text box below.';document.getElementById('out').select();});}
  else{m.textContent='Copy is not available here; use the text box below.';document.getElementById('out').select();}});
render();
</script></body></html>
`;
  writeFileSync(PAGE, html);
  console.log(`wrote ${PAGE} (${items.length} pairs, order seed ${ORDER_SEED})`);
  process.exit(0);
}

// Step 2: read the second labeler's labels and compare.
const second = JSON.parse(readFileSync(LABELS2, "utf8")) as { labeler?: string; labeledAt?: string; labels: Array<{ calId: number; human: string }> };
const byId = new Map(second.labels.map((l) => [l.calId, l.human]));
const missing = cal.filter((p) => !byId.has(p.calId)).map((p) => p.calId);
if (missing.length > 0) throw new Error(`the second labeler's file lacks ${missing.length} pairs (first: ${missing.slice(0, 5).join(", ")})`);
if ([...byId.values()].some((v) => v !== "SAME" && v !== "DIFFERENT")) throw new Error("a second-labeler label is neither SAME nor DIFFERENT");

const n = cal.length;
const same = (v: string | boolean) => v === "SAME" || v === true;
const agreeAuthor = cal.filter((p) => same(byId.get(p.calId)!) === same(p.human)).length;
const agreeModel = cal.filter((p) => same(byId.get(p.calId)!) === p.adjudicator).length;
// Cohen's kappa between the two humans.
const pA = cal.filter((p) => same(p.human)).length / n;
const pB = cal.filter((p) => same(byId.get(p.calId)!)).length / n;
const pe = pA * pB + (1 - pA) * (1 - pB);
const kappa = (agreeAuthor / n - pe) / (1 - pe);

const judgeSame = cal.filter((p) => p.judge);
const judgeDiff = cal.filter((p) => !p.judge);
const missesSecond = judgeSame.filter((p) => !same(byId.get(p.calId)!)).length;
const missesEither = judgeSame.filter((p) => !same(byId.get(p.calId)!) || !same(p.human)).length;
const falseFlipsSecond = judgeDiff.filter((p) => same(byId.get(p.calId)!)).length;
const ucb = (k: number, m: number) => binomialUpperBound(k, m, pilot.deltaCal);
const humansDisagreeOnJudgeSame = judgeSame.filter((p) => same(byId.get(p.calId)!) !== same(p.human)).length;
const secondAgreesWithModelWhereAuthorAndModelSplit = cal.filter((p) => same(p.human) !== p.adjudicator && same(byId.get(p.calId)!) === p.adjudicator).length;
const authorModelSplits = cal.filter((p) => same(p.human) !== p.adjudicator).length;

const out = {
  experiment: "exp19b-second-labeler",
  note: "the free-text pilot's 201 calibration pairs labeled by a second person on the page this script writes; agreement with the author and the model labeler, and the judge's miss bound under the second labeler's reading and under a conservative reading (different if either human says so)",
  labeler: second.labeler ?? null,
  labeledAt: second.labeledAt ?? null,
  deltaCal: pilot.deltaCal,
  n,
  agreementWithAuthor: { agree: agreeAuthor, rate: agreeAuthor / n, kappa },
  agreementWithModelLabeler: { agree: agreeModel, rate: agreeModel / n },
  authorModelSplits: { pairs: authorModelSplits, secondSidesWithModel: secondAgreesWithModelWhereAuthorAndModelSplit },
  judgeSame: {
    pairs: judgeSame.length,
    missesSecond,
    missUcbSecond: ucb(missesSecond, judgeSame.length),
    missesEitherHuman: missesEither,
    missUcbEitherHuman: ucb(missesEither, judgeSame.length),
    humansDisagree: humansDisagreeOnJudgeSame,
  },
  judgeDifferent: { pairs: judgeDiff.length, falseFlipsSecond },
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
