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

let sessionItem, weeklyItem, pollTimer;
let hasData = false;     // have we ever rendered real values?
let backoffAttempt = 0;  // 0-based consecutive-failure index for decorrelated-jitter backoff
let backoffPrev = 0;     // Polly V2 running value (previous uncapped formula output)
let backoffUntil = 0;    // no unscheduled API call before this timestamp (ms)
let retryAfterUntil = 0; // server-mandated 429 Retry-After (ms); even manual clicks respect it
let activityTimer;       // local poll of Claude Code logs
let debounceTimer;       // settle timer before an activity-triggered refresh
let lastLogMtime = 0;    // newest .jsonl mtime seen so far
let lastApiAttempt = 0;  // when refresh() last hit the network
let lastValues = null;   // [{ item, label, name, pct, reset, windowMs, cfg }] last good render
let lastGoodAt = 0;      // when lastValues was captured (ms)
let staleTimer;          // spinner animation interval while showing stale values
let spinFrame = 0;       // spinner frame index
let inFlight = null;     // promise of the refresh currently running (callers coalesce onto it)
let currentReq = null;   // in-flight https request, aborted by deactivate()
let disposed = false;    // set by deactivate(); nothing may schedule work after it
let storageDir = null;   // context.globalStorageUri — shared by all windows of this profile

// Clamp a numeric setting into [lo, hi]; anything non-numeric falls back to d.
// settings.json edits bypass the schema bounds in package.json, so don't trust them.
function num(v, lo, hi, d) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

function getCfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  const home = os.homedir();
  return {
    credentialsPath: (c.get('credentialsPath') || '~/.claude/.credentials.json').replace(/^~(?=$|[/\\])/, home),
    refreshBaseSeconds: num(c.get('refreshBaseSeconds'), 15, 3600, 90),
    refreshJitterPct: num(c.get('refreshJitterPct'), 0, 0.5, 0.2),
    backoffMedianFirstSeconds: num(c.get('backoffMedianFirstSeconds'), 0.5, 60, 2),
    backoffCapSeconds: num(c.get('backoffCapSeconds'), 30, 3600, 300),
    startupSplaySeconds: num(c.get('startupSplaySeconds'), 0, 60, 5),
    syncToActivity: c.get('syncToActivity', true),
    activityPollSeconds: num(c.get('activityPollSeconds'), 1, 60, 5),
    activityDebounceSeconds: num(c.get('activityDebounceSeconds'), 1, 60, 4),
    activityMinIntervalSeconds: num(c.get('activityMinIntervalSeconds'), 5, 600, 20),
    segments: Math.round(num(c.get('barSegments'), 1, 20, 7)),
    warn: num(c.get('warnThreshold'), 0, 100, 60),
    high: num(c.get('highThreshold'), 0, 100, 80),
    critical: num(c.get('criticalThreshold'), 0, 100, 95),
    betaHeader: c.get('betaHeader', 'oauth-2025-04-20'),
    showResetGauge: c.get('showResetGauge', true),
    sessionWindowHours: num(c.get('sessionWindowHours'), 0.1, 168, 5),
    weeklyWindowDays: num(c.get('weeklyWindowDays'), 0.1, 31, 7),
  };
}

function readToken(cfg) {
  try {
    const o = (JSON.parse(fs.readFileSync(cfg.credentialsPath, 'utf8')).claudeAiOauth) || {};
    return { token: o.accessToken, expiresAt: o.expiresAt || 0 };
  } catch { return { token: null, expiresAt: 0 }; }
}

// GET https://api.anthropic.com/api/oauth/usage with the OAuth bearer token.
// Settles exactly once on every path and never rejects: a connection dropped mid-body
// emits no 'end', and a bad header value makes https.request() throw synchronously.
function fetchUsage(cfg) {
  return new Promise((resolve) => {
    let req;
    let done = false;
    let deadline;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (currentReq === req) currentReq = null;
      resolve(v);
    };
    deadline = setTimeout(() => { finish({ error: 'timeout' }); if (req) req.destroy(); }, 20000);
    try {
      const { token, expiresAt } = readToken(cfg);
      if (!token) return finish({ error: 'no-token' });
      if (expiresAt && expiresAt < Date.now()) return finish({ error: 'auth' });
      req = https.request({
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
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        res.on('error', () => finish({ error: 'network' }));
        res.on('close', () => finish({ error: 'network' })); // no-op once 'end' has settled
        res.on('end', () => {
          if (res.statusCode === 401) return finish({ error: 'auth' });
          if (res.statusCode === 429) {
            const ra = parseInt(res.headers['retry-after'], 10);
            return finish({ error: 'http-429', retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null });
          }
          if (res.statusCode !== 200) return finish({ error: 'http-' + res.statusCode });
          try { finish({ data: JSON.parse(body) }); } catch { finish({ error: 'parse' }); }
        });
      });
      currentReq = req;
      req.on('error', () => finish({ error: 'network' }));
      req.setTimeout(15000, () => { finish({ error: 'timeout' }); req.destroy(); });
      req.end();
    } catch {
      finish({ error: 'config' }); // e.g. ERR_INVALID_CHAR from betaHeader or the token
    }
  });
}

