# -*- coding: utf-8 -*-
"""Capture each slide of an HTML deck as a clean PNG using headless Chrome.

Renders the deck through a throwaway harness page that loads it in a 1280x720
iframe, hides the on-screen nav and any injected annotate widget, and calls the
deck's own show(n) to page to each slide. One PNG per slide, full-bleed, no chrome.

Usage:
    python3 capture_slides.py DECK.html [--out DIR] [--slides 0,2,5] [--scale 2]

DECK.html is a path relative to the project root (the cwd you run this from),
e.g. a path like slides/deck.html . Output defaults to <deck-dir>/shots/.

The deck must expose a global show(i) that activates the i-th `.slide` section
(the standard deck-nav convention) - that is how we page between slides.

macOS note: CHROME_CANDIDATES points at the standard macOS Chrome install, then
Chromium/Edge as fallbacks. Originally authored for Windows.
"""
import argparse, http.server, os, re, shutil, socket, socketserver, subprocess, sys, tempfile, threading, time

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",  # fallback
]

HARNESS = """<!doctype html><meta charset=utf-8>
<style>html,body{{margin:0;padding:0;background:#fff;width:1280px;height:720px;overflow:hidden}}
iframe{{border:0;width:1280px;height:720px;display:block}}</style>
<iframe id=f src="/{deck}"></iframe>
<script>
const n=parseInt((location.hash.slice(1)||"0"),10);
const f=document.getElementById('f');
function hideWidget(doc,win){{
  if(!doc||!doc.body) return;
  Array.from(doc.body.querySelectorAll('*')).forEach(el=>{{
    const cs=win.getComputedStyle(el);
    if(cs.position==='fixed' && parseInt(cs.zIndex||'0',10)>=2147483000) el.style.setProperty('display','none','important');
  }});
}}
function scrub(){{try{{
  f.contentWindow.show(n);
  hideWidget(f.contentDocument,f.contentWindow);
  hideWidget(document,window);
  document.title='OK';
}}catch(e){{document.title='ERR '+e;}}}}
f.onload=()=>{{
  try{{const d=f.contentDocument,css=d.createElement('style');
    css.textContent='html,body{{background:#fff!important}}'
      +'.nav{{display:none!important}}'
      +'.slide{{margin:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important}}';
    d.head.appendChild(css);
  }}catch(e){{}}
  setInterval(scrub,150); setTimeout(scrub,250);
}};
</script>
"""

def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("No Chrome/Chromium/Edge found. Edit CHROME_CANDIDATES in capture_slides.py.")

def free_port(base=8830):
    for p in range(base, base + 80):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p)); return p
            except OSError:
                continue
    raise SystemExit("no free port")

def count_slides(deck_path):
    html = open(deck_path, encoding="utf-8").read()
    # count nav slides only: class contains "slide" but not "aux".
    # aux slides (class="slide aux") are link-only, excluded from show()'s nav order,
    # so capturing 0..count via show() must not include them (show() clamps past the end).
    return len(re.findall(r'class="slide(?! aux)[^"]*"', html))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("deck", help="deck .html path, relative to project root (cwd)")
    ap.add_argument("--out", default=None, help="output dir (default <deck-dir>/shots)")
    ap.add_argument("--slides", default=None, help="comma list of 0-based indices; default all")
    ap.add_argument("--scale", type=float, default=2.0, help="device scale factor (2 = 2560x1440)")
    a = ap.parse_args()

    root = os.getcwd()
    deck_rel = a.deck.replace("\\", "/")
    deck_abs = os.path.join(root, deck_rel)
    if not os.path.exists(deck_abs):
        raise SystemExit(f"deck not found: {deck_abs}")

    # ABSOLUTE out dir: Chrome resolves a relative --screenshot path against its cwd, and
    # silently fails to write when the cwd has spaces/parens.
    out = os.path.abspath(a.out or os.path.join(os.path.dirname(deck_abs), "shots"))
    os.makedirs(out, exist_ok=True)

    n = count_slides(deck_abs)
    idxs = [int(x) for x in a.slides.split(",")] if a.slides else list(range(n))
    print(f"{n} slides in deck; capturing {len(idxs)}: {idxs}")

    chrome = find_chrome()
    port = free_port()

    # throwaway harness at project root so the deck's relative img/ paths resolve
    fd, harness_abs = tempfile.mkstemp(prefix="_capture_", suffix=".html", dir=root)
    os.close(fd)
    harness_rel = os.path.basename(harness_abs)
    open(harness_abs, "w", encoding="utf-8").write(HARNESS.format(deck=deck_rel))

    handler = lambda *args, **kw: http.server.SimpleHTTPRequestHandler(*args, directory=root, **kw)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    try:
        for i in idxs:
            png = os.path.join(out, f"slide{i:02d}.png")
            url = f"http://127.0.0.1:{port}/{harness_rel}#{i}"
            cmd = [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                   f"--force-device-scale-factor={a.scale}",
                   "--window-size=1280,720", "--virtual-time-budget=5000",
                   "--run-all-compositor-stages-before-draw",
                   f"--screenshot={png}", url]
            with tempfile.TemporaryDirectory() as ud:
                cmd.insert(1, f"--user-data-dir={ud}")
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ok = os.path.exists(png) and os.path.getsize(png) > 0
            print(("  OK  " if ok else "  FAIL") + f" slide {i} -> {png}")
    finally:
        httpd.shutdown()
        try: os.remove(harness_abs)
        except OSError: pass
    print(f"done -> {out}")

if __name__ == "__main__":
    main()
