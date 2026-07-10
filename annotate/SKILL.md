---
name: annotate
description: Start the local "comment-on-element" annotation loop for the current project's HTML so the user can mark up a page in the browser and have the comments applied. Use when the user says things like "start the annotate loop", "let me annotate this page", "annotate blinded_ad_loop.html", "open the annotation server", or when they ask to give visual feedback on an HTML file by clicking elements. A separate trigger ("start actioning", "process my comments", "go") begins the live edit loop. Self-contained: the Python server + browser overlay are bundled in this skill. Sets up on first run, auto-picks a free port, and reuses a server already serving the same project.
---

# Annotate loop

A tiny local Python server gives any HTML page in a project a Claude-style annotation
overlay. The user hovers an element, clicks it, types a comment, and it lands in
`<project>/.annotate/comments.json`. They can also open a **list** pop-up to review, edit, or
delete any comment. Claude applies each open comment to the source HTML. Each comment carries a
**thread**: when Claude actions it, Claude's "what changed" note is appended as a reply; the user
can reply back in the list, which re-opens the comment for another pass. The overlay is injected
on the fly only when served through this tool — committed `.html` files are never modified by the
server.

The skill has **two phases that fire on different triggers**:
- **Serve** ("start the annotate loop") — start the server, hand back the URL, then **go idle**.
  The user may leave the server running for a long time; Claude does nothing until triggered.
- **Action loop** ("start actioning" / "process my comments" / "go") — only *then* does Claude
  begin the live edit loop below.

**Everything ships inside this skill directory** — no external install, nothing in `~/bin`:
- `annotate_server.py` — stdlib HTTP server. Serves a project root, injects the overlay into
  any `.html`, and is the **single writer** of `comments.json`. Auto-selects a free port (scans
  up from 8800), takes `--root`/`--port`, exposes `GET /__info` → `{tool, root, port}` for reuse
  detection, and exposes a cheap change-feed `GET /__poll?since=N`.
- `annotate_overlay.js` — the in-browser overlay (toggle, hover-highlight, comment box, and the
  list/edit/delete manager).

When sharing the skill, copy the whole `annotate/` folder — that's all it needs.

> **Platform note (macOS).** This skill was originally authored on Windows and has been adapted
> for macOS. The bundled `annotate_server.py` and `annotate_overlay.js` are pure, cross-platform
> stdlib and run unchanged. Only the launch/probe commands below were rewritten to use the
> standard macOS toolchain (`python3`, `lsof`, `curl`, plain bash) — all of which ship with macOS.

---

## Phase 1 — launch the server (when invoked)

Run these steps using the standard macOS shell (`python3`, `curl`, and `lsof` are all available).

### 1. Pick the project root and target page
- Root = the directory of the HTML file the user named, else the current working directory.
- Note the page filename (e.g. `blinded_ad_loop.html`) so you can hand back a ready URL.

