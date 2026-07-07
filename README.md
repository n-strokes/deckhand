# Deckhand

**Turn Chrome into a PowerPoint-style editor for any HTML page — and write every edit straight back into the source file.**

A browser can render HTML, but it can't save changes back to disk. Deckhand is the missing write half. A tiny local Python server (pure stdlib, no dependencies) serves your project and injects an editing overlay into any `.html` file. You flick the editor **on**, then select, drag, resize, retype, format, add shapes, align, restack, and reorder slides — exactly the moves of a slide editor — and each edit is spliced back into the real `.html` source **immediately**. When you stop, the file is already done. There is no separate "export" or "apply" step.

## Why it's different

Most WYSIWYG tools re-serialize the whole DOM back to disk, which reorders attributes, drops comments, collapses whitespace, and bakes in injected editor markup — turning clean source into sludge. Deckhand doesn't do that. It edits **surgically, by character offset**, touching only the bytes that must change:

- A position-aware parser records each element's exact span in the raw source.
- Move / resize / format rewrite only the element's start-tag `style` attribute — children are left untouched, so JS-generated SVG/canvas content is never frozen into the file.
- Text, create, delete, and slide-reorder each splice the minimum needed. Comments, indentation, and sibling markup are preserved.
- Writes are atomic (temp file + `os.replace`), so a reader never sees a half-written file.
- Undo is transaction-grouped: one user action — even a held-arrow nudge burst — is one undo step that reverts the DOM *and* restores the source exactly.

If an edit's element can't be located in source, the server makes **no change** and the overlay flashes a warning — nothing is silently lost.

## Requirements

- Python 3 (standard library only — nothing to install)
- Google Chrome (or any Chromium browser)

## Quick start

```bash
python3 editor_server.py --root /path/to/your/project
```

The server prints a line like `EDITOR_URL=http://127.0.0.1:8800/`. Open your page through that URL (**not** `file://`, or the overlay can't reach the server):

```
http://127.0.0.1:8800/your-page.html
```

Click **OFF → ON** in the top bar, then edit:

- **Click** to select; Shift-click or Shift-lasso to multi-select; Cmd/Ctrl-click to toggle.
- **Drag** the body to move (Shift-drag locks to one axis); drag the blue **handles** to resize; **arrow keys** nudge.
- **Double-click** or Enter to edit text; the ribbon gives bold/italic/underline, numeric font size, bullets, text/fill/outline color, alignment, z-order, group, distribute.
- **+text / +rect / +oval / +line** arm placement.
- **Cmd/Ctrl+Z** undoes; the slide **sorter** reorders slides; **Cmd/Ctrl+M / +D** add or duplicate a slide.
- **💬 Comment** works with the editor on or off.

Edits save to the `.html` as they happen. Close the tab when you're done.

## The two-tier model

The editor turns on for **any** HTML. What you can do depends on the operation, not the file.

**Tier 1 — works anywhere.** Text editing, text formatting, and drag/resize on any element. These mutate an element's own content or styling, so they need no fixed stage.

**Tier 2 — needs a positioning context.** The geometry suite (align, distribute, z-order, exact-position) only means something when shapes are absolutely positioned in a known coordinate frame. Those tools appear only when the selection sits inside a `.slide`, `#stage`, or `[data-ppt-stage]` element. A fixed slide stage (e.g. `section.slide` at 1280×720) is exactly such a frame.

## Known limits

- First-edit locating of an id-less element inside JS-generated SVG or a browser-inserted `<tbody>` can fail; the overlay warns and the edit stays visual-only. Once an element is touched it gets a stable handle and is robust after that.
- Browser-reserved shortcuts (Cmd/Ctrl+N/T/W) can't be captured by a page.
- Writing pixel geometry onto responsive content freezes its responsiveness — fine on a fixed slide stage, less so elsewhere.
- Animations/transitions, slide masters, WordArt fidelity, and chart *editing* are out of scope.

## Files

- `editor_server.py` — the local server and surgical source-write engine.
- `editor_overlay.js` — the browser editing overlay (injected into served pages).
- `SKILL.md` — the full design spec and endpoint reference.

## Optional companions

Deckhand's core is self-contained. Two features reference companion tooling if you use it: comment coexistence (an `annotate`-style server) and export to `.pptx` (a derive-from-HTML step). Neither is required to edit pages.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 n-strokes.
