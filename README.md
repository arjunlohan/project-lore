# project lore

An AI-native table you can talk to, and the statistics that let it edit
prompts without recomputing the world.

lore is two tightly-coupled things:

1. **A framework + reference app** for Juicebox/Clay-style tabular search:
   natural-language queries compile to a versioned, deterministic filter
   spec executed identically on MySQL and Elasticsearch; AI columns run as
   cached, cost-gated per-cell jobs with typed outputs and full provenance.
2. **A research system, sIVM** (semantic incremental view maintenance):
   when a column's prompt is edited, statistically certify which cached
   cells can be reused instead of recomputed, with the false-reuse rate of
   every certified group bounded by a user budget. Paper: ["Reuse, but Verify: Certified
   Maintenance of LLM-Computed Table Cells under Prompt
   Edits"](https://doi.org/10.5281/zenodo.21833641) (preprint), source in
   [`paper/`](paper/), measured results in
   [`docs/research/`](docs/research/).

## The product loop

- **Search**: type "senior Rust developers in Germany or France making over
  $100k". One structured-output LLM call compiles it to a `FilterSpec`;
  execution is deterministic, replayable, and backend-agnostic. Filters
  render as editable chips; edits re-execute with zero LLM involvement.
- **Backends**: `@lore/adapter-elasticsearch` and `@lore/adapter-mysql`
  implement one `DataSourceAdapter` SPI with conformance-tested parity
  (identical counts, pages, sort orders incl. NULL placement, facet
  aggregations, and hydrated rows), plus a hybrid mode (ES search + SQL
  hydration). Switch live in the UI.
- **AI columns**: define a column in natural language with a typed output
  (boolean/select/number/text). Each cell is a per-row job: content-hash
  cached on exactly the fields the template binds, budget-guarded,
  cost-ledgered, Clay-style pre-run estimates, rationale tooltips.
- **Prompt edits create versions, not cache wipes**: the sIVM certifier
  samples a few fresh cells per stratum, bounds each stratum's flip rate,
  reuses what clears your error budget (shield-marked in the UI), and
  recomputes the rest.

## Quickstart (local, no Docker)

```bash
pnpm install

# services: MySQL (brew) + Elasticsearch (tarball in .local-infra/)
brew services start mysql
.local-infra/elasticsearch/bin/elasticsearch -d -p .local-infra/es.pid

# corpora: Stack Overflow Survey 2023 (89,184 rows, ODbL) into both stores
pnpm tsx scripts/ingest/so2023.ts
# optional free-text corpus: Djinni CVs (210,250 rows, MIT)
pnpm tsx scripts/ingest/djinni.ts
# AI-column metadata tables
pnpm tsx scripts/migrate-lore-meta.ts

# env: put your Vercel AI Gateway key in .env.local
#   AI_GATEWAY_API_KEY=...

pnpm dev   # open http://localhost:3000/lore
```

Verify the deterministic core anytime:

```bash
pnpm tsx scripts/conformance.ts     # adapter parity battery
pnpm tsx scripts/test-sivm-math.ts  # certification validity (synthetic)
```

## Adopting the framework in your own environment

The packages are deliberately headless and app-independent:

- `@lore/core`: the SPI (`FilterSpec`, `DataSourceAdapter`, `ColumnDef`,
  `CellRecord`, certificates) and the sIVM math
  (`packages/core/src/sivm.ts`: diffing, stratification, adaptive
  certification under the exact finite-population bound, with the
  earlier bounds kept as ablation arms, both estimand modes).
- `@lore/adapter-elasticsearch`, `@lore/adapter-mysql`: reference
  adapters. To support your store, implement `DataSourceAdapter`
  (count/search/aggregate/hydrate over a `FilterSpec`) and run the
  conformance battery against a reference adapter on your data.
- App-layer pieces you can copy or replace: the NL compiler
  (`lib/lore/compile-query.ts`, one `generateObject` call against your
  field catalog), the cell runner (`lib/lore/run-column.ts`), the
  certification worker (`lib/lore/certify.ts`), and the API routes under
  `app/api/lore/`.

Model access goes through the Vercel AI Gateway; default model and pinned
decode parameters live in `lib/lore/models.ts`.

## The research in one paragraph

An AI column is a materialized view of a versioned prompt. Cells are
stochastic even at temperature zero (the same prompt disagrees with itself
on 5.0% of rows on our Boolean workload), so "did the edit change this
cell?" is only meaningful statistically. sIVM freezes cached-value strata,
samples each on a doubling look schedule, bounds each stratum's flip rate
with an exact finite-population confidence bound (validity under peeking by
splitting the failure probability across looks), and reuses only strata
that clear the user's error budget, with two guarantee targets (all
presented cells, or the strict reuse set). Measured on two public corpora
with five edit pairs and 28,000 labeled cells: a formatting-only edit
certifies reuse of 82.6% of cells on average at an error budget of 0.1 and
of 88.1% at 0.2 (failure probability 0.1; 1,000 sampling replications), and
on the full 89,184-row corpus at budget 0.2, 90 fresh calls certify reuse
of 81,424 cells. Across 396,000 calibration runs, certificates that exceed
their budget occur in at most 1.00% of runs per configuration, and at the
least favorable population the probability, computed exactly, is at most
2.7%, against a nominal 5% per stratum. Everything else is refused. On each
of 6 further models from four providers at least one edit certifies in
nearly every sampling replication; which edits are benign varies by model.
These are
the figures of the IEEE Access resubmission (`paper/ieee/`), which pins the
exact bound; the earlier preprint used an empirical-Bernstein bound, and
its certification results reproduce with that arm selected. Every number
regenerates from `scripts/experiments/`. The HTML report at
`docs/research/lore-research-report.html` is a snapshot of the preprint's
numbers and is not regenerated for the resubmission.

