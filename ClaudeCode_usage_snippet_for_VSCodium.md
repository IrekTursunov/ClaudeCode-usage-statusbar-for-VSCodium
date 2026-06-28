# Claude Code usage — VSCodium status‑bar snippet

A tiny VSCodium extension that shows **current Claude Code usage** in the status bar for two windows —
**Session** (5h) and **Weekly** (7d) — each as a **percentage** with a **color‑coded progress bar**.
The numbers are the **real** values from Anthropic's usage endpoint — the same data Claude Code's
`/usage` screen shows.

> **v0.2 note — data source changed.** The first version estimated usage from local token logs and
> did **not** match `/usage` (it can't: Anthropic weights models/messages differently than a raw token
> sum). This version reads the **real** percentages from the live usage API instead. The history of
> that investigation is summarized in §4.

---

## 1. Overview & what it shows

Two adjacent items appear at the right side of the VSCodium status bar:

```
…  $(pulse) S 79% ▰▰▰▰▰▰▱   $(calendar) W 70% ▰▰▰▰▰▱▱
```

| Item | Icon | Meaning |
|------|------|---------|
| `S 79% ▰▰▰▰▰▰▱` | `$(pulse)` | **Session** — `five_hour.utilization` (rolling 5‑hour window) |
| `W 70% ▰▰▰▰▰▱▱` | `$(calendar)` | **Weekly** — `seven_day.utilization` (rolling 7‑day window) |

- Each item is colored **independently** by its own percentage (a single status‑bar item can only
  carry one color, so we use two items).
- Hover shows a **tooltip** with the exact percentage and **time until reset** (`resets_at`).
- Click either item to **refresh immediately** (it also auto‑refreshes every 60s).

---

## 2. Status‑bar mockup (color states)

The bar has 7 segments (`▰` filled, `▱` empty). Color escalates with the percentage:

```
  0– 59%   OK         $(pulse) S 41% ▰▰▰▱▱▱▱        green text
 60– 79%   Notice     $(pulse) S 70% ▰▰▰▰▰▱▱        yellow text
 80– 94%   High       $(pulse) S 88% ▰▰▰▰▰▰▱        orange text + warning background
 95%+      Critical   $(pulse) S 98% ▰▰▰▰▰▰▰        red text   + error background
```

