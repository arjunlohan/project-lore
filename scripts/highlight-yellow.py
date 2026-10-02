#!/usr/bin/env python3
"""Put a yellow highlight behind every changed passage of the highlighted PDF.

IEEE Access asks for a copy with the changes highlighted, "preferably with
the yellow highlight tool". The latexdiff copy marks changes in blue text:
neither background highlighter that runs under pdfTeX (soul's \\hl, ulem's
mark-over) survives this class's captions, run-in headings and citation-dense
prose. So the highlight is added to the finished PDF instead. poppler reports
every text run with its colour and box (pdftohtml -xml); each run set in the
diff's blue gets a pale yellow rectangle, and the original page is painted over
those rectangles. The page content itself is embedded unchanged, so the
text stays text (selectable, searchable, same fonts) and the highlighted copy
keeps the pagination of the blue one.

Usage: highlight-yellow.py BLUE.pdf OUT.pdf
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

BLUE = "#0000ff"  # latexdiff-highlight.tex: \color{blue}
ZOOM = 1.5  # pdftohtml's default: XML units are 1/1.5 of a PDF point
MERGE_GAP = 9  # XML units; runs closer than this on one line are one stripe


def main(src: str, out: str) -> None:
    src = os.path.abspath(src)
    out = os.path.abspath(out)
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(src, os.path.join(tmp, "blue.pdf"))
        subprocess.run(
            ["pdftohtml", "-xml", "-i", "-q", "-hidden", "blue.pdf", "runs"],
            cwd=tmp, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        raw = open(os.path.join(tmp, "runs.xml"), encoding="utf-8", errors="replace").read()
        # pdftohtml emits control characters XML 1.0 forbids; drop them.
        raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", raw)
        root = ET.fromstring(raw.split("?>", 1)[1].split(">", 1)[1] if raw.lstrip().startswith("<?xml") and "<!DOCTYPE" in raw[:200] else raw)
        colour = {}
        pages = []
        for page in root.iter("page"):
            for spec in page.iter("fontspec"):
                colour[spec.get("id")] = (spec.get("color") or "").lower()
            width, height = float(page.get("width")), float(page.get("height"))
            runs = []
            for t in page.iter("text"):
                if colour.get(t.get("font")) != BLUE:
                    continue
                if not "".join(t.itertext()).strip():
                    continue
                runs.append([float(t.get("left")), float(t.get("top")), float(t.get("width")), float(t.get("height"))])
            # One stripe per line: merge runs that share a baseline band.
            runs.sort(key=lambda r: (round(r[1] / 3), r[0]))
            stripes = []
            for left, top, w, h in runs:
                if stripes:
                    pl, pt, pw, ph = stripes[-1]
                    same_line = abs(pt - top) <= max(3.0, 0.4 * min(ph, h))
                    if same_line and left - (pl + pw) <= MERGE_GAP and left >= pl - 1:
                        new_top = min(pt, top)
                        new_bottom = max(pt + ph, top + h)
                        stripes[-1] = [pl, new_top, max(pl + pw, left + w) - pl, new_bottom - new_top]
                        continue
                stripes.append([left, top, w, h])
            pages.append((width / ZOOM, height / ZOOM, stripes))
        if not pages:
            sys.exit("no pages read from the highlighted PDF")
        if not any(s for _, _, s in pages):
            sys.exit("no blue text found: nothing to highlight")
        w_pt, h_pt = pages[0][0], pages[0][1]
        tex = [
            r"\documentclass{article}",
            rf"\usepackage[paperwidth={w_pt:.2f}bp,paperheight={h_pt:.2f}bp,margin=0pt]{{geometry}}",
            r"\usepackage{xcolor}",
            r"\usepackage{graphicx}",
            r"\definecolor{changed}{rgb}{1,0.95,0.42}",
            r"\setlength{\unitlength}{1bp}",
            r"\setlength{\parindent}{0pt}\setlength{\topskip}{0pt}\setlength{\parskip}{0pt}",
            r"\pagestyle{empty}",
            # Embed the fonts of the included pages once, as they are, and
            # compress the object streams; without this pdfTeX writes each
            # page's fonts again and the file grows sixfold.
            r"\pdfinclusioncopyfonts=1 \pdfobjcompresslevel=2 \pdfcompresslevel=9 \pdfminorversion=5",
            r"\pdfinfo{/Title (Reuse, but Verify: highlighted changes) /Author (Arjun Lohan)}",
            r"\begin{document}",
            # Declare every page of the source before any is used: pdfTeX
            # then keeps the file open and shares its fonts and resources
            # across pages instead of copying them once per page.
            r"\makeatletter",
            r"\def\loadpage#1{\pdfximage page #1 {blue.pdf}\expandafter\xdef\csname pg@#1\endcsname{\the\pdflastximage}}",
            r"\def\usepage#1{\pdfrefximage\csname pg@#1\endcsname}",
            r"\makeatother",
        ]
        tex.extend(rf"\loadpage{{{i}}}" for i in range(1, len(pages) + 1))
        for i, (pw, ph, stripes) in enumerate(pages, start=1):
            cmds = []
            for left, top, w, h in stripes:
                x = left / ZOOM - 0.6
                # A text box is taller than its ink; trim the stripe a little
                # so stripes on consecutive lines do not fuse into a slab.
                y = ph - (top + h) / ZOOM + 0.08 * h / ZOOM
                cmds.append(rf"\put({x:.2f},{y:.2f}){{\color{{changed}}\rule{{{w / ZOOM + 1.2:.2f}bp}}{{{0.9 * h / ZOOM:.2f}bp}}}}")
            # A picture paints its items in order: the stripes first, then the
            # original page over them, so the text is never covered.
            tex.append(
                rf"\noindent\begin{{picture}}({pw:.2f},{ph:.2f})%" + "\n"
                + "%\n".join(cmds) + "%\n"
                + rf"\put(0,0){{\usepage{{{i}}}}}%" + "\n"
                + r"\end{picture}\newpage"
            )
        tex.append(r"\end{document}")
        open(os.path.join(tmp, "yellow.tex"), "w").write("\n".join(tex) + "\n")
        for _ in range(2):
            r = subprocess.run(["pdflatex", "-interaction=nonstopmode", "yellow.tex"], cwd=tmp, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(os.path.join(tmp, "yellow.pdf")):
            sys.stderr.write(r.stdout[-2000:])
            sys.exit("pdflatex failed on the highlight overlay")
        shutil.copy(os.path.join(tmp, "yellow.pdf"), out)
    total = sum(len(s) for _, _, s in pages)
    print(f"yellow highlight: {total} stripes over {len(pages)} pages -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
