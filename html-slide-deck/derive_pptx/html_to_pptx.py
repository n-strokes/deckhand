# -*- coding: utf-8 -*-
"""Canonical HTML -> PowerPoint: derive the PPT from the LIVE deck so it can never drift.

Two stages: extract_slides.py reads the HTML with headless Chrome -> slides.json; then
render_pptx_com.py emits native PPT objects into the active PowerPoint via COM. Run this
orchestrator; it chains both.

    python html_to_pptx.py DECK.html --pres "Derm DST" --fresh        # first / clean build
    python html_to_pptx.py DECK.html --pres "Derm DST" --increment    # only changed slides
    python html_to_pptx.py DECK.html --pres "Derm DST" --increment --rebuild-mode replace

DECK.html may be absolute or relative to the cwd. The PowerPoint with the target deck must
be open (house standard: COM against the running instance). slides.json + <deck>.ppt-build.json
are written next to the deck as the audit trail.
"""
import argparse, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("deck", help="deck .html (absolute or relative to cwd)")
    ap.add_argument("--pres", default=None, help="open presentation name substring")
    ap.add_argument("--increment", action="store_true", help="only rebuild changed slides")
    ap.add_argument("--fresh", action="store_true", help="clear all slides and rebuild")
    ap.add_argument("--rebuild-mode", choices=["merge", "replace"], default="merge")
    ap.add_argument("--slides", default=None, help="comma 0-based indices to extract; default all")
    a = ap.parse_args()

    deck_abs = os.path.abspath(a.deck)
    if not os.path.exists(deck_abs):
        raise SystemExit("deck not found: " + deck_abs)
    deck_dir = os.path.dirname(deck_abs)
    deck_base = os.path.basename(deck_abs)
    slides_json = os.path.splitext(deck_abs)[0] + ".slides.json"

    # Stage 1: extract (cwd = deck dir so the deck's relative img/ paths resolve)
    ex = [sys.executable, os.path.join(HERE, "extract_slides.py"), deck_base, "--out", slides_json]
    if a.slides:
        ex += ["--slides", a.slides]
    print("==> extract:", " ".join(ex))
    r = subprocess.run(ex, cwd=deck_dir)
    if r.returncode != 0:
        raise SystemExit("extract failed (rc %d)" % r.returncode)

    # Stage 2: render via COM into the active PowerPoint
    rn = [sys.executable, os.path.join(HERE, "render_pptx_com.py"), slides_json,
          "--rebuild-mode", a.rebuild_mode]
    if a.pres:
        rn += ["--pres", a.pres]
    if a.increment and not a.fresh:
        rn += ["--increment"]
    elif a.fresh:
        rn += ["--fresh"]
    print("==> render:", " ".join(rn))
    r = subprocess.run(rn)
    if r.returncode != 0:
        raise SystemExit("render failed (rc %d)" % r.returncode)
    print("OK")


if __name__ == "__main__":
    main()