(Markdown can't render the colors here; the table in §3 lists the exact theme colors used.)

---

## 3. Color thresholds

Each item picks its color from **its own** percentage. Thresholds are configurable
(`warnThreshold` / `highThreshold` / `criticalThreshold`).

| % range | State | Foreground (`item.color`) | Background (`item.backgroundColor`) |
|---------|-------|----------------------------|--------------------------------------|
| 0–59  | OK       | `charts.green`  | none |
| 60–79 | Notice   | `charts.yellow` | none |
| 80–94 | High     | `charts.orange` | `statusBarItem.warningBackground` |
| 95+   | Critical | `charts.red`    | `statusBarItem.errorBackground` |

> VSCodium only allows `statusBarItem.warningBackground` / `statusBarItem.errorBackground` as status
> bar backgrounds; the foreground uses the built‑in `charts.*` theme colors so it adapts to any theme.

---

## 4. Data source

**Endpoint:** `GET https://api.anthropic.com/api/oauth/usage` — the OAuth endpoint that backs Claude
Code's `/usage` screen. Authenticated with the Bearer token from `~/.claude/.credentials.json`
(`claudeAiOauth.accessToken`), plus headers `anthropic-beta: oauth-2025-04-20` and
`anthropic-version: 2023-06-01`. The token is read locally and sent **only** to `api.anthropic.com` —
the same read‑only call Claude Code itself makes.

**Response shape (relevant fields):**

```json
{
  "five_hour": { "utilization": 79.0, "resets_at": "2026-06-28T14:19:59Z" },
  "seven_day": { "utilization": 70.0, "resets_at": "2026-07-01T14:59:59Z" },
  "limits": [
    { "kind": "session",     "group": "session", "percent": 79, "severity": "normal", "resets_at": "…" },
    { "kind": "weekly_all",  "group": "weekly",  "percent": 70, "severity": "normal", "resets_at": "…" }
  ]
}
```

The extension reads `five_hour.utilization` (Session) and `seven_day.utilization` (Weekly), falling
back to the matching entry in `limits[]` if a block is null.

**Why not the local logs?** Investigation confirmed the real session/weekly percentages are **not**
stored on disk: `~/.claude/settings.json`, `~/.claude.json`, the env vars, and the
`~/.claude/projects/*.jsonl` logs contain **no** rate‑limit fields (only raw `message.usage` token
counts and the account's rate‑limit *tier*). Anthropic computes the percentages server‑side, so the
only way to match `/usage` is to call the endpoint above.

**Auth lifetime.** Claude Code refreshes the OAuth token itself and rewrites `.credentials.json`; this
extension only **reads** it (never writes credentials). If the token is expired and Claude Code isn't
running to refresh it, the items show `—` with a tooltip prompting you to open Claude Code / run
`/usage`.

---

## 5. Rendering logic

1. Read `accessToken` + `expiresAt` from `~/.claude/.credentials.json`.
2. `GET /api/oauth/usage`; on `200`, parse `five_hour` / `seven_day`.
3. `pct = round(utilization)`, render `$(icon) <S|W> <pct>% <bar>` with the color from §3 and a
   tooltip showing the % and `resets_at` countdown.
4. Repeat every `refreshIntervalSeconds` (default 60, min 15) and on demand via `claudeUsage.refresh`.
5. On `401` / network / timeout / parse errors, show a muted `—` state with an explanatory tooltip.

---

## 6. `package.json`

```json
{
  "name": "claude-usage-statusbar",
  "displayName": "Claude Code Usage (status bar)",
  "description": "Shows live Session and Weekly Claude Code usage % (from Anthropic's usage API) with colored progress bars.",
  "version": "0.2.0",
  "publisher": "local",
  "engines": { "vscode": "^1.75.0" },
  "categories": ["Other"],
  "activationEvents": ["*"],
  "main": "./extension.js",
  "contributes": {
    "commands": [
      { "command": "claudeUsage.refresh", "title": "Claude Usage: Refresh" }
    ],
    "configuration": {
      "title": "Claude Code Usage",
      "properties": {
        "claudeUsage.credentialsPath": {
          "type": "string",
          "default": "~/.claude/.credentials.json",
          "description": "Path to the Claude Code OAuth credentials file (read locally; the token is sent only to api.anthropic.com)."
        },
        "claudeUsage.refreshIntervalSeconds": {
          "type": "number",
          "default": 60,
          "description": "How often to poll the usage endpoint (seconds; min 15)."
        },
        "claudeUsage.barSegments": {
          "type": "number",
          "default": 7,
          "description": "Number of segments in each progress bar."
        },
        "claudeUsage.warnThreshold": {
          "type": "number",
          "default": 60,
          "description": "Percent at which the gauge turns yellow."
        },
        "claudeUsage.highThreshold": {
          "type": "number",
          "default": 80,
          "description": "Percent at which the gauge turns orange (warning background)."
        },
        "claudeUsage.criticalThreshold": {
          "type": "number",
          "default": 95,
          "description": "Percent at which the gauge turns red (error background)."
        },
        "claudeUsage.betaHeader": {
          "type": "string",
          "default": "oauth-2025-04-20",
          "description": "Value of the anthropic-beta header required by the OAuth usage endpoint."
        }
      }
    }
  }
}
```

---

## 7. `extension.js`

Plain JavaScript — only Node built‑ins (`fs`, `os`, `https`) plus the `vscode` API. No build step,
no npm install.

```js
// Claude Code usage — VSCodium status bar
// Shows the REAL Session (5h) and Weekly (7d) usage % from Anthropic's usage
// endpoint — the same data Claude Code's /usage screen shows. Reads the OAuth
// token from ~/.claude/.credentials.json and calls GET /api/oauth/usage.
// Node built-ins only (fs, os, https); no npm deps.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const https = require('https');

let sessionItem, weeklyItem, timer;

function getCfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  const home = os.homedir();
  return {
    credentialsPath: (c.get('credentialsPath') || '~/.claude/.credentials.json').replace(/^~(?=$|[/\\])/, home),
    refreshSeconds: c.get('refreshIntervalSeconds', 60),
    segments: c.get('barSegments', 7),
    warn: c.get('warnThreshold', 60),
    high: c.get('highThreshold', 80),
    critical: c.get('criticalThreshold', 95),
    betaHeader: c.get('betaHeader', 'oauth-2025-04-20'),
  };
}

function readToken(cfg) {
  try {
    const o = (JSON.parse(fs.readFileSync(cfg.credentialsPath, 'utf8')).claudeAiOauth) || {};
    return { token: o.accessToken, expiresAt: o.expiresAt || 0 };
  } catch { return { token: null, expiresAt: 0 }; }
}

// GET https://api.anthropic.com/api/oauth/usage with the OAuth bearer token.
function fetchUsage(cfg) {
  return new Promise((resolve) => {
    const { token, expiresAt } = readToken(cfg);
    if (!token) return resolve({ error: 'no-token' });
    if (expiresAt && expiresAt < Date.now()) return resolve({ error: 'auth' });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': cfg.betaHeader,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'claude-usage-statusbar',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 401) return resolve({ error: 'auth' });
        if (res.statusCode !== 200) return resolve({ error: 'http-' + res.statusCode });
        try { resolve({ data: JSON.parse(body) }); } catch { resolve({ error: 'parse' }); }
      });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

// Prefer five_hour/seven_day.utilization; fall back to the limits[] array.
function pick(d, key, group) {
  const block = d[key];
  if (block && typeof block.utilization === 'number') {
    return { pct: block.utilization, reset: block.resets_at };
  }
  const lim = (d.limits || []).find((l) => l.group === group || l.kind === group);
  return lim ? { pct: lim.percent, reset: lim.resets_at } : { pct: null, reset: null };
}

function bar(pct, segments) {
  const filled = Math.max(0, Math.min(segments, Math.round((pct / 100) * segments)));
  return '▰'.repeat(filled) + '▱'.repeat(segments - filled); // ▰ / ▱
}

function colorFor(pct, cfg) {
  if (pct >= cfg.critical) return { color: 'charts.red', bg: 'statusBarItem.errorBackground' };
  if (pct >= cfg.high) return { color: 'charts.orange', bg: 'statusBarItem.warningBackground' };
  if (pct >= cfg.warn) return { color: 'charts.yellow', bg: null };
  return { color: 'charts.green', bg: null };
}

function resetsIn(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  let s = Math.max(0, Math.round((t - Date.now()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderItem(item, icon, label, name, pct, reset, cfg) {
  if (pct == null) {
    item.text = `$(${icon}) ${label} —`;
    item.color = new vscode.ThemeColor('descriptionForeground');
    item.backgroundColor = undefined;
    item.tooltip = `Claude ${name} usage: not reported by the API.`;
    item.show();
    return;
  }
  const p = Math.round(pct);
  const { color, bg } = colorFor(p, cfg);
  item.text = `$(${icon}) ${label} ${p}% ${bar(p, cfg.segments)}`;
  item.color = new vscode.ThemeColor(color);
  item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Claude Code — ${name} usage**\n\n`);
  md.appendMarkdown(`- Used: **${p}%**\n`);
  const r = resetsIn(reset);
  if (r) md.appendMarkdown(`- Resets in: **${r}**\n`);
  md.appendMarkdown('\n_Live from api.anthropic.com/api/oauth/usage. Click to refresh._');
  item.tooltip = md;
  item.show();
}

