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
   cells can be reused instead of recomputed, with the expected false-reuse
   rate bounded by a user budget. Paper: ["Reuse, but Verify: Certified
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
  empirical-Bernstein certification, both estimand modes).
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
certifies 88.4% call savings at an error budget of 0.2 (88.1% mean over
1,000 sampling replications), and at deployment scale 90 fresh calls
certify reuse of 81,424 of 89,184 cells. Across 396,000 calibration runs,
certificates that exceed their budget occur in at most 1.00% of runs per
configuration, against a nominal 5%. Everything else is refused. These are
the figures of the IEEE Access resubmission (`paper/ieee/`), which pins the
exact bound; the earlier preprint used an empirical-Bernstein bound, and
its certification results reproduce with that arm selected. Every number
regenerates from `scripts/experiments/`; the earlier HTML report is at
`docs/research/lore-research-report.html`.

## Repository map

| Path | What |
| --- | --- |
| `packages/core` | SPI types + sIVM math (framework heart) |
| `packages/adapter-*` | Elasticsearch / MySQL adapters |
| `lib/lore/` | NL compiler, cell runner, certifier, stores |
| `app/lore/`, `app/api/lore/` | table UI + API |
| `scripts/ingest/` | corpus ingestion (reproducible) |
| `scripts/experiments/` | exp0–exp19 (exp9b: the certifier's exact error probability at the least favourable population; exp9c: what block-scale dependence among draws would cost that probability; exp11b: the audit verifier, which recomputes every deployment audit without the certifier; exp14–exp19: bound ablation and null study, snapshot versions and drift, independence check, remaining pairs on further families, free-text judge pilot) + asset/report generation |
| `docs/research/` | report, review memos, result JSONs |
| `paper/` | manuscript body shared by the acmart shell (`main.tex`, tectonic) and the IEEE Access shell (`ieee/main.tex`, latexmk; `pnpm pack:paper:ieee` builds the submission package: `scripts/pack-ieee-submission.sh` with `scripts/resolve-tex-gates.py` for the prose gates, `scripts/mark-bbl-changes.py` for the highlighted copy's reference list, and `scripts/gen-resubmission-checklist.py` for the upload checklist) |
| `patent/` | provisional draft (attorney review pending) |

## Reproducing the paper

Every quantitative claim in the paper and in the research report is emitted
from the result artifacts by one generator and cited through a macro, never
typed inline, so re-running an experiment regenerates the sentences that cite
it. Four commands rebuild the whole thing:

```bash
pnpm gen:paper && pnpm gen:report && pnpm check:paper && pnpm build:paper
```

`gen:paper` writes `paper/{macros,table1,figdata}.tex` from
`docs/research/experiments/*.json` plus the system's cost ledger, and dumps
every database read it makes to `db-derived-inputs.json` so the numbers are
recomputable without our instance. `gen:report` emits
`docs/research/lore-research-report.html` from the same macros. `check:paper`
is the enforcement pass and fails on six conditions: a hand-typed quantity in
the prose, a quantity hardcoded in the generator, a macro defined but never
cited, a macro that swallows its trailing space, a sentence asserting two
quantities differ while citing two macros of equal value, and a spelled-out
multiplier the macro ratio does not support. Each guard exists because the
corresponding defect shipped at least once.

Reproducing the statistical results needs no model endpoint: the ground-truth
flip labels are released. Recomputing the labels themselves does, and costs
about the ledgered spend reported in the paper.

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
