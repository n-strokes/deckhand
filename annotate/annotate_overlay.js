(function () {
  if (window.__annInit) return;
  window.__annInit = true;
  var ON = false;
  var dragging = false; // true while a comment box is being dragged

  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;' +
    'font:14px/1.4 system-ui,sans-serif;background:#111;color:#fff;border-radius:10px;' +
    'padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.3);user-select:none';
  bar.innerHTML =
    '<a href="#" id="anncollapse" title="collapse" style="color:#7cf;text-decoration:none;' +
    'font-weight:700;font-size:16px;margin-right:8px;vertical-align:-1px">&rsaquo;</a>' +
    '<b>Annotate</b>' +
    '<span id="annbody"> <span id="annc">0</span> open &middot; ' +
    '<a href="#" id="anntog" style="color:#7cf;text-decoration:none">off</a> &middot; ' +
    '<a href="#" id="annlist" style="color:#7cf;text-decoration:none">list</a></span>';
  document.body.appendChild(bar);

  var hi = document.createElement('div');
  hi.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;' +
    'border:2px solid #ff3b6b;background:rgba(255,59,107,.12);display:none;border-radius:3px';
  document.body.appendChild(hi);

  // Persistent "selected from the list" highlight (blue), distinct from the red
  // hover box. Shown only while annotation is OFF — when ON, the cursor hover
  // highlight (hi) takes over and this is suppressed.
  var sel = document.createElement('div');
  sel.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;' +
    'border:2px solid #2da6ff;background:rgba(45,166,255,.14);display:none;border-radius:3px;' +
    'box-shadow:0 0 0 2px rgba(45,166,255,.22)';
  document.body.appendChild(sel);

  var selId = null; // currently selected comment id (null = none)
  var selEl = null; // resolved DOM element for that comment
  var replyId = null; // comment id whose reply box is currently open (null = none)

  function resolveEl(c) {
    // Prefer the precise selector (the exact element clicked) over nearest_id —
    // nearest_id walks up to the closest ancestor with an id (e.g. the whole
    // #svg), which would light up everything instead of the sub-element.
    var e = null;
    if (c && c.selector) { try { e = document.querySelector(c.selector); } catch (_) {} }
    if (!e && c && c.nearest_id) e = document.getElementById(c.nearest_id);
    return e;
  }
  // Position the selection box over selEl. Hidden when nothing is selected,
  // the element is gone, or annotation is ON (hover overrides).
  function placeSel() {
    if (selId == null || !selEl || ON) { sel.style.display = 'none'; return; }
    var r = selEl.getBoundingClientRect();
    sel.style.display = 'block';
    sel.style.left = r.left + 'px'; sel.style.top = r.top + 'px';
    sel.style.width = r.width + 'px'; sel.style.height = r.height + 'px';
  }
  function markSelectedTile() {
    panel.querySelectorAll('[data-row]').forEach(function (row) {
      var on = Number(row.getAttribute('data-row')) === selId;
      row.style.background = on ? '#eaf4ff' : '';
      row.style.borderColor = on ? '#2da6ff' : '#eee';
    });
  }
  window.addEventListener('scroll', placeSel, true);
  window.addEventListener('resize', placeSel);

  function clearSelection() { selId = null; selEl = null; replyId = null; sel.style.display = 'none'; }
  // Closing/leaving the list cancels any selection highlight.
  function closePanel() { panel.style.display = 'none'; clearSelection(); }

  // ---- comment manager panel (the "list" pop-up) -------------------------
  var panel = document.createElement('div');
  panel.className = 'ann-box';
  panel.style.cssText = 'position:fixed;z-index:2147483647;bottom:60px;right:16px;display:none;' +
    'width:360px;max-height:60vh;overflow:auto;background:#fff;color:#111;border:1px solid #ccc;' +
    'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);font:13px/1.4 system-ui,sans-serif;padding:8px';
  document.body.appendChild(panel);

  function setCount(n) { document.getElementById('annc').textContent = n; }

  function setOn(v) {
    ON = v;
    var t = document.getElementById('anntog');
    if (t) t.textContent = ON ? 'ON' : 'off';
    hi.style.display = 'none';
    placeSel(); // ON hides the list-selection box; off restores it
  }

  // collapsed = minimized pill (just the toggle button + "Annotate")
  var collapsed = false;
  function setCollapsed(v) {
    collapsed = v;
    document.getElementById('annbody').style.display = v ? 'none' : '';
    var c = document.getElementById('anncollapse');
    c.innerHTML = v ? '&lsaquo;' : '&rsaquo;';
    c.title = v ? 'expand' : 'collapse';
    if (v) closePanel();
  }

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

  function inOverlay(el) {
    if (!el) return false;
    if (el === bar || bar.contains(el) || el === hi) return true;
    return !!(el.closest && el.closest('.ann-box'));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  document.addEventListener('mousemove', function (e) {
    if (!ON || dragging) return;
    var el = e.target;
    if (inOverlay(el)) { hi.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hi.style.display = 'block';
    hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px'; hi.style.height = r.height + 'px';
  }, true);

  document.addEventListener('click', function (e) {
    if (!ON) return;
    if (inOverlay(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    openBox(e.target, e.clientX, e.clientY);
  }, true);

  function openBox(el, x, y) {
    var box = document.createElement('div');
    box.className = 'ann-box ann-input';
    box.style.cssText = 'position:fixed;z-index:2147483647;left:' +
      Math.min(x, innerWidth - 300) + 'px;top:' + Math.min(y, innerHeight - 140) + 'px;' +
      'background:#fff;color:#111;border:1px solid #ccc;border-radius:8px;padding:8px;' +
      'width:280px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:14px system-ui,sans-serif';
    box.innerHTML =
      '<div data-drag title="drag to move" style="font:12px monospace;color:#666;' +
      'margin-bottom:6px;max-height:34px;overflow:hidden;cursor:move;user-select:none">' +
      '&#x2630; ' + esc(selectorFor(el)) + '</div>' +
      '<textarea style="width:100%;height:64px;box-sizing:border-box;font:14px system-ui" ' +
      'placeholder="comment... (Cmd/Ctrl+Enter to save, Esc to cancel)"></textarea>' +
      '<div style="text-align:right;margin-top:6px">' +
      '<button data-x style="margin-right:6px">cancel</button>' +
      '<button data-s>save</button></div>';
    document.body.appendChild(box);
    var ta = box.querySelector('textarea'); ta.focus();

    // Drag the box around by its header. Move/up listeners only live for the
    // duration of a drag, so nothing leaks when the box closes.
    box.querySelector('[data-drag]').addEventListener('mousedown', function (ev) {
      ev.preventDefault(); // no text selection while dragging
      dragging = true;
      hi.style.display = 'none';
      var r = box.getBoundingClientRect();
      var ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      function move(e2) {
        var nx = Math.max(0, Math.min(e2.clientX - ox, innerWidth - box.offsetWidth));
        var ny = Math.max(0, Math.min(e2.clientY - oy, innerHeight - box.offsetHeight));
        box.style.left = nx + 'px'; box.style.top = ny + 'px';
      }
      function up() {
        dragging = false;
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });

    function close() { box.remove(); }
    function save() {
      var txt = ta.value.trim();
      if (!txt) { close(); return; }
      var payload = {
        page: location.pathname,
        selector: selectorFor(el),
        nearest_id: nearestId(el),
        tag: el.tagName.toLowerCase(),
        text_excerpt: (el.textContent || '').trim().slice(0, 120),
        comment: txt
      };
      fetch('/__comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); })
        .then(function (d) { setCount(d.count); if (panel.style.display !== 'none') renderList(); })
        .catch(function () {});
      close();
    }
    box.querySelector('[data-x]').onclick = close;
    box.querySelector('[data-s]').onclick = save;
    ta.addEventListener('keydown', function (ev) {
      // Esc is handled globally (it cancels this box); here only handle save.
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') save();
    });
  }

  // Global Esc precedence (capture phase, so it runs before the box's own
  // handlers):
  // 1. an open comment box -> cancel it
  // 2. editing/replying in the list -> leave alone (the textarea cancels itself)
  // 3. a comment is selected in the list -> unselect it (collapse the thread)
  // 4. the list is open -> close the list
  // 5. annotation is ON -> turn it off
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var inputBox = document.querySelector('.ann-input');
    if (inputBox) { e.preventDefault(); e.stopPropagation(); inputBox.remove(); return; }
    if (panel.style.display !== 'none' && panel.querySelector('textarea')) return;
    if (panel.style.display !== 'none' && selId != null) {
      e.preventDefault(); e.stopPropagation(); clearSelection(); renderList(); return;
    }
    if (panel.style.display !== 'none') { e.preventDefault(); e.stopPropagation(); closePanel(); return; }
    if (ON) { e.preventDefault(); setOn(false); }
  }, true);

  // While the caret is in any annotation field, keep the underlying page from
  // reacting to the keyboard (slide decks commonly advance on Arrow/Space/Page
  // keys via a document keydown listener). We listen on window in the capture
  // phase — the earliest point, ahead of any page handler — and stop the event
  // from propagating down to the page. We deliberately let Escape and
  // Cmd/Ctrl+Enter through so the box's own cancel/save shortcuts still fire.
  // stopPropagation does NOT suppress the default action, so typing and caret
  // movement inside the field are unaffected. The mouse is never touched, so
  // the slide stays fully clickable/hoverable while a comment is open.
  function annInputFocused() {
    var ae = document.activeElement;
    if (!ae || (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT')) return false;
    return !!(ae.closest && ae.closest('.ann-box'));
  }
  function shieldKey(e) {
    if (!annInputFocused()) return;
    if (e.key === 'Escape') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return;
    e.stopPropagation();
  }
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, shieldKey, true);
  });

  // ---- list / edit / delete ---------------------------------------------
  // Header carries the bulk actions (copy / clear done / wipe) so the main
  // bar stays minimal. Re-rendered on every renderList(), so re-wire each time.
  function headerHTML(total) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:2px 4px 8px;border-bottom:1px solid #eee;margin-bottom:6px">' +
      '<b>Comments (' + total + ')</b>' +
      '<span style="font-size:12px;white-space:nowrap">' +
      '<a href="#" id="anncopy" style="color:#06c;text-decoration:none;margin-left:10px">copy</a>' +
      '<a href="#" id="annclear" style="color:#06c;text-decoration:none;margin-left:10px">clear done</a>' +
      '<a href="#" id="annwipe" style="color:#c33;text-decoration:none;margin-left:10px">wipe</a>' +
      '<a href="#" id="annclose" style="color:#888;text-decoration:none;margin-left:10px">close</a>' +
      '</span></div>';
  }
  function wireHeader() {
    panel.querySelector('#annclose').onclick = function (e) { e.preventDefault(); closePanel(); };
    panel.querySelector('#annclear').onclick = function (e) {
      e.preventDefault();
      fetch('/__clear?mode=done', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) { setCount(d.count); renderList(); });
    };
    panel.querySelector('#annwipe').onclick = function (e) {
      e.preventDefault();
      if (!confirm('Wipe ALL comments (open + done)?')) return;
      fetch('/__clear?mode=all', { method: 'POST' })
        .then(function () { setCount(0); renderList(); });
    };
    panel.querySelector('#anncopy').onclick = function (e) {
      e.preventDefault();
      var link = e.target;
      fetch('/__comments').then(function (r) { return r.json(); }).then(function (d) {
        var open = d.filter(function (c) { return c.status !== 'done'; });
        var md = open.map(function (c) {
          var anchor = c.nearest_id ? '#' + c.nearest_id : c.selector;
          var s = '- [' + c.page + '] `' + anchor + '` (' + c.tag +
            ', "' + c.text_excerpt + '")\n -> ' + c.comment;
          (c.thread || []).forEach(function (m) {
            s += '\n ' + (m.author === 'user' ? 'you' : 'Claude') + ': ' + m.text;
          });
          return s;
        }).join('\n');
        navigator.clipboard.writeText(md);
        link.textContent = 'copied!';
        setTimeout(function () { link.textContent = 'copy'; }, 1200);
      });
    };
  }

  // The expanded conversation under a comment: each message styled by author
  // (your replies tinted blue, Claude's set off with a teal rule + indent).
  // Messages only — the reply box is separate (replyBoxHTML) and shown on demand
  // when the user clicks the "reply" action link. Returns '' for an empty thread.
  function threadHTML(thread) {
    if (!thread.length) return '';
    var rows = thread.map(function (m) {
      var mine = m.author === 'user';
      return '<div style="margin:4px 0;padding:5px 7px;border-radius:6px;white-space:pre-wrap;' +
        (mine ? 'background:#eef4ff;border:1px solid #d6e4ff'
              : 'background:#f4f6f5;border-left:3px solid #6BBBAE;margin-left:14px') + '">' +
        '<div style="font:10px system-ui;color:#888;margin-bottom:2px">' +
        (mine ? 'you' : 'Claude') + '</div>' + esc(m.text) + '</div>';
    }).join('');
    return '<div data-thread style="margin:6px 0;border-top:1px dashed #ddd;padding-top:6px">' +
      rows + '</div>';
  }

  // The reply composer, shown under a comment only while its "reply" link is
  // active (replyId === id). Sending appends to the thread and re-opens the
  // comment for another pass.
  function replyBoxHTML(id) {
    return '<div data-replybox style="margin:6px 0;border-top:1px dashed #ddd;padding-top:6px">' +
      '<textarea data-reply placeholder="reply… (Cmd/Ctrl+Enter to send, Esc to cancel)" ' +
      'style="width:100%;height:46px;box-sizing:border-box;font:13px system-ui"></textarea>' +
      '<div style="text-align:right;margin-top:4px">' +
      '<button data-replycancel style="margin-right:6px">cancel</button>' +
      '<button data-send="' + id + '">reply</button></div>' +
      '</div>';
  }

  function renderList() {
    fetch('/__comments').then(function (r) { return r.json(); }).then(function (d) {
      setCount(d.filter(function (c) { return c.status !== 'done'; }).length);
      // drop a selection whose comment no longer exists
      if (selId != null && !d.some(function (c) { return c.id === selId; })) {
        selId = null; selEl = null; placeSel();
      }
      if (!d.length) {
        panel.innerHTML = headerHTML(0) + '<div style="padding:10px;color:#666">No comments yet.</div>';
        wireHeader();
        return;
      }
      // open first, then done; within each group most-recently-active first
      // (highest rev). A brand-new comment and a freshly-replied (re-opened)
      // thread both carry the latest rev, so both rise to the top, pez-style.
      var order = d.slice().sort(function (a, b) {
        var ad = a.status === 'done' ? 1 : 0, bd = b.status === 'done' ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return (b.rev || 0) - (a.rev || 0);
      });
      var html = headerHTML(d.length);
      order.forEach(function (c) {
        var anchor = c.nearest_id ? '#' + c.nearest_id : (c.selector || '');
        var done = c.status === 'done';
        var thread = c.thread || [];
        var expanded = selId === c.id; // the selected row is the expanded one
        // collapsed rows stay compact (just the original comment); a 💬 badge
        // signals a hidden thread. expanded rows show the full conversation.
        var badge = thread.length
          ? '<span data-expand style="cursor:pointer;color:#06c">&#128172; ' + thread.length + '</span>'
          : '';
        html += '<div data-row="' + c.id + '" style="padding:6px;border:1px solid #eee;' +
          'border-radius:6px;margin-bottom:6px;' + (done && !expanded ? 'opacity:.6' : '') + '">' +
          '<div style="font:11px monospace;color:#888;display:flex;justify-content:space-between">' +
          '<span>' + esc(anchor) + ' &middot; ' + esc(c.tag || '') + '</span>' +
          '<span>' + (done ? 'done' : 'open') + '</span></div>' +
          '<div data-text style="margin:4px 0;white-space:pre-wrap">' + esc(c.comment) + '</div>' +
          (expanded ? threadHTML(thread) : '') +
          (replyId === c.id ? replyBoxHTML(c.id) : '') +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span style="font-size:12px">' + badge + '</span>' +
          '<span>' +
          '<a href="#" data-reply-open="' + c.id + '" style="color:#06c;margin-right:10px;text-decoration:none">reply</a>' +
          '<a href="#" data-edit="' + c.id + '" style="color:#06c;margin-right:10px;text-decoration:none">edit</a>' +
          '<a href="#" data-del="' + c.id + '" style="color:#c33;text-decoration:none">delete</a>' +
          '</span></div></div>';
      });
      panel.innerHTML = html;
      wireHeader();
      // click a tile (not its action links, its thread, or an open reply box) to
      // select it: lights up the target element AND expands the thread to show
      // any replies. Click again to deselect/collapse. Only one row is expanded
      // at a time. Selecting never opens the reply composer — that's the "reply"
      // link's job — so any open reply box is dismissed here.
      panel.querySelectorAll('[data-row]').forEach(function (row) {
        row.style.cursor = 'pointer';
        row.onclick = function (e) {
          if (e.target.closest('[data-reply-open],[data-edit],[data-del],[data-thread],[data-replybox],textarea,button')) return;
          var id = Number(row.getAttribute('data-row'));
          replyId = null;
          if (selId === id) { selId = null; selEl = null; }
          else {
            selId = id;
            var c = order.filter(function (x) { return x.id === id; })[0];
            selEl = resolveEl(c);
          }
          // re-render so the thread expands/collapses; selId persists across it
          renderList();
        };
      });
      markSelectedTile();
      placeSel();
      panel.querySelectorAll('[data-del]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          if (!confirm('Delete this comment?')) return;
          fetch('/__delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(a.getAttribute('data-del')) })
          }).then(function (r) { return r.json(); })
            .then(function (res) { if (res.ok !== false) setCount(res.count); renderList(); });
        };
      });
      panel.querySelectorAll('[data-edit]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var id = Number(a.getAttribute('data-edit'));
          replyId = null;
          var row = panel.querySelector('[data-row="' + id + '"]');
          var cur = order.filter(function (c) { return c.id === id; })[0];
          var textDiv = row.querySelector('[data-text]');
          textDiv.innerHTML = '<textarea style="width:100%;height:60px;box-sizing:border-box;' +
            'font:13px system-ui">' + esc(cur.comment) + '</textarea>' +
            '<div style="text-align:right;margin-top:4px">' +
            '<button data-cancel style="margin-right:6px">cancel</button>' +
            '<button data-save>save</button></div>';
          var ta = textDiv.querySelector('textarea'); ta.focus();
          textDiv.querySelector('[data-cancel]').onclick = function () { renderList(); };
          function commit() {
            var txt = ta.value.trim();
            if (!txt) { renderList(); return; }
            fetch('/__update', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: id, comment: txt })
            }).then(function (r) { return r.json(); })
              .then(function (res) { if (res.ok !== false) setCount(res.count); renderList(); });
          }
          textDiv.querySelector('[data-save]').onclick = commit;
          ta.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') renderList();
            if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') commit();
          });
        };
      });
      // "reply" link: open the reply composer for this row. Selecting+expanding
      // the row first means the existing thread shows above the composer.
      panel.querySelectorAll('[data-reply-open]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var id = Number(a.getAttribute('data-reply-open'));
          selId = id;
          selEl = resolveEl(order.filter(function (x) { return x.id === id; })[0]);
          replyId = id;
          renderList(); // focus happens at the tail of renderList (see below)
        };
      });
      // reply box (present only on the row whose reply link is active): append to
      // the thread and re-open the comment so Claude re-actions it. renderList()
      // afterwards keeps this row selected, so it stays expanded and floats up.
      panel.querySelectorAll('[data-send]').forEach(function (b) {
        var id = Number(b.getAttribute('data-send'));
        var row = panel.querySelector('[data-row="' + id + '"]');
        var ta = row.querySelector('[data-reply]');
        var cancel = row.querySelector('[data-replycancel]');
        function send() {
          var txt = ta.value.trim();
          if (!txt) return;
          replyId = null;
          fetch('/__reply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, text: txt })
          }).then(function (r) { return r.json(); })
            .then(function (res) { if (res && res.ok !== false) setCount(res.count); renderList(); });
        }
        b.onclick = function (e) { e.preventDefault(); send(); };
        if (cancel) cancel.onclick = function (e) { e.preventDefault(); replyId = null; renderList(); };
        ta.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') { ev.preventDefault(); replyId = null; renderList(); }
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); send(); }
        });
      });
      // If a reply composer is showing, put the caret in it (it was just opened
      // via the reply link, or survived a re-render).
      if (replyId != null) {
        var rrow = panel.querySelector('[data-row="' + replyId + '"]');
        var rta = rrow && rrow.querySelector('[data-reply]');
        if (rta) rta.focus();
      }
    });
  }

  document.getElementById('annlist').onclick = function (e) {
    e.preventDefault();
    if (panel.style.display === 'none') { panel.style.display = 'block'; renderList(); }
    else { closePanel(); }
  };

  document.getElementById('anntog').onclick = function (e) {
    e.preventDefault(); setOn(!ON);
  };
  document.getElementById('anncollapse').onclick = function (e) {
    e.preventDefault(); setCollapsed(!collapsed);
  };

  fetch('/__comments').then(function (r) { return r.json(); })
    .then(function (d) {
      setCount(d.filter(function (c) { return c.status !== 'done'; }).length);
    }).catch(function () {});
})();
