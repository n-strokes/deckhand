#!/usr/bin/env python3
"""Local annotation server for Claude Code.

Serves a project directory. For any .html file it injects a comment overlay
before </body>. Collects element-anchored comments into .annotate/comments.json
(in the project root). Pure stdlib, no dependencies.

Usage:
    python annotate_server.py [--root DIR] [--port N] [--base-port N]

  --root Project root to serve (default: current working directory).
               comments.json is written to <root>/.annotate/.
  --port Force a specific port (errors if busy).
  --base-port First port to try when auto-selecting (default 8800).

If --port is omitted the server scans upward from --base-port for the first
free port, so it never collides with another server already running.
On start it prints a line beginning "ANNOTATE_URL=" for easy capture, and
exposes GET /__info -> {"tool","root","port"} so a launcher can tell which
project a running server is serving (this powers "reuse if it's mine").

Each comment carries a stable integer `id` and a `rev` (the revision at which
it was last touched). A monotonic server-wide revision counter lets clients
ask "what changed since rev N?" cheaply via GET /__poll?since=N instead of
re-reading the whole file — this keeps the action-loop's idle polling light.
The server is the single writer of comments.json; all mutations go through
endpoints (/__comment, /__update, /__delete, /__done, /__clear) under a lock.
"""
import argparse
import datetime
import http.server
import json
import os
import socket
import socketserver
import threading
import urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OVERLAY_PATH = os.path.join(SCRIPT_DIR, "annotate_overlay.js")

with open(OVERLAY_PATH, "r", encoding="utf-8") as _f:
    OVERLAY = "\n<script>\n" + _f.read() + "\n</script>\n"

# One lock guards every read-modify-write of comments.json and the rev counter,
# because ThreadingTCPServer dispatches each request on its own thread.
LOCK = threading.Lock()