function showError(kind) {
  const msg = {
    'no-token': 'No Claude credentials found (~/.claude/.credentials.json).',
    'auth': 'Login expired — open Claude Code and run /usage to refresh auth.',
    'network': 'No network connection.',
    'timeout': 'Usage request timed out.',
    'parse': 'Unexpected response from the usage API.',
  }[kind] || ('Usage error: ' + kind);
  for (const [it, ic, lb] of [[sessionItem, 'pulse', 'S'], [weeklyItem, 'calendar', 'W']]) {
    it.text = `$(${ic}) ${lb} —`;
    it.color = new vscode.ThemeColor('descriptionForeground');
    it.backgroundColor = undefined;
    it.tooltip = 'Claude usage unavailable: ' + msg + ' (click to retry)';
    it.show();
  }
}

async function refresh() {
  const cfg = getCfg();
  const r = await fetchUsage(cfg);
  if (r.error) return showError(r.error);
  const s = pick(r.data, 'five_hour', 'session');
  const w = pick(r.data, 'seven_day', 'weekly');
  renderItem(sessionItem, 'pulse', 'S', 'Session', s.pct, s.reset, cfg);
  renderItem(weeklyItem, 'calendar', 'W', 'Weekly', w.pct, w.reset, cfg);
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, Math.max(15, getCfg().refreshSeconds) * 1000);
}

function activate(context) {
  sessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  weeklyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sessionItem.command = weeklyItem.command = 'claudeUsage.refresh';
  context.subscriptions.push(
    sessionItem, weeklyItem,
    vscode.commands.registerCommand('claudeUsage.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) { startTimer(); refresh(); }
    })
  );
  refresh();
  startTimer();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
```

---

## 8. Install & configure

1. Create the folder `claude-usage-statusbar/` containing `package.json` and `extension.js`.
2. Copy it into your VSCodium extensions directory:

   ```
   ~/.vscode-oss/extensions/claude-usage-statusbar/
   ```

3. Run **Developer: Reload Window** in VSCodium. The two items appear at the bottom‑right.
4. Optional tuning in **Settings → Extensions → Claude Code Usage** (`claudeUsage.*`): poll interval,
   bar segments, color thresholds.

**Optional — build a `.vsix`:**

```bash
cd claude-usage-statusbar
npx @vscode/vsce package      # produces claude-usage-statusbar-0.2.0.vsix
# VSCodium → Extensions: Install from VSIX…
```

---

## 9. Optional enhancements

- **Combined‑item mode:** render both gauges in one item if you prefer a single, non‑colored widget.
- **Per‑model weekly:** the endpoint also returns `seven_day_opus` / `seven_day_sonnet` (often null on
  some plans) — add a third item when present.
- **Extra‑usage / spend:** show the `extra_usage` / `spend` blocks when enabled.
- **Reset alerts:** raise a notification when a window crosses a threshold or is about to reset.

---

### Verification performed for this design

- `package.json` parses as valid JSON; `extension.js` and `verify-harness.js` pass a `node --check`
  syntax pass (Node v22 bundled with VSCodium).
- The live endpoint was queried with the real OAuth token and returned `200` with
  `five_hour.utilization` / `seven_day.utilization`; the standalone `verify-harness.js` rendered the
  same Session/Weekly percentages the extension displays (matching Claude Code's `/usage`).
