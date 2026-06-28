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
