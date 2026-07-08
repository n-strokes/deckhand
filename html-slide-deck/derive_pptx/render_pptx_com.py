# -*- coding: utf-8 -*-
"""Stage 2 of the canonical HTML->PPT derive tool: render slides.json (produced by
extract_slides.py from the LIVE HTML) into the active PowerPoint as NATIVE editable
objects, via COM (pywin32) per the house standard.

Because every value comes from slides.json (which is read fresh from the HTML each run),
the PowerPoint is always derived from the current HTML -- it cannot drift to a hard-coded
copy (the failure this whole tool exists to prevent).

Modes:
    (default / --fresh)  rebuild the whole deck: clear slides, build one PPT slide per
                         HTML slide. Use for the first build or a clean regenerate.
    --increment          only rebuild slides whose content changed since the last build
                         (see reconcile() / manifest); untouched slides are not touched.
                         --rebuild-mode merge (default) clears only renderer-owned shapes
                         so manual PowerPoint edits survive; replace rebuilds the slide.

Geometry: HTML px * 0.75 = PowerPoint points (1280px -> 960pt = 13.33" widescreen).
Font, color, fill, border, alignment, bullets, tables all come from the extract.

Usage:
    python render_pptx_com.py SLIDES.json [--pres NAME] [--fresh|--increment]
                                          [--rebuild-mode merge|replace] [--manifest M.json]
"""
import argparse, json, os, sys

S = 0.75                      # HTML px -> PPT points
DHTAG = "DH"                  # AlternativeText prefix marking renderer-owned shapes

# COM enums (avoid importing the typelib)
MSO_TRUE, MSO_FALSE = -1, 0
SHAPE_RECT, SHAPE_ROUND = 1, 5
TXT_HORIZ = 1
ALIGN = {"left": 1, "start": 1, "center": 2, "right": 3, "end": 3, "justify": 4}
VANCHOR = {"top": 1, "middle": 3, "bottom": 4}
AUTOSIZE_NONE = 0
BORDER = {"top": 1, "left": 2, "bottom": 3, "right": 4}   # ppBorderTop/Left/Bottom/Right


def s(v):
    return float(v) * S


def rgb(hexstr):
    """'#rrggbb' -> PowerPoint BGR-packed int."""
    h = (hexstr or "#000000").lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r + g * 256 + b * 65536


def pt_font(font):
    return max(1.0, (font.get("size") or 12) * S)


# ---- shape emitters --------------------------------------------------------
def _apply_text(tf, text, font, valign="top"):
    tf.WordWrap = MSO_TRUE
    try: tf.AutoSize = AUTOSIZE_NONE
    except Exception: pass
    tf.VerticalAnchor = VANCHOR.get(valign, 1)
    for m in ("MarginLeft", "MarginRight"): setattr(tf, m, s(4))
    for m in ("MarginTop", "MarginBottom"): setattr(tf, m, s(1))
    tr = tf.TextRange
    tr.Text = text or ""
    fo = tr.Font
    fo.Name = "Calibri"                                   # house font, always
    fo.Size = pt_font(font)
    fo.Bold = MSO_TRUE if (font.get("weight") or 400) >= 600 else MSO_FALSE
    fo.Italic = MSO_TRUE if font.get("italic") else MSO_FALSE
    fo.Color.RGB = rgb(font.get("color") or "#071D49")
    tr.ParagraphFormat.Alignment = ALIGN.get((font.get("align") or "left"), 1)
    return tr


def _fill_line(shape, fill, border):
    if fill:
        shape.Fill.Visible = MSO_TRUE; shape.Fill.ForeColor.RGB = rgb(fill)
    else:
        shape.Fill.Visible = MSO_FALSE
    if border and (border.get("width") or 0) > 0:
        shape.Line.Visible = MSO_TRUE
        shape.Line.ForeColor.RGB = rgb(border.get("color") or "#000000")
        shape.Line.Weight = max(0.5, (border.get("width") or 1) * S)
    else:
        shape.Line.Visible = MSO_FALSE
    try: shape.Shadow.Visible = MSO_FALSE
    except Exception: pass


def _round_adj(shape, radius_px, w, h):
    short = max(1.0, min(w, h))
    frac = max(0.0, min(0.5, (radius_px or 0) / short))
    try:
        shape.Adjustments[1] = frac        # pywin32 subscript-assign -> put_Item
    except Exception:
        pass


