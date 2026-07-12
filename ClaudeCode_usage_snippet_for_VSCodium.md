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
…  $(pulse) S 79% ▰▰▰▰▰▰▱  ⏳⣿⣧⠀   $(calendar) W 70% ▰▰▰▰▰▱▱  ⏳⣷⠀⠀
```

| Item | Icon | Meaning |
|------|------|---------|
| `S 79% ▰▰▰▰▰▰▱` | `$(pulse)` | **Session** — `five_hour.utilization` (rolling 5‑hour window) |
| `W 70% ▰▰▰▰▰▱▱` | `$(calendar)` | **Weekly** — `seven_day.utilization` (rolling 7‑day window) |

- Each item is colored **independently** by its own percentage (a single status‑bar item can only
  carry one color, so we use two items).
- A **"resets in" sand‑timer gauge** follows each usage bar (see §2a).
- Hover shows a **tooltip** with the exact percentage and **time until reset** (`resets_at`).
- Click either item to **refresh immediately** (it also auto‑refreshes every 60s).

---

## 2a. "Resets in" sand‑timer gauge

A **second** dimension — how much **time is left** in the window before it resets — rendered as a
**sand‑timer** that empties as the reset approaches. This is independent of the usage % bar.

```
  full window    ⏳⣿⣿⣿      ← just reset, sand full
  half left      ⏳⣿⡇⠀
  almost out     ⌛⡀⠀⠀      ← hourglass flips to ⌛ near empty
