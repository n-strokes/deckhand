# Deckhand

Turn Chrome into a PowerPoint-style editor for any HTML page, and write every edit straight back into the source file.

A browser can show HTML, but it cannot save changes back to disk. Deckhand adds the save half. A small local Python server (standard library only, nothing to install) serves your project and adds an editing layer to any `.html` file. You turn the editor on, then select, drag, resize, retype, format, add shapes, align, restack, and reorder slides. Each edit is written back into the real `.html` source right away. When you stop, the file is already done. There is no separate export or apply step.

## Why it is different

Most visual editors write the whole page back to disk at once. That reorders attributes, drops comments, collapses whitespace, and bakes in the editor's own markup, so clean source turns to junk. Deckhand does not do that. It edits by exact character position and changes only the bytes that need to change.

- A parser records each element's exact span in the raw source.
- Move, resize, and format rewrite only the element's start-tag `style`. Children are left alone, so content that JavaScript draws (SVG or canvas) is never frozen into the file.
- Text edits, create, delete, and slide reorder each change the smallest amount needed. Comments, indentation, and nearby markup are kept.
- Writes are atomic (temp file plus `os.replace`), so a reader never sees a half-written file.
- Undo is grouped by action. One action, even a held-down arrow key, is one undo step that reverts the page and restores the source exactly.

If an edit's element cannot be found in the source, the server changes nothing and the editor shows a warning. Nothing is lost without you knowing.

## Requirements

- Python 3 (standard library only)
- Google Chrome, or any Chromium browser

## Quick start

```bash
python3 editor_server.py --root /path/to/your/project
```

The server prints a line like `EDITOR_URL=http://127.0.0.1:8800/`. Open your page through that address, not through `file://`, or the editor cannot reach the server.

```
http://127.0.0.1:8800/your-page.html
```

Click OFF to ON in the top bar, then edit.

- Click to select. Shift-click or shift-lasso to select several. Cmd/Ctrl-click to toggle one.
- Drag the body to move (shift-drag locks to one axis). Drag the blue handles to resize. Arrow keys nudge.
- Double-click or press Enter to edit text. The ribbon gives bold, italic, underline, numeric font size, bullets, text and fill and outline color, alignment, z-order, group, and distribute.
- The +text, +rect, +oval, and +line buttons arm placement.
- Cmd/Ctrl+Z undoes. The slide sorter reorders slides. Cmd/Ctrl+M and +D add or duplicate a slide.
- The comment button works with the editor on or off.

Edits save to the `.html` as they happen. Close the tab when you are done.

## Two tiers of editing

The editor turns on for any HTML. What you can do depends on the action, not the file.

Tier 1 works anywhere. Text editing, text formatting, and drag or resize on any element. These change an element's own content or style, so they need no fixed frame.

Tier 2 needs a positioning frame. The geometry tools (align, distribute, z-order, exact position) only mean something when shapes sit at absolute positions in a known coordinate frame. Those tools appear only when the selection is inside a `.slide`, `#stage`, or `[data-ppt-stage]` element. A fixed slide stage, for example `section.slide` at 1280x720, is such a frame.

## Known limits

- The first edit of an element with no id, inside JavaScript-drawn SVG or a browser-inserted `<tbody>`, can fail to locate. The editor warns and keeps that edit on screen only. Once an element is touched it gets a stable handle and is reliable after that.
- Browser-reserved shortcuts (Cmd/Ctrl+N, +T, +W) cannot be caught by a web page.
- Writing pixel positions onto responsive content freezes how it responds. This is fine on a fixed slide stage and less so elsewhere.
- Animations and transitions, slide masters, WordArt fidelity, and editing charts are out of scope.

## Files

- `editor_server.py` is the local server and the source-write engine.
- `editor_overlay.js` is the browser editing layer that gets added to served pages.
- `SKILL.md` is the full design spec and endpoint reference.

## Optional companions

The core is self-contained. Two features point to companion tools if you use them: comments (an annotate-style server) and export to `.pptx` (a build-from-HTML step). Neither is needed to edit pages.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 n-strokes.
