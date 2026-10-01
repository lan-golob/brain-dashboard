#!/usr/bin/env python3
"""Brain Dashboard server: serves web/, parses the vault, and runs headless Claude Code.

Stdlib only. Endpoints:
  GET  /api/tasks    open checkboxes across the vault, grouped by file
  GET  /api/digest   the "## YouTube digest" section of the latest daily note
  GET  /api/brief    data/brief.json (calendar + inbox) plus refresh status
  POST /api/refresh  re-fetch calendar + inbox in the background via `claude -p`
  POST /api/ask      {"text": ...} -> {"reply": ...}, a voice turn via `claude -p`
  POST /api/reset    start a new conversation
"""
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text())
VAULT = Path(os.path.expanduser(os.environ.get("BRAIN_VAULT") or CONFIG["vault"])).resolve()
TZ = ZoneInfo(CONFIG.get("timezone", "Europe/Ljubljana"))
BRIEF_PATH = ROOT / "data" / "brief.json"
CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")

# Tool sets for headless runs. --tools limits which built-in tools exist at all,
# --allowedTools pre-approves these, --disallowedTools carves out exceptions, and
# --permission-mode dontAsk denies anything else instead of prompting.
CAL = "mcp__claude_ai_Google_Calendar__"
GMAIL = "mcp__claude_ai_Gmail__"
BRIEF_TOOLS = [f"{CAL}list_events", f"{CAL}list_calendars", f"{GMAIL}search_threads", f"{GMAIL}get_thread"]
CAL_WRITE = [f"{CAL}create_event", f"{CAL}update_event"]
# Voice: read the vault and edit/create notes inside it (never .obsidian/, .git/,
# .claude/), create and move calendar events, read Gmail. No shell, no sending
# or drafting mail, no deleting events.
ASK_BUILTIN = "Read,Grep,Glob,Edit,Write"
ASK_TOOLS = ["Read", "Grep", "Glob", "Edit(./**)", "Write(./**)",
             f"{CAL}list_events", f"{CAL}list_calendars", f"{CAL}search_events", f"{CAL}get_event",
             f"{CAL}suggest_time", *CAL_WRITE,
             f"{GMAIL}search_threads", f"{GMAIL}get_thread", f"{GMAIL}get_message", f"{GMAIL}list_labels"]
ASK_DENY = [f"{t}(./{d}/**)" for t in ("Edit", "Write") for d in (".obsidian", ".git", ".claude")]


def now():
    return dt.datetime.now(TZ)


def claude(prompt, tools, builtin="", deny=(), session=None, system=None, timeout=240):
    """Run `claude -p` in the vault with a locked-down tool set.

    Returns the final result object, plus "tools_used": the names of the tools it called."""
    cmd = [CLAUDE, "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--permission-mode", "dontAsk",
           "--tools", builtin,
           "--allowedTools", ",".join(tools)]
    if deny:
        cmd += ["--disallowedTools", ",".join(deny)]
    if CONFIG.get("model"):
        cmd += ["--model", CONFIG["model"]]
    if session:
        cmd += ["--resume", session]
    if system:
        cmd += ["--append-system-prompt", system]
    proc = subprocess.run(cmd, cwd=VAULT, capture_output=True, text=True, timeout=timeout)
    out, used = None, []
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            used += [c.get("name") for c in ev.get("message", {}).get("content", []) if c.get("type") == "tool_use"]
        elif ev.get("type") == "result":
            out = ev
    if out is None:
        raise RuntimeError((proc.stderr or proc.stdout or "no output").strip()[-300:])
    out["tools_used"] = used
    if out.get("is_error"):
        raise RuntimeError(str(out.get("result") or out.get("subtype"))[:300])
    return out


# ---------- tasks ----------

TASK_RE = re.compile(r"^(\s*)[-*+] \[ \] (.+)$")
DATE_RE = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")
SKIP_DIRS = {".obsidian", ".git", ".trash", ".claude", "node_modules"}


def note_title(path, text):
    m = re.search(r"^# (.+)$", text, re.M)
    if m:
        return m.group(1).strip()
    return path.parent.name if path.stem.lower() == "readme" else path.stem


