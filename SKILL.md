---
name: deckhand
description: Deckhand — turn the Chrome browser into a PowerPoint-style direct-manipulation editor for an HTML page, backed by a local server that writes every edit straight back into the real .html source. Use when the user wants to edit an HTML page or slide deck visually in the browser (select, drag, resize, retype text, format, add text boxes / shapes / lines, align, z-order, reorder slides) and have those edits land in the source file immediately — no separate "apply" step. Triggers include "start the editor loop", "open deckhand", "start the deckhand loop", "let me edit this page in the browser", "edit deck.html visually", "open the PPT editor", "turn my browser into PowerPoint", and "drag these boxes around". Because edits write to source live, Claude's only follow-up role is OPTIONAL cleanup on request ("tidy up what I did", "reconcile my edits") — the file is already done when the user stops. Pairs with the annotate and html-slide-deck skills and reuses the same local-server pattern. Self-contained — the Python server and browser overlay ship inside this skill.
---

# Deckhand — live HTML/PowerPoint editor

A tiny local Python server gives any served HTML page a PowerPoint-style editing overlay.
The user flicks the editor **on**, then selects elements, drags them, resizes them with
handles, retypes and formats text, adds text boxes / rectangles / ovals / lines, aligns and
re-stacks shapes, reorders slides, and leaves comments — exactly the moves of a slide editor,
in the browser.

**The browser only has read.** Chrome renders HTML but can't persist edits to a file on its
own. This server is the missing write half: **every browser edit is written straight back into
the `.html` source, immediately and surgically.** When the user stops editing, the file is
already done — Claude does not need to touch it. Chrome is, in effect, a direct HTML editor for
that file, with the middle layer removed.

> **This is the current model.** Earlier versions recorded edits into a `blueprint.json` that
> Claude later "actioned" into source in a second phase. That indirection is gone by default:
> edits hit the source as they happen. A blueprint is still written as a lightweight **change
> log** (so `edits(N)` has a count and an optional audit trail), and a `localStorage` flag
> (`pptEdSrc='0'`) falls back to the old blueprint-only behavior if ever needed — but the
> default, and the thing to reason about, is **live source write-back.**

## What "write to source" means (and why it stays clean)

The server never re-serializes the DOM back to disk (that yields normalized "sludge" — reordered
attributes, dropped comments, collapsed whitespace — and would bake in the injected overlay).
Instead it edits the source **surgically**, by character offset, touching only the bytes that
must change:

- A position-aware HTML parser records each element's `[start, end)` span in the raw source.
- An element is addressed by a stable `data-ppt-h` handle (stamped on first edit), else by its
  nearest ancestor `id` + a child-index path, else (for slides) by its ordinal among `.slide`s.
- **Move / resize / format** rewrite only the element's **start-tag `style` attribute** —
  children are left untouched, so JS-generated SVG / canvas content is never frozen into source.
- **Text edits** replace only the element's inner content; **create** splices a clean new node
  in; **delete** removes exactly the element's span; **reorder** moves whole `.slide` spans as a
  block. Everything around the edit — comments, indentation, sibling markup — is preserved.

If an edit's element **can't be located** in source (an id-less node whose live DOM index path
diverges from the file — e.g. inside a browser-inserted `<tbody>` or JS-generated SVG), the
server makes **no change** and the overlay flashes a visible warning. Nothing is silently lost
or left hanging: the user knows that edit is visual-only and can ask Claude to reconcile it.

---

## The two-tier model (what works where)

The editor flicks on for **any** HTML. What you can do depends on the **operation**, not the file.

**Tier 1 — general HTML (works anywhere; no canvas needed).** Direct text editing; text
formatting (font size, bold/italic/underline, color via the native EyeDropper, bullets);
drag/move and resize on any element. These mutate an element's own content/styling, so they need
no fixed stage.

