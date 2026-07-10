---
name: html-slide-deck
description: Iterate on a slide deck as a single HTML file built deck-style (fixed 16:9 slides, on-screen nav) for fast editing and clean export, then export it to PowerPoint. Use when the user wants to mock up / iterate on slides in HTML — "build this as an HTML deck", "make slide N into an HTML slide", "turn these slides into HTML", "add a slide to the html deck", "screenshot the deck", "export the deck to ppt", "render the html to powerpoint", "make a ppt rendition". Bidirectional: slides may be recreated from a referenced .pptx, authored fresh in HTML, or pushed back into PowerPoint. The reference build is a placeholder set on first use (see SKILL.md).
---

# HTML slide deck loop

The user iterates on slide decks as **one self-contained HTML file** — each slide a
fixed-size `<section class="slide">`, paged by an on-screen nav, styled to a clean deck
standard so it reads like a real deck and exports cleanly. HTML is the fast
medium: edit, preview in the browser, screenshot, and when asked, render to `.pptx`.

> **No bundled reference deck.**
> This skill ships no example deck. Author a fresh deck from the conventions below (they are
> fully self-contained and need no reference file), or point it at your own deck. Treat the
> "Deck file conventions" section below as the single source of truth for structure.

> **Platform note (macOS).** This skill was authored on Windows (PowerPoint COM, win32com,
> Windows Chrome paths) and has been adapted for macOS. `capture_slides.py` now probes the
> macOS Chrome path, and `render_pptx.py` has been rewritten to use **python-pptx**
> (cross-platform) instead of PowerPoint COM, so the QUICK export works natively on a Mac.
> The COM-based "full export" and the COM ingest path do not run on macOS — substitutes are
> noted inline below.

---

## Deck file conventions (author every deck to match these exactly)

