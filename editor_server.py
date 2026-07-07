#!/usr/bin/env python3
"""Deckhand — local HTML/PowerPoint editor server for Claude.

Serves a project directory. For any .html file it injects the editor overlay
before </body>, turning Chrome into a direct editor for that file.

LIVE SOURCE WRITE-BACK (the default, see SKILL.md):
  * Every browser edit is written straight back into the .html source, surgically
    and immediately, via the /__src_* endpoints. The source file IS the artifact;
    when the user stops editing it is already done (Claude only does optional
    cleanup on request).
  * Writes are surgical (character-offset splices via _SpanParser / locate_node),
    so comments / whitespace / sibling markup are preserved and JS-generated
    content is never frozen into source. Writes are atomic (temp + os.replace).
  * Undo = a stack of file snapshots, grouped by transaction `txid`: one user
    action (incl. a whole held-arrow nudge burst) is one undo step, popped strictly
    by txid so a failed-locate edit can never over-pop an unrelated one.

Also under <root>/.annotate/ (the server is the single writer there):
    blueprint.json   a lightweight change LOG (op history + edits count) — in the
                     live model this is an audit trail, not replayed
    comments.json    element-anchored comments (same shape as the annotate skill)

A localStorage flag (pptEdSrc='0') in the overlay falls back to blueprint-only
behavior (no source writes) if ever needed.

Pure stdlib, no dependencies.

Usage:
    python3 editor_server.py [--root DIR] [--port N] [--base-port N]
"""
import argparse
import datetime
import hashlib
import http.server
import json
import os
import socket
import socketserver
import threading
import time
import urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OVERLAY_PATH = os.path.join(SCRIPT_DIR, "editor_overlay.js")

with open(OVERLAY_PATH, "r", encoding="utf-8") as _f:
    OVERLAY = "\n<script>\n" + _f.read() + "\n</script>\n"

# One lock guards every read-modify-write of the .annotate files and the rev
# counter, because ThreadingTCPServer dispatches each request on its own thread.
LOCK = threading.Lock()


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ---- blueprint: reduce op history -> resolved per-element edits --------------
def reduce_history(history):
    """Fold the append-only op log into one record per element handle. Last write
    wins per property, so Claude reads the *current* desired state, never a
    replay of 'moved to A then B'. Returns a list of edit records."""
    edits = {}
    for op in history:
        h = op.get("handle")
        if h is None:
            continue
        e = edits.get(h)
        if e is None:
            e = {
                "handle": h,
                "anchor": op.get("anchor") or {},
                "kind": "modify",
                "create": None,
                "props": {"style": {}},
                "deleted": False,
                "last_seq": op.get("seq", 0),
            }
            edits[h] = e
        if op.get("anchor"):
            e["anchor"] = op["anchor"]
        e["last_seq"] = op.get("seq", e["last_seq"])
        kind = op.get("op")
        val = op.get("value") or {}
        if kind == "create":
            e["kind"] = "create"
            e["create"] = val
            e["deleted"] = False
        elif kind == "delete":
            e["deleted"] = True
        elif kind == "setText":
            e["props"]["text"] = val.get("text", "")
        elif kind == "setHTML":
            e["props"]["html"] = val.get("html", "")
        elif kind == "setStyle":
            e["props"]["style"].update(val.get("style") or {})
        elif kind == "move":
            e["props"]["pos"] = {
                "ref": val.get("ref"),
                "left": val.get("left"),
                "top": val.get("top"),
            }
        elif kind == "resize":
            e["props"]["size"] = {"w": val.get("w"), "h": val.get("h")}
        elif kind == "setZ":
            e["props"]["z"] = val.get("z")
        elif kind == "reorder":
            e["kind"] = "reorder"
            e["props"]["order"] = val.get("order")
            e["props"]["excerpts"] = val.get("excerpts")
    # order by most-recently-touched first so the action loop sees fresh work top
    out = sorted(edits.values(), key=lambda e: e["last_seq"], reverse=True)
    return out


def open_blueprint_count(history):
    return len(reduce_history(history))


# ---- live source write-back: locate an element's exact span in the HTML text -
# Surgical, position-aware: never re-serialize the whole file (no sludge). We find
# the [start,end) char span of one element and splice only that. Elements are
# addressed by a root id (nearest ancestor with an id, or the document) plus a
# child-index path down to the target — robust without a full CSS engine.
from html.parser import HTMLParser as _HTMLParser

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
         "meta", "param", "source", "track", "wbr"}


