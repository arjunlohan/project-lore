---
title: "Response to Reviewers"
subtitle: "Original Manuscript ID: Access-2026-41149"
author: "Arjun Lohan (University of Southern California), corresponding author"
date: "Resubmission, 2 October 2026"
---

**Original Article Title:** "Reuse, but Verify: Certified Maintenance of Table Cells Computed by Large Language Models under Prompt Edits"

**To:** IEEE Access Editor

**Re:** Response to reviewers

Dear Editor,

Thank you for allowing a resubmission of our manuscript, with an opportunity to address the reviewers' comments. We are uploading (a) our point-by-point response to the comments (this document, under "Author's Response Files"), (b) an updated manuscript with every change marked (as "Highlighted PDF"), and (c) a clean updated manuscript without highlights ("Main Manuscript", LaTeX source and PDF).

The reviewers' central concern, raised independently by Reviewers 1 and 3, was that the headline results were certified with a bound (Maurer–Pontil) that our own theorem did not prove for the without-replacement sampling the procedure performs. Reviewer 3 asked why an exact bound was not used. We agree, and we did not merely restate the numbers under the proven Bardenet–Maillard bound. For a binary loss under without-replacement sampling from a frozen stratum, the exact finite-population (hypergeometric, Clopper–Pearson-type) bound is valid by a short coupling argument. On every configuration we measured it is also tighter than either empirical-Bernstein bound, because a binary loss never needs the range term those bounds pay. The revised manuscript makes that bound the pinned certifier. It restates Theorem 1 for that bound and proves it in full, now as a high-probability bound on the realized flip count rather than on its expectation. Every number was regenerated from the same stored labels and oracle draws, and the earlier bounds are kept as measured ablation arms.

The results are stronger on every axis the reviewers raised. On the main seed, 10 of the 20 benchmark configurations certify instead of 7 (12 certify in at least one sampling replication). Mean certified savings rise from 18.5% to 29.5% on 35% fewer oracle calls. The $\alpha=0.1$ budget on the headline edit certifies 88.4% savings for 90 oracle calls on the main seed, instead of 54.7% for 765 (82.6% mean savings over the 1,000 sampling replications). The deployment certificate a reviewer re-derived clears both $\alpha=0.2$ and $\alpha=0.1$ under the exact bound. One coincidence of values deserves a note. The first abstract's 82.6% was the replication mean at $\alpha=0.2$ under Maurer–Pontil; the same figure is now the replication mean at $\alpha=0.1$. The abstract therefore labels its main-seed figure (88.4%) beside the replication mean at $\alpha=0.2$ (88.1%).

Reviewer 2 asked for an explicit statement of the framework (its assumptions, workflow, correctness criterion, and how a cell is judged safe to reuse) and a sharper distinction from LLM verification, caching, incremental computation, and result reuse. Section II now opens with a terminology paragraph and a notation table, states Assumptions 1 to 3 together, gives the correctness criterion in words, and says why the unit of decision is the stratum, not the cell. Algorithm 1 states the procedure in full. A new positioning table (Table 11) lists, for each neighboring line of work, what it certifies, what it holds fixed, and what changes.

Four further studies were added because the reviewers asked for evidence rather than assertion. The remaining edit pairs were run on further model families, and a sixth family was added, so that five families carry all five pairs. The cross-row independence assumption was tested directly (sequential against concurrent requests). A free-text pilot was run with a judge-based equivalence relation calibrated on hand labels. The deployment column was re-certified live 55 days after the original run. That run measured drift of the served model (the flip rate against the same cache rose on the same rows, McNemar p<0.001) and showed the certifier pricing it: the two budgets certified in August certified again, the tighter one a look deeper than the exact bound's replay of the August draws, and the tightest budget, on which the August draws are silent, was refused. While preparing these we also found and fixed a reproducibility defect in the earlier certifier (its sample path depended on the storage engine's row order). The manuscript discloses it, and the released replay reproduces the August run's every count.

