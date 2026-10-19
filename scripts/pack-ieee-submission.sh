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

# The in-tree article and Supplementary Material first (pnpm build:paper:ieee
# builds the pair, each reading the other's .aux): the flattened copies below
# are checked against them page for page, and the article's references to the
# supplement are resolved from the supplement's .aux.
pnpm -s build:paper:ieee >/dev/null 2>&1 || { echo "in-tree build failed (run pnpm build:paper:ieee)"; exit 1; }
# The same fixed timestamp for the packaged builds (see scripts/build-ieee.sh),
# so a repack of an unchanged source reproduces its PDFs byte for byte.
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct -- paper ':(exclude)paper/*.pdf' ':(exclude)paper/ieee/*.pdf' ':(exclude)paper/ieee/response.md' ':(exclude)paper/ieee/cover-letter.tex' ':(exclude)paper/ieee/resubmission-checklist.md')"
export SOURCE_DATE_EPOCH
OUT=paper/ieee/submission
# The version the reviewers last saw: the highlighted copy is compared with
# it, and the letters' readability figures are measured against it.
DIFF_BASE_TAG="${DIFF_BASE_TAG:-ieee-access-resubmission-v10}"
rm -rf "$OUT" && mkdir -p "$OUT/src" "$OUT/supp"
# Generated tables a source \input's through \paperroot, so each copy carries
# exactly the tables it prints.
tables_of() { /usr/bin/grep -o '\\input{\\paperroot/[A-Za-z0-9]*}' "$1" | sed -E 's#.*/([A-Za-z0-9]+)\}#paper/\1.tex#' | sort -u; }

# 1. Shell with flattened input paths and macro root.
sed -e 's#\\input{\.\./#\\input{#g' \
    -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' \
    paper/ieee/main.tex > "$OUT/src/main.tex"
# 2. Shared prose and generated inputs.
cp paper/body.tex paper/macros.tex paper/figdata.tex $(tables_of paper/body.tex) "$OUT/src/"
# The prose gates optional studies on \ifnum<macro>=1\relax ... \else ... \fi;
# the shipped source carries only the branch that prints, so nobody editing
# it at the publisher meets dead text. Macros stay macros here.
python3 scripts/resolve-tex-gates.py "$OUT/src/body.tex" "$OUT/src/macros.tex"
# 3. Vendored template (class, bst, fonts, maps, fd, logos) and the IEEE bib.
cp paper/ieee/ieeeaccess.cls paper/ieee/IEEEtran.cls paper/ieee/IEEEtran.bst paper/ieee/spotcolor.sty \
   paper/ieee/t1-*.pfb paper/ieee/t1-*.tfm paper/ieee/t1-*.map paper/ieee/t1*.fd \
   paper/ieee/logo.png paper/ieee/notaglinelogo.png paper/ieee/bullet.png \
   paper/ieee/refs.bib "$OUT/src/"
# The author photograph is optional and private. It lives in the gitignored
# paper/ieee/private/, outside the in-tree build's search path, so the
# tracked paper/ieee/main.pdf never carries it; copied next to the flattened
# main.tex, it sets the biography with the photograph (main.tex decides).
PHOTO=paper/ieee/private/author-photo.jpg
if [ -f "$PHOTO" ]; then cp "$PHOTO" "$OUT/src/"; echo "author photo: included"; else echo "author photo: NOT included ($PHOTO is missing; IEEE's resubmission checklist asks for one)"; fi

# The article cites the appendices and the supplement's tables by number
# ("Appendix D", "Table S3") through xr; the shipped source carries that text
# instead, so it compiles without the supplement.
python3 scripts/resolve-supp-refs.py paper/ieee/supplement.aux "$OUT/src/main.tex" "$OUT/src/body.tex"

# 3b. The Supplementary Material: the shared appendices under the same
#     template, flattened the same way, reading the article's labels and
#     reference numbers from the flattened article's .aux (step 4).
sed -e 's#\\input{\.\./#\\input{#g' \
    -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' \
    paper/ieee/supplement.tex > "$OUT/supp/supplement.tex"
