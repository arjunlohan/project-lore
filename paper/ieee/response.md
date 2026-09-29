---
title: "Response to Reviewers"
subtitle: "Original Manuscript ID: Access-2026-41149"
author: "Arjun Lohan (University of Southern California), corresponding author"
date: "Resubmission, October 2026"
---

**Original Article Title:** "Reuse, but Verify: Certified Maintenance of Table Cells Computed by Large Language Models under Prompt Edits"

**To:** IEEE Access Editor
**Re:** Response to reviewers

Dear Editor,

Thank you for allowing a resubmission of our manuscript, with an opportunity to address the reviewers' comments. We are uploading (a) our point-by-point response to the comments (this document, under "Author's Response Files"), (b) an updated manuscript with every change marked (as "Highlighted PDF"), and (c) a clean updated manuscript without highlights ("Main Manuscript", LaTeX source and PDF).

The reviewers' central concern, raised independently by Reviewers 1 and 3, was that the headline results were certified with a bound (Maurer–Pontil) that our own theorem did not prove for the without-replacement sampling the procedure performs, and Reviewer 3 asked why an exact bound was not used. We agree, and we did not merely restate the numbers under the proven Bardenet–Maillard bound: for a binary loss under without-replacement sampling from a frozen stratum, the exact finite-population (hypergeometric, Clopper–Pearson-type) bound is valid by a short coupling argument and dominates every empirical-Bernstein bound, because a binary loss never needs the range term those bounds pay. The revised manuscript makes that bound the pinned certifier, restates Theorem 1 for that bound and proves it in full (now a high-probability bound on the realized flip count, not only its expectation), regenerates every number from the same stored labels and oracle draws, and keeps the earlier bounds as measured ablation arms. The result is a stronger paper on every axis the reviewers raised: on the main seed, 10 of the 20 benchmark configurations certify instead of 7 (12 certify in at least one sampling replication), mean certified savings rise from 18.5% to 29.5% on 35% fewer oracle calls, the $\alpha=0.1$ budget on the headline edit now certifies 88.4% savings for 90 oracle calls instead of 54.7% for 765 (82.6% mean savings over the 1,000 sampling replications), and the deployment certificate a reviewer re-derived clears both $\alpha=0.2$ and $\alpha=0.1$ under the exact bound.