The Highlighted PDF was produced by latexdiff against the source submitted in August. Added or changed text is set in blue, and deleted text is omitted. Every generated number is substituted by its value before the comparison, so a figure that changed under an unchanged macro name is marked like any other change. Three kinds of block are compared whole, not word by word: table bodies, the figures, and Algorithm 1. A block that is new or regenerated is set in blue in full, and its caption is compared word by word like the prose. Every table was regenerated from the recomputed artifacts, Figure 1 was redrawn, and Figures 2 and 3 are replotted from the new results, so every figure and every table body is blue. (Table 10's edit pairs are unchanged; its flip column now prints one decimal, as Table 2 does.) The reference list keeps the numbering of the clean copy, and every entry that is new or changed since the first submission is set in blue in full. The checker conditions that moved from the Availability section to Appendix A appear there without markup, because moved blocks are not tracked. Because the bound changed, almost every numerical value in the manuscript changed. Each is regenerated mechanically from the released artifacts, and the guards described in Appendix A report zero findings on the revised manuscript.

Best regards,

Arjun Lohan

---

# Reviewer 1

## Reviewer 1, Concern 1: Unproven validity condition

> Your headline results are certified using the Maurer–Pontil bound, which Theorem 1 states is proven only for independent draws; validity under the without-replacement sampling your procedure actually performs is explicitly not proven. [...] the paper would be considerably stronger if the primary reported numbers used the proven Bardenet–Maillard bound, with Maurer–Pontil results presented as a secondary, empirically-validated variant rather than the headline procedure.

**Author response:** We agree that the headline numbers must rest on a bound proven for the sampling actually performed, and we went one step further than the suggestion. Reviewer 3 (Concern 2) asked why an exact bound was not used. On reflection the exact bound is the right choice, not merely a comparison point. The flip indicator is binary, and the sample is drawn uniformly without replacement from a frozen stratum. Conditional on the stratum's fresh-draw outcomes, the sampled flip count is therefore exactly hypergeometric. The finite-population Clopper–Pearson construction then gives an upper confidence bound that is valid for every population realization, hence unconditionally. It bounds the realized whole-stratum flip count, the quantity the estimand is defined on, where the earlier theorem bounded its expectation. It is also tighter than either empirical-Bernstein bound, because a binary loss never needs their range term. On a clean sample of 90 draws at the pinned per-look level, the exact bound reads 0.050 where Maurer–Pontil read 0.144 and Bardenet–Maillard reads 0.317. Bardenet–Maillard is proven for this sampling, but adopting it as the headline would have cost power for no gain in validity. It certifies the same 7 configurations as Maurer–Pontil, 3 of them at the same look and 4 at a later one.

**Author action:** The pinned certifier now uses the exact finite-population bound (Section III, "The bound", Eq. 1; Algorithm 1). Theorem 1 is restated for that bound and proven in full by the coupling argument. The theorem's last sentence and a remark after the proof state that the same argument covers any bound valid for uniform without-replacement draws, including Bardenet–Maillard, while Maurer–Pontil is retained only as an ablation arm. Every result in the manuscript (Table 2, the calibration study, the baselines, the SUPG-style competitor, the model-family tables, the deployment section) was regenerated under the exact bound from the same stored labels and oracle draws. The bound ablation (Section V, "The bound ablation" and "The bounds compared"; Table 9; Appendix B) now compares five bounds inside the same procedure: exact, Clopper–Pearson (binomial), betting sequence, Maurer–Pontil, and Bardenet–Maillard, with their null-calibration results. The Availability section names the public preprint of the first version and states that its certification results are reproducible from the same release with the Maurer–Pontil arm selected, so nothing about the earlier version is lost.

## Reviewer 1, Concern 2: Generalization across models

> Only one model carries the full experimental program; the other four families are tested on just two edit pairs, and one probe uses only n=500. [...] I'd encourage running the full edit set (all five pairs) across at least 2–3 additional families to substantiate the generality implied in the abstract and conclusion.

**Author response:** Five further families now carry all five pairs at n=2,000, and no n=500 row remains. We ran the remaining three pairs (the production column's scope widening and the two Djinni select pairs) on Gemini 2.5 Flash-Lite, GLM-4.7-Flash, and Qwen3.7-Flash. We re-ran gpt-5-nano on all five pairs in a single run on 29 September 2026, which supersedes the n=500 probe (no August draws are mixed in). We added a sixth family, Gemini 3.8 Flash, on all five pairs. Every run uses the same seeded rows as the primary evaluation vectors, the runner's own framing, temperature 0, one fresh draw per cell, and the pinned procedure. Gemini 3 Flash stays at the two lab pairs: in its reasoning regime the further calls would have cost roughly $200, and the caption of Table 6 says its remaining pairs were left out for cost. The six further families come from four providers, and three of them are successive Gemini generations; the manuscript says so where the study is introduced.

The results read the same way as the lab pairs did (Tables 6 and 7 give every figure):

- *Scope widening.* At $\alpha=0.2$ it certifies on Gemini 2.5 Flash-Lite (95.3% savings at 8.22% realized presented-cells error), GLM-4.7-Flash (74.1% at 6.29%), Qwen3.7-Flash (79.8% at 14.35%), and Gemini 3.8 Flash (95.5% at 4.35%). At $\alpha=0.1$ it certifies on GLM-4.7-Flash (67.3% at 6.03%) and Gemini 3.8 Flash (94.3% at 4.35%). Gemini 2.5 Flash-Lite and Qwen3.7-Flash are refused at 0.1 by the futility rule, as the primary model's own frontier predicts near the budget.
- *Djinni select pairs.* Gemini 2.5 Flash-Lite certifies both edits at both budgets (formatting 23.3% and 86.5%; criteria 56.7% and 88.7%). So do GLM-4.7-Flash (36.5% and 65.4%; 39.2% and 64.9%), Qwen3.7-Flash (48.4% and 82.9%; 43.6% and 85.7%), and Gemini 3.8 Flash (55.7% and 84.3%; 24.1% and 63.5%). Every realized presented-cells error is inside its budget. The select column's floor varies across families (0.2% to 16.3%, the primary model's 6.5% among them) in the same way the Boolean column's does.
- *gpt-5-nano.* Its pooled lab-column floor of 34.8% is above every budget in the grid. It is refused on scope widening at both budgets (flip rate 36.5%) and on the Djinni pairs at 0.1. At 0.2 it certifies 30.0% (6.74%) on the Djinni formatting edit and 21.0% (9.61%) on the criteria change, at 15.8% and 21.1% flip rates.
- *Gemini 3.8 Flash on the lab column.* Its self-flip floor is 0.95% and its formatting flip 0.85%, certifying both strata at both budgets. Its synonym flip is 4.9%, certifying the cached-FALSE stratum at both budgets.

Independently of the new runs, the earlier lab-pair results were re-derived under the exact bound (replays over the stored per-row draws, no new model calls). The qualitative finding is unchanged and sharper. At least one stratum certifies on each of the six families, which is the sense in which the manuscript says certification reproduces. The re-run gpt-5-nano is refused on every stratum of the formatting edit and certifies the cached-TRUE stratum of the synonym edit at $\alpha=0.2$. Which edit is benign, and on which cached-value stratum, is a property of the (edit, model) pair.

**Author action:** Section V, "Other model families" (with its paragraphs "What transfers" and "Benign edits by family"), and Table 6 were regenerated with gpt-5-nano as a full family. A new Table 7 and the paragraph "Beyond the lab column" report the remaining three pairs on the further families. A scope statement now stands at the head of the evaluation (Section V, "Scope") and appears in the limitations (Section VIII, "Models and snapshots") and the Conclusion: one budget-class model carries the full program, and the family study establishes the qualitative structure, not the frontier. The abstract states the count, and Contribution 4 says the anatomy is of one primary model. Table 3 lists every model identifier with its run dates and list prices.

## Reviewer 1, Concern 3: Equivalence relation scope

> Exact-match equivalence limits applicability to Boolean/select columns. Since your introduction motivates free-text "spreadsheet copilot" columns, even a small pilot with a judge-based equivalence relation (with its own error calibrated into $\alpha$, as you note in Section VIII) would substantially broaden the paper's relevance.

**Author response:** We ran the pilot the reviewer describes, and its result is negative on power. The column is a free-text one over the same Stack Overflow profiles (the respondent's primary technical specialty in at most eight words). It has three prompt versions (a baseline, a formatting-only edit of it, and a synonym rewording), n=2,000 rows, and one fresh draw per cell from the primary model. The equivalence relation is a judge: the primary model, asked in both orders whether two phrases name the same specialty, with agreement required in both orders. The calibration recipe of Section VIII was applied as stated. The author hand-labeled 201 pairs from the judge's output (150 it had called equivalent and 51 it had called different, drawn evenly from the three comparisons and pooled). A second model (meta/muse-spark-1.3-contributor) labeled the same pairs under the same instruction as an independent check.

The two labelers read the judge differently, and the manuscript reports both readings.

- *Under the author's labels* the judge missed nothing: of the 150 pairs it had called equivalent, the author called 0 different. That gives an upper confidence bound of 2.0% on its miss rate among the pairs it calls equivalent at $\delta_{\mathrm{cal}}=0.05$ (pooled across the three comparisons; each comparison's 50 labels alone give 5.8%). The recipe takes that bound off each budget, 2.0 percentage points, so $\alpha=0.2$ becomes 0.180 and $\alpha=0.1$ becomes 0.080.
- *Under the second labeler's labels* the judge missed 20 of those 150 pairs, all of them pairs the author called the same. The miss bound would then be 18.8%, a deflation of 18.8 points, more than the tight budget itself. The clean side of the calibration therefore rests on the author's reading, and the manuscript says so.
- *On the other side* the author called 41 of the judge's 51 "different" pairs the same specialty, while the second labeler called 42 of the 51 different. By the author's labels the judge is stricter than the author's reading; by the second labeler's it is mostly right. One human labeler and one model cannot say which reading is right. A second human labeler is what would separate a strict instruction from a lenient labeler, and the manuscript says that as well.

Under the judge, the column's own floor (two draws of the same prompt) is 40.1%, the formatting edit's flip rate 42.2%, and the synonym edit's 49.9% (over 1,602, 1,821, and 1,799 usable pairs). The certifier therefore refused every stratum of both edits at both budgets at its first looks. Weighting the judge's verdicts by the author's labels puts the disagreement of two same-prompt draws near 7.9% (band [4.4, 14.5]%), inside the loose budget. The second model agreed with the hand labels on 74.1% of pairs, and the judge agreed with them on 79.6%.

The pilot does not broaden the savings claims, and the manuscript does not present it as doing so. It shows three things. The machinery ports unchanged to a judge-based equivalence. The judge's error enters the budget exactly as the recipe says, at a price that depends on whose labels calibrate it. The larger price of a judge is power: the certifier sees only the judge, and it refused. The composed guarantee holds for any judge whose miss rate the calibration bounds correctly; what the pilot does not deliver is a judge whose equivalence matches a reader's, calibrated in both directions.

**Author action:** Section VIII, "Equivalence and columns", states the recipe with its $1-\delta-\delta_{\mathrm{cal}}$ accounting and the homogeneity assumption it rests on. Three new paragraphs report the pilot: "A free-text pilot", "Pilot calibration", and "Pilot outcome and reading". Contribution 4 names it. Table 3 lists the judge and the second labeler. Section V, "Labels and spend", counts the pilot's draws among the off-ledger cells. The script, the artifact, the labeling page, and the labels are in the release (exp19).

## Reviewer 1, Minor 1: "AI table" product category citation

> The "AI table" product category in your introduction would benefit from a supporting citation or concrete named example.

**Author response:** Agreed.

**Author action:** The first paragraph of the Introduction now names and cites four shipping products whose columns are computed per row by a language model: Google Sheets' AI function and AI columns, Airtable AI fields, Notion AI autofill for databases, and Snowflake Cortex's AI_COMPLETE and AI_CLASSIFY over table columns. Each is cited to its official documentation with an access date. The paragraph also notes that Microsoft's Excel COPILOT function shipped as a preview and was withdrawn in September 2026, a measure of how quickly this product surface is moving (refs. [1]–[5]).

## Reviewer 1, Minor 2: Label-noise discussion

> Consider grounding the label-noise discussion (Section V.b) in existing LLM-as-annotator agreement literature.

**Author response:** Agreed. The picture that literature draws (model labels reaching crowd-worker or expert agreement on many tasks, with task-specific noise that has to be validated rather than assumed) is the one our relabeling measurements show.

**Author action:** The label-noise passage in Section V, "Labels and spend", now cites Gilardi et al. (PNAS 2023), Ziems et al. (Computational Linguistics 2024), Pangakis et al. (arXiv 2023), and Törnberg (arXiv 2023). A new Table 4 reconciles every flip-rate figure quoted for the headline pair and its cached-TRUE stratum with its edit, its cells, and its instrument.

## Reviewer 1, further remarks in the assessment

The reviewer's answers to the assessment questions raised points beyond the numbered issues. Each is quoted and answered below.

### Further remark 1: the deployment run was a replay

> The deployment-scale run is a "replay" against previously stored cells rather than a live timed run, so wall-clock/rate-limit claims are estimates, appropriately caveated but still not independently verified.

**Author response:** We re-ran the certification live.

**Author action:** The deployment column was re-certified live on 29 September 2026 under the exact bound (Section V, "Deployment scale", the September run). The live decision at the loose budget took 101 seconds of wall clock including its 90 oracle calls. The tight budget needed 405 calls in all, and the 315 calls beyond the loose arm's 90 took a further 304 seconds. The materialization run's wall clock is now reported as measured, from its first cell write to its last (7.2 hours); the estimate from stored latencies (7.4 hours) is kept beside it and prices the maintenance workload.

### Further remark 2: single-model scope stated up front

> Reliance on a single "primary" model's numbers for most quantitative claims while other families are treated as secondary sensitivity checks is a reasonable design choice but should be stated as a scope limitation, not just in Section VIII.

**Author response:** Agreed.

**Author action:** A paragraph headed "Scope" now stands at the head of the evaluation in Section V, directly after the workloads. Contribution 4 says the anatomy is of one primary model, the abstract states the family counts, and the Conclusion ends its first paragraph with the same scope.

### Further remark 3: cost and latency from one run

> Cost/latency comparisons are based on one materialization run and ledger-derived estimates rather than repeated live measurements.

**Author response:** That is accurate, and the manuscript now says it in as many words.

**Author action:** Section VIII, "Economics", states that the cost figures come from one ledgered materialization and one priced maintenance replay at the gateway's list rates, and that they show the scale of the saving, not a cost model. The September run adds one measured wall clock for the certification decision itself.

### Further remark 4: no user study of the certificate surface

> No user study or qualitative assessment of how certificates/refusals are surfaced in the UI, despite the paper emphasizing this as part of the production contribution.

**Author response:** We describe the surface and state that it was not studied with users. We did not add a user study in this revision.

**Author action:** Section IV has a new paragraph, "What the user sees". It describes the mark and tooltip a reused cell carries, the certificate summary returned to the user (rows in scope, the budget, cells sampled, reused, and to recompute, and the flips observed), and how a refusal appears (its cells are recomputed and served as ordinary fresh cells; the refusal is in the certificate record). Section VIII, "Economics", states that this surface was not studied with users, so whether a person acts differently on a column that shows one is open.

### Further remark 5: the edit taxonomy

> Only five edit pairs (one per class per column) are studied, and the paper itself concedes this is too small to draw general conclusions about edit classes appropriately caveated, but it does leave the "edit taxonomy" discussion thinner than the framing suggests.

**Author response:** Agreed; the framing was narrowed to what five pairs can show.

**Author action:** The edit-class claim now reads, in the Introduction, in Section VII, and in Section VIII ("Equivalence and columns"), that class can fail to predict flip rate, not how often it does (see also Reviewer 3, Concern 3). The text notes that the certifier never consults the class.

### Further remark 6: free-text and numeric columns

> Only two data types are tested (Boolean and 4-way ordinal), and equivalence is exact-match only; free-text or numeric AI columns, which are common in practice, are not evaluated even though the introduction motivates "spreadsheet copilots" broadly.

**Author response:** The free-text pilot (Concern 3 above) is the first such measurement. Numeric columns remain unevaluated.

**Author action:** Section VIII, "Equivalence and columns", states which column types are evaluated and that numeric and free-text columns are not part of the main evaluation; the pilot paragraphs follow it.

### Further remark 7: recent preprints among the references

> Several references are to very recent arXiv preprints or 2026 SIGMOD/VLDB papers not yet formally published at review time (e.g., [16], [18], [24]–[26], [31]–[36]); this is understandable given the field's pace, but a reviewer should verify these aren't self-referential or circularly citing unpublished/unverifiable claims.

**Author response:** Every reference was re-verified against its publisher record or arXiv listing in this revision. None is a self-citation.

**Author action:** arXiv-only entries are labeled as preprints, and published versions are cited where they exist (Reviewer 3, Minor 9). Three entries that were preprints at the first submission are now cited in their published form (SPADE and SemBench in Proc. VLDB Endow., and Atıl et al. in the Eval4NLP 2025 proceedings).

---

# Reviewer 2

## Reviewer 2, Concern 1: Clearer explanation of the certification framework

> The authors should provide a clearer explanation of the proposed certification and verification framework, including its assumptions, workflow, correctness criteria, and how it determines whether a previously computed cell can be safely reused after a prompt change.

**Author response:** We agree that the first version asked the reader to assemble the framework from several places. In one paragraph, the framework is this. An AI column is a view (a prompt, a model, and pinned decode parameters), and each cached cell is one draw from that model. After a prompt edit the question is not whether a cached cell is correct. It is whether recomputing the cell under the new prompt would return a different value (a flip). Learning that for one cell costs exactly the call that reuse would save, so sIVM never decides per cell. It (1) diffs the two prompts, for provenance only; (2) partitions the cached cells into strata fixed before any model call, by cached value; (3) recomputes a seeded sample from each stratum on a doubling schedule of looks; (4) at each look computes an exact finite-population upper confidence bound on the stratum's flip rate, certifies the stratum when that bound clears the user's error budget $\alpha$, and refuses it when the sample's own flip rate already exceeds $\alpha$; (5) reuses every unsampled cell of a certified stratum and recomputes every cell of a refused one.

The correctness criterion is Theorem 1. With probability at least $1-\delta$ over the run's sampling and oracle draws, at most an $\alpha$ share of a certified stratum's cells would flip if recomputed now. Three assumptions, stated together in Section II, carry it: the model snapshot is pinned and draws do not interfere across rows (Assumption 1), the stratification is fixed before sampling (Assumption 2), and the sample is a uniform without-replacement draw within each stratum (Assumption 3). The guarantee is per stratum and about the realized run. It says nothing about agreement with ground truth. And for an unedited prompt it cannot be tighter than the model's own rate of disagreement with itself, the impossibility floor of Section II. The revision states each of these elements explicitly, at the places listed below.

**Author action:**

1. *Assumptions.* Section II now opens with a "Terminology" paragraph that defines stratum, look, floor, certificate, and the other recurring terms before the technical sections use them, followed by a notation table (Table 1). The Introduction and the abstract gloss the few terms they need inline. Assumptions 1–3 are stated together, and each says which experiment probes it: decode pinning and snapshot scope in Section V, "Deployment scale" (the September run); independence across rows in Section V, "Independence across rows"; the sampling assumption in the seeded canonical order of Section IV, with the calibration study checking the level of the implemented test. The proof says which consequence of independence it uses (non-interference between rows).
2. *Workflow.* Section III gives the five steps, and a new Algorithm 1 states the complete procedure in pseudocode, including the futility rule, the two guarantee targets, and the apply step.
3. *Correctness criterion.* The two estimands (presented-cells and reuse-set false-reuse rates) are defined in Section II. Theorem 1 states exactly what a certificate guarantees for each, in the realized terms of the run, with the proof rewritten for the exact bound. Section II, "Reading the budget", restates the guarantee in words.
4. *How reuse is decided.* Section II, "Estimand and guarantee", now states that sIVM makes no decision about an individual cell and why it cannot: learning whether one cell would change costs the call reuse would save, and the cheapest per-cell signal, prompt similarity, predicts flips at chance (baseline B1). The signals that do carry information enter as strata. The correctness criterion for reuse is stated as a sentence: an unsampled cached cell is reused if and only if the upper confidence bound on its stratum's flip rate clears the budget at a look the schedule reaches. Section III, "The bound", defines that bound in one equation (Eq. 1) and explains in words why it is valid. Steps 2 and 4 of the procedure and Algorithm 1 cite the assumption each rests on. The running example in the Introduction and Figure 1 follow one column through the decision.

## Reviewer 2, Concern 2: Distinction from existing methods and comparisons with baselines

> However, the contribution would be stronger if the authors more clearly distinguished the proposed approach from existing methods for LLM verification, caching, incremental computation, and result reuse. Additional theoretical justification, broader experimental validation, and comparisons with relevant baseline approaches would help demonstrate the novelty, applicability, and generalizability of the contribution.

**Author response:** The first version compared against four baselines and positioned the work against four lines of related work in prose. The baselines are B1 (verified-cache similarity), B2 (aggregate-only certification), B2' (a SUPG-style competitor matched on budget, labels, target, and multiplicity), and B3 (guarantee-free embedding transfer). We have made the distinction visible at a glance and broadened the validation.

**Author action:** Section VII opens with a new comparison table (Table 11). For each neighboring system or line of work it lists the quantity certified, what is held fixed, what changes, and the form of the guarantee, beside the same row for our method. The lines covered are guaranteed semantic query processing, verified caching, stale-view cleaning and online aggregation, classical view maintenance, step-level reuse, guarantee-free semantic caches, and per-output verification by assertions, regression suites, or majority vote.

The theoretical justification is two results. Theorem 1 (validity under peeking, Section III) is now fully proven for the bound actually used (Reviewer 1, Concern 1). The impossibility floor (Section II, "The impossibility floor is per-stratum") limits what any single-draw certifier can certify under an unedited prompt.

The experimental validation was broadened in five ways: a calibration study restated as the rate of certificates that exceed their budget, with the exact error probability at the least favorable population (Section V, "Calibration"); a five-bound ablation (Table 9, Appendix B); an independence check (Section V, "Independence across rows"); a live re-certification 55 days after the deployment run that measures model drift (Section V, "Deployment scale", the September run); and the remaining edit pairs on five further model families (Section V, "Other model families"; Table 7). The baselines and the matched SUPG-style competitor were regenerated under the exact bound. Both arms of the head-to-head use the same bound, so the comparison isolates per-stratum against aggregate certification and nothing else (Section V, "Baselines"; Table 5).

---

# Reviewer 3

## Reviewer 3, Concern 1: Theorem 1 does not cover the bound used for the headline results

> Theorem 1 proves the result for the Bardenet-Maillard bound, but the headline results use the Maurer-Pontil bound. [...] Under the Bardenet-Maillard bound, the deployment certificate at $\alpha$ = 0.2 (5 flips in 180 draws) reaches 0.230, which is above the budget at the look where it was issued. Please report the headline and deployment results using a bound that has been proved for this setting, or state clearly that Theorem 1 does not cover those results.

**Author response:** The reviewer's re-derivation is correct. On 5 flips in 180 draws from the 81,469-cell cached-FALSE stratum, at the pinned per-look level, the Bardenet–Maillard bound reads 0.230 and does not clear $\alpha=0.2.$ We have adopted a bound that is proven for exactly this setting and is tighter than both empirical-Bernstein bounds: the exact finite-population (hypergeometric) bound, as described under Reviewer 1, Concern 1. On the same evidence it reads 0.073, which clears $\alpha=0.2$ and $\alpha=0.1$ alike. Under it the August draws certify the loose budget at look 45 (1 flip), so the whole certification costs 90 oracle calls instead of 225. They certify the tight budget at look 180 (5 flips), for 225 calls instead of 765. Every headline and deployment result in the manuscript is now reported under this proven bound, and Theorem 1 covers them.

**Author action:** Section III ("The bound", Theorem 1 and its proof) and Section V ("Deployment scale", Table 8) were rewritten. The deployment section reports three regimes over one sample path: the live August run under Maurer–Pontil (the certificate the system applied, kept for the record), the same stored draws under the exact bound, and a live re-certification on 29 September 2026 under the exact bound. The 0.230 figure the reviewer derived, and what the exact bound reads on the same evidence, appear in the text. The caption of Table 8 states that its Maurer–Pontil rows are outside Theorem 1's coverage and are kept for the record. Table 9 includes the deployment evidence as one of its columns.

## Reviewer 3, Concern 2: Exact bounds for a binary outcome

> A flip is a yes-or-no outcome. Exact bounds, such as Clopper-Pearson or a hypergeometric bound for sampling without replacement, are valid for this setting and may be tighter when there are few flips. Please explain why Maurer-Pontil was chosen or compare it with an exact bound.

**Author response:** The reviewer is right. The honest explanation is that the earlier version inherited empirical-Bernstein bounds from the guaranteed semantic-query-processing literature it builds on (SUPG, BARGAIN, Task Cascades), where the loss is often not binary. It did not ask whether the binary, without-replacement case admitted an exact bound. It does. On this workload the exact hypergeometric bound is tighter than the empirical-Bernstein bounds on every configuration, and tighter than the binomial Clopper–Pearson bound by the finite-population correction. We therefore did not stop at a comparison: the exact bound is now the pinned certifier, and the comparison the reviewer asked for is reported in full.

**Author action:** Section III, "The bound", defines the exact bound (Eq. 1) and explains why it is the natural one. Section V, "The bound ablation" and "The bounds compared", and Table 9 compare five bounds inside the same pinned procedure over the same stored labels. The exact bound certifies 10 of the 20 benchmark configurations, against 9 for Clopper–Pearson, 9 for the betting sequence, 7 for Maurer–Pontil, and 7 for Bardenet–Maillard. Mean savings are 29.5% against 28.1%, 29.1%, 18.5%, and 16.4%, on 7,458 oracle calls against 8,054, 7,616, 11,515, and 12,325. Appendix B (Table 12) lists every configuration. Each arm was also replayed through the calibration protocol (36,000 trials per arm, 18,000 of them at planted rates above the budget). At planted nulls the exact bound certifies at most 6.3% of trials against a per-stratum $\delta$ of 5%. Most of those certificates are correct, because the planted stratum's realized flip count often falls below the budget. The rate of certificates whose realized flip count exceeds the budget (the event Theorem 1 bounds) is at most 1.00% of trials for the exact bound in any null configuration. The two suggested references (Clopper and Pearson 1934; Howard et al. 2021) are cited where the exact bound and time-uniform alternatives are discussed; we found both directly relevant.

## Reviewer 3, Concern 3: Narrow the edit-class claim

> The evaluation covers only three columns and five author-written edits, with one example of each edit class per column. [...] A single example per class is too little to support the claim that edit class does not predict the flip rate. Please narrow that claim and discuss how the limited set of columns and outputs affects the findings.

**Author response:** Agreed. The claim the evidence supports is that surface class *can* fail to predict flip rate, not that it generally does. The first version said so in the Introduction; the limitations section did not.

**Author action:** Section VIII now has a paragraph "Equivalence and columns". It states that the columns studied are two Boolean columns and one four-way ordinal select, that numeric and free-text columns are not part of the main evaluation, and that five author-written edit pairs, one per class per column, show that class can fail to predict flip rate, not how often it does. It adds that the observation about a column's own stability rests on two columns. The edit-class sentences in the Introduction and in Section VII were checked against that strength, and the Introduction's sentence on column stability is now limited to the two column types studied.

## Reviewer 3, Concern 4: Applications for a 20% budget, and what tighter budgets achieve

> Most of the useful savings appear at $\alpha$ = 0.2, which allows an expected 20% of the cells shown in a certified group to be stale and wrong. At $\alpha$ = 0.05, almost nothing is certified for reuse. Please give examples of applications where a 20% error budget would be acceptable, and explain more plainly what the method can achieve with a tighter budget.

**Author response:** Two things changed here. First, the exact bound moved the frontier substantially. On the headline edit, $\alpha=0.1$ now certifies 88.4% savings for 90 oracle calls on the main seed (82.6% mean over the sampling replications; previously 54.7% for 765). The budget $\alpha=0.05$, previously refused, certifies in 74.4% of sampling replications, for 38.6% mean savings. At deployment scale the tight budget costs 225 oracle calls on the August draws and 405 on the September ones, against 89,184 cells. Second, we now say plainly where a 20% budget is defensible and where it is not.

**Author action:** Section VIII opens with a new paragraph, "Which budgets are usable, and for what". A 20% budget is defensible where a person reads the column row by row before acting on it (a recruiter screen, a lead list, an enrichment sheet a reviewer walks through), where the cost of a stale cell is a wasted glance, and where the alternative on offer is today's status quo of reusing everything at the population flip rate with no bound. It is not defensible for a column that feeds an aggregate or a downstream filter; there a tighter budget and the strict reuse-set mode are the right setting.

The paragraph then states what those settings cost, in both modes. On the stable Boolean column the default mode certifies 82.6% mean savings at $\alpha=0.1$ and certifies in 74.4% of replications at $\alpha=0.05$. The strict mode certifies 80.6% mean savings at $\alpha=0.1$ and certifies in only 4.5% of replications at $\alpha=0.05$. On the less stable select column the default mode still certifies at $\alpha=0.1$ in most replications, the strict mode in at most 2.7%, and $\alpha=0.05$ is refused in both modes because the column's flip rates sit above it. Sample cost at a tight budget is still a constant in the table size. What a tight budget cannot buy is certification of a stratum whose flip rate exceeds it, which is the correct outcome; the September run (Section V, "Deployment scale") shows that refusal at $\alpha=0.05$ after model drift. The realized presented-cells error under a certificate is typically far below the budget (3.20% at $\alpha=0.2$ on the headline pair), as Section II, "Reading the budget", states.

## Reviewer 3, Concern 5: Independence across rows is untested

> Assumption 1 requires independent results across rows. However, the paper cites studies [3] and [4] showing that provider-side batching can make responses correlated. The author does not test this assumption. A check comparing flip rates from sequential and concurrent requests would help.

**Author response:** Agreed. We ran the check the reviewer describes, and we report it with its limits. The flip rates agree. The evidence on dependence among draws issued together is mixed, and the manuscript says so.

*The check.* On 29 September 2026, on 300 rows of the evaluation vector, the formatting edit's new version was drawn twice for every row against the same cache: once with a single request in flight (78 minutes of wall clock) and once at the deployment run's concurrency of 32 (4.6 minutes). Requests that errored or exceeded a 90-second ceiling are excluded from their arm (9 sequential, 28 concurrent, where the ceiling binds more often).

*The requested comparison.* The flip rates are 8.9% (Wilson [6.2, 12.8]) sequential against 8.8% ([6.0, 12.8]) concurrent, two-proportion p = 0.96. The test's minimum detectable difference at 80% power is 7.0 percentage points. On the 263 rows both arms kept the rates are 9.5% and 8.4%; 14 rows flipped only sequentially and 11 only concurrently (exact McNemar p = 0.69). The excluded rows show no sign of being flip-prone, on small counts: of the 28 rows the concurrent arm dropped, 1 flipped in the sequential arm, and of the 9 the sequential arm dropped, 2 flipped in the concurrent arm.

*The other planned tests.* The script fixed two further analyses before the run. One set the arms' disagreement on the same row (9.5%, [6.5, 13.7]) against the August stratum floors. After the drift measured in the same section that comparison cannot separate concurrency from the change of snapshot, and we draw nothing from it. The other looked for serial dependence in completion order. The lag-one autocorrelation of the flip indicator is -0.006 in the concurrent arm (permutation p = 0.95) and 0.070 in the sequential arm (p = 0.27). Over consecutive blocks of 32 completions, the variance of flip counts is 2.08 times its binomial value in the concurrent arm (8 blocks; 95% CI [0.91, 8.62]; one-sided chi-square p = 0.04) against 1.39 in the sequential arm (9 blocks; p = 0.20).

*A larger concurrent arm.* Because eight blocks cannot see modest overdispersion, we drew a concurrent arm alone on a further 1,000 rows on 30 September 2026 (31 blocks; no request failed or hit the ceiling). Its block dispersion is 1.26 (95% CI [0.81, 2.26]; p = 0.15), its lag-one autocorrelation -0.031 (p = 0.34), and its flip rate 7.1% ([5.7, 8.9]) against the sequential arm's 8.9% (p = 0.30). This arm was drawn a day later, on other rows, and under faster serving (a median response of 3.7 seconds against 14.4 in the first concurrent arm). Pooled over both concurrent arms the dispersion statistic is 52.5 on 37 degrees of freedom (p = 0.048).

*What we conclude.* The rate and lag tests do not reject. The block-scale question is bounded, not settled: the larger arm alone does not reject, the pooled test (which includes the first arm) rejects narrowly, and ratios up to 2.26 lie inside the larger arm's interval. Two looks outside the plan argue for caution, and the manuscript reports them as such. Flips concentrate in slow responses (59 of the 500 slower responses in the larger arm against 12 of the 500 faster ones), so completion order is not neutral. With blocks formed in launch order instead, the ratio is 1.61 in the larger arm (p = 0.019) and 1.82 in the first (p = 0.08). The manuscript therefore claims less than independence. The flip rate, the quantity the bound estimates, does not move with concurrency in these draws. Dependence among draws issued together is not excluded, and it would raise a certificate's error probability.

*What such dependence would cost.* We simulated the certifier on the 81,469-cell deployment stratum, at its two certified budgets and at a flip rate one flip past the budget, with beta-binomial dependence inside blocks of 32 draws. With independent draws its per-stratum error probability is at most 2.3%. It rises to 4.1% at the planned test's dispersion estimate in the larger arm (1.26), 7.1% at the launch-order estimate (1.61), and 12.2% at the upper end of the planned test's interval (2.26), against a nominal 5%. That exposure is confined to strata whose flip rate sits just above the budget. At the loose budget the deployment stratum is not one: its audited error is 3.15% in August and 7.46% in September. At the tight budget the September audit, 7.96% against 0.1, leaves less room. Two further things limit the exposure. The replication results resample frozen labels, a fixed population for which the hypergeometric law holds however the labels were drawn, so only a live certification relies on the assumption. And a certification sample is small (a few hundred calls in the deployment runs), so a deployment that cannot accept the assumption can issue the sample's calls one at a time, at a cost in wall clock and none in calls.

**Author action:** Three new paragraphs of Section V report the check: "Independence across rows", "The planned tests", and "Reading the tests". They give the numbers above, the tests' resolution (the minimum detectable difference, the dispersion intervals), the exclusion check in both directions, the paired test, the 1,000-row concurrent arm, the pooled test, the two unplanned looks, and the simulated cost of dependence. Assumption 1 points to the check, the proof of Theorem 1 states the consequence of independence it uses (non-interference between rows), and Section VIII, "Statistical scope", lists the assumption as bounded but not established. The scripts and artifacts (exp17, and exp9c for the simulation) are in the release; exp17 has an analysis-only mode that recomputes every statistic from the stored draws.

## Reviewer 3, Concern 6: Readability

> The paper is hard to follow. Many sentences are long and contain several numbers or points in parentheses. Terms such as "look," "floor," and "stratum" appear before they are explained. Please shorten the sentences, add a table of notation, and move detailed implementation checks, such as the nine checker conditions, to an appendix.

**Author response:** Agreed on all counts.

**Author action:** Section II opens with a "Terminology" paragraph that defines stratum, look, floor, certificate, oracle draw, estimand, power, pinned, and the Bonferroni split before their first use in the technical sections, followed by a notation table (Table 1). The paragraph also defines a flip, a refusal, and a futility stop. The Introduction glosses the terms it cannot avoid inline (strata in the running example, looks and peeking in Contribution 2, pinned, the noise floor, estimands, power, and certificates at their first mention). The abstract now says how the strata are formed where it first uses the word. The checker conditions moved from the Availability section to Appendix A, where they are set as a numbered list, and the Availability section carries a one-sentence pointer. Algorithm 1 supplements the five-step summary of Section III with complete pseudocode.

Sentence length was revised across the whole manuscript, not only in the passages we rewrote. Measured over the prose (tables, captions, numbered lists, the algorithm, displayed mathematics, and the theorem environments excluded), the mean sentence length fell from 36.4 words in the first submission to 21.4. In the first submission 28% of sentences ran past 45 words and 25 ran past 60; none now runs past 45. A check added to the manuscript's mechanical guards (Appendix A, condition 10) fails the build on any prose sentence longer than 60 words, so the property holds for whatever is edited next. Parenthetical numbers were given sentences of their own or left to the tables that hold them (Tables 2 and 8). The long paragraphs of Sections V and VIII and of the Availability section were divided, most under run-in headings. Table 4 collects the flip-rate figures that had been scattered through the text.

## Reviewer 3, Minor 1: Page header "VOLUME 11, 2023"

> The page header says "VOLUME 11, 2023." Please use the correct template.

**Author response:** The manuscript was built from the current template; the footer is a default of that template's class file.

**Author action:** The vendored IEEE Access template (ACCESS_latex_template_20260513, the current one on the Access author page) sets that footer by default. It is now set to the 2026 volume. The class file is otherwise unmodified.

## Reviewer 3, Minor 2: The headline flip rate reported as 6.3%, 6.0%, 6.30%, and 7.2%

> The flip rate for the headline edit is reported as 6.3%, 6.0%, 6.30%, and 7.2% in different places. A short table explaining what each figure measures would help.

**Author response:** These are four readings of one population quantity, and the first version explained them in one dense sentence that a reader could not be expected to parse. Tracing them for the table also showed that the first version's description of the 6.0% figure was imprecise, which the revision corrects.

**Author action:** A new Table 4 lists each figure with its edit, its cells, and its instrument, and gives the flip count behind each of the first three.

- 6.3% (127 of 2,000 rows, 6.35% to two decimals) is the Table 2 label instrument: stored v2 oracle cells against the stored v1 cache, one draw each side, on the evaluation vector.
- 6.0% (120 rows) is the same comparison on the v2 cells as first drawn. The relabeling experiment recorded it before 1,811 of the vector's v2 cells were re-drawn on 5 August 2026, so the two figures are two single-draw labelings of the same rows. (Those cells are the ones the August certificate reused: the earlier apply step had written certificate copies over them, the fault Section IV describes, and they were drawn again.)
- 6.30% (126 rows) is the majority of three draws on each side.
- 7.2% is fresh single draws on both sides.

The same table lists the column-level self-flip rate (5.0%, between pairs of fresh draws) and the per-stratum floors (2.6% and 23.0%, the stored cached value against three fresh draws of the same prompt).

## Reviewer 3, Minor 3: The cached-TRUE flip rate reported as 45.7%, 45.2%, and 37.1%

> The cached-TRUE flip rate is reported as 45.7%, 45.2%, and 37.1% in different sections. Please identify the edit and calculation behind each figure.

**Author response:** These were three different quantities, and the text did not say which was which.

**Author action:** Table 4 lists them. 37.1% is the cached-TRUE stratum's flip rate under the formatting edit (single fresh draw against the cache). 45.7% is the cached-TRUE flip rate under the scope-widening edit on the production column (199 cells, with its Wilson interval). The third figure was the realized error among the cached-TRUE cells the aggregate-only baseline (B2) reused at $\alpha=0.1$, an adversely selected subset rather than a population rate. It reads 35.3% in the regenerated numbers; the earlier 45.2% was the same quantity under the earlier bound. The table also lists that baseline's subgroup error at $\alpha=0.2$ on the formatting edit (37.2%) and on the widening edit (44.6%). The text now names the edit and the calculation wherever such a figure appears.

## Reviewer 3, Minor 4: Define "SO"

> Please define "SO" as Stack Overflow when it first appears.

**Author response:** Agreed.

**Author action:** "Stack Overflow (SO)" is now defined at its first use, in the Introduction's running example, and the second definition in Section V, "Workloads", was removed.

## Reviewer 3, Minor 5: The "exceed." column of Table 1

> Please explain the "exceed." column more clearly in the caption of Table 1.

**Author response:** Agreed. The caption now defines every column, and the two rate columns whose denominators differ ("cert." and "exceed.") are spelled out.

**Author action:** The caption of Table 2 (the former Table 1) now explains every column. "cert." is the share of the 1,000 sampling replications that issued any certificate. "exceed." is the share of those certifying replications, not of all 1,000, whose realized reuse-set rate exceeded $\alpha$, a metric the default mode does not certify.

## Reviewer 3, Minor 6: Fig. 1 text size

> The text in Fig. 1 is difficult to read at print size.

**Author response:** Agreed. The figure was scaled down to fit and lost legibility.

**Author action:** Figure 1 was redrawn with shorter labels so that it fits the text width at its natural size and no longer needs to be scaled down. Its text is now set at the body font size.

## Reviewer 3, Minor 7: Exact model identifiers

> Please give the exact snapshot or version identifiers for all models used, including the gpt-5-nano probe.

**Author response:** Agreed. The September re-certification, in which what one gateway identifier serves had changed, shows why the run dates matter as much as the identifiers, so both are listed.

**Author action:** A new Table 3 lists every model the article uses by its gateway identifier (deepseek/deepseek-v4-flash-0731; openai/text-embedding-3-small; google/gemini-2.5-flash-lite; google/gemini-3-flash; google/gemini-3.8-flash; zai/glm-4.7-flash; alibaba/qwen3.7-flash; openai/gpt-5-nano; meta/muse-spark-1.3-contributor), its role, and its run dates. The setup paragraphs ("Scope" and "Models and decoding") state that no decode parameter other than temperature 0 is set. They state that the gateway exposes no snapshot identifier finer than these names (only the primary model's carries a date suffix), so the run dates are the snapshot record. The September re-certification shows that this is not a formality.

## Reviewer 3, Minor 8: References missing page numbers or DOIs; DOIs ending in "2026"

> References [6], [7], [9], and [29] are missing page numbers or DOIs. The DOIs in [16] and [18] appear to have "2026" added at the end. Please check them.

**Author response:** We checked every entry against its publisher record. The missing locators were ours to supply, and the trailing "2026" was a defect of our bibliography generator.

**Author action:** Bardenet and Maillard now carries pages 1361–1385 and DOI 10.3150/14-BEJ605. Waudby-Smith and Ramdas carries volume 86, issue 1, pages 1–27, and DOI 10.1093/jrsssb/qkad009. Gupta, Mumick, and Ross carries pages 211–222 and DOI 10.1145/223784.223817. Maurer and Pontil (COLT 2009) appeared in the venue's online proceedings, which assign no DOI or page numbers; the entry gives that locator and the arXiv identifier. Wang and Ramdas (e-BH) carries pages 822–852 and DOI 10.1111/rssb.12489. In the same pass GPTCache gained its full title, pages 212–218, and DOI 10.18653/v1/2023.nlposs-1.24, and RETAIN its DOI 10.18653/v1/2024.emnlp-demo.31.

The "2026" that appeared after two DOIs came from our generator. It carries DOIs into the note field because the IEEEtran style has no DOI field, and it mis-parsed a note containing a braced venue name, printing "SIGMOD; doi:… 2026". The generator was fixed. Those two entries (BARGAIN and Task Cascades) now carry their Proc. ACM Manag. Data volume, issue, and pages (vol. 3, no. 6, pp. 1–26, 2025, and vol. 4, no. 1, pp. 1–26, 2026, as Crossref records them; BARGAIN's year was corrected from 2026 to 2025), with the SIGMOD 2026 note and the DOI separated from the year.

## Reviewer 3, Minor 9: Which references are peer reviewed

> Many cited 2026 papers are arXiv preprints. Please make clear which references have been peer reviewed.

**Author response:** Agreed.

**Author action:** Every arXiv-only reference is now labeled "arXiv preprint" in the bibliography, and entries with a published version cite the published version. Three entries moved from preprint to published form: SPADE (Proc. VLDB Endow., vol. 17, no. 12), SemBench (Proc. VLDB Endow., vol. 19, no. 8, pp. 1754–1767, 2026), and Atıl et al. (Proc. 5th Workshop on Evaluation and Comparison of NLP Systems, 2025, pp. 135–148).

## Reviewer 3, Minor 10: The code license

> The code has a noncommercial, source-available license. Please state that clearly in the abstract or contributions section when describing the code release.

**Author response:** Agreed.

**Author action:** The abstract now says the system is released under a source-available noncommercial license. Contribution 3 says the same, and the Availability section already did.

## Reviewer 3, suggested references

> The paper should also discuss exact binomial confidence bounds and time-uniform confidence sequences, since these are relevant alternatives to the chosen bound: C. J. Clopper and E. S. Pearson, "The use of confidence or fiducial limits illustrated in the case of the binomial," Biometrika, vol. 26, no. 4, pp. 404–413, 1934, doi: 10.1093/biomet/26.4.404. S. R. Howard, A. Ramdas, J. McAuliffe, and J. Sekhon, "Time-uniform, nonparametric, nonasymptotic confidence sequences," Ann. Statist., vol. 49, no. 2, pp. 1055–1080, 2021, doi: 10.1214/20-AOS1991.

**Author response:** Both are relevant to the argument, and we cite both for that reason.

**Author action:** Clopper and Pearson (1934) is cited where the exact bound is introduced (Section III, "The bound") and in the related-work discussion of the bound. Howard et al. (2021) is cited where time-uniform confidence sequences are discussed as the alternative that would remove the Bonferroni split across looks (Sections III, V, VII, and VIII).

---

# Changes not prompted by a specific comment

1. **A reproducibility defect, found and fixed.** While re-deriving the deployment certificates under the new bound we found that the earlier certifier shuffled each stratum in the order the cell query happened to return. The database served that query through one index in August and another afterwards, so the same seed drew a different sample. The certifier now sorts each stratum canonically (by content hash, then row identifier) before the seeded shuffle. The August run walked the content-hash order, and the released replay reproduces its every count under the Maurer–Pontil arm and asserts that it does. The manuscript discloses this in Section IV, Section V ("Deployment scale"), and the Availability section.

2. **Snapshots as versions.** Oracle draws taken after a change of the served model are now stored under a prompt version of their own carrying the same template, so draws from two snapshots never share a key and cannot be mixed in one certification path. This is how the September re-certification was run cleanly against the August cache (Section IV).

3. **Calibration restated as a rate, with the worst case computed exactly.** Under an exact bound that spends its $\delta$, "no unsafe certification in any trial" is no longer the right claim (nor was it the right claim to make of a bound that left almost all of $\delta$ unspent). The calibration study now reports the unconditional rate of certificates whose realized flip count exceeds the budget, the event Theorem 1 bounds. It is at most 1.00% of runs in any configuration (95% CI [0.65, 1.54]%) against a nominal per-stratum $\delta$ of 5%, and it averages 0.35% over the 54 tight nulls. The presented-cells rate, which leaves out the sampled flips, peaks at 0.70%. Planting a flip rate is not the least favorable case, so the study now adds it: for a fixed population one flip past the budget, the probability of an unsafe certificate is an exact finite sum over the schedule. Across the nine (budget, size) combinations of the grid it lies between 1.3% and 2.6% in the default mode and reaches 1.0% in the strict mode, inside the 5% in each (Section V, "Calibration"). The abstract quotes that exact worst case (2.6%), not the smaller frequency observed in the planted runs. The text accompanying Table 2 (Section V, "Certificates that exceed the budget") reports the one default-mode configuration in which unsafe certificates occur, scope widening at $\alpha=0.05$, a stratum whose flip rate sits just above the budget. There 1.2% of replications certify, every one of them unsafe in the sense of Theorem 1, against that column's per-stratum $\delta_j$ of 5%; in 75% of them the presented-cells rate also exceeds the budget (0.90% of replications). The strict mode has one such configuration too (the same edit and budget, 0.4% of replications), and Section V, "The strict mode", now says so.

4. **Erratum relative to the preprint.** The Zenodo preprint reported the Bardenet–Maillard bound as slightly tighter than Maurer–Pontil. That replay used the Maurer–Pontil linear constant inside the Serfling form, and the published constant $\kappa = 7/3 + 3/\sqrt{2}$ is what the numbers here use. (This was already corrected in the first IEEE Access submission and is restated in the revision.) The Availability section now names the preprint and gives its DOI, and the manuscript refers to it as "the preprint" throughout.

5. **The labeled-cell count.** The abstract, Contribution 4, and Section VI now say 28,000 labeled cells where the first version said 32,000+. The earlier figure added each edit pair's two versions separately and so counted the shared middle version of each lab column twice (the cells that are the "after" side of one pair and the "before" side of the next). The count is now of distinct (column, version) cells: 16,000 edit-pair labels plus 12,000 replicate-draw labels. No label was removed.

6. **Corrections from our own re-reading.** Several passages still carried statements written for the earlier bound's numbers, or measured a quantity slightly differently from how the text defined it. Each was rewritten from the artifacts, and the generator now fails if a stated relation stops holding.

    - *The strict mode and the stratifier ablation* (Section V) carried relation words from the earlier numbers ("collapses", "never certifies reliably", "the single win"). Each figure is now set beside its default-mode comparator.
    - *The embedding-proxy arm of the matched competitor* (Section V, baseline B2'). Under Maurer–Pontil this arm certified nothing, and the first version said so. Under the exact bound it certifies in 3 of the 4 (edit, budget) configurations, with the same pattern as the cached-value arm: at $\alpha=0.2$ on the formatting edit it reuses 1,899 cells at 6.53% error, 180 of them cached-TRUE cells that flip at 37.2%. The caveat now says that the proxy changes how much the competitor reuses, not where its errors land.
    - *The per-stratum floors* (Section II; Table 4). The floor is defined as the identity-edit flip rate, the cached draw against a fresh one. The first version estimated it from pairs of fresh draws bucketed by the cached value, which reads slightly higher (3.1% and 24.1%). The floors are now measured as defined: 2.6% for the cached-FALSE stratum and 23.0% for the cached-TRUE stratum. No conclusion changes.
    - *The floor and edits* (Sections II and V). The floor is a bound for the identity edit only, and the text now shows it with two strata of the family study that flip less under the formatting edit than under no edit at all (GLM-4.7-Flash's cached-FALSE stratum, 17.0% against 24.4%; GPT-5 nano's cached-TRUE stratum, 24.3% against 44.9%). The abstract and Contribution 1 state the floor for the unedited prompt.
    - *The audit verifier* (Sections IV and V). The separate script that recomputes the deployment audits now covers every audit the manuscript prints, from row identifiers the runs persist, and the generator asserts that it reproduces them. The audited sets are larger than in the first version because each audit is now taken against every August oracle cell, including those the live run's own tight-budget arm drew after the loose arm's audit had been recorded; no cell was drawn after August. The applied August certificate's audit covers 2,686 rows (3.16%) where the first version reported 2,159 (3.01%).
    - *Table 5.* The guarantee-free baseline's error on the widening edit is now its measured error among the cells it reuses (9.8%), not the population flip rate.
    - *The released labels* (Availability). The per-cell labels behind Table 2 (16,000 cells over eight column versions) are now a tracked artifact, and Table 2's results rebuild from it with neither the database nor a model endpoint. The Availability section now says that the release contains ingestion scripts for the two corpora, which are downloaded from their maintainers, not the corpora themselves.
    - *Smaller items.* The pinned-configuration sentence of Section III states the number of strata per column (2 on the Boolean columns, 4 on the select column, 8 in the pilot). The materialization time is now the measured wall clock of the run, and the maintenance time is described as what it is, an estimate from stored latencies at the run's concurrency. The model is written $\mathcal{M}$ so that $M$ is free for the flip count. Table 2 prints its certification shares to one decimal. A sentence-length check joined the mechanical guards (Reviewer 3, Concern 6).

7. **The corpora are cited.** The two corpora now have references (the 2023 Stack Overflow Developer Survey and the Djinni Recruitment Dataset, refs. [50] and [51]), cited in the Availability section with their licenses.

8. **Minor.** Boolean capitalized throughout; the acknowledgment and author biography unchanged; a new model-identifier table (Table 3); appendices lettered.
