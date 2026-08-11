# sIVM Verification Verdict: Build / No-Build Decision Memo

Date: 2026-08-04
Basis: 5-agent verification sweep plus 3-agent adversarial attack pass. Every claim below was checked against primary sources (arXiv API, ACM DL, vldb.org volume JSON, OpenReview, ICLR schedule, Google Patents / FreePatentsOnline claim text, vendor documentation) on 2026-08-04.
Purpose: decide whether we build the planned PVLDB submission on Semantic Incremental View Maintenance (sIVM).

---

## 0. Bottom line

**Novelty verdict: DENTED. Decision: BUILD, on the rescoped claim, with the mandatory changes in Section 3. Do not build the paper as currently drafted.**

- **The problem is verified open.** No paper, system, or published patent claim certifies reuse of cached LLM-computed view cells across a definition change (prompt edit or model swap) with a bounded false-reuse rate. Five independent sweeps converged on this, including a complete triage of all 10 vCache-citing papers, full-text reads of every near neighbor, scans of the SIGMOD 2026 and CIDR 2026 accepted lists, and claims-field patent searches. All three attack agents, briefed to kill the thesis, returned "survives".
- **But the draft overclaims on three of four mechanisms and contains one unsound lemma.** The edit taxonomy is preempted (SPADE), cross-version reuse of a materialization has a 30-year-old deterministic ancestor (view adaptation, SIGMOD 1995), the statistical stack is off-the-shelf and already applied to LLM caching decisions, and "deterministically safe" is false for a stochastic model. What is genuinely ours: the estimand (cell-level expected false-reuse of a reuse set under a definition delta), the prompt-delta x row-interaction risk stratifier, the edit-class to certification-consequence mapping, the composition theorem, and the benchmark.
- **The window is roughly one publication cycle.** Brown (SPEAR, VectraFlow, Evergreen) and Berkeley EPIC (SPADE, BARGAIN, Task Cascades) each hold every adjacent ingredient. vCache accumulated 10 citing papers across 6+ groups in about six months.
- **The venue plan is wrong and one option expires tonight.** The PVLDB volume open now is Volume 20 (feeds VLDB 2027), not Volume 21. CIDR 2027's deadline is today, Aug 4, 2026, 11:59pm PT, with a one-submission-per-author cap; it is not viable and should be formally passed on. The only near-term backup is SIGMOD 2027 Round 4 (abstract Oct 10, paper Oct 17, 2026).

The one headline claim the evidence supports, verbatim:

> sIVM is the first method that certifies reuse of cached outputs of an LLM-defined table column across a change to the column's definition (prompt edit or model swap), selecting a reuse set whose expected false-reuse fraction, defined against the new definition's output distribution, adjudicated by a calibrated judge, at certification time, for a pinned model snapshot, is at most alpha.

Four disclaimers must appear in the paper or reviewers will write them for us: not the first prompt-edit taxonomy (SPADE), not the first cross-version view reuse (Gupta/Mumick/Ross 1995), not the first empirical-Bernstein / confidence-sequence / FDR machinery in LLM decisions (Maurer-Pontil; Waudby-Smith & Ramdas; Wang & Ramdas; applied to caching in arXiv:2603.08907), not the first versioned-prompt-view framing (SPEAR, CIDR 2026).

---

## 1. Novelty verdict: DENTED (problem intact, mechanisms overclaimed)

### 1.1 What survived, with the evidence

