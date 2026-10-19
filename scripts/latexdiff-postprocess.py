#!/usr/bin/env python3
"""Post-process a latexdiff output for the highlighted copy of the IEEE
Access submission (the article or its Supplementary Material).

Usage: latexdiff-postprocess.py DIFF.tex OLD.tex NEW.tex

Restores plain \\DIFadd/\\DIFdel definitions, marks the article's roadmap
paragraph (a preamble macro latexdiff does not compare), colours added or
regenerated blocks (table bodies, figures, the algorithm), marks lone numbers
and added displays, drops deleted headings, colours replotted figures, and
stops if a changed table body would print outside every blue scope. Moved
here from scripts/pack-ieee-submission.sh so that both documents get the
same treatment.
"""
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
# lines latexdiff keeps between the comment lines of a deleted block (a
# deleted float, or the paragraph breaks around one) would still break the
# paragraph the new text continues. A blank line with deleted-command lines
# on both sides lies inside such a block; one next to surviving text is a
# real paragraph break and stays.
s = re.sub(r"(%DIFDELCMD < [^\n]*\n)\n+(?=%DIFDELCMD < |%DIF < |\{?%DIFAUXCMD)", r"\1", s)
# A float whose text did not change can still come out of latexdiff as
# deleted in one place and added in another, when the text around it was
# rewritten: it then prints as wholly new. Compare each float of the diff,
# with its markup resolved to the new text, against the floats of the old
# source; one that matches an old float exactly is unchanged and is restored
# without markup, so the highlighted copy marks only what changed.
import os as _os


def _flatten(path, depth=0):
    """The source with its \\input files inlined, as latexdiff --flatten does."""
    src = open(path).read()
    if depth > 8:
        return src
    base = _os.path.dirname(path)

    def inline(m):
        name = m.group(1)
        cand = _os.path.join(base, name if name.endswith(".tex") else name + ".tex")
        return _flatten(cand, depth + 1) if _os.path.exists(cand) else m.group(0)

    return re.sub(r"\\input\{([^}]+)\}", inline, src)


def _skip_group(text, i):
    """Index just past the brace group that opens at text[i] == '{'."""
    depth = 0
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


def _resolve_markup(text):
    """The new text of a marked-up block: additions kept, deletions dropped."""
    text = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith("%DIF"))
    text = re.sub(r"\\DIFdelbegin(FL)?\b.*?\\DIFdelend(FL)?\b", "", text, flags=re.S)
    out = []
    i = 0
    while i < len(text):
        m = re.compile(r"\\DIF(add|del)(FL)?\{").match(text, i)
        if m:
            end = _skip_group(text, m.end() - 1)
            if m.group(1) == "add":
                out.append(text[m.end():end - 1])
            i = end
            continue
        out.append(text[i])
        i += 1
    text = "".join(out)
    text = re.sub(r"\\DIF(add|del)(begin|end)(FL)?\b ?", "", text)
    return text


def _norm(text):
    text = "\n".join(l.split("%")[0] if not l.lstrip().startswith("%") else "" for l in text.split("\n"))
    return re.sub(r"\s+", "", text)


FLOAT_RE = r"((?<!%DIFDELCMD < )\\begin\{(table\*?|figure\*?)\}(\[[^\]]*\])?)(?P<body>.*?)((?<!%DIFDELCMD < )\\end\{\2\})"
_old_floats = set()
if _os.path.exists(sys.argv[2]):
    for m in re.finditer(FLOAT_RE, _flatten(sys.argv[2]), flags=re.S):
        _old_floats.add(_norm(m.group(0)))
restored = []


def _restore_unchanged(m):
    block = m.group(0)
    if "\\DIF" not in block:
        return block
    resolved = _resolve_markup(block)
    if _norm(resolved) in _old_floats:
        label = re.search(r"\\label\{([^}]+)\}", resolved)
        restored.append(label.group(1) if label else resolved[:40])
        return resolved
    return block


s = re.sub(FLOAT_RE, _restore_unchanged, s, flags=re.S)
if restored:
    print("unchanged floats printed without markup: " + ", ".join(restored))
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
# latexdiff keeps a deleted heading as a command with an empty title, which
# prints a bare section number; with deletions omitted it must print nothing.
# Drop it wherever it sits (at the start of a deletion block or inside one,
# as when a renamed heading's old title is deleted with the text after it).
# A heading deleted and then added again under the same title has only moved
# relative to a float, so that title is not marked; a renamed heading's new
# title stays marked as added.
moved_headings = set()
def drop_deleted_heading(m):
    moved_headings.add(m.group(3))
    return m.group(1) or ""
s = re.sub(
    r"(\\DIFdelbegin )?\\(section|subsection)\{\\DIFdel\{(.*?)\}\}\s*%DIFAUXCMD\s*\\addtocounter\{\2\}\{-1\}%DIFAUXCMD\n",
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
# The letters say every changed table body is highlighted. Stop if a changed
# tabular is outside every blue scope: neither its float is coloured from the
# start nor an open {\color{blue} group contains it.
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
    # A table body latexdiff left unmarked is unchanged since the base
    # version and prints black, as it should. A changed body sits inside an
    # added block (\DIFaddbegin opened before the tabular and not yet
    # closed), and that one must be blue.
    if head.rfind("\\DIFaddbegin") <= head.rfind("\\DIFaddend"):
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
    sys.exit("highlighted copy: changed table bodies outside every blue scope: " + ", ".join(uncovered))
open(p, "w").write(s)
