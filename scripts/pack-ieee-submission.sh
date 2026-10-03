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
   paper/tabledeploymp.tex paper/tablefampairs.tex paper/tableboundsgrid.tex \
   paper/tabledependence.tex paper/tablestrict.tex paper/tablebudgets.tex paper/tableboundary.tex \
   paper/tablestrata.tex \
   "$OUT/src/"
# The prose gates optional studies on \ifnum<macro>=1\relax ... \else ... \fi;
# the shipped source carries only the branch that prints, so nobody editing
# it at the publisher meets dead text. Macros stay macros here.
python3 scripts/resolve-tex-gates.py "$OUT/src/body.tex" "$OUT/src/macros.tex"
# 3. Vendored template (class, bst, fonts, maps, fd, logos) and the IEEE bib.
cp paper/ieee/ieeeaccess.cls paper/ieee/IEEEtran.cls paper/ieee/IEEEtran.bst paper/ieee/spotcolor.sty \
   paper/ieee/t1-*.pfb paper/ieee/t1-*.tfm paper/ieee/t1-*.map paper/ieee/t1*.fd \
   paper/ieee/logo.png paper/ieee/notaglinelogo.png paper/ieee/bullet.png \
   paper/ieee/refs.bib "$OUT/src/"
# The author photograph is optional in the source tree: the biography is set
# with it when the file exists and without it otherwise (main.tex decides).
PHOTO=paper/ieee/author-photo.jpg
if [ -f "$PHOTO" ]; then cp "$PHOTO" "$OUT/src/"; echo "author photo: included"; else echo "author photo: NOT included ($PHOTO is missing; IEEE's resubmission checklist asks for one)"; fi

# 4. Compile the flattened copy exactly as the portal's referees would.
( cd "$OUT/src" && latexmk -pdf -interaction=nonstopmode main.tex >/dev/null 2>&1 )
ERRORS=$(/usr/bin/grep -c '^!' "$OUT/src/main.log" || true)
[ "$ERRORS" = "0" ] || { echo "flattened build has $ERRORS TeX errors"; exit 1; }
PAGES_FLAT=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' "$OUT/src/main.log" | /usr/bin/grep -o '[0-9]* pages')
PAGES_TREE=$(/usr/bin/grep -o 'Output written on main.pdf ([0-9]* pages\?' paper/ieee/main.log | /usr/bin/grep -o '[0-9]* pages')
[ "$PAGES_FLAT" = "$PAGES_TREE" ] || { echo "page count differs: flat=$PAGES_FLAT tree=$PAGES_TREE"; exit 1; }
UNDEF=$(/usr/bin/grep -c 'Citation.*undefined\|Reference.*undefined' "$OUT/src/main.log" || true)
[ "$UNDEF" = "0" ] || { echo "$UNDEF undefined citations/references"; exit 1; }

# 4b. The response letter and the cover letter point at tables, sections and
#     references by number and quote generated figures. Their placeholders are
#     filled here from THIS build (its .aux, the generated macros, and the
#     checker's readability statistics), so neither letter can describe an
#     older manuscript. An unknown label or macro stops the pack.
python3 scripts/resolve-response-refs.py paper/ieee/response.md "$OUT/response-resolved.md" --aux "$OUT/src/main.aux"
mkdir -p "$OUT/cover"
python3 scripts/resolve-response-refs.py paper/ieee/cover-letter.tex "$OUT/cover/cover-letter.tex" --tex --aux "$OUT/src/main.aux"

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
#    against the source submitted under the git tag DIFF_BASE_TAG.
if [ -f paper/ieee/response.md ]; then
  pandoc "$OUT/response-resolved.md" -o "$OUT/response-to-reviewers.docx"
  pandoc "$OUT/response-resolved.md" -o "$OUT/response-to-reviewers.pdf" --pdf-engine=pdflatex \
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
  python3 - "$OUT/diff/main.tex" "$OUT/diff/old/main.tex" "$OUT/diff/new/main.tex" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
# The roadmap paragraph lives in a preamble macro of the shell, which latexdiff
# does not compare. Diff the two definitions token by token here and wrap the
# added tokens in \DIFadd, so the highlighted copy marks that paragraph too.
import difflib
def definition(src, name):
    start = src.find("\\newcommand{\\" + name + "}{")
    if start < 0:
        return None
    i = start + len("\\newcommand{\\" + name + "}{")
    depth = 1
    j = i
    body = []
    while j < len(src) and depth:
        c = src[j]
        if c == "%" and src[j - 1] != "\\":
            # a TeX comment (latexdiff leaves %DIF markers here); skip it
            j = src.find("\n", j)
            if j < 0:
                j = len(src)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if depth:
            body.append(c)
        j += 1
    return "".join(body), start, j