1. **The open problem itself.** Certified cross-version reuse of cached stochastic-LLM view outputs is unoccupied as of 2026-08-04:
   - vCache (arXiv:2502.03771, ICLR 2026 poster): full text of v5 contains no invalidation, versioning, prompt-template-change, or model-swap mechanism. All 10 citing papers were triaged; every one is fixed-definition (Krites, MVR-cache, TVCACHE, QVCache, StepCache, etc.).
   - Every certified semantic-operator system is one-shot proxy-vs-oracle under a fixed task: SUPG (PVLDB'20), LOTUS (PVLDB'25), BARGAIN and Task Cascades (SIGMOD'26), ThalamusDB (deterministic bounds, SIGMOD'24), Stretto, Abacus (VLDB'26), Evergreen. Scans of ~46 LOTUS-citing and 17 BARGAIN-citing papers surfaced nothing cross-version.
   - Incrementality exists only on the data axis: Continuous Prompts / VectraFlow (streaming tuples), Streaming Model Cascades (certified, but new-tuple axis), Snowflake dynamic tables (data-delta refresh; any definition change always reinitializes).
   - Deterministic blanket invalidation is the shipped state of the art: DSPy, promptfoo, Braintrust hash the template into the cache key; DocETL invalidates the edited op plus everything downstream; Execution Lineage (arXiv:2605.06365) invalidates all descendants on any hash change. Practitioner guidance is uniformly "flush on template change".
   - Patents: claims-field searches for spreadsheet + LLM + cache/reuse return zero; the closest five claim texts (Section 5) are all deterministic-dependency or fixed-definition.
2. **Mechanism 1: prompt-delta x row-interaction stratification.** No prior system computes a row-level risk signal from a definition delta. Even the strongest reduction attack (Section 3, A1) concedes the SUPG/BARGAIN reduction has no such signal. SPADE classifies deltas but scores no rows.
3. **The edit-class to certification-consequence mapping.** Which classes admit one-sided tests, which admit informative priors, and how class structure feeds the certificate: found nowhere. The taxonomy exists (SPADE); its certification semantics do not.
4. **The benchmark.** No prompt-edit benchmark with cross-version reuse-certification labels exists. SemBench (VLDB 2026) benchmarks engines; SemCEB benchmarks cardinality estimation. Claim: "first benchmark with cross-version reuse-certification labels", not "first prompt-edit taxonomy".
5. **The motivation, now documentable from primary sources.** Microsoft Dataverse prompt columns went GA shipping blind cross-version reuse as the default ("updating the prompt definition does not recalculate existing prompt values..."); Airtable offers keep-vs-regenerate with no certification; Excel's COPILOT function is capped at 100 calls per 10 minutes (a 70K-cell rebuild is roughly 5 days in-app); Snowflake reinitializes on any definition change; Microsoft Foundry force-migrates models on a non-extendable 18-month clock (gpt-4o to gpt-5.1 on 2026-10-01). The gap is real and shipping at fleet scale.

### 1.2 What is dead as claimed, with the exact prior art

| Claimed novelty | Killer prior art | What remains claimable |
|---|---|---|
| "Novel taxonomy of edit classes" | SPADE, arXiv:2401.03038 (Jan 2024), Table 2: 9-category prompt-delta taxonomy from 19 real pipelines (Inclusion/Exclusion Instruction = scope narrowing/widening; Qualitative Criteria = new-criterion; structural = formatting-only), GPT-4 delta classifier F1 = 0.81 | The class-to-certification-consequence mapping. Seed our benchmark's classes from SPADE so the taxonomy is empirically grounded, not invented. |
| "Cross-version reuse is open" (unscoped) | Gupta, Mumick, Ross, "Adapting materialized views after redefinitions", SIGMOD 1995: reuses the old materialization under view-definition change, with per-redefinition-class case analysis (adding a WHERE conjunct = scope narrowing) | The claim scoped to stochastic LLM-computed views with statistical certification. Cite 1995 as the deterministic ancestor or an informed reviewer rejects the framing outright. |
| "Novel statistical machinery" (stratified EB + BH-FDR + anytime validity) | Empirical Bernstein: Maurer & Pontil 2009, Audibert et al. 2009. Without-replacement bounds: Bardenet & Maillard 2015. Betting/WoR confidence sequences: Waudby-Smith & Ramdas (JRSS-B). e-BH FDR under arbitrary dependence: Wang & Ramdas, JRSS-B 2022. Anytime-valid stopped e-BH: arXiv:2502.08539. Already applied to LLM caching trust: arXiv:2603.08907, arXiv:2602.18922. Confidence sequences inside a semantic engine: Evergreen, arXiv:2604.26180. Cheap-predictions-plus-few-labels inference: PPI (2301.09633), PPI++ (2311.01453), Active Statistical Inference (2403.03208), AutoEval Done Right (2403.07008) | The estimand and the composition theorem: stratified, size-weighted, dependence-robust, anytime-valid certification of a cell-level false-reuse bound for cross-version reuse sets. Novel as a composition and problem mapping only. |
| Scope-narrowing lemma: "cached FALSEs are deterministically safe" | Category error, falsifiable with one row. Monotonicity holds for the ideal predicate, not the stochastic channel: Sclar et al. (arXiv:2310.11324, ICLR 2024) show up to 76 accuracy points from formatting-only changes; Salinas & Morstatter (arXiv:2401.03729) show a trailing space flips answers. Determinism is unavailable even at T=0: Thinking Machines batch-invariance result (80 distinct completions in 1,000 identical T=0 calls); Background Temperature (arXiv:2604.22411, TMLR 2026) | A one-sided certificate conditional on a stated semantic-monotonicity / model-consistency assumption, with the empirical violation rate measured per model and edit class and folded into alpha. Delete the word "deterministically". |
| "Zero-recompute edit classes" (formatting-only, synonym) | Same fragility literature: any class that bypasses sampling ships false reuses at a rate no alpha bounds | Edit classes as stratification priors and one-sidedness structure only. Every reused cell passes through certified sampling. |
| Model-swap axis as a structured mechanism | No delta structure exists for M to M'. Format sensitivity correlates only weakly across models (Sclar). Flip-rate estimation under model updates is owned by Positive-Congruent Training (2011.09161), MUSCLE (2407.09435; >60% negative-flip regressions in some updates), FlipGuard (2410.00508). RETAIN (2409.03928) is migration regression-testing tooling, not a cache | Model swap as a secondary application: certified flip-rate-bounded reuse with purely statistical stratification, motivated by forced provider migration (Foundry 18-month lifecycle, auto-upgrade). |
| "First to treat AI columns / prompts as versioned views" | SPEAR (arXiv:2508.05012, CIDR 2026, Brown): prompts as versioned, provenance-tracked views; its reuse is KV/token-level only | Claim the certification machinery. Never claim the framing. |

### 1.3 Verdict logic

Killed would mean someone certifies cross-version reuse; nobody does, verified exhaustively. Intact would mean the four mechanisms stand as drafted; they do not: two are preempted in their stated generality, the zero-recompute tier is empirically false, and the flagship lemma needs an assumption to be true. Hence DENTED: the paper is buildable and worth building, but only after the claims are rebuilt around the estimand, the stratifier, the composition theorem, and the benchmark, and only if it moves fast.

---

## 2. Citation audit table

Rule for the draft: **the paper may cite only rows marked CONFIRMED, with the listed corrections applied.** Zero references were hallucinated; every failure is framing or metadata. ("Not-found" results in the sweep were gap searches, i.e., good news, and do not appear here.)

### 2.A Bibliography items (papers, benchmarks, patents)

| # | Reference (as in source docs) | Status | Required correction / usage note |
|---|---|---|---|
| 1 | LOTUS, arXiv:2407.11418 = PVLDB 18(11):4171-4184 | CONFIRMED | Cite the published title, not the arXiv title. Best-evidenced published title (PDF read + SPEAR's reference list + DOI 10.14778/3749646.3749685): "Semantic Operators and Their Optimization: Enabling LLM-Based Data Processing with Accuracy Guarantees in LOTUS". One sweep agent recorded a variant ("...Towards AI-Based Data Analytics..."); verify once against p4171-patel.pdf at camera-ready. |
| 2 | FrugalGPT, arXiv:2305.05176 | CONFIRMED | None. |
| 3 | vCache, arXiv:2502.03771, ICLR 2026 | CONFIRMED | Poster (Poster Session 1, Apr 23, 2026). Quote positioning from v5 (Feb 21, 2026); v1 was titled "Adaptive Semantic Prompt Caching with VectorQ". |
| 4 | BARGAIN, arXiv:2509.02896, SIGMOD'26 | CONFIRMED | Real title: "Cut Costs, Not Accuracy: LLM-Powered Data Processing with Guarantees" (BARGAIN is the system name). PACMMOD DOI 10.1145/3769776. |
| 5 | Task Cascades, arXiv:2601.05536, SIGMOD'26 | CONFIRMED | PACMMOD DOI 10.1145/3786702. SIGMOD 2026 already took place (May 31-Jun 5, Bengaluru). |
| 6 | Stretto, arXiv:2602.04430 | CONFIRMED | No venue; cite as preprint. Affiliation is TU Darmstadt / EURECOM. |
| 7 | Abacus, arXiv:2505.14661 | CONFIRMED | Add published ref: PVLDB 19(5):1060-1073 (VLDB'26). |
| 8 | Query-centric AQP, arXiv:2607.00254 | CONFIRMED | Unrefereed preprint, no venue, looser guarantees framing. Cite as preprint or drop; never present as a peer-reviewed "certified" baseline. |
| 9 | ThalamusDB, PACMMOD 2(3) 2024, Jo & Trummer | CONFIRMED | DOI 10.1145/3654989. Its bounds are deterministic and treat the models as ground truth; characterize accordingly. |
| 10 | "VectraFlow", cited via arXiv:2512.03389 | WRONG AS CITED | 2512.03389 is "Continuous Prompts: LLM-Augmented Pipeline Processing over Unstructured Streams" (Chen, Raghavan, Cetintemel). VectraFlow proper is "VectraFlow: Integrating Vectors into Stream Processing", CIDR 2025. Cite both as two artifacts of one group, and acknowledge the Apr 2026 VectraFlow demo (arXiv:2604.03855), which already supports mid-stream edit-recompile (it recompiles operators; it does not reuse cached outputs). |
| 11 | DocWrangler, UIST 2025 | CONFIRMED | DOI 10.1145/3746059.3747625; arXiv:2504.14764; Best Paper Honorable Mention. |
| 12 | Evaporate, arXiv:2304.09433, PVLDB 17(2) | CONFIRMED | Pages 92-105. |
| 13 | DocETL, arXiv:2410.12189 | CONFIRMED | Published: PVLDB 18(9):3035-3048. |
| 14 | Palimpzest, arXiv:2405.14696, CIDR'25 | CONFIRMED | CIDR title differs from arXiv: "Palimpzest: Optimizing AI-Powered Analytics with Declarative Query Processing". Cite the CIDR title for the CIDR version. |
| 15 | TAG, arXiv:2408.14717 | CONFIRMED | None. |
| 16 | SemBench, arXiv:2511.01716 | CONFIRMED | VLDB 2026. Benchmarks engines, not prompt edits; position our benchmark against it explicitly. |
| 17 | SemCEB, arXiv:2606.23081 | CONFIRMED | Cardinality-estimation benchmark; same positioning note. |
| 18 | PASC, arXiv:2605.18812 | CONFIRMED | Single-author unrefereed cs.LG preprint. Do not lean on it as established prior art. |
| 19 | Sema, arXiv:2603.11622 | CONFIRMED | None. |
| 20 | Prune 'n Predict, arXiv:2501.00555 | CONFIRMED | ICML 2025. |
| 21 | Conformal abstention, arXiv:2405.01563 | CONFIRMED | None. |
| 22 | RouteNLP, arXiv:2604.23577 | CONFIRMED | ACL 2026 Industry Track. |
| 23 | Enzyme, arXiv:2603.27775 | CONFIRMED | Cite as SIGMOD Companion '26 (industrial track), not main research track. Purely classical IVM, zero LLM content: supports our gap claim. |
| 24 | Execution Lineage, arXiv:2605.06365 | CONFIRMED | Preprint, no venue. Deterministic hash-identity invalidation; cite as the recompute-all pole we contrast against. |
| 25 | CAPC, arXiv:2607.15516 | CONFIRMED | Unrefereed preprint. |
| 26 | SUPG, Kang et al. | CONFIRMED | PVLDB 13(11):1990-2003. Use these page numbers. |
| 27 | SWDE benchmark | CONFIRMED | Hao et al., SIGIR 2011. 8 verticals, 80 sites, 124,291 pages. |
| 28 | BIRD, arXiv:2305.03111 | CONFIRMED | NeurIPS 2023. |
| 29 | Spider, Yu et al. | CONFIRMED | EMNLP 2018, ACL Anthology D18-1425. |
| 30 | DIN-SQL, arXiv:2304.11015 | CONFIRMED | NeurIPS 2023. |
| 31 | DAIL-SQL, arXiv:2308.15363 | CONFIRMED | PVLDB 17(5):1132-1145 (DAIL-SQL is the method name within). |
| 32 | LinkedIn talent search, arXiv:1809.06473 | CONFIRMED | CIKM 2018. |
| 33 | DBSP, arXiv:2203.16684 | CONFIRMED | PVLDB 16:1601-1614 (VLDB 2023 Best Paper); extended VLDBJ 2025 version exists. Deterministic; supports gap claim. |
| 34 | F-IVM, arXiv:1703.07484 | CONFIRMED | SIGMOD 2018; extended VLDBJ 2023. Deterministic; supports gap claim. |
| 35 | GPTCache | CONFIRMED | Fu Bang, NLP-OSS @ EMNLP 2023 (2023.nlposs-1.24). Static-threshold cache, no guarantees. |
| 36 | RETAIN, arXiv:2409.03928 | WRONG AS CITED | Exists (EMNLP 2024 System Demonstrations, pp. 301-310) but it is NOT a semantic cache: it is an interactive regression-testing / diff tool for LLM migration. Recast as motivation evidence that migration cost is a recognized industry pain point (Adobe). |
| 37 | US 12,481,837 (prompt configuration for LLM in spreadsheets) | CONFIRMED | Microsoft, granted Nov 25, 2025, priority Mar 9, 2023. Claim text read in full: no caching, no reuse, no certification (Section 5). |
| 38 | US 12,450,225 (dynamically limiting recalc scope) | CONFIRMED | Microsoft, granted Oct 21, 2025, priority Mar 31, 2021. Deterministic reference-graph scoping only (Section 5). |
| 39 | US20230259705A1 + US12073180B2 | WRONG AS CITED | Both are ONE family from Unlikely Artificial Intelligence Ltd (Tunstall-Pedoe; the A1 is the pre-grant publication of the B2). Not Microsoft, not spreadsheets. Drop, or cite once with correct attribution. |

**Accounting: 39 bibliography items checked. 36 CONFIRMED, 3 WRONG AS CITED (#10, #36, #39), 0 not-found / hallucinated.**

### 2.B Venue facts

| Claim in source docs | Status | Verified reality |
|---|---|---|
| "PVLDB Vol 21 rolling monthly deadlines" as our target | WRONG | The volume open Apr 1, 2026 through Mar 1, 2027 is Volume 20 (feeds VLDB 2027). Monthly deadlines on the 1st; mandatory abstract the 25th of the prior month; CMT opens the 20th of the prior month. Vol 21 opens ~Apr 2027 (VLDB 2028). |
| SIGMOD 2027 rounds Jan 17 / Apr 17 / Jul 17 / Oct 17, 2026 | CONFIRMED | Abstracts 7 days before each. As of today only Round 4 remains (abstract Oct 10, paper Oct 17, 2026). Max 10 research-track papers per author. Conference Jun 13-19, 2027, Huntington Beach. |
| CIDR 2027 deadline Aug 4, 2026; one-submission-per-author rule | CONFIRMED | 11:59pm PT tonight; "at most one submission of any kind" per author; 6 pages incl. references; notification Oct 6, 2026; conference Jan 24-27, 2027, Amsterdam. |

### 2.C Product / pricing claims verified for the motivation and economics sections (all CONFIRMED against primary docs)

- Dataverse prompt columns GA: prompt edits do NOT recalculate existing values until a row's source columns update (blind version mixing is the shipped default).
- Airtable AI fields: explicit regenerate-vs-keep choice; human-edited cells never auto-overwritten.
- Excel COPILOT: 100 function calls per 10 minutes; docs warn results may change with identical arguments.
- Snowflake dynamic tables: Cortex AI functions participate in incremental (data-delta) refresh; adaptive mode "typically skips reinitialization"; CREATE OR REPLACE on a definition change always reinitializes.
- Clay: manual conditional runs, filtered-view re-runs, ~10-row free prompt tests (uncertified partial recompute in practice).
- dbt: logic change means --full-refresh.
- DSPy / promptfoo / Braintrust: exact-hash cache keys; any template edit is a miss / flush.
- Microsoft Foundry: 18-month non-extendable GA lifecycle, retirements return 410 Gone, Standard deployments auto-upgrade across families (gpt-4o 2024-05-13 to gpt-5.1 on 2026-10-01).
- Batch pricing: 50% batch discounts (OpenAI, Anthropic, Google); Anthropic cache reads at 0.1x input price, stackable with batch. A 70K-row rebuild: ~$7 (Gemini 2.5 Flash-Lite batch), ~$79 (Haiku 4.5 batch), ~$800-1,600 (frontier, Fable 5 at $10/$50), >$2,000 (agentic columns with web search at $10 per 1K searches). Sonnet 5 price increases to $3/$15 on 2026-09-01. (GPT-5.5 at ~$5/$30 is from third-party trackers; flag as non-primary if used.)

---

## 3. The attack board

Each objection is verified; each answer is mandatory. Tags: [SCOPE] claim rewrite, [PROVE] theory work, [EXPERIMENT] evaluation work, [REFRAME] positioning work.

### Cluster A: identity / reduction attacks

**A1. "sIVM is SUPG/BARGAIN with the stale cache as the proxy and the new prompt as the oracle."** False-reuse of a selected set is 1 minus precision of that set; the certification template is exactly SUPG (PVLDB 13(11)) / BARGAIN (SIGMOD'26).
Answer: [EXPERIMENT] implement BARGAIN/SUPG-with-stale-cache-as-proxy (with and without naive delta features) as a first-class baseline and beat it. [REFRAME] state why the reduction is weaker: it has no row-level risk signal; constructing that signal from the prompt-delta x row interaction is mechanism 1, which no prior system computes. If the baseline is missing, the reviewer builds it in their head and rejects.

**A2. "The statistics are textbook, and even the application to caching is published."** Maurer-Pontil EB; Waudby-Smith & Ramdas confidence sequences (including without-replacement, exactly our fixed-table setting); Wang & Ramdas e-BH; stopped e-BH (arXiv:2502.08539); EB/CS/LTT applied to cache-serving trust (arXiv:2603.08907, 2602.18922); confidence sequences in a semantic engine (Evergreen); PPI family for cheap-predictions-plus-few-labels.
Answer: [SCOPE] claim only the problem mapping and the composition; cite all of the above. Any "first to bring these bounds to caching/LLM data processing" sentence is falsifiable on named citations. [PROVE] the composition theorem is the contribution; write it as one.

**A3. "Why not vCache with a version key?"**
Answer: [REFRAME] kill the strawman explicitly in positioning: one delta applied to N rows makes the (pi, r_i) vs (pi', r_i) similarity signal near-constant across rows, so per-entry threshold learning has no row-discriminative signal and no query stream to learn from; and vCache yields per-lookup guarantees, not set-level FDR over a finite population. [EXPERIMENT] include it as a baseline anyway.

### Cluster B: soundness attacks

**B1. The scope-narrowing lemma is a category error.** Monotonicity is a property of the ideal predicate, not the LLM channel; FALSE-to-TRUE flips occur with positive probability (formatting sensitivity: Sclar arXiv:2310.11324, up to 76 points; Salinas & Morstatter arXiv:2401.03729); and determinism fails even at T=0 (Thinking Machines batch-invariance: 80 distinct completions in 1,000 identical T=0 calls; Background Temperature, TMLR 2026). One counterexample row kills the lemma as worded.
Answer: [SCOPE] restate as conditional on a named semantic-monotonicity / model-consistency assumption; delete "deterministically". [EXPERIMENT] measure the violation rate per model and edit class; fold it into alpha or downgrade to a one-sided statistical certificate.

**B2. Zero-recompute classes ship unbounded errors.** Formatting-only edits move accuracy by double digits; any class that bypasses sampling has no bound.
Answer: [SCOPE] demote all classes to stratification priors plus one-sidedness structure; every reused cell passes through certified sampling. [EXPERIMENT] report measured per-class flip rates on the benchmark.

**B3. Estimand mismatch: BH across strata bounds the fraction of bad STRATA, not bad CELLS.** Strata are size-heterogeneous; one huge wrongly-certified stratum is one FDR error but most of the false-reuse mass; correctly certified strata still leak epsilon_s each.
Answer: [PROVE] define the estimand precisely (expected fraction of reused cells whose cached value differs from fresh recomputation under the current definition, per edit, at certification time) and prove the size-weighted composition theorem from stratum-level bounds to that quantity.

**B4. BH's dependence assumptions are unverifiable here; the sampling model is wrong; reported rates are selection-biased.** Stratum evidence shares one judge, one decode-randomness process, one drift shock (PRDS unverifiable); the table is a fixed finite population (i.i.d. EB is the wrong bound); per-stratum rates reported only for certified strata suffer winner's curse (Benjamini & Yekutieli 2005).
Answer: [PROVE] use e-BH with per-stratum e-processes (valid under arbitrary dependence, composes with optional stopping); without-replacement EB / betting confidence sequences (Bardenet & Maillard 2015; Waudby-Smith & Ramdas); FCR correction for any reported per-stratum rates. [PROVE] show alpha-validity holds for ANY stratifier (frozen before sampling, uniform within-stratum draws): a wrong stratifier costs power, never validity. [EXPERIMENT] adversarial anti-correlated-stratifier run demonstrating realized false reuse still <= alpha.

**B5. The certificate expires under drift, and with tools T the estimand is undefined.** Flip probability depends on server load and silent provider updates (GPT-4 prime-vs-composite 84% to 51% in 3 months, arXiv:2307.09009); tool-augmented f_V depends on external mutable state, so "false-reuse rate" has no fixed ground truth.
Answer: [SCOPE] certify against a pinned snapshot (model build/fingerprint, decode params, frozen tool state); exclude tool-augmented columns or version their tool state; state the time scope. [EXPERIMENT] drift study: realized false-reuse at certification time and after N days / across a provider update, with a recertification trigger. [REFRAME] contrast change-of-definition (ours) vs change-of-world (FreshCache, arXiv:2607.04281), ideally with an experiment showing temporal-decay gating fails on prompt edits.

**B6. For free-text columns, alpha is only as good as an uncertified LLM judge.** GPT-4-judge agreement ~80% with position/verbosity/self-bias (MT-Bench); 2026 evidence of systematic kappa deflation (arXiv:2606.19544). Nominal alpha = 0.01 adjudicated by a judge with 5-15% FNR is fiction.
Answer: [PROVE]+[EXPERIMENT] calibrate the judge on human-labeled data per column type / edit class and propagate judge FPR/FNR into alpha via Learn-then-Test (arXiv:2110.01052) or Conformal Alignment (arXiv:2405.10301); account for judge test-retest nondeterminism. Otherwise [SCOPE]: the theorem and abstract must say alpha is with respect to judge adjudication, not ground truth.

### Cluster C: economics / motivation attacks

**C1. "Just recompute": a 70K-row rebuild costs ~$7-79 on value-tier batch APIs** (50% batch discount plus stacked cache reads at 0.1x input). Any headline computed against list-price synchronous recompute is inflated several-fold.
Answer: [EXPERIMENT] reprice the recompute-all baseline with 2026 batch + cache economics; report absolute dollars per edit at value-tier (~$7-80), frontier (~$800-1,600), and agentic (> $2,000) regimes; add at least one regime where recompute is genuinely expensive (agentic research column or >= 1M rows). [SCOPE] otherwise drop cost as the headline.

**C2. The defensible framing is latency and rate limits, not dollars.** Excel COPILOT: 100 calls per 10 minutes means a 70K-cell rebuild is ~5 days in-app; batch tiers have 24-hour completion windows, incompatible with interactive prompt editing.
Answer: [REFRAME] make time-to-certified-consistent-column after an edit, under real rate limits, the primary metric; report latency-at-fixed-error alongside cost-at-fixed-error. Also answer "prices will keep falling" in-text: Sonnet 5 increases to $3/$15 on 2026-09-01, Fable 5 is $10/$50, Claude 4.7+ tokenizer emits ~30% more tokens; concede value-tier deflation and argue savings compound where spend concentrates.

**C3. "Recompute-all or blind-reuse" is a strawman versus shipped behavior.** Dataverse ships blind version mixing by default; Airtable ships keep-vs-regenerate; Clay ships manual uncertified partial re-runs; Snowflake ships deterministic data-delta reuse.
Answer: [REFRAME] replace the strawman with a primary-sourced industry-practice section quoting the docs. [EXPERIMENT] evaluate blind-reuse (Dataverse semantics) and manual-filter (Clay semantics) as baselines and report their realized false-reuse rates vs sIVM at equal cost.

**C4. "Why certify at all?" Microsoft can ship an uncertified heuristic tomorrow.**
Answer: [EXPERIMENT] measure the silent-error rate of the shipped blind-reuse policy on the benchmark; show certified selection dominates at equal cost. [REFRAME] weaponize forced migration: Foundry's 18-month non-extendable lifecycle and cross-family auto-upgrades mean M changes involuntarily; that is the strongest real-world case for certification. [EXPERIMENT] own the break-even honestly: sampling cost scales ~1/epsilon per stratum; report the frontier (table size, alpha, strata count) where recompute-all is cheaper. A guarantee whose verification costs more than recomputation is a result, not an embarrassment.

### Cluster D: scope and framing attacks

**D1. Model-swap axis collapses as drafted.** No edit classes, no one-sided lemma, no delta to analyze; flip-rate estimation is prior art (PCT 2011.09161; MUSCLE 2407.09435; FlipGuard 2410.00508); cross-model format correlation is weak.
Answer: [SCOPE] demote M-to-M' to a secondary application (certified negative-flip-rate-bounded reuse, purely statistical stratification); cite the flip-rate line; recast RETAIN correctly as motivation. Headline claims scoped to prompt edits.

**D2. Contested framing: SPEAR already calls prompts versioned views.**
Answer: [REFRAME] engage SPEAR head-on: it versions and provenances prompts and reuses KV state; it certifies nothing and reuses no outputs. Claim the certification machinery, not the view framing.

**D3. Compilation moots reuse for some operators.** "From Interpretation to Compilation" (arXiv:2607.13407) compiles semantic operators to deterministic code, making recompute nearly free where it works.
Answer: [REFRAME] one discussion paragraph: where compilation applies, savings shrink; sIVM targets the operators that stay stochastic (judgment-heavy, open-ended columns).

**D4. Benchmark positioning.**
Answer: [REFRAME] position against SemBench (engines) and SemCEB (cardinality); seed edit classes from SPADE's 9 empirically derived categories; claim "first benchmark with cross-version reuse-certification labels".

### Cluster E: velocity

**E1. The window is one cycle.** vCache: 10 citing papers in ~6 months across 6+ groups. Brown has SPEAR + VectraFlow + Evergreen (every ingredient, and they name "principled reuse" as a goal). Berkeley EPIC has SPADE + BARGAIN + Task Cascades + Streaming Cascades and ships 4-6 papers/year here; Shankar finishes her thesis Summer 2026 in exactly this area. Krites shows async-judge verification is now standard; applying it to version migration is an obvious next step.
Answer: submit to PVLDB Vol 20 at the earliest deadline experiments can meet (Section 6); re-run the competitor scan against each new PACMMOD/PVLDB issue before submission; file the provisional before any public disclosure.

---

## 4. Missing related work to add

Grouped; each with the delta the paper must draw.

**Deterministic ancestors (frame the stochastic lift):**
- Gupta/Mumick/Ross, SIGMOD 1995, view adaptation after redefinition (+ journal version). Delta: deterministic SQL, decidable equivalence; we lift to stochastic operators where certification must be statistical.
- Stale View Cleaning, Krishnan et al., PVLDB 8(12):1370 (2015): sample-and-clean stale MVs with statistical bounds. Delta: their staleness is deferred DATA maintenance; ours is definitional.
- Enzyme (2603.27775), DBSP, F-IVM: data-delta deterministic IVM. Execution Lineage (2605.06365): the all-or-nothing invalidation pole.

**Fixed-definition verified caching (the vCache line):**
- vCache v5 (2502.03771); GPTCache; Krites (2602.13165, EuroMLSys'26); MVR-cache (2605.24914); calibration-gap critique (2606.19719); Generative Caching (2511.17565, uncertified output reuse); Mnimi (2511.22118). Delta: per-lookup matching under a fixed definition; no version axis; no set-level FDR.

**Reuse-under-change neighbors (the dangerous ones; cite or die):**
- StepCache (2603.28795): deterministic step reuse + selective patching across perturbed requests; no statistics, no view semantics.
- FreshCache (2607.04281): risk-budgeted reuse under temporal/world drift; not definition change.
- SPEAR (2508.05012, CIDR 2026): versioned prompt views; KV-level reuse only.
- VectraFlow line: CIDR 2025 paper + Continuous Prompts (2512.03389) + demo (2604.03855, edit-recompile).
- PromptDB (2607.21756): prompt as an in-DB datatype; no caching or certification.
- Streaming Model Cascades for Semantic SQL (2604.00660): certified guarantees on the data-arrival axis; draw the data-delta vs definition-delta axis distinction explicitly.
- KV/prefix layer (input-state reuse, outputs always recomputed): Prompt Cache (2311.04934), CacheBlend, "Don't Break the Cache" (2601.06007), Prompt Choreography (2512.23049, TACL), Kalypso (2607.23815), Helium (2603.16104).

**One-shot certification ancestry:**
- SUPG, LOTUS, BARGAIN, Task Cascades, ThalamusDB, Stretto, Abacus, Evergreen (2604.26180, confidence sequences + early stopping), BLIP (VLDB'26, provenance), Kang-group approximate joins (10.1145/3802004), 100x proxy-model E&A (2603.15970 / 10.1145/3802002). Delta: proxy-vs-oracle for ONE fixed task; no cross-version estimand.

**Statistics to cite instead of claim:**
- Maurer & Pontil 2009; Audibert et al. 2009; Bardenet & Maillard 2015 (WoR); Waudby-Smith & Ramdas (betting/WoR confidence sequences); Wang & Ramdas e-BH (JRSS-B 2022); stopped e-BH (2502.08539); Benjamini & Yekutieli 2005 (FCR); Learn-then-Test (2110.01052); Conformal Alignment (2405.10301); Prompt Risk Control (2311.13628); PPI (2301.09633); PPI++ (2311.01453); Active Statistical Inference (2403.03208); AutoEval Done Right (2403.07008); cross-domain UQ for agentic caching (2603.08907); RCPS agent-cache serving (2602.18922).

**Model-swap axis:**
- Positive-Congruent Training (2011.09161); MUSCLE (2407.09435); FlipGuard (2410.00508); RETAIN (2409.03928, recast as migration-pain motivation); Foundry lifecycle docs.

**Fragility, nondeterminism, drift, judges (assumption support):**
- Sclar et al. (2310.11324); Salinas & Morstatter (2401.03729); Thinking Machines batch-invariance (Sep 2025); Background Temperature (2604.22411, TMLR 2026); ChatGPT behavior drift (2307.09009); MT-Bench judge biases (Zheng et al., NeurIPS 2023 D&B); "Reliability without Validity" (2606.19544).

**Motivation / HCI:**
- SPADE (2401.03038, prominent); DocWrangler; RAGGY (2504.13587, CHI 2026 Best Paper: fast pipeline-edit iteration).

**Read before print (checked at title level only; the novelty claim is not safe until someone reads them):**
- Nirvana / "Beyond Relational" (2511.19830 / 10.1145/3786628); "Logical and Physical Optimizations for SQL over LLMs" (10.1145/3725411); "Semantic Data Processing with Holistic Data Understanding" (2604.02655); "From Interpretation to Compilation" (2607.13407, read in part); 100x proxy E&A full text.

---

## 5. Patent posture

We read the independent claims verbatim. What they actually cover:

| Patent | Holder / dates | What the claims cover | Bearing on sIVM |
|---|---|---|---|
| US 12,450,225 | Microsoft; granted Oct 21, 2025; priority Mar 31, 2021 | Limiting recalc scope via a workbook/worksheet external-reference data structure. Deterministic dependency scoping | Closest "selective recomputation in spreadsheets" art. No AI, no sampling, no error bounds. Orthogonal. |
| US 12,481,837 | Microsoft; granted Nov 25, 2025; priority Mar 9, 2023 | NL input, subset selection with cell-address remapping, domain-constrained prompt, accept LLM-suggested formula, recalculate | Prompt construction + recalculate-on-accept. No caching, no reuse of prior LLM outputs, no certification. |
| US 12,333,241 | Microsoft; granted Jun 17, 2025; priority Aug 16, 2023 | "Limit recalculations ... based at least on the indirect dependency" for non-native (Python/Java) cell arguments | Nearest "avoid recomputing expensive non-native cells". Purely dependency-structural; prompts/models absent. |
| US 2026/0154507 A1 | Salesforce; filed Dec 4, 2024 | Threshold-gated semantic cache serving with few-shot fallback | vCache territory: fixed definition, per-query threshold, no bounded error rate, no template-change invalidation. |
| US 12,596,764 | OpenAI; granted Apr 7, 2026 | Prefix-hash prompt caching over activated (KV) tokens | Input-state layer; outputs still recomputed. |
| US 12,431,131 B1 | Amazon; priority Sep 19, 2023 | Multi-turn KV-state reuse, exact-portion matching, explicit deletion | Same layer; no semantics, no guarantees. |
| US 12,259,913 | Inventus Holdings; priority Feb 14, 2024 | Hybrid semantic/lexical answer cache with reciprocal rank fusion, settable thresholds | Fixed-definition answer caching, no statistical guarantee. |
| US20230259705A1 / US12073180B2 | Unlikely AI; priority Aug 24, 2021 | LLM + semantic-node question answering | Irrelevant. One family, wrongly grouped in our source docs as Microsoft spreadsheet art. Fix. |
| US 7,640,490 | Microsoft, 2009 | Throttling recalculation of volatile (nondeterministic) spreadsheet functions | Amusing pre-AI ancestor of "skip recomputing a nondeterministic cell". Optional cite. |
| Microsoft LLM-spreadsheet family (12,536,387; 12,147,758; 12,367,336; 12,481,823; 12,499,306; 12,321,393 + A1/WO) | Mar 2023 provisionals | Every verified claim: prompt orchestration, then formula, then recalculate | None claims storing per-row LLM outputs as a view, reusing across a prompt edit, or bounding false reuse. |

**What this implies for our provisional:**

1. **The claim space is open in published art.** FPO claims-field searches: spreadsheet + LLM claims = 47 documents (all the Microsoft prompt-orchestration family); adding "cache" or "reuse" = zero. "Selective recomputation" + "language model" = one irrelevant hit. Materialized-view + LLM + incremental refresh = only classic deterministic-IVM patents. No vCache filing found.
2. **Draft claims around the pipeline**: definition-delta analysis, row-level risk stratification, certified sampling with finite-population bounds, FDR-selected reuse-set output, bounded expected false-reuse application, recertification triggers on drift; plus dependent claims for edit-class one-sided certification under a stated consistency assumption. Explicitly distinguish from (a) dependency-graph recalc scoping (Microsoft: structural triggers, no statistics) and (b) threshold-gated per-query cache serving (Salesforce: fixed definition, no set-level bound).
3. **Blind spots, so use exact wording**: US applications publish ~18 months after filing; unpublished Microsoft filings on COPILOT() result-caching semantics (the function shipped in 2025 with documented caching and non-volatile recalc) are plausible, as are Google Gemini-in-Sheets filings. Google Patents IP-blocked mid-sweep, so the CPC-scoped international sweep is incomplete; FPO covers US only; CN/KR semantic-cache patents exist (CN121681573B, KR20260056557A) and were sampled, not exhaustively claim-searched. The paper must say "no PUBLISHED patent claims", never "no filings".
4. **File the provisional before any public disclosure** (arXiv counts as disclosure). Field velocity makes our priority date worth more than a polished spec.
5. **FTO is a separate question from novelty**: a shipped sIVM product inside a spreadsheet operates near US 12,450,225 / 12,333,241 / 12,481,837. The paper is unaffected; productization needs a real FTO review. Our claim reading is not legal advice.

---

## 6. Venue facts (verified 2026-08-04)

| Venue | Verified facts | Consequence |
|---|---|---|
| PVLDB Volume 20 | Open Apr 1, 2026 through Mar 1, 2027; papers due the 1st of each month; mandatory abstract the 25th of the prior month; CMT opens the 20th of the prior month; feeds VLDB 2027 | **Our target.** The plan's "Vol 21" is wrong: Vol 21 opens ~Apr 2027 and feeds VLDB 2028. Submitting on the plan's stated volume would follow the wrong CFP. |
| PVLDB Volume 19 / VLDB 2026 | Vol 19 research-track cutoff for VLDB 2026 was Jun 15, 2026; VLDB 2026 is Sept 2026, Boston | Closed to us. Expect adjacent Vol 19/20 papers to keep landing monthly; re-run the competitor scan per issue. |
| SIGMOD 2027 | Four rounds with paper deadlines Jan 17 / Apr 17 / Jul 17 / Oct 17, 2026 (abstracts 7 days earlier); max 10 research papers per author; conference Jun 13-19, 2027, Huntington Beach | Only Round 4 remains: abstract Oct 10, paper Oct 17, 2026. Viable backup if experiments land early. |
| CIDR 2027 | Deadline Aug 4, 2026, 11:59pm PT (today); at most one submission of any kind per author; 6 pages incl. references; notification Oct 6, 2026; conference Jan 24-27, 2027, Amsterdam | Not viable; formally pass. The one-submission cap also constrains any co-author with other CIDR plans tonight. |
| SIGMOD 2026 | Took place May 31-Jun 5, 2026, Bengaluru | BARGAIN, Task Cascades, Enzyme are already public; cite as published. |

**Recommendation:** PVLDB Vol 20, targeting the Nov 1, 2026 deadline (abstract Oct 25, CMT opens Oct 20), with Dec 1 (abstract Nov 25) as the slip boundary. Every month of slip is real scoop exposure given Section 3, E1. Treat SIGMOD 2027 Round 4 (Oct 17) as opportunistic only if theory and experiments land by early October; do not dual-track the same paper.

---

## 7. Build order (what "BUILD" means, next ~12 weeks)

1. **Week 1: rewrite the claims.** Adopt the Section 0 headline verbatim; add the four disclaimers; fix the lemma statement (assumption + one-sided certificate); define the estimand and correctness semantics (output-equivalence vs the new definition's distribution; judge-adjudicated where free-text; pinned snapshot; per-edit, non-compounding across edit sequences via cache-as-is vs current-definition certification).
2. **Weeks 1-3: theory.** Size-weighted composition theorem on e-BH with per-stratum without-replacement e-processes; validity-for-any-frozen-stratifier proposition; FCR for reported per-stratum rates; anytime validity where actually needed (edit sequences, incremental sampling).
3. **Weeks 2-6: benchmark.** ~70K-row corpus; edit suite seeded with SPADE's 9 classes plus scope-narrowing/widening boolean cases; cross-version labels; human-labeled judge-calibration sets per column type.
4. **Weeks 3-8: system + baselines.** Recompute-all repriced (batch + stacked cache reads); blind reuse (Dataverse semantics); manual filter (Clay semantics); BARGAIN/SUPG-with-stale-proxy; vCache-with-version-key; FreshCache-style temporal gate; adversarial stratifier.
5. **Weeks 6-10: experiments.** Cost and time-to-certified-consistency at fixed realized error; realized false-reuse vs nominal alpha (incl. judge-error propagation); savings by edit class with measured per-class flip rates; frontier and agentic regimes; drift/recertification study; break-even frontier.
6. **Throughout:** file the provisional before any preprint; re-run the competitor scan on each new PACMMOD/PVLDB issue and the arXiv cs.DB feed; read the four title-level-only papers before the camera-ready novelty sentence.

---

### Appendix: attack-pass disposition

All three attack agents returned survives = true. Their union of required changes is fully absorbed into Sections 3 and 7; nothing was dropped. The thesis dies only if we (a) keep the unscoped novelty sentences, (b) keep the lemma's "deterministically", (c) headline dollar savings at 70K rows on value-tier models, or (d) miss the window. All four are within our control.
