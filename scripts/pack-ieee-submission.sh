#!/usr/bin/env bash
# Build the IEEE Access submission package: a flat, self-contained LaTeX
# source directory plus its compiled PDF, both from the SAME source tree the
# guards just checked. The IEEE shell (paper/ieee/main.tex) reads the shared
# prose via ../body etc.; the portal expects a zip whose main.tex compiles on
# its own, so this flattens those paths, compiles the flattened copy with
# the same TeX Live toolchain, and zips it. Fails loudly if the flattened
# build differs in page count from the in-tree build.
#
# Run: pnpm pack:paper:ieee   (after pnpm gen:paper && pnpm check:paper)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

pnpm gen:ieee-refs >/dev/null
OUT=paper/ieee/submission
rm -rf "$OUT" && mkdir -p "$OUT/src"

# 1. Shell with flattened input paths and macro root.
sed -e 's#\\input{\.\./#\\input{#g' \
    -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' \
    paper/ieee/main.tex > "$OUT/src/main.tex"
# 2. Shared prose and generated inputs.
cp paper/body.tex paper/macros.tex paper/figdata.tex paper/table1.tex paper/tablefam.tex "$OUT/src/"
# 3. Vendored template (class, bst, fonts, maps, fd, logos) and the IEEE bib.
cp paper/ieee/ieeeaccess.cls paper/ieee/IEEEtran.cls paper/ieee/IEEEtran.bst paper/ieee/spotcolor.sty \
   paper/ieee/t1-*.pfb paper/ieee/t1-*.tfm paper/ieee/t1-*.map paper/ieee/t1*.fd \
   paper/ieee/logo.png paper/ieee/notaglinelogo.png paper/ieee/bullet.png \
   paper/ieee/refs.bib "$OUT/src/"

# 4. Compile the flattened copy exactly as the portal's referees would.
( cd "$OUT/src" && latexmk -pdf -interaction=nonstopmode main.tex >/dev/null 2>&1 )
ERRORS=$(/usr/bin/grep -c '^!' "$OUT/src/main.log" || true)
[ "$ERRORS" = "0" ] || { echo "flattened build has $ERRORS TeX errors"; exit 1; }
PAGES_FLAT=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages' "$OUT/src/main.log" | /usr/bin/grep -o '[0-9]* pages')
PAGES_TREE=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages' paper/ieee/main.log | /usr/bin/grep -o '[0-9]* pages')
[ "$PAGES_FLAT" = "$PAGES_TREE" ] || { echo "page count differs: flat=$PAGES_FLAT tree=$PAGES_TREE"; exit 1; }
UNDEF=$(/usr/bin/grep -c 'Citation.*undefined\|Reference.*undefined' "$OUT/src/main.log" || true)
[ "$UNDEF" = "0" ] || { echo "$UNDEF undefined citations/references"; exit 1; }

# 5. Deliverables: the PDF, and a FLAT zip of the sources (the IEEE Author
#    Portal compiles the archive itself: main.tex at the archive root, the
#    resolved main.bbl kept so the build does not depend on the portal
#    running BibTeX, and the matching main.pdf included as the checklist's
#    "source plus matching PDF"). Build residue (aux/log/fls/...) removed.
cp "$OUT/src/main.pdf" "$OUT/manuscript.pdf"
( cd "$OUT/src" && latexmk -c main.tex >/dev/null 2>&1 )   # keeps main.bbl; -c never removes .bbl/.pdf? it removes .pdf, so restore:
cp "$OUT/manuscript.pdf" "$OUT/src/main.pdf"
( cd "$OUT/src" && rm -f source.zip && zip -q source.zip * -x '*.DS_Store' && mv source.zip .. )
# 6. Cover letter (source tracked at paper/ieee/cover-letter.tex; the
#    portal's "Cover letter / Comments" slot takes a PDF).
mkdir -p "$OUT/cover" && cp paper/ieee/cover-letter.tex "$OUT/cover/" \
  && ( cd "$OUT/cover" && pdflatex -interaction=nonstopmode cover-letter.tex >/dev/null 2>&1 && pdflatex -interaction=nonstopmode cover-letter.tex >/dev/null 2>&1 ) \
  && cp "$OUT/cover/cover-letter.pdf" "$OUT/cover-letter.pdf"
echo "cover letter: $OUT/cover-letter.pdf ($(/usr/bin/grep -o 'Output written on cover-letter.pdf ([0-9]* pages' "$OUT/cover/cover-letter.log" | /usr/bin/grep -o '[0-9]* pages'))"
echo "packed: $OUT/manuscript.pdf ($PAGES_FLAT), $OUT/source.zip ($(du -h "$OUT/source.zip" | cut -f1); flat, with main.bbl and main.pdf)"
