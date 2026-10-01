# Brain Dashboard

A local, Jarvis-style dashboard for the `~/lan_brain` Obsidian vault. A live particle orb (the assistant) sits in the centre, with four glass panels around it: today's calendar, open tasks, an inbox overview and the YouTube digest.

```bash
./start.sh
```

That starts the server and opens http://localhost:4747. Use Chrome (or Safari) for voice. Stop it with Ctrl-C.

### Desktop app

`app/build.sh` builds `/Applications/Brain.app` (with the orb icon from `app/make_icon.py`). Opening it starts the server in the background if it isn't running, then opens the dashboard in its own Chrome app window, with no tabs and no address bar. It uses Chrome and not Electron or a WebKit wrapper because the free voice input (Web Speech API) only works in a real browser. The server keeps running after you close the window, so reopening is instant. `./stop.sh` stops it. Server log: `~/Library/Logs/brain-dashboard.log`. Rebuild after moving the repo, because the app has the repo path built in.

## How it works

- **Stack:** `server.py` (Python stdlib only) serves `web/` (plain HTML/CSS/JS). three.js comes from a CDN. No build step.
- **Tasks:** every open `- [ ]` checkbox in the vault, grouped by note and read live from the Markdown. Notes with something dated today come first, then the most recently edited. Click the checkbox to tick it off: the server writes `[x]` into that line of the note (after checking the line hasn't changed). The row fades out after a moment, and clicking again before then reopens it. Click the text to open the note in Obsidian. Ticks are committed and pushed automatically (see Permissions). Excluded paths are set in `config.json` (`dump/`, `projects/_template/`, and the sales-coach `review-checklist.md`, which is a reusable checklist and not tasks). `.obsidian/` and other dot-folders are always skipped.
- **YouTube digest:** the `## YouTube digest` section of today's `daily/` note, or the latest daily note that has one. Today's pick is shown with its thumbnail.
- **Calendar + inbox:** only reachable through Claude's connectors, so the server runs headless Claude Code (`claude -p`, cwd = the vault) and writes the result to `data/brief.json`. This happens on start if the file is from another day or over an hour old, then hourly while the server runs (06:00–24:00), and whenever you press **Refresh**. One refresh takes about 30–60 seconds.
- **Voice:** hold **space** (or the mic button) and talk. The page shows no hints for this. Speech-to-text is the browser's Web Speech API. The text goes to `/api/ask`, which runs `claude -p` in the vault and resumes the same session, so follow-ups work. After 30 minutes idle it starts a fresh conversation, or press "New conversation". The answer is spoken with `speechSynthesis`, using the macOS British voice "Daniel" when available. Press `/` to type instead, and `Esc` to stop it talking.

## Permissions (headless mode)

The CLI flags enforce what each headless run can do, so it doesn't depend on the prompt. `--permission-mode dontAsk` denies anything not explicitly allowed instead of prompting.

| | Brief refresh | Voice |
|---|---|---|
| Built-in tools (`--tools`) | none | `Read, Grep, Glob, Edit, Write` |
| Files | — | edit/create inside the vault only (`Edit(./**)`, `Write(./**)`), never `.obsidian/`, `.git/`, `.claude/` |
| Calendar | `list_events`, `list_calendars` | read + `suggest_time`, `create_event`, `update_event` (no delete) |
| Gmail | `search_threads`, `get_thread` | read only (`search_threads`, `get_thread`, `get_message`, `list_labels`): no drafts, no sending |
| Shell | no | no |

- **Say it back first:** the voice prompt makes Claude repeat every note edit or calendar change and wait for your "yes" in the next turn before doing it. This is an instruction, not a technical lock. Note edits can be undone with git, but calendar changes can't, so listen to the read-back.
- **Commits:** the server commits vault changes made from the dashboard (checkbox ticks and voice edits), runs `git pull --rebase --autostash`, and pushes, per the vault's CLAUDE.md. Commits are batched about 8 seconds after the last change. Only the files the dashboard touched are committed; your other local changes are left alone. If the rebase fails, the commit stays local and the log says so.
- Tested against a throwaway copy of the vault: writes to `/tmp` and `.obsidian/` were refused, and a Gmail draft call was denied.
- To change what voice can do, edit `ASK_TOOLS` / `ASK_DENY` in `server.py`.

The server binds to `127.0.0.1` only and rejects POSTs from other origins.

## Notes

- **Speech recognition is not local.** Chrome sends the audio to Google and Safari sends it to Apple. The rest stays on the machine (apart from Claude itself).
- **Latency:** a voice answer takes about 8–30 s, depending on how many lookups it needs. Setting `"model": "sonnet"` in `config.json` makes it faster.
- **Themes:** Ember (default) and Blue. Switch with the two dots top right. The choice is remembered in localStorage.
- **Optional upgrade:** ElevenLabs for a more natural "Jarvis" voice (paid). It would replace `speak()` in `web/app.js`.

## Files

```
server.py        API + static server, vault parsing, headless Claude runs
config.json      vault path, port, model, refresh interval, excluded paths
start.sh         one-command start
web/index.html   layout
web/style.css    themes + glass panels
web/app.js       data panels, push-to-talk, speech
web/orb.js       three.js particle orb (shell, ribbons, dust, bloom)
data/brief.json  latest calendar + inbox snapshot (git-ignored)
reference/       the design reference images
```