old_def = definition(open(sys.argv[2]).read(), "venueroadmap")
new_def = definition(open(sys.argv[3]).read(), "venueroadmap")
if old_def and new_def:
    a = old_def[0].split()
    b = new_def[0].split()
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            out.extend(b[j1:j2])
        elif tag in ("insert", "replace"):
            out.append("\\DIFadd{" + " ".join(b[j1:j2]) + "}")
    marked = " ".join(out)
    cur = definition(s, "venueroadmap")
    if cur:
        s = s[: cur[1]] + "\\newcommand{\\venueroadmap}{" + marked + "}" + s[cur[2] :]
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
# Blocks latexdiff compares as wholes (table bodies, the figures, the
# algorithm) carry only the empty \DIFaddbegin markers, so an added block
# would print black. Colour them: a float whose caption is entirely new is
# a new float and is set in blue throughout (the colour goes inside the
# float, where the float box is built); a replaced block inside an existing
# float is wrapped in a colour group of its own.
def colour_float(m):
    head, body, tail = m.group(1), m.group("body"), m.group(5)
    if re.search(r"\\caption\{\\DIFaddFL\{", body) and not re.search(r"\\DIFdel", body):
        return head + r"\color{blue}" + body + tail
    body = re.sub(
        # Size, column-spacing, and row-spacing commands, and the generator's
        # comment lines, may sit between the marker and the tabular. The
        # marker is \DIFaddbeginFL inside a float, or the plain \DIFaddbegin
        # when latexdiff aligned the new block with a deleted float.
        r"\\DIFaddbegin(FL)? ((?:(?:\\(?:scriptsize|footnotesize|small|tiny|centering)\b|\\setlength\{\\tabcolsep\}\{[^}]*\}|\\renewcommand\{\\arraystretch\}\{[^}]*\})\s*|%[^\n]*\n\s*)*(?:\\begin\{tabular\}|\\begin\{tikzpicture\}|\\resizebox))(.*?)\\DIFaddend(FL)?",
        lambda k: "\\DIFaddbegin" + (k.group(1) or "") + " {\\color{blue}" + k.group(2) + k.group(3) + "}\\DIFaddend" + (k.group(4) or ""),
        body,
        flags=re.S,
    )
    return head + body + tail
# A float's begin and end lines that latexdiff kept as comments of deleted
# text (%DIFDELCMD < ...) are not floats: matching them pairs a deleted
# figure's begin with its end and swallows the new float between them.
s = re.sub(
    r"((?<!%DIFDELCMD < )\\begin\{(table\*?|figure\*?|algorithm)\}(\[[^\]]*\])?)(?P<body>.*?)((?<!%DIFDELCMD < )\\end\{\2\})",
    colour_float,
    s,
    flags=re.S,
)
# A lone number that latexdiff matched between a deletion and an addition
# is the same digits meaning something else (a changed sentence whose old
# and new values coincide); mark it as changed rather than let it print
# black between blue neighbours.
s = re.sub(r"(\\DIFaddend )(\d[\d.,{}]*(?:\\%)?)(\\DIFdelbegin )", r"\1\\DIFadd{\2}\3", s)
s = re.sub(r"(\\DIFdelend )(\d[\d.,{}]*(?:\\%)?)(\\DIFaddbegin )", r"\1\\DIFadd{\2}\3", s)
# Displayed math is excluded from markup; a display sitting between two
# added text spans is itself added, so colour it.
s = re.sub(
    r"(\}\s*)(\\begin\{equation\}.*?\\end\{equation\}|\\\[.*?\\\])(\s*\\DIFadd\{)",
    # \ignorespaces: TeX skips one space after a display, but the closing
    # brace of the colour group hides the line end from that rule.
    lambda m: m.group(1) + r"{\color{blue}" + m.group(2) + r"}\ignorespaces" + m.group(3),
    s,
    flags=re.S,
)
# A heading that latexdiff reports as deleted and then added again has only
# moved relative to a float. latexdiff keeps a deleted heading as a command
# with an empty title, which prints a bare section number; with deletions
# omitted it must print nothing, and the unchanged title must not be marked.
moved_headings = set()
def drop_deleted_heading(m):
    moved_headings.add(m.group(2))
    return r"\DIFdelbegin "
