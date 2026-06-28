// Standalone check of the live-usage data source (no vscode).
// Calls the same endpoint the extension uses and prints what it will display.
//   node verify-harness.js
//   ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium verify-harness.js
const fs = require('fs'), os = require('os'), https = require('https');

const credPath = os.homedir() + '/.claude/.credentials.json';
const o = (JSON.parse(fs.readFileSync(credPath, 'utf8')).claudeAiOauth) || {};
if (!o.accessToken) { console.error('no accessToken in', credPath); process.exit(1); }
if (o.expiresAt && o.expiresAt < Date.now()) console.warn('WARNING: token appears expired');

function bar(p, n = 7) {
  const f = Math.max(0, Math.min(n, Math.round((p / 100) * n)));
  return '▰'.repeat(f) + '▱'.repeat(n - f);
}

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
    console.log(`Session: $(pulse) S ${sp}% ${bar(sp)}   resets ${s.resets_at}`);
    console.log(`Weekly : $(calendar) W ${wp}% ${bar(wp)}   resets ${w.resets_at}`);
  });
});
req.on('error', (e) => console.error('network error:', e.message));
req.setTimeout(15000, () => { req.destroy(); console.error('timeout'); });
req.end();
