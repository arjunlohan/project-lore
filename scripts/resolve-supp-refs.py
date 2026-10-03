#!/usr/bin/env python3
"""Replace references to labels of the Supplementary Material by their text.

The IEEE Access article (paper/ieee/main.tex) leaves its appendices to a
separate Supplementary Material (paper/ieee/supplement.tex) and reads that
document's labels through xr. The shipped source must compile on its own,
without the supplement's .aux, so the packager runs this script on the
flattened copies: every \\ref, \\secref, and \\figref whose label the
supplement defines becomes the text LaTeX printed for it ("D", "S3"), with
the shell's own wording for \\secref ("Section~") and \\figref ("Fig.~"), and
the xr lines leave the shell. Labels of the article itself are untouched.

Usage: resolve-supp-refs.py SUPPLEMENT_AUX FILE [FILE ...]
"""
import re
import sys

aux = open(sys.argv[1]).read()
labels = {}
for m in re.finditer(r"\\newlabel\{([^}]+)\}\{\{((?:[^{}]|\{[^{}]*\})*)\}", aux):
    labels[m.group(1)] = re.sub(r"\\mbox\s*\{([^}]*)\}", r"\1", m.group(2)).strip()
if not labels:
    sys.exit(f"{sys.argv[1]} defines no labels; build the supplement first")

WORDING = {"ref": "{}", "secref": "Section~{}", "figref": "Fig.~{}"}
count = 0


def replace(m):
    global count
    cmd, label = m.group(1), m.group(2)
    if label not in labels:
        return m.group(0)
    count += 1
    return WORDING[cmd].format(labels[label])


for path in sys.argv[2:]:
    src = open(path).read()
    src = re.sub(r"\\(ref|secref|figref)\{([^}]+)\}", replace, src)
    src = re.sub(r"^\\usepackage\{xr-hyper\}\n", "", src, flags=re.M)
    src = re.sub(r"^\\externaldocument\{supplement\}\n", "", src, flags=re.M)
    if "\\externaldocument" in src:
        sys.exit(f"{path} still reads an external document")
    open(path, "w").write(src)
print(f"resolved {count} references to the Supplementary Material")