Two further studies were added because the reviewers asked for evidence rather than assertion: a direct test of the cross-row independence assumption (sequential versus concurrent requests), and a live re-certification of the deployment column 55 days after the original run, which measured provider-side model drift (the flip rate against the same cache rose on the same rows, McNemar p<0.001) and showed the certifier pricing it: the two budgets certified in August certified again, the tighter one a look deeper, and the tightest budget, on which the August draws are silent, was refused. While preparing these we also found and fixed a reproducibility defect in the earlier certifier (its sample path depended on the storage engine's row order); the manuscript discloses it, and the released replay reproduces the published run's every count.

In the Highlighted PDF, produced by latexdiff against the source submitted in August, added or changed text is set in blue and deleted text is omitted, so the highlighted copy paginates like the clean one. Four things are not marked word by word: table bodies, Figure 1, Algorithm 1, and the bibliography, which latexdiff compares as whole blocks (their captions and the surrounding prose are marked, and every table was regenerated from the recomputed artifacts, so every table body should be read as changed); and the checker conditions that moved from the Availability section to Appendix A appear there without markup, because moved blocks are not tracked. Because the bound changed, almost every numerical value in the manuscript changed; each is regenerated mechanically from the released artifacts, and the guards described in Appendix A report zero findings on the revised draft.

Best regards,
Arjun Lohan

---

# Reviewer 1

## Reviewer 1, Concern 1: Unproven validity condition

> Your headline results are certified using the Maurer–Pontil bound, which Theorem 1 states is proven only for independent draws; validity under the without-replacement sampling your procedure actually performs is explicitly not proven. [...] the paper would be considerably stronger if the primary reported numbers used the proven Bardenet–Maillard bound, with Maurer–Pontil results presented as a secondary, empirically-validated variant rather than the headline procedure.

**Author response:** We agree that the headline numbers must rest on a bound proven for the sampling actually performed, and we went one step further than the suggestion. Reviewer 3 (Concern 2) asked why an exact bound was not used, and on reflection the exact bound is the right choice, not merely a comparison point: the flip indicator is binary and the sample is drawn uniformly without replacement from a frozen stratum, so conditional on the stratum's fresh-draw outcomes the sampled flip count is exactly hypergeometric, and the finite-population Clopper–Pearson construction gives an upper confidence bound that is valid for every population realization, hence unconditionally. It bounds the realized whole-stratum flip count, which is stronger than the expectation bound the earlier theorem gave, and it is tighter than either empirical-Bernstein bound because a binary loss never needs their range term: on a clean sample of 90 draws at the pinned per-look level, the exact bound reads 0.050 where Maurer–Pontil read 0.144 and Bardenet–Maillard reads 0.317. Bardenet–Maillard is proven for this sampling, but adopting it as the headline would have cost power for no gain in validity (it certifies the same 7 configurations as Maurer–Pontil, 3 of them at the same look and 4 at a later one).

**Author action:** The pinned certifier now uses the exact finite-population bound (Section III, "The bound", Eq. 1; Algorithm 1). Theorem 1 is restated for that bound and proven in full by the coupling argument; a remark after the proof states that the same argument covers any bound valid for uniform without-replacement draws, including Bardenet–Maillard, while Maurer–Pontil is retained only as an ablation arm. Every result in the manuscript (Table 2, the calibration study, the baselines, the SUPG-style competitor, the model-family tables, the deployment section) was regenerated under the exact bound from the same stored labels and oracle draws. The bound ablation (Section V, "The bound"; Table 9; Appendix B) now compares five bounds inside the same procedure: exact, Clopper–Pearson (binomial), betting sequence, Maurer–Pontil, and Bardenet–Maillard, with their null-calibration results. The Availability section states that the earlier numbers are reproducible from the same release with the Maurer–Pontil arm selected, so nothing about the earlier version is lost.

## Reviewer 1, Concern 2: Generalization across models

> Only one model carries the full experimental program; the other four families are tested on just two edit pairs, and one probe uses only n=500. [...] I'd encourage running the full edit set (all five pairs) across at least 2–3 additional families to substantiate the generality implied in the abstract and conclusion.

**Author response:** We ran the remaining three pairs (the production column's scope widening and the two Djinni select pairs) on three further families at n=2,000 each, with the same seeded rows as the primary evaluation vectors, the runner's own framing, temperature 0, one fresh draw per cell, and the pinned procedure, and we completed gpt-5-nano to n=2,000 on both lab pairs so that no n=500 row remains. Gemini 2.5 Flash-Lite, GLM-4.7-Flash, and Qwen3.7-Flash now carry all five pairs. Gemini 3 Flash stays at the two lab pairs: its reasoning regime prices the further calls at roughly $200, and the manuscript says so in the caption of Table 6. The results (Table 7) read the same way as the lab pairs did. On scope widening, certification reproduces on all three families at $\alpha=0.2$ (Gemini 2.5 Flash-Lite 95.3% savings at 8.22% realized presented-cells error; GLM-4.7-Flash 74.1% at 6.29%; Qwen3.7-Flash 79.8% at 14.35%) and at $\alpha=0.1$ on GLM-4.7-Flash (67.3% at 6.03%), while the two families whose widening flip rate sits near or below 10% are refused at 0.1 by the futility rule, as the primary model's own frontier predicts. On the Djinni select pairs, Gemini 2.5 Flash-Lite certifies both edits at both budgets (formatting 23.3% and 86.5%, criteria 56.7% and 88.7%) GLM-4.7-Flash likewise (36.5% and 65.4%; 39.2% and 64.9%), and Qwen3.7-Flash as well (formatting 57.3% and 78.1%, criteria 43.6% and 83.5%; select-column floor 2.8%), with every realized presented-cells error inside its budget; the per-stratum floor of the select column varies across families (2.8% to 6.5%) in the same way the Boolean column's does. Independently of the new runs, the earlier lab-pair results were re-derived under the exact bound (replays over the stored per-row draws, no new model calls), and the qualitative finding is unchanged and sharper: certification reproduces on all five families (the completed gpt-5-nano, whose self-flip floor of 34.8% sits above every budget in the grid, is refused on every stratum of the formatting edit and certifies the cached-TRUE stratum of the synonym edit at $\alpha=0.2$), and which edit is benign, and on which cached-value stratum, is a property of the (edit, model) pair.

**Author action:** Section V, "Other model families", and Table 6 were regenerated with gpt-5-nano as a full family; a new Table 7 and the accompanying paragraph report the remaining three pairs on the further families; a scope statement was added to the setup paragraph (Section V, "Setup and evaluation protocol: Scope") and to the limitations (Section VIII, "Models and snapshots") stating that one budget-class model carries the full program and what the family study does and does not establish; the abstract states the count. Table 3 lists every model identifier with its run dates and list prices.

## Reviewer 1, Concern 3: Equivalence relation scope

> Exact-match equivalence limits applicability to Boolean/select columns. Since your introduction motivates free-text "spreadsheet copilot" columns, even a small pilot with a judge-based equivalence relation (with its own error calibrated into $\alpha$, as you note in Section VIII) would substantially broaden the paper's relevance.

**Author response:** [TO BE COMPLETED PENDING THE PILOT: a free-text column over the Stack Overflow profiles with a judge-based equivalence relation, the judge's miss rate calibrated on author-labeled pairs and folded into $\alpha$ as an upper confidence bound.] We have made the calibration recipe explicit in the manuscript: a judge that misses a fraction q of true flips inflates the certified rate by at most q, so certifying at $\alpha - \hat{q}$ with an upper confidence bound $\hat{q}$ on the miss rate restores the guarantee, and nothing else in the procedure changes.

**Author action:** Section VIII, "Equivalence and columns", states the recipe and the scope limitation (two column types, exact match) in the terms above. [TO BE COMPLETED: pilot results.]

## Reviewer 1, Minor 1: "AI table" product category citation

> The "AI table" product category in your introduction would benefit from a supporting citation or concrete named example.

**Author response:** Agreed.

**Author action:** The first paragraph of the Introduction now names and cites four shipping products whose columns are computed per row by a language model (Google Sheets' AI function and AI columns, Airtable AI fields, Notion AI autofill for databases, and Snowflake Cortex's AI_COMPLETE and AI_CLASSIFY over table columns), each cited to its official documentation with an access date, and notes that Microsoft's Excel COPILOT function shipped as a preview and was withdrawn in September 2026, as a measure of how quickly this product surface is moving (refs. [1]–[5]).

## Reviewer 1, Minor 2: Label-noise discussion

> Consider grounding the label-noise discussion (Section V.b) in existing LLM-as-annotator agreement literature.

**Author response:** Agreed; the picture that literature draws (model labels reaching crowd-worker or expert agreement on many tasks, with task-specific noise that has to be validated rather than assumed) is exactly the one our relabeling measurements show.

**Author action:** The label-noise passage in Section V, "Setup and evaluation protocol", now cites Gilardi et al. (PNAS 2023), Ziems et al. (Computational Linguistics 2024), Pangakis et al. (arXiv 2023), and Törnberg (arXiv 2023), and a new Table 4 reconciles every flip-rate figure quoted for the headline pair and its cached-TRUE stratum with its edit, its cells, and its instrument.

## Reviewer 1, further remarks in the assessment

The reviewer's assessment also noted that the deployment-scale run was a replay rather than a live timed run, and that the single-primary-model scope should be stated earlier than Section VIII. Both are addressed: the deployment column was re-certified live on 29 September 2026 under the exact bound, with the wall clock of the live decision reported (101 seconds for the loose budget including the oracle calls, 304 seconds for the tight budget), and the scope statement now appears in the setup paragraph of Section V.

---

# Reviewer 2

## Reviewer 2, Concern 1: Clearer explanation of the certification framework

> The authors should provide a clearer explanation of the proposed certification and verification framework, including its assumptions, workflow, correctness criteria, and how it determines whether a previously computed cell can be safely reused after a prompt change.

**Author response:** We agree that the first version asked the reader to assemble the framework from several places. The revision adds explicit statements of each element the reviewer names.

**Author action:** (1) *Assumptions:* Section II now opens with a "Terminology" paragraph defining stratum, look, floor, certificate, and the other recurring terms before the technical sections use them (the Introduction glosses the few it needs inline), and a notation table (Table 1); Assumptions 1–3 are stated together, each says which experiment probes it (decode pinning and snapshot scope: Section V, "The September run"; independence across rows: Section V, "Independence across rows"; the sampling assumption: the calibration study), and the proof says which consequence of independence it uses (non-interference between rows). (2) *Workflow:* Section III gives the five steps, and a new Algorithm 1 states the complete procedure in pseudocode, including the futility rule, the two guarantee targets, and the apply step. (3) *Correctness criterion:* the two estimands (presented-cells and reuse-set false-reuse rates) are defined in Section II, and Theorem 1 states exactly what a certificate guarantees for each, in the realized terms of the run, with the proof rewritten for the exact bound; Section II, "Reading the budget", restates the guarantee in words. (4) *How reuse is decided:* Section III, "The bound", defines the upper confidence bound in one equation (Eq. 1) and explains in words why it is valid; a stratum is reused if and only if that bound clears the budget at some look, and the worked running example in the Introduction and Figure 1 follow one column through the decision.

## Reviewer 2, Concern 2: Distinction from existing methods and comparisons with baselines

> The contribution would be stronger if the authors more clearly distinguished the proposed approach from existing methods for LLM verification, caching, incremental computation, and result reuse. Additional theoretical justification, broader experimental validation, and comparisons with relevant baseline approaches would help demonstrate the novelty, applicability, and generalizability of the contribution.

**Author response:** The first version compared against four baselines (B1 verified-cache similarity, B2 aggregate-only certification, B2' a SUPG-style competitor matched on budget, labels, target, and multiplicity, and B3 guarantee-free embedding transfer) and positioned the work against four lines of related work in prose. We have made the distinction visible at a glance and broadened the validation.

**Author action:** Section VII opens with a new comparison table (Table 11) that lists, for each neighboring system or line of work (guaranteed semantic query processing, verified caching, stale-view and online aggregation, classical view maintenance, step-level reuse, guarantee-free semantic caches, and per-output verification by assertions, regression suites, or vote-of-k), the quantity it certifies, what it holds fixed, what changes, and the form of its guarantee, beside the same row for our method. The theoretical justification is now a fully proven theorem for the bound actually used (Reviewer 1, Concern 1). The experimental validation was broadened with a calibration study restated in terms of the rate of unsafe certificates against the nominal budget (Section V, "Calibration"), a five-bound ablation (Table 9, Appendix B), an independence check (Section V, "Independence across rows"), a live re-certification 55 days after the deployment run that measures model drift (Section V, "The September run"), and the remaining edit pairs on three further model families (Section V, "Other model families"; Table 7). The baselines and the matched SUPG-style competitor were regenerated under the exact bound, with both arms of the head-to-head using the same bound so that the comparison isolates per-stratum against aggregate certification and nothing else (Section V, "Baselines"; Table 5).

---

# Reviewer 3

## Reviewer 3, Concern 1: Theorem 1 does not cover the bound used for the headline results

> Theorem 1 proves the result for the Bardenet-Maillard bound, but the headline results use the Maurer-Pontil bound. [...] Under the Bardenet-Maillard bound, the deployment certificate at $\alpha$ = 0.2 (5 flips in 180 draws) reaches 0.230, which is above the budget at the look where it was issued. Please report the headline and deployment results using a bound that has been proved for this setting, or state clearly that Theorem 1 does not cover those results.

**Author response:** The reviewer's re-derivation is correct: on 5 flips in 180 draws from the 81,469-cell cached-FALSE stratum, at the pinned per-look level, the Bardenet–Maillard bound reads 0.230 and does not clear $\alpha=0.2.$ We have adopted a bound that is proven for exactly this setting and is tighter than both empirical-Bernstein bounds, the exact finite-population (hypergeometric) bound, as described under Reviewer 1, Concern 1. On the same evidence it reads 0.073, which clears $\alpha=0.2$ and $\alpha=0.1$ alike; under it the August draws certify the loose budget at look 45 (1 flip), so the whole certification costs 90 oracle calls instead of 225, and the tight budget at look 180 (5 flips) for 225 calls instead of 765. Every headline and deployment result in the manuscript is now reported under this proven bound, and Theorem 1 covers them.

**Author action:** Section III ("The bound", Theorem 1 and its proof) and Section V ("Deployment scale", Table 8) were rewritten. The deployment section reports three regimes over one sample path: the live August run under Maurer–Pontil (the certificate the system applied, kept for the record), the same stored draws under the exact bound, and a live re-certification on 29 September 2026 under the exact bound. The reviewer's 0.230 figure, and what the exact bound reads on the same evidence, appear in the text. Table 9 includes the deployment evidence as one of its columns.

## Reviewer 3, Concern 2: Exact bounds for a binary outcome

> A flip is a yes-or-no outcome. Exact bounds, such as Clopper-Pearson or a hypergeometric bound for sampling without replacement, are valid for this setting and may be tighter when there are few flips. Please explain why Maurer-Pontil was chosen or compare it with an exact bound.

**Author response:** The reviewer is right, and the honest explanation is that the earlier version inherited empirical-Bernstein bounds from the guaranteed semantic-query-processing literature it builds on (SUPG, BARGAIN, Task Cascades), where the loss is often not binary, without asking whether the binary, without-replacement case admitted an exact bound. It does, and the exact hypergeometric bound is not only valid but uniformly tighter than the empirical-Bernstein bounds on this workload, and tighter than the binomial Clopper–Pearson bound by the finite-population correction. We therefore did not stop at a comparison: the exact bound is now the pinned certifier, and the comparison the reviewer asked for is reported in full.

**Author action:** Section III, "The bound", defines the exact bound (Eq. 1) and explains why it dominates. Section V, "The bound", and Table 9 compare five bounds inside the same pinned procedure over the same stored labels: the exact bound certifies 10 of the 20 benchmark configurations against 9 for Clopper–Pearson, 9 for the betting sequence, 7 for Maurer–Pontil, and 7 for Bardenet–Maillard, at mean savings of 29.5% against 28.1%, 29.1%, 18.5%, and 16.4%, on 7,458 oracle calls against 8,054, 7,616, 11,515, and 12,325; Appendix B (Table 12) lists every configuration. Each arm was also replayed through the calibration protocol (36,000 trials per arm, 18,000 of them at planted rates above the budget): no arm's null certification rate is demonstrably above the per-stratum $\delta$ of 5%, and the rate of certificates whose realized flip count exceeds the budget (the event Theorem 1 bounds) is at most 1.00% of trials for the exact bound in any null configuration. The two suggested references (Clopper and Pearson 1934; Howard et al. 2021) are cited where the exact bound and time-uniform alternatives are discussed; we found both directly relevant.

## Reviewer 3, Concern 3: Narrow the edit-class claim

> The evaluation covers only three columns and five author-written edits, with one example of each edit class per column. [...] A single example per class is too little to support the claim that edit class does not predict the flip rate. Please narrow that claim and discuss how the limited set of columns and outputs affects the findings.

**Author response:** Agreed. The claim the evidence supports is that surface class *can* fail to predict flip rate, not that it generally does, and the first version already said so in the Introduction; the limitations section did not.

**Author action:** Section VIII now has a paragraph "Equivalence and columns" stating that the columns studied are two Boolean columns and one four-way ordinal select, that numeric and free-text columns are not evaluated, and that five author-written edit pairs, one per class per column, show that class can fail to predict flip rate, not how often it does; the edit-class sentences in the Introduction and in Section VII were checked against that strength.

## Reviewer 3, Concern 4: Applications for a 20% budget, and what tighter budgets achieve

> Most of the useful savings appear at $\alpha$ = 0.2, which allows an expected 20% of the cells shown in a certified group to be stale and wrong. At $\alpha$ = 0.05, almost nothing is certified for reuse. Please give examples of applications where a 20% error budget would be acceptable, and explain more plainly what the method can achieve with a tighter budget.

**Author response:** Two things changed here. First, the exact bound moved the frontier substantially: on the headline edit, $\alpha=0.1$ now certifies 88.4% savings for 90 oracle calls on the main seed (82.6% mean over the sampling replications; previously 54.7% for 765), and $\alpha=0.05$, previously refused, certifies in 74.4% of sampling replications by the deepest look of the schedule, for 38.6% mean savings; at deployment scale the tight budget costs 225 oracle calls on the August draws and 405 on the September ones, against 89,184 cells. Second, we now say plainly where a 20% budget is defensible and where it is not.

**Author action:** Section VIII opens with a new paragraph, "Which budgets are usable, and for what": a 20% budget is defensible where a person reads the column row by row before acting on it (a recruiter screen, a lead list, an enrichment sheet a reviewer walks through), where the cost of a stale cell is a wasted glance and the alternative on offer is today's status quo of reusing everything at the population flip rate with no bound; it is not defensible for a column that feeds an aggregate or a downstream filter, where the strict reuse-set mode and a budget at or below 0.05 are the right setting. The paragraph then states what tight budgets cost and achieve in the revised numbers, and that sample cost at a tight budget is still a constant in the table size, so what a tight budget cannot buy is certification of a stratum whose flip rate exceeds it, which is the correct outcome (Section V, "The September run", shows that refusal at $\alpha=0.05$ after model drift, on a budget the August draws could not reach). The realized presented-cells error under a certificate remains far below the budget throughout (3.20% at $\alpha=0.2$ on the headline pair), which the text also states.

## Reviewer 3, Concern 5: Independence across rows is untested

> Assumption 1 requires independent results across rows. However, the paper cites studies [3] and [4] showing that provider-side batching can make responses correlated. The author does not test this assumption. A check comparing flip rates from sequential and concurrent requests would help.

**Author response:** Agreed; we ran the check the reviewer describes, on 29 September 2026, on 300 rows of the evaluation vector: the formatting edit's new version was drawn twice for every row, once with a single request in flight (78 minutes of wall clock) and once at the deployment run's concurrency of 32 (4.6 minutes), against the same cache, with requests that errored or exceeded a 90-second ceiling excluded from their arm (9 sequential, 28 concurrent, where the ceiling binds more often). The falsification criterion was fixed in advance: a flip rate that differs between the arms, or dependence among concurrent completions. The flip rates agree, 8.9% (Wilson [6.2, 12.8]) sequential against 8.8% ([6.0, 12.8]) concurrent, two-proportion p = 0.96, a test whose minimum detectable difference at 80% power is 6.8 points absolute. The two arms disagree with each other on 9.5% of rows ([6.5, 13.7]; 9.2% on cached-FALSE rows, 12.0% on cached-TRUE rows), which is the September snapshot's own same-prompt self-disagreement. In completion order the lag-one autocorrelation of the flip indicator is -0.006 in the concurrent arm (permutation p = 0.80) and 0.070 in the sequential arm (p = 0.22). The block-dispersion test is the one result we report as unresolved rather than clean: over consecutive blocks of 32 completions, the variance of flip counts is 2.08 times its binomial value in the concurrent arm (8 blocks; 95% CI [0.91, 8.62]; chi-square p = 0.04) against 1.39 in the sequential arm (9 blocks; p = 0.20); with eight blocks the test cannot see modest overdispersion, and we say so. Since the pinned schedule tests a stratum's flip rate and the rates agree, the certificates of the deployment run, which was issued at this concurrency, rest on draws whose rate the sequential arm reproduces.

**Author action:** A new paragraph, Section V, "Independence across rows", reports the test with the numbers above, its resolution (the minimum detectable difference, the dispersion interval), and the fixed falsification criterion; Assumption 1 points to it, and the proof of Theorem 1 states the consequence of independence it uses (non-interference between rows). The script and artifact (exp17) are in the release.

## Reviewer 3, Concern 6: Readability

> The paper is hard to follow. Many sentences are long and contain several numbers or points in parentheses. Terms such as "look," "floor," and "stratum" appear before they are explained. Please shorten the sentences, add a table of notation, and move detailed implementation checks, such as the nine checker conditions, to an appendix.

**Author response:** Agreed on all counts.

**Author action:** Section II opens with a "Terminology" paragraph that defines stratum, look, floor, certificate, oracle draw, estimand, power, pinned, and the Bonferroni split before their first use in the technical sections, followed by a notation table (Table 1); the abstract and the Introduction gloss the terms they cannot avoid inline (strata in the running example, looks and peeking in Contribution 2, pinned, the noise floor, estimands, power, and certificates at their first mention). The nine checker conditions moved from the Availability section to Appendix A, and the Availability section now carries a one-sentence pointer. Algorithm 1 supplements the five-step summary of Section III with complete pseudocode. The Deployment section was restructured into three short subsections with a summary table (Table 8) so that the numbers live in the table and the prose interprets them; the calibration, main-results, and bound paragraphs were rewritten with shorter sentences; and Table 4 collects the flip-rate figures that had been scattered through the text. We revised sentence length throughout the sections we rewrote, while keeping the technical statements exact.

## Reviewer 3, Minor 1: Page header "VOLUME 11, 2023"

**Author response and action:** The vendored IEEE Access template (ACCESS_latex_template_20260513, the current one on the Access author page) sets that footer by default; it is now set to the 2026 volume. The class file is otherwise unmodified.

## Reviewer 3, Minor 2: The headline flip rate reported as 6.3%, 6.0%, 6.30%, and 7.2%

**Author response:** These are four different instruments on the same population quantity, and the first version explained them in one dense sentence that a reader could not be expected to parse.

**Author action:** A new Table 4 lists each figure with its edit, its cells, and its instrument: 6.3% is the Table 2 label instrument (stored v2 oracle cells against the stored v1 cache, one draw each side, on the n=2,000 evaluation vector); 6.0% is an independent second v2 draw against the same frozen cache (the two differ by 7 rows); 6.30% is the majority of three draws on each side; 7.2% is fresh single draws on both sides. The within-version self-flip floor (5.0%) and the per-stratum floors (3.1%, 24.1%) are in the same table.

## Reviewer 3, Minor 3: The cached-TRUE flip rate reported as 45.7%, 45.2%, and 37.1%

**Author response and action:** Table 4 also lists these: 37.1% is the cached-TRUE stratum's flip rate under the formatting edit (single fresh draw against the cache); 45.7% is the cached-TRUE flip rate under the scope-widening edit on the production column (199 cells, with its Wilson interval); and the third figure was the realized error among the cached-TRUE cells the aggregate-only baseline (B2) reused at $\alpha=0.1$, an adversely selected subset rather than a population rate (35.3% in the regenerated numbers; the earlier 45.2% was the same quantity under the earlier bound). The text now names the edit and the calculation wherever such a figure appears.

## Reviewer 3, Minor 4: Define "SO"

**Author action:** "Stack Overflow (SO)" is now defined at its first use, in the Introduction's running example, and the second definition in Section V, "Workloads", was removed.

## Reviewer 3, Minor 5: The "exceed." column of Table 1

**Author action:** The caption of Table 2 (the former Table 1) now explains every column, including "cert." (the share of the 1,000 sampling replications that issued any certificate) and "exceed." (the share of those certifying replications, not of all 1,000, whose realized reuse-set rate exceeded $\alpha$, a metric the default mode does not certify).

## Reviewer 3, Minor 6: Fig. 1 text size

**Author action:** Figure 1 was redrawn with shorter labels so that it fits the text width at its natural size and no longer needs to be scaled down; its text is now set at the body font size.

## Reviewer 3, Minor 7: Exact model identifiers

**Author action:** A new Table 3 lists every model the article uses by its gateway identifier (deepseek/deepseek-v4-flash-0731; openai/text-embedding-3-small; google/gemini-2.5-flash-lite; google/gemini-3-flash; zai/glm-4.7-flash; alibaba/qwen3.7-flash; openai/gpt-5-nano), its role, and its run dates. The setup paragraph states that no decode parameter other than temperature 0 is set and that provider-side snapshots are dated, which the September re-certification shows is not a formality.

## Reviewer 3, Minor 8: References missing page numbers or DOIs; DOIs ending in "2026"

**Author response and action:** Bardenet and Maillard now carries pages 1361–1385 and DOI 10.3150/14-BEJ605; Waudby-Smith and Ramdas carries volume 86, issue 1, pages 1–27, and DOI 10.1093/jrsssb/qkad009; Gupta, Mumick, and Ross carries pages 211–222 and DOI 10.1145/223784.223817; Maurer and Pontil (COLT 2009) has no DOI or page numbers assigned by the venue, which the entry now says, and its arXiv identifier is given; Wang and Ramdas (e-BH) carries pages 822–852 and DOI 10.1111/rssb.12489; the remaining journal and conference entries were checked for locators in the same pass. The "2026" that appeared after two DOIs was a defect of our bibliography generator (it carries DOIs into the note field because the IEEEtran style has no DOI field, and it mis-parsed a note containing a braced venue name, printing "SIGMOD; doi:… 2026"); the generator was fixed and those entries now read "SIGMOD 2026, doi:…".

## Reviewer 3, Minor 9: Which references are peer reviewed

**Author action:** Every arXiv-only reference is now labeled "arXiv preprint" in the bibliography; entries with a published version cite the published version. One entry carries both labels on purpose: SemBench is accepted to VLDB 2026 but not yet published, so it is cited as the arXiv preprint with the acceptance noted.

## Reviewer 3, Minor 10: The code license

**Author action:** The abstract now says the system is released under a source-available noncommercial license; Contribution 3 says the same, and the Availability section already did.

## Reviewer 3, suggested references

**Author response:** Both are relevant and both are now cited: Clopper and Pearson (1934) where the exact bound is introduced (Section III, "The bound") and in the related-work discussion of the bound; Howard et al. (2021) where time-uniform confidence sequences are discussed as the alternative that would remove the Bonferroni split across looks (Sections III, V, and VIII).

---

# Changes not prompted by a specific comment

1. **A reproducibility defect, found and fixed.** While re-deriving the deployment certificates under the new bound we found that the earlier certifier shuffled each stratum in the order the cell query happened to return, which the database served through one index in August and another afterwards, so the same seed drew a different sample. The certifier now sorts each stratum canonically (by content hash, then row identifier) before the seeded shuffle; the published run walked the content-hash order, and the released replay reproduces its every count under the Maurer–Pontil arm and asserts that it does. The manuscript discloses this in Section IV, Section V ("Deployment scale"), and the Availability section.

2. **Snapshots as versions.** Oracle draws taken after a provider-side change are now stored under a prompt version of their own carrying the same template, so draws from two snapshots never share a key and cannot be mixed in one certification path. This is how the September re-certification was run cleanly against the August cache (Section IV).

3. **Calibration restated as a rate.** Under an exact bound that spends its budget, "no unsafe certification in any trial" is no longer the right claim (nor was it the right claim to make of a bound that left almost all of $\delta$ unspent). The calibration study now reports the unconditional rate of certificates whose realized flip count exceeds the budget, the event Theorem 1 bounds: at most 1.00% of runs in any configuration (95% CI [0.65, 1.54]%) against a nominal per-stratum $\delta$ of 5%, averaging 0.35% over the 54 tight nulls (the presented-cells rate, which leaves out the sampled flips, peaks at 0.70%); Table 2 likewise reports the one configuration (scope widening at $\alpha=0.05$, a stratum whose flip rate sits just above the budget) in which 1.2% of replications certify and 75% of those exceed, an unconditional 0.90% against $\delta=0.1.$

4. **Erratum relative to the preprint.** The Zenodo preprint reported the Bardenet–Maillard bound as slightly tighter than Maurer–Pontil; that replay used the Maurer–Pontil linear constant inside the Serfling form, and the published constant $\kappa$ = 7/3 + 3/$\sqrt{2}$ is what the numbers here use (this was already corrected in the first IEEE Access submission and is restated in the revision).

5. **Minor.** Boolean capitalized throughout; the acknowledgment and author biography unchanged; an enlarged model-identifier table; appendices lettered.
