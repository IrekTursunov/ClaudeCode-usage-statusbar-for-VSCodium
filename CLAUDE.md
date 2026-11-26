# CLAUDE.md — claude-usage-statusbar extension

Guidance for Claude Code working in this repo. **The repo root *is* the VSCodium extension**
(restructured in v0.3.x — there is no longer a `claude-usage-statusbar/` subfolder).

## What this is

A VSCodium extension that shows live Claude Code **Session** (5h) and **Weekly** (7d) usage % in the
status bar with colored progress bars and a resets-in sand-timer gauge. Current version: **v0.7.0**.

- `extension.js` — the entire extension (single file, see Conventions).
- `package.json` — manifest.
- `verify-harness.js` — standalone live check of the usage endpoint.
- `MEMORY.md` — durable design notes & decisions (endpoint details, abandoned approaches, behaviors).

## Data source

Reads the OAuth token from `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) and calls
`GET https://api.anthropic.com/api/oauth/usage` with headers `anthropic-beta: oauth-2025-04-20` and
`anthropic-version: 2023-06-01` — the same read-only call Claude Code makes for `/usage`. Parses
`five_hour.utilization` (Session) and `seven_day.utilization` (Weekly), falling back to the
`limits[]` array. Transient failures (429/network/timeout/5xx) keep the last good values visible with
a greyed stale spinner; 429s trigger a backoff. See MEMORY.md for the full behavior.

- The extension only **reads** credentials; it never writes them. Token refresh is left to Claude
  Code. The token is sent **only** to `api.anthropic.com`.

## Working on this repo

- **No standalone `node` on this machine.** Use the Node runtime bundled with VSCodium:
  ```bash
  ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium --check extension.js      # syntax
  ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium verify-harness.js          # live check
  ```
- **Validate `package.json`** with `python3 -c "import json;json.load(open('package.json'))"`.
- **The installed copy is separate.** The live extension lives at
  `~/.vscode-oss/extensions/claude-usage-statusbar/`. After editing here, re-copy and reload:
  ```bash
  # Exclude .git — its pack objects are read-only and break a plain cp -r.
  rsync -a --exclude .git ./ ~/.vscode-oss/extensions/claude-usage-statusbar/
  # then in VSCodium: Developer: Reload Window
  ```

## Git

- `origin` → fork `GayratTursunov/...`; `upstream` → `IrekTursunov/...`. Work on feature branches,
  push to origin, PR to upstream.

## Conventions

- Keep the extension dependency-free and single-file (`extension.js`); no bundlers, no build/transpile
  step — plain JavaScript, Node built-ins only (`fs`, `os`, `https`) + the `vscode` API.
- Never commit secrets. `~/.claude/.credentials.json` is outside this repo; `.gitignore` also blocks
  `*.credentials.json` / `.env` as a safety net.
- Match the existing code style (small pure helpers, 2-space indent).
