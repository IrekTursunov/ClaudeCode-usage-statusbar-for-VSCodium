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
let lastValues = null;   // [{ item, icon, label, name, pct, reset, windowMs }] last good render
let lastGoodAt = 0;      // when lastValues was captured (ms)
let staleTimer;          // spinner animation interval while showing stale values
let spinFrame = 0;       // spinner frame index

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
// Braille spinner frames cycled while showing stale (rate-limited) values.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
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
  if (f != null) {
    const drain = `<span style="color:${timeColorHex(f, cfg)};">${sandBar(f, cfg.segments)}</span>`;
    md.appendMarkdown(`- Resets in: ${sandGlyph(f)} ${drain}\n`);
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

// Re-render both items from the last good values, greyed, with the current
// spinner frame — signals "stale, refreshing" without losing the numbers.
function renderStale() {
  if (!lastValues) return;
  const spin = SPINNER[spinFrame % SPINNER.length];
  const since = Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000));
  const ago = since >= 60 ? `${Math.floor(since / 60)}m ${since % 60}s` : `${since}s`;
  for (const v of lastValues) {
    const { item, icon, label, name, pct, reset, windowMs, cfg } = v;
    let text = `$(${icon}) ${spin} ${label}`;
    if (pct != null) {
      const p = Math.round(pct);
      text += ` ${p}% ${bar(p, cfg.segments)}`;
      const f = fracLeft(reset, windowMs);
      if (cfg.showResetGauge && f != null) text += `  ${sandGlyph(f)}${sandBar(f, 3)}`;
    } else {
      text += ' —';
    }
    item.text = text;
    item.color = new vscode.ThemeColor('descriptionForeground');
    item.backgroundColor = undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Claude Code — ${name} usage** _(stale)_\n\n`);
    if (pct != null) md.appendMarkdown(`- Last known: **${Math.round(pct)}%** ${bar(Math.round(pct), cfg.segments)}\n`);
    md.appendMarkdown(`\n${spin} Rate-limited / offline — backing off. Last updated ${ago} ago. Click to retry.`);
    item.tooltip = md;
    item.show();
  }
}

// Begin (or keep) the greyed stale animation. No-op if we never had data.
function startStale() {
  if (!lastValues || staleTimer) return;
  renderStale();
  staleTimer = setInterval(() => {
    spinFrame = (spinFrame + 1) % SPINNER.length;
    renderStale();
  }, 600);
}

function stopStale() {
  if (staleTimer) { clearInterval(staleTimer); staleTimer = undefined; }
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
    if (transient && hasData) { startStale(); return; }
    return showError(r.error);
  }
  hasData = true;
  backoffUntil = 0;
  stopStale();
  const s = pick(r.data, 'five_hour', 'session');
  const w = pick(r.data, 'seven_day', 'weekly');
  const sessionMs = cfg.sessionWindowHours * 3600e3;
  const weeklyMs = cfg.weeklyWindowDays * 86400e3;
  lastValues = [
    { item: sessionItem, icon: 'pulse', label: 'S', name: 'Session', pct: s.pct, reset: s.reset, windowMs: sessionMs, cfg },
    { item: weeklyItem, icon: 'calendar', label: 'W', name: 'Weekly', pct: w.pct, reset: w.reset, windowMs: weeklyMs, cfg },
  ];
  lastGoodAt = Date.now();
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
  if (staleTimer) clearInterval(staleTimer);
}

module.exports = { activate, deactivate };
