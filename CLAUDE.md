# CLAUDE.md — VSCodium workspace

Guidance for Claude Code working in `/home/irek/Documents/VSCodium/`.

## What's here

| Path | What it is |
|------|------------|
| `claude-usage-statusbar/` | VSCodium extension: shows live Claude Code **Session** (5h) and **Weekly** (7d) usage % in the status bar with colored progress bars. |
| `ClaudeCode_usage_snippet_for_VSCodium.md` | Full design doc for the extension (mockups, colors, data source, embedded code). |
| `market_places` | Plain notes: Claude Code skill marketplace source URLs. |

## The extension (`claude-usage-statusbar/`)

- **Data source:** reads the OAuth token from `~/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`) and calls `GET https://api.anthropic.com/api/oauth/usage`
  with headers `anthropic-beta: oauth-2025-04-20` and `anthropic-version: 2023-06-01`. This is the
  same read-only call Claude Code makes for `/usage`. Parses `five_hour.utilization` (Session) and
  `seven_day.utilization` (Weekly), falling back to the `limits[]` array.
- **Constraints:** plain JavaScript, Node built-ins only (`fs`, `os`, `https`) + the `vscode` API.
  No npm dependencies, no build/transpile step.
- The extension only **reads** credentials; it never writes them. Token refresh is left to Claude
  Code. The token is sent **only** to `api.anthropic.com`.

## Working on this repo

- **No standalone `node` on this machine.** Use the Node runtime bundled with VSCodium:
  ```bash
  ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium --check claude-usage-statusbar/extension.js   # syntax
  ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium claude-usage-statusbar/verify-harness.js       # live check
  ```
- **Validate `package.json`** with `python3 -c "import json;json.load(open('claude-usage-statusbar/package.json'))"`.
- **The installed copy is separate.** The live extension lives at
  `~/.vscode-oss/extensions/claude-usage-statusbar/`. After editing the source here, re-copy and reload:
  ```bash
  cp -r claude-usage-statusbar ~/.vscode-oss/extensions/
  # then in VSCodium: Developer: Reload Window
  ```

## Conventions

- Keep the extension dependency-free and single-file (`extension.js`); no bundlers.
- Never commit secrets. `~/.claude/.credentials.json` is outside this repo; `.gitignore` also blocks
  `*.credentials.json` / `.env` as a safety net.
- Match the existing code style (small pure helpers, 2-space indent).