def scan_tasks():
    excluded = [e.rstrip("/") for e in CONFIG.get("exclude", [])]
    today = now().date().isoformat()
    groups = []
    for dirpath, dirnames, filenames in os.walk(VAULT):
        rel_dir = Path(dirpath).relative_to(VAULT).as_posix()
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and not d.startswith(".")
                       and (f"{rel_dir}/{d}" if rel_dir != "." else d) not in excluded]
        for name in filenames:
            if not name.endswith(".md"):
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(VAULT).as_posix()
            if rel in excluded:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            tasks, fenced = [], False
            for lineno, line in enumerate(text.splitlines()):
                if line.lstrip().startswith("```"):
                    fenced = not fenced
                    continue
                m = None if fenced else TASK_RE.match(line)
                if m:
                    body = m.group(2).strip()
                    d = DATE_RE.search(body)
                    tasks.append({"text": body, "line": lineno, "indent": len(m.group(1).expandtabs(4)) // 2,
                                  "date": d.group(1) if d else None})
            if tasks:
                groups.append({"file": rel[:-3], "title": note_title(path, text), "tasks": tasks,
                               "today": any(t["date"] == today for t in tasks),
                               "mtime": path.stat().st_mtime})
    # files with something dated today first, then most recently edited
    groups.sort(key=lambda g: (not g["today"], -g["mtime"]))
    for g in groups:
        del g["mtime"], g["today"]
    return {"groups": groups, "total": sum(len(g["tasks"]) for g in groups), "today": today}


TOGGLE_RE = re.compile(r"^(\s*[-*+] \[)([ xX])(\] )(.+?)(\r?\n)?$")


def toggle_task(file, line, text, done):
    """Tick (or untick) one checkbox in a vault note, after checking the line still matches."""
    path = (VAULT / f"{file}.md").resolve()
    rel = path.relative_to(VAULT).as_posix()  # raises if outside the vault
    if any(part.startswith(".") for part in Path(rel).parts):
        raise ValueError("not a vault note")
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    m = TOGGLE_RE.match(lines[line]) if 0 <= line < len(lines) else None
    if not m or m.group(4).strip() != text.strip():
        raise ValueError("the note changed since the dashboard loaded; refresh and try again")
    lines[line] = f"{m.group(1)}{'x' if done else ' '}{m.group(3)}{m.group(4)}{m.group(5) or ''}"
    path.write_text("".join(lines), encoding="utf-8")
    verb = "ticked off" if done else "reopened"
    log(f"{verb}: {text} ({rel})")
    schedule_commit(rel, f"{verb}: {text}")


# ---------- vault commits ----------
# Changes made from the dashboard (ticks, voice edits) are committed and pushed, per
# the vault's CLAUDE.md. Batched: one commit goes out a few seconds after the last change.
# Only the files the dashboard touched are committed; other local changes are left alone.

_commit = {"paths": set(), "notes": [], "timer": None}
_commit_lock = threading.Lock()
COMMIT_DELAY = 8


def git(*args):
    return subprocess.run(["git", *args], cwd=VAULT, capture_output=True, text=True, timeout=120)


def dirty_files():
    """{path: content hash} for changed/new files in the vault, ignoring dot-folders."""
    r = git("status", "--porcelain", "-uall", "-z")
    paths = [e[3:] for e in r.stdout.split("\0") if len(e) > 3 and not e.startswith("D")]
    paths = [p for p in paths if not any(part.startswith(".") for part in p.split("/"))]
    if not paths:
        return {}
    h = git("hash-object", "--", *paths).stdout.split()
    return dict(zip(paths, h))


def schedule_commit(rel_path, note):
    with _commit_lock:
        _commit["paths"].add(rel_path)
        _commit["notes"].append(note)
        if _commit["timer"]:
            _commit["timer"].cancel()
        _commit["timer"] = threading.Timer(COMMIT_DELAY, _commit_worker)
        _commit["timer"].daemon = True
        _commit["timer"].start()


def _commit_worker():
    with _commit_lock:
        paths, notes = sorted(_commit["paths"]), _commit["notes"]
        _commit["paths"], _commit["notes"], _commit["timer"] = set(), [], None
    if not paths:
        return
    # ticking then unticking the same task leaves nothing to commit
    changed = [p for p in paths if git("status", "--porcelain", "--", p).stdout.strip()]
    if not changed:
        return
    subject = f"Dashboard: {notes[0]}" if len(notes) == 1 else f"Dashboard: {len(notes)} changes"
    msg = subject if len(notes) == 1 else subject + "\n\n" + "\n".join(f"- {n}" for n in notes)
    git("add", "--", *changed)
    r = git("commit", "-m", msg, "--", *changed)
    if r.returncode != 0:
        log(f"commit failed: {(r.stdout + r.stderr).strip()[:200]}")
        return
    r = git("pull", "--rebase", "--autostash")
    if r.returncode != 0:
        log(f"pull --rebase failed; commit kept locally, push skipped: {r.stderr.strip()[:200]}")
        git("rebase", "--abort")
        return
    r = git("push")
    log("vault committed and pushed" if r.returncode == 0 else f"push failed: {r.stderr.strip()[:200]}")


# ---------- YouTube digest ----------

PICK_RE = re.compile(
    r"^\*\*Today's pick(?:\s*[—–-]\s*(?P<label>[^:*]+))?:?\*\*:?\s*"
    r"\[(?P<title>[^\]]+)\]\((?P<url>[^)]+)\)\s*(?:\((?P<meta>[^)]*)\))?\.?\s*(?P<text>.*)$", re.S)
