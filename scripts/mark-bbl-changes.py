#!/usr/bin/env python3
"""Mark the reference entries that are new or changed since the first
submission, for the highlighted copy.

latexdiff cannot compare two bibliographies whose order changed: it keeps a
live \\bibitem for every deleted entry (an empty numbered entry) and defines
some keys twice, so the highlighted copy's citation numbers drift away from
the clean copy's. Instead the highlighted copy uses the NEW bibliography
only, with the numbering of the clean copy, and every entry whose key is
absent from the old bibliography, or whose text differs from the old entry,
is set in blue as a whole (a colour group, not a macro argument, so \\url
keeps its catcodes). Both sides of the diff then carry this same file, so
latexdiff has nothing to mark there.

Usage: mark-bbl-changes.py OLD_BBL NEW_BBL OUT_BBL
Prints a one-line summary of what was marked.
"""
import re
import sys

old_path, new_path, out_path = sys.argv[1:4]
ITEM = re.compile(r"\\bibitem\{([^}]*)\}")


def entries(text):
    """Map key -> entry text (after the \\bibitem{key}, up to the next item)."""
    out = {}
    positions = [(m.start(), m.end(), m.group(1)) for m in ITEM.finditer(text)]
    end_marker = text.find(r"\end{thebibliography}")
    for i, (start, end, key) in enumerate(positions):
        stop = positions[i + 1][0] if i + 1 < len(positions) else end_marker
        out[key] = text[end:stop]
    return out


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


old = entries(open(old_path).read()) if old_path and open(old_path).read() else {}
new_text = open(new_path).read()
new = entries(new_text)
changed = [k for k, v in new.items() if k not in old or norm(old[k]) != norm(v)]
added = [k for k in changed if k not in old]


# Open the colour group right after \bibitem{key}; close it at the end of the
# entry's text (before the blank line that separates entries, or before
# \end{thebibliography}).
positions = [(m.start(), m.end(), m.group(1)) for m in ITEM.finditer(new_text)]
end_marker = new_text.find(r"\end{thebibliography}")
pieces = []
cursor = 0
for i, (start, end, key) in enumerate(positions):
    stop = positions[i + 1][0] if i + 1 < len(positions) else end_marker
    body = new_text[end:stop]
    pieces.append(new_text[cursor:end])
    if key in changed:
        stripped = body.rstrip()
        pieces.append("{\\color{blue}" + stripped + "}" + body[len(stripped):])
    else:
        pieces.append(body)
    cursor = stop
pieces.append(new_text[cursor:])
open(out_path, "w").write("".join(pieces))
print(f"reference list: {len(new)} entries, {len(added)} added and {len(changed) - len(added)} changed since the first submission are set in blue")
