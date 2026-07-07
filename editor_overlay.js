/*PPT-ED-OVERLAY*/
// HTML-PPT editor overlay. Injected by editor_server.py into any served .html.
// It is a toggleable MODE: off -> the page is just the page (fully interactive);
// on -> click to select, drag to move, handles to resize, a top PowerPoint-style
// ribbon to insert/arrange/format, a clear Comment button, real Cmd/Ctrl+Z undo,
// and PowerPoint-flavoured keyboard shortcuts.
//
// Nothing here writes the source. Every action emits an intent-bearing OP to the
// server (POST /__op); Claude later actions the resolved blueprint into clean
// source. All editor UI is tagged [data-ppt-ui] so it is ignored by selection
// and stripped from snapshots. Content the user ADDS (shapes/text boxes) is real
// content (marked [data-ppt-shape]) and is kept.
//
// UNDO MODEL: every op is wrapped in a client-side "transaction" that records how
// to reverse the DOM change *visually*, plus how many server ops it emitted. One
// Cmd/Ctrl+Z reverts the DOM right here AND pops the matching server op(s), so the
// browser and the blueprint stay in lockstep. (Undo only covers actions taken in
// the current page session; ops already on disk from before load aren't on the stack.)
(function () {
  if (window.__pptEd) return;
  window.__pptEd = true;

  var ON = false;          // edit mode
  var sel = null;          // currently selected element
  var multi = [];          // multi-selection (shift-click) for align-between
  var dragging = false;
  var placing = null;      // shape type armed for placement, or null
  var commentMode = false; // annotate-style "hover & click to comment" pick mode
  var handleSeq = 0;
  var expanded = true;     // ribbon body expanded vs collapsed
  // Which ribbon categories are expanded (persisted). Default: all collapsed.
  var openGrps = (function () { try { return new Set((localStorage.getItem('pptEdGrps') || '').split(',').filter(Boolean)); } catch (e) { return new Set(); } })();
  var sorterOpen = false;  // slide-sorter view active
  var sorterCols = 3;      // sorter thumbnail columns (zoom)
  var sorterOrder = null;  // display order as indices into the slide list
  var sorterEl = null, navEls = [];
  var groupSeq = 0;        // counter for formal group ids
  var curScale = 1;        // effective deck scale (1 = none)
  var userZoom = null;     // manual zoom override; null = auto-fit under the ribbon
  var showMiniToolbar = (function () { try { return localStorage.getItem('pptEdMiniTb') === '1'; } catch (e) { return false; } })();   // opt-in: off by default (no auto-hover menu)

  // ---- tiny helpers ---------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function isUI(el) { return !!(el && el.closest && el.closest('[data-ppt-ui]')); }
  // "Scenery": chrome that belongs to the page itself and must NOT be edited — the
  // html-slide-deck advancement nav, or anything a skill marks [data-ppt-scenery].
  function isScenery(el) { return !!(el && el.closest && el.closest('[data-ppt-scenery], .nav')); }
  // The empty "slide expanse" (slide/stage background, or the page itself). Clicking
  // it selects nothing — it just deselects whatever was selected.
  function isExpanse(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (el.matches && el.matches('.slide, .stage, #stage, [data-ppt-stage]')) return true;
    // A wrapper that CONTAINS slides (e.g. .deck) is deck background, not a shape —
    // treat it as empty space so off-slide clicks deselect / start a lasso.
    return !!(el.querySelector && el.querySelector('.slide'));
  }
  // "Forgotten" objects are temporarily removed from the edit surface (not
  // selectable / movable) but stay in the deck and still take comments.
  function isForgotten(el) { return !!(el && el.closest && el.closest('[data-ppt-forget]')); }
  function mac() { return /Mac|iPod|iPhone|iPad/.test(navigator.platform); }

  function selectorFor(el) {
    if (!el || el === document.body) return 'body';
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift('#' + el.id); break; }
      var tag = el.tagName.toLowerCase(), sib = el, i = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === el.tagName) i++;
      }
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function nearestId(el) {
    while (el && el.nodeType === 1) { if (el.id) return el.id; el = el.parentElement; }
    return null;
  }
  // The positioning context to record coordinates against: a slide stage if the
  // element lives in one (.slide / #stage), else the offset parent.
  function stageOf(el) {
    var s = el && el.closest && el.closest('.slide, #stage, [data-ppt-stage]');
    return s || el.offsetParent || document.body;
  }
  // Positions are returned in the stage's LOCAL (unscaled) coordinate space, so
  // they stay correct when the deck is zoomed (curScale != 1). Screen px / curScale.
  function relRect(el, ref) {
    var r = el.getBoundingClientRect(), rr = ref.getBoundingClientRect();
    return { left: Math.round((r.left - rr.left) / curScale), top: Math.round((r.top - rr.top) / curScale),
             w: Math.round(r.width / curScale), h: Math.round(r.height / curScale) };
  }
  function ensureHandle(el) {
    if (!el.getAttribute('data-ppt-h')) el.setAttribute('data-ppt-h', 'ed-' + (++handleSeq));
    return el.getAttribute('data-ppt-h');
  }
  function anchorFor(el) {
    return {
      page: location.pathname,
      selector: selectorFor(el),
      nearest_id: nearestId(el),
      tag: el.tagName.toLowerCase(),
      text_excerpt: (el.textContent || '').trim().slice(0, 120),
      shape: el.getAttribute('data-ppt-shape') || null
    };
  }
  // ---- live source write-back: edits go straight into the .html (the file IS the
  // truth). In this mode we do NOT replay a blueprint on refresh — the page just
  // reloads the already-edited source, so there's no replay divergence. The blueprint
  // is kept only as a lightweight change-log (edits() count + a reference for optional
  // Claude cleanup). Toggle off with localStorage pptEdSrc='0' to fall back to blueprint.
  var SRC = (function () { try { return localStorage.getItem('pptEdSrc') !== '0'; } catch (e) { return true; } })();
  function elemLocator(el) {
    var indices = [], node = el, root = null;
    while (node && node.nodeType === 1) {
      if (node.id) { root = node.id; break; }
      var p = node.parentElement; if (!p) break;
      var i = 0, c = p.firstElementChild;
      while (c && c !== node) { c = c.nextElementSibling; i++; }
      indices.unshift(i); node = p;
    }
    return { file: location.pathname, handle: el.getAttribute('data-ppt-h') || null, root_id: root, indices: indices };
  }
  // Post a source write and watch the result. If the server can't locate the element
  // (or the write otherwise fails), the edit did NOT persist to the file. We surface
  // that LOUDLY — a flash naming the element AND a red ring drawn on it for ~2s — so a
  // lost edit is never silent (the user's hard rule: no hanging elements). `el` is the
  // element the write targeted, used to identify and ring it.
  var lastSrcWarn = 0;
  var warnRing = null;
  function showWarnRing(el) {
    try {
      if (!el || !el.getBoundingClientRect || !document.contains(el)) return;
      if (!warnRing) {
        warnRing = document.createElement('div');
        warnRing.setAttribute('data-ppt-ui', '1');
        warnRing.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;display:none;' +
          'border:2px solid #e23b3b;background:rgba(226,59,59,.10);border-radius:3px;' +
          'box-shadow:0 0 0 2px rgba(226,59,59,.25);transition:opacity .4s';
        document.body.appendChild(warnRing);
      }
      var r = el.getBoundingClientRect();
      warnRing.style.display = 'block'; warnRing.style.opacity = '1';
      warnRing.style.left = r.left + 'px'; warnRing.style.top = r.top + 'px';
      warnRing.style.width = r.width + 'px'; warnRing.style.height = r.height + 'px';
      clearTimeout(warnRing.__t1); clearTimeout(warnRing.__t2);
      warnRing.__t1 = setTimeout(function () { warnRing.style.opacity = '0'; }, 1600);
      warnRing.__t2 = setTimeout(function () { warnRing.style.display = 'none'; }, 2100);
    } catch (e) {}
  }
  function warnNotSaved(el, err) {
    var now = (window.performance && performance.now) ? performance.now() : 0;
    if (now - lastSrcWarn > 1200) {   // throttle the text line so a multi-element action shows one notice
      lastSrcWarn = now;
      var what = '';
      try {
        if (el && el.tagName) {
          what = ' <' + el.tagName.toLowerCase() + '>';
          var t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
          if (t) what += ' “' + t + '”';
        }
      } catch (e) {}
      flash('⚠ edit not saved to source —' + (what || ' element') + ' couldn’t be located (visual only)');
    }
    showWarnRing(el);   // ring every failed element (not throttled) so each lost edit is visible
  }
  function srcPost(endpoint, body, el) {
    fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok === false) warnNotSaved(el, d.error); })
      .catch(function () {});
  }
  // Drag-moves append a translate() every time; collapse the chain into ONE net
  // translate so source stays clean (a sum of translates == a single translate).
  function collapseTransform(val) {
    var sx = 0, sy = 0, others = [], re = /([\w-]+)\(([^)]*)\)/g, m;
    while ((m = re.exec(val || ''))) {
      if (m[1] === 'translate' || m[1] === 'translateX' || m[1] === 'translateY') {
        var p = m[2].split(',');
        if (m[1] === 'translateY') sy += parseFloat(p[0]) || 0;
        else { sx += parseFloat(p[0]) || 0; sy += parseFloat(p[1] || '0') || 0; }
      } else { others.push(m[0]); }
    }
    var t = (sx || sy) ? 'translate(' + (Math.round(sx * 100) / 100) + 'px, ' + (Math.round(sy * 100) / 100) + 'px)' : '';
    return others.concat(t ? [t] : []).join(' ');
  }
  function collapseStyleTransform(style) {
    return (style || '').replace(/transform\s*:\s*([^;]*)(;?)/i, function (whole, val, semi) {
      var c = collapseTransform(val);
      return c ? 'transform: ' + c + semi : '';
    });
  }
  // Write one edit straight to the .html source. `txid` groups every write of one
  // user action so the server checkpoints the file ONCE per action (see srcUndo).
  // Returns true if a write was actually posted (false = nothing written, e.g.
  // reorder), so the caller can tell whether this transaction made a server undo step.
  function srcWrite(el, op, value, txid) {
    var handle = ensureHandle(el);
    var loc = elemLocator(el); loc.handle = handle; loc.txid = txid;
    if (op === 'delete') { srcPost('/__src_delete', loc, el); return true; }
    if (op === 'setText') { loc.text = el.innerText; srcPost('/__src_text', loc, el); return true; }
    if (op === 'setHTML') { loc.html = el.innerHTML; srcPost('/__src_text', loc, el); return true; }
    if (op === 'create') {
      if (value && value.kind === 'slide') return false;   // whole-slide creates go via srcSlideCreate (el here is the PARENT, not the slide)
      var parent = el.parentElement; if (!parent) return false;
      var pl = elemLocator(parent);
      var clone = el.cloneNode(true);
      if (clone.querySelectorAll) clone.querySelectorAll('[data-ppt-ui]').forEach(function (n) { n.remove(); });
      srcPost('/__src_create', { file: loc.file, txid: txid, parent_root_id: pl.root_id,
        parent_indices: pl.indices, parent_handle: pl.handle, html: clone.outerHTML }, el);
      return true;
    }
    if (op === 'reorder') {
      // order[k] = index (in the old/source slide order) of the slide now at position k.
      var order = (value && value.order) || null;
      if (!order || order.length < 2 || order.indexOf(-1) >= 0) return false;   // can't express as a clean permutation -> blueprint fallback
      srcPost('/__src_reorder', { file: location.pathname, txid: txid, order: order }, el);
      return true;
    }
    // move / resize / setStyle / setZ -> wholesale style write (source inline == DOM inline)
    loc.style_text = collapseStyleTransform(el.getAttribute('style') || '');
    srcPost('/__src_style', loc, el);
    return true;
  }
  // Pop ONE server checkpoint = revert exactly one user action's source writes.
  // (The server grouped the whole transaction under one snapshot via its txid, so a
  // single call reverts it cleanly no matter how many writes — or failed locates —
  // it contained. Never over-pops into an unrelated earlier edit.)
  function srcUndo(txid) {
    if (!SRC) return;
    fetch('/__src_undo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: location.pathname, txid: txid }) }).catch(function () {});
  }
  // Revert every pending source edit this session in one shot (server restores the
  // pre-session file), so "Undo all" stays a single, race-free server call.
  function srcUndoAll() {
    if (!SRC) return;
    fetch('/__src_undo_all', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: location.pathname }) }).catch(function () {});
  }
  // Insert a whole new .slide into source after the anchor slide (by source-slide
  // index). Slide creates can't use the generic create path (its op carries the
  // PARENT element, not the new slide), so they write through here. Shares the open
  // transaction's txid + counts a source write, so one Undo removes it from source.
  function srcSlideCreate(newNode, afterIndex) {
    if (!SRC) return;
    var clone = newNode.cloneNode(true);
    if (clone.querySelectorAll) clone.querySelectorAll('[data-ppt-ui]').forEach(function (n) { n.remove(); });
    var txid = curTx ? curTx.txid : 't' + (++txSeq);
    if (curTx) curTx.srcWrites++;
    srcPost('/__src_slide_create', { file: location.pathname, txid: txid,
      after_index: afterIndex, html: clone.outerHTML }, newNode);
  }
  // Emit one op. `txid` groups the source write with its siblings in the same user
  // action; defaults to the open transaction's id (or a fresh one if called bare).
  function sendOp(el, op, value, txid) {
    txid = txid || (curTx ? curTx.txid : 'a' + (++txSeq));
    if (curTx) curTx.ops++;   // count ops in the open transaction (for blueprint undo sync)
    if (SRC && srcWrite(el, op, value, txid) && curTx) curTx.srcWrites++;   // count writes that hit source
    var payload = { handle: ensureHandle(el), anchor: anchorFor(el), op: op, value: value || {} };
    fetch('/__op', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.count != null) setEdits(d.count); })  // edits, NOT comments
      .catch(function () {});
  }

  // ---- undo: client-side visual revert + server-synced ----------------------
  // A transaction = one user action. It carries a `txid` (shared by all its source
  // writes so the server collapses them to ONE undo checkpoint) and `srcWrites` (how
  // many writes hit source — >0 means there's a server checkpoint to pop on undo).
  var undoStack = [];
  var curTx = null;
  var txSeq = 0;
  function txStart(label, revert) { nudgeEnd(); curTx = { label: label, revert: revert, ops: 0, srcWrites: 0, txid: 't' + (++txSeq) }; }
  function txCommit() { if (curTx && curTx.ops > 0) undoStack.push(curTx); curTx = null; refreshUndo(); }
  function serverUndo(n) {
    if (n <= 0) { if (panel && panelKind === 'edits') renderEdits(); return; }   // refresh open edits list after the undo lands
    fetch('/__undo', { method: 'POST' }).then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.count != null) setEdits(d.count); serverUndo(n - 1); })
      .catch(function () { serverUndo(n - 1); });
  }
  function doUndo() {
    nudgeEnd();                                // commit any in-flight nudge burst first
    var tx = undoStack.pop();
    if (!tx) { flash('nothing to undo'); refreshUndo(); return; }
    try { tx.revert(); } catch (e) {}
    if (sel && !document.contains(sel)) clearSel();   // selection was the thing we removed
    positionChrome();
    serverUndo(tx.ops);             // pop the matching blueprint op(s) so the change-log matches
    if (tx.srcWrites > 0) srcUndo(tx.txid);   // revert this action's source writes — strictly by txid, never over-pops
    flash('undo: ' + tx.label);
    refreshUndo();
  }
  function doUndoAll() {
    nudgeEnd();
    if (!undoStack.length) { flash('nothing to undo'); return; }
    var n = 0;
    while (undoStack.length) { var tx = undoStack.pop(); try { tx.revert(); } catch (e) {} n += tx.ops || 0; }
    if (sel && !document.contains(sel)) clearSel();
    positionChrome();
    serverUndo(n);            // pop every matching blueprint op
    srcUndoAll();             // restore the pre-session source in one race-free call
    refreshUndo();
    flash('undid all edits');
  }
  function refreshUndo() {
    var b = bar && bar.querySelector('[data-undo]'); if (!b) return;
    b.textContent = '↶ Undo' + (undoStack.length ? ' (' + undoStack.length + ')' : '');
    b.style.opacity = undoStack.length ? '1' : '.45';
    var ba = bar.querySelector('[data-undoall]'); if (ba) ba.style.opacity = undoStack.length ? '1' : '.45';
  }

  // ---- chrome: top PowerPoint-style ribbon ----------------------------------
  var BTN = 'background:#2a2a2a;color:#fff;border:1px solid #3a3a3a;border-radius:6px;' +
            'padding:5px 9px;margin:0 2px;font:13px system-ui;cursor:pointer;line-height:1.1';
  // Each category keeps its side-by-side column shape, but the label is now a
  // clickable toggle: collapsed = just the label, expanded = buttons + label
  // (the current look). Open all three and it reads like before, just wrappable.
  var GLBL = 'font:10px system-ui;letter-spacing:.6px;text-transform:uppercase;color:#9bb0c2;' +
    'margin-top:5px;background:none;border:0;cursor:pointer;padding:2px 0';
  function grp(label, inner) {
    var key = label.toLowerCase();
    return '<div style="display:flex;flex-direction:column;align-items:flex-start">' +
      '<div data-grpc="' + key + '" style="display:none;align-items:center;flex-wrap:wrap;gap:4px 2px">' + inner + '</div>' +
      '<button data-grp="' + key + '" style="' + GLBL + '">' +
        '<span data-grparrow style="font-size:9px">&#9656;</span> ' + label + '</button></div>';
  }
  var bar = document.createElement('div');
  bar.setAttribute('data-ppt-ui', '1');
  bar.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;right:0;' +
    'font:14px/1.4 system-ui,sans-serif;background:#161616;color:#fff;' +
    'box-shadow:0 2px 14px rgba(0,0,0,.35);user-select:none';
  bar.innerHTML =
    // ---- header strip (always visible) ----
    '<div style="display:flex;align-items:center;gap:10px;padding:8px 14px">' +
      '<b>Deckhand</b>' +
      '<a href="#" data-tog style="color:#7cf;text-decoration:none;font-weight:600">off</a>' +
      '<span style="display:inline-flex;align-items:center;gap:9px">' +
        '<span style="display:inline-flex;align-items:center;gap:2px">' +
          '<button data-dzout title="Zoom out" style="' + BTN + '">−</button>' +
          '<span data-dzlbl style="min-width:38px;text-align:center;color:#9ab;font-size:12px">100%</span>' +
          '<button data-dzin title="Zoom in" style="' + BTN + '">+</button>' +
          '<button data-dzfit title="Fit slide to window" style="' + BTN + '">Fit</button>' +
        '</span>' +
        '<button data-cmt-pick title="Comment mode — click elements to comment (works with deckhand off)" style="' + BTN +
          ';background:#13314a;border-color:#1f4a6b">💬 Comment</button>' +
        '<a href="#" data-list style="color:#9ab;text-decoration:none;font-size:12px">comments(<span data-c>0</span>)</a>' +
      '</span>' +
      '<span data-tools style="display:none;align-items:center;gap:9px;flex:1">' +
        '<button data-undo title="Undo (Cmd/Ctrl+Z)" style="' + BTN +
          ';background:#3a2f10;border-color:#5a4a1a">↶ Undo</button>' +
        '<button data-undoall title="Undo everything (revert all pending edits)" style="' + BTN +
          ';background:#3a2f10;border-color:#5a4a1a">↶↶ All</button>' +
        '<button data-snap title="Save a snapshot of what you see" style="' + BTN + '">Snapshot</button>' +
        '<button data-sorter title="Slide sorter (Ctrl/Cmd+4)" style="' + BTN + '">⊞ Sorter</button>' +
        '<button data-shortcuts title="Keyboard shortcuts" style="' + BTN + '">⌨ Keys</button>' +
        '<button data-options title="Options" style="' + BTN + '">⚙</button>' +
        '<span style="font-size:12px">' +
          '<a href="#" data-elist style="color:#9ab;text-decoration:none">edits(<span data-e>0</span>)</a>' +
          ' <span style="color:#9ab">&middot;</span> ' +
          '<a href="#" data-flist style="color:#9ab;text-decoration:none">forgotten(<span data-fgt>0</span>)</a>' +
        '</span>' +
        '<span style="flex:1"></span>' +
        '<a href="#" data-expand style="color:#7cf;text-decoration:none;font-size:12px">▴ ribbon</a>' +
      '</span>' +
    '</div>' +
    // ---- ribbon body (expandable) ----
    '<div data-body style="display:none;border-top:1px solid #2a2a2a;padding:9px 14px;' +
        'column-gap:26px;row-gap:6px;align-items:flex-start;flex-wrap:wrap">' +
      grp('Insert',
        '<button data-add="textbox" style="' + BTN + '">+ Text</button>' +
        '<button data-add="rect" style="' + BTN + '">+ Rect</button>' +
        '<button data-add="oval" style="' + BTN + '">+ Oval</button>' +
        '<button data-add="line" style="' + BTN + '">+ Line</button>') +
      grp('Arrange',
        '<button data-z="front" title="Bring to front (Cmd/Ctrl+Shift+])" style="' + BTN + '">To Front</button>' +
        '<button data-z="back" title="Send to back (Cmd/Ctrl+Shift+[)" style="' + BTN + '">To Back</button>' +
        '<span style="width:10px;display:inline-block"></span>' +
        '<button data-ta="left" title="Align text left" style="' + BTN + '">Left</button>' +
        '<button data-ta="center" title="Center text" style="' + BTN + '">Center</button>' +
        '<button data-ta="right" title="Align text right" style="' + BTN + '">Right</button>' +
        '<span style="width:8px;display:inline-block"></span>' +
        '<button data-tv="top" title="Text to top of box" style="' + BTN + '">Top</button>' +
        '<button data-tv="middle" title="Text to middle of box" style="' + BTN + '">Middle</button>' +
        '<button data-tv="bottom" title="Text to bottom of box" style="' + BTN + '">Bottom</button>' +
        '<span style="width:10px;display:inline-block"></span>' +
        '<button data-dist="h" title="Distribute horizontally (Cmd+Shift+H / Alt+Shift+H)" style="' + BTN + '">↔</button>' +
        '<button data-dist="v" title="Distribute vertically (Cmd+Shift+V / Alt+Shift+V)" style="' + BTN + '">↕</button>' +
        '<span style="width:10px;display:inline-block"></span>' +
        '<button data-group title="Group (Ctrl+G)" style="' + BTN + '">Group</button>' +
        '<button data-ungroup title="Ungroup (Ctrl+Shift+G)" style="' + BTN + '">Ungroup</button>') +
      grp('Font',
        '<button data-f="smaller" title="Smaller (Cmd/Ctrl+[)" style="' + BTN + '">A-</button>' +
        '<button data-f="bigger" title="Bigger (Cmd/Ctrl+])" style="' + BTN + '">A+</button>' +
        '<input data-fz type="number" min="4" max="400" title="Font size (px) — sets all selected text" style="width:50px;height:30px;margin:0 4px;border:1px solid #3a3a3a;border-radius:6px;background:#2a2a2a;color:#fff;text-align:center;font:13px system-ui">' +
        '<button data-f="bold" title="Bold (Cmd/Ctrl+B)" style="' + BTN + ';font-weight:700">B</button>' +
        '<button data-f="italic" title="Italic (Cmd/Ctrl+I)" style="' + BTN + ';font-style:italic">I</button>' +
        '<button data-f="underline" title="Underline (Cmd/Ctrl+U)" style="' + BTN + ';text-decoration:underline">U</button>' +
        '<button data-f="bullets" title="Bullets" style="' + BTN + '">&bull;</button>' +
        '<button data-f="color" title="Text color" style="' + BTN + '">Color</button>' +
        '<button data-f="fill" title="Fill color (shape background)" style="' + BTN + '">Fill</button>' +
        '<button data-f="outline" title="Outline color (border)" style="' + BTN + '">Outline</button>') +
    '</div>';
  document.body.appendChild(bar);

  // selection outline
  var box = document.createElement('div');
  box.setAttribute('data-ppt-ui', '1');
  box.style.cssText = 'position:fixed;z-index:2147483640;pointer-events:none;display:none;' +
    'border:2px solid #2da6ff;background:rgba(45,166,255,.08);border-radius:2px';
  document.body.appendChild(box);

  // 8 resize handles
  var handles = document.createElement('div');
  handles.setAttribute('data-ppt-ui', '1');
  // The container spans the viewport but MUST be click-through, else it eats every
  // drag aimed at the page. Only the handle dots themselves are grabbable.
  handles.style.cssText = 'position:fixed;z-index:2147483641;display:none;pointer-events:none';
  var HPOS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  HPOS.forEach(function (p) {
    var h = document.createElement('div');
    h.setAttribute('data-h', p);
    h.style.cssText = 'position:absolute;width:10px;height:10px;background:#2da6ff;' +
      'border:1px solid #fff;border-radius:2px;box-sizing:border-box;pointer-events:auto;' +
      'cursor:' + p + '-resize';
    handles.appendChild(h);
  });
  document.body.appendChild(handles);

  // floating mini-toolbar (compact; shown at the selection). Format essentials +
  // edit/comment/delete. Align & z-order live in the ribbon's Arrange group.
  var TBTN = 'display:inline-flex;align-items:center;justify-content:center;height:26px;min-width:26px;' +
    'padding:0 7px;margin:0;font:12px/1 system-ui;color:#1b1b1b;background:#f4f6f8;' +
    'border:1px solid #d0d6dd;border-radius:5px;cursor:pointer;white-space:nowrap';
  var SEP = '<span style="width:1px;height:18px;background:#dde2e8;margin:0 2px;display:inline-block"></span>';
  var tb = document.createElement('div');
  tb.setAttribute('data-ppt-ui', '1');
  tb.style.cssText = 'position:fixed;z-index:2147483646;display:none;background:#fff;color:#111;' +
    'border:1px solid #ccc;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.26);' +
    'padding:4px;gap:2px;align-items:center;font:12px system-ui';
  tb.innerHTML =
    '<button data-f="bold" title="Bold (Cmd/Ctrl+B)" style="' + TBTN + ';font-weight:700">B</button>' +
    '<button data-f="italic" title="Italic (Cmd/Ctrl+I)" style="' + TBTN + ';font-style:italic">I</button>' +
    '<button data-f="underline" title="Underline (Cmd/Ctrl+U)" style="' + TBTN + ';text-decoration:underline">U</button>' +
    '<button data-f="smaller" title="Smaller font (Cmd/Ctrl+[)" style="' + TBTN + '">A−</button>' +
    '<button data-f="bigger" title="Bigger font (Cmd/Ctrl+])" style="' + TBTN + '">A+</button>' +
    '<button data-f="bullets" title="Bullets" style="' + TBTN + '">&bull;</button>' +
    '<button data-f="color" title="Text color" style="' + TBTN + '">🎨</button>' +
    '<button data-f="fill" title="Fill color" style="' + TBTN + '">▰</button>' +
    '<button data-f="outline" title="Outline color" style="' + TBTN + '">▢</button>' +
    SEP +
    '<button data-edit-text title="Edit text (Enter)" style="' + TBTN + '">✎</button>' +
    '<button data-cmt title="Comment on this element" style="' + TBTN +
      ';background:#e8f1fb;border-color:#b9d6f2">💬</button>' +
    '<button data-del title="Delete (Del/Backspace)" style="' + TBTN +
      ';background:#fdecec;border-color:#f3c2c2;color:#b32020">✕</button>';
  document.body.appendChild(tb);

  // hover highlight used by comment pick-mode (annotate-style "light up on hover")
  var hoverBox = document.createElement('div');
  hoverBox.setAttribute('data-ppt-ui', '1');
  hoverBox.style.cssText = 'position:fixed;z-index:2147483639;pointer-events:none;display:none;' +
    'border:2px solid #13a06b;background:rgba(19,160,107,.12);border-radius:2px';
  document.body.appendChild(hoverBox);

  // outlines for every element in a shift-click multi-selection
  var multiLayer = document.createElement('div');
  multiLayer.setAttribute('data-ppt-ui', '1');
  multiLayer.style.cssText = 'position:fixed;z-index:2147483638;pointer-events:none;display:none;' +
    'left:0;top:0;width:0;height:0';
  document.body.appendChild(multiLayer);

  // highlight for the page element a selected comment row points at
  var linkBox = document.createElement('div');
  linkBox.setAttribute('data-ppt-ui', '1');
  linkBox.style.cssText = 'position:fixed;z-index:2147483637;pointer-events:none;display:none;' +
    'border:2px solid #e8b23a;background:rgba(232,178,58,.14);border-radius:2px';
  document.body.appendChild(linkBox);

  function setCount(n) { var e = bar.querySelector('[data-c]'); if (e) e.textContent = n; }
  function setEdits(n) { var e = bar.querySelector('[data-e]'); if (e) e.textContent = n; }

  // ---- mode -----------------------------------------------------------------
  function updateExpand() {
    var body = bar.querySelector('[data-body]'), ex = bar.querySelector('[data-expand]');
    var show = ON && expanded;
    if (body) body.style.display = show ? 'flex' : 'none';
    if (ex) ex.textContent = (expanded ? '▴' : '▾') + ' ribbon';
    applyDeckZoom();   // ribbon height changed -> re-fit the deck
    positionPanel();   // and nudge any open side panel below the new ribbon height
  }
  // Collapsible categories: show/hide one category's button row + flip its caret.
  function applyGrp(key) {
    var c = bar.querySelector('[data-grpc="' + key + '"]');
    var b = bar.querySelector('[data-grp="' + key + '"]');
    if (!c || !b) return;
    var open = openGrps.has(key);
    c.style.display = open ? 'flex' : 'none';
    var ar = b.querySelector('[data-grparrow]'); if (ar) ar.innerHTML = open ? '&#9662;' : '&#9656;';
  }
  function applyAllGrps() { ['insert', 'arrange', 'font'].forEach(applyGrp); }
  function toggleGrp(key) {
    if (openGrps.has(key)) openGrps.delete(key); else openGrps.add(key);
    try { localStorage.setItem('pptEdGrps', Array.from(openGrps).join(',')); } catch (e) {}
    applyGrp(key); applyDeckZoom(); positionPanel();
  }
  function setOn(v) {
    ON = v;
    bar.querySelector('[data-tog]').textContent = v ? 'ON' : 'off';
    bar.querySelector('[data-tools]').style.display = v ? 'flex' : 'none';
    updateExpand();
    if (!v) { clearSel(); disarm(); }
    applyDeckZoom();
    try { localStorage.setItem('pptEdOn', v ? '1' : '0'); } catch (e) {}   // survive refresh
  }

  // ---- deck zoom (auto-fit under the ribbon + manual zoom) -------------------
  // What to scale when zooming. Two deck shapes are supported:
  //  - fixed canvas: a single `.stage`/`#stage`/[data-ppt-stage] that WRAPS the
  //    slides (and isn't itself inside a slide) — scale that one element.
  //  - one-slide-at-a-time: slides toggled display:none/block with no wrapping
  //    canvas (or `.stage` is a per-slide content region) — scale EVERY slide with
  //    the same transform, so the active slide is always fit and the rest are ready.
  function zoomTargets() {
    var canvas = document.querySelector('.stage, #stage, [data-ppt-stage]');
    if (canvas && !(canvas.closest && canvas.closest('.slide')) && canvas.querySelector('.slide')) return [canvas];
    var slides = getSlides();
    if (slides.length) return slides;
    return canvas ? [canvas] : [];
  }
  function fitScale(ribbonH) {
    var first = getSlides()[0]; if (!first) return 1;
    var sw = parseFloat(getComputedStyle(first).width) || 1280;
    var sh = parseFloat(getComputedStyle(first).height); if (!sh || sh < 10) sh = sw * 9 / 16;
    // Reserve the ribbon at the top and just the deck's own bottom nav (if any) below
    // — not a whole second ribbon — so 'fit' fills the space instead of leaving a gap.
    var navEl = document.querySelector('.nav, [data-ppt-scenery]');
    var bottomReserve = navEl ? navEl.offsetHeight + 22 : 16;
    var availH = window.innerHeight - (ribbonH + 8) - bottomReserve - 8, availW = window.innerWidth - 24;
    // Fit FILLS the available space (scales up small decks too, like PowerPoint's
    // Fit-to-Window), capped so a tiny deck doesn't blow up absurdly.
    var s = Math.min(3, availH / sh, availW / sw);
    return s > 0 ? s : 1;
  }
  var zoomSpacer = null;
  // Grow the page's scrollable area to (w,h) with an invisible absolutely-positioned
  // spacer, so a zoomed-IN (transform-scaled) slide can be scrolled to on both axes
  // without touching the slides' own margins/centering. (0,0) removes it.
  function sizeZoomSpacer(w, h) {
    if (!w || !h) { if (zoomSpacer) { zoomSpacer.style.width = '0'; zoomSpacer.style.height = '0'; } return; }
    if (!zoomSpacer) {
      zoomSpacer = document.createElement('div');
      zoomSpacer.setAttribute('data-ppt-ui', '1');
      zoomSpacer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;z-index:-1';
      document.body.appendChild(zoomSpacer);
    }
    zoomSpacer.style.width = w + 'px'; zoomSpacer.style.height = h + 'px';
  }
  function applyDeckZoom() {
    var targets = zoomTargets(); if (!targets.length) { curScale = 1; updateZoomLabel(); return; }
    targets.forEach(function (t) { if (t.__pptPrevTransform === undefined) t.__pptPrevTransform = t.style.transform || ''; });
    // Zoom / fit applies whether deckhand is on or OFF — it persists. Only the EDIT
    // chrome (selection, handles) is gated on ON.
    var ribbonH = bar.getBoundingClientRect().height || 0;
    curScale = (userZoom != null) ? userZoom : fitScale(ribbonH);
    var first = getSlides()[0];
    var sh = first ? (parseFloat(getComputedStyle(first).height) || 0) : 0;
    if (!sh || sh < 10) { var sw = first ? parseFloat(getComputedStyle(first).width) || 1280 : 1280; sh = sw * 9 / 16; }
    // Reframe from the top: clearing the FIXED ribbon only makes sense at scroll 0,
    // so a Fit/zoom done after scrolling lands the slide correctly (not low).
    try { window.scrollTo(0, 0); } catch (e) {}
    // measure the untransformed geometry of a visible target (active slide / canvas)
    targets.forEach(function (t) { t.style.transform = t.__pptPrevTransform || ''; t.style.marginRight = ''; t.style.marginBottom = ''; });
    var probe = targets.filter(function (t) { return t.offsetParent !== null; })[0] || targets[0];
    var pr = probe.getBoundingClientRect();
    var natTop = pr.top, natLeft = pr.left;
    var natW = probe.offsetWidth || pr.width, natH = probe.offsetHeight || pr.height;
    var centeredTop = natTop + sh * (1 - curScale) / 2;        // where center-scaling lands the top
    var needPush = centeredTop < ribbonH + 8;                  // ribbon would cover the top
    var scaledW = natW * curScale;
    var leftAt = scaledW < (window.innerWidth - 16) ? Math.max(8, Math.round((window.innerWidth - scaledW) / 2)) : 8;
    var dx = Math.round(leftAt - natLeft), dyPush = Math.round((ribbonH + 8) - natTop);
    targets.forEach(function (t) {
      var pre = t.__pptPrevTransform ? t.__pptPrevTransform + ' ' : '';
      if (curScale > 1) {                                     // zoomed in: anchor top-LEFT so all overflow is right/down
        t.style.transformOrigin = '0 0';
        t.style.transform = pre + 'translate(' + dx + 'px,' + dyPush + 'px) scale(' + curScale + ')';
      } else if (needPush) {                                  // fit/out: pin top below the ribbon, centered horizontally
        t.style.transformOrigin = '50% 0';
        t.style.transform = pre + 'translateY(' + dyPush + 'px) scale(' + curScale + ')';
      } else {                                                // fits above the fold -> center both ways
        t.style.transformOrigin = '50% 50%';
        t.style.transform = pre + 'scale(' + curScale + ')';
      }
    });
    // Transforms don't grow layout, so a zoomed-IN slide isn't scrollable on its own.
    // Grow the scrollable area with an invisible spacer covering the scaled extent —
    // this leaves the slides' own margins/centering untouched (no misplacement).
    sizeZoomSpacer(curScale > 1 ? Math.ceil(leftAt + scaledW + 16) : 0,
                   curScale > 1 ? Math.ceil((ribbonH + 8) + natH * curScale + 16) : 0);
    positionChrome();
    updateZoomLabel();
  }
  function setZoom(z) { userZoom = Math.max(0.2, Math.min(4, z)); applyDeckZoom(); }
  function zoomIn() { setZoom((userZoom != null ? userZoom : curScale) * 1.1); }
  function zoomOut() { setZoom((userZoom != null ? userZoom : curScale) * 0.9); }
  function zoomFit() { userZoom = null; applyDeckZoom(); flash('Zoom: fit'); }
  function updateZoomLabel() { var e = bar.querySelector('[data-dzlbl]'); if (e) e.textContent = Math.round(curScale * 100) + '%'; }

  // ---- comment pick-mode (annotate-style hover & click) ---------------------
  function setCommentMode(v) {
    commentMode = v;
    document.body.style.cursor = v ? 'pointer' : '';   // pointer, not crosshair
    if (!v) hoverBox.style.display = 'none';
    var cb = bar.querySelector('[data-cmt-pick]');
    if (cb) {   // make the in/out state obvious on the button itself
      cb.style.background = v ? '#2d6cdf' : '#13314a';
      cb.style.borderColor = v ? '#7fb0ff' : '#1f4a6b';
      cb.style.boxShadow = v ? '0 0 0 2px rgba(127,176,255,.55)' : '';
      cb.textContent = v ? '💬 Commenting · Esc' : '💬 Comment';
    }
    if (v) flash('Comment mode ON — click elements to comment; stays on until Esc');
  }

  // ---- selection ------------------------------------------------------------
  function clearSel() {
    sel = null; multi = [];
    box.style.display = 'none'; handles.style.display = 'none'; tb.style.display = 'none';
    multiLayer.style.display = 'none'; multiLayer.innerHTML = '';
    updateFontReadout();
  }
  function drawMulti() {
    multiLayer.innerHTML = '';
    if (multi.length < 2) { multiLayer.style.display = 'none'; return; }
    multiLayer.style.display = 'block';
    multi.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var o = document.createElement('div');
      o.style.cssText = 'position:fixed;border:2px solid #2da6ff;border-radius:2px;' +
        'background:rgba(45,166,255,.12);pointer-events:none;' +
        'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
      multiLayer.appendChild(o);
    });
  }
  function select(el, additive) {
    // clicking any member of a formal group selects the whole group
    var gid = el && el.getAttribute && el.getAttribute('data-ppt-group');
    if (gid && !additive) {
      var g = Array.from(document.querySelectorAll('[data-ppt-group="' + gid + '"]'));
      if (g.length > 1) { multi = g; sel = el; positionChrome(); return; }
    }
    if (additive && sel && el !== sel) {
      if (multi.indexOf(sel) < 0) multi.push(sel);
      if (multi.indexOf(el) < 0) multi.push(el);
    } else {
      multi = [];
    }
    sel = el;
    positionChrome();
  }
  // Ctrl/Cmd+click toggles an element in / out of the current selection (PPT-style).
  function toggleInSelection(el) {
    var set = multi.length ? multi.slice() : (sel ? [sel] : []);
    var unit = null;
    for (var i = 0; i < set.length; i++) { if (set[i] === el || set[i].contains(el)) { unit = set[i]; break; } }
    if (unit) set.splice(set.indexOf(unit), 1);   // already selected -> remove it
    else set.push(el);                            // not selected -> add it
    if (!set.length) clearSel();
    else if (set.length === 1) { multi = []; sel = set[0]; positionChrome(); }
    else { multi = set; sel = set[set.length - 1]; positionChrome(); }
  }
  function positionChrome() {
    if (!sel) { clearSel(); return; }
    if (sel.offsetParent === null && sel !== document.body) {   // selection is on a now-hidden slide
      box.style.display = 'none'; handles.style.display = 'none'; tb.style.display = 'none';
      multiLayer.style.display = 'none'; linkBox.style.display = 'none';
      return;
    }
    var r = sel.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    // handles
    handles.style.display = 'block';
    handles.style.left = '0px'; handles.style.top = '0px';
    handles.style.width = '100%'; handles.style.height = '100%';
    var pts = {
      nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top],
      e: [r.right, r.top + r.height / 2], se: [r.right, r.bottom],
      s: [r.left + r.width / 2, r.bottom], sw: [r.left, r.bottom],
      w: [r.left, r.top + r.height / 2]
    };
    handles.querySelectorAll('[data-h]').forEach(function (h) {
      var p = pts[h.getAttribute('data-h')];
      h.style.left = (p[0] - 5) + 'px'; h.style.top = (p[1] - 5) + 'px';
    });
    // mini-toolbar above (or below if no room) — only if enabled in Options
    if (showMiniToolbar) {
      tb.style.display = 'flex';
      var ty = r.top - tb.offsetHeight - 8;
      if (ty < 54) ty = r.bottom + 8;   // keep clear of the top ribbon
      tb.style.left = Math.max(4, Math.min(r.left, innerWidth - tb.offsetWidth - 4)) + 'px';
      tb.style.top = ty + 'px';
    } else { tb.style.display = 'none'; }
    drawMulti();
    updateFontReadout();
  }
  window.addEventListener('scroll', positionChrome, true);
  window.addEventListener('resize', function () { applyDeckZoom(); positionChrome(); });
  window.addEventListener('hashchange', function () { clearSel(); });   // deck nav -> drop ghost selection

  // ---- hover highlight while in comment pick-mode ---------------------------
  document.addEventListener('mousemove', function (e) {
    if (!commentMode) return;   // hover highlight works whenever comment mode is on (deckhand on or off)
    if (isUI(e.target)) { hoverBox.style.display = 'none'; return; }
    var r = e.target.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px'; hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px'; hoverBox.style.height = r.height + 'px';
  }, true);

  // ---- click to select ------------------------------------------------------
  document.addEventListener('click', function (e) {
    if (isUI(e.target)) return;
    if (commentMode) {                       // comment pick-mode works with deckhand ON or OFF
      if (isScenery(e.target) || isExpanse(e.target)) return;   // nav / empty space: ignore, stay in comment mode
      e.preventDefault(); e.stopPropagation();
      clearSel();                            // comment only — don't select it for editing
      commentSel(e.target);
      return;                                // stay in comment mode for the next comment
    }
    if (!ON) return;                         // selection/editing only when deckhand is on
    if (isScenery(e.target)) { clearSel(); return; }  // nav etc.: drop selection, let it act
    if (placing) { placeAt(e.clientX, e.clientY); return; }
    e.preventDefault(); e.stopPropagation();
    // Selection happens on mousedown (below). We deliberately do NOT re-select
    // here: after even a 1px drag the browser fires `click` on the common
    // ancestor of press+release (e.g. the whole .slide), which would escalate
    // the selection from the element you clicked up to the entire slide.
  }, true);

  // double-click = edit text
  document.addEventListener('dblclick', function (e) {
    if (!ON || isUI(e.target) || isScenery(e.target) || commentMode) return;
    e.preventDefault(); e.stopPropagation();
    editText(e.target, { x: e.clientX, y: e.clientY });
  }, true);

  // ---- drag to move ---------------------------------------------------------
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    nudgeEnd();                              // any mouse action commits a pending nudge burst first (ordering + snappy undo)
    if (commentMode) {                       // comment mode (on or off): block the page, let the click handler pick
      if (!isUI(e.target) && !isScenery(e.target)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (!ON) return;
    // armed to add a shape: rect/oval/line draw on drag; textbox places on click
    if (placing) { if (placing !== 'textbox' && !isUI(e.target)) startShapeDraw(e, placing); return; }
    var htarget = e.target.closest && e.target.closest('[data-h]');
    if (htarget) { startResize(e, htarget.getAttribute('data-h')); return; }
    if (isUI(e.target)) return;
    if (isScenery(e.target)) return;          // deck nav etc. is not editable
    // Never stay in edit mode on one shape while selecting/lassoing another:
    // leaving the element you were editing commits it (blur -> editText's done()).
    var editing = document.activeElement;
    if (editing && editing.isContentEditable && editing !== e.target && !editing.contains(e.target)) editing.blur();
    if (isForgotten(e.target)) { startLasso(e); return; }   // forgotten objects are neutral space
    if (isExpanse(e.target)) { startLasso(e); return; }   // empty slide area -> lasso / deselect
    // Ctrl/Cmd+Shift+DRAG pulls a copy out of the original — the copy is spawned only
    // once you actually drag (a bare click does nothing); Esc mid-drag abandons it.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      var srcDup = (e.target.closest && e.target.closest('[data-ppt-shape]')) || e.target;
      if (srcDup && srcDup !== document.body && !isUI(srcDup) && !isScenery(srcDup) && !isExpanse(srcDup)) {
        var grabbedInSel = multi.length > 1 && multi.some(function (m) { return m === srcDup || m === e.target || m.contains(e.target); });
        startDuplicateDrag(e, grabbedInSel ? multi.slice() : [srcDup], srcDup);
        return;
      }
    }
    var el = e.target;
    // Ctrl/Cmd+click toggles this element in/out of the selection (no drag, no edit).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); toggleInSelection(el); return;
    }
    // Pressing anywhere inside the current multi-selection — on a member OR any of
    // its descendants (e.g. the text inside a selected card) — drags the WHOLE set
    // together, with or without Shift held.
    if (multi.length > 1) {
      var member = null;
      for (var i = 0; i < multi.length; i++) { if (multi[i] === el || multi[i].contains(el)) { member = multi[i]; break; } }
      if (member) { startMove(e, member, false, multi.slice()); return; }
    }
    // Single selection: pressing inside it (the element OR a child) drags the WHOLE
    // selection — so a selected container moves as a unit, not grabbing a constituent.
    if (sel && multi.length <= 1 && !e.shiftKey && (el === sel || sel.contains(el))) {
      if (sel.isContentEditable) return;              // already editing -> let the caret happen
      startMove(e, sel, isTextEditable(sel), null);   // text box -> plain click edits; container -> drag
      return;
    }
    // PowerPoint feel: a plain click on an already-selected single text element
    // drops into text editing (not for groups / multi-selections).
    var clickEdits = (el === sel || multi.indexOf(el) >= 0) && !e.shiftKey && multi.length <= 1;
    if (multi.indexOf(el) < 0) select(el, e.shiftKey);   // select() expands groups
    if (el.isContentEditable) return; // already editing: let caret editing happen
    var dragGroup = (multi.length > 1 && multi.indexOf(el) >= 0) ? multi.slice() : null;
    startMove(e, el, clickEdits, dragGroup);
  }, true);

  // text-bearing leaf? (textbox, or an element whose only children are inline
  // formatting) — so we don't drop a structural container into contenteditable.
  function isTextEditable(el) {
    if (el.getAttribute('data-ppt-shape') === 'textbox') return true;
    var k = el.children;
    for (var i = 0; i < k.length; i++) {
      if (!/^(B|I|U|EM|STRONG|SPAN|A|BR|MARK|SMALL|SUB|SUP|CODE|FONT)$/.test(k[i].tagName)) return false;
    }
    return true;
  }

  function startMove(e, el, clickEdits, group, immediate) {
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY;
    // Move one element, or — for a multi-selection — every member by the same delta.
    var list = (group && group.length) ? group : [el];
    list = list.filter(function (m) { return !list.some(function (o) { return o !== m && o.contains && o.contains(m); }); });   // a nested member moves WITH its selected ancestor — never twice
    var members = list.map(function (m) {
      var ref = stageOf(m);
      return { el: m, isShape: m.getAttribute('data-ppt-shape'), ref: ref,
               start: relRect(m, ref), baseTransform: m.style.transform || '', prevCss: m.style.cssText };
    });
    // `immediate` tracks from pixel 1 (duplicate-drag knows it's a drag, so no 4px
    // threshold freeze — the copy emerges smoothly). Otherwise wait past threshold.
    var active = !!immediate, cancelled = false;
    if (immediate) dragging = true;
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function onEsc(ev) {                       // Esc mid-drag: abandon, snap back
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      cancelled = true; dragging = false;
      members.forEach(function (m) { m.el.style.cssText = m.prevCss; });
      cleanup(); positionChrome();
    }
    function move(ev) {
      if (cancelled) return;
      var dx = (ev.clientX - sx) / curScale, dy = (ev.clientY - sy) / curScale;  // screen -> local
      // Ignore sub-threshold jitter so a plain click is never treated as a drag.
      if (!active) {
        if (Math.abs(dx * curScale) < 4 && Math.abs(dy * curScale) < 4) return;
        active = true; dragging = true;
      }
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // Shift: constrain to one axis
      members.forEach(function (m) {
        if (m.isShape) { m.el.style.left = (m.start.left + dx) + 'px'; m.el.style.top = (m.start.top + dy) + 'px'; }
        else { m.el.style.transform = m.baseTransform + ' translate(' + dx + 'px,' + dy + 'px)'; }
      });
      positionChrome();
    }
    function up(ev) {
      cleanup();
      if (cancelled) return;
      if (!active) {                                // was a click, not a drag
        dragging = false;
        if (clickEdits && isTextEditable(el)) editText(el, { x: ev.clientX, y: ev.clientY });   // 2nd click -> edit (caret at click)
        return;
      }
      dragging = false;
      txStart(members.length > 1 ? 'move ' + members.length + ' items' : 'move', function () {
        members.forEach(function (m) { m.el.style.cssText = m.prevCss; });
      });
      members.forEach(function (m) {
        if (!m.isShape) m.el.style.transform = collapseTransform(m.el.style.transform);   // fold stacked translates -> one
        var now = relRect(m.el, m.ref);
        sendOp(m.el, 'move', { ref: selectorFor(m.ref), left: now.left, top: now.top, shape: !!m.isShape });
      });
      txCommit();
      positionChrome();
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', onEsc, true);
  }

  // ---- resize ---------------------------------------------------------------
  function startResize(e, dir) {
    if (!sel) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    var el = sel, ref = stageOf(el);
    var sx = e.clientX, sy = e.clientY, st = relRect(el, ref);
    var isShape = el.getAttribute('data-ppt-shape');
    var baseTransform = el.style.transform || '';
    var prevCss = el.style.cssText, cancelled = false;   // captured for undo / Esc-cancel
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function onEsc(ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      cancelled = true; dragging = false; el.style.cssText = prevCss; cleanup(); positionChrome();
    }
    function move(ev) {
      if (cancelled) return;
      var dx = (ev.clientX - sx) / curScale, dy = (ev.clientY - sy) / curScale;  // screen -> local
      var w = st.w, h = st.h, dLeft = 0, dTop = 0;
      // East/south handles grow from the fixed west/north edge. West/north handles must
      // keep the OPPOSITE edge fixed and grow toward the cursor — so we move left/top by
      // the size change (this is what makes a shape extend out of the side you grabbed).
      if (dir.indexOf('e') >= 0) w = Math.max(8, st.w + dx);
      if (dir.indexOf('s') >= 0) h = Math.max(8, st.h + dy);
      if (dir.indexOf('w') >= 0) { w = Math.max(8, st.w - dx); dLeft = st.w - w; }   // keep east edge fixed
      if (dir.indexOf('n') >= 0) { h = Math.max(8, st.h - dy); dTop = st.h - h; }     // keep south edge fixed
      el.style.width = w + 'px'; el.style.height = h + 'px';
      if (isShape) {
        if (dLeft) el.style.left = (st.left + dLeft) + 'px';
        if (dTop) el.style.top = (st.top + dTop) + 'px';
      } else if (dLeft || dTop) {
        el.style.transform = collapseTransform(baseTransform + ' translate(' + dLeft + 'px,' + dTop + 'px)');
      }
      positionChrome();
    }
    function up() {
      cleanup();
      if (cancelled) return;
      dragging = false;
      txStart('resize', function () { el.style.cssText = prevCss; });
      var now = relRect(el, ref);
      sendOp(el, 'resize', { w: now.w, h: now.h });
      txCommit();
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', onEsc, true);
  }

  // ---- text editing ---------------------------------------------------------
  function editText(el, pt) {
    // SVG text can't host a caret via contenteditable — edit it through an overlay input.
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      if (el.tagName && el.tagName.toLowerCase() === 'text') return editSvgText(el);
      var t = el.closest && el.closest('text'); if (t) return editSvgText(t);
      return;   // other SVG shapes aren't text-editable in place
    }
    if (el.isContentEditable) return;   // already editing
    select(el, false);
    var prevHTML = el.innerHTML, prevCss = el.style.cssText;   // captured for undo
    var prevOutline = el.style.outline;
    el.setAttribute('contenteditable', 'true');
    el.style.outline = 'none';                 // no border while editing — the caret is enough
    el.focus();
    placeCaret(el, pt);   // show the caret on this click — no extra click needed
    box.style.display = 'none'; handles.style.display = 'none';
    var finished = false;
    function done() {
      if (finished) return; finished = true;   // run once (blur, Esc-blur, or forced)
      el.removeEventListener('blur', done);
      el.removeAttribute('contenteditable');
      el.style.outline = prevOutline;          // restore — never leave an editing border behind
      try { window.getSelection().removeAllRanges(); } catch (e) {}
      txStart('edit text', function () { el.innerHTML = prevHTML; el.style.cssText = prevCss; });
      sendOp(el, 'setText', { text: el.innerText });
      if (el.querySelector && el.querySelector('b,i,u,span,br,ul,li'))
        sendOp(el, 'setHTML', { html: el.innerHTML });
      txCommit();
      positionChrome();
    }
    el.addEventListener('blur', done);
  }
  // SVG <text> isn't contenteditable in Chrome (no caret), so edit it through a
  // small HTML input positioned over the node; write the value back on commit.
  function editSvgText(el) {
    select(el, false);
    box.style.display = 'none'; handles.style.display = 'none';
    document.querySelectorAll('[data-ppt-svgedit]').forEach(function (n) { n.remove(); });
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    var anchor = el.getAttribute('text-anchor');
    var inp = document.createElement('input');
    inp.type = 'text'; inp.value = el.textContent;
    inp.setAttribute('data-ppt-ui', '1'); inp.setAttribute('data-ppt-svgedit', '1');
    var fs = (parseFloat(cs.fontSize) || 16) * curScale;
    inp.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.round(r.left - 6) + 'px;top:' +
      Math.round(r.top - 3) + 'px;width:' + Math.round(Math.max(48, r.width + 12)) + 'px;height:' +
      Math.round(Math.max(20, r.height + 6)) + 'px;font-family:' + cs.fontFamily + ';font-size:' + fs +
      'px;font-weight:' + cs.fontWeight + ';text-align:' + (anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left') +
      ';color:' + cs.fill + ';background:#fff;border:1px solid #2D6CDF;border-radius:3px;padding:0 3px;box-sizing:border-box';
    document.body.appendChild(inp);
    inp.focus(); inp.select();
    var prevText = el.textContent, finished = false;
    function commit(save) {
      if (finished) return; finished = true;
      inp.removeEventListener('blur', onBlur);
      var val = inp.value; inp.remove();
      if (save && val !== prevText) {
        txStart('edit text', function () { el.textContent = prevText; });
        el.textContent = val;
        sendOp(el, 'setText', { text: val });
        txCommit();
      }
      positionChrome();
    }
    function onBlur() { commit(true); }
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      ev.stopPropagation();
    });
    inp.addEventListener('blur', onBlur);
  }
  // Put a visible caret in a freshly-editable element — at the click point if we
  // have one (so the cursor lands where the user clicked), else at the end.
  function placeCaret(el, pt) {
    try {
      var range = null;
      if (pt && document.caretRangeFromPoint) range = document.caretRangeFromPoint(pt.x, pt.y);
      if (!range || !el.contains(range.startContainer)) {
        range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      }
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    } catch (e) {}
  }
  // True if the caret is collapsed at the very start of el (no text before it).
  function caretAtStart(el) {
    var s = window.getSelection();
    if (!s || !s.rangeCount) return false;
    var r = s.getRangeAt(0);
    if (!r.collapsed) return false;
    var probe = document.createRange();
    probe.selectNodeContents(el); probe.setEnd(r.startContainer, r.startOffset);
    return probe.toString().length === 0;
  }

  // ---- format ops -----------------------------------------------------------
  function applyStyle(el, style) { styleMany([el], function () { return style; }); }
  // Apply styles to one OR many elements as a SINGLE undoable transaction, so a
  // multi-select format is one Undo (not one step per object). computeStyle(el)->style.
  function styleMany(list, computeStyle) {
    if (!list.length) return;
    var prev = list.map(function (el) { return el.style.cssText; });
    txStart(list.length > 1 ? 'format ' + list.length + ' objects' : 'format',
      function () { list.forEach(function (el, i) { el.style.cssText = prev[i]; }); });
    list.forEach(function (el) {
      var style = computeStyle(el);
      for (var k in style) el.style.setProperty(k, style[k]);
      sendOp(el, 'setStyle', { style: style });
    });
    txCommit();
  }
  // Vertical placement of a text box's content (top / middle / bottom of the shape).
  function vAlignStyle(where) {
    return { 'display': 'flex', 'flex-direction': 'column',
      'justify-content': where === 'middle' ? 'center' : where === 'bottom' ? 'flex-end' : 'flex-start' };
  }
  function setVAlign(el, where) { applyStyle(el, vAlignStyle(where)); }
  // The current target list for format ops: the whole multi-selection if any, else
  // the single selection. Lets font/color/fill/outline apply to all selected boxes.
  function selList() { return multi.length ? multi.slice() : (sel ? [sel] : []); }
  // A "text leaf": an element that holds its own text with no block child that also
  // holds text (inline formatting / tspans are fine). Text ops target these, so
  // selecting a big CONTAINER applies to all the text inside it (PowerPoint-style).
  function isTextLeaf(el) {
    if (!el || el.nodeType !== 1 || isUI(el)) return false;
    if (!(el.textContent || '').trim()) return false;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if ((c.textContent || '').trim() && !/^(B|I|U|EM|STRONG|SPAN|A|BR|MARK|SMALL|SUB|SUP|CODE|FONT|TSPAN)$/i.test(c.tagName)) return false;
    }
    return true;
  }
  function textTargets(els) {
    var out = [];
    els.forEach(function (el) {
      if (isTextLeaf(el)) { if (out.indexOf(el) < 0) out.push(el); return; }
      var leaves = Array.prototype.filter.call(el.querySelectorAll('*'), isTextLeaf);
      if (leaves.length) leaves.forEach(function (d) { if (out.indexOf(d) < 0) out.push(d); });
      else if (out.indexOf(el) < 0) out.push(el);   // no inner text leaves -> the element itself
    });
    return out;
  }
  function updateFontReadout() {
    var fzEl = bar.querySelector('[data-fz]'); if (!fzEl || document.activeElement === fzEl) return;
    var t = sel ? (textTargets([sel])[0] || sel) : null;
    fzEl.value = t ? (Math.round(parseFloat(getComputedStyle(t).fontSize)) || '') : '';
  }
  function fmt(name, anchor) {
    var list = selList(); if (!list.length) return;
    var textList = textTargets(list);                    // text ops apply to the text WITHIN containers
    var cs = getComputedStyle(textList[0] || list[0]);   // toggle state keys off the first text target
    function allText(style) { styleMany(textList, function () { return style; }); }   // ONE undo for the whole selection
    function allBox(style) { styleMany(list, function () { return style; }); }
    if (name === 'bold') allText({ 'font-weight': cs.fontWeight === '700' ? '400' : '700' });
    else if (name === 'italic') allText({ 'font-style': cs.fontStyle === 'italic' ? 'normal' : 'italic' });
    else if (name === 'underline') allText({ 'text-decoration': cs.textDecorationLine === 'underline' ? 'none' : 'underline' });
    else if (name === 'bigger') styleMany(textList, function (el) { var c = getComputedStyle(el); return { 'font-size': (parseFloat(c.fontSize) + 2) + 'px' }; });
    else if (name === 'smaller') styleMany(textList, function (el) { var c = getComputedStyle(el); return { 'font-size': Math.max(4, parseFloat(c.fontSize) - 2) + 'px' }; });
    else if (name === 'bullets') allText(cs.display === 'list-item'   // already bulleted -> toggle off
      ? { 'display': 'block', 'list-style': 'none', 'margin-left': '0' }
      : { 'display': 'list-item', 'list-style': 'disc', 'margin-left': '1.2em' });
    else if (name === 'color') openColorPopover(anchor, 'Text color', function (c) { allText({ 'color': c || 'inherit' }); });
    else if (name === 'fill') openColorPopover(anchor, 'Fill color', function (c) { allBox({ 'background-color': c || 'transparent' }); });
    else if (name === 'outline') openColorPopover(anchor, 'Outline color', function (c) { allBox(c ? { 'border': '2px solid ' + c } : { 'border': 'none' }); });
    updateFontReadout();
  }
  // Set an explicit numeric font size (from the ribbon box) on all text in the selection.
  function setFontSize(px) {
    var list = selList(); if (!list.length || !(px > 0)) return;
    styleMany(textTargets(list), function () { return { 'font-size': px + 'px' }; });
    updateFontReadout();
  }
  // ---- clipboard: objects (Ctrl/Cmd+C/V) + formats (Ctrl/Cmd+Shift+C/V) -------
  var objClip = [];      // source nodes copied for object paste (cloned at paste time)
  var fmtClip = null;    // captured format properties for format paste
  var FMT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line',
    'color', 'text-align', 'line-height', 'letter-spacing', 'background-color', 'border', 'border-radius', 'padding'];
  function freshClone(srcEl) {
    var node = srcEl.cloneNode(true);
    node.removeAttribute('data-ppt-h'); if (node.id) node.id = '';
    node.querySelectorAll('[data-ppt-h]').forEach(function (n) { n.removeAttribute('data-ppt-h'); });
    node.querySelectorAll('[id]').forEach(function (n) { n.id = ''; });
    return node;
  }
  // Ctrl/Cmd+Shift+drag: the copy is pulled OUT of the original by the drag itself.
  // Nothing is created until the pointer actually moves (a bare click does nothing);
  // the copy then tracks the cursor; Esc before release abandons it. Shift locks axis.
  function startDuplicateDrag(e, srcs, grabbed) {
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY;
    var copies = null, members = null, cancelled = false;
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function makeCopies() {
      copies = srcs.map(function (srcEl) {
        var node = freshClone(srcEl);
        srcEl.parentNode.insertBefore(node, srcEl.nextSibling);
        ensureHandle(node);
        return node;
      });
      var anchor = copies[srcs.indexOf(grabbed)] || copies[copies.length - 1] || copies[0];
      members = copies.map(function (m) {
        var ref = stageOf(m);
        return { el: m, isShape: m.getAttribute('data-ppt-shape'), ref: ref, start: relRect(m, ref), baseTransform: m.style.transform || '' };
      });
      multi = copies.length > 1 ? copies.slice() : []; sel = anchor; dragging = true; positionChrome();
    }
    function onEsc(ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      cancelled = true; dragging = false;
      if (copies) copies.forEach(function (n) { n.remove(); });   // abandon: remove the spawned copies
      cleanup(); clearSel(); positionChrome();
    }
    function move(ev) {
      if (cancelled) return;
      var dx = (ev.clientX - sx) / curScale, dy = (ev.clientY - sy) / curScale;
      if (!copies) {                                   // wait for a real drag before spawning anything
        if (Math.abs(dx * curScale) < 3 && Math.abs(dy * curScale) < 3) return;
        makeCopies();
      }
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // Shift: constrain to one axis
      members.forEach(function (m) {
        if (m.isShape) { m.el.style.left = (m.start.left + dx) + 'px'; m.el.style.top = (m.start.top + dy) + 'px'; }
        else { m.el.style.transform = m.baseTransform + ' translate(' + dx + 'px,' + dy + 'px)'; }
      });
      positionChrome();
    }
    function up() {
      cleanup(); dragging = false;
      if (cancelled || !copies) return;                // bare click (no drag) created nothing
      var made = copies.slice();
      txStart('duplicate ' + made.length + (made.length > 1 ? ' objects' : ''), function () { made.forEach(function (n) { n.remove(); }); clearSel(); positionChrome(); });
      made.forEach(function (n) { sendOp(n, 'create', { kind: 'duplicate', shape: n.getAttribute('data-ppt-shape') || null, html: n.outerHTML }); });
      txCommit();
      positionChrome();
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', onEsc, true);
  }
  function copyObjects() {
    objClip = selList().filter(function (el) { return document.contains(el); });
    if (!objClip.length) { flash('select object(s) to copy'); return; }
    flash('Copied ' + objClip.length + ' object' + (objClip.length > 1 ? 's' : ''));
  }
  function pasteObjects() {
    var src = objClip.filter(function (el) { return document.contains(el); });
    if (!src.length) { flash('clipboard empty'); return; }
    var made = [];
    txStart('paste ' + src.length + ' object' + (src.length > 1 ? 's' : ''), function () { made.forEach(function (n) { n.remove(); }); });
    src.forEach(function (el) {
      var node = freshClone(el);
      el.parentNode.insertBefore(node, el.nextSibling);
      if (node.getAttribute('data-ppt-shape') || getComputedStyle(node).position === 'absolute') {
        node.style.left = ((parseFloat(getComputedStyle(node).left) || 0) + 18) + 'px';
        node.style.top = ((parseFloat(getComputedStyle(node).top) || 0) + 18) + 'px';
      } else {
        node.style.transform = (node.style.transform || '') + ' translate(18px,18px)';
      }
      ensureHandle(node);
      sendOp(node, 'create', { kind: 'paste', shape: node.getAttribute('data-ppt-shape') || null, html: node.outerHTML });
      made.push(node);
    });
    txCommit();
    multi = made.length > 1 ? made.slice() : [];
    sel = made[made.length - 1] || null;
    positionChrome();
    flash('Pasted ' + made.length);
  }
  function copyFormat() {
    var el = sel || selList()[0]; if (!el) { flash('select an object to copy its format'); return; }
    var cs = getComputedStyle(el); fmtClip = {};
    FMT_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) fmtClip[p] = v; });
    if (fmtClip['text-decoration-line']) { fmtClip['text-decoration'] = fmtClip['text-decoration-line']; delete fmtClip['text-decoration-line']; }
    flash('Copied format — Ctrl/Cmd+Shift+V to apply');
  }
  function pasteFormat() {
    if (!fmtClip) { flash('copy a format first (Ctrl/Cmd+Shift+C)'); return; }
    var list = selList(); if (!list.length) { flash('select target object(s)'); return; }
    styleMany(list, function () { return fmtClip; });
    flash('Pasted format to ' + list.length + ' object' + (list.length > 1 ? 's' : ''));
  }
  var SWATCHES = ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#efefef', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff',
    '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3',
    '#071D49', '#E8B23A', '#2D6CDF', '#1FA47A', '#B5532E', '#8497B0', '#3A4A6B', '#D9E0EA'];
  function openColorPopover(anchor, label, apply) {
    document.querySelectorAll('[data-ppt-cpop]').forEach(function (n) { n.remove(); });
    var r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: 120, bottom: 120 };
    var pop = document.createElement('div');
    pop.setAttribute('data-ppt-ui', '1'); pop.setAttribute('data-ppt-cpop', '1');
    pop.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.max(6, Math.min(r.left, innerWidth - 252)) +
      'px;top:' + Math.min((r.bottom || 120) + 6, innerHeight - 270) + 'px;background:#fff;color:#111;border:1px solid #ccc;' +
      'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.3);padding:10px;font:13px system-ui;width:240px';
    var sw = SWATCHES.map(function (c) {
      return '<button data-col="' + c + '" title="' + c + '" style="width:24px;height:24px;border:1px solid #ccc;' +
        'border-radius:4px;background:' + c + ';cursor:pointer;padding:0;margin:1px"></button>';
    }).join('');
    var btn = 'flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;background:#f4f6f8;cursor:pointer;font:12px system-ui';
    pop.innerHTML = '<div style="font-weight:600;margin-bottom:6px">' + esc(label) + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:2px">' + sw + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:9px">' +
      (window.EyeDropper ? '<button data-eye style="' + btn + '">⊙ Eyedrop</button>' : '') +
      '<button data-custom style="' + btn + '">Custom…</button>' +
      '<button data-none style="' + btn + ';flex:0 0 auto">None</button></div>';
    document.body.appendChild(pop);
    function close() { pop.remove(); document.removeEventListener('keydown', onK, true); document.removeEventListener('mousedown', onOut, true); }
    function onK(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } }
    function onOut(ev) { if (!pop.contains(ev.target)) close(); }
    document.addEventListener('keydown', onK, true);
    setTimeout(function () { document.addEventListener('mousedown', onOut, true); }, 0);
    pop.querySelectorAll('[data-col]').forEach(function (b) { b.onclick = function () { apply(b.getAttribute('data-col')); close(); }; });
    var eye = pop.querySelector('[data-eye]');
    if (eye) eye.onclick = function () { if (window.EyeDropper) new window.EyeDropper().open().then(function (res) { apply(res.sRGBHex); close(); }).catch(function () {}); };
    pop.querySelector('[data-custom]').onclick = function () {
      var inp = document.createElement('input'); inp.type = 'color'; inp.setAttribute('data-ppt-ui', '1');
      inp.onchange = function () { apply(inp.value); close(); }; inp.click();
    };
    pop.querySelector('[data-none]').onclick = function () { apply(null); close(); };
  }

  // ---- align / z-order (Tier 2: needs a stage) ------------------------------
  // Single selection: align to the slide/stage. Multiple selection (shift-click):
  // align the shapes to their shared bounding box (PowerPoint "align selected").
  function isGroupSelection(targets) {
    if (targets.length < 2) return false;
    var g = targets[0].getAttribute && targets[0].getAttribute('data-ppt-group');
    return !!g && targets.every(function (el) { return el.getAttribute && el.getAttribute('data-ppt-group') === g; });
  }
  // A formal group aligns RIGIDLY: shift the group's bounding box to the slide edge by
  // one delta, so members keep their relative positions (they don't collapse onto a line).
  function alignGroupRigid(targets, side, ref, rr) {
    var ls = [], ts = [], rs = [], bs = [];
    targets.forEach(function (el) { var r = el.getBoundingClientRect(); ls.push(r.left); ts.push(r.top); rs.push(r.right); bs.push(r.bottom); });
    var gL = (Math.min.apply(null, ls) - rr.left) / curScale, gT = (Math.min.apply(null, ts) - rr.top) / curScale;
    var gW = (Math.max.apply(null, rs) - Math.min.apply(null, ls)) / curScale, gH = (Math.max.apply(null, bs) - Math.min.apply(null, ts)) / curScale;
    var slideW = rr.width / curScale, slideH = rr.height / curScale, dL = 0, dT = 0;
    if (side === 'left') dL = -gL;
    else if (side === 'right') dL = (slideW - gW) - gL;
    else if (side === 'center') dL = (slideW - gW) / 2 - gL;
    else if (side === 'top') dT = -gT;
    else if (side === 'bottom') dT = (slideH - gH) - gT;
    else if (side === 'middle') dT = (slideH - gH) / 2 - gT;
    var snaps = targets.map(function (el) { return { el: el, css: el.style.cssText }; });
    txStart('align group ' + side, function () { snaps.forEach(function (s) { s.el.style.cssText = s.css; }); });
    targets.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var leftRel = Math.round((r.left - rr.left) / curScale + dL), topRel = Math.round((r.top - rr.top) / curScale + dT);
      applyPos(el, ref, rr, leftRel, topRel);
      sendOp(el, 'move', { ref: selectorFor(ref), left: leftRel, top: topRel, shape: !!el.getAttribute('data-ppt-shape'), align: side });
    });
    txCommit(); positionChrome();
  }
  function alignSel(side) {
    if (!sel) return;
    var ref = stageOf(sel), rr = ref.getBoundingClientRect();
    var targets = multi.length ? multi.slice() : [sel];
    if (targets.length > 1 && isGroupSelection(targets)) { alignGroupRigid(targets, side, ref, rr); return; }
    var frame;
    if (targets.length > 1) {
      var ls = [], ts = [], rs = [], bs = [];
      targets.forEach(function (el) {
        var r = el.getBoundingClientRect();
        ls.push(r.left); ts.push(r.top); rs.push(r.right); bs.push(r.bottom);
      });
      frame = { left: (Math.min.apply(null, ls) - rr.left) / curScale, top: (Math.min.apply(null, ts) - rr.top) / curScale,
                right: (Math.max.apply(null, rs) - rr.left) / curScale, bottom: (Math.max.apply(null, bs) - rr.top) / curScale };
      frame.width = frame.right - frame.left; frame.height = frame.bottom - frame.top;
    } else {
      frame = { left: 0, top: 0, width: rr.width / curScale, height: rr.height / curScale };
    }
    var snaps = targets.map(function (el) { return { el: el, css: el.style.cssText }; });
    txStart('align ' + side, function () { snaps.forEach(function (s) { s.el.style.cssText = s.css; }); });
    targets.forEach(function (el) {
      var r = el.getBoundingClientRect(), w = r.width / curScale, h = r.height / curScale;
      var leftRel = Math.round((r.left - rr.left) / curScale), topRel = Math.round((r.top - rr.top) / curScale);
      if (side === 'left') leftRel = Math.round(frame.left);
      else if (side === 'right') leftRel = Math.round(frame.left + frame.width - w);
      else if (side === 'center') leftRel = Math.round(frame.left + (frame.width - w) / 2);
      else if (side === 'top') topRel = Math.round(frame.top);
      else if (side === 'bottom') topRel = Math.round(frame.top + frame.height - h);
      else if (side === 'middle') topRel = Math.round(frame.top + (frame.height - h) / 2);
      applyPos(el, ref, rr, leftRel, topRel);
      sendOp(el, 'move', { ref: selectorFor(ref), left: leftRel, top: topRel,
                           shape: !!el.getAttribute('data-ppt-shape'), align: side });
    });
    txCommit();
    positionChrome();
  }
  // Make selected shapes match the FIRST-selected one's width/height/size.
  function matchSize(dim) {
    var list = multi.length > 1 ? multi.slice() : [];
    if (list.length < 2) { flash('Select 2+ shapes — the first one governs'); return; }
    var gov = list[0];
    if (dim === 'both' && gov.getAttribute('data-ppt-shape') === 'line') { flash('Pick a non-line shape first'); return; }
    var gr = relRect(gov, stageOf(gov)), rest = list.slice(1);
    var snaps = rest.map(function (el) { return { el: el, css: el.style.cssText }; });
    txStart('match ' + (dim === 'w' ? 'width' : dim === 'h' ? 'height' : 'size'),
      function () { snaps.forEach(function (s) { s.el.style.cssText = s.css; }); });
    rest.forEach(function (el) {
      if (dim === 'both' && el.getAttribute('data-ppt-shape') === 'line') return;   // don't squash lines
      if (dim === 'w' || dim === 'both') el.style.width = gr.w + 'px';
      if (dim === 'h' || dim === 'both') el.style.height = gr.h + 'px';
      var now = relRect(el, stageOf(el));
      sendOp(el, 'resize', { w: now.w, h: now.h });
    });
    txCommit();
    positionChrome();
    flash('Matched ' + (dim === 'w' ? 'width' : dim === 'h' ? 'height' : 'size') + ' to first shape');
  }
  // Center selected shapes onto the FIRST-selected one along one axis.
  // axis 'x' = match horizontal centre (keep each one's own top);
  // axis 'y' = match vertical centre (keep each one's own left).
  function centerSel(axis) {
    var list = multi.length > 1 ? multi.slice() : [];
    if (list.length < 2) { flash('Select 2+ shapes — the first one governs'); return; }
    var gov = list[0], ref = stageOf(gov), rr = ref.getBoundingClientRect();
    var gr = gov.getBoundingClientRect();
    var cx = (gr.left + gr.width / 2 - rr.left) / curScale;
    var cy = (gr.top + gr.height / 2 - rr.top) / curScale;
    var rest = list.slice(1);
    var snaps = rest.map(function (el) { return { el: el, css: el.style.cssText }; });
    txStart('center ' + (axis === 'x' ? 'horizontally' : 'vertically'),
      function () { snaps.forEach(function (s) { s.el.style.cssText = s.css; }); });
    rest.forEach(function (el) {
      var r = el.getBoundingClientRect(), w = r.width / curScale, h = r.height / curScale;
      var leftRel = Math.round((r.left - rr.left) / curScale), topRel = Math.round((r.top - rr.top) / curScale);
      if (axis === 'x') leftRel = Math.round(cx - w / 2);
      else topRel = Math.round(cy - h / 2);
      applyPos(el, ref, rr, leftRel, topRel);
      sendOp(el, 'move', { ref: selectorFor(ref), left: leftRel, top: topRel,
                           shape: !!el.getAttribute('data-ppt-shape') });
    });
    txCommit();
    positionChrome();
    flash('Centered ' + (axis === 'x' ? 'horizontally' : 'vertically') + ' on first shape');
  }
  function zorder(where) {
    if (!sel) return;
    var z = where === 'front' ? 1000 : 0;
    applyStyle(sel, { 'z-index': String(z), 'position': sel.style.position || 'relative' });
  }
  // Arrow-key nudge. Holding an arrow autorepeats fast — if each keypress were its own
  // transaction the source file would be rewritten hundreds of times and Undo would
  // crawl back one pixel at a time. So a burst is COALESCED into one session: the DOM
  // moves live on every press, but the source write + blueprint op + undo step are
  // debounced to fire ONCE when the burst settles (~450ms idle). All writes in a
  // session share one txid, so even a multi-flush burst is a single undo checkpoint.
  // The session also coalesces Shift+Arrow RESIZE bursts (kind:'resize') the same way —
  // one undo step + one debounced source write per burst. Source writes are wholesale
  // inline-style either way, so a centered resize (which changes width AND left/top)
  // persists correctly whichever op is logged.
  var nudgeSession = null;
  function nudgeFlush(ns) {
    if (!ns.dirty) return;
    ns.dirty = false;
    var now = relRect(ns.el, ns.ref);
    if (ns.kind === 'resize') sendOp(ns.el, 'resize', { w: now.w, h: now.h }, ns.txid);
    else sendOp(ns.el, 'move', { ref: selectorFor(ns.ref), left: now.left, top: now.top, shape: !!ns.isShape }, ns.txid);
    ns.emitted++;
  }
  function nudgeEnd() {
    var ns = nudgeSession; if (!ns) return;
    nudgeSession = null;
    if (ns.idleTimer) { clearTimeout(ns.idleTimer); ns.idleTimer = null; }
    nudgeFlush(ns);
    if (ns.emitted > 0) {                      // one undo step for the whole burst
      undoStack.push({ label: ns.kind === 'resize' ? 'resize' : 'nudge', revert: ns.revert,
                       ops: ns.emitted, srcWrites: 1, txid: ns.txid });
      refreshUndo();
    }
  }
  function keySession(kind) {   // open (or reuse) a coalescing session for the selection
    if (nudgeSession && (nudgeSession.el !== sel || nudgeSession.kind !== kind)) nudgeEnd();
    if (!nudgeSession) {
      var el = sel, prevCss = el.style.cssText;
      nudgeSession = { el: el, ref: stageOf(el), isShape: el.getAttribute('data-ppt-shape'),
                       kind: kind, txid: 't' + (++txSeq), emitted: 0, dirty: false, idleTimer: null,
                       revert: function () { el.style.cssText = prevCss; } };
    }
    return nudgeSession;
  }
  function keyTick(ns) {
    ns.dirty = true;
    positionChrome();
    if (ns.idleTimer) clearTimeout(ns.idleTimer);
    ns.idleTimer = setTimeout(nudgeEnd, 450);   // settle the burst, then write + bank one undo step
  }
  function nudge(dx, dy) {
    if (!sel) return;
    var ns = keySession('move');
    if (ns.isShape) {
      var now = relRect(ns.el, ns.ref);
      ns.el.style.left = (now.left + dx) + 'px'; ns.el.style.top = (now.top + dy) + 'px';
    } else {
      ns.el.style.transform = collapseTransform((ns.el.style.transform || '') + ' translate(' + dx + 'px,' + dy + 'px)');   // fold, don't stack
    }
    keyTick(ns);
  }
  // Shift+Arrow resize: grow/shrink the selected box by (dw,dh) while keeping its CENTER
  // fixed (so it stays put as it resizes). Shapes move via left/top; in-flow boxes via a
  // transform shift of half the delta. Min size 8px.
  function sizeStep(dw, dh) {
    if (!sel) return;
    var ns = keySession('resize');
    var r = relRect(ns.el, ns.ref);
    var nw = Math.max(8, r.w + dw), nh = Math.max(8, r.h + dh);
    var adw = nw - r.w, adh = nh - r.h;                     // actual deltas after clamping
    ns.el.style.width = nw + 'px'; ns.el.style.height = nh + 'px';
    if (ns.isShape) {
      ns.el.style.left = (r.left - adw / 2) + 'px';
      ns.el.style.top = (r.top - adh / 2) + 'px';
    } else if (adw || adh) {
      ns.el.style.transform = collapseTransform((ns.el.style.transform || '') + ' translate(' + (-adw / 2) + 'px,' + (-adh / 2) + 'px)');
    }
    keyTick(ns);
  }

  // Place an element at a target (left,top) within ref: absolute for shapes, a
  // transform shift for in-flow elements (measured from natural position).
  // leftRel/topRel are LOCAL (unscaled) coords within ref.
  function applyPos(el, ref, rr, leftRel, topRel) {
    if (el.getAttribute('data-ppt-shape')) {
      el.style.position = 'absolute'; el.style.left = leftRel + 'px'; el.style.top = topRel + 'px';
    } else {
      el.style.transform = '';
      var nat = el.getBoundingClientRect();
      el.style.transform = 'translate(' + Math.round(((rr.left + leftRel * curScale) - nat.left) / curScale) +
        'px,' + Math.round(((rr.top + topRel * curScale) - nat.top) / curScale) + 'px)';
    }
  }
  // Distribute selected elements so the gaps between them are equal. Endpoints
  // (first/last along the axis) stay put, like PowerPoint. axis: 'h' or 'v'.
  function distributeSel(axis) {
    if (multi.length < 3) { flash('Select 3+ elements to distribute (Shift-click)'); return; }
    var ref = stageOf(sel), rr = ref.getBoundingClientRect();
    // work in LOCAL (unscaled) coords so distribute is correct under zoom
    var items = multi.map(function (el) {
      var r = el.getBoundingClientRect();
      return { el: el, left: (r.left - rr.left) / curScale, top: (r.top - rr.top) / curScale,
               w: r.width / curScale, h: r.height / curScale,
               right: (r.right - rr.left) / curScale, bottom: (r.bottom - rr.top) / curScale };
    });
    items.sort(function (a, b) { return axis === 'h' ? a.left - b.left : a.top - b.top; });
    var first = items[0], last = items[items.length - 1];
    var sumSize = 0; items.forEach(function (it) { sumSize += axis === 'h' ? it.w : it.h; });
    var span = axis === 'h' ? (last.right - first.left) : (last.bottom - first.top);
    var gap = (span - sumSize) / (items.length - 1);
    var snaps = items.map(function (it) { return { el: it.el, css: it.el.style.cssText }; });
    txStart('distribute ' + axis, function () { snaps.forEach(function (s) { s.el.style.cssText = s.css; }); });
    var cursor = axis === 'h' ? first.left : first.top;
    items.forEach(function (it) {
      var leftRel = Math.round(it.left), topRel = Math.round(it.top);
      if (axis === 'h') { leftRel = Math.round(cursor); cursor += it.w + gap; }
      else { topRel = Math.round(cursor); cursor += it.h + gap; }
      applyPos(it.el, ref, rr, leftRel, topRel);
      sendOp(it.el, 'move', { ref: selectorFor(ref), left: leftRel, top: topRel,
                             shape: !!it.el.getAttribute('data-ppt-shape'), distribute: axis });
    });
    txCommit();
    positionChrome();
  }

  // ---- group / ungroup (selection stickiness; client-side editing aid) ------
  function groupSel() {
    var targets = multi.length ? multi.slice() : (sel ? [sel] : []);
    if (targets.length < 2) { flash('Select 2+ items to group (Shift-click)'); return; }
    var gid = 'g' + (++groupSeq);
    targets.forEach(function (el) { el.setAttribute('data-ppt-group', gid); });
    flash('Grouped ' + targets.length + ' items (Ctrl+Shift+G to ungroup)');
  }
  function ungroupSel() {
    var targets = multi.length ? multi.slice() : (sel ? [sel] : []);
    var ids = {};
    targets.forEach(function (el) { var g = el.getAttribute('data-ppt-group'); if (g) ids[g] = 1; });
    if (!Object.keys(ids).length) { flash('Nothing grouped in the selection'); return; }
    Object.keys(ids).forEach(function (g) {
      document.querySelectorAll('[data-ppt-group="' + g + '"]').forEach(function (el) { el.removeAttribute('data-ppt-group'); });
    });
    flash('Ungrouped');
  }

  // ---- create shapes --------------------------------------------------------
  function arm(type) { placing = type; document.body.style.cursor = 'crosshair'; }
  function disarm() { placing = null; document.body.style.cursor = ''; }

  // PowerPoint-style draw: click-drag-release to size rect/oval/line. Shift keeps
  // rect/oval square/circle and snaps a line to 45°. A bare click = default size.
  function startShapeDraw(e, type) {
    e.preventDefault();
    var stage = document.elementFromPoint(e.clientX, e.clientY);
    stage = (stage && stage.closest && stage.closest('.slide, #stage, [data-ppt-stage]')) || document.body;
    if (getComputedStyle(stage).position === 'static' && stage !== document.body) stage.style.position = 'relative';
    var rr = stage.getBoundingClientRect();
    var x0 = e.clientX, y0 = e.clientY;
    var lx = (x0 - rr.left) / curScale, ly = (y0 - rr.top) / curScale;
    var el = document.createElement('div');
    el.setAttribute('data-ppt-shape', type);
    var base = 'position:absolute;box-sizing:border-box;left:' + lx + 'px;top:' + ly + 'px;';
    if (type === 'rect') el.style.cssText = base + 'width:0;height:0;background:#2da6ff;';
    else if (type === 'oval') el.style.cssText = base + 'width:0;height:0;background:#2da6ff;border-radius:50%;';
    else el.style.cssText = base + 'height:0;border-top:3px solid #111;transform-origin:0 0;width:0;';
    stage.appendChild(el);
    var geom = { left: Math.round(lx), top: Math.round(ly), width: 0, height: 0, angle: 0 };
    var cancelled = false;
    function move(ev) {
      if (cancelled) return;
      var dx = (ev.clientX - x0) / curScale, dy = (ev.clientY - y0) / curScale;
      if (type === 'line') {
        var len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
        if (ev.shiftKey) ang = Math.round(ang / 45) * 45;
        el.style.width = len + 'px'; el.style.transform = 'rotate(' + ang + 'deg)';
        geom.width = Math.round(len); geom.angle = Math.round(ang);
      } else {
        var w = Math.abs(dx), h = Math.abs(dy);
        if (ev.shiftKey) { var m = Math.max(w, h); w = m; h = m; }
        var left = dx < 0 ? lx - w : lx, top = dy < 0 ? ly - h : ly;
        el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
        geom.left = Math.round(left); geom.top = Math.round(top); geom.width = Math.round(w); geom.height = Math.round(h);
      }
    }
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function onEsc(ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      cancelled = true; if (el.parentNode) el.parentNode.removeChild(el); disarm(); cleanup();
    }
    function up() {
      cleanup();
      if (cancelled) return;
      if (type === 'line') {
        if (geom.width < 5) { geom.width = 160; geom.angle = 0; el.style.width = '160px'; el.style.transform = ''; }
      } else if (geom.width < 5 && geom.height < 5) {     // bare click -> default size
        geom.width = type === 'rect' ? 160 : 120; geom.height = type === 'rect' ? 90 : 120;
        geom.left = Math.round(lx); geom.top = Math.round(ly);
        el.style.left = lx + 'px'; el.style.top = ly + 'px';
        el.style.width = geom.width + 'px'; el.style.height = geom.height + 'px';
      }
      ensureHandle(el);
      txStart('add ' + type, function () { if (el.parentNode) el.parentNode.removeChild(el); });
      sendOp(el, 'create', { type: type, parent: selectorFor(stage), frame: selectorFor(stage), props: geom });
      txCommit();
      disarm();
      select(el, false);
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', onEsc, true);
  }

  // PowerPoint-style lasso: drag on empty slide space to rubber-band a selection
  // of the top-level objects fully enclosed by the box.
  function startLasso(e) {
    e.preventDefault();
    var x0 = e.clientX, y0 = e.clientY, additive = e.shiftKey;   // Shift+lasso adds to the current selection
    var slide = (e.target.closest && e.target.closest('.slide, #stage, [data-ppt-stage]')) || document.body;
    var rb = document.createElement('div');
    rb.setAttribute('data-ppt-ui', '1');
    rb.style.cssText = 'position:fixed;z-index:2147483640;border:1px solid #2da6ff;background:rgba(45,166,255,.12);' +
      'left:' + x0 + 'px;top:' + y0 + 'px;width:0;height:0;pointer-events:none';
    document.body.appendChild(rb);
    var active = false;
    function move(ev) {
      var dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!active) { if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; active = true; }
      rb.style.left = Math.min(x0, ev.clientX) + 'px'; rb.style.top = Math.min(y0, ev.clientY) + 'px';
      rb.style.width = Math.abs(dx) + 'px'; rb.style.height = Math.abs(dy) + 'px';
    }
    function up(ev) {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      rb.remove();
      if (!active) { if (!additive) clearSel(); return; }   // plain click clears; Shift keeps the selection
      var L = Math.min(x0, ev.clientX), T = Math.min(y0, ev.clientY), R = Math.max(x0, ev.clientX), B = Math.max(y0, ev.clientY);
      var cands = Array.from(slide.querySelectorAll('*')).filter(function (el) {
        return !isUI(el) && !isScenery(el) && el !== slide;
      });
      var enclosed = cands.filter(function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= L - 1 && r.top >= T - 1 && r.right <= R + 1 && r.bottom <= B + 1;
      });
      var top = enclosed.filter(function (el) {            // keep only outermost enclosed
        var p = el.parentElement;
        while (p && p !== slide) { if (enclosed.indexOf(p) >= 0) return false; p = p.parentElement; }
        return true;
      });
      if (!top.length) { if (!additive) clearSel(); return; }
      var base = additive ? (multi.length ? multi.slice() : (sel ? [sel] : [])) : [];
      top.forEach(function (el) { if (base.indexOf(el) < 0) base.push(el); });
      multi = base.length > 1 ? base : []; sel = base[base.length - 1]; positionChrome();
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }
  function placeAt(x, y) {
    var stage = document.elementFromPoint(x, y);
    stage = (stage && stage.closest && stage.closest('.slide, #stage, [data-ppt-stage]')) || document.body;
    var rr = stage.getBoundingClientRect();
    var left = Math.round((x - rr.left) / curScale), top = Math.round((y - rr.top) / curScale);
    if (getComputedStyle(stage).position === 'static' && stage !== document.body)
      stage.style.position = 'relative';
    var el = document.createElement('div');
    el.setAttribute('data-ppt-shape', placing);
    var base = 'position:absolute;left:' + left + 'px;top:' + top + 'px;box-sizing:border-box;';
    if (placing === 'textbox') {
      el.style.cssText = base + 'min-width:120px;min-height:24px;font:16px system-ui;color:#111;padding:4px';
      el.textContent = 'Text';
    } else if (placing === 'rect') {
      el.style.cssText = base + 'width:160px;height:90px;background:#2da6ff;';
    } else if (placing === 'oval') {
      el.style.cssText = base + 'width:120px;height:120px;background:#2da6ff;border-radius:50%;';
    } else if (placing === 'line') {
      el.style.cssText = base + 'width:160px;height:0;border-top:3px solid #111;';
    }
    var type = placing;
    stage.appendChild(el);
    ensureHandle(el);
    txStart('add ' + type, function () { if (el.parentNode) el.parentNode.removeChild(el); });
    sendOp(el, 'create', { type: type, parent: selectorFor(stage),
                           frame: selectorFor(stage),
                           props: { left: left, top: top } });
    txCommit();
    disarm();
    select(el, false);
    if (type === 'textbox') editText(el);
  }

  // ---- delete ---------------------------------------------------------------
  function delSel() {
    if (!sel) return;
    var list = multi.length > 1 ? multi.slice() : [sel];
    var recs = list.map(function (el) { return { el: el, parent: el.parentNode, next: el.nextSibling }; });
    txStart(list.length > 1 ? 'delete ' + list.length + ' items' : 'delete', function () {
      recs.forEach(function (r) {
        if (!r.parent) return;
        if (r.next && r.next.parentNode === r.parent) r.parent.insertBefore(r.el, r.next);
        else r.parent.appendChild(r.el);
      });
    });
    list.forEach(function (el) { sendOp(el, 'delete', {}); });   // one op each -> undo pops them all
    txCommit();
    list.forEach(function (el) { el.remove(); });                // disappear in-browser immediately
    clearSel();
  }

  // ---- draggable floating box (comment box etc.) ----------------------------
  // Grab anywhere in the box except inputs/buttons to reposition it; clamped to
  // the viewport so it can't be dragged off-screen.
  function makeDraggable(boxEl) {
    boxEl.style.cursor = 'move';
    boxEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('textarea, input, button, select, a')) return;  // let controls work
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY;
      var r = boxEl.getBoundingClientRect(), ox = r.left, oy = r.top;
      function mv(ev) {
        var nx = Math.max(0, Math.min(ox + ev.clientX - sx, innerWidth  - boxEl.offsetWidth));
        var ny = Math.max(0, Math.min(oy + ev.clientY - sy, innerHeight - boxEl.offsetHeight));
        boxEl.style.left = nx + 'px'; boxEl.style.top = ny + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv, true);
        document.removeEventListener('mouseup', up, true);
      }
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    }, true);
  }

  // ---- comment --------------------------------------------------------------
  function commentSel(target) {
    var el = target || sel;
    if (!el) { flash('select an element to comment on'); return; }
    if (sel) clearSel();   // commenting resolves the deck-edit selection (no re-click needed)
    document.querySelectorAll('[data-ppt-cbox]').forEach(function (n) { n.remove(); });  // one box at a time
    var r = el.getBoundingClientRect();
    var bx = document.createElement('div');
    bx.setAttribute('data-ppt-ui', '1');
    bx.setAttribute('data-ppt-cbox', '1');
    bx.style.cssText = 'position:fixed;z-index:2147483647;left:' +
      Math.min(r.left, innerWidth - 300) + 'px;top:' + Math.min(r.bottom + 6, innerHeight - 140) +
      'px;background:#fff;color:#111;border:1px solid #ccc;border-radius:8px;padding:8px;' +
      'width:280px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:14px system-ui';
    bx.innerHTML = '<textarea style="width:100%;height:64px;box-sizing:border-box" ' +
      'placeholder="comment... (Cmd/Ctrl+Enter)"></textarea>' +
      '<div style="text-align:right;margin-top:6px">' +
      '<button data-x style="margin-right:6px">cancel</button><button data-s>save</button></div>';
    document.body.appendChild(bx);
    makeDraggable(bx);   // click-drag the box body (not the textarea/buttons) to move it
    var ta = bx.querySelector('textarea'); ta.focus();
    function close() { bx.remove(); }
    function save() {
      var txt = ta.value.trim(); if (!txt) { close(); return; }
      var a = anchorFor(el);
      fetch('/__comment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: a.page, selector: a.selector, nearest_id: a.nearest_id,
          tag: a.tag, text_excerpt: a.text_excerpt, handle: ensureHandle(el), comment: txt }) })
        .then(function (r) { return r.json(); }).then(function (d) { setCount(d.count); });
      close();
    }
    bx.querySelector('[data-x]').onclick = close;
    bx.querySelector('[data-s]').onclick = save;
    ta.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') save();
      if (ev.key === 'Escape') close();
    });
  }

  // ---- shared panel + element resolution ------------------------------------
  var panel = null, panelKind = null, panelKey = null;   // single floating panel
  var clSelId = null, clReplyId = null;                  // comments list state
  function resolveEl(a) {
    var an = a.anchor || a;
    if (a.handle) { var byH = document.querySelector('[data-ppt-h="' + a.handle + '"]'); if (byH) return byH; }
    if (an.nearest_id) { var byId = document.getElementById(an.nearest_id); if (byId) return byId; }
    if (an.selector) { try { var s = document.querySelector(an.selector); if (s) return s; } catch (e) {} }
    return null;
  }
  function highlightEl(el) {
    if (!el) { linkBox.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    linkBox.style.display = 'block';
    linkBox.style.left = r.left + 'px'; linkBox.style.top = r.top + 'px';
    linkBox.style.width = r.width + 'px'; linkBox.style.height = r.height + 'px';
  }
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    panelKind = null; linkBox.style.display = 'none';
    if (panelKey) { document.removeEventListener('keydown', panelKey, true); panelKey = null; }
  }
  // Keep side panels (edits / comments / forgotten) below the ribbon's CURRENT
  // height so the expanded ribbon never overlaps them.
  function positionPanel() {
    if (!panel) return;
    var h = (bar.getBoundingClientRect().height || 54) + 8;
    panel.style.top = h + 'px';
    panel.style.maxHeight = 'calc(100vh - ' + (h + 16) + 'px)';
  }
  function ensurePanel(title) {
    if (!panel) {
      panel = document.createElement('div');
      panel.setAttribute('data-ppt-ui', '1');
      panel.style.cssText = 'position:fixed;z-index:2147483645;right:16px;width:360px;' +
        'overflow:auto;background:#fff;color:#1b1b1b;border:1px solid #ccc;' +
        'border-radius:11px;box-shadow:0 10px 32px rgba(0,0,0,.32);font:13px system-ui;padding:10px';
      document.body.appendChild(panel);
      panelKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); } };
      document.addEventListener('keydown', panelKey, true);
    }
    positionPanel();
    return panel;
  }

  // ---- comments list (threads, reply, edit, delete, click-to-highlight) -----
  function listComments() {
    if (panel && panelKind === 'comments') { closePanel(); return; }
    if (panel) closePanel();
    panelKind = 'comments';
    renderComments();
  }
  function threadHTML(thread) {
    if (!thread || !thread.length) return '';
    var rows = thread.map(function (m) {
      var mine = m.author === 'user';
      return '<div style="margin:4px 0;padding:5px 7px;border-radius:6px;white-space:pre-wrap;' +
        (mine ? 'background:#eef4ff;border:1px solid #d6e4ff'
              : 'background:#f3f7f5;border-left:3px solid #1FA47A;margin-left:14px') + '">' +
        '<div style="font:10px system-ui;color:#888;margin-bottom:2px">' +
        (mine ? 'you' : 'Claude') + '</div>' + esc(m.text) + '</div>';
    }).join('');
    return '<div data-thread style="margin:6px 0;border-top:1px dashed #ddd;padding-top:6px">' + rows + '</div>';
  }
  function replyBoxHTML(id) {
    return '<div data-replybox style="margin:6px 0;border-top:1px dashed #ddd;padding-top:6px">' +
      '<textarea data-reply placeholder="reply… (Cmd/Ctrl+Enter to send, Esc to cancel)" ' +
      'style="width:100%;height:46px;box-sizing:border-box;font:13px system-ui"></textarea>' +
      '<div style="text-align:right;margin-top:4px">' +
      '<button data-replycancel style="margin-right:6px">cancel</button>' +
      '<button data-send="' + id + '">reply</button></div></div>';
  }
  function renderComments() {
    ensurePanel();
    fetch('/__comments').then(function (r) { return r.json(); }).then(function (d) {
      if (!panel || panelKind !== 'comments') return;
      setCount(d.filter(function (c) { return c.status !== 'done'; }).length);
      if (clSelId != null && !d.some(function (c) { return c.id === clSelId; })) { clSelId = null; highlightEl(null); }
      var head = '<div style="display:flex;justify-content:space-between;align-items:center;' +
        'border-bottom:1px solid #eee;padding-bottom:6px;margin-bottom:8px">' +
        '<b>Comments (' + d.length + ')</b>' +
        '<a href="#" data-close style="color:#888;text-decoration:none">close</a></div>';
      if (!d.length) { panel.innerHTML = head + '<div style="padding:10px;color:#666">No comments yet.</div>'; wireClose(); return; }
      var order = d.slice().sort(function (a, b) {
        var ad = a.status === 'done' ? 1 : 0, bd = b.status === 'done' ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return (b.rev || 0) - (a.rev || 0);
      });
      var html = head;
      order.forEach(function (c) {
        var anchor = c.nearest_id ? '#' + c.nearest_id : (c.selector || '');
        var done = c.status === 'done', thread = c.thread || [], open = clSelId === c.id;
        var badge = thread.length ? '<span style="color:#06c">💬 ' + thread.length + '</span>' : '';
        html += '<div data-row="' + c.id + '" style="padding:7px;border:1px solid #eee;border-radius:7px;' +
          'margin-bottom:6px;cursor:pointer;' + (done && !open ? 'opacity:.6;' : '') +
          (open ? 'box-shadow:0 0 0 2px #e8b23a inset;' : '') + '">' +
          '<div style="font:11px monospace;color:#888;display:flex;justify-content:space-between">' +
          '<span>' + esc(anchor) + ' &middot; ' + esc(c.tag || '') + '</span><span>' + (done ? 'done' : 'open') + '</span></div>' +
          '<div data-text style="margin:4px 0;white-space:pre-wrap">' + esc(c.comment) + '</div>' +
          (open ? threadHTML(thread) : '') + (clReplyId === c.id ? replyBoxHTML(c.id) : '') +
          '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">' +
          '<span>' + badge + '</span><span>' +
          '<a href="#" data-reply-open="' + c.id + '" style="color:#06c;margin-right:10px;text-decoration:none">reply</a>' +
          '<a href="#" data-edit="' + c.id + '" style="color:#06c;margin-right:10px;text-decoration:none">edit</a>' +
          '<a href="#" data-del="' + c.id + '" style="color:#c33;text-decoration:none">delete</a>' +
          '</span></div></div>';
      });
      panel.innerHTML = html;
      wireClose();
      if (clSelId != null) highlightEl(resolveEl(order.filter(function (x) { return x.id === clSelId; })[0] || {}));
      panel.querySelectorAll('[data-row]').forEach(function (row) {
        row.onclick = function (e) {
          if (e.target.closest('[data-reply-open],[data-edit],[data-del],[data-thread],[data-replybox],textarea,button')) return;
          var id = Number(row.getAttribute('data-row'));
          clReplyId = null;
          if (clSelId === id) { clSelId = null; } else { clSelId = id; }
          renderComments();
        };
      });
      panel.querySelectorAll('[data-del]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          if (!confirm('Delete this comment?')) return;
          fetch('/__delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(a.getAttribute('data-del')) }) })
            .then(function (r) { return r.json(); }).then(function () { renderComments(); });
        };
      });
      panel.querySelectorAll('[data-edit]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var id = Number(a.getAttribute('data-edit'));
          var row = panel.querySelector('[data-row="' + id + '"]');
          var cur = order.filter(function (c) { return c.id === id; })[0];
          var textDiv = row.querySelector('[data-text]');
          textDiv.innerHTML = '<textarea style="width:100%;height:60px;box-sizing:border-box;font:13px system-ui">' +
            esc(cur.comment) + '</textarea><div style="text-align:right;margin-top:4px">' +
            '<button data-cancel style="margin-right:6px">cancel</button><button data-save>save</button></div>';
          var ta = textDiv.querySelector('textarea'); ta.focus();
          textDiv.querySelector('[data-cancel]').onclick = function () { renderComments(); };
          function commit() {
            var txt = ta.value.trim(); if (!txt) { renderComments(); return; }
            fetch('/__update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: id, comment: txt }) })
              .then(function (r) { return r.json(); }).then(function () { renderComments(); });
          }
          textDiv.querySelector('[data-save]').onclick = commit;
          ta.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') { ev.stopPropagation(); renderComments(); }
            if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') commit();
          });
        };
      });
      panel.querySelectorAll('[data-reply-open]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var id = Number(a.getAttribute('data-reply-open'));
          clSelId = id; clReplyId = id; renderComments();
        };
      });
      panel.querySelectorAll('[data-send]').forEach(function (b) {
        var id = Number(b.getAttribute('data-send'));
        var row = panel.querySelector('[data-row="' + id + '"]');
        var ta = row.querySelector('[data-reply]'), cancel = row.querySelector('[data-replycancel]');
        function send() {
          var txt = ta.value.trim(); if (!txt) return;
          clReplyId = null;
          fetch('/__reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, text: txt }) })
            .then(function (r) { return r.json(); }).then(function () { renderComments(); });
        }
        b.onclick = function (e) { e.preventDefault(); send(); };
        if (cancel) cancel.onclick = function (e) { e.preventDefault(); clReplyId = null; renderComments(); };
        ta.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); clReplyId = null; renderComments(); }
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); send(); }
        });
      });
      if (clReplyId != null) {
        var rrow = panel.querySelector('[data-row="' + clReplyId + '"]');
        var rta = rrow && rrow.querySelector('[data-reply]'); if (rta) rta.focus();
      }
    });
  }
  function wireClose() {
    var c = panel.querySelector('[data-close]');
    if (c) c.onclick = function (e) { e.preventDefault(); closePanel(); };
  }

  // ---- edits list (pending blueprint moves/resizes/etc.) --------------------
  function describeEdit(ed) {
    var p = ed.props || {};
    if (ed.deleted) return 'delete';
    if (ed.kind === 'reorder') return 'reorder slides → ' + ((p.order || []).map(function (i) { return i + 1; }).join(', '));
    if (ed.kind === 'create') return 'add ' + ((ed.create && ed.create.type) || 'shape');
    var bits = [];
    if (p.pos) bits.push('move → ' + Math.round(p.pos.left) + ',' + Math.round(p.pos.top));
    if (p.size) bits.push('resize → ' + Math.round(p.size.w) + '×' + Math.round(p.size.h));
    if (p.text != null) bits.push('text');
    if (p.html != null) bits.push('html');
    if (p.style && Object.keys(p.style).length) bits.push('style: ' + Object.keys(p.style).join(', '));
    return bits.join(' · ') || 'edit';
  }
  function listEdits() {
    if (panel && panelKind === 'edits') { closePanel(); return; }
    if (panel) closePanel();
    panelKind = 'edits';
    renderEdits();
  }
  function renderEdits() {
    ensurePanel();
    fetch('/__blueprint').then(function (r) { return r.json(); }).then(function (bp) {
      if (!panel || panelKind !== 'edits') return;
      var eds = bp.edits || [];
      setEdits(eds.length);
      var head = '<div style="display:flex;justify-content:space-between;align-items:center;' +
        'border-bottom:1px solid #eee;padding-bottom:6px;margin-bottom:8px">' +
        '<b>Pending edits (' + eds.length + ')</b><span>' +
        (eds.length ? '<a href="#" data-clear style="color:#c33;text-decoration:none;margin-right:10px">clear all</a>' : '') +
        '<a href="#" data-close style="color:#888;text-decoration:none">close</a></span></div>';
      if (!eds.length) { panel.innerHTML = head + '<div style="padding:10px;color:#666">No pending edits. ' +
        'Drag, resize, format or add shapes and they show up here.</div>'; wireClose(); wireClear(); return; }
      var html = head;
      eds.forEach(function (ed) {
        var an = ed.anchor || {};
        var anchor = an.nearest_id ? '#' + an.nearest_id : (an.selector || '');
        var excerpt = (an.text_excerpt || '').slice(0, 60);
        html += '<div data-erow="' + ed.handle + '" style="padding:7px;border:1px solid #eee;border-radius:7px;' +
          'margin-bottom:6px;cursor:pointer">' +
          '<div style="font:11px monospace;color:#888;display:flex;justify-content:space-between">' +
          '<span>' + esc(an.tag || '') + ' ' + esc(anchor) + '</span><span>' + esc(ed.handle || '') + '</span></div>' +
          '<div style="margin:4px 0;font-weight:600;color:#1b1b1b">' + esc(describeEdit(ed)) + '</div>' +
          (excerpt ? '<div style="color:#888;white-space:pre-wrap">"' + esc(excerpt) + '"</div>' : '') +
          '</div>';
      });
      panel.innerHTML = html;
      wireClose(); wireClear();
      panel.querySelectorAll('[data-erow]').forEach(function (row) {
        var ed = eds.filter(function (x) { return x.handle === row.getAttribute('data-erow'); })[0];
        row.onmouseenter = function () { highlightEl(resolveEl(ed)); };
        row.onmouseleave = function () { highlightEl(null); };
      });
    });
  }
  function wireClear() {
    var c = panel.querySelector('[data-clear]');
    if (c) c.onclick = function (e) {
      e.preventDefault();
      if (!confirm('Clear ALL pending edits? (comments are untouched)')) return;
      while (undoStack.length) { var tx = undoStack.pop(); try { tx.revert(); } catch (e2) {} }
      if (sel && !document.contains(sel)) clearSel();
      positionChrome();
      fetch('/__bp_clear', { method: 'POST' }).then(function (r) { return r.json(); })
        .then(function () { undoStack = []; refreshUndo(); renderEdits(); });
    };
  }

  // ---- forget: temporarily drop objects from the edit surface ----------------
  function setForgotten(n) { var e = bar.querySelector('[data-fgt]'); if (e) e.textContent = n; }
  function countForgotten() { return document.querySelectorAll('[data-ppt-forget]').length; }
  function setForget(el, on) {
    if (!el) return;
    if (on) { el.setAttribute('data-ppt-forget', '1'); if (sel === el || multi.indexOf(el) >= 0) clearSel(); }
    else el.removeAttribute('data-ppt-forget');
    setForgotten(countForgotten());
  }
  function toggleForgetSel() {
    var list = multi.length ? multi.slice() : (sel ? [sel] : []);
    if (!list.length) { flash('select an object, then Ctrl/Cmd+Shift+F to forget it'); return; }
    list.forEach(function (el) { setForget(el, !el.hasAttribute('data-ppt-forget')); });
    clearSel();
    flash('Forgotten ' + list.length + ' object' + (list.length > 1 ? 's' : '') +
      ' — ignored by select/move (still commentable). Toggle in forgotten()');
  }
  function activeSlide() {
    var slides = getSlides();
    return slides.filter(function (s) { return s.offsetParent !== null; })[0] || slides[0] || null;
  }
  function slideObjects() {
    var s = activeSlide(); if (!s) return [];
    var out = [];
    Array.prototype.forEach.call(s.children, function (c) { if (c.nodeType === 1 && !isUI(c)) out.push(c); });
    s.querySelectorAll('[data-ppt-forget]').forEach(function (f) { if (out.indexOf(f) < 0) out.push(f); });
    return out;
  }
  function listForgotten() {
    if (panel && panelKind === 'forgotten') { closePanel(); return; }
    if (panel) closePanel();
    panelKind = 'forgotten';
    renderForgotten();
  }
  function renderForgotten() {
    ensurePanel();
    var objs = slideObjects();
    setForgotten(countForgotten());
    var head = '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'border-bottom:1px solid #eee;padding-bottom:6px;margin-bottom:8px">' +
      '<b>Objects on this slide</b><a href="#" data-close style="color:#888;text-decoration:none">close</a></div>' +
      '<div style="color:#888;font-size:12px;margin-bottom:8px">Checked = forgotten: ignored by select &amp; move, ' +
      'still commentable. Nail down clutter here, then move the rest freely.</div>';
    var html = head;
    if (!objs.length) html += '<div style="padding:10px;color:#666">No objects detected on the active slide.</div>';
    objs.forEach(function (o, i) {
      var fg = o.hasAttribute('data-ppt-forget');
      var label = (o.tagName ? o.tagName.toLowerCase() : '?') + (o.id ? '#' + o.id : '');
      var ex = (o.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46);
      html += '<label data-orow="' + i + '" style="display:flex;gap:8px;align-items:flex-start;padding:6px 7px;' +
        'border:1px solid #eee;border-radius:7px;margin-bottom:5px;cursor:pointer">' +
        '<input type="checkbox" data-fchk="' + i + '"' + (fg ? ' checked' : '') + ' style="margin-top:2px">' +
        '<span style="flex:1"><span style="font:11px monospace;color:#888">' + esc(label) + '</span>' +
        (ex ? '<br><span style="color:#333">' + esc(ex) + '</span>' : '') + '</span></label>';
    });
    panel.innerHTML = html;
    wireClose();
    panel.querySelectorAll('[data-fchk]').forEach(function (chk) {
      var o = objs[Number(chk.getAttribute('data-fchk'))];
      chk.onchange = function () { setForget(o, chk.checked); };
    });
    panel.querySelectorAll('[data-orow]').forEach(function (row) {
      var o = objs[Number(row.getAttribute('data-orow'))];
      row.onmouseenter = function () { highlightEl(o); };
      row.onmouseleave = function () { highlightEl(null); };
    });
  }

  // ---- snapshot: the literal "what I saw" record ----------------------------
  function snapshot() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-ppt-ui]').forEach(function (n) { n.remove(); });
    Array.from(clone.querySelectorAll('script')).forEach(function (s) {
      if ((s.textContent || '').indexOf('PPT-ED-OVERLAY') >= 0) s.remove();
    });
    Array.from(clone.querySelectorAll('[contenteditable]')).forEach(function (n) {
      n.removeAttribute('contenteditable');
    });
    var html = '<!doctype html>\n<html>' + clone.innerHTML + '</html>';
    fetch('/__snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: html, label: location.pathname.replace(/\W+/g, '_') }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { flash('snapshot saved: ' + d.file); })
      .catch(function () {});
  }
  function flash(msg) {
    var f = document.createElement('div');
    f.setAttribute('data-ppt-ui', '1');
    f.textContent = msg;
    f.style.cssText = 'position:fixed;z-index:2147483647;top:54px;left:16px;background:#111;' +
      'color:#fff;padding:8px 12px;border-radius:8px;font:13px system-ui';
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 1800);
  }

  // ---- slide sorter view ----------------------------------------------------
  // The real slides are .slide elements (html-slide-deck convention); exclude any
  // clones living inside our own UI (the sorter thumbnails).
  function getSlides() {
    return Array.from(document.querySelectorAll('.slide')).filter(function (s) {
      return !(s.closest && s.closest('[data-ppt-ui]'));
    });
  }
  function slideExcerpt(s) { return (s.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60); }

  function toggleSorter() { if (sorterOpen) closeSorter(); else openSorter(); }
  function openSorter() {
    var slides = getSlides();
    if (slides.length < 2) { flash('Slide sorter needs a deck with .slide sections'); return; }
    sorterOpen = true;
    clearSel(); disarm(); if (commentMode) setCommentMode(false);
    // hide the deck's advancement nav (scenery) while sorting
    navEls = Array.from(document.querySelectorAll('[data-ppt-scenery], .nav'));
    navEls.forEach(function (n) { n.setAttribute('data-ppt-navhidden', n.style.display || ''); n.style.display = 'none'; });
    buildSorter(slides);
  }
  function closeSorter() {
    sorterOpen = false;
    if (sorterEl) { sorterEl.remove(); sorterEl = null; }
    navEls.forEach(function (n) { n.style.display = n.getAttribute('data-ppt-navhidden') || ''; n.removeAttribute('data-ppt-navhidden'); });
    navEls = [];   // keep sorterOrder so the recorded order persists across opens
  }
  function buildSorter(slides) {
    if (sorterEl) sorterEl.remove();
    sorterEl = document.createElement('div');
    sorterEl.setAttribute('data-ppt-ui', '1');
    sorterEl.style.cssText = 'position:fixed;inset:0;z-index:2147483644;background:#1f2330;color:#fff;overflow:auto;font:14px system-ui';
    sorterEl.innerHTML =
      '<div style="position:sticky;top:0;background:#1f2330;display:flex;align-items:center;gap:12px;' +
        'padding:12px 18px;border-bottom:1px solid #333;z-index:2">' +
        '<b style="font-size:16px">Slide Sorter</b>' +
        '<span style="color:#9ab">' + slides.length + ' slides · drag to reorder</span>' +
        '<span style="flex:1"></span>' +
        '<button data-zoomout title="Smaller thumbnails" style="' + BTN + '">– zoom</button>' +
        '<button data-zoomin title="Larger thumbnails" style="' + BTN + '">+ zoom</button>' +
        '<button data-done style="' + BTN + ';background:#2d6cdf;border-color:#2d6cdf">Done (Esc)</button>' +
      '</div>' +
      '<div data-grid style="display:grid;gap:18px;padding:20px"></div>';
    document.body.appendChild(sorterEl);
    sorterEl.querySelector('[data-done]').onclick = function () { closeSorter(); };
    sorterEl.querySelector('[data-zoomin]').onclick = function () { sorterCols = Math.max(1, sorterCols - 1); renderSorterGrid(slides); };
    sorterEl.querySelector('[data-zoomout]').onclick = function () { sorterCols = Math.min(6, sorterCols + 1); renderSorterGrid(slides); };
    renderSorterGrid(slides);
  }
  function gotoSlide(slide) {
    var all = getSlides(), idx = all.indexOf(slide);
    closeSorter();
    // DOM is never reordered, so idx matches the deck's own slide list -> show() is correct.
    if (typeof window.show === 'function' && idx >= 0) { try { window.show(idx); return; } catch (e) {} }
    all.forEach(function (s) { s.classList.remove('active'); });
    if (slide) slide.classList.add('active');
    try { location.hash = '#' + (idx + 1); } catch (e) {}
  }
  // Rename every id inside a cloned subtree and rewrite the references that point at them
  // (url(#…) in fill/stroke/clip-path/mask/filter/style, and href/xlink:href="#…"), so SVG
  // gradients / clipPaths / masks / <use> keep working in a thumbnail clone. Stripping ids
  // (the old behaviour) broke those refs -> shapes rendered unclipped/unmasked (the
  // "slide looks distorted in the sorter" bug). Hex colours (#702082) start with a digit,
  // so the [A-Za-z] anchor leaves them untouched.
  function rescopeIds(root, suffix) {
    var idEls = root.querySelectorAll('[id]'); if (!idEls.length) return;
    var map = {};
    idEls.forEach(function (el) { var o = el.id; if (o) { el.id = o + suffix; map[o] = el.id; } });
    var ATTRS = ['href', 'xlink:href', 'fill', 'stroke', 'clip-path', 'mask', 'filter',
      'marker-start', 'marker-mid', 'marker-end', 'style'];
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
      ATTRS.forEach(function (a) {
        var v = el.getAttribute && el.getAttribute(a); if (!v || v.indexOf('#') < 0) return;
        var nv = v.replace(/#([A-Za-z][\w:.-]*)/g, function (m, id) { return map[id] ? '#' + map[id] : m; });
        if (nv !== v) el.setAttribute(a, nv);
      });
    });
  }
  function renderSorterGrid() {
    if (!sorterEl) return;
    var slides = getSlides();   // live DOM order is the source of truth
    var grid = sorterEl.querySelector('[data-grid]');
    grid.style.gridTemplateColumns = 'repeat(' + sorterCols + ',1fr)';
    grid.style.position = 'relative';
    var first = slides[0];
    var sw = parseFloat(getComputedStyle(first).width) || 1280;
    var sh = parseFloat(getComputedStyle(first).height); if (!sh || sh < 10) sh = sw * 9 / 16;
    grid.innerHTML = '';
    var dragFrom = -1, insertAt = -1, dragged = false;
    var ind = document.createElement('div');   // insertion indicator bar
    ind.style.cssText = 'position:absolute;width:4px;background:#2d6cdf;border-radius:2px;display:none;' +
      'pointer-events:none;z-index:5;box-shadow:0 0 8px #2d6cdf';
    grid.appendChild(ind);
    slides.forEach(function (slide, pos) {
      var card = document.createElement('div');
      card.setAttribute('data-card', pos);
      card.draggable = true;
      card.style.cssText = 'background:#2a2f3e;border:1px solid #3a4152;border-radius:8px;overflow:hidden;' +
        'cursor:grab;position:relative';
      var thumb = document.createElement('div');
      thumb.style.cssText = 'position:relative;width:100%;aspect-ratio:' + sw + '/' + sh + ';overflow:hidden;background:#fff';
      var clone = slide.cloneNode(true);
      clone.classList.add('active');
      clone.removeAttribute('id');
      rescopeIds(clone, '_st' + (++handleSeq));   // rename inner ids + rewrite url(#…)/href refs so SVG gradients/clipPaths/masks still render
      clone.querySelectorAll('[data-ppt-ui]').forEach(function (n) { n.remove(); });
      clone.style.cssText += ';display:block;position:absolute;left:0;top:0;margin:0;width:' + sw + 'px;height:' + sh + 'px;overflow:hidden;transform:none;transform-origin:top left;pointer-events:none';
      thumb.appendChild(clone);
      var num = document.createElement('div');
      num.textContent = (pos + 1);
      num.style.cssText = 'position:absolute;top:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font:12px system-ui;padding:2px 7px;border-radius:10px;z-index:2';
      var hint = document.createElement('div');
      hint.textContent = 'double-click ↗';
      hint.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(45,108,223,.92);color:#fff;font:11px system-ui;padding:2px 7px;border-radius:10px;z-index:2;opacity:0;transition:opacity .12s';
      card.appendChild(thumb); card.appendChild(num); card.appendChild(hint);
      card.onmouseenter = function () { hint.style.opacity = '1'; };
      card.onmouseleave = function () { hint.style.opacity = '0'; };
      grid.appendChild(card);
      requestAnimationFrame(function () { var tw = thumb.clientWidth; if (tw) clone.style.transform = 'scale(' + (tw / sw) + ')'; });
      // double-click opens that slide (single click is reserved for drag start)
      card.addEventListener('dblclick', function () { gotoSlide(slide); });
      card.addEventListener('dragstart', function (e) {
        dragFrom = pos; dragged = true; e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(pos));
        setTimeout(function () { card.style.opacity = '.35'; }, 0);
      });
      card.addEventListener('dragend', function () {
        card.style.opacity = ''; ind.style.display = 'none';
        setTimeout(function () { dragged = false; }, 0);   // let the suppressed click pass
      });
      card.addEventListener('dragover', function (e) {
        e.preventDefault();
        var r = card.getBoundingClientRect(), after = (e.clientX - r.left) > r.width / 2;
        insertAt = pos + (after ? 1 : 0);
        ind.style.display = 'block';
        ind.style.left = (card.offsetLeft + (after ? card.offsetWidth + 6 : -10)) + 'px';
        ind.style.top = card.offsetTop + 'px';
        ind.style.height = card.offsetHeight + 'px';
      });
    });
    grid.ondragover = function (e) { e.preventDefault(); };
    grid.ondrop = function (e) {
      e.preventDefault();
      if (dragFrom < 0 || insertAt < 0) return;
      var cur = getSlides();                          // current live DOM order
      var moved = cur[dragFrom]; if (!moved) return;
      var to = insertAt; if (to > dragFrom) to--;
      var newNodes = cur.slice(); newNodes.splice(dragFrom, 1); newNodes.splice(to, 0, moved);
      reorderSlides(newNodes, cur);
      renderSorterGrid();
    };
  }
  // ---- slide management: LIVE DOM reorder + new / duplicate -------------------
  // The reorder is applied to the real DOM (this deck re-queries `.slide` on every
  // nav, so prev/next/dots follow), and an op is recorded so Claude reconciles the
  // source order on "start actioning".
  function slideKey(s) { return s.id ? ('#' + s.id) : ('@' + slideExcerpt(s)); }
  function arrangeSlides(seq) { for (var i = 1; i < seq.length; i++) if (seq[i - 1] && seq[i]) seq[i - 1].after(seq[i]); }
  function applySlideSequence(keys) {
    var cur = getSlides(), byKey = {};
    cur.forEach(function (s) { byKey[slideKey(s)] = s; });
    var seq = keys.map(function (k) { return byKey[k]; }).filter(Boolean);
    if (seq.length >= 2) arrangeSlides(seq);
  }
  // Re-sync the deck's own nav (dots / label / active) to the active slide's new index.
  function resyncNav() {
    try {
      var nonAux = Array.prototype.slice.call(document.querySelectorAll('.slide:not(.aux)'));
      var ai = nonAux.findIndex(function (s) { return s.classList.contains('active'); });
      if (typeof window.show === 'function' && ai >= 0) window.show(ai);
    } catch (e) {}
  }
  function reorderSlides(newNodes, oldNodes) {
    if (newNodes.length < 2) return;
    arrangeSlides(newNodes);
    txStart('reorder slides', function () { arrangeSlides(oldNodes); resyncNav(); if (sorterOpen && sorterEl) renderSorterGrid(); });
    // new order expressed as a permutation of old (= source) slide indices, so the
    // server can move the spans by ordinal without any brittle index-path guessing.
    var order = newNodes.map(function (n) { return oldNodes.indexOf(n); });
    sendOp(newNodes[0].parentNode, 'reorder', { ids: newNodes.map(slideKey), order: order });
    txCommit();
    resyncNav();
  }
  function activeSlideNode() {
    var sl = getSlides();
    return sl.filter(function (s) { return s.classList.contains('active'); })[0] ||
           sl.filter(function (s) { return s.offsetParent !== null; })[0] || sl[0] || null;
  }
  function duplicateActiveSlide() {
    var active = activeSlideNode(); if (!active) { flash('no slide to duplicate'); return; }
    var clone = active.cloneNode(true);
    clone.classList.remove('active');
    if (clone.id) clone.id = clone.id + '-copy' + (++handleSeq);
    clone.querySelectorAll('[id]').forEach(function (n) { n.id = n.id + '-c' + (++handleSeq); });
    clone.removeAttribute('data-ppt-h');
    clone.querySelectorAll('[data-ppt-h]').forEach(function (n) { n.removeAttribute('data-ppt-h'); });
    active.after(clone);
    txStart('duplicate slide', function () { clone.remove(); resyncNav(); if (sorterOpen && sorterEl) renderSorterGrid(); });
    srcSlideCreate(clone, getSlides().indexOf(active));   // write the new slide into source after the original
    sendOp(clone.parentNode, 'create', { kind: 'slide', mode: 'duplicate', source: slideKey(active), after: slideKey(active) });
    txCommit();
    if (sorterOpen && sorterEl) renderSorterGrid(); else gotoSlide(clone);
    flash('Duplicated slide');
  }
  function newSlideAfterActive() {
    var sl = getSlides(); if (!sl.length) { flash('no .slide to add after'); return; }
    var active = activeSlideNode() || sl[0];
    var blank = document.createElement(active.tagName);
    blank.className = (active.className || 'slide').replace(/\bactive\b/g, ' ').replace(/\s+/g, ' ').trim() || 'slide';
    blank.id = 'slide-new-' + (++handleSeq);
    blank.innerHTML = '<h1 class="title">New slide</h1>';
    active.after(blank);
    txStart('new slide', function () { blank.remove(); resyncNav(); if (sorterOpen && sorterEl) renderSorterGrid(); });
    srcSlideCreate(blank, getSlides().indexOf(active));   // write the new blank slide into source after the active one
    sendOp(blank.parentNode, 'create', { kind: 'slide', mode: 'blank', after: slideKey(active) });
    txCommit();
    if (sorterOpen && sorterEl) renderSorterGrid(); else gotoSlide(blank);
    flash('New slide added');
  }

  // ---- keyboard shortcuts pane (rendered help, Mac/Windows switchable) -------
  function shortcutsHTML(M) {
    var mod = M ? 'Cmd' : 'Ctrl', opt = M ? 'Opt' : 'Alt';
    function row(a, k) {
      return '<tr><td style="padding:5px 16px 5px 0;color:#cdd6e2;vertical-align:top">' + a + '</td>' +
        '<td style="padding:5px 0"><kbd style="background:#2a2f3e;border:1px solid #3a4152;border-radius:5px;' +
        'padding:2px 7px;font:12px ui-monospace,Menlo,monospace;color:#fff;white-space:nowrap">' + k + '</kbd></td></tr>';
    }
    function sect(t, rows) {
      return '<div style="margin:16px 0 4px;font:11px system-ui;letter-spacing:1px;text-transform:uppercase;color:#7f93a6">' +
        t + '</div><table style="border-collapse:collapse;width:100%">' + rows + '</table>';
    }
    return sect('General',
        row('Toggle edit mode', 'click “off / ON”') +
        row('Undo', mod + '+Z') +
        row('Undo all', '↶↶ All button') +
        row('Delete selection', 'Del · Backspace') +
        row('Edit text', 'Enter · double-click') +
        row('Deselect / exit mode', 'Esc')) +
      sect('Slides',
        row('Slide sorter (toggle)', 'Ctrl+4 · Cmd+4') +
        row('New slide · Duplicate', mod + '+M · ' + mod + '+D') +
        row('Open a slide (in sorter)', 'double-click thumbnail') +
        row('Reorder slides (live, in sorter)', 'drag thumbnail')) +
      sect('Text format',
        row('Bold · Italic · Underline', mod + '+B · ' + mod + '+I · ' + mod + '+U') +
        row('Font bigger · smaller', mod + '+] · ' + mod + '+[')) +
      sect('Arrange',
        row('Bring to front · send to back', mod + '+Shift+] · ' + mod + '+Shift+[') +
        row('Align left/right/top/bottom', (M ? 'Ctrl+Cmd' : 'Ctrl+Alt') + '+ ← → ↑ ↓') +
        row('Distribute horizontal · vertical', (M ? 'Cmd' : 'Alt') + '+Shift+H · ' + (M ? 'Cmd' : 'Alt') + '+Shift+V') +
        row('Group · Ungroup', 'Ctrl+G · Ctrl+Shift+G') +
        row('Forget / restore object', mod + '+Shift+F')) +
      sect('Insert shapes',
        row('Text box · Rect · Oval · Line', opt + '+Shift+X · R · O · L')) +
      sect('Clipboard',
        row('Copy · Paste objects', mod + '+C · ' + mod + '+V') +
        row('Copy · Paste format', mod + '+Shift+C · ' + mod + '+Shift+V') +
        row('Duplicate by dragging', mod + '+Shift+drag (Shift locks axis)')) +
      sect('Move & size',
        row('Nudge selection', 'Arrows (1px)') +
        row('Resize, keeping centered', 'Shift+→ ← wider/narrower · Shift+↑ ↓ taller/shorter') +
        row('Move several at once', 'Shift-click to select, then drag any one'));
  }
  function openShortcuts() {
    var ov = document.createElement('div');
    ov.setAttribute('data-ppt-ui', '1');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(10,15,30,.55);display:flex;align-items:center;justify-content:center';
    var pane = document.createElement('div');
    pane.style.cssText = 'background:#1f2330;color:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);' +
      'max-height:84vh;overflow:auto;width:540px;max-width:92vw;padding:18px 22px;font:13px system-ui';
    ov.appendChild(pane); document.body.appendChild(ov);
    function tabStyle(on) {
      return 'padding:5px 14px;border:1px solid #3a4152;cursor:pointer;font:13px system-ui;' +
        (on ? 'background:#2d6cdf;border-color:#2d6cdf;color:#fff' : 'background:#2a2f3e;color:#cdd6e2');
    }
    function render(M) {
      pane.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<b style="font-size:16px">Keyboard shortcuts</b>' +
        '<a href="#" data-close style="color:#9ab;text-decoration:none">close (Esc)</a></div>' +
        '<div style="display:inline-flex;margin:10px 0 2px;border-radius:7px;overflow:hidden">' +
        '<button data-plat="mac" style="' + tabStyle(M) + ';border-radius:7px 0 0 7px">Mac</button>' +
        '<button data-plat="win" style="' + tabStyle(!M) + ';border-radius:0 7px 7px 0;border-left:none">Windows / Linux</button>' +
        '</div>' + shortcutsHTML(M);
      pane.querySelector('[data-close]').onclick = function (e) { e.preventDefault(); close(); };
      pane.querySelector('[data-plat="mac"]').onclick = function () { render(true); };
      pane.querySelector('[data-plat="win"]').onclick = function () { render(false); };
    }
    function close() { ov.remove(); document.removeEventListener('keydown', onK, true); }
    function onK(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onK, true);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    render(mac());   // default to the detected platform
  }

  // ---- options popover ------------------------------------------------------
  function openOptions(anchor) {
    document.querySelectorAll('[data-ppt-opts]').forEach(function (n) { n.remove(); });
    var r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: 120, bottom: 50 };
    var p = document.createElement('div');
    p.setAttribute('data-ppt-ui', '1'); p.setAttribute('data-ppt-opts', '1');
    p.style.cssText = 'position:fixed;z-index:2147483647;top:' + ((r.bottom || 50) + 6) + 'px;left:' +
      Math.max(6, Math.min(r.left, innerWidth - 250)) + 'px;background:#fff;color:#111;border:1px solid #ccc;' +
      'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.3);padding:12px;font:13px system-ui;width:240px';
    p.innerHTML = '<div style="font-weight:600;margin-bottom:8px">Options</div>' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" data-opt-tb ' + (showMiniToolbar ? 'checked' : '') + '> ' +
      'Floating toolbar on selection</label>';
    document.body.appendChild(p);
    function close() { p.remove(); document.removeEventListener('mousedown', onOut, true); document.removeEventListener('keydown', onK, true); }
    function onOut(ev) { if (!p.contains(ev.target) && ev.target !== anchor) close(); }
    function onK(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } }
    setTimeout(function () { document.addEventListener('mousedown', onOut, true); }, 0);
    document.addEventListener('keydown', onK, true);
    p.querySelector('[data-opt-tb]').onchange = function (ev) {
      showMiniToolbar = ev.target.checked;
      try { localStorage.setItem('pptEdMiniTb', showMiniToolbar ? '1' : '0'); } catch (e) {}
      if (!showMiniToolbar) tb.style.display = 'none'; else positionChrome();
    };
  }

  // ---- keyboard shortcuts ---------------------------------------------------
  // PowerPoint / PPT-Productivity-flavoured map (Cmd<->Ctrl normalized via combo()).
  // Combo string format: "mod+key" / "mod+shift+key" / "mod+alt+shift+key" / "key".
  // Layout/Option-independent key token: Mac's Option rewrites e.key (Alt+X -> ≈),
  // so use e.code for letters/digits and fall back to e.key for punctuation/arrows.
  function keyToken(e) {
    var c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    return (e.key || '').toLowerCase();
  }
  function combo(e) {
    var parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('mod');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(keyToken(e));
    return parts.join('+');
  }
  var KEYMAP = {
    // text formatting
    'mod+b': function () { fmt('bold'); },
    'mod+i': function () { fmt('italic'); },
    'mod+u': function () { fmt('underline'); },
    // font size: PowerPoint Ctrl+] / Ctrl+[ ("the bracket"), plus Ctrl+Shift+> / <
    'mod+]': function () { fmt('bigger'); },
    'mod+[': function () { fmt('smaller'); },
    'mod+shift+.': function () { fmt('bigger'); },
    'mod+shift+,': function () { fmt('smaller'); },
    // z-order (brackets now belong to font, so front/back move to shift+bracket)
    'mod+shift+]': function () { zorder('front'); },
    'mod+shift+[': function () { zorder('back'); },
    // align selected objects: PPT-Productivity Ctrl+Alt+Shift + L/E/R/T/M/B
    'mod+alt+shift+l': function () { alignSel('left'); },
    'mod+alt+shift+e': function () { alignSel('center'); },
    'mod+alt+shift+r': function () { alignSel('right'); },
    'mod+alt+shift+t': function () { alignSel('top'); },
    'mod+alt+shift+m': function () { alignSel('middle'); },
    'mod+alt+shift+b': function () { alignSel('bottom'); },
    // undo (the must-have): visual revert + server pop
    'mod+z': function () { doUndo(); },
    // slide sorter view (PPT-Productivity Ctrl+4)
    'mod+4': function () { toggleSorter(); },
    // insert shapes
    'alt+shift+x': function () { arm('textbox'); },
    'alt+shift+r': function () { arm('rect'); },
    'alt+shift+o': function () { arm('oval'); },
    'alt+shift+l': function () { arm('line'); },
    // nudge (move shapes around)
    'arrowleft': function () { nudge(-1, 0); },
    'arrowright': function () { nudge(1, 0); },
    'arrowup': function () { nudge(0, -1); },
    'arrowdown': function () { nudge(0, 1); },
    'shift+arrowright': function () { sizeStep(10, 0); },    // wider (centered)
    'shift+arrowleft': function () { sizeStep(-10, 0); },    // narrower (centered)
    'shift+arrowup': function () { sizeStep(0, 10); },       // taller (centered)
    'shift+arrowdown': function () { sizeStep(0, -10); },    // shorter (centered)
    // delete selected shape / text box / element
    'delete': function () { delSel(); },
    'backspace': function () { delSel(); },
    'enter': function () { if (sel) editText(sel); },
    'escape': function () { if (commentMode) setCommentMode(false); else if (placing) disarm(); else clearSel(); }
  };
  // Browser-reserved combos we cannot capture: Cmd/Ctrl+N, +T, +W. Don't bind.

  function editorFieldFocused() {
    var a = document.activeElement;
    return a && a.closest && a.closest('[data-ppt-ui]') &&
      (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
  }
  document.addEventListener('keydown', function (e) {
    // Esc exits comment mode whether deckhand is on or off (not while typing a comment).
    if (e.key === 'Escape' && commentMode && !editorFieldFocused()) { e.preventDefault(); e.stopPropagation(); setCommentMode(false); return; }
    if (!ON) return;
    if (sorterOpen) {                          // in the sorter: toggle / exit / add slides
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSorter(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); e.stopPropagation(); toggleSorter(); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); e.stopPropagation(); newSlideAfterActive(); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); e.stopPropagation(); duplicateActiveSlide(); }
      return;
    }
    if (editorFieldFocused()) return;          // typing a comment: leave alone
    if (document.activeElement && document.activeElement.isContentEditable) {
      var ce = document.activeElement;
      if (e.key === 'Escape') { ce.blur(); return; }
      // Backspace at the very start of a bulleted text box removes the bullet
      // instead of deleting backward into nothing.
      if (e.key === 'Backspace' && getComputedStyle(ce).display === 'list-item' && caretAtStart(ce)) {
        e.preventDefault(); e.stopPropagation();
        applyStyle(ce, { 'display': 'block', 'list-style': 'none', 'margin-left': '0' });
        return;
      }
      // Block the page/deck's own key handlers (e.g. arrow keys advancing slides)
      // while typing, but DON'T preventDefault — so the caret moves/types natively.
      e.stopPropagation();
      return;
    }
    // Align via arrows: Mac = Ctrl+Cmd+Arrow, Windows/Linux = Ctrl+Alt+Arrow.
    // Matched directly because combo() collapses Ctrl/Cmd to one 'mod', and Mac's
    // Option rewrites e.key so the Alt-letter align combos can't match there.
    var amap = { ArrowDown: 'bottom', ArrowUp: 'top', ArrowLeft: 'left', ArrowRight: 'right' };
    var alignChord = mac() ? (e.metaKey && e.ctrlKey) : (e.ctrlKey && e.altKey);
    if (alignChord && amap[e.key]) {
      e.preventDefault(); e.stopPropagation(); alignSel(amap[e.key]); return;
    }
    // Group / ungroup: Ctrl+G and Ctrl+Shift+G (Ctrl on both Mac and Windows).
    if (e.ctrlKey && !e.metaKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) ungroupSel(); else groupSel();
      return;
    }
    // Forget / unforget the selection: Ctrl+Shift+F (Cmd+Shift+F on Mac).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); e.stopPropagation(); toggleForgetSel(); return;
    }
    // New slide (Ctrl/Cmd+M) and duplicate current slide (Ctrl/Cmd+D).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault(); e.stopPropagation(); newSlideAfterActive(); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault(); e.stopPropagation(); duplicateActiveSlide(); return;
    }
    // Copy / paste OBJECTS (Ctrl/Cmd+C / +V); add Shift for FORMAT copy/paste.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); copyFormat(); return; }
      if (selList().length) { e.preventDefault(); e.stopPropagation(); copyObjects(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); pasteFormat(); return; }
      if (objClip.length) { e.preventDefault(); e.stopPropagation(); pasteObjects(); return; }
    }
    // Distribute: Mac Cmd+Shift+H/V, Windows/Linux Alt+Shift+H/V.
    var distMod = mac() ? e.metaKey : e.altKey;
    if (distMod && e.shiftKey) {
      var dk = (e.key || '').toLowerCase();
      if (dk === 'h') { e.preventDefault(); e.stopPropagation(); distributeSel('h'); return; }
      if (dk === 'v') { e.preventDefault(); e.stopPropagation(); distributeSel('v'); return; }
    }
    // Match size (first selected governs): width = Mac Ctrl+Cmd+E / Win Ctrl+Alt+E,
    // add Shift for both dimensions; height = Ctrl+Shift+E (both platforms).
    var sizeMod = mac() ? (e.metaKey && e.ctrlKey) : (e.ctrlKey && e.altKey);
    if (sizeMod && keyToken(e) === 'e') {
      e.preventDefault(); e.stopPropagation(); matchSize(e.shiftKey ? 'both' : 'w'); return;
    }
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && keyToken(e) === 'e') {
      e.preventDefault(); e.stopPropagation(); matchSize('h'); return;
    }
    // Center on first selected: Mac Ctrl+Cmd / Win Ctrl+Alt, +C horizontal, +M vertical.
    var centerMod = mac() ? (e.metaKey && e.ctrlKey) : (e.ctrlKey && e.altKey);
    if (centerMod && keyToken(e) === 'c') {
      e.preventDefault(); e.stopPropagation(); centerSel('x'); return;
    }
    if (centerMod && keyToken(e) === 'm') {
      e.preventDefault(); e.stopPropagation(); centerSel('y'); return;
    }
    var fn = KEYMAP[combo(e)];
    if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
  }, true);

  function shieldKey(e) {
    if (!editorFieldFocused()) return;
    if (e.key === 'Escape') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return;
    e.stopPropagation();
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, shieldKey, true);
  });

  // ---- wire controls --------------------------------------------------------
  // The same control set lives in both the top ribbon and the floating
  // mini-toolbar; wire any root that contains them.
  function wireControls(root) {
    root.querySelectorAll('[data-add]').forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); arm(a.getAttribute('data-add')); };
    });
    root.querySelectorAll('[data-f]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); fmt(b.getAttribute('data-f'), b); };
    });
    root.querySelectorAll('[data-a]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); alignSel(b.getAttribute('data-a')); };
    });
    root.querySelectorAll('[data-ta]').forEach(function (b) {   // text-align (whole selection, one undo)
      b.onclick = function (e) { e.preventDefault(); var v = b.getAttribute('data-ta'); styleMany(selList(), function () { return { 'text-align': v }; }); };
    });
    root.querySelectorAll('[data-tv]').forEach(function (b) {   // vertical text placement (whole selection, one undo)
      b.onclick = function (e) { e.preventDefault(); var v = b.getAttribute('data-tv'); styleMany(selList(), function () { return vAlignStyle(v); }); };
    });
    root.querySelectorAll('[data-z]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); zorder(b.getAttribute('data-z')); };
    });
    root.querySelectorAll('[data-dist]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); distributeSel(b.getAttribute('data-dist')); };
    });
    var gb = root.querySelector('[data-group]'); if (gb) gb.onclick = function (e) { e.preventDefault(); groupSel(); };
    var ub = root.querySelector('[data-ungroup]'); if (ub) ub.onclick = function (e) { e.preventDefault(); ungroupSel(); };
    var et = root.querySelector('[data-edit-text]');
    if (et) et.onclick = function (e) { e.preventDefault(); if (sel) editText(sel); };
    var cm = root.querySelector('[data-cmt]');
    if (cm) cm.onclick = function (e) { e.preventDefault(); commentSel(); };
    var dl = root.querySelector('[data-del]');
    if (dl) dl.onclick = function (e) { e.preventDefault(); delSel(); };
  }
  wireControls(bar);
  wireControls(tb);

  // global ribbon buttons
  bar.querySelector('[data-tog]').onclick = function (e) { e.preventDefault(); setOn(!ON); };
  bar.querySelector('[data-undo]').onclick = function (e) { e.preventDefault(); doUndo(); };
  bar.querySelector('[data-undoall]').onclick = function (e) { e.preventDefault(); doUndoAll(); };
  bar.querySelector('[data-snap]').onclick = function (e) { e.preventDefault(); snapshot(); };
  bar.querySelector('[data-sorter]').onclick = function (e) { e.preventDefault(); toggleSorter(); };
  bar.querySelector('[data-shortcuts]').onclick = function (e) { e.preventDefault(); openShortcuts(); };
  bar.querySelector('[data-options]').onclick = function (e) { e.preventDefault(); openOptions(bar.querySelector('[data-options]')); };
  bar.querySelector('[data-dzout]').onclick = function (e) { e.preventDefault(); zoomOut(); };
  bar.querySelector('[data-dzin]').onclick = function (e) { e.preventDefault(); zoomIn(); };
  bar.querySelector('[data-dzfit]').onclick = function (e) { e.preventDefault(); zoomFit(); };
  bar.querySelector('[data-list]').onclick = function (e) { e.preventDefault(); listComments(); };
  bar.querySelector('[data-elist]').onclick = function (e) { e.preventDefault(); listEdits(); };
  bar.querySelector('[data-flist]').onclick = function (e) { e.preventDefault(); listForgotten(); };
  (function () {
    var fzEl = bar.querySelector('[data-fz]'); if (!fzEl) return;
    fzEl.addEventListener('change', function () { setFontSize(parseFloat(fzEl.value)); });
    fzEl.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); setFontSize(parseFloat(fzEl.value)); fzEl.blur(); } });
  })();
  bar.querySelectorAll('[data-grp]').forEach(function (b) {
    b.onclick = function (e) { e.preventDefault(); toggleGrp(b.getAttribute('data-grp')); };
  });
  applyAllGrps();
  bar.querySelector('[data-expand]').onclick = function (e) {
    e.preventDefault(); expanded = !expanded; updateExpand();
    try { localStorage.setItem('pptEdExpanded', expanded ? '1' : '0'); } catch (e2) {}
  };
  bar.querySelector('[data-cmt-pick]').onclick = function (e) {
    e.preventDefault();
    // Toggle STICKY comment mode (stays on until Esc). If something is selected when
    // turning it on, comment that element too — but stay in comment mode either way.
    if (commentMode) { setCommentMode(false); return; }
    setCommentMode(true);
    if (sel) commentSel(sel);
  };

  // ---- replay: rebuild the visual edit layer + undo stack after a refresh ----
  // The server serves clean source on reload; we re-apply the recorded op HISTORY
  // to the DOM so edits persist, and push one undo step per op so Cmd/Ctrl+Z still
  // works across refreshes (each step also pops its matching server op).
  function safeQ(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function byHandle(h) { return h ? document.querySelector('[data-ppt-h="' + h + '"]') : null; }
  function resolveByAnchor(an) {
    an = an || {};
    if (an.nearest_id) { var e = document.getElementById(an.nearest_id); if (e) return e; }
    if (an.selector) { var s = safeQ(an.selector); if (s) return s; }
    return null;
  }
  function buildShape(type, props) {
    var el = document.createElement('div');
    el.setAttribute('data-ppt-shape', type);
    var base = 'position:absolute;left:' + (props.left || 0) + 'px;top:' + (props.top || 0) + 'px;box-sizing:border-box;';
    if (type === 'textbox') { el.style.cssText = base + 'min-width:120px;min-height:24px;font:16px system-ui;color:#111;padding:4px'; el.textContent = 'Text'; }
    else if (type === 'rect') { el.style.cssText = base + 'width:' + (props.width || 160) + 'px;height:' + (props.height || 90) + 'px;background:#2da6ff;'; }
    else if (type === 'oval') { el.style.cssText = base + 'width:' + (props.width || 120) + 'px;height:' + (props.height || 120) + 'px;background:#2da6ff;border-radius:50%;'; }
    else if (type === 'line') { el.style.cssText = base + 'height:0;border-top:3px solid #111;transform-origin:0 0;width:' + (props.width || 160) + 'px;' + (props.angle ? 'transform:rotate(' + props.angle + 'deg);' : ''); }
    else { el.style.cssText = base + 'width:100px;height:60px;background:#ccc;'; }
    return el;
  }
  // Shift an in-flow element to a target (left,top) within ref, measured from its
  // natural position. Temporarily reveals a hidden ancestor slide off-screen so the
  // measurement is correct even when replaying onto a non-active slide.
  function placeInflow(el, ref, left, top) {
    var slide = el.closest && el.closest('.slide, #stage, [data-ppt-stage]');
    var restore = null;
    if (slide && getComputedStyle(slide).display === 'none') {
      var prev = slide.getAttribute('style') || '';
      slide.style.setProperty('display', 'block', 'important');
      slide.style.position = 'absolute'; slide.style.left = '-99999px'; slide.style.top = '0';
      restore = function () { slide.setAttribute('style', prev); };
    }
    el.style.transform = '';
    var nat = el.getBoundingClientRect(), rr = ref.getBoundingClientRect();
    var dx = Math.round(((rr.left + left * curScale) - nat.left) / curScale);
    var dy = Math.round(((rr.top + top * curScale) - nat.top) / curScale);
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    if (restore) restore();
  }
  // True if `el` still carries the text the anchor was recorded against — used to avoid
  // applying a stale edit to an element that has since been rebuilt/replaced in source.
  function anchorMatches(el, anchor) {
    if (!anchor) return true;
    var want = (anchor.text_excerpt || '').replace(/\s+/g, ' ').trim();
    if (!want) return true;                                  // nothing recorded to verify against
    var have = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return have.indexOf(want.slice(0, 24)) >= 0;
  }
  function replayOp(op) {
    var v = op.value || {}, h = op.handle;
    if (op.op === 'reorder') {
      var before = getSlides().slice();
      if (v.ids && v.ids.length) applySlideSequence(v.ids);
      else if (v.order && v.order.length === before.length) arrangeSlides(v.order.map(function (i) { return before[i]; }));
      undoStack.push({ label: 'reorder slides', ops: 1, revert: function () {
        arrangeSlides(before); resyncNav(); if (sorterOpen && sorterEl) renderSorterGrid();
      } });
      resyncNav();
      return;
    }
    if (op.op === 'create') {
      // Structural creates (slide new/duplicate, object paste, duplicate-drag) carry a
      // `kind` and are reconstructed into clean source by Claude — do NOT replay them
      // here, or buildShape(undefined) would append a stray near-blank element that
      // covers the deck on refresh.
      if (v.kind) return;
      // Only recreate a shape we can actually place on its slide with a known type.
      // A malformed/stale create (no type, or parent no longer in the DOM) must NOT be
      // fabricated onto <body> — that floats a stray box at the top and shoves the deck
      // (the "slide is blank with a box at the top" artifact). Skip it; reconciliation owns it.
      var parent = v.parent && safeQ(v.parent);
      if (!parent || !v.type) return;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      var nel = buildShape(v.type, v.props || {});
      parent.appendChild(nel);
      if (h) nel.setAttribute('data-ppt-h', h);
      undoStack.push({ label: 'add ' + v.type, ops: 1, revert: function () { if (nel.parentNode) nel.parentNode.removeChild(nel); } });
      return;
    }
    var el = byHandle(h) || resolveByAnchor(op.anchor);
    if (!el) return;
    // Robustness vs a source re-actioned / rebuilt by a parallel pass: only apply an op when
    // the resolved element still carries the text it was recorded against. (Handles aren't in
    // fresh source — Pass 1 stamps them by anchor, so a handle match alone doesn't prove
    // identity.) If the node was rebuilt/replaced, skip rather than fling a stale move/style
    // onto the wrong element — which blanked or displaced slides.
    if (!anchorMatches(el, op.anchor)) return;
    if (h && !el.getAttribute('data-ppt-h')) el.setAttribute('data-ppt-h', h);
    if (op.op === 'delete') {
      // A slide-level delete is reconciled into clean SOURCE by Claude — don't replay it
      // on the live DOM, or the deck's own nav (dots/count, built at load for the full set)
      // desyncs: 13 -> 12, a skipped slide, and a dead last dot. Keep the deck intact;
      // the delete stays pending in the blueprint until actioned.
      if (el.matches && (el.matches('.slide') || el.querySelector('.slide'))) return;
      var p = el.parentNode, nx = el.nextSibling;
      undoStack.push({ label: 'delete', ops: 1, revert: function () { if (p) p.insertBefore(el, nx); } });
      el.remove(); return;
    }
    var prevCss = el.style.cssText, prevHTML = el.innerHTML;
    if (op.op === 'setText') el.textContent = v.text || '';
    else if (op.op === 'setHTML') el.innerHTML = v.html || '';
    else if (op.op === 'setStyle') { var s = v.style || {}; for (var k in s) el.style.setProperty(k, s[k]); }
    else if (op.op === 'setZ') el.style.zIndex = String(v.z);
    else if (op.op === 'resize') { if (v.w != null) el.style.width = v.w + 'px'; if (v.h != null) el.style.height = v.h + 'px'; }
    else if (op.op === 'move') {
      if (v.shape || el.getAttribute('data-ppt-shape')) { el.style.position = 'absolute'; el.style.left = v.left + 'px'; el.style.top = v.top + 'px'; }
      else placeInflow(el, (v.ref && safeQ(v.ref)) || stageOf(el), v.left, v.top);
    }
    undoStack.push({ label: op.op, ops: 1, revert: function () { el.style.cssText = prevCss; el.innerHTML = prevHTML; } });
  }
  function replayFromServer() {
    fetch('/__blueprint').then(function (r) { return r.json(); }).then(function (bp) {
      setEdits((bp.edits || []).length);
      if (SRC) { refreshUndo(); return; }   // source is the truth — do NOT replay (no divergence)
      var hist = bp.history || [];
      if (hist.length) {
        // Pass 1: stamp handles on pre-existing elements in the pristine DOM, so
        // later ops resolve by handle and survive sibling insert/delete shifts.
        var seen = {};
        hist.forEach(function (op) {
          if (!op.handle || seen[op.handle] || op.op === 'create') { if (op.handle) seen[op.handle] = 1; return; }
          seen[op.handle] = 1;
          var el = resolveByAnchor(op.anchor);
          if (el && !el.getAttribute('data-ppt-h')) el.setAttribute('data-ppt-h', op.handle);
        });
        // Pass 2: replay non-reorder ops in order, then apply only the LAST
        // reorder (reorders are whole-deck and would compound if stacked).
        var reorders = [];
        hist.forEach(function (op) { try { if (op.op === 'reorder') reorders.push(op); else replayOp(op); } catch (e) {} });
        if (reorders.length) { try { replayOp(reorders[reorders.length - 1]); } catch (e) {} }
      }
      refreshUndo();
    }).catch(function () { refreshUndo(); });
  }

  // ---- boot: restore editor state, counts, and replay edits -----------------
  try {
    expanded = localStorage.getItem('pptEdExpanded') !== '0';
    if (localStorage.getItem('pptEdOn') === '1') setOn(true); else updateExpand();
  } catch (e) { updateExpand(); }
  fetch('/__comments').then(function (r) { return r.json(); })
    .then(function (d) { setCount(d.filter(function (c) { return c.status !== 'done'; }).length); })
    .catch(function () {});
  replayFromServer();

  // Persist & restore the viewed slide + sorter across refresh — the deck's own nav
  // resets to slide 1 on load, so put the user back where they were.
  var VKEY = 'pptEdView:' + location.pathname;
  function saveViewState() {
    try {
      var nonAux = Array.prototype.slice.call(document.querySelectorAll('.slide:not(.aux)'));
      var ai = nonAux.findIndex(function (s) { return s.classList.contains('active'); });
      localStorage.setItem(VKEY, JSON.stringify({ slide: ai, sorter: !!sorterOpen }));
    } catch (e) {}
  }
  function restoreViewState() {
    try {
      var st = JSON.parse(localStorage.getItem(VKEY) || '{}');
      if (st.slide > 0) {
        if (typeof window.show === 'function') window.show(st.slide);
        else {
          var na = Array.prototype.slice.call(document.querySelectorAll('.slide:not(.aux)'));
          if (na[st.slide]) { document.querySelectorAll('.slide.active').forEach(function (s) { s.classList.remove('active'); }); na[st.slide].classList.add('active'); }
        }
      }
      if (st.sorter && !sorterOpen && getSlides().length >= 2) openSorter();
    } catch (e) {}
  }
  window.addEventListener('beforeunload', saveViewState);
  window.addEventListener('pagehide', saveViewState);
  if (document.readyState === 'complete') setTimeout(restoreViewState, 40);
  else window.addEventListener('load', function () { setTimeout(restoreViewState, 40); });
})();