YT_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/)([\w-]{11})")


def read_digest():
    today = now().date().isoformat()
    daily = VAULT / "daily"
    files = sorted((p for p in daily.glob("*.md") if p.stem <= today), reverse=True) if daily.exists() else []
    for path in files:
        text = path.read_text(encoding="utf-8")
        m = re.search(r"^## YouTube digest\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
        if not m:
            continue
        section = m.group(1).strip()
        paras = [p.strip() for p in re.split(r"\n\s*\n", section) if p.strip()]
        # drop the "*Pulled via Apify ...*" provenance line
        paras = [p for p in paras if not re.match(r"^\*[^*].*\*$", p, re.S) or "pick" in p.lower()]
        pick, rest = None, []
        for p in paras:
            pm = PICK_RE.match(p) if pick is None else None
            if pm:
                yt = YT_ID_RE.search(pm.group("url"))
                pick = {"label": (pm.group("label") or "Today's pick").strip(),
                        "title": pm.group("title"), "url": pm.group("url"),
                        "meta": pm.group("meta"), "text": pm.group("text").strip(),
                        "video_id": yt.group(1) if yt else None}
            else:
                rest.append(p)
        return {"found": True, "date": path.stem, "is_today": path.stem == today,
                "file": f"daily/{path.stem}", "pick": pick, "rest": "\n\n".join(rest), "raw": section}
    return {"found": False}


# ---------- brief: calendar + inbox ----------

_brief_lock = threading.Lock()
_brief_state = {"refreshing": False, "error": None}


def brief_prompt():
    t = now()
    start = t.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)
    return f"""You are fetching data for Lan's local dashboard. Read-only: never send, draft, label, archive or modify anything.
Now: {t.strftime('%A %Y-%m-%d %H:%M')} (Europe/Ljubljana).

1. Google Calendar: list_events on the primary calendar from {start.isoformat()} to {end.isoformat()}, ordered by start time.
2. Gmail: run search_threads with query "is:unread in:inbox" once, only to read the result-size estimate (don't page through).
   Then search_threads with "in:inbox newer_than:3d -category:promotions -category:social -category:forums" and open threads
   where needed to find the ones that genuinely need Lan: written by a real person, or something he must act on
   (recruiter, prospect, client, business contact, family, a bill or deadline). Skip newsletters, notifications, receipts, marketing.

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{{"calendar": {{"events": [{{"start": "HH:MM" or null, "end": "HH:MM" or null, "all_day": bool, "title": str, "location": str or null, "link": htmlLink or null}}]}},
 "inbox": {{"unread_estimate": int or null, "summary": "one short calm sentence about the inbox today",
            "needs_you": [{{"from": "sender name", "subject": str, "why": "what Lan needs to do, max 10 words", "thread_id": str, "received": "e.g. 09:12, Yesterday or Mon"}}]}}}}
Times are 24h Europe/Ljubljana. At most 5 needs_you entries, most important first; an empty list is fine."""


def refresh_brief():
    with _brief_lock:
        if _brief_state["refreshing"]:
            return False
        _brief_state["refreshing"] = True
    threading.Thread(target=_refresh_worker, daemon=True).start()
    return True


def _refresh_worker():
    try:
        out = claude(brief_prompt(), BRIEF_TOOLS, timeout=300)
        raw = out.get("result", "")
        data = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
        for th in data.get("inbox", {}).get("needs_you", []):
            if th.get("thread_id"):
                th["link"] = f"https://mail.google.com/mail/u/0/#inbox/{th['thread_id']}"
        t = now()
        data["date"] = t.date().isoformat()
        data["updated_at"] = t.isoformat(timespec="seconds")
        BRIEF_PATH.parent.mkdir(exist_ok=True)
        tmp = BRIEF_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        tmp.replace(BRIEF_PATH)
        _brief_state["error"] = None
        log("brief refreshed")
    except Exception as e:  # noqa: BLE001 — surface any failure in the UI
        _brief_state["error"] = str(e)[:300]
        log(f"brief refresh failed: {e}")
    finally:
        _brief_state["refreshing"] = False


def read_brief():
    data = {}
    if BRIEF_PATH.exists():
        try:
            data = json.loads(BRIEF_PATH.read_text())
        except json.JSONDecodeError:
            pass
    data.update(_brief_state)
    data["today"] = now().date().isoformat()
    return data


def brief_age_minutes():
    if not BRIEF_PATH.exists():
        return None
    return (time.time() - BRIEF_PATH.stat().st_mtime) / 60