cp paper/appendix.tex paper/macros.tex paper/figdata.tex $(tables_of paper/appendix.tex) "$OUT/supp/"
python3 scripts/resolve-tex-gates.py "$OUT/supp/appendix.tex" "$OUT/supp/macros.tex"
cp paper/ieee/ieeeaccess.cls paper/ieee/IEEEtran.cls paper/ieee/spotcolor.sty \
   paper/ieee/t1-*.pfb paper/ieee/t1-*.tfm paper/ieee/t1-*.map paper/ieee/t1*.fd \
   paper/ieee/logo.png paper/ieee/notaglinelogo.png paper/ieee/bullet.png "$OUT/supp/"

# 4. Compile the flattened copy exactly as the portal's referees would.
( cd "$OUT/src" && latexmk -pdf -interaction=nonstopmode main.tex >/dev/null 2>&1 )
ERRORS=$(/usr/bin/grep -c '^!' "$OUT/src/main.log" || true)
[ "$ERRORS" = "0" ] || { echo "flattened build has $ERRORS TeX errors"; exit 1; }
PAGES_FLAT=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' "$OUT/src/main.log" | /usr/bin/grep -o '[0-9]* pages')
PAGES_TREE=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' paper/ieee/main.log | /usr/bin/grep -o '[0-9]* pages')
[ "$PAGES_FLAT" = "$PAGES_TREE" ] || { echo "page count differs: flat=$PAGES_FLAT tree=$PAGES_TREE"; exit 1; }
UNDEF=$(/usr/bin/grep -c 'Citation.*undefined\|Reference.*undefined' "$OUT/src/main.log" || true)
[ "$UNDEF" = "0" ] || { echo "$UNDEF undefined citations/references"; exit 1; }
# The supplement against the flattened article: no error, nothing undefined,
# the in-tree page count, and the same labels the article's text was
# resolved from.
cp "$OUT/src/main.aux" "$OUT/supp/main.aux"
( cd "$OUT/supp" && latexmk -pdf -interaction=nonstopmode supplement.tex >/dev/null 2>&1 )
[ "$(/usr/bin/grep -c '^!' "$OUT/supp/supplement.log" || true)" = "0" ] || { echo "supplement build has TeX errors"; exit 1; }
SUPP_UNDEF=$(/usr/bin/grep -c 'Citation.*undefined\|Reference.*undefined' "$OUT/supp/supplement.log" || true)
[ "$SUPP_UNDEF" = "0" ] || { echo "supplement: $SUPP_UNDEF undefined citations/references (a key cited only in the appendices must be cited in the article)"; exit 1; }
SUPP_FLAT=$(/usr/bin/grep -o 'Output written on supplement.pdf ([0-9]* pages\?' "$OUT/supp/supplement.log" | /usr/bin/grep -o '[0-9]* pages')
SUPP_TREE=$(/usr/bin/grep -o 'Output written on supplement.pdf ([0-9]* pages\?' paper/ieee/supplement.log | /usr/bin/grep -o '[0-9]* pages')
[ "$SUPP_FLAT" = "$SUPP_TREE" ] || { echo "supplement page count differs: flat=$SUPP_FLAT tree=$SUPP_TREE"; exit 1; }
labels_of() { /usr/bin/grep -o '^\\newlabel{[^}]*}{{[^}]*}' "$1" | sort; }
[ "$(labels_of "$OUT/supp/supplement.aux")" = "$(labels_of paper/ieee/supplement.aux)" ] \
  || { echo "the packaged supplement numbers its labels differently from the in-tree build"; exit 1; }
cp "$OUT/supp/supplement.pdf" "$OUT/supplement.pdf"
# IEEE's resubmission checklist asks for supplementary material "uploaded as
# a .zip file"; the same PDF, zipped, for the portal slot that wants one.
( cd "$OUT" && rm -f supplement.zip && zip -q -X supplement.zip supplement.pdf )
echo "supplement: $OUT/supplement.pdf ($SUPP_FLAT) and $OUT/supplement.zip"