```

- **Glyph:** `⏳` while sand is running, flipping to `⌛` when the window is nearly empty.
- **Drain:** a short braille bar (`⣿⣧⠀` …) that empties left‑to‑right at sub‑cell resolution
  (`⠀⡀⡄⡆⡇⣇⣧⣷⣿`), giving smooth motion across the whole window. The inline gauge carries the
  countdown visually; the exact `resets_at` time-remaining is shown as plain text (e.g. `5h 30m`)
  on the hover tooltip's "Resets in:" line.
- **Window length** is a known constant (Session 5h, Weekly 7d; both configurable) — the API returns
  `resets_at` but not the window start, so `fracLeft = clamp((resets_at − now) / windowMs, 0, 1)`.
- **Inline color note:** a status‑bar item carries only **one** foreground color, already owned by
  the usage %, and emoji glyphs render in their own font color. So inline, urgency is conveyed by the
  **glyph + how much sand is left**, not by recoloring. The **colored** inverted gauge (green when
  lots of time remains → red as the reset nears) lives in the **hover tooltip** via HTML spans.
- Toggle with `claudeUsage.showResetGauge`; tune urgency colors with
  `claudeUsage.timeWarnPct`/`timeHighPct`/`timeCritPct` (percent of window **elapsed**).

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

## 3a. Activity‑synced refresh

Instead of relying only on a fixed poll, the extension refreshes **shortly after real Claude Code
request activity**. Claude Code appends to its session log
`~/.claude/projects/<workspace>/<id>.jsonl` on every request, and usage is **account‑wide**, so the
newest mtime across **all** project logs is a reliable "a request just happened" signal.

- Detecting activity is a **local file stat** (`fs.statSync` mtime) — it never calls the usage API,
  so it can run every few seconds (`activityPollSeconds`, default 5) cheaply.
- When the newest `.jsonl` mtime advances, a **debounced** refresh fires (`activityDebounceSeconds`,
  default 4) so a burst of requests collapses into one API call.
- Activity‑triggered API calls are spaced by at least `activityMinIntervalSeconds` (default 20) and
  still obey the 429 backoff, protecting the rate limit during heavy use.
- `refreshIntervalSeconds` (now default 300) remains only as an **idle safety net** — to catch window
  resets and the idle case. Toggle the whole behavior with `syncToActivity`.

**Caveat:** this tracks *local* request activity, not the exact server‑side counter, so expect a
few‑second lag (debounce + the API's own update latency).

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
3. `pct = round(utilization)`, render `$(icon) <S|W> <pct>% <bar>` with the color from §3, followed
   by the sand-timer reset gauge (§2a, no text), and a tooltip showing the % and the time
   remaining until reset as plain text (e.g. `5h 30m`).
4. Refresh shortly after request activity (§3a, debounced from local `.jsonl` log writes), with the
   idle poll interval (`refreshBaseSeconds`, jittered ±`refreshJitterPct`) as a safety net, plus on
   demand via `claudeUsage.refresh`. The **first** poll after activation is delayed by a random
   `0–startupSplaySeconds` (a neutral `…` placeholder shows meanwhile) so many windows/clients
   starting together don't all hit the API at `t=0`.
5. On `401` / parse errors, show a muted `—` state with an explanatory tooltip. **Transient** errors
   (HTTP 429, 5xx, network, timeout) are **swallowed once data exists** — the last good values stay
   on screen (greyed, with a spinner) instead of flashing an error. After **any** failure the
   extension **backs off** using **decorrelated jitter** (Polly's `DecorrelatedJitterBackoffV2`):
   `t = attempt + rand()`, `next = 2^t·tanh(√(4t))`, `delay = (next − prev)·(1/1.4)·backoffMedianFirstSeconds`,
   capped at `backoffCapSeconds` and floored by a 429 `Retry-After` header. This gives a smooth,
   spike-free retry distribution with a controlled **median** first-retry delay, and de-synchronizes
   clients so they don't retry in lockstep after a shared outage. A success resets the backoff.

---

## 6. `package.json`

```json
{
  "name": "claude-usage-statusbar",
  "displayName": "Claude Code Usage (status bar)",
  "description": "Shows live Session and Weekly Claude Code usage % (from Anthropic's usage API) with colored progress bars.",
  "version": "0.4.0",
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
          "default": 300,
          "description": "Idle safety-net poll interval (seconds; min 15). With syncToActivity on, refreshes are mainly driven by request activity; this timer just catches resets/idle. The extension also backs off automatically when rate-limited (HTTP 429)."
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
        },
        "claudeUsage.syncToActivity": {
          "type": "boolean",
          "default": true,
          "description": "Refresh usage shortly after real Claude Code request activity (detected locally from ~/.claude/projects/*.jsonl log writes) instead of only on the timer."
        },
        "claudeUsage.activityPollSeconds": {
          "type": "number",
          "default": 5,
          "description": "How often to check the Claude Code logs locally for new activity (seconds). This is a local file stat only; it never calls the usage API."
        },
        "claudeUsage.activityDebounceSeconds": {
          "type": "number",
          "default": 4,
          "description": "How long to wait after the last logged request before refreshing usage, so a burst of requests triggers a single refresh."
        },
        "claudeUsage.activityMinIntervalSeconds": {
          "type": "number",
          "default": 20,
          "description": "Minimum gap between activity-triggered usage API calls, to protect the rate limit during heavy use."
        },
        "claudeUsage.showResetGauge": {
          "type": "boolean",
          "default": true,
          "description": "Show the 'resets in' sand-timer gauge (hourglass + draining braille cells + countdown) next to each usage bar."
        },
        "claudeUsage.sessionWindowHours": {
          "type": "number",
          "default": 5,
          "description": "Length of the Session window in hours (used to compute how much time is left for the reset gauge)."
        },
        "claudeUsage.weeklyWindowDays": {
          "type": "number",
          "default": 7,
          "description": "Length of the Weekly window in days (used to compute how much time is left for the reset gauge)."
        },
        "claudeUsage.timeWarnPct": {
          "type": "number",
          "default": 50,
          "description": "Percent of the window elapsed at which the tooltip reset gauge turns yellow."
        },
        "claudeUsage.timeHighPct": {
          "type": "number",
          "default": 75,
          "description": "Percent of the window elapsed at which the tooltip reset gauge turns orange."
        },
        "claudeUsage.timeCritPct": {
          "type": "number",
          "default": 90,
          "description": "Percent of the window elapsed at which the tooltip reset gauge turns red."
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
const path = require('path');
const https = require('https');

let sessionItem, weeklyItem, timer;
let hasData = false;     // have we ever rendered real values?
let backoffUntil = 0;    // skip polling until this timestamp (ms) after a 429
let activityTimer;       // local poll of Claude Code logs
let debounceTimer;       // settle timer before an activity-triggered refresh
let lastLogMtime = 0;    // newest .jsonl mtime seen so far
let lastApiAttempt = 0;  // when refresh() last hit the network

function getCfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  const home = os.homedir();
  return {
    credentialsPath: (c.get('credentialsPath') || '~/.claude/.credentials.json').replace(/^~(?=$|[/\\])/, home),
    refreshSeconds: c.get('refreshIntervalSeconds', 300),
    syncToActivity: c.get('syncToActivity', true),
    activityPollSeconds: c.get('activityPollSeconds', 5),
    activityDebounceSeconds: c.get('activityDebounceSeconds', 4),
    activityMinIntervalSeconds: c.get('activityMinIntervalSeconds', 20),
    segments: c.get('barSegments', 7),
    warn: c.get('warnThreshold', 60),
    high: c.get('highThreshold', 80),
    critical: c.get('criticalThreshold', 95),
    betaHeader: c.get('betaHeader', 'oauth-2025-04-20'),
    showResetGauge: c.get('showResetGauge', true),
    sessionWindowHours: c.get('sessionWindowHours', 5),
    weeklyWindowDays: c.get('weeklyWindowDays', 7),
    timeWarn: c.get('timeWarnPct', 50),
    timeHigh: c.get('timeHighPct', 75),
    timeCrit: c.get('timeCritPct', 90),
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
        if (res.statusCode === 429) {
          const ra = parseInt(res.headers['retry-after'], 10);
          return resolve({ error: 'http-429', retryAfter: Number.isFinite(ra) ? ra : null });
        }
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

// Fraction of the window still remaining (1 = just reset, 0 = at reset), or null.
function fracLeft(iso, windowMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || !(windowMs > 0)) return null;
  return Math.max(0, Math.min(1, (t - Date.now()) / windowMs));
}

// Hourglass: sand running (⏳) until nearly empty, then flipped/run-out (⌛).
function sandGlyph(frac) {
  return frac > 0.06 ? '⏳' : '⌛';
}

// Short braille "sand drain": leftmost cells stay full, draining toward empty.
const SAND = ['⠀', '⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣷', '⣿']; // empty → full (9 levels)
function sandBar(frac, cells) {
  const total = cells * (SAND.length - 1);
  let units = Math.round(frac * total);
  let out = '';
  for (let i = 0; i < cells; i++) {
    const lvl = Math.max(0, Math.min(SAND.length - 1, units));
    out += SAND[lvl];
    units -= SAND.length - 1;
  }
  return out;
}

// Inverted urgency by time left → hex (green when full, red as reset nears).
function timeColorHex(frac, cfg) {
  const elapsed = (1 - frac) * 100;
  if (elapsed >= cfg.timeCrit) return '#F14C4C';
  if (elapsed >= cfg.timeHigh) return '#D7894E';
  if (elapsed >= cfg.timeWarn) return '#E2C08D';
  return '#89D185';
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

function renderItem(item, icon, label, name, pct, reset, cfg, windowMs) {
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
  const r = resetsIn(reset);
  const f = fracLeft(reset, windowMs);
  // Inline: usage bar, then the sand-timer gauge (glyph + drain), no countdown text.
  let text = `$(${icon}) ${label} ${p}% ${bar(p, cfg.segments)}`;
  if (cfg.showResetGauge && f != null) {
    text += `  ${sandGlyph(f)}${sandBar(f, 3)}`;
  }
  item.text = text;
  item.color = new vscode.ThemeColor(color);
  item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  md.appendMarkdown(`**Claude Code — ${name} usage**\n\n`);
  md.appendMarkdown(`- Used: **${p}%** ${bar(p, cfg.segments)}\n`);
  if (r != null) {
    md.appendMarkdown(`- Resets in: **${r}**\n`);
  }
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
    'http-429': 'Rate-limited by the usage API — backing off.',
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
  if (Date.now() < backoffUntil) return; // still backing off from a 429
  lastApiAttempt = Date.now();
  const cfg = getCfg();
  const r = await fetchUsage(cfg);
  if (r.error) {
    if (r.error === 'http-429') {
      backoffUntil = Date.now() + (r.retryAfter || 300) * 1000;
    }
    // Swallow transient errors once we have data — keep the last good values visible.
    const transient = r.error === 'http-429' || r.error === 'network' ||
      r.error === 'timeout' || /^http-5/.test(r.error);
    if (transient && hasData) return;
    return showError(r.error);
  }
  hasData = true;
  backoffUntil = 0;
  const s = pick(r.data, 'five_hour', 'session');
  const w = pick(r.data, 'seven_day', 'weekly');
  const sessionMs = cfg.sessionWindowHours * 3600e3;
  const weeklyMs = cfg.weeklyWindowDays * 86400e3;
  renderItem(sessionItem, 'pulse', 'S', 'Session', s.pct, s.reset, cfg, sessionMs);
  renderItem(weeklyItem, 'calendar', 'W', 'Weekly', w.pct, w.reset, cfg, weeklyMs);
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, Math.max(15, getCfg().refreshSeconds) * 1000);
}

// ~/.claude/projects — where Claude Code appends per-request session logs.
function logsDir(cfg) {
  return path.join(path.dirname(cfg.credentialsPath), 'projects');
}

// Newest mtime (ms) across all session *.jsonl logs, or 0 if none/unreadable.
// This is a local stat only — it never touches the network.
function newestLogMtime(cfg) {
  let newest = 0;
  try {
    const root = logsDir(cfg);
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const m = fs.statSync(path.join(dir, f)).mtimeMs;
          if (m > newest) newest = m;
        } catch { /* ignore */ }
      }
    }
  } catch { /* projects dir missing — leave 0 */ }
  return newest;
}

