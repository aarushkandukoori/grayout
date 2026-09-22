'use strict';
/**
 * Developer end-to-end check of the first run: launch the real app with an
 * empty user-data directory, drive the onboarding window the way a person
 * would (Start watching), and assert that a verdict actually gets logged.
 *
 * This exists because the one thing unit tests cannot see is main.js's wiring:
 * the loop is paused while onboarding is open, and finishing it must resume.
 *
 *   node scripts/dev-firstrun.js          # uses the `claude` CLI engine, no key
 *   OPENAI_API_KEY=... node scripts/dev-firstrun.js --api
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9333;
const USE_API = process.argv.includes('--api');
// --packaged runs the installed /Applications/Grayout.app instead of the source
// tree. A packaged app ignores GRAYOUT_USER_DATA on purpose, so its real user
// data directory is moved aside for the run and put back afterwards.
const PACKAGED = process.argv.includes('--packaged');
const APP = '/Applications/Grayout.app';
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', 'Grayout');
const UD = PACKAGED ? REAL_UD : fs.mkdtempSync(path.join(os.tmpdir(), 'grayout-firstrun-'));
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(...a) { console.log('[firstrun]', ...a); }

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function evaluateIn(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res, rej) => {
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result); };
    ws.onerror = rej;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    setTimeout(() => rej(new Error('evaluate timed out')), 20000);
  });
  ws.close();
  return out;
}

let stash = null;
function stashRealUserData() {
  if (!PACKAGED || !fs.existsSync(REAL_UD)) return;
  stash = `${REAL_UD}.firstrun-backup-${process.pid}`;
  fs.renameSync(REAL_UD, stash);
  log('moved existing user data aside:', stash);
}
function restoreRealUserData() {
  if (!stash) return;
  try { fs.rmSync(REAL_UD, { recursive: true, force: true }); } catch {}
  try { fs.renameSync(stash, REAL_UD); log('restored the original user data'); } catch (e) { console.error('[firstrun] could not restore user data:', e.message); }
}

(async () => {
  log(PACKAGED ? `packaged app: ${APP}` : 'running from source');
  log('user data:', UD);
  stashRealUserData();
  const env = { ...process.env, GRAYOUT_USER_DATA: UD };
  if (!USE_API) env.GRAYOUT_DEV_ENGINE = 'cli';
  const bin = PACKAGED
    ? path.join(APP, 'Contents', 'MacOS', 'Grayout')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const args = PACKAGED ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`];
  const child = spawn(bin, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write(`  app| ${d}`));
  child.stderr.on('data', d => process.stderr.write(`  app! ${d}`));

  let failed = null;
  try {
    // 1. the welcome window opens on a fresh install
    let onboarding = null;
    for (let i = 0; i < 40 && !onboarding; i++) {
      await sleep(500);
      try { onboarding = (await targets()).find(t => t.url.endsWith('onboarding.html')); } catch {}
    }
    if (!onboarding) throw new Error('onboarding window never opened');
    log('onboarding window is up');

    // 2. it must not be paused-and-forgotten: walk to the last screen and finish
    const step = await evaluateIn(onboarding.webSocketDebuggerUrl, 'document.querySelector(".progress")?.textContent || ""');
    log('progress reads:', JSON.stringify(step.result && step.result.value));

    if (!USE_API || process.env.GRAYOUT_API_BASE) {
      // v2 free taste: no key, no card. Exactly what a new person clicks.
      const r = await evaluateIn(onboarding.webSocketDebuggerUrl, 'window.grayout.startFree()');
      log('free taste started:', JSON.stringify(r.result && r.result.value));
    } else if (PACKAGED && USE_API) {
      // A packaged app never reads a key from the environment. Hand it one for
      // this session only: it lives in memory and is never written to disk or
      // to the Keychain.
      const key = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('--packaged --api needs OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment');
      const r = await evaluateIn(onboarding.webSocketDebuggerUrl, `window.grayout.useKeyForSession(${JSON.stringify(key)})`);
      log('session key accepted:', JSON.stringify(r.result && r.result.value));
    }

    await evaluateIn(onboarding.webSocketDebuggerUrl, 'window.grayout.finish()');
    log('clicked through to "Start watching"');

    // 3. a verdict must actually be logged (the loop really resumed)
    const verdicts = path.join(UD, 'verdicts.jsonl');
    let rows = [];
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try { rows = fs.readFileSync(verdicts, 'utf8').split('\n').filter(Boolean); } catch {}
      if (rows.length) break;
    }
    if (!rows.length) throw new Error('no verdict was ever logged — the loop did not start after onboarding');
    log('verdict logged:', rows[0].slice(0, 160));
    log('PASS');
  } catch (e) {
    failed = e;
    console.error('[firstrun] FAIL:', e.message);
  } finally {
    child.kill('SIGTERM');
    await sleep(1500);
    try { child.kill('SIGKILL'); } catch {}
    if (!PACKAGED) { try { fs.rmSync(UD, { recursive: true, force: true }); } catch {} }
    else { try { fs.rmSync(UD, { recursive: true, force: true }); } catch {} }
    restoreRealUserData();
  }
  process.exit(failed ? 1 : 0);
})();
