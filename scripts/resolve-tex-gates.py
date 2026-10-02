#!/usr/bin/env python3
"""Resolve the prose gates of a LaTeX file in place, and optionally expand
every generated macro to its value.

The shared prose gates optional studies on
    \\ifnum\\<macro>=1\\relax ... \\else ... \\fi
with the macro defined in macros.tex; gates may nest. The shipped source
should carry only the branch that prints (a reader of the source must not
meet dead text), and latexdiff cannot mark up inside such a test at all.
With --expand-macros, every \\newcommand of macros.tex is also substituted
by its value, so that a number which changed under an unchanged macro name
shows as a change.

Usage: resolve-tex-gates.py FILE MACROS_TEX [--expand-macros]
"""
import re
import sys

path, macros = sys.argv[1], sys.argv[2]
expand_macros = "--expand-macros" in sys.argv[3:]
vals = dict(re.findall(r"\\newcommand\{\\(\w+)\}\{(.*)\}", open(macros).read()))
out = open(path).read()

# Innermost gates first: a gate whose branches contain no further \ifnum.
GATE = re.compile(
    r"\\ifnum\\(\w+)=1\\relax((?:(?!\\ifnum).)*?)(?:\\else((?:(?!\\ifnum).)*?))?\\fi",
    re.S,
)


def resolve(m):
    name, yes, no = m.group(1), m.group(2), m.group(3) or ""
    text = yes if vals.get(name, "0").strip() == "1" else no
    src = m.string
    # A gate that occupied its own lines must not leave a blank line behind,
    # which TeX would read as a paragraph break the clean copy does not have.
    if m.start() > 0 and src[m.start() - 1] == "\n" and text.startswith("\n"):
        text = text[1:]
    if text.endswith("\n") and src[m.end() : m.end() + 1] == "\n":
        text = text[:-1]
    return text


while True:
    resolved = GATE.sub(resolve, out)
    if resolved == out:
        break
    out = resolved
if "\\ifnum\\" in out:
    sys.exit(f"{path}: a gate could not be resolved")
if expand_macros:
    names = sorted(vals, key=len, reverse=True)
    if names:
        pat = re.compile(r"\\(" + "|".join(map(re.escape, names)) + r")(\\[ \n]|\{\}|(?=[^A-Za-z]))")

        def expand(m):
            tail = m.group(2)
            return vals[m.group(1)] + (" " if tail.startswith("\\") else "")

        out = pat.sub(expand, out)
open(path, "w").write(out)
