# -*- coding: utf-8 -*-
"""Stage 1 of the canonical HTML->PPT derive tool: read the LIVE deck with headless
Chrome and emit a faithful, computed-from-the-browser description of every slide.

The PPT renderer (render_pptx_com.py) consumes this JSON, so the PowerPoint is always
derived from the current HTML and can never drift to a hard-coded copy.

For each `.slide` (nav slides; `.slide.aux` excluded, matching the deck nav) we activate
it via the deck's own show(i), wait for fonts + layout, then walk it and record each
renderable element's slide-local geometry, computed style, text, lists, and tables.

Transport: the harness page POSTs each slide's JSON back to this script's own
http.server (no Chrome DevTools Protocol, no extra deps). The POST arriving is the
readiness signal.

Usage:
    python extract_slides.py DECK.html [--out OUT.json] [--slides 0,2,5]
DECK.html is relative to the project root (the cwd you run from).
"""
import argparse, http.server, json, os, re, socket, socketserver, subprocess, sys, tempfile, threading, time

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

# Harness: loads the deck in a 1280x720 iframe, activates slide #i, waits for fonts +
# two animation frames, walks the active slide, and POSTs the result. __DECK__ is the
# only substitution (the slide index rides in location.hash, like capture_slides.py).
HARNESS = r"""<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;padding:0;background:#fff;width:1280px;height:720px;overflow:hidden}
iframe{border:0;width:1280px;height:720px;display:block}</style>
<iframe id=f src="/__DECK__"></iframe>
<script>
const f=document.getElementById('f');
const i=parseInt((location.hash.slice(1)||"0"),10);
const INLINE=/^(B|I|U|EM|STRONG|SPAN|A|BR|MARK|SMALL|SUB|SUP|CODE|FONT|TSPAN|WBR)$/;
function txt(el){return (el.innerText||el.textContent||"").replace(/ /g," ").replace(/\s+/g," ").trim();}
function isTextLeaf(el){
  if(!txt(el)) return false;
  for(const c of el.children){ if(txt(c) && !INLINE.test(c.tagName)) return false; }
  return true;
}
function col(s){
  if(!s) return null;
  const m=String(s).match(/rgba?\(([^)]+)\)/); if(!m) return null;
  const p=m[1].split(",").map(x=>parseFloat(x)); const a=p.length>3?p[3]:1;
  if(!(a>0)) return null;
  const h=n=>("0"+Math.round(n).toString(16)).slice(-2);
  return "#"+h(p[0])+h(p[1])+h(p[2]);
}
function fontOf(cs){return {family:cs.fontFamily,size:parseFloat(cs.fontSize)||0,
  weight:parseInt(cs.fontWeight)||400,italic:cs.fontStyle==="italic",
  align:cs.textAlign,lineHeight:cs.lineHeight,color:col(cs.color)||"#071D49"};}
function borderOf(cs){
  const w=parseFloat(cs.borderTopWidth)||0;
  if(w<=0||cs.borderTopStyle==="none") return null;
  const c=col(cs.borderTopColor); if(!c) return null;
  return {width:w,color:c,style:cs.borderTopStyle};
}
function box(el,sr){const r=el.getBoundingClientRect();
  return {left:r.left-sr.left,top:r.top-sr.top,w:r.width,h:r.height};}
function items(el){return Array.from(el.querySelectorAll(":scope > li")).map(li=>txt(li));}
function vanchor(cs){
  // CSS flex column justify -> PPT vertical anchor hint
  if(cs.display.indexOf("flex")>=0 && cs.flexDirection.indexOf("column")>=0){
    if(cs.justifyContent==="center") return "middle";
    if(cs.justifyContent==="flex-end") return "bottom";
  }
  return "top";
}
function emitTable(el,sr,out){
  const b=box(el,sr);
  let colw=Array.from(el.querySelectorAll("col")).map(c=>c.getBoundingClientRect().width);
  const rows=Array.from(el.querySelectorAll("tr")); let cells=[],cols=0;
  rows.forEach(tr=>{
    const row=[];
    Array.from(tr.children).forEach(td=>{
      const cs=getComputedStyle(td); const ul=td.querySelector(":scope ul,:scope ol");
      let t=txt(td),it=null; if(ul){it=items(ul);t=null;}
      row.push({text:t,items:it,font:fontOf(cs),fill:col(cs.backgroundColor),
        align:cs.textAlign,valign:cs.verticalAlign,border:borderOf(cs),
        head:td.tagName==="TH"});
    });
    cols=Math.max(cols,row.length); cells.push(row);
  });
  if(!colw.length && cells[0]) colw=cells[0].map((_,j)=>{
    const c=rows[0].children[j]; return c?c.getBoundingClientRect().width:0;});
  out.push({role:"table",left:b.left,top:b.top,w:b.w,h:b.h,rows:cells.length,cols:cols,colWidths:colw,cells:cells});
}
function walk(el,sr,out){
  if(el.nodeType!==1) return;
  if(el.closest("[data-ppt-ui],[data-ppt-scenery],.nav")) return;
  const cs=getComputedStyle(el);
  if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity)===0) return;
  const tag=el.tagName;
  if(tag==="TABLE"){ emitTable(el,sr,out); return; }
  const fill=col(cs.backgroundColor), bd=borderOf(cs), rad=parseFloat(cs.borderTopLeftRadius)||0;
  if(tag==="UL"||tag==="OL"){
    const b=box(el,sr);
    out.push({role:"list",left:b.left,top:b.top,w:b.w,h:b.h,font:fontOf(cs),
      fill:fill,border:bd,radius:rad,items:items(el)});
    return;
  }
  if(tag==="IMG"){ const b=box(el,sr); out.push({role:"image",left:b.left,top:b.top,w:b.w,h:b.h,src:el.getAttribute("src")}); return; }
  if(isTextLeaf(el)){
    const b=box(el,sr);
    out.push({role:"text",left:b.left,top:b.top,w:b.w,h:b.h,font:fontOf(cs),
      text:txt(el),fill:fill,border:bd,radius:rad,valign:vanchor(cs)});
    return;
  }
  if(fill||bd){
    const b=box(el,sr);
    out.push({role:"rect",left:b.left,top:b.top,w:b.w,h:b.h,fill:fill,border:bd,radius:rad});
  }
  Array.from(el.children).forEach(c=>walk(c,sr,out));
}
async function run(){
  try{
    const win=f.contentWindow, doc=f.contentDocument;
    const all=Array.from(doc.querySelectorAll(".slide")).filter(s=>!s.classList.contains("aux") && !s.classList.contains("no-ppt") && !s.closest("[data-ppt-ui]"));
    const slide=all[i];
    if(!slide){ return post({error:"no slide "+i}); }
    try{ if(typeof win.show==="function") win.show(i); }catch(e){}
    all.forEach(s=>s.classList.remove("active")); slide.classList.add("active");
    await (doc.fonts?doc.fonts.ready:Promise.resolve());
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const sr=slide.getBoundingClientRect(), out=[];
    Array.from(slide.children).forEach(c=>walk(c,sr,out));
    post({index:i,key:(slide.id||("@"+txt(slide).slice(0,60))),hasId:!!slide.id,elements:out});
  }catch(e){ post({error:String(e&&e.stack||e)}); }
}
function post(payload){
  fetch("/__extract?i="+i,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(()=>{document.title="DONE "+i;}).catch(e=>{document.title="ERR "+e;});
}
f.onload=()=>{
  try{ const d=f.contentDocument, css=d.createElement("style");
    css.textContent=".nav{display:none!important}.slide{margin:0!important;box-shadow:none!important;border-radius:0!important;max-width:none!important}";
    d.head.appendChild(css);
  }catch(e){}
  setTimeout(run,80);
};
</script>
"""