def read_comments(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def write_comments(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def open_count(data):
    return sum(1 for c in data if c.get("status") != "done")

def max_id(data):
    return max((int(c.get("id", 0)) for c in data), default=0)

def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")

def normalize(data):
    """Backfill id/rev/status/thread on any pre-existing comments so older files
    (and files shared from another machine) work with edit/delete/poll/reply.
    Returns (data, changed, max_rev)."""
    changed = False
    rid = max_id(data)
    rev = max((int(c.get("rev", 0)) for c in data), default=0)
    for c in data:
        if "id" not in c:
            rid += 1
            c["id"] = rid
            changed = True
        if "status" not in c:
            c["status"] = "open"
            changed = True
        if "rev" not in c:
            rev += 1
            c["rev"] = rev
            changed = True
        # Threads supersede the old single `note`. Fold any legacy note into the
        # thread as Claude's first reply, then drop the note key for good.
        if "thread" not in c:
            note = c.pop("note", None)
            if note:
                c["thread"] = [{"author": "claude", "text": note,
                                "ts": c.get("addressed_at") or c.get("timestamp")}]
            else:
                c["thread"] = []
            changed = True
        elif "note" in c:
            note = c.pop("note")
            if note:
                c["thread"].append({"author": "claude", "text": note,
                                    "ts": c.get("addressed_at")})
            changed = True
    return data, changed, rev

def find_free_port(base, span=80):
    # NOTE: do NOT set SO_REUSEADDR here. On Windows SO_REUSEADDR lets bind()
    # succeed on a port another process is already listening on, which would
    # make us report a busy port as "free" and then double-bind it. A plain
    # bind correctly raises OSError for a taken port on every platform.
    for p in range(base, base + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit(f"no free port in {base}..{base + span}")

def make_handler(root, comments_file, port_box, state):
    # state: {"rev": int, "deleted": [{"id": int, "rev": int}, ...]}
    def bump_rev():
        state["rev"] += 1
        return state["rev"]

    def find(data, cid):
        for c in data:
            if int(c.get("id", -1)) == cid:
                return c
        return None

    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-store") # always serve fresh
            super().end_headers()

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _id_param(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return int(q.get("id", [None])[0])
            except (TypeError, ValueError):
                return None

        def _body_json(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            try:
                return json.loads(raw or b"{}")
            except Exception:
                return {}

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/__info":
                return self._json({"tool": "claude-annotate", "root": root, "port": port_box[0]})
            if parsed.path == "/__comments":
                with LOCK:
                    return self._json(read_comments(comments_file))
            if parsed.path == "/__comment":
                cid = self._id_param()
                with LOCK:
                    c = find(read_comments(comments_file), cid) if cid is not None else None
                return self._json(c or {}, 200 if c else 404)
            if parsed.path == "/__poll":
                # Cheap change-feed: tell the client only what moved since `since`.
                q = urllib.parse.parse_qs(parsed.query)
                try:
                    since = int(q.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                with LOCK:
                    data = read_comments(comments_file)
                    rev = state["rev"]
                    # A cursor ahead of our rev means the server restarted; force
                    # a full resync by treating everything as changed.
                    if since > rev:
                        since = -1
                    changed = [int(c["id"]) for c in data if int(c.get("rev", 0)) > since]
                    deleted = [d["id"] for d in state["deleted"] if d["rev"] > since]
                    open_ids = [int(c["id"]) for c in data if c.get("status") != "done"]
                    return self._json({
                        "rev": rev,
                        "changed": changed,
                        "deleted": deleted,
                        "open_ids": open_ids,
                        "open_total": len(open_ids),
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

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)

            if parsed.path == "/__comment":
                payload = self._body_json()
                with LOCK:
                    data = read_comments(comments_file)
                    payload["id"] = max_id(data) + 1
                    payload["status"] = "open"
                    payload["timestamp"] = now_iso()
                    payload["rev"] = bump_rev()
                    data.append(payload)
                    write_comments(comments_file, data)
                    return self._json({"ok": True, "id": payload["id"], "count": open_count(data)})

            if parsed.path == "/__update":
                payload = self._body_json()
                cid = payload.get("id")
                text = (payload.get("comment") or "").strip()
                with LOCK:
                    data = read_comments(comments_file)
                    c = find(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    if text:
                        c["comment"] = text
                    # An edited comment becomes open again so it gets re-actioned,
                    # even if Claude had already marked it done. The thread (prior
                    # replies) is preserved — editing only revises the user's
                    # original point, it doesn't reset the conversation.
                    c["status"] = "open"
                    c.pop("addressed_at", None)
                    c["edited_at"] = now_iso()
                    c["rev"] = bump_rev()
                    write_comments(comments_file, data)
                    return self._json({"ok": True, "count": open_count(data)})

            if parsed.path == "/__delete":
                payload = self._body_json()
                cid = payload.get("id")
                with LOCK:
                    data = read_comments(comments_file)
                    c = find(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    data = [x for x in data if int(x.get("id", -1)) != int(cid)]
                    state["deleted"].append({"id": int(cid), "rev": bump_rev()})
                    write_comments(comments_file, data)
                    return self._json({"ok": True, "count": open_count(data)})

            if parsed.path == "/__done":
                # Claude marks a comment actioned through here (server stays the
                # single writer, so the rev feed and the file never disagree).
                payload = self._body_json()
                cid = payload.get("id")
                note = payload.get("note")
                with LOCK:
                    data = read_comments(comments_file)
                    c = find(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    c["status"] = "done"
                    c["addressed_at"] = now_iso()
                    if note:
                        c.setdefault("thread", []).append(
                            {"author": "claude", "text": note, "ts": now_iso()})
                    c["rev"] = bump_rev()
                    write_comments(comments_file, data)
                    return self._json({"ok": True, "count": open_count(data)})

            if parsed.path == "/__reply":
                # The user replies to a comment's thread. Appends their message
                # and re-opens the comment so the action loop picks it back up,
                # WITHOUT disturbing the existing thread (history accumulates).
                payload = self._body_json()
                cid = payload.get("id")
                text = (payload.get("text") or "").strip()
                with LOCK:
                    data = read_comments(comments_file)
                    c = find(data, int(cid)) if cid is not None else None
                    if not c:
                        return self._json({"ok": False, "error": "not found"}, 404)
                    if not text:
                        return self._json({"ok": False, "error": "empty"}, 400)
                    c.setdefault("thread", []).append(
                        {"author": "user", "text": text, "ts": now_iso()})
                    c["status"] = "open"
                    c.pop("addressed_at", None)
                    c["rev"] = bump_rev()
                    write_comments(comments_file, data)
                    return self._json({"ok": True, "count": open_count(data)})

            if parsed.path == "/__clear":
                params = urllib.parse.parse_qs(parsed.query)
                mode = params.get("mode", ["done"])[0]
                with LOCK:
                    data = read_comments(comments_file)
                    if mode == "all":
                        removed = [int(c.get("id", -1)) for c in data]
                        keep = []
                    else:
                        removed = [int(c.get("id", -1)) for c in data if c.get("status") == "done"]
                        keep = [c for c in data if c.get("status") != "done"]
                    for rid in removed:
                        state["deleted"].append({"id": rid, "rev": bump_rev()})
                    write_comments(comments_file, keep)
                    return self._json({"ok": True, "count": open_count(keep)})

            self.send_error(404)

        def log_message(self, *args):
            pass # quiet

    return Handler

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.getcwd())
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--base-port", type=int, default=8800)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    annotate_dir = os.path.join(root, ".annotate")
    comments_file = os.path.join(annotate_dir, "comments.json")
    gitignore_file = os.path.join(annotate_dir, ".gitignore")

    os.makedirs(annotate_dir, exist_ok=True)
    if not os.path.exists(gitignore_file):
        with open(gitignore_file, "w", encoding="utf-8") as g:
            g.write("*\n!.gitignore\n")

    # Backfill id/rev/status on any existing comments and seed the rev counter.
    data, changed, max_rev = normalize(read_comments(comments_file))
    if changed:
        write_comments(comments_file, data)
    state = {"rev": max_rev, "deleted": []}

    os.chdir(root)
    port = args.port if args.port else find_free_port(args.base_port)
    port_box = [port]

    # Only enable address reuse on POSIX. On Windows it permits two servers to
    # bind the same port simultaneously, which silently splits traffic.
    socketserver.ThreadingTCPServer.allow_reuse_address = (os.name == "posix")
    handler = make_handler(root, comments_file, port_box, state)
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        # flush=True so a launcher reading piped stdout sees the URL immediately
        # (without it, block-buffering hides these lines until the buffer fills).
        print(f"ANNOTATE_URL=http://127.0.0.1:{port}/", flush=True)
        print(f"Annotate server: http://127.0.0.1:{port}/<http://127.0.0.1:%7bport%7d/>", flush=True)
        print(f"Project root: {root}", flush=True)
        print(f"Comments file: {comments_file}", flush=True)
        print(f"Open a page, e.g. http://127.0.0.1:{port}/<your-file>.html<http://127.0.0.1:%7bport%7d/%3cyour-file%3e.html>", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")

if __name__ == "__main__":
    main()
