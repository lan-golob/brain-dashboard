# Brain Dashboard

A local, Jarvis-style dashboard for the `~/lan_brain` Obsidian vault. A live particle orb (the assistant) sits in the centre, with four glass panels around it: today's calendar, open tasks, an inbox overview and the YouTube digest.

```bash
./start.sh
```

That starts the server and opens http://localhost:4747. Use Chrome (or Safari) for voice. Stop it with Ctrl-C.

## How it works

- **Stack:** `server.py` (Python stdlib only) serves `web/` (plain HTML/CSS/JS). three.js comes from a CDN. No build step.
- **Tasks:** every open `- [ ]` checkbox in the vault, grouped by note and read live from the Markdown. Notes with something dated today come first, then the most recently edited. Click a task to open its note in Obsidian. Read-only. Excluded paths are set in `config.json` (`dump/`, `projects/_template/`, and the sales-coach `review-checklist.md`, which is a reusable checklist and not tasks). `.obsidian/` and other dot-folders are always skipped.
- **YouTube digest:** the `## YouTube digest` section of today's `daily/` note, or the latest daily note that has one. Today's pick is shown with its thumbnail.
- **Calendar + inbox:** only reachable through Claude's connectors, so the server runs headless Claude Code (`claude -p`, cwd = the vault) and writes the result to `data/brief.json`. This happens on start if the file is from another day or over an hour old, then hourly while the server runs (06:00–24:00), and whenever you press **Refresh**. One refresh takes about 30–60 seconds.
- **Voice:** hold **space** (or the mic button) and talk. Speech-to-text is the browser's Web Speech API. The text goes to `/api/ask`, which runs `claude -p` in the vault and resumes the same session, so follow-ups work. After 30 minutes idle it starts a fresh conversation, or press "New conversation". The answer is spoken with `speechSynthesis`, using the macOS British voice "Daniel" when available. Press `/` to type instead, and `Esc` to stop it talking.

## Permissions (headless mode)

Both headless runs are read-only, and the CLI enforces this. It isn't left to the prompt:

- `--tools "Read,Grep,Glob"` for voice (no built-in tools at all for the brief refresh). Write, Edit and Bash don't exist in those sessions.
- `--allowedTools` lists only the read-only connector calls: Calendar `list_events`, `list_calendars`, `search_events`, `get_event`, and Gmail `search_threads`, `get_thread`, `get_message`, `list_labels`.
- `--permission-mode dontAsk` denies any other call instead of prompting. Tested: `list_drafts` was denied and no file could be written.

To let it write later (e.g. tick off tasks or draft replies), widen those lists in `server.py` (`ASK_TOOLS`, `BRIEF_TOOLS`) deliberately.

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