// Prefer five_hour/seven_day.utilization; fall back to the limits[] array.
// Tolerates any JSON shape: unexpected values read as "not reported".
function pick(d, key, group) {
  const block = d && d[key];
  if (block && Number.isFinite(block.utilization)) {
    return { pct: block.utilization, reset: block.resets_at };
  }
  const lims = d && Array.isArray(d.limits) ? d.limits : [];
  const lim = lims.find((l) => l && (l.group === group || l.kind === group));
  return lim && Number.isFinite(lim.percent) ? { pct: lim.percent, reset: lim.resets_at } : { pct: null, reset: null };
}

// null if the payload is usable, else the error kind to report.
function validate(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'parse';
  const s = pick(d, 'five_hour', 'session');
  const w = pick(d, 'seven_day', 'weekly');
  return s.pct == null && w.pct == null ? 'schema' : null;
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
  stopStale(); // a real error must not be overwritten by the stale animation
  const msg = {
    'no-token': 'No Claude credentials found (~/.claude/.credentials.json).',
    'auth': 'Login expired — open Claude Code and run /usage to refresh auth.',
    'network': 'No network connection.',
    'timeout': 'Usage request timed out.',
    'parse': 'Unexpected response from the usage API.',
    'schema': 'The usage API returned no Session/Weekly data (response format changed?).',
    'config': 'Request could not be built — check claudeUsage.betaHeader and the credentials file.',
    'internal': 'Internal error — see Help › Toggle Developer Tools › Console.',
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

// Neutral placeholder shown at activation while the startup-splay timer waits,
// so the bar isn't blank before the first real poll lands.
function renderLoading() {
  for (const [it, ic, lb] of [[sessionItem, 'pulse', 'S'], [weeklyItem, 'calendar', 'W']]) {
    it.text = `$(${ic}) ${lb} …`;
    it.color = new vscode.ThemeColor('descriptionForeground');
    it.backgroundColor = undefined;
    it.tooltip = 'Loading Claude usage…';
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
    const { item, label, name, pct, reset, windowMs, cfg } = v;
    // Replace the codicon with the spinner (don't prepend) so the stale text
    // is the same width as normal — otherwise the wider text can overflow the
    // status bar and VSCodium hides an item.
    let text = `${spin} ${label}`;
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

// One usage snapshot shared by every window of this profile, so N windows reacting
// to the same Claude Code turn make one API call instead of N. Only the fields we
// render are stored — never the token.
function sharedPath() {
  return storageDir ? path.join(storageDir, 'last-usage.json') : null;
}

function readShared(cfg) {
  const p = sharedPath();
  if (!p) return null;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    const age = Date.now() - o.at;
    if (age >= 0 && age < cfg.activityMinIntervalSeconds * 1000 && !validate(o.data)) return o;
  } catch { /* missing or unreadable — fetch instead */ }
  return null;
}

function writeShared(d) {
  const p = sharedPath();
  if (!p) return;
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), data: { five_hour: d.five_hour, seven_day: d.seven_day, limits: d.limits } }));
    fs.renameSync(tmp, p); // atomic: other windows never read a half-written file
  } catch { /* best effort */ }
}