class _SpanParser(_HTMLParser):
    """Parse HTML, recording each element's [start,end) char offsets + child tree."""
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self._text = text
        self._lines = [0]
        for i, ch in enumerate(text):
            if ch == "\n":
                self._lines.append(i + 1)
        self.nodes = []        # {tag, attrs, start, starttag_end, end, parent, children}
        self.roots = []        # top-level node indices
        self._open = []        # stack of open node indices
        try:
            self.feed(text)
            self.close()
        except Exception:
            pass

    def _off(self):
        line, col = self.getpos()
        return self._lines[line - 1] + col

    def _add(self, tag, attrs, start, starttag_end, closed):
        node = {"tag": tag.lower(), "attrs": dict(attrs), "start": start,
                "starttag_end": starttag_end, "end": (starttag_end if closed else None),
                "parent": self._open[-1] if self._open else None, "children": []}
        idx = len(self.nodes)
        self.nodes.append(node)
        (self.nodes[node["parent"]]["children"] if node["parent"] is not None
         else self.roots).append(idx)
        return idx

    def handle_starttag(self, tag, attrs):
        start = self._off()
        gt = self._text.find(">", start)
        ste = gt + 1 if gt >= 0 else start
        idx = self._add(tag, attrs, start, ste, tag.lower() in _VOID)
        if tag.lower() not in _VOID:
            self._open.append(idx)

    def handle_startendtag(self, tag, attrs):
        start = self._off()
        gt = self._text.find(">", start)
        self._add(tag, attrs, start, (gt + 1 if gt >= 0 else start), True)

    def handle_endtag(self, tag):
        start = self._off()
        gt = self._text.find(">", start)
        endtag_end = gt + 1 if gt >= 0 else start
        for i in range(len(self._open) - 1, -1, -1):
            if self.nodes[self._open[i]]["tag"] == tag.lower():
                for j in range(len(self._open) - 1, i - 1, -1):
                    if self.nodes[self._open[j]]["end"] is None:
                        self.nodes[self._open[j]]["end"] = endtag_end
                del self._open[i:]
                return


def _find_by_attr(parser, attr, val):
    for n in parser.nodes:
        if n["attrs"].get(attr) == val:
            return n
    return None


def _slide_nodes(parser):
    """Top-level `.slide` nodes in source document order — the same set, in the same
    order, the overlay's getSlides() sees. Nested slides are excluded so reorder acts
    on the real slide sequence. Lets reorder address slides by ordinal (robust) instead
    of a brittle body child-index path."""
    def has_slide_ancestor(n):
        pi = n["parent"]
        while pi is not None:
            a = parser.nodes[pi]
            if "slide" in (a["attrs"].get("class") or "").split():
                return True
            pi = a["parent"]
        return False
    out = [n for n in parser.nodes
           if "slide" in (n["attrs"].get("class") or "").split()
           and n["end"] is not None and not has_slide_ancestor(n)]
    return sorted(out, key=lambda n: n["start"])


def locate_node(text, root_id=None, indices=None, handle=None):
    """Return the addressed element's node dict (start/starttag_end/end/children/tag),
    or None. Prefer a data-ppt-h handle (stable, unique); else nearest-id + child path."""
    p = _SpanParser(text)
    if handle:
        n = _find_by_attr(p, "data-ppt-h", handle)
        if n and n["end"] is not None:
            n["_parser"] = p
            return n
    node = None
    if root_id:
        root = _find_by_attr(p, "id", root_id)
        if not root:
            return None
        node = root
        for ci in (indices or []):
            ch = node["children"]
            if not (0 <= ci < len(ch)):
                return None
            node = p.nodes[ch[ci]]
    else:
        # No id ancestor: the overlay builds the path by walking up to the
        # documentElement (<html>) and STOPPING there without recording the root's own
        # index — so indices[0] is a child index within <html>. Start AT the root
        # element and descend through its children, one index per level. (Earlier this
        # indexed into p.roots directly, an off-by-one that made every id-less element
        # fail to locate — e.g. a whole deck with no ids on slides/tables/boxes.)
        if not p.roots:
            return None
        node = p.nodes[p.roots[0]]
        for ci in (indices or []):
            ch = node["children"]
            if not (0 <= ci < len(ch)):
                return None
            node = p.nodes[ch[ci]]
    if not node or node["end"] is None:
        return None
    node["_parser"] = p
    return node


def locate_span(text, root_id=None, indices=None, handle=None):
    n = locate_node(text, root_id, indices, handle)
    return (n["start"], n["end"]) if n else None


