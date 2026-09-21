'use strict';
// Developer tool: render every onboarding step and the dashboard (+ settings)
// to PNG using the real windows, preload bridges and IPC handlers, without a
// key or a screen — capturePage() works even when the Mac is locked.
//   GRAYOUT_SHOT_DIR=/tmp/shots npx electron scripts/dev-shots.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, nativeImage } = require('electron');

const OUT = process.env.GRAYOUT_SHOT_DIR || path.join(os.tmpdir(), 'grayout-shots');
const UD = process.env.GRAYOUT_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'grayout-shots-ud-'));
process.env.GRAYOUT_USER_DATA = UD;
app.setName('Grayout');
// Keep Electron's own userData (singleton lock, caches) separate from the real app.
app.setPath('userData', path.join(UD, 'electron'));

const paths = require('../src/paths');
const configMod = require('../src/config');
const state = require('../src/state');
const secrets = require('../src/secrets');
const grayscale = require('../src/grayscale');
const windows = require('../src/windows');
const { createLoop } = require('../src/loop');
const { registerIpc } = require('../src/ipc');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, name) {
  await sleep(1800);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote', file, img.getSize());
}

function closeAll() {
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} }
}

app.on('window-all-closed', () => {}); // we close windows between shots; don't quit

app.whenReady().then(async () => {
  paths.init();
  let config = configMod.loadConfig();
  state.get();
  const loop = createLoop({
    config: () => config, state, secrets, grayscale,
    capture: async () => ({ images: [], blank: true }),
    analyze: async () => { throw new Error('not in dev-shots'); }
  });
  loop.pause('dev-shots');
  registerIpc({ loop, getConfig: () => config, applyConfig: c => { config = c; }, windows, updater: null, grayscaleAvailable: () => true });

  // Onboarding, every step
  for (const step of [1, 2, 3, 4, 5]) {
    state.update(s => { s.onboarding = { completed: false, step }; });
    const win = windows.openOnboarding();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await shot(win, `onboarding-${step}`);
    closeAll();
    await sleep(200);
  }

  // Dashboard with fixture history
  const fixture = path.join(__dirname, '..', 'tests', 'fixtures', 'verdicts.sample.jsonl');
  try {
    const rows = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && typeof r.ts === 'number');
    const shift = Date.now() - Math.max(...rows.map(r => r.ts)) - 60000;
    fs.writeFileSync(paths.VERDICT_LOG, rows.map(r => JSON.stringify({ ...r, ts: r.ts + shift, ref: r.ref ? r.ref + shift : r.ref })).join('\n') + '\n');
  } catch (e) { console.log('no fixture:', e.message); }
  state.update(s => { s.onboarding = { completed: true, step: 5 }; });
  // Present the dashboard as a healthy, watching install (a fake session key,
  // never sent anywhere: the loop stays paused and analyze() throws).
  secrets.useSessionKey('sk-ant-dev-shots-placeholder-key-not-real-0000');
  loop._state.paused = false;
  loop._state.lastLine = 'code editor and terminal';
  loop._state.lastActivity = 'code editor and terminal';
  loop._state.lastApp = 'Code';
  const dash = windows.openDashboard();
  await new Promise(r => dash.webContents.once('did-finish-load', r));
  await shot(dash, 'dashboard');
  dash.webContents.send('navigate', 'settings');
  await shot(dash, 'dashboard-settings');
  closeAll();
  app.exit(0);
});