s = re.sub(
    r"\\DIFdelbegin \\(section|subsection)\{\\DIFdel\{(.*?)\}\}\s*%DIFAUXCMD\s*\\addtocounter\{\1\}\{-1\}%DIFAUXCMD\n",
    drop_deleted_heading,
    s,
)
for title in moved_headings:
    for level in ("section", "subsection"):
        s = s.replace("\\" + level + "{\\DIFadd{" + title + "}}", "\\" + level + "{" + title + "}")
if re.search(r"\\(section|subsection)\{\\DIFdel\{", s):
    sys.exit("a deleted heading survives in the highlighted source and would print a bare number")
# A deleted run-in heading is kept the same way, as a \paragraph with an
# empty title, and prints its bare letter. Remove it together with the
# counter correction latexdiff writes after it.
s = re.sub(r"\\paragraph\{\\DIFdel\{.*?\}\}\s*%DIFAUXCMD\s*\\addtocounter\{paragraph\}\{-1\}%DIFAUXCMD\n", "", s)
if re.search(r"\\paragraph\{\\DIFdel\{", s):
    sys.exit("a deleted run-in heading survives in the highlighted source and would print a bare letter")
# A figure whose plot data comes from a macro of figdata.tex is textually
# unchanged when only the data changed. If that macro's definition differs
# between the two submissions the figure was replotted, so colour it.
import os
def plot_macros(path):
    out = {}
    if os.path.exists(path):
        for line in open(path):
            k = re.match(r"\\newcommand\{\\(\w+)\}\{(.*)\}\s*$", line)
            if k:
                out[k.group(1)] = k.group(2)
    return out
old_plots = plot_macros(os.path.join(os.path.dirname(sys.argv[2]), "figdata.tex"))
new_plots = plot_macros(os.path.join(os.path.dirname(sys.argv[3]), "figdata.tex"))
replotted = [n for n in new_plots if old_plots.get(n) != new_plots[n]]
def colour_replotted(m):
    body = m.group("body")
    if "%DIFDELCMD" in body or r"\color{blue}" in body or not any(("\\" + n) in body for n in replotted):
        return m.group(0)
    body = re.sub(
        r"(\\begin\{tikzpicture\}.*?\\end\{tikzpicture\})",
        lambda k: r"{\color{blue}" + k.group(1) + "}",
        body,
        count=1,
        flags=re.S,
    )
    return m.group(1) + body + m.group(5)
s = re.sub(
    r"((?<!%DIFDELCMD < )\\begin\{(figure\*?)\}(\[[^\]]*\])?)(?P<body>.*?)((?<!%DIFDELCMD < )\\end\{\2\})",
    colour_replotted,
    s,
    flags=re.S,
)
# The letters say every table body is highlighted. Stop if a tabular is
# outside every blue scope: neither its float is coloured from the start nor
# an open {\color{blue} group contains it.
uncovered = []
# (a tabular after a % on its line is deleted text, kept as a comment)
for m in re.finditer(r"^[^%\n]*?\\begin\{tabular\}", s, flags=re.M):
    pos = m.end()
    start = max(s.rfind("\\begin{table}", 0, pos), s.rfind("\\begin{table*}", 0, pos))
    if start < 0:
        continue
    head = s[start:pos]
    if re.match(r"\\begin\{table\*?\}(\[[^\]]*\])?\\color\{blue\}", head):
        continue
    covered = False
    for g in re.finditer(r"\{\\color\{blue\}", head):
        rest = re.sub(r"\\[{}]", "", head[g.start():])
        rest = "\n".join(l.split("%")[0] for l in rest.split("\n"))
        if rest.count("{") - rest.count("}") > 0:
            covered = True
    if not covered:
        label = re.search(r"\\label\{([^}]+)\}", s[start:start + 4000])
        uncovered.append(label.group(1) if label else s[start:start + 60])
if uncovered:
    sys.exit("highlighted copy: table bodies outside every blue scope: " + ", ".join(uncovered))
open(p, "w").write(s)
PY
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
else
  echo "highlighted PDF skipped (latexdiff or tag $DIFF_BASE_TAG missing)"
fi
# 8. The upload checklist, regenerated from this build (sizes, digests, page
#    counts, and the abstract to paste) so that it cannot describe an older one.
python3 scripts/gen-resubmission-checklist.py "$OUT"
