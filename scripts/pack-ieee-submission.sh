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
cp paper/body.tex paper/macros.tex paper/figdata.tex paper/table1.tex paper/tablefam.tex \
   paper/tablebounds.tex paper/tablerates.tex paper/tablemodels.tex paper/tabledeploy.tex \
   paper/tablefampairs.tex paper/tableboundsgrid.tex "$OUT/src/"
# 3. Vendored template (class, bst, fonts, maps, fd, logos) and the IEEE bib.
cp paper/ieee/ieeeaccess.cls paper/ieee/IEEEtran.cls paper/ieee/IEEEtran.bst paper/ieee/spotcolor.sty \
   paper/ieee/t1-*.pfb paper/ieee/t1-*.tfm paper/ieee/t1-*.map paper/ieee/t1*.fd \
   paper/ieee/logo.png paper/ieee/notaglinelogo.png paper/ieee/bullet.png \
   paper/ieee/refs.bib "$OUT/src/"

# 4. Compile the flattened copy exactly as the portal's referees would.
( cd "$OUT/src" && latexmk -pdf -interaction=nonstopmode main.tex >/dev/null 2>&1 )
ERRORS=$(/usr/bin/grep -c '^!' "$OUT/src/main.log" || true)
[ "$ERRORS" = "0" ] || { echo "flattened build has $ERRORS TeX errors"; exit 1; }
PAGES_FLAT=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' "$OUT/src/main.log" | /usr/bin/grep -o '[0-9]* pages')
PAGES_TREE=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' paper/ieee/main.log | /usr/bin/grep -o '[0-9]* pages')
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
echo "cover letter: $OUT/cover-letter.pdf ($(/usr/bin/grep -o 'Output written on cover-letter.pdf ([0-9]* pages\?' "$OUT/cover/cover-letter.log" | /usr/bin/grep -o '[0-9]* pages\?'))"
echo "packed: $OUT/manuscript.pdf ($PAGES_FLAT), $OUT/source.zip ($(du -h "$OUT/source.zip" | cut -f1); flat, with main.bbl and main.pdf)"

# 7. Resubmission deliverables (IEEE Access reject-with-resubmission): the
#    point-by-point response to reviewers rendered from paper/ieee/response.md,
#    and a "Highlighted PDF" with every change marked, built by latexdiff
#    against the source submitted under the git tag DIFF_BASE_TAG.
if [ -f paper/ieee/response.md ]; then
  pandoc paper/ieee/response.md -o "$OUT/response-to-reviewers.docx"
  pandoc paper/ieee/response.md -o "$OUT/response-to-reviewers.pdf" --pdf-engine=pdflatex \
    -V geometry:margin=1in -V fontsize=11pt -V colorlinks=true
  echo "response: $OUT/response-to-reviewers.docx and .pdf"
fi
DIFF_BASE_TAG="${DIFF_BASE_TAG:-ieee-access-submission-v1}"
LATEXDIFF=$(kpsewhich latexdiff.pl 2>/dev/null || find "$(kpsewhich -var-value TEXMFDIST)/scripts/latexdiff" -name latexdiff.pl 2>/dev/null | head -1)
# latexdiff needs Encode::Locale; Homebrew's perl ships without it, the
# system perl may have it. Pick whichever can load the module.
PERL=""
for candidate in /usr/bin/perl "$(command -v perl)"; do
  if [ -n "$candidate" ] && "$candidate" -MEncode::Locale -e 1 2>/dev/null; then PERL="$candidate"; break; fi
done
if [ -z "$PERL" ]; then
  echo "highlighted PDF skipped: no perl with Encode::Locale (install with: cpanm Encode::Locale)"