def emit(slide, el, key):
    role = el.get("role")
    L, T, W, H = s(el["left"]), s(el["top"]), s(max(1, el["w"])), s(max(1, el["h"]))
    sh = None
    if role == "text":
        fill, border, rad = el.get("fill"), el.get("border"), el.get("radius") or 0
        if fill or border:                                 # styled box / pill -> a shape that holds text
            sh = slide.Shapes.AddShape(SHAPE_ROUND if rad > 4 else SHAPE_RECT, L, T, W, H)
            _fill_line(sh, fill, border)
            if rad > 4: _round_adj(sh, el.get("radius"), el["w"], el["h"])
            _apply_text(sh.TextFrame, el.get("text"), el["font"], el.get("valign", "middle"))
        else:
            sh = slide.Shapes.AddTextbox(TXT_HORIZ, L, T, W, H)
            _apply_text(sh.TextFrame, el.get("text"), el["font"], el.get("valign", "top"))
    elif role == "rect":
        rad = el.get("radius") or 0
        sh = slide.Shapes.AddShape(SHAPE_ROUND if rad > 4 else SHAPE_RECT, L, T, W, H)
        _fill_line(sh, el.get("fill"), el.get("border"))
        if rad > 4: _round_adj(sh, el.get("radius"), el["w"], el["h"])
    elif role == "list":
        sh = slide.Shapes.AddTextbox(TXT_HORIZ, L, T, W, H)
        items = el.get("items") or []
        tr = _apply_text(sh.TextFrame, "\r".join(items), el["font"], "top")
        for i in range(1, len(items) + 1):
            try:
                b = tr.Paragraphs(i).ParagraphFormat.Bullet
                b.Visible = MSO_TRUE; b.Character = 8226
            except Exception: pass
    elif role == "table":
        sh = emit_table(slide, el)
    elif role == "image":
        sh = None  # images handled by orchestrator if a resolvable path is supplied
    if sh is not None:
        try: sh.AlternativeText = "%s:%s:%s" % (DHTAG, key, role)
        except Exception: pass
    return sh


def emit_table(slide, el):
    rows, cols = el["rows"], el["cols"]
    L, T, W, H = s(el["left"]), s(el["top"]), s(el["w"]), s(el["h"])
    shp = slide.Shapes.AddTable(rows, cols, L, T, W, H)
    tb = shp.Table
    try: tb.FirstRow = False; tb.HorizBanding = False; tb.FirstCol = False
    except Exception: pass
    colw = el.get("colWidths") or []
    for j, w in enumerate(colw):
        if w and j < cols:
            try: tb.Columns(j + 1).Width = s(w)
            except Exception: pass
    cells = el.get("cells") or []
    for r, row in enumerate(cells):
        for c, cd in enumerate(row):
            if r + 1 > rows or c + 1 > cols: continue
            try: cc = tb.Cell(r + 1, c + 1)
            except Exception: continue
            if cd.get("fill"):
                cc.Shape.Fill.ForeColor.RGB = rgb(cd["fill"])
            tf = cc.Shape.TextFrame
            tf.VerticalAnchor = VANCHOR.get(cd.get("valign"), 3)
            txt = cd.get("text")
            if txt is None and cd.get("items"):
                txt = "\r".join(cd["items"])
            tr = tf.TextRange; tr.Text = txt or ""
            fo = tr.Font; fo.Name = "Calibri"; fo.Size = pt_font(cd.get("font") or {})
            fo.Bold = MSO_TRUE if cd.get("head") or (cd.get("font", {}).get("weight", 400) >= 600) else MSO_FALSE
            fo.Color.RGB = rgb((cd.get("font") or {}).get("color") or "#071D49")
            tr.ParagraphFormat.Alignment = ALIGN.get(cd.get("align", "left"), 1)
    return shp


# ---- presentation plumbing -------------------------------------------------
def connect(pres_name):
    import win32com.client
    app = win32com.client.GetActiveObject("PowerPoint.Application")
    opens = list(app.Presentations)
    if not opens:
        raise SystemExit("No presentation open in PowerPoint. Open the target .pptx first.")
    if pres_name:
        match = [p for p in opens if pres_name.lower() in p.Name.lower()]
        if not match:
            raise SystemExit("No open presentation matches %r. Open: %s"
                             % (pres_name, ", ".join(p.Name for p in opens)))
        return app, match[0]
    if len(opens) == 1:
        return app, opens[0]
    raise SystemExit("Several presentations open; pass --pres NAME. Open: %s"
                     % ", ".join(p.Name for p in opens))