RESULTS = {}
LOCK = threading.Lock()


def make_handler(root):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=root, **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            if self.path.startswith("/__extract"):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                q = self.path.split("i=", 1)
                idx = int(q[1]) if len(q) > 1 and q[1].isdigit() else -1
                with LOCK:
                    RESULTS[idx] = json.loads(body)
                self.send_response(204); self.end_headers()
            else:
                self.send_response(404); self.end_headers()
    return H


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("No Chrome/Edge found. Add the path to CHROME_CANDIDATES in extract_slides.py.")


def free_port(base=8840):
    for p in range(base, base + 80):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p)); return p
            except OSError:
                continue
    raise SystemExit("no free port")


def count_slides(deck_path):
    """Count slides that belong in the PPT: class has 'slide' but not 'aux' (link-only)
    or 'no-ppt' (author-flagged HTML-only). Must match the harness's filter exactly."""
    html = open(deck_path, encoding="utf-8").read()
    n = 0
    for cls in re.findall(r'class="(slide[^"]*)"', html):
        toks = cls.split()
        if "slide" in toks and "aux" not in toks and "no-ppt" not in toks:
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("deck", help="deck .html path relative to project root (cwd)")
    ap.add_argument("--out", default=None, help="output json (default <deck>.slides.json)")
    ap.add_argument("--slides", default=None, help="comma 0-based indices; default all")
    ap.add_argument("--timeout", type=float, default=25.0, help="seconds to wait per slide")
    a = ap.parse_args()

    root = os.getcwd()
    deck_rel = a.deck.replace("\\", "/")
    deck_abs = os.path.join(root, deck_rel)
    if not os.path.exists(deck_abs):
        raise SystemExit("deck not found: " + deck_abs)
    out_path = os.path.abspath(a.out or (os.path.splitext(deck_abs)[0] + ".slides.json"))

    import hashlib
    deck_sha = hashlib.sha256(open(deck_abs, "rb").read()).hexdigest()
    n = count_slides(deck_abs)
    idxs = [int(x) for x in a.slides.split(",")] if a.slides else list(range(n))
    print("%d slides; extracting %d: %s" % (n, len(idxs), idxs))

    chrome = find_chrome()
    port = free_port()
    fd, harness_abs = tempfile.mkstemp(prefix="_extract_", suffix=".html", dir=root)
    os.close(fd)
    harness_rel = os.path.basename(harness_abs)
    open(harness_abs, "w", encoding="utf-8").write(HARNESS.replace("__DECK__", deck_rel))

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), make_handler(root))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    slides = {}
    import shutil
    ud = tempfile.mkdtemp(prefix="_extract_profile_")
    try:
        for i in idxs:
            with LOCK:
                RESULTS.pop(i, None)
            url = "http://127.0.0.1:%d/%s#%d" % (port, harness_rel, i)
            udi = os.path.join(ud, "p%d" % i)   # unique profile per launch -> no lock contention
            # No --virtual-time-budget: it freezes scripts after the budget elapses, so on
            # cold starts our async measure+POST never fires. We run in real time and end
            # Chrome ourselves once the POST lands (or on timeout).
            cmd = [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                   "--user-data-dir=" + udi, "--window-size=1280,720",
                   "--force-device-scale-factor=1", url]
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.time() + a.timeout
            got = None
            while time.time() < deadline:
                with LOCK:
                    if i in RESULTS:
                        got = RESULTS[i]; break
                time.sleep(0.1)
            try:
                proc.terminate(); proc.wait(timeout=6)   # let Chrome release the profile before the next launch
            except Exception:
                try: proc.kill()
                except Exception: pass
            if got is None:
                print("  FAIL slide %d (timeout)" % i); slides[i] = {"index": i, "error": "timeout"}
            elif got.get("error"):
                print("  FAIL slide %d: %s" % (i, got["error"])); slides[i] = got
            else:
                slides[i] = got
                print("  OK   slide %d: %d elements%s" %
                      (i, len(got.get("elements", [])), "" if got.get("hasId") else "  (no id -> title key)"))
    finally:
        httpd.shutdown()
        try:
            os.remove(harness_abs)
        except OSError:
            pass
        shutil.rmtree(ud, ignore_errors=True)   # Chrome may still hold a few cache files; ignore

    ordered = [slides[i] for i in idxs if i in slides]
    # per-slide content hash (geometry + style + text), stable across runs
    for s in ordered:
        s["hash"] = hashlib.sha256(json.dumps(s.get("elements", []), sort_keys=True).encode()).hexdigest()
    doc = {"deck": deck_rel, "deck_sha": deck_sha, "slides": ordered}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    print("wrote %s (%d slides)" % (out_path, len(ordered)))


if __name__ == "__main__":
    main()
