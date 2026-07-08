# -*- coding: utf-8 -*-
"""Incremental reconcile for render_pptx_com.py: rebuild ONLY the slides whose content
changed since the last build, so an untouched slide is never re-run through the
"printing press". Identity is the DHKEY tag stamped on each built slide; change is the
DHHASH tag vs the freshly extracted hash; PPT-side identity is the stable SlideID
(never the live index, which shifts on insert/delete).

Falls back to a full fresh build whenever the deck and the PPT can't be reconciled 1:1
(duplicate keys, or no prior DH build) — correctness over a clever-but-wrong patch.
"""


def _tag(sl, name):
    try:
        return sl.Tags(name) or ""
    except Exception:
        return ""


def _index_of(pres, sid):
    try:
        return pres.Slides.FindBySlideID(sid).SlideIndex
    except Exception:
        for i in range(1, pres.Slides.Count + 1):
            if pres.Slides(i).SlideID == sid:
                return i
        return None


def run_increment(pres, layout, doc, manifest, rebuild_mode, F):
    deck = doc["slides"]
    deck_keys = [s.get("key") for s in deck]
    if len(set(deck_keys)) != len(deck_keys):
        print("increment: duplicate slide keys in deck -> full rebuild")
        return F["fresh_build"](pres, layout, doc, manifest)

    ppt = []
    for i in range(1, pres.Slides.Count + 1):
        sl = pres.Slides(i)
        key = _tag(sl, "DHKEY")
        ppt.append({"id": sl.SlideID, "key": key, "hash": _tag(sl, "DHHASH"), "dh": bool(key)})
    dh_keys = [p["key"] for p in ppt if p["dh"]]
    if not dh_keys:
        print("increment: no prior derived build in this PPT -> full rebuild (use this once)")
        return F["fresh_build"](pres, layout, doc, manifest)
    if len(set(dh_keys)) != len(dh_keys):
        print("increment: duplicate derived keys in PPT -> full rebuild")
        return F["fresh_build"](pres, layout, doc, manifest)

    by_key = {p["key"]: p for p in ppt if p["dh"]}
    all_dh = all(p["dh"] for p in ppt)
    changed = skipped = added = removed = 0

    # 1) remove derived slides whose key left the deck (back-to-front by live index)
    gone = [p for p in ppt if p["dh"] and p["key"] not in deck_keys]
    for p in sorted(gone, key=lambda p: (_index_of(pres, p["id"]) or 0), reverse=True):
        idx = _index_of(pres, p["id"])
        if idx:
            pres.Slides(idx).Delete(); removed += 1
            by_key.pop(p["key"], None)

    # 2) per deck slide: skip unchanged / rebuild changed / add new
    for sd in deck:
        key = sd.get("key")
        if key in by_key:
            cur = by_key[key]
            if cur["hash"] == sd.get("hash"):
                skipped += 1; continue                      # untouched -> do not touch the PPT slide
            idx = _index_of(pres, cur["id"])
            if rebuild_mode == "replace":
                pres.Slides(idx).Delete()
                sl = F["new_slide"](pres, layout, idx)
            else:                                           # merge: clear only renderer-owned shapes
                sl = pres.Slides(idx)
                F["clear_dh_shapes"](sl)
            F["render_slide"](sl, sd); changed += 1
            by_key[key] = {"id": sl.SlideID, "key": key, "hash": sd.get("hash"), "dh": True}
        else:
            sl = F["new_slide"](pres, layout, pres.Slides.Count + 1)   # append; order fixed below
            F["render_slide"](sl, sd); added += 1
            by_key[key] = {"id": sl.SlideID, "key": key, "hash": sd.get("hash"), "dh": True}

    # 3) reorder to deck order (resolve by stable SlideID each step; safe only when the
    #    whole presentation is derived-owned — otherwise leave manual slides where they are)
    if all_dh:
        for target, key in enumerate(deck_keys, start=1):
            idx = _index_of(pres, by_key[key]["id"])
            if idx and idx != target:
                pres.Slides(idx).MoveTo(target)
    elif added or removed:
        print("increment: non-derived slides present -> content updated, slide order left as-is")

    # 4) manifest
    k2i = {key: _index_of(pres, by_key[key]["id"]) for key in deck_keys}
    F["write_manifest"](manifest, doc, pres, k2i)
    print("increment: %d changed, %d unchanged, %d added, %d removed" %
          (changed, skipped, added, removed))