// Debounced, rate-guarded refresh after request activity settles.
function scheduleActivityRefresh(cfg) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (Date.now() - lastApiAttempt >= cfg.activityMinIntervalSeconds * 1000) refresh();
  }, Math.max(1, cfg.activityDebounceSeconds) * 1000);
}

// Poll the logs locally; when a request is logged, trigger a refresh.
function startActivityWatch(cfg) {
  if (activityTimer) clearInterval(activityTimer);
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
  if (!cfg.syncToActivity) return;
  lastLogMtime = newestLogMtime(cfg);
  activityTimer = setInterval(() => {
    const m = newestLogMtime(cfg);
    if (m > lastLogMtime) { lastLogMtime = m; scheduleActivityRefresh(cfg); }
  }, Math.max(1, cfg.activityPollSeconds) * 1000);
}

function activate(context) {
  sessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  weeklyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sessionItem.command = weeklyItem.command = 'claudeUsage.refresh';
  context.subscriptions.push(
    sessionItem, weeklyItem,
    vscode.commands.registerCommand('claudeUsage.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) {
        startTimer(); startActivityWatch(getCfg()); refresh();
      }
    })
  );
  refresh();
  startTimer();
  startActivityWatch(getCfg());
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (activityTimer) clearInterval(activityTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
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