import re as _re


def _strip_empty_decls(style_str):
    """Drop any declaration with an empty value ('prop:' / 'prop: ;'). Browsers emit
    these when a CSS *shorthand* present in the source (background, font, border,
    margin, ...) is exploded into longhands after the overlay sets a single longhand —
    e.g. setting fill on an element authored with `background:` yields
    `background-image: ; background-repeat: ;`, which is invalid CSS and lints as errors.
    Stripping them keeps the written source clean. Declarations with real values are
    preserved verbatim (only spacing around the joins is normalized)."""
    out = []
    for part in (style_str or "").split(";"):
        if not part.strip():
            continue
        if ":" in part:
            _k, v = part.split(":", 1)
            if not v.strip():
                continue                       # 'prop:' with no value -> drop it
        out.append(part.strip())
    return "; ".join(out)


def _merge_style(existing, props):
    """Merge {prop: value} into a 'a:b;c:d' style string. value '' / None removes.
    Empty-valued declarations (in the existing style or produced by the merge) are
    dropped, so a shorthand the browser exploded never leaves `prop:` junk behind."""
    cur = []
    seen = {}
    for part in existing.split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k = k.strip()
            if not v.strip():
                continue                       # don't carry forward an empty declaration
            cur.append([k, v.strip()])
            seen[k] = len(cur) - 1
    for k, v in (props or {}).items():
        k = k.strip()
        if v is None or v == "":
            if k in seen:
                cur[seen[k]] = None
        elif k in seen:
            cur[seen[k]][1] = str(v).strip()
        else:
            cur.append([k, str(v).strip()])
            seen[k] = len(cur) - 1
    return _strip_empty_decls(";".join(k + ":" + v for kv in cur if kv for k, v in [kv]))


def _set_style_attr(tag_text, style_str, handle):
    """Set the start tag's style attribute wholesale to style_str (so source inline
    style == the DOM element's), and stamp data-ppt-h. Preserves the rest of the tag."""
    t = tag_text
    enc = _strip_empty_decls(style_str).replace('"', "&quot;")   # never write 'prop:' empties (exploded shorthands)
    m = _re.search(r'style\s*=\s*"[^"]*"', t)
    if enc:
        if m:
            t = t[:m.start()] + 'style="' + enc + '"' + t[m.end():]
        else:
            t = _re.sub(r'\s*(/?>)\s*$', ' style="' + enc + r'"\1', t, count=1)
    elif m:
        t = (t[:m.start()].rstrip() + t[m.end():])
    if handle and "data-ppt-h=" not in t:
        t = _re.sub(r'\s*(/?>)\s*$', ' data-ppt-h="' + handle + r'"\1', t, count=1)
    return t


def update_start_tag(tag_text, style_props, handle):
    """Surgically edit ONE start tag's style attr (+ stamp data-ppt-h), preserving
    the rest of the tag byte-for-byte. tag_text is the '<...>' opening tag only."""
    t = tag_text
    m = _re.search(r'style\s*=\s*"([^"]*)"', t)
    if style_props is not None:
        merged = _merge_style(m.group(1) if m else "", style_props)
        if m:
            t = t[:m.start()] + 'style="' + merged + '"' + t[m.end():]
        elif merged:
            t = _re.sub(r'\s*(/?>)\s*$', ' style="' + merged + r'"\1', t, count=1)
    if handle and "data-ppt-h=" not in t:
        t = _re.sub(r'\s*(/?>)\s*$', ' data-ppt-h="' + handle + r'"\1', t, count=1)
    return t