**Tier 2 — needs a positioning context / fixed canvas.** The PowerPoint geometry suite — align
left/center/right/top/middle/bottom, distribute, z-order, exact-position — only *means* something
when shapes are absolutely positioned in a known coordinate frame. The overlay shows these tools
only when the selection sits inside a `.slide`, `#stage`, or `[data-ppt-stage]` element (the
[[html-slide-deck]] skill's `section.slide` at fixed 1280x720 is exactly such a stage). Outside a
stage, geometry ops are hidden; text and gesture-drag still work.

A "shape" the user adds (text box, rect, oval, line) is just an absolutely-positioned `div`
inside the stage; its **contents** can be any HTML. The stage constrains only the shape layer's
coordinates, never the content.

---

## Phase 1 — launch the server (when invoked)

1. **Pick the project root and page.** Root = the directory of the HTML file named, else the cwd.
   Note the page filename so you can hand back a ready URL.
2. **Reuse an existing server if it already serves this project.** Probe `88xx` listeners for
   `/__info`; if a `root` resolves to the same project, reuse it and report its URL.
   ```bash
   curl -s http://127.0.0.1:PORT/__info   # tool == "claude-deckhand" and same root -> reuse
   ```
3. **Otherwise launch a new server (background).**
   ```bash
   python3 -u ~/.claude/skills/deckhand/editor_server.py --root "<PROJECT_ROOT>"
   ```
   Run with `run_in_background: true`. It prints `EDITOR_URL=http://127.0.0.1:<port>/`; read the
   background output and capture the exact port (8800 only if free).
4. **Hand back the URL + workflow, then STOP.**
   - Open `http://127.0.0.1:<port>/<page>.html` (must be this URL, **not** `file://`, or the
     overlay's `fetch` calls can't reach the server).
   - Click **off → ON** in the top bar. Then: **click** to select (Shift-click / Shift-lasso to
     multi-select, Ctrl/Cmd-click to toggle one in/out); **drag** the body to move
     (**Shift-drag** locks to one axis); drag the blue **handles** to resize; **arrow keys**
     nudge; **double-click** or Enter to edit text; expand the **ribbon** for bold/italic/
     underline, numeric font size, bullets (toggle), text/fill/outline color, text alignment,
     z-order, group, distribute. **+text / +rect / +oval / +line** arm placement. **Ctrl/Cmd+Z**
     undoes; the slide **sorter** reorders slides; **Ctrl/Cmd+M / +D** add / duplicate a slide.
     **💬 Comment** works with deckhand on or off.
   - **Edits save to the source `.html` as they happen — there is no "apply" step.** The user can
     just close the tab when done. Tell them so.

   After handing over the URL, **stay idle.** There is no polling loop to run. Only act again if
   the user explicitly asks for cleanup (next section).

---

## Phase 2 — optional cleanup (only when the user asks)

Because edits are already in the source, there is **no mandatory action loop**. Engage only on an
explicit request like "tidy up my edits", "reconcile what I did", "clean up the source", or a
specific fix. When you do:

1. **Check for a live editing session first.** `GET /__srcinfo?file=/<page>.html` →
   `{sha256, bytes, last_write_age_s, gui_active}`. If `gui_active` is true, the user is actively
   writing the file right now — say so and hold off (or coordinate) rather than racing their
   edits. The server's writes are atomic, so you'll never read a torn file, but you can still lose
   each other's changes if you both write blind.
2. **Read the source fresh, immediately before editing** (it has the user's live edits — never
   work from a stale copy or a remembered version).
3. **Treat the user's direct edits as near-canonical — follow them, never undo them.** Every move,
   resize, retype, format, create, delete, and reorder is already in the file because the user did
   it deliberately. Your job is only to *improve the implementation on top of intent*: snap a
   near-aligned move to a true alignment, replace a raw inline style with the deck's own
   class/idiom, tidy coordinates, fix an edit the overlay flagged as visual-only (couldn't locate
   in source). Never drop or "correct away" what the user changed.
4. **Read comments too** (`GET /__comments`) — a comment may explain a change or ask for one;
   action edits + comments together. For an actioned comment, `POST /__done {id, note}`.
5. **If genuinely ambiguous, ask before editing.** When you edit the source yourself, use the
   normal file tools — they write atomically, same as the server.

There is no archive/version step in this model. The source file *is* the artifact. The user's own
**Undo** (below) and ordinary version control are the safety net.

---

## Undo — preserved, and transaction-exact

Undo is a first-class guarantee, not a nicety. The server keeps a stack of **file snapshots**;
the browser keeps a matching stack of visual reverts. One Cmd/Ctrl+Z reverts the DOM *and*
restores the source to exactly its state before that action.

The mechanism is **transaction grouping by `txid`**: every source write for one user action
carries the same txid, and the server checkpoints the file **once per txid**. So:
- A multi-element move, a `setText`+`setHTML` pair, or a whole held-arrow **nudge burst** all
  collapse to **one** undo step.
- Undo pops a checkpoint **strictly by txid**, so an action whose writes failed to locate (and
  therefore changed nothing) is a no-op on undo — it can **never over-pop into an unrelated
  earlier edit**.
- **Undo all** restores the pre-session file in a single, race-free call.

Holding an arrow key is coalesced: the DOM moves live on every keypress, but the source write and
the undo step fire **once** when the burst settles (~450ms idle), so a long press is one clean
file write and one undo step — not hundreds.

(Undo covers actions taken in the current page session; edits already on disk from before load
aren't on the stack — use version control for those.)

---

## Server endpoints

- `GET /__info` → `{tool:"claude-deckhand", root, port}` (reuse detection).
- `GET /__srcinfo?file=…` → `{ok, sha256, bytes, last_write_age_s, gui_active}` — single-writer
  coordination: is a live GUI session writing this file right now?
- **Live source writes** (browser → server; each carries a `txid` for undo grouping):
  - `POST /__src_style {file, txid, handle, root_id, indices, style_text}` — move/resize/format
    (rewrites the start-tag style; `style_text` is the whole inline style, transforms collapsed).
  - `POST /__src_text {file, txid, …locator, text|html}` — set inner text / HTML.
  - `POST /__src_create {file, txid, parent_*, html}` — splice a new element into its parent.
  - `POST /__src_delete {file, txid, …locator}` — remove the element's span.
  - `POST /__src_reorder {file, txid, order}` — reorder `.slide` sections; `order` is a
    permutation of old slide indices. Bails out (no change) if it can't reorder cleanly.
  - `POST /__src_slide_create {file, txid, after_index, html}` — insert a whole new slide after a
    source slide.
  - `POST /__src_undo {file, txid}` — revert exactly that transaction (by txid; no-op if it made
    no checkpoint). `POST /__src_undo_all {file}` — restore the pre-session file.
  - All write responses are `{ok:bool, …}`; `ok:false` (e.g. element not found) triggers the
    overlay's "edit not saved to source" flash.
- **Change-log / comments** (kept for the count + optional audit): `GET /__blueprint`,
  `POST /__op`, `POST /__undo`; comments same contract as annotate: `POST /__comment` ·
  `/__update` · `/__delete` · `/__done {id,note}` · `/__reply {id,text}` · `/__clear`.

## Persistence & lifecycle

- The **`.html` source is the canonical artifact** and is written live (atomically: temp file +
  `os.replace`, so no reader ever sees a half-written file).
- `<root>/.annotate/` holds the change log (`blueprint.json`) and `comments.json` only. In the
  live model the blueprint is a count + audit trail, not a thing you replay.
- The undo stack (file snapshots) lives in the running server's memory for the session.

## Honest limits (don't fight these)

- **First-edit locating** of an id-less element inside JS-generated SVG or a browser-inserted
  `<tbody>` can fail — the DOM index path diverges from source. The overlay flashes a warning and
  the edit stays visual-only; once an element is touched it gets a stable handle and is robust
  thereafter. Reorder/slide-create bail out cleanly rather than risk mis-splicing.
- **Browser-reserved shortcuts** (Cmd/Ctrl+N, +T, +W) can't be captured by a page.
- **App-chrome ops don't port** (PowerPoint ribbon navigation, slideshow-playback tooling).
- **Responsive flow + fixed geometry fight** — writing px geometry onto responsive content
  freezes its responsiveness. Fine on a fixed slide stage; elsewhere prefer the gentlest lever.
- **Sub-projects, not checkboxes** — animations/transitions, slide masters, WordArt fidelity,
  chart *editing*. Each is its own build.

## Extending (notes for Claude Code)

- **Keyboard shortcuts** live in `KEYMAP` in `editor_overlay.js` (a combo→handler table with a
  Cmd↔Ctrl-normalizing `combo()`).
- **Source-write engine** is in `editor_server.py`: `_SpanParser` (offsets), `locate_node` /
  `locate_span` / `_slide_nodes` (addressing), and the `src_*` write closures + `_checkpoint`
  (txid-grouped undo). The overlay's `srcWrite` / `srcSlideCreate` / `srcUndo` mirror them.
- **Editor UI** is tagged `[data-ppt-ui]` (ignored by selection, stripped from writes/snapshots).
  **Added content** is tagged `[data-ppt-shape]` and a stable `[data-ppt-h]` handle.
- **Restart after editing** the server or overlay (both are read once at server start).
  **Always restart on the same port** the running server used — capture it (launch output or
  `GET /__info`), kill that PID, relaunch with `--port <same>` and the same `--root`, so the URL
  stays stable and the user just refreshes the tab. ([[restart-server-same-port]])
- **Coexists with annotate** — both use `.annotate/` and the same comment contract; run one server
  per project. This server is a superset (live edits + comments) of the annotate server.

## Export to PowerPoint

The HTML you edit here is the single source of truth. To turn it into a PowerPoint, use the
[[html-slide-deck]] skill's canonical **derive-from-HTML** tool (`derive_pptx/html_to_pptx.py`) —
it reads the live HTML and emits native PPT objects via COM, with an `--increment` mode that
rebuilds only changed slides. Never hand-code slide content into a PPT script: that drifts the
moment you edit the HTML. Putting a stable `id` on each `<section class="slide">` makes the
incremental export robust.