// Single entry point for every trigger: poll timer, click, activity, settings change.
//   opts.scheduled — fired by pollTimer: it IS the pending retry, so it skips the backoff guard.
//   opts.manual    — click / settings change: skips our own backoff and the shared snapshot,
//                    but still respects a server 429 Retry-After.
function refresh(opts = {}) {
  if (disposed) return Promise.resolve();
  if (inFlight) return inFlight; // coalesce: never two requests at once, never out-of-order renders
  if (!opts.scheduled) {
    const wait = (opts.manual ? retryAfterUntil : backoffUntil) - Date.now();
    if (wait > 0) {
      if (opts.manual) {
        vscode.window.setStatusBarMessage(`Claude usage: rate-limited — retry in ${Math.ceil(wait / 1000)}s`, 4000);
      }
      return Promise.resolve(); // the scheduled retry is still pending
    }
  }
  inFlight = runRefresh(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runRefresh(opts) {
  const cfg = getCfg();
  let next = nextPollDelayMs(cfg);
  try {
    const shared = opts.manual ? null : readShared(cfg);
    if (shared) { onSuccess(cfg, shared.data, shared.at); return; }
    lastApiAttempt = Date.now();
    const r = await fetchUsage(cfg);
    if (disposed) return;
    const err = r.error || validate(r.data);
    if (err) { next = onFailure(cfg, err, r.retryAfter); return; }
    writeShared(r.data);
    onSuccess(cfg, r.data, Date.now());
  } catch (e) {
    console.error('[claude-usage] refresh failed:', e);
    if (!disposed) showError('internal');
  } finally {
    if (!disposed) scheduleNextPoll(next); // always — no failure may end the poll loop
  }
}

// Decorrelated-jitter backoff after ANY failure; a 429 Retry-After is a floor.
// Returns the delay until the scheduled retry.
function onFailure(cfg, kind, retryAfterSec) {
  const ra = kind === 'http-429' ? (retryAfterSec || 0) : 0;
  const delay = Math.ceil(backoffDelayMs(cfg, backoffAttempt, ra));
  backoffAttempt++;
  backoffUntil = Date.now() + delay;
  retryAfterUntil = ra ? Date.now() + ra * 1000 : 0;
  // Swallow transient errors once we have data — keep the last good values visible.
  const transient = kind === 'http-429' || kind === 'network' ||
    kind === 'timeout' || /^http-5/.test(kind);
  if (transient && hasData) startStale(); else showError(kind);
  return delay;
}

function onSuccess(cfg, d, at) {
  backoffAttempt = 0;
  backoffPrev = 0;
  backoffUntil = 0;
  retryAfterUntil = 0;
  stopStale();
  const s = pick(d, 'five_hour', 'session');
  const w = pick(d, 'seven_day', 'weekly');
  const sessionMs = cfg.sessionWindowHours * 3600e3;
  const weeklyMs = cfg.weeklyWindowDays * 86400e3;
  lastValues = [
    { item: sessionItem, label: 'S', name: 'Session', pct: s.pct, reset: s.reset, windowMs: sessionMs, cfg },
    { item: weeklyItem, label: 'W', name: 'Weekly', pct: w.pct, reset: w.reset, windowMs: weeklyMs, cfg },
  ];
  lastGoodAt = at;
  renderItem(sessionItem, 'pulse', 'S', 'Session', s.pct, s.reset, cfg, sessionMs);
  renderItem(weeklyItem, 'calendar', 'W', 'Weekly', w.pct, w.reset, cfg, weeklyMs);
  hasData = true;
}

// Idle poll delay: base ±jitterPct, floored at 15s, so clients de-synchronize.
function nextPollDelayMs(cfg) {
  const j = 1 + (Math.random() * 2 - 1) * cfg.refreshJitterPct; // 1 ± pct
  return Math.max(15000, cfg.refreshBaseSeconds * j * 1000);
}

// Polly DecorrelatedJitterBackoffV2 (George Polevoy): smooth, spike-free, with a
// controlled MEDIAN first-retry delay. next = 2^t · tanh(√(4t)); delay = (next-prev)
// · (1/1.4) · medianFirst. Carries backoffPrev across attempts; capped; Retry-After is a floor.
function backoffDelayMs(cfg, i, retryAfterSec) {
  const t = Math.min(i, 30) + Math.random();          // clamp exponent so 2^t can't overflow
  const next = 2 ** t * Math.tanh(Math.sqrt(4 * t));
  const raw = (next - backoffPrev) * (1 / 1.4) * cfg.backoffMedianFirstSeconds * 1000;
  backoffPrev = next;
  const capMs = cfg.backoffCapSeconds * 1000;
  // Once the exponent is clamped, next and prev share a range and raw can be ≤ 0:
  // stay at the cap instead of retrying instantly. 1s floor guards the low end.
  const delay = raw > 0 ? Math.min(capMs, raw) : capMs;
  return Math.max(1000, (retryAfterSec || 0) * 1000, delay);
}

function scheduleNextPoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  if (disposed) return;
  // Math.ceil: timers run on the loop's integer-ms clock; never fire before backoffUntil.
  pollTimer = setTimeout(() => refresh({ scheduled: true }), Math.ceil(ms));
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

// Debounced, rate-guarded refresh after request activity settles. The debounce is
// jittered 1–2× so windows watching the same logs don't call the API in lockstep.
function scheduleActivityRefresh(cfg) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (Date.now() - lastApiAttempt >= cfg.activityMinIntervalSeconds * 1000) refresh();
  }, cfg.activityDebounceSeconds * 1000 * (1 + Math.random()));
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
  }, cfg.activityPollSeconds * 1000);
}

function activate(context) {
  disposed = false;
  storageDir = context.globalStorageUri ? context.globalStorageUri.fsPath : null;
  sessionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  weeklyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sessionItem.command = weeklyItem.command = 'claudeUsage.refresh';
  context.subscriptions.push(
    sessionItem, weeklyItem,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh({ manual: true })),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) {
        // A settings fix (e.g. credentialsPath) applies now, not after the backoff.
        backoffAttempt = 0; backoffPrev = 0; backoffUntil = 0;
        startActivityWatch(getCfg()); refresh({ manual: true });
      }
    })
  );
  // Startup splay: show a placeholder now, but fire the first real poll after a
  // random 0–startupSplaySeconds delay so many windows/clients starting together
  // (or reopening after an outage) don't all hit the API at t=0.
  renderLoading();
  scheduleNextPoll(Math.random() * getCfg().startupSplaySeconds * 1000);
  startActivityWatch(getCfg());
}

function deactivate() {
  disposed = true;
  if (currentReq) { currentReq.destroy(); currentReq = null; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
  if (activityTimer) clearInterval(activityTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  stopStale();
}

module.exports = { activate, deactivate };