elif [ -n "$LATEXDIFF" ] && git rev-parse -q --verify "$DIFF_BASE_TAG" >/dev/null; then
  rm -rf "$OUT/diff" && mkdir -p "$OUT/diff/old" "$OUT/diff/new"
  # Old: the tagged sources, flattened the same way step 1 flattens the shell.
  git show "$DIFF_BASE_TAG:paper/ieee/main.tex" \
    | sed -e 's#\\input{\.\./#\\input{#g' -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' > "$OUT/diff/old/main.tex"
  for f in body.tex macros.tex figdata.tex table1.tex tablefam.tex; do
    git show "$DIFF_BASE_TAG:paper/$f" > "$OUT/diff/old/$f"
  done
  # New: the flattened sources of this package.
  cp "$OUT"/src/*.tex "$OUT/diff/new/"
  # latexdiff --flatten cannot resolve \input{\paperroot/...}; inline the
  # root in both copies. The last-page stretch is a length argument latexdiff
  # would mark up into a TeX error, and the highlighted copy paginates
  # differently anyway.
  for d in old new; do
    sed -i '' -e 's#\\input{\\paperroot/#\\input{#g' "$OUT/diff/$d/body.tex"
    sed -i '' -e '/\\enlargethispage/d' "$OUT/diff/$d/main.tex"
  done
  # The prose gates optional studies on \ifnum<macro>=1\relax ... \else ... \fi;
  # latexdiff marks up inside the test and breaks it. Resolve the gates with
  # each copy's own macro values, so the diff shows what actually prints, and
  # then substitute every generated macro by its value in both copies: a
  # number that changed under an unchanged macro name is a change the
  # reviewer must see in blue, which latexdiff cannot know from the names.
  for d in old new; do
    for f in body.tex main.tex; do
      python3 - "$OUT/diff/$d/$f" "$OUT/diff/$d/macros.tex" <<'PY'
import re, sys
path, macros = sys.argv[1], sys.argv[2]
vals = dict(re.findall(r'\\newcommand\{\\(\w+)\}\{(.*)\}', open(macros).read()))
src = open(path).read()
def resolve(m):
    name, yes, no = m.group(1), m.group(2), m.group(3) or ""
    text = yes if vals.get(name, "0").strip() == "1" else no
    # A gate that occupied its own lines must not leave a blank line behind,
    # which TeX would read as a paragraph break the clean copy does not have.
    if m.start() > 0 and src[m.start() - 1] == "\n" and text.startswith("\n"):
        text = text[1:]
    if text.endswith("\n") and src[m.end():m.end() + 1] == "\n":
        text = text[:-1]
    return text
out = re.sub(r'\\ifnum\\(\w+)=1\\relax(.*?)(?:\\else(.*?))?\\fi', resolve, src, flags=re.S)
names = sorted(vals, key=len, reverse=True)
if names:
    pat = re.compile(r'\\(' + '|'.join(map(re.escape, names)) + r')(\\[ \n]|\{\}|(?=[^A-Za-z]))')
    def expand(m):
        tail = m.group(2)
        return vals[m.group(1)] + (" " if tail.startswith("\\") else "")
    out = pat.sub(expand, out)
open(path, "w").write(out)
PY
    done
  done
  # Bibliographies: latexdiff --flatten inlines each side's main.bbl when it
  # exists, so changed reference entries are marked too. The new one comes
  # from this build; the old one is rebuilt from the tagged sources.
  cp "$OUT/src/main.bbl" "$OUT/diff/new/main.bbl"
  git show "$DIFF_BASE_TAG:paper/ieee/refs.bib" > "$OUT/diff/old/refs.bib" 2>/dev/null || cp "$OUT/src/refs.bib" "$OUT/diff/old/refs.bib"
  cp "$OUT"/src/*.cls "$OUT"/src/*.bst "$OUT"/src/*.sty "$OUT"/src/*.pfb "$OUT"/src/*.tfm "$OUT"/src/*.map "$OUT"/src/*.fd "$OUT"/src/*.png "$OUT/diff/old/"
  ( cd "$OUT/diff/old" && latexmk -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1 ) || true
  [ -f "$OUT/diff/old/main.bbl" ] || echo "note: old bibliography could not be rebuilt; the reference list will be compared as a block"
  # tikz/pgfplots pictures, the algorithm block and the abstract's own
  # environment are compared as wholes; math is not marked inside.
  if ! "$PERL" "$LATEXDIFF" --flatten --math-markup=0 \
      --preamble=paper/ieee/latexdiff-highlight.tex \
      --config "PICTUREENV=(?:picture|DIFnomarkup|tikzpicture|axis|algorithmic|tabular)[\\w\\d*@]*" \
      --config "FLOATENV=(?:figure|table|plate|algorithm)[\\w\\d*@]*" \
      --exclude-safecmd=Description \
      "$OUT/diff/old/main.tex" "$OUT/diff/new/main.tex" > "$OUT/diff/main.tex" 2> "$OUT/diff/latexdiff.log"; then
    echo "latexdiff FAILED (see $OUT/diff/latexdiff.log)"; exit 1
  fi
  # latexdiff wraps \DIFadd/\DIFdel in \texorpdfstring when it sees hyperref,
  # for headings; headings are excluded from markup above, and the wrapper
  # cannot span a paragraph break, so restore the plain definitions.
  python3 - "$OUT/diff/main.tex" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace(r"\providecommand{\DIFadd}[1]{\texorpdfstring{\DIFaddtex{#1}}{#1}}", r"\providecommand{\DIFadd}[1]{\DIFaddtex{#1}}")
s = s.replace(r"\providecommand{\DIFdel}[1]{\texorpdfstring{\DIFdeltex{#1}}{}}", r"\providecommand{\DIFdel}[1]{\DIFdeltex{#1}}")
import re
# A word-internal edit leaves the source's own space after \DIFaddend, where
# TeX swallows it (latexdiff always adds one separator space; two mean a
# real one); keep the real space.
s = re.sub(r"(\\DIF(?:add|del)end) {2,}(?=\S)", r"\1{} ", s)
# In colour-only markup a deleted paragraph prints nothing, but the blank
# line latexdiff keeps between its comment markers would still break the
# paragraph the new text continues.
s = re.sub(r"(%DIFDELCMD < [^\n]*\n)\n+(%DIFDELCMD < %%%\n)", r"\1\2", s)
open(p, "w").write(s)
PY
  # Compile the diff beside the vendored template files.
  cp "$OUT"/src/*.cls "$OUT"/src/*.bst "$OUT"/src/*.sty "$OUT"/src/*.pfb "$OUT"/src/*.tfm "$OUT"/src/*.map "$OUT"/src/*.fd "$OUT"/src/*.png "$OUT/src/refs.bib" "$OUT/diff/"
  ( cd "$OUT/diff" && latexmk -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1 ) || true
  DIFF_ERRORS=$(/usr/bin/grep -c '^!' "$OUT/diff/main.log" 2>/dev/null || true)
  if [ -f "$OUT/diff/main.pdf" ] && [ "${DIFF_ERRORS:-1}" = "0" ]; then
    cp "$OUT/diff/main.pdf" "$OUT/highlighted.pdf"
    echo "highlighted: $OUT/highlighted.pdf ($(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' "$OUT/diff/main.log" | /usr/bin/grep -o '[0-9]* pages\?'); diff base $DIFF_BASE_TAG)"
  else
    echo "highlighted PDF FAILED: $DIFF_ERRORS TeX errors in $OUT/diff/main.log"; exit 1
  fi
else
  echo "highlighted PDF skipped (latexdiff or tag $DIFF_BASE_TAG missing)"
fi
