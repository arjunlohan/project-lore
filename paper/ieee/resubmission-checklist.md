# IEEE Access resubmission checklist: Access-2026-41149

Built from the repository state that the tag `ieee-access-resubmission-v1` marks (regenerate with `pnpm pack:paper:ieee`; outputs in `paper/ieee/submission/`, which is gitignored).

## 1. Files and where they go (IEEE Author Portal, "Start Resubmission" on Access-2026-41149)

| Portal slot | File | Size | SHA-256 |
| --- | --- | ---: | --- |
| Main Manuscript (clean): PDF | `manuscript.pdf` (22 pages) | 593,272 | `01b286df62150bced0b24a6ae2cdbb5d1f9f20c45482bd651f5a5e35322f5bef` |
| Main Manuscript (clean): LaTeX source | `source.zip` (flat: main.tex, body, tables, macros, refs.bib, main.bbl, main.pdf, class and fonts) | 1,694,448 | `43271cb53d2fa14782fc74c36bdce97df5080bc99b9dc6ea33f33dd68c355320` |
| Highlighted PDF (all changes marked) | `highlighted.pdf` (22 pages; blue = added or changed, deletions omitted, changed numbers marked, reference list compared entry by entry) | 596,634 | `3b5c8af461aa665b345cb6213b99c345f56bb802416edea6ec02c2f8f44449f5` |
| Author's Response Files (point-by-point) | `response-to-reviewers.docx` (13 pages as PDF; the `.pdf` twin is the same text if the portal prefers PDF) | 29,011 | `a579ff7ae496d468b1258c78ed3efe0c58267da996e9ab28c885784eb39db63e` |
| Cover letter | `cover-letter.pdf` (1 page), or paste its text into the cover-letter field | 38,101 | `1a06d8b571792f4126e73cc56e9cf2e9cd2c9cd6dbbb5512be192142cc7bcba7` |

Not needed: the byline-change form (single author, unchanged). The portal's resubmission checklist template: answer that every reviewer comment is addressed in the response file, that the highlighted copy marks every change, and that the byline is unchanged.

## 2. Form fields (unchanged from the first submission unless noted)

| Field | Answer |
| --- | --- |
| Manuscript ID | Access-2026-41149 (resubmission of the 29 September 2026 decision) |
| Article type | Regular Manuscript / Research Article |
| Title | Reuse, but Verify: Certified Maintenance of Table Cells Computed by Large Language Models under Prompt Edits |
| Abstract (paste; 245 words) | see below |
| Index terms | Caching, confidence bounds, incremental view maintenance, large language models, materialized views, prompt engineering, query processing |
| Corresponding author | Arjun Lohan, lohan@usc.edu, ORCID 0009-0003-3605-1221, University of Southern California, Los Angeles, CA 90089 USA |
| Funding / conflicts | None / None |
| Preprint | Yes: Zenodo, doi:10.5281/zenodo.21833641 (declared in the cover letter; expect high iThenticate similarity to it and to the first submission) |
| Under review elsewhere | No |
| Supplementary files | None (code, labels, artifacts are public in the repository named in the Availability section) |
| License at acceptance | CC BY; APC personal |

### Abstract text to paste

Modern data tables let users define columns in natural language: a language model computes each cell from a versioned prompt over its row. When the prompt is edited, systems either recompute every cell or reuse stale ones, with unbounded error. We present semantic incremental view maintenance (sIVM), which certifies which cached cells may be reused after a prompt edit, bounding each certified stratum’s falsereuse rate by a user-chosen error budget with stated confidence. sIVM freezes cached-value strata, samples adaptively on a doubling schedule, and bounds each stratum’s flip rate with an exact finite-population confidence bound; a strict mode bounds the error of the reused cells alone. An impossibility floor follows for this estimand: a model’s rate of disagreement with itself under the unedited prompt limits the certifiable budget. On two public corpora with 28,000 labeled cells, a formatting-only edit certifies 88.4% call savings at an error budget of 0.2 with 3.20% realized false-reuse, and at deployment scale 90 oracle calls certify reuse of 81,424 of 89,184 cells. Across 396,000 calibration runs with planted flip rates, unsafe certificates occur in at most 1.00% of runs in any configuration, against a nominal 5%. A second certification 55 days later, against the same cache, measured provider-side model drift and re-certified the same budgets. Certification reproduces on 6 of 6 further model families, while which edits are benign varies by family. The system is released under a source-available noncommercial license, with labels and a benchmark of versioned promptedit pairs.

## 3. Before you press submit

- Open `highlighted.pdf` once and confirm blue text appears on page 1 (abstract numbers) and in the reference list.
- The response document's opening letter names the three file designations; keep them consistent with the slots you use.
- Do not upload the `.partial.json` checkpoints or anything from `paper/ieee/submission/diff/`.

## 4. After submission

- Record the new submission timestamp and any new manuscript ID in `tasks/todo.md`.
- On acceptance: final files, graphical abstract (Figure 1 export, 660x295 JPG under 45 KB, caption under 60 words), Zenodo record updated with the IEEE citation and DOI.