def pick_layout(pres):
    """House content layout ('Use this'), else the first slide's layout."""
    try:
        for design in pres.Designs:
            for lay in design.SlideMaster.CustomLayouts:
                if "use this" in (lay.Name or "").lower():
                    return lay
    except Exception:
        pass
    try:
        return pres.Slides(1).CustomLayout
    except Exception:
        return pres.SlideMaster.CustomLayouts(1)


def strip_placeholders(slide):
    for i in range(slide.Shapes.Count, 0, -1):
        sh = slide.Shapes(i)
        try:
            if sh.Type == 14 or sh.HasTextFrame and sh.PlaceholderFormat.Type:  # placeholder
                sh.Delete()
        except Exception:
            pass


def new_slide(pres, layout, at_index):
    try:
        sl = pres.Slides.AddSlide(at_index, layout)
    except Exception:
        sl = pres.Slides.Add(at_index, 12)   # ppLayoutBlank fallback
    strip_placeholders(sl)
    return sl


def render_slide(sl, sdata):
    key = sdata.get("key") or ("idx%d" % sdata.get("index", 0))
    for el in sdata.get("elements", []):
        try:
            emit(sl, el, key)
        except Exception as e:
            sys.stderr.write("  warn: element %s failed: %s\n" % (el.get("role"), e))
    # stamp identity + content hash on the slide for incremental reconcile
    try:
        sl.Tags.Add("DHKEY", key)
        sl.Tags.Add("DHHASH", sdata.get("hash", ""))
    except Exception:
        pass


def clear_dh_shapes(sl):
    for i in range(sl.Shapes.Count, 0, -1):
        sh = sl.Shapes(i)
        try:
            if (sh.AlternativeText or "").startswith(DHTAG + ":"):
                sh.Delete()
        except Exception:
            pass


def write_manifest(path, doc, pres, key_to_index):
    man = {"deck": doc.get("deck"), "deck_sha": doc.get("deck_sha"),
           "pres": pres.Name, "slides": []}
    for sd in doc["slides"]:
        key = sd.get("key")
        man["slides"].append({"key": key, "hash": sd.get("hash"),
                              "position": key_to_index.get(key)})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)


def fresh_build(pres, layout, doc, manifest):
    """Clear every slide and build one PPT slide per HTML slide, in order."""
    while pres.Slides.Count > 0:
        pres.Slides(pres.Slides.Count).Delete()
    key_to_index = {}
    for i, sd in enumerate(doc["slides"], start=1):
        sl = new_slide(pres, layout, i)
        render_slide(sl, sd)
        key_to_index[sd.get("key")] = i
        print("  built slide %d  key=%s  (%d elements)" %
              (i, (sd.get("key") or "")[:32], len(sd.get("elements", []))))
    write_manifest(manifest, doc, pres, key_to_index)
    print("done (fresh): %d slides; manifest -> %s" % (len(doc["slides"]), manifest))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slides", help="slides.json from extract_slides.py")
    ap.add_argument("--pres", default=None, help="open presentation name substring")
    ap.add_argument("--increment", action="store_true", help="only rebuild changed slides")
    ap.add_argument("--fresh", action="store_true", help="clear all slides and rebuild (first build)")
    ap.add_argument("--rebuild-mode", choices=["merge", "replace"], default="merge")
    ap.add_argument("--manifest", default=None)
    a = ap.parse_args()

    doc = json.load(open(a.slides, encoding="utf-8"))
    manifest = a.manifest or (os.path.splitext(a.slides)[0].replace(".slides", "") + ".ppt-build.json")
    app, pres = connect(a.pres)
    layout = pick_layout(pres)

    if a.increment and not a.fresh:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from _increment import run_increment
        funcs = {"render_slide": render_slide, "clear_dh_shapes": clear_dh_shapes,
                 "new_slide": new_slide, "write_manifest": write_manifest,
                 "fresh_build": fresh_build}
        run_increment(pres, layout, doc, manifest, a.rebuild_mode, funcs)
        return

    fresh_build(pres, layout, doc, manifest)


if __name__ == "__main__":
    main()
