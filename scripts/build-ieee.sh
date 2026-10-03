#!/usr/bin/env bash
# Build the IEEE Access article (paper/ieee/main.tex) and its Supplementary
# Material (paper/ieee/supplement.tex) in place. The two read each other's
# .aux through xr-hyper, so the article is built, then the supplement, then
# the article again.
#
# SOURCE_DATE_EPOCH is the time of the last commit that touched the sources
# the two PDFs are built from (the PDFs themselves and the letters excluded),
# so pdfTeX writes the same dates and document ID on every run: an unchanged
# source gives byte-identical PDFs, and rebuilding leaves the tracked PDFs
# clean.
#
# Run: pnpm build:paper:ieee
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct -- paper \
  ':(exclude)paper/*.pdf' ':(exclude)paper/ieee/*.pdf' \
  ':(exclude)paper/ieee/response.md' ':(exclude)paper/ieee/cover-letter.tex' \
  ':(exclude)paper/ieee/resubmission-checklist.md')"
export SOURCE_DATE_EPOCH
pnpm -s gen:ieee-refs
cd paper/ieee
latexmk -pdf -interaction=nonstopmode main.tex
latexmk -g -pdf -interaction=nonstopmode supplement.tex
latexmk -g -pdf -interaction=nonstopmode main.tex