### 2. Reuse an existing server if it's already serving this project
List local listeners on the 88xx range and probe each for `/__info`:
```bash
# find PIDs/ports listening on 127.0.0.1:88xx
lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN | grep -E '127\.0\.0\.1:88[0-9][0-9]'
# for each PORT found:
curl -s http://127.0.0.1:PORT/__info
```
If an `/__info` response has a `root` that resolves to the **same project** as step 1 (normalize
the path with `realpath` before comparing), that server is already ours — **reuse it**, report its
URL, and skip launching. (Ports that don't answer `/__info`, or answer with a different root, are
left untouched — the server's own free-port scan will avoid them.)

### 3. Otherwise launch a new server (background)
Launch the bundled script in the background, scoped to the project root (the `-u` keeps stdout
unbuffered so the URL appears immediately):
```bash
python3 -u ~/.claude/skills/annotate/annotate_server.py --root "<PROJECT_ROOT>"
```
Run it with `run_in_background: true`. The script prints a line
`ANNOTATE_URL=http://127.0.0.1:<port>/` — read the background task's output and capture that exact
port. It is **8800 only if free**; while another loop holds 8800, this one correctly takes 8801,
etc. Never assume 8800 — always read the port.

### 4. Hand the user a ready-to-click URL and the workflow — then STOP
Tell them, with the real port substituted:
- Open **`http://127.0.0.1:<port>/<page>.html`** in the browser. **Must be this URL, not
  `file://`** — otherwise the overlay's `fetch` calls can't reach the server.
- Click the **off → ON** toggle in the bottom-right bar. Hover (red highlight), click an
  element, type a comment, **save** (or Cmd/Ctrl+Enter). Esc cancels. Toggle **off** to scroll.
  While typing, the keyboard is captured by the comment box (arrows/space/page keys won't
  drive the page) — the mouse still works. Drag a comment box by its **☰** header to reposition it.
- **list** opens the manager pop-up — review every comment (newest/most-recently-active at the
  top), **edit** the text inline, or **delete** one. **Esc** closes the list. Click a row to
  highlight its element **and** expand its thread; a **💬 N** badge marks comments with a thread.
  In an expanded thread you can **reply** to Claude's response — that re-opens the comment so it
  gets another pass, and bubbles it back to the top. (Editing a comment also flips it back to
  *open*; the thread is preserved either way.)
- When ready, say **"start actioning"** and Claude will begin the live loop.

After handing over the URL, **do not start editing or polling.** Stay idle until the user
explicitly triggers the action loop. The server can sit open indefinitely at zero cost.

---

## Phase 2 — the live action loop (only after the user triggers it)

Begin only on an explicit trigger ("start actioning", "process my comments", "go ahead and
apply", etc.). The loop processes **one comment at a time, always re-reading that comment's
current state immediately before actioning it** — never a stale batch snapshot — so the user can
edit/delete/add comments in the browser while Claude edits.

### The loop
1. **Seed the cursor.** `GET /__poll?since=0` → `{rev, open_ids, ...}`. Remember `rev` as your
   cursor and `open_ids` as the current work list (this is your awareness of everything
   outstanding).
2. **Take the next open id.** Pick one id from the work list.
3. **Re-read it fresh, right now:** `GET /__comment?id=<id>`.
   - `404` / empty → the user deleted it. Skip; drop it from the work list.
   - `status == "done"` → already handled. Skip.
   - Otherwise use the **current** `comment` text (the user may have edited it since step 1).
   - **Check `thread`.** If it has entries, this is a follow-up: the user replied to your earlier
     work. Read the whole thread and address the **newest `author:"user"` message** — that's the
     live request. The original `comment` is context; the latest user reply is what to act on now.
4. **Action it** — edit the real source `.html` per the comment. Anchor via `nearest_id`, fall
   back to `selector`, verify with `text_excerpt`. If genuinely ambiguous, ask before editing.
5. **Mark it done through the server** (keeps the server the single writer; do **not** hand-edit
   `comments.json`). The `note` is appended to the thread as your reply — the user sees it when
   they expand the comment and can reply back. Write it as a reply, not just a changelog:
   ```bash
   curl -s -X POST http://127.0.0.1:<port>/__done \
     -H "Content-Type: application/json" \
     -d '{"id": <id>, "note": "<your reply: what you changed / a question back>"}'
   ```
6. **Return to the list.** `GET /__poll?since=<cursor>` to see what moved while you were editing:
   - `changed` ids → re-read and action (covers brand-new comments **and** edits to ones you
     haven't reached yet).
   - `deleted` ids → drop from the work list.
   - Update your work list and set `cursor = rev`.
7. Repeat 2–6 until `open_ids` is empty.

Tell the user briefly what you changed as you go (one line per comment), and remind them to
**refresh** the browser to see edits (the server sends `Cache-Control: no-store`, so a normal
reload is enough).

### Keeping watch while idle (option A — keep checking until told to stop)
When the work list empties, **don't stop** — keep watching so the user can keep commenting
hands-free without re-triggering:
- Poll `GET /__poll?since=<cursor>` on a modest cadence (≈90 s). This is the whole point of the
  change-feed: an idle poll is a one-line response — `{"rev":N,"changed":[],"deleted":[],
  "open_ids":[],"open_total":0}` — so watching costs almost nothing in context. Only when
  `changed` is non-empty do you fetch full comments (step 3) and resume the loop.
- **Stop only when the user says so** ("stop", "stop actioning", "done", "that's enough"). On
  stop, do not reschedule. Report a short summary of what was actioned.
- Backstop: if you prefer not to keep a wakeup pending, you may instead tell the user "caught up —
  say go when there's more" and stop. Default to the keep-watching behavior unless they opt out.

### Offline fallback (server not running)
If the user wants comments applied with no server up, read `<project>/.annotate/comments.json`
directly, action every entry with `status == "open"`, and write back `status: "done"` +
`addressed_at` + `note` (preserving the file's formatting). Don't clear the file — keep the
paper trail. This is the only case where Claude writes the file directly.

---

## `comments.json` entry shape
```json
{
  "id": 7,
  "page": "/blinded_ad_loop.html",
  "selector": "#stage > svg:nth-of-type(1)",
  "nearest_id": "stage",
  "tag": "svg",
  "text_excerpt": "...",
  "comment": "make the itch node larger",
  "status": "open",
  "rev": 12,
  "timestamp": "2026-06-10T14:03:11"
}
```
`id` is stable; `rev` bumps every time the comment is touched (post/edit/delete/done) and powers
`/__poll`. After actioning, the entry also gets `addressed_at` and `note`; an edited entry gets
`edited_at` and reverts to `status: "open"`.

## Server endpoints
- `GET /__info` → `{tool, root, port}` (reuse detection).
- `GET /__comments` → full list. `GET /__comment?id=N` → one comment (404 if gone).
- `GET /__poll?since=N` → `{rev, changed:[ids], deleted:[ids], open_ids:[ids], open_total}`. A
  `since` ahead of `rev` (server restarted) forces a full resync (everything reported changed).
- `POST /__comment` (browser) · `POST /__update {id,comment}` · `POST /__delete {id}` ·
  `POST /__done {id,note}` (Claude) · `POST /__clear?mode=done|all`.

## Notes & knobs
- **Free-port scan.** With no `--port`, the server binds the first free port from 8800 upward.
  Pass `--port N` to force one.
- **One server per project, many pages.** Every comment carries a `page` field, so annotating
  several pages of the same project all flows into one `comments.json`.
- **Each project is isolated.** `--root` (or the launch cwd) determines where `.annotate/` lives.
- **Self-gitignoring.** On first run the server writes `.annotate/.gitignore` (`*` + `!.gitignore`).
- **Single writer.** While the server runs, mutate comments only through endpoints — the rev
  feed and the file stay in sync, and there's no read-modify-write race against the browser.
- **Editing the overlay/server.** Both are read once at server start. After changing either,
  restart the server (kill the process, relaunch).
- **Stopping a server.** Find the PID with `lsof -nP -iTCP@127.0.0.1:<port> -sTCP:LISTEN`, then
  `kill <PID>` (use `kill -9 <PID>` if it doesn't exit).
- **copy fallback.** The overlay bar's **copy** link puts all open comments on the clipboard as
  markdown — useful if the user would rather paste them than have Claude read the file.