def auto_refresh_loop():
    every = CONFIG.get("refresh_minutes", 60)
    while True:
        age = brief_age_minutes()
        stale_day = read_brief().get("date") != now().date().isoformat()
        if age is None or age >= every or stale_day:
            if 6 <= now().hour < 24:
                refresh_brief()
        time.sleep(60)


# ---------- voice ----------

VOICE_SYSTEM = """You are Lan's voice assistant on his Brain Dashboard, speaking out loud through text-to-speech.
Answer in a natural spoken style: short (one to three sentences unless he asks for more), no Markdown, no bullet points,
no headings, no URLs, no file paths. Say times like "half past two". Be direct and warm, with a light, dry, Jarvis-like touch.
You can read the vault (Read, Grep, Glob), edit and create notes in it (Edit, Write; follow the vault's CLAUDE.md for where
things go and how they're formatted), look up and create or move Google Calendar events, and read Gmail.
You cannot send, draft or change email, delete events, or run commands; if Lan asks, say so and tell him what you would do.

Changes need his confirmation. Speech recognition mishears, so before ANY edit to a note or ANY calendar create/update:
say back in one sentence exactly what you're about to do (which note or event, what text, which day and time) and ask
"Shall I?". Then stop and make no change in that turn. Only make the change after he clearly says yes in his next turn;
if he corrects you, say the corrected version back again. After making it, confirm briefly ("Done.").
Don't commit or push; the dashboard commits vault changes itself."""

_session = {"id": None, "last": 0.0}
_session_lock = threading.Lock()


def ask(text):
    with _session_lock:
        # a fresh conversation after a long pause keeps context relevant and fast
        if time.time() - _session["last"] > CONFIG.get("conversation_idle_minutes", 30) * 60:
            _session["id"] = None
        t = now()
        prompt = f"[{t.strftime('%A %d %B %Y, %H:%M')} Europe/Ljubljana] {text}"
        before = dirty_files()
        out = claude(prompt, ASK_TOOLS, builtin=ASK_BUILTIN, deny=ASK_DENY,
                     session=_session["id"], system=VOICE_SYSTEM, timeout=240)
        _session["id"] = out.get("session_id") or _session["id"]
        _session["last"] = time.time()
        used = set(out["tools_used"])
        if used & {"Edit", "Write"}:
            # a short reply ("yes", "go ahead") confirms the previous request; name that one
            request = _session.get("prev") if len(text.split()) <= 4 and _session.get("prev") else text
            after = dirty_files()
            for rel in sorted(p for p, h in after.items() if before.get(p) != h):
                schedule_commit(rel, f"voice: {request[:80]}")
        _session["prev"] = text
        if used & set(CAL_WRITE):
            refresh_brief()
        return (out.get("result") or "").strip()


# ---------- HTTP ----------

def log(msg):
    print(f"[{now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "web"), **kw)

    def log_message(self, fmt, *args):
        first = str(args[0]) if args else ""
        if "/api/" in first and not first.startswith("GET"):
            log(fmt % args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        routes = {"/api/tasks": scan_tasks, "/api/digest": read_digest, "/api/brief": read_brief}
        path = self.path.split("?")[0]
        if path in routes:
            try:
                self.send_json(routes[path]())
            except Exception as e:  # noqa: BLE001
                self.send_json({"error": str(e)}, 500)
            return
        super().do_GET()

    def do_POST(self):
        # Only accept requests from the dashboard itself (blocks cross-site POSTs from other pages).
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", origin):
            self.send_json({"error": "forbidden"}, 403)
            return
        path = self.path.split("?")[0]
        if path == "/api/refresh":
            self.send_json({"started": refresh_brief()})
        elif path == "/api/task":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                toggle_task(body["file"], int(body["line"]), body["text"], bool(body.get("done", True)))
                self.send_json({"ok": True})
            except Exception as e:  # noqa: BLE001
                self.send_json({"error": str(e)}, 409)
        elif path == "/api/reset":
            with _session_lock:
                _session["id"] = None
            self.send_json({"ok": True})
        elif path == "/api/ask":
            try:
                length = int(self.headers.get("Content-Length", 0))
                text = json.loads(self.rfile.read(length) or b"{}").get("text", "").strip()
                if not text:
                    self.send_json({"error": "empty"}, 400)
                    return
                log(f"ask: {text}")
                reply = ask(text)
                log(f"reply: {reply}")
                self.send_json({"reply": reply})
            except Exception as e:  # noqa: BLE001
                log(f"ask failed: {e}")
                self.send_json({"error": str(e)}, 500)
        else:
            self.send_json({"error": "not found"}, 404)


def main():
    port = int(os.environ.get("PORT", CONFIG.get("port", 4747)))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    if not os.environ.get("NO_AUTO_REFRESH"):
        threading.Thread(target=auto_refresh_loop, daemon=True).start()
    log(f"Brain Dashboard on http://localhost:{port}  (vault: {VAULT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