Follow clean PowerPoint typography standards — a single sans-serif family throughout (the
author's house standard was **Calibri**, Text 2 navy `#071D49` for all text), sentence-case
titles, ≥11pt body. The HTML just renders those same rules on screen. Core chrome:

- **Slide box**: `width:1280px; aspect-ratio:16/9;` white, one `<section class="slide">`
  per slide; only `.slide.active` is shown (`display:block`, others `none`). 1280×720 is
  the 16:9 canvas — keep everything inside it so export is full-bleed with no cropping.
- **Title / sub**: `h1.title` (≈27px, weight 400) and `p.sub` (≈15px, `--navy-soft`).
- **Nav** (`<nav class="nav">`): fixed pill bar with ‹ › buttons, a dot per slide, and a
  `idx+1 / N · title` label. A `titles[]` array holds the per-slide nav labels — **keep it
  in sync** when you add/remove/reorder slides.
- **`show(i)`**: the global that activates the i-th `.slide`. Capture and any harness rely
  on it; every deck must expose it. Arrow keys / PageUp-Down page the deck.
- **Refresh keeps the current slide.** `show(i)` must persist the active index to the URL
  hash (`location.hash = '#' + (i+1)`, slide numbers 1-based), and on load the deck must read
  that hash and open that slide instead of always starting at slide 0. A page refresh (or a
  capture harness calling `show(n)`) therefore stays put rather than jumping back to the
  beginning. Pattern:
  ```js
  function show(i){
    i = Math.max(0, Math.min(titles.length - 1, i));   // clamp
    current = i;
    // …activate the i-th .slide, update nav/dots…
    history.replaceState(null, '', '#' + (i + 1));      // replaceState = no new history entry
  }
  function initFromHash(){
    var n = parseInt((location.hash || '').slice(1), 10);
    show(isNaN(n) ? 0 : n - 1);                          // clamp handles out-of-range
  }
  window.addEventListener('DOMContentLoaded', initFromHash);
  window.addEventListener('hashchange', initFromHash);   // back/forward + manual #edits
  ```
  Use `history.replaceState` (not assigning `location.hash` directly) inside `show()` so paging
  doesn't flood browser history. When **migrating an existing deck**, retrofit this same hash
  read/write onto its `show()` and add the two listeners — don't rebuild the deck.
- **Palette as CSS vars** in `:root` (navy, navy-soft, grey `#8497B0`, callout `#F3F5F8`,
  per-theme node colors). Reuse them; don't hardcode stray hexes.
- Charts/diagrams are **inline SVG built in JS**. Footnotes: `div.footnote`, ~11px, bottom-left.

When **adding or rewriting a slide**, build it as one more `.slide` section in the same
idiom and register its nav label in `titles[]`. This is a big single-file artifact — when
generating a whole new deck or a large slide, write it section by section, not all in one shot.
Before editing a deck the user has also been editing, read the live file and let it govern —
never replay an old build script over the user's own edits.

### Author so the deck edits cleanly in deckhand

These decks get edited visually in the [[deckhand]] skill, which writes each change straight
back into this source file's inline `style`. Two authoring habits keep those writes clean:

- **Use longhand CSS, never shorthands, for anything that might be edited visually.** Deckhand
  writes longhands (`background-color`, `border-color`, `font-size`, …). If the source used a
  *shorthand* (`background:`, `font:`, `border:`, `margin:`, `padding:`), the browser explodes
  it into longhands the moment deckhand sets one — and emits the unset ones as empty
  declarations (`background-image: ;`), which is invalid CSS. **The big one: write
  `background-color: var(--grey)`, not `background: var(--grey)`.** (Deckhand now strips empty
  declarations defensively, so this no longer corrupts the file — but clean longhand source
  avoids the churn and any reliance on that safety net.)
- **Give editable boxes a stable hook.** An `id` (or a distinctive class) on a container/box/
  cell makes its very first deckhand edit locate reliably and stay stable across structural
  changes. Deckhand auto-stamps a `data-ppt-h` handle on first edit, but a deeply nested,
  id-less inline element (e.g. a `<span>` chip inside a flex row) is the hardest thing to
  locate on that first touch — an `id` on it or its parent box removes the risk.

## Ingest — recreate a referenced .pptx slide as HTML

Read the source `.pptx` and rebuild each named slide as a `.slide` section in the deck's idiom
(a clean deck-native reconstruction, not a pixel tracing). Pull the slide's text, structure,
colors, and any images.

- **macOS:** read the `.pptx` with **python-pptx** (or invoke the `pptx` skill). The original
  Windows COM path (`GetActiveObject("PowerPoint.Application")`) does not exist on macOS — use
  python-pptx to enumerate `slide.shapes`, text frames, and images instead.
- Images the slide needs go in the deck's `img/` folder and are referenced with **relative** paths.

## Preview

Serve the project root over HTTP so the deck's relative `img/` paths resolve, then open
`…/<deck>.html`. The [[annotate]] skill already runs exactly such a static server (and powers
click-to-comment feedback) — reuse it if it's running; its `/__info` reports the port. Otherwise:
```bash
cd "<project root>" && python3 -m http.server 8000
# then open http://127.0.0.1:8000/<deck>.html
```

## Export to PowerPoint

Two modes — the user picks. **Default to QUICK** unless they say "full".

### Quick export — full-bleed screenshots (default)
A faithful picture of each HTML slide, one per `.pptx` slide. Fast, exact, not editable.

```bash
# from the project root:
python3 ~/.claude/skills/html-slide-deck/capture_slides.py <deck>.html   # -> <deck-dir>/shots/slideNN.png
python3 ~/.claude/skills/html-slide-deck/render_pptx.py <deck-dir>/shots --out <name>_html_rendition.pptx
```

- `capture_slides.py` drives **headless Chrome** against a throwaway harness that loads the
  deck in a 1280×720 iframe, hides the nav + any annotate widget, and calls `show(n)` per
  slide. `--scale 2` (default) yields crisp 2560×1440 PNGs. `--slides 0,2,5` for a subset.
- `render_pptx.py` (rewritten for macOS using **python-pptx**) drops each PNG full-bleed onto a
  blank 16:9 slide. No PowerPoint install required. Name the output `*_html_rendition.pptx`.
- Install the one dependency once. Your Mac uses a Homebrew/externally-managed Python
  (PEP 668), so install it in an isolated way rather than into system Python, e.g.
  `pipx install python-pptx` OR a project venv (`python3 -m venv .venv && . .venv/bin/activate && pip install python-pptx`).
  As a last resort: `pip3 install --user --break-system-packages python-pptx`.

### Full export — native PowerPoint objects (canonical, derive-from-HTML)
Rebuild **every element** as real PPT shapes/text/tables so the deck is fully editable in
PowerPoint. **Use the canonical two-stage tool in `derive_pptx/` — never hand-code per-deck
content.** Hard-coding slide text/geometry from memory is exactly how a prior build silently
*drifted* to an outdated copy of the HTML; this tool reads every value from the **live HTML**
each run, so the PPT cannot drift.

```bash
# Windows; the target .pptx must be OPEN in PowerPoint (house standard: COM via pywin32).
python ~/.claude/skills/html-slide-deck/derive_pptx/html_to_pptx.py DECK.html --pres "Name" --fresh       # first/clean build
python ~/.claude/skills/html-slide-deck/derive_pptx/html_to_pptx.py DECK.html --pres "Name" --increment   # only changed slides
```

- **Stage 1 `extract_slides.py`** drives headless Chrome over the deck and records each slide's
  **computed** geometry/style/text/tables (relative to the `.slide`, 1280×720 px) into
  `<deck>.slides.json`. It POSTs each slide back to its own http.server (no DevTools, no deps).
- **Stage 2 `render_pptx_com.py`** emits native objects via COM into the active PowerPoint at
  `px*0.75 = points`, Calibri / navy `#071D49`, per `~/.claude/CLAUDE.md` house standards.
  Each shape is tagged (`AlternativeText="DH:<key>:<role>"`) and each slide stamped
  (`Tags DHKEY/DHHASH`) for incremental reconcile.
- **Increment mode** keeps a manifest `<deck>.ppt-build.json` (per slide: key, content hash,
  position). `--increment` rebuilds **only** slides whose content changed; untouched slides are
  never touched (no "non-updated printing press"). Default `--rebuild-mode merge` clears only
  renderer-owned shapes so **manual PowerPoint edits survive**; `replace` rebuilds the whole
  slide. It reconciles by slide **key** (section `id`, else a title fingerprint) and PPT
  **SlideID**, and **falls back to a full rebuild** if it can't match 1:1.
- **First build / no prior derived deck → use `--fresh`** (or `--increment` auto-falls-back to a
  full build the first time). Pure HTML→PPT for now; PPT→HTML is a separate future tool.
- **Author for clean increment:** put a stable `id` on each `<section class="slide">` (and on
  editable boxes) — see the deck-conventions note above. Without ids, slides key off title text,
  which is fine until two titles collide or a title is edited.

## Notes
- `capture_slides.py` probes for Chrome at the standard macOS location
  (`/Applications/Google Chrome.app/...`), then Chromium/Edge. User uses **Chrome**.
- Both scripts assume the cwd is the project root.
- Keep `titles[]` and the slide count in sync; the nav label and dots derive from them.

## Export gotchas (learned the hard way)
- **`--out` must resolve to an absolute path.** Chrome resolves a relative `--screenshot=`
  path against its cwd; when the project root has spaces/parens the screenshot **silently fails
  — every slide FAILs, no PNG, no error**. `capture_slides.py` `abspath`s the out dir; if you
  ever pass a path by hand, make it absolute.
- **Aux / link-only slides.** A deck may have `<section class="slide aux">` slides that are
  excluded from the arrow nav (`show()` pages `.slide:not(.aux)` and *clamps*) and reached
  only via `showAux(id)` links. `count_slides()` skips `.slide aux`, so the default capture
  grabs exactly the nav slides. To also capture the aux extras, drive `showAux('id')`
  separately, or temporarily un-aux them. Without this, a naive `0..count` capture duplicates
  the last nav slide and misses the aux.
- **`render_pptx.py` globs `*.png`** in the shots dir, sorted — stray files (a `_test.png`,
  leftovers from a prior run with a different slide count) get inserted. Capture into a
  clean/fresh dir, or clear it first.
- **Overwriting an open rendition.** python-pptx writes a fresh file each run, so there's no COM
  file-lock problem; but if the `.pptx` is open in Keynote/PowerPoint, close it before re-rendering
  so the new file isn't held open or shadowed by the app's copy.
