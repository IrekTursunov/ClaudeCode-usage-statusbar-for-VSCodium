// Standalone check of the live-usage data source (no vscode).
// Calls the same endpoint the extension uses and prints what it will display.
//   node verify-harness.js
//   ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium verify-harness.js
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https');

const credPath = os.homedir() + '/.claude/.credentials.json';
const o = (JSON.parse(fs.readFileSync(credPath, 'utf8')).claudeAiOauth) || {};
if (!o.accessToken) { console.error('no accessToken in', credPath); process.exit(1); }
if (o.expiresAt && o.expiresAt < Date.now()) console.warn('WARNING: token appears expired');

function bar(p, n = 7) {
  const f = Math.max(0, Math.min(n, Math.round((p / 100) * n)));
  return '▰'.repeat(f) + '▱'.repeat(n - f);
}

// Mirror the extension's reset-gauge helpers so we can preview them here.
function fracLeft(iso, windowMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || !(windowMs > 0)) return null;
  return Math.max(0, Math.min(1, (t - Date.now()) / windowMs));
}
function sandGlyph(frac) { return frac > 0.06 ? '⏳' : '⌛'; }
const SAND = ['⠀', '⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣷', '⣿'];
function sandBar(frac, cells) {
  let units = Math.round(frac * cells * (SAND.length - 1)), out = '';
  for (let i = 0; i < cells; i++) {
    out += SAND[Math.max(0, Math.min(SAND.length - 1, units))];
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
function gauge(reset, windowMs) {
  const f = fracLeft(reset, windowMs);
  return f != null ? `  ${sandGlyph(f)}${sandBar(f, 3)}` : '';
}

// Mirror the activity-sync log signal (local stat only, no network).
function logsDir() { return path.join(path.dirname(credPath), 'projects'); }
function newestLogMtime() {
  let newest = 0;
  try {
    const root = logsDir();
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > newest) newest = m; } catch {}
      }
    }
  } catch {}
  return newest;
}

// Offline check of the activity-sync signal.
(function activityCheck() {
  const dir = logsDir(), m = newestLogMtime();
  const age = m ? Math.round((Date.now() - m) / 1000) + 's ago' : 'no logs found';
  console.log('--- activity sync signal ---');
  console.log(`  logsDir: ${dir}`);
  console.log(`  newest .jsonl write: ${age}\n`);
})();

// Offline self-check of the sand-timer gauge across the window (incl. null reset).
(function selfCheck() {
  const W = 5 * 3600e3, now = Date.now();
  console.log('--- reset gauge preview (Session, 5h window) ---');
  for (const frac of [1, 0.75, 0.5, 0.25, 0.05, 0]) {
    const iso = new Date(now + frac * W).toISOString();
    console.log(`  frac=${frac.toFixed(2)}  ⏳→ ${sandGlyph(frac)}${sandBar(frac, 3)}  ${resetsIn(iso)}`);
  }
  console.log(`  null reset → "${gauge(null, W)}" (gauge omitted)\n`);
})();

const req = https.request({
  hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
  headers: {
    'Authorization': 'Bearer ' + o.accessToken,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'claude-usage-statusbar-verify',
  },
}, (res) => {
  let b = ''; res.on('data', (c) => (b += c));
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    if (res.statusCode !== 200) { console.log(b.slice(0, 300)); return; }
    const d = JSON.parse(b);
    const s = d.five_hour || {}, w = d.seven_day || {};
    const sp = Math.round(s.utilization), wp = Math.round(w.utilization);
    console.log(`Session: $(pulse) S ${sp}% ${bar(sp)}${gauge(s.resets_at, 5 * 3600e3)}`);
    console.log(`Weekly : $(calendar) W ${wp}% ${bar(wp)}${gauge(w.resets_at, 7 * 86400e3)}`);
  });
});
req.on('error', (e) => console.error('network error:', e.message));
req.setTimeout(15000, () => { req.destroy(); console.error('timeout'); });
req.end();
