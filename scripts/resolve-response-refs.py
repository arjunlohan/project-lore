#!/usr/bin/env python3
"""Resolve the placeholders of a companion document (the response to
reviewers, the cover letter) against the manuscript build it describes.

The response letter points at tables, sections, appendices, and references
by number, and quotes figures the manuscript generates. Typed by hand, those
go stale whenever the manuscript moves: a table added in Section VIII
renumbers every appendix table, and a regenerated artifact changes a figure
that the letter still quotes at its old value. Each has happened. The letters
therefore carry placeholders, and this script fills them from the same build
that produced the manuscript:

  {{ref:LABEL}}    the number LaTeX assigned to \\label{LABEL} (a table,
                   figure, section, appendix, assumption, or theorem), read
                   from the build's .aux file
  {{page:LABEL}}   the page that label falls on (.aux)
  {{cite:KEY}}     the reference number of bibliography key KEY (.aux)
  {{m:NAME}}       the value of the generated macro \\NAME (paper/macros.tex)
  {{stat:KEY}}     a readability statistic printed by the manuscript's own
                   checker, for this manuscript (now.*, main.*) or for the
                   first submission (v1.*), which is read from its git tag;
                   {{stat:pages}} is the build's page count (.aux) and
                   {{stat:refs}} its number of references (.aux)
  {{assert:stat:KEY=VALUE}}  prints nothing; stops the run if the statistic
                   no longer has that value
  {{assert:less:KEY:KEY}}    prints nothing; stops the run unless the first
                   statistic is smaller than the second (for a sentence that
                   says "fewer")

An unknown label, key, macro, or statistic stops the run, so a letter cannot
ship pointing at something the manuscript no longer has.

Usage:
  resolve-response-refs.py IN OUT [--tex] [--aux FILE] [--macros FILE]
                                  [--base-tag TAG]
--tex keeps macro values as TeX (for the cover letter); the default strips
TeX for Markdown.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("out")
ap.add_argument("--tex", action="store_true")
ap.add_argument("--aux", default="paper/ieee/main.aux")
ap.add_argument("--macros", default="paper/macros.tex")
ap.add_argument("--base-tag", default="ieee-access-submission-v1")
args = ap.parse_args()

text = open(args.src).read()
aux = open(args.aux).read()
macro_tex = open(args.macros).read()

labels = {}
pages = {}
for m in re.finditer(r"\\newlabel\{([^}]+)\}\{\{((?:[^{}]|\{[^{}]*\})*)\}\{((?:[^{}]|\{[^{}]*\})*)\}", aux):
    value = re.sub(r"\\mbox\s*\{([^}]*)\}", r"\1", m.group(2)).strip()
    labels[m.group(1)] = value
    pages[m.group(1)] = m.group(3).strip()
cites = dict(re.findall(r"\\bibcite\{([^}]+)\}\{(\d+)\}", aux))
last_page = re.search(r"\\@abspage@last\{(\d+)\}", aux)
# Read from the build itself, with no checker run.
build_stats = {"refs": str(len(cites))}
if last_page:
    build_stats["pages"] = last_page.group(1)
macros = dict(re.findall(r"\\newcommand\{\\(\w+)\}\{(.*)\}", macro_tex))


def plain(value):
    """A macro value as plain text for Markdown."""
    v = value.replace("{,}", ",").replace("\\%", "%").replace("\\$", "\\$")
    v = re.sub(r"\$([^$]*)\$", r"\1", v)
    v = v.replace("{=}", "=").replace("\\ ", " ")
    if re.search(r"\\[A-Za-z]", v):
        sys.exit(f"macro value still carries TeX after cleaning: {value!r}")
    return v.replace("{", "").replace("}", "")


STAT_RE = re.compile(
    r"(\d+) sentences, (\d+) words, mean ([\d.]+) words, over 45 words: (\d+) \((\d+)%\), "
    r"over \d+: (\d+); numbers: (\d+) \(([\d.]+) per 100 words\), sentences with three or more: ([\d.]+)%"
)


def stat_block(prefix, line, into):
    m = STAT_RE.search(line)
    if not m:
        sys.exit(f"could not read the checker's statistics line for {prefix}: {line!r}")
    keys = ["sentences", "words", "mean", "over45", "over45pct", "over60", "numbers", "per100", "dense"]
    for k, v in zip(keys, m.groups()):
        into[f"{prefix}.{k}"] = v


stats = None


def load_stats():
    """Run the manuscript's checker on this tree and on the first submission."""
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ)
        for name in ("body.tex", "macros.tex"):
            blob = subprocess.run(
                ["git", "show", f"{args.base_tag}:paper/{name}"], check=True, capture_output=True, text=True
            ).stdout
            open(os.path.join(tmp, name), "w").write(blob)
        env["PROSE_STATS_BODY"] = os.path.join(tmp, "body.tex")
        env["PROSE_STATS_MACROS"] = os.path.join(tmp, "macros.tex")
        res = subprocess.run(["pnpm", "-s", "check:paper"], capture_output=True, text=True, env=env).stdout
    if "PAPER_NUMBERS_OK" not in res:
        sys.exit("the manuscript checker does not pass; fix it before resolving the letters")
    for line in res.splitlines():
        if line.startswith("prose sentences:"):
            stat_block("now", line, out)
        elif line.startswith("main text only:"):
            stat_block("main", line, out)
        elif line.startswith("compared source"):
            stat_block("v1", line, out)
        elif line.startswith("abstract:"):
            m = re.search(r"abstract: (\d+) sentences, longest: (\d+) words", line)
            if m:
                out["abstract.sentences"], out["abstract.longest"] = m.groups()
    for need in ("now.mean", "main.numbers", "v1.mean"):
        if need not in out:
            sys.exit(f"the checker did not print the statistic {need}")
    # Thousands separators, as the letters print counts.
    for k in list(out):
        if k.endswith((".words", ".numbers", ".sentences")) and out[k].isdigit():
            out[k] = f"{int(out[k]):,}"
    return out