# 4b. The response letter and the cover letter point at tables, sections and
#     references by number and quote generated figures. Their placeholders are
#     filled here from THIS build (its .aux, the generated macros, and the
#     checker's readability statistics), so neither letter can describe an
#     older manuscript. An unknown label or macro stops the pack.
python3 scripts/resolve-response-refs.py paper/ieee/response.md "$OUT/response-resolved.md" --aux "$OUT/src/main.aux" --supp-aux "$OUT/supp/supplement.aux" --base-tag "$DIFF_BASE_TAG"
mkdir -p "$OUT/cover"
python3 scripts/resolve-response-refs.py paper/ieee/cover-letter.tex "$OUT/cover/cover-letter.tex" --tex --aux "$OUT/src/main.aux" --supp-aux "$OUT/supp/supplement.aux" --base-tag "$DIFF_BASE_TAG"

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
( cd "$OUT/cover" && pdflatex -interaction=nonstopmode cover-letter.tex >/dev/null 2>&1 && pdflatex -interaction=nonstopmode cover-letter.tex >/dev/null 2>&1 ) \
  && cp "$OUT/cover/cover-letter.pdf" "$OUT/cover-letter.pdf"
echo "cover letter: $OUT/cover-letter.pdf ($(/usr/bin/grep -o 'Output written on cover-letter.pdf ([0-9]* pages\?' "$OUT/cover/cover-letter.log" | /usr/bin/grep -o '[0-9]* pages\?'))"
# The letter is written to fit one page; an edit that spills the signature
# onto a second page should stop the build, not ship.
COVER_PAGES=$(pdfinfo "$OUT/cover-letter.pdf" | /usr/bin/awk '/^Pages:/ {print $2}')
[ "$COVER_PAGES" = "1" ] || { echo "cover letter runs to $COVER_PAGES pages; trim it to one"; exit 1; }
echo "packed: $OUT/manuscript.pdf ($PAGES_FLAT), $OUT/source.zip ($(du -h "$OUT/source.zip" | cut -f1); flat, with main.bbl and main.pdf)"

# 7. Resubmission deliverables (IEEE Access reject-with-resubmission): the
#    point-by-point response to reviewers rendered from paper/ieee/response.md,
#    and a "Highlighted PDF" with every change marked, built by latexdiff
#    against the source submitted under the git tag DIFF_BASE_TAG: the version
#    the reviewers last saw. The article and the Supplementary Material are
#    compared separately, and the uploaded file is the one followed by the
#    other.
if [ -f paper/ieee/response.md ]; then
  pandoc "$OUT/response-resolved.md" -o "$OUT/response-to-reviewers.docx"
  # xurl lets a long URL break at any character, so none runs into the margin.
  pandoc "$OUT/response-resolved.md" -o "$OUT/response-to-reviewers.pdf" --pdf-engine=pdflatex \
    -V geometry:margin=1in -V fontsize=11pt -V colorlinks=true -V header-includes='\usepackage{xurl}'
  echo "response: $OUT/response-to-reviewers.docx and .pdf"