## Repository map

| Path | What |
| --- | --- |
| `packages/core` | SPI types + sIVM math (framework heart) |
| `packages/adapter-*` | Elasticsearch / MySQL adapters |
| `lib/lore/` | NL compiler, cell runner, certifier, stores |
| `app/lore/`, `app/api/lore/` | table UI + API |
| `scripts/ingest/` | corpus ingestion (reproducible) |
| `scripts/experiments/` | exp0–exp19 (exp9b: the certifier's exact error probability at the least favorable population; exp9c: what block-scale dependence among draws would cost that probability; exp11b: the audit verifier, which recomputes every deployment audit without the certifier; exp14–exp19: bound ablation and null study, snapshot versions and drift, independence check, remaining pairs on further models, free-text judge pilot; exp18b: the replication analysis repeated on every further model's stored draws) + asset generation |
| `docs/research/` | report, review memos, result JSONs |
| `paper/` | manuscript body (`body.tex`) and appendices (`appendix.tex`) shared by the acmart shell (`main.tex`, tectonic, appendices inline) and the IEEE Access shell (`ieee/main.tex`, latexmk; the appendices print in its Supplementary Material, `ieee/supplement.tex`, so the article stays under the 20 pages IEEE Access recommends; `pnpm pack:paper:ieee` builds the submission package: `scripts/pack-ieee-submission.sh` with `scripts/resolve-tex-gates.py` for the prose gates, `scripts/mark-bbl-changes.py` for the highlighted copy's reference list, `scripts/highlight-yellow.py` for the yellow highlight under the changed text, `scripts/resolve-response-refs.py` for the response and cover letters, whose table, section, and reference numbers and quoted figures are filled from the manuscript build, and `scripts/gen-resubmission-checklist.py` for the upload checklist) |
| `patent/` | provisional draft (attorney review pending) |

## Reproducing the paper

Every quantitative claim in the paper and in the research report is emitted
from the result artifacts by one generator and cited through a macro, never
typed inline, so re-running an experiment regenerates the sentences that cite
it. Three commands rebuild the IEEE Access manuscript and its Supplementary
Material (`pnpm build:paper` builds the preprint shell from the same body):

```bash
pnpm gen:paper && pnpm check:paper && pnpm build:paper:ieee
```

`gen:paper` writes `paper/macros.tex`, `paper/figdata.tex`, and the generated
tables (`paper/table*.tex`) from `docs/research/experiments/*.json` plus the
system's cost ledger, and dumps every database read it makes to
`db-derived-inputs.json` so the numbers are recomputable without our
instance. `gen:paper` itself needs the populated database; without one,
`pnpm check:paper && pnpm build:paper:ieee` rebuilds the manuscript from the
committed macros and tables. `check:paper`
is the enforcement pass and fails on ten conditions: a hand-typed quantity in
the prose, a quantity hardcoded in the generator, a macro defined but never
cited, a macro that swallows its trailing space, a sentence asserting two
quantities differ while citing two macros of equal value, a spelled-out
multiplier the macro ratio does not support, a containment claim the cited
macros do not support, an absolute claim in the abstract or contributions
outside an allow-list, a "same column" claim whose macros come from different
columns, and a sentence of the prose, of a list item, of a caption, or of
the abstract longer than 60 words. It also prints the
readability statistics the response letter quotes (sentence lengths, and the
density of numbers in the main text), and prints them for any other source
given in `PROSE_STATS_BODY` and `PROSE_STATS_MACROS`. The generator adds its own
assertions on the relations the prose states between figures. Each guard
exists because the corresponding defect shipped at least once.

Reproducing the statistical results needs no model endpoint and no database:
the five edit pairs (both prompt templates of each, with the model and the
output contract) and their per-cell labels are released as
`docs/research/experiments/benchmark-labels.json`, and

```bash
EXP_STRATIFIER=value-only EXP_LABELS=docs/research/experiments/benchmark-labels.json \
  pnpm tsx scripts/experiments/exp8-final-table.ts
```

rebuilds the main results table from them. The deployment audits recompute
the same way, from `docs/research/experiments/deployment-audit-cells.json`
(every row an audit reads, with its cached and oracle values):

```bash
EXP_CELLS=docs/research/experiments/deployment-audit-cells.json \
  pnpm tsx scripts/experiments/exp11b-verify.ts
```

Adding `EXP_EQUIV=adjacent-tier`
and an `EXP_OUT` of its own re-scores the ordinal select column under a graded
relation (adjacent tiers equivalent), the paper's graded result, from the same
labels. Recomputing the labels themselves
needs an endpoint, and costs about the ledgered spend reported in the paper.
The corpora are not redistributed here: download them from their maintainers
(the sources and licenses are in `docs/research/dataset-shortlist.md` and in
the paper's references) into `.local-infra/data/`, and `scripts/ingest/` loads
them.

Data licenses: SO Survey 2023 under ODbL 1.0/DbCL 1.0; Djinni profiles
under MIT (lang-uk). The chat scaffold this app began from is the eve
chat template; eve docs live in `node_modules/eve/docs` and the original
template docs in [`docs/`](docs/).

## License

This repository is **source-available, not open source**. The code is
licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md):
personal, research, educational, and other noncommercial use is free,
and reproducing the paper's results is expressly welcome. **Commercial
or production use of any kind requires prior written permission from the
copyright holder**; permissions are granted individually and are
revocable on the terms of each grant. See [COMMERCIAL.md](COMMERCIAL.md)
for how to ask. The underlying datasets keep their own licenses (ODbL
1.0/DbCL 1.0 and MIT) and are fetched from their original sources, not
redistributed here.

Copyright &copy; 2026 Arjun Lohan.