missing = []


def resolve(m):
    global stats
    kind, key = m.group(1), m.group(2)
    if kind == "ref":
        if key not in labels:
            missing.append(m.group(0))
            return m.group(0)
        return labels[key]
    if kind == "cite":
        if key not in cites:
            missing.append(m.group(0))
            return m.group(0)
        return cites[key]
    if kind == "m":
        if key not in macros:
            missing.append(m.group(0))
            return m.group(0)
        return macros[key] if args.tex else plain(macros[key])
    if kind == "page":
        if key not in pages:
            missing.append(m.group(0))
            return m.group(0)
        return pages[key]
    if kind == "stat" and key in build_stats:
        return build_stats[key]
    if kind == "stat":
        if stats is None:
            stats = load_stats()
        if key not in stats:
            missing.append(m.group(0))
            return m.group(0)
        return stats[key]
    missing.append(m.group(0))
    return m.group(0)


def check_assert(m):
    """{{assert:stat:KEY=VALUE}} prints nothing and stops the run when the
    statistic no longer has that value, for a sentence that states it in words
    ("none now runs past 45")."""
    global stats
    key, want = m.group(1), m.group(2)
    if key in build_stats:
        have = build_stats[key]
    else:
        if stats is None:
            stats = load_stats()
        have = stats.get(key)
    if have != want:
        sys.exit(f"the letter asserts {key} = {want}, but the build gives {have!r}; rewrite the sentence")
    return ""


def check_less(m):
    """{{assert:less:A:B}} prints nothing and stops the run unless statistic A
    is smaller than statistic B."""
    global stats
    if stats is None:
        stats = load_stats()
    vals = []
    for key in (m.group(1), m.group(2)):
        if key not in stats:
            sys.exit(f"the letter compares the unknown statistic {key}")
        vals.append(float(stats[key].replace(",", "")))
    if not vals[0] < vals[1]:
        sys.exit(f"the letter says {m.group(1)} is smaller than {m.group(2)}, but they are {vals[0]:g} and {vals[1]:g}; rewrite the sentence")
    return ""


text = re.sub(r"\{\{assert:stat:([A-Za-z0-9.]+)=([^}]*)\}\}", check_assert, text)
text = re.sub(r"\{\{assert:less:([A-Za-z0-9.]+):([A-Za-z0-9.]+)\}\}", check_less, text)
resolved = re.sub(r"\{\{(ref|page|cite|m|stat):([A-Za-z0-9_:.\-]+)\}\}", resolve, text)
if missing:
    sys.exit("unresolved placeholders: " + ", ".join(sorted(set(missing))))
left = re.findall(r"\{\{[^}]*\}\}", resolved)
if left:
    sys.exit("malformed placeholders: " + ", ".join(sorted(set(left))))
open(args.out, "w").write(resolved)
n = len(re.findall(r"\{\{(ref|page|cite|m|stat):", text))
print(f"resolved {n} placeholders in {args.src} -> {args.out}")