# ---- free-port scan ----------------------------------------------------------
def find_free_port(base, span=80):
    for p in range(base, base + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit(f"no free port in {base}..{base + span}")


def make_handler(root, ann_dir, port_box, state):
    bp_file = os.path.join(ann_dir, "blueprint.json")
    cm_file = os.path.join(ann_dir, "comments.json")
    versions_dir = os.path.join(ann_dir, "versions")

    def bump_rev():
        state["rev"] += 1
        return state["rev"]

    def load_bp():
        return read_json(bp_file, {"meta": {"version": 0}, "history": [], "edits": [], "snapshots": []})

    def save_bp(bp):
        bp["edits"] = reduce_history(bp["history"])
        bp["meta"]["rev"] = state["rev"]
        write_json(bp_file, bp)

    def load_cm():
        return read_json(cm_file, [])

    def find_cm(data, cid):
        for c in data:
            if int(c.get("id", -1)) == cid:
                return c
        return None

    def cm_open(data):
        return sum(1 for c in data if c.get("status") != "done")

    # ---- live source write-back (the file IS the truth; undo = file snapshots) ----
    # Undo is grouped by transaction: every source write carries a `txid`, and the
    # file is snapshotted ONCE per txid (the first write of the transaction). All
    # later writes sharing that txid mutate the file without adding an undo step, so
    # one Undo reverts exactly one user action — a multi-element move, a setText +
    # setHTML pair, or a whole held-arrow nudge burst all collapse to a single step.
    # This also makes a failed locate harmless: the checkpoint is taken regardless,
    # so the client's one-undo-per-transaction count can never out-run the server's.
    src_undo = state.setdefault("src_undo", {})   # {fs_path: [(txid, prior_contents)...]}
    src_txid = state.setdefault("src_txid", {})   # {fs_path: txid of the current transaction}

    # Single-writer coordination. The GUI (through this server) and an optional
    # parallel Claude cleanup must never clobber each other:
    #  * every write is ATOMIC (temp file + os.replace) so a reader — Claude's editor,
    #    or the next GUI write reading fresh — never sees a half-written file;
    #  * each source write stamps a heartbeat (last_write per file). GET /__srcinfo
    #    reports it + the file's current hash, so Claude can see a live GUI session is
    #    actively writing and hold off / re-read before editing (see SKILL.md).
    src_active = state.setdefault("src_active", {})   # {fs_path: last GUI write epoch}

    def _read_src(fs):
        with open(fs, "r", encoding="utf-8") as f:
            return f.read()

    def _write_src(fs, text):
        # Prefer an ATOMIC swap (temp file + os.replace) so no reader ever sees a torn
        # file. On Windows os.replace can transiently fail with Access Denied when
        # something holds a handle on the destination or the just-written temp — most
        # often **OneDrive sync** (these decks live in OneDrive) or antivirus scanning a
        # new file. Retry briefly; if it still won't swap, fall back to an in-place
        # rewrite so the edit is never simply lost to a momentary lock.
        data = text.encode("utf-8")
        tmp = fs + ".dh-tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            last = None
            for delay in (0, 0.05, 0.12, 0.25):
                if delay:
                    time.sleep(delay)
                try:
                    os.replace(tmp, fs)               # atomic swap
                    src_active[fs] = time.time()
                    return
                except OSError as e:
                    last = e
            # atomic swap kept failing -> in-place rewrite (not atomic, but the edit lands)
            with open(fs, "w", encoding="utf-8") as f:
                f.write(text)
            src_active[fs] = time.time()
        finally:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

    def _checkpoint(fs, text, txid):
        """Snapshot the file for undo — but only the first time we see this txid, so
        every write in one transaction collapses to a single undo step. The snapshot is
        tagged with the txid so undo can pop strictly by transaction (never over-pop)."""
        if txid and src_txid.get(fs) == txid:
            return                                      # already checkpointed this transaction
        src_undo.setdefault(fs, []).append((txid, text))
        src_txid[fs] = txid

    def src_delete(fs, pl):
        text = _read_src(fs)
        sp = locate_span(text, pl.get("root_id"), pl.get("indices"), pl.get("handle"))
        if not sp:
            return {"ok": False, "error": "not found in source"}
        _checkpoint(fs, text, pl.get("txid"))
        new = text[:sp[0]] + text[sp[1]:]
        # tidy a now-empty line left where the element was
        new = new.replace("\n\n\n", "\n\n")
        _write_src(fs, new)
        return {"ok": True}

    def src_undo_last(fs, txid):
        """Pop the top checkpoint ONLY if it belongs to the transaction being undone.
        If `txid` made no checkpoint (all its writes failed to locate, so the file never
        changed), the top belongs to an earlier transaction — undoing is then a no-op,
        never reverting an unrelated edit. Bare/legacy callers (no txid) pop the top."""
        st = src_undo.get(fs) or []
        if not st:
            return {"ok": True, "noop": True}           # nothing pending — harmless
        if txid is not None and st[-1][0] != txid:
            return {"ok": True, "noop": True}           # this action changed no source; don't over-pop
        _write_src(fs, st.pop()[1])
        src_txid[fs] = None                             # next write starts a fresh checkpoint
        return {"ok": True}

    def src_undo_all(fs):
        """Revert every pending source edit this session — restore the oldest snapshot
        (the file as it was before the first edit) and clear the stack."""
        st = src_undo.get(fs) or []
        if not st:
            return {"ok": True, "noop": True}
        _write_src(fs, st[0][1])
        src_undo[fs] = []
        src_txid[fs] = None
        return {"ok": True}

    def src_style(fs, pl):
        """Merge style props into the element's start tag (move/resize/format) and
        stamp its data-ppt-h. Children untouched — never bakes JS-generated content."""
        text = _read_src(fs)
        n = locate_node(text, pl.get("root_id"), pl.get("indices"), pl.get("handle"))
        if not n:
            return {"ok": False, "error": "not found in source"}
        _checkpoint(fs, text, pl.get("txid"))
        tag = text[n["start"]:n["starttag_end"]]
        if pl.get("style_text") is not None:           # wholesale: source inline == DOM inline
            newtag = _set_style_attr(tag, pl["style_text"], pl.get("handle"))
        else:                                          # merge specific props
            newtag = update_start_tag(tag, pl.get("style") or {}, pl.get("handle"))
        _write_src(fs, text[:n["start"]] + newtag + text[n["starttag_end"]:])
        return {"ok": True}

    def src_text(fs, pl):
        """Replace an element's inner content (setText/setHTML), tags preserved. Also
        stamps the element's data-ppt-h handle on its start tag, so a text-edited node
        (often deeply nested + id-less) becomes handle-addressable and locates robustly
        on every later edit instead of re-deriving a fragile index path each time."""
        text = _read_src(fs)
        n = locate_node(text, pl.get("root_id"), pl.get("indices"), pl.get("handle"))
        if not n or n["end"] is None:
            return {"ok": False, "error": "not found in source"}
        _checkpoint(fs, text, pl.get("txid"))
        inner = pl.get("html")
        if inner is None:
            t = pl.get("text") or ""
            inner = (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        close = text.rfind("</" + n["tag"], n["starttag_end"], n["end"])
        if close < n["starttag_end"]:
            close = n["end"]
        starttag = text[n["start"]:n["starttag_end"]]
        handle = pl.get("handle")
        if handle and "data-ppt-h=" not in starttag:   # make it robust for next time
            starttag = _re.sub(r'\s*(/?>)\s*$', ' data-ppt-h="' + handle + r'"\1', starttag, count=1)
        _write_src(fs, text[:n["start"]] + starttag + inner + text[close:])
        return {"ok": True}

    def src_create(fs, pl):
        """Insert a new element's clean HTML as the last child of its parent."""
        text = _read_src(fs)
        parent = locate_node(text, pl.get("parent_root_id"), pl.get("parent_indices"), pl.get("parent_handle"))
        if not parent or parent["end"] is None:
            return {"ok": False, "error": "parent not found in source"}
        html = (pl.get("html") or "").strip()
        if not html:
            return {"ok": False, "error": "empty"}
        _checkpoint(fs, text, pl.get("txid"))
        close = text.rfind("</" + parent["tag"], parent["starttag_end"], parent["end"])
        if close < parent["starttag_end"]:
            close = parent["end"]
        _write_src(fs, text[:close] + "  " + html + "\n" + text[close:])
        return {"ok": True}

    def src_slide_create(fs, pl):
        """Insert a whole new `.slide` section (duplicate / blank) into source right
        after the anchor slide (`after_index` among source slides; <0 or out of range
        appends at the end), matching its indentation. Bails out cleanly if there are
        no slides to anchor to (blueprint fallback)."""
        html = (pl.get("html") or "").strip()
        if not html:
            return {"ok": False, "error": "empty"}
        text = _read_src(fs)
        p = _SpanParser(text)
        slides = _slide_nodes(p)
        if not slides:
            return {"ok": False, "error": "no slides to anchor to"}
        ai = pl.get("after_index")
        anchor = slides[ai] if isinstance(ai, int) and 0 <= ai < len(slides) else slides[-1]
        s = anchor["start"]
        i = s
        while i > 0 and text[i - 1] in " \t":
            i -= 1
        indent = text[i:s] if (i == 0 or text[i - 1] == "\n") else ""
        at = anchor["end"]
        _checkpoint(fs, text, pl.get("txid"))
        _write_src(fs, text[:at] + "\n" + indent + html + text[at:])
        return {"ok": True}

    def src_reorder(fs, pl):
        """Reorder the deck's top-level `.slide` sections in source to a new order.
        `order` is a permutation of old slide indices: order[k] = which source slide
        now sits in position k. Whole spans are moved as a block; bails out (ok:False,
        blueprint fallback) on anything it can't reorder cleanly — slide-count drift, a
        non-permutation, slides that aren't siblings, or non-whitespace between them
        (which would be dropped). Each slide keeps its own leading indentation."""
        order = pl.get("order")
        if not isinstance(order, list) or len(order) < 2:
            return {"ok": False, "error": "need an order of 2+ slides"}
        text = _read_src(fs)
        p = _SpanParser(text)
        slides = _slide_nodes(p)
        if len(slides) != len(order):
            return {"ok": False, "error": "slide count mismatch (%d in source, %d sent)"
                    % (len(slides), len(order))}
        if sorted(order) != list(range(len(slides))):
            return {"ok": False, "error": "order is not a permutation"}
        par = slides[0]["parent"]
        if any(s["parent"] != par for s in slides):
            return {"ok": False, "error": "slides are not siblings"}
        for a, b in zip(slides, slides[1:]):           # don't drop anything living between slides
            if text[a["end"]:b["start"]].strip():
                return {"ok": False, "error": "non-whitespace between slides"}

        def indent_of(n):
            s = n["start"]
            i = s
            while i > 0 and text[i - 1] in " \t":
                i -= 1
            return (text[i:s], i) if (i == 0 or text[i - 1] == "\n") else ("", s)

        inds = [indent_of(n) for n in slides]
        block_start = min(i for _, i in inds)          # leading indent of the first source slide
        block_end = slides[-1]["end"]
        units = [inds[k][0] + text[slides[k]["start"]:slides[k]["end"]] for k in order]
        _checkpoint(fs, text, pl.get("txid"))
        _write_src(fs, text[:block_start] + "\n".join(units) + text[block_end:])
        return {"ok": True}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            try:
                return json.loads(raw or b"{}")
            except Exception:
                return {}

        def _q(self):
            return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        # ---- GET -------------------------------------------------------------
        def do_GET(self):
            p = urllib.parse.urlparse(self.path).path
            if p == "/__info":
                return self._json({"tool": "claude-deckhand",
                                   "root": root, "port": port_box[0]})
            # Single-writer coordination probe (for a parallel Claude cleanup): the
            # file's current sha + when the GUI last wrote it. gui_active=true means a
            # live editing session is writing this file right now — re-read fresh and
            # hold off / ask before overwriting (see SKILL.md).
            if p == "/__srcinfo":
                q = self._q()
                rel = (q.get("file", [None])[0]) or ""
                fs = self.translate_path(rel) if rel else None
                if not fs or not (os.path.isfile(fs) and fs.lower().endswith(".html")):
                    return self._json({"ok": False, "error": "bad file"}, 400)
                with open(fs, "rb") as f:
                    blob = f.read()
                last = state.get("src_active", {}).get(fs)
                age = (time.time() - last) if last else None
                return self._json({"ok": True, "sha256": hashlib.sha256(blob).hexdigest(),
                                   "bytes": len(blob), "last_write_age_s": age,
                                   "gui_active": (age is not None and age < 20)})
            if p == "/__blueprint":
                with LOCK:
                    return self._json(load_bp())
            if p == "/__comments":
                with LOCK:
                    return self._json(load_cm())
            if p == "/__comment":
                q = self._q()
                try:
                    cid = int(q.get("id", [None])[0])
                except (TypeError, ValueError):
                    cid = None
                with LOCK:
                    c = find_cm(load_cm(), cid) if cid is not None else None
                return self._json(c or {}, 200 if c else 404)
            if p == "/__poll":
                q = self._q()
                try:
                    since = int(q.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                with LOCK:
                    rev = state["rev"]
                    if since > rev:
                        since = -1  # server restarted -> full resync
                    bp = load_bp()
                    cm = load_cm()
                    changed_edits = [e["handle"] for e in bp["edits"]
                                     if e["last_seq"] > since]
                    changed_comments = [int(c["id"]) for c in cm
                                        if int(c.get("rev", 0)) > since]
                    open_comment_ids = [int(c["id"]) for c in cm
                                        if c.get("status") != "done"]
                    return self._json({
                        "rev": rev,
                        "changed_edits": changed_edits,
                        "changed_comments": changed_comments,
                        "open_comment_ids": open_comment_ids,
                        "edit_total": len(bp["edits"]),
                        "comment_total": len(open_comment_ids),
                    })

            fs = self.translate_path(self.path)
            if fs.endswith(".html") and os.path.isfile(fs):
                with open(fs, "rb") as f:
                    html = f.read().decode("utf-8", "replace")
                if "</body>" in html:
                    html = html.replace("</body>", OVERLAY + "</body>", 1)
                else:
                    html += OVERLAY
                body = html.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

        # ---- POST ------------------------------------------------------------
        def do_POST(self):
            p = urllib.parse.urlparse(self.path).path

            # -- blueprint --------------------------------------------------
            if p == "/__op":
                payload = self._body()
                with LOCK:
                    bp = load_bp()
                    seq = bump_rev()
                    op = {
                        "seq": seq,
                        "handle": payload.get("handle"),
                        "anchor": payload.get("anchor"),
                        "op": payload.get("op"),
                        "value": payload.get("value") or {},
                        "ts": now_iso(),
                    }
                    bp["history"].append(op)
                    save_bp(bp)
                    return self._json({"ok": True, "rev": seq,
                                       "count": len(bp["edits"])})

            if p == "/__undo":
                with LOCK:
                    bp = load_bp()
                    if bp["history"]:
                        bp["history"].pop()
                        bump_rev()
                        save_bp(bp)
                    return self._json({"ok": True, "rev": state["rev"],
                                       "count": len(bp["edits"])})

            if p == "/__snapshot":
                payload = self._body()
                html = payload.get("html") or ""
                label = (payload.get("label") or "snapshot").replace("/", "_")
                with LOCK:
                    os.makedirs(versions_dir, exist_ok=True)
                    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                    fname = f"{label}-{stamp}.html"
                    with open(os.path.join(versions_dir, fname), "w",
                              encoding="utf-8") as f:
                        f.write(html)
                    bp = load_bp()
                    bp["snapshots"].append({"file": fname, "ts": now_iso(),
                                            "rev": state["rev"]})
                    bump_rev()
                    save_bp(bp)
                    return self._json({"ok": True, "file": fname})

            if p == "/__action-done":
                # Archive the current pass (blueprint + newest snapshot) into a
                # numbered version, then reset the working blueprint. Preserve by
                # default: this NEVER discards, it files the pass away.
                payload = self._body()
                note = payload.get("note")
                with LOCK:
                    bp = load_bp()
                    v = int(bp["meta"].get("version", 0)) + 1
                    os.makedirs(versions_dir, exist_ok=True)
                    vdir = os.path.join(versions_dir, f"version-{v:03d}")
                    os.makedirs(vdir, exist_ok=True)
                    archive = {"meta": {"version": v, "archived_at": now_iso(),
                                        "note": note},
                               "history": bp["history"],
                               "edits": bp["edits"],
                               "snapshots": bp["snapshots"]}
                    write_json(os.path.join(vdir, "blueprint.json"), archive)
                    fresh = {"meta": {"version": v}, "history": [],
                             "edits": [], "snapshots": []}
                    bump_rev()
                    fresh["meta"]["rev"] = state["rev"]
                    write_json(bp_file, fresh)
                    return self._json({"ok": True, "version": v})

            if p == "/__bp_clear":
                with LOCK:
                    bp = load_bp()
                    v = int(bp["meta"].get("version", 0))
                    bump_rev()
                    write_json(bp_file, {"meta": {"version": v, "rev": state["rev"]},
                                         "history": [], "edits": [], "snapshots": []})
                    return self._json({"ok": True})

            # -- live source write-back: Chrome edits the .html directly --------
            if p in ("/__src_style", "/__src_text", "/__src_create",
                     "/__src_delete", "/__src_undo", "/__src_undo_all",
                     "/__src_reorder", "/__src_slide_create"):
                pl = self._body()
                fs = self.translate_path(pl.get("file") or self.path)
                if not (os.path.isfile(fs) and fs.lower().endswith(".html")):
                    return self._json({"ok": False, "error": "bad file"}, 400)
                with LOCK:
                    bump_rev()
                    # A write must never crash the request (and drop the connection /
                    # kill an in-flight edit) — on failure, report ok:false so the
                    # overlay flashes "not saved" instead of silently dropping.
                    try:
                        if p == "/__src_style":
                            res = src_style(fs, pl)
                        elif p == "/__src_text":
                            res = src_text(fs, pl)
                        elif p == "/__src_create":
                            res = src_create(fs, pl)
                        elif p == "/__src_reorder":
                            res = src_reorder(fs, pl)
                        elif p == "/__src_slide_create":
                            res = src_slide_create(fs, pl)
                        elif p == "/__src_delete":
                            res = src_delete(fs, pl)
                        elif p == "/__src_undo_all":
                            res = src_undo_all(fs)
                        else:
                            res = src_undo_last(fs, pl.get("txid"))
                    except Exception as e:
                        res = {"ok": False, "error": "write failed: %s" % e}
                return self._json(res)

            # -- comments (same contract as the annotate skill) -------------
            if p == "/__comment":
                payload = self._body()
                with LOCK:
                    data = load_cm()
                    cid = max((int(c.get("id", 0)) for c in data), default=0) + 1
                    payload["id"] = cid
                    payload["status"] = "open"
                    payload["timestamp"] = now_iso()
                    payload["rev"] = bump_rev()
                    payload.setdefault("thread", [])
                    data.append(payload)
                    write_json(cm_file, data)
                    return self._json({"ok": True, "id": cid, "count": cm_open(data)})

            if p == "/__update":
                payload = self._body()
                cid = payload.get("id")
                text = (payload.get("comment") or "").strip()
                with LOCK:
                    data = load_cm()
                    c = find_cm(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    if text:
                        c["comment"] = text
                    c["status"] = "open"
                    c.pop("addressed_at", None)
                    c["edited_at"] = now_iso()
                    c["rev"] = bump_rev()
                    write_json(cm_file, data)
                    return self._json({"ok": True, "count": cm_open(data)})

            if p == "/__delete":
                payload = self._body()
                cid = payload.get("id")
                with LOCK:
                    data = load_cm()
                    c = find_cm(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    data = [x for x in data if int(x.get("id", -1)) != int(cid)]
                    bump_rev()
                    write_json(cm_file, data)
                    return self._json({"ok": True, "count": cm_open(data)})

            if p == "/__done":
                payload = self._body()
                cid = payload.get("id")
                note = payload.get("note")
                with LOCK:
                    data = load_cm()
                    c = find_cm(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    c["status"] = "done"
                    c["addressed_at"] = now_iso()
                    if note:
                        c.setdefault("thread", []).append(
                            {"author": "claude", "text": note, "ts": now_iso()})
                    c["rev"] = bump_rev()
                    write_json(cm_file, data)
                    return self._json({"ok": True, "count": cm_open(data)})

            if p == "/__reply":
                payload = self._body()
                cid = payload.get("id")
                text = (payload.get("text") or "").strip()
                with LOCK:
                    data = load_cm()
                    c = find_cm(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    if not text:
                        return self._json({"ok": False, "error": "empty"}, 400)
                    c.setdefault("thread", []).append(
                        {"author": "user", "text": text, "ts": now_iso()})
                    c["status"] = "open"
                    c.pop("addressed_at", None)
                    c["rev"] = bump_rev()
                    write_json(cm_file, data)
                    return self._json({"ok": True, "count": cm_open(data)})

            if p == "/__clear":
                mode = self._q().get("mode", ["done"])[0]
                with LOCK:
                    data = load_cm()
                    if mode == "all":
                        keep = []
                    else:
                        keep = [c for c in data if c.get("status") != "done"]
                    bump_rev()
                    write_json(cm_file, keep)
                    return self._json({"ok": True, "count": cm_open(keep)})

            self.send_error(404)

        def log_message(self, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.getcwd())
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--base-port", type=int, default=8800)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    ann_dir = os.path.join(root, ".annotate")
    os.makedirs(ann_dir, exist_ok=True)
    gi = os.path.join(ann_dir, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w", encoding="utf-8") as g:
            g.write("*\n!.gitignore\n")

    # seed the rev counter from whatever is on disk so cursors stay monotonic
    bp = read_json(os.path.join(ann_dir, "blueprint.json"),
                   {"meta": {}, "history": []})
    cm = read_json(os.path.join(ann_dir, "comments.json"), [])
    rev = max([op.get("seq", 0) for op in bp.get("history", [])] +
              [int(c.get("rev", 0)) for c in cm] +
              [int(bp.get("meta", {}).get("rev", 0))], default=0)
    state = {"rev": rev}

    os.chdir(root)
    port = args.port if args.port else find_free_port(args.base_port)
    port_box = [port]

    socketserver.ThreadingTCPServer.allow_reuse_address = (os.name == "posix")
    handler = make_handler(root, ann_dir, port_box, state)
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"EDITOR_URL=http://127.0.0.1:{port}/", flush=True)
        print(f"Deckhand editor server: http://127.0.0.1:{port}/", flush=True)
        print(f"Project root: {root}", flush=True)
        print(f"Open a page, e.g. http://127.0.0.1:{port}/<your-file>.html", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