fi
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
  # The tag's article and supplement are built once, so that its references
  # to the supplement resolve to the text the reviewers read, exactly as the
  # new side's do (step 3); otherwise every "Appendix D" would compare as a
  # change against an unresolved reference.
  OLDROOT="$OUT/diff-base"
  rm -rf "$OLDROOT" && mkdir -p "$OLDROOT"
  git archive "$DIFF_BASE_TAG" paper | tar -x -C "$OLDROOT"
  if [ -f "$OLDROOT/paper/ieee/supplement.tex" ]; then
    ( cd "$OLDROOT/paper/ieee" && latexmk -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1; \
      latexmk -g -pdf -interaction=nonstopmode -f supplement.tex >/dev/null 2>&1; \
      latexmk -g -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1 ) || true
    [ -f "$OLDROOT/paper/ieee/supplement.aux" ] && [ -f "$OLDROOT/paper/ieee/main.aux" ] \
      || { echo "the base tag's article and supplement could not be built"; exit 1; }
  fi
  sed -e 's#\\input{\.\./#\\input{#g' -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' \
    "$OLDROOT/paper/ieee/main.tex" > "$OUT/diff/old/main.tex"
  cp "$OLDROOT/paper/body.tex" "$OLDROOT/paper/macros.tex" "$OLDROOT/paper/figdata.tex" \
    $(tables_of "$OLDROOT/paper/body.tex" | sed "s#^paper/#$OLDROOT/paper/#") "$OUT/diff/old/"
  if [ -f "$OLDROOT/paper/ieee/supplement.aux" ]; then
    python3 scripts/resolve-supp-refs.py "$OLDROOT/paper/ieee/supplement.aux" "$OUT/diff/old/main.tex" "$OUT/diff/old/body.tex"
  fi
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
  # latexdiff marks up inside the prose gates and breaks them. Resolve the
  # gates with each copy's own macro values, so the diff shows what actually
  # prints, and substitute every generated macro by its value in both copies:
  # a number that changed under an unchanged macro name is a change the
  # reviewer must see in blue, which latexdiff cannot know from the names.
  for d in old new; do
    for f in body.tex main.tex; do
      python3 scripts/resolve-tex-gates.py "$OUT/diff/$d/$f" "$OUT/diff/$d/macros.tex" --expand-macros
    done
  done
  # Bibliography: latexdiff --flatten inlines the main.bbl beside each side's
  # main.tex. Letting it compare the two lists word by word breaks the
  # numbering (a deleted entry keeps a live \bibitem and prints as an empty
  # number; a moved key is defined twice), so the highlighted copy carries the
  # NEW list only, numbered as in the clean copy, with every entry that is
  # new or changed since the tagged submission set in blue as a whole. The
  # old list is rebuilt from the tagged sources for that comparison, and both
  # sides then carry the same marked file.
  git show "$DIFF_BASE_TAG:paper/ieee/refs.bib" > "$OUT/diff/old/refs.bib" 2>/dev/null || cp "$OUT/src/refs.bib" "$OUT/diff/old/refs.bib"
  cp "$OUT"/src/*.cls "$OUT"/src/*.bst "$OUT"/src/*.sty "$OUT"/src/*.pfb "$OUT"/src/*.tfm "$OUT"/src/*.map "$OUT"/src/*.fd "$OUT"/src/*.png "$OUT/diff/old/"
  [ -f "$OUT/src/author-photo.jpg" ] && cp "$OUT/src/author-photo.jpg" "$OUT/diff/" || true
  ( cd "$OUT/diff/old" && latexmk -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1 ) || true
  [ -f "$OUT/diff/old/main.bbl" ] || { echo "old bibliography could not be rebuilt"; exit 1; }
  python3 scripts/mark-bbl-changes.py "$OUT/diff/old/main.bbl" "$OUT/src/main.bbl" "$OUT/diff/new/main.bbl"
  cp "$OUT/diff/new/main.bbl" "$OUT/diff/old/main.bbl"
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
  python3 scripts/latexdiff-postprocess.py "$OUT/diff/main.tex" "$OUT/diff/old/main.tex" "$OUT/diff/new/main.tex"
  # Compile the diff beside the vendored template files.
  cp "$OUT"/src/*.cls "$OUT"/src/*.bst "$OUT"/src/*.sty "$OUT"/src/*.pfb "$OUT"/src/*.tfm "$OUT"/src/*.map "$OUT"/src/*.fd "$OUT"/src/*.png "$OUT/src/refs.bib" "$OUT/diff/"
  ( cd "$OUT/diff" && latexmk -pdf -interaction=nonstopmode -f main.tex >/dev/null 2>&1 ) || true
  DIFF_ERRORS=$(/usr/bin/grep -c '^!' "$OUT/diff/main.log" 2>/dev/null || true)
  if [ -f "$OUT/diff/main.pdf" ] && [ "${DIFF_ERRORS:-1}" = "0" ]; then
    # The diff marks changes in blue text. IEEE asks for yellow highlighting,
    # which no pdfTeX highlighter survives on this class, so the highlight is
    # laid under the blue text on the finished pages (the page content is
    # embedded unchanged; the checks below run on the result).
    python3 scripts/highlight-yellow.py "$OUT/diff/main.pdf" "$OUT/highlighted.pdf"
    echo "highlighted: $OUT/highlighted.pdf ($(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' "$OUT/diff/main.log" | /usr/bin/grep -o '[0-9]* pages\?'); diff base $DIFF_BASE_TAG)"
  else
    echo "highlighted PDF FAILED: $DIFF_ERRORS TeX errors in $OUT/diff/main.log"; exit 1
  fi
  # The highlighted copy must read as the clean copy: same page count, no
  # doubly defined labels, the same citation numbers in the same
  # multiplicity, and no empty reference entry (each of which happened once).
  MULT=$(/usr/bin/grep -c 'multiply defined' "$OUT/diff/main.log" || true)
  [ "$MULT" = "0" ] || { echo "highlighted build has $MULT multiply-defined labels"; exit 1; }
  python3 - "$OUT/manuscript.pdf" "$OUT/highlighted.pdf" <<'PY'
import re, subprocess, sys
def text(pdf):
    return subprocess.run(["pdftotext", pdf, "-"], check=True, capture_output=True, text=True).stdout
clean, marked = text(sys.argv[1]), text(sys.argv[2])
pages = lambda t: t.count("\f")
if pages(clean) != pages(marked):
    sys.exit(f"highlighted copy has {pages(marked)} pages against {pages(clean)}")
cites = lambda t: sorted(re.findall(r"\[(\d+)\]", t))
if cites(clean) != cites(marked):
    sys.exit("highlighted copy's citation numbers differ from the clean copy's")
# A section number alone on a line is a heading whose title was dropped.
bare = lambda t: sorted(re.findall(r"^[IVX]+\.$", t, flags=re.M))
if bare(clean) != bare(marked):
    sys.exit(f"highlighted copy prints bare section numbers the clean copy does not: {bare(marked)} against {bare(clean)}")
# The same for a run-in heading: its letter alone on a line.
bare_letter = lambda t: sorted(re.findall(r"^[a-z]:$", t, flags=re.M))
if bare_letter(clean) != bare_letter(marked):
    sys.exit(f"highlighted copy prints bare run-in letters the clean copy does not: {bare_letter(marked)} against {bare_letter(clean)}")
# An empty entry is a label followed directly by the next label (a label
# alone on its line is normal when its text is set in another colour).
lines = [l.strip() for l in marked.splitlines() if l.strip()]
blank = [l for i, l in enumerate(lines[:-1]) if re.fullmatch(r"\[\d+\]", l) and re.match(r"\[\d+\]", lines[i + 1])]
if blank:
    sys.exit(f"highlighted copy has {len(blank)} empty reference entries: {' '.join(blank)}")
print("highlighted copy checked: pages, citation numbers, and reference entries match the clean copy")
PY
  # 7b. The Supplementary Material, compared with the base tag's in the same
  #     way. It reads the article's labels and reference numbers through xr:
  #     each side from its own article's .aux, the diff from this package's.
  if [ -f "$OLDROOT/paper/ieee/supplement.tex" ]; then
    D="$OUT/diff-supp"
    rm -rf "$D" && mkdir -p "$D/old" "$D/new"
    sed -e 's#\\input{\.\./#\\input{#g' -e 's#\\newcommand{\\paperroot}{\.\.}#\\newcommand{\\paperroot}{.}#' \
      "$OLDROOT/paper/ieee/supplement.tex" > "$D/old/supplement.tex"
    cp "$OLDROOT/paper/appendix.tex" "$OLDROOT/paper/macros.tex" "$OLDROOT/paper/figdata.tex" \
      $(tables_of "$OLDROOT/paper/appendix.tex" | sed "s#^paper/#$OLDROOT/paper/#") "$D/old/"
    cp "$OUT"/supp/*.tex "$D/new/"
    rm -f "$D/new/main.aux"
    for d in old new; do
      sed -i '' -e 's#\\input{\\paperroot/#\\input{#g' "$D/$d/appendix.tex"
      for f in appendix.tex supplement.tex; do
        python3 scripts/resolve-tex-gates.py "$D/$d/$f" "$D/$d/macros.tex" --expand-macros
      done
    done
    if ! "$PERL" "$LATEXDIFF" --flatten --math-markup=0 \
        --preamble=paper/ieee/latexdiff-highlight.tex \
        --config "PICTUREENV=(?:picture|DIFnomarkup|tikzpicture|axis|algorithmic|tabular)[\\w\\d*@]*" \
        --config "FLOATENV=(?:figure|table|plate|algorithm)[\\w\\d*@]*" \
        --exclude-safecmd=Description \
        "$D/old/supplement.tex" "$D/new/supplement.tex" > "$D/supplement.tex" 2> "$D/latexdiff.log"; then
      echo "latexdiff of the supplement FAILED (see $D/latexdiff.log)"; exit 1
    fi
    python3 scripts/latexdiff-postprocess.py "$D/supplement.tex" "$D/old/supplement.tex" "$D/new/supplement.tex"
    cp "$OUT"/supp/*.cls "$OUT"/supp/*.sty "$OUT"/supp/*.pfb "$OUT"/supp/*.tfm "$OUT"/supp/*.map "$OUT"/supp/*.fd "$OUT"/supp/*.png "$D/"
    # The flattened article's .aux, kept beside the supplement in step 4 (the
    # article's own build directory is cleaned in step 5).
    cp "$OUT/supp/main.aux" "$D/main.aux"
    ( cd "$D" && latexmk -pdf -interaction=nonstopmode -f supplement.tex >/dev/null 2>&1 ) || true
    SUPP_DIFF_ERRORS=$(/usr/bin/grep -c '^!' "$D/supplement.log" 2>/dev/null || true)
    [ -f "$D/supplement.pdf" ] && [ "${SUPP_DIFF_ERRORS:-1}" = "0" ] \
      || { echo "highlighted supplement FAILED: $SUPP_DIFF_ERRORS TeX errors in $D/supplement.log"; exit 1; }
    [ "$(/usr/bin/grep -c 'multiply defined' "$D/supplement.log" || true)" = "0" ] \
      || { echo "highlighted supplement has multiply-defined labels"; exit 1; }
    [ "$(/usr/bin/grep -c 'Citation.*undefined\|Reference.*undefined' "$D/supplement.log" || true)" = "0" ] \
      || { echo "highlighted supplement has undefined citations or references"; exit 1; }
    python3 scripts/highlight-yellow.py "$D/supplement.pdf" "$OUT/highlighted-supplement.pdf"
    python3 - "$OUT/supplement.pdf" "$OUT/highlighted-supplement.pdf" <<'PY'
import re, subprocess, sys
def text(pdf):
    return subprocess.run(["pdftotext", pdf, "-"], check=True, capture_output=True, text=True).stdout
clean, marked = text(sys.argv[1]), text(sys.argv[2])
if clean.count("\f") != marked.count("\f"):
    sys.exit(f"highlighted supplement has {marked.count(chr(12))} pages against {clean.count(chr(12))}")
cites = lambda t: sorted(re.findall(r"\[(\d+)\]", t))
if cites(clean) != cites(marked):
    sys.exit("highlighted supplement's citation numbers differ from the clean supplement's")
heads = lambda t: sorted(re.findall(r"^APPENDIX [A-Z]\b", t, flags=re.M))
if heads(clean) != heads(marked):
    sys.exit(f"highlighted supplement's appendix headings differ: {heads(marked)} against {heads(clean)}")
print("highlighted supplement checked: pages, citation numbers, and appendix headings match the clean supplement")
PY
    mv "$OUT/highlighted.pdf" "$OUT/highlighted-article.pdf"
    pdfunite "$OUT/highlighted-article.pdf" "$OUT/highlighted-supplement.pdf" "$OUT/highlighted.pdf"
    echo "highlighted: $OUT/highlighted.pdf = the article ($(pdfinfo "$OUT/highlighted-article.pdf" | /usr/bin/awk '/^Pages:/ {print $2}') pages) followed by the Supplementary Material ($(pdfinfo "$OUT/highlighted-supplement.pdf" | /usr/bin/awk '/^Pages:/ {print $2}') pages)"
  fi
else
  echo "highlighted PDF skipped (latexdiff or tag $DIFF_BASE_TAG missing)"
fi
# 8. The upload checklist, regenerated from this build (sizes, digests, page
#    counts, and the abstract to paste) so that it cannot describe an older one.
python3 scripts/gen-resubmission-checklist.py "$OUT"
