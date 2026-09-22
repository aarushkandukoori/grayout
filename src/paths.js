'use strict';
// Single place that resolves where Grayout keeps things. Everything lives
// outside the read-only app.asar. Works under plain Node too (tests), where
// Electron is absent and userData falls back to GRAYOUT_USER_DATA or a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const IN_ELECTRON = !!process.versions.electron;
let electronApp = null;
if (IN_ELECTRON) {
  try { electronApp = require('electron').app; } catch { electronApp = null; }
}

const APP_ROOT = path.join(__dirname, '..');

function userDataDir() {
  // The override exists for tests and `npm start`; a packaged app ignores it.
  const packaged = !!(electronApp && electronApp.isPackaged);
  if (process.env.GRAYOUT_USER_DATA && !packaged) return process.env.GRAYOUT_USER_DATA;
  if (electronApp) return electronApp.getPath('userData');
  return path.join(os.tmpdir(), 'grayout-test');
}

function tempRoot() {
  if (electronApp) { try { return electronApp.getPath('temp'); } catch {} }
  return os.tmpdir();
}

const USER_DATA = userDataDir();
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const SECRETS_PATH = path.join(USER_DATA, 'secrets.bin');
const STATE_PATH = path.join(USER_DATA, 'state.json');
const VERDICT_LOG = path.join(USER_DATA, 'verdicts.jsonl');
const LOG_DIR = path.join(USER_DATA, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'grayout.log');
const FRAMES_DIR = path.join(tempRoot(), `grayout-frames-${process.pid}`);
const HELPER_BIN = (electronApp && electronApp.isPackaged)
  ? path.join(process.resourcesPath, 'helper', 'grayscale')
  : (process.env.GRAYOUT_HELPER_BIN || path.join(APP_ROOT, 'helper', 'grayscale'));

const ui = f => path.join(APP_ROOT, 'ui', f);
const preload = f => path.join(APP_ROOT, 'ui', 'preload', f);
const asset = f => path.join(APP_ROOT, 'assets', f);

function init() {
  fs.mkdirSync(USER_DATA, { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FRAMES_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(USER_DATA, 0o700); } catch {}
}

// Frame dirs are per-pid; a force-killed instance leaves one behind.
function cleanStaleFrameDirs() {
  const root = tempRoot();
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('grayout-frames-')) continue;
    const pid = Number(name.slice('grayout-frames-'.length));
    if (pid === process.pid) continue;
    let alive = false;
    if (Number.isFinite(pid)) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (!alive) { try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch {} }
  }
}

function removeFramesDir() {
  try { fs.rmSync(FRAMES_DIR, { recursive: true, force: true }); } catch {}
}

module.exports = {
  IN_ELECTRON, APP_ROOT, USER_DATA, CONFIG_PATH, SECRETS_PATH, STATE_PATH, VERDICT_LOG,
  LOG_DIR, LOG_PATH, FRAMES_DIR, HELPER_BIN, ui, preload, asset, init, cleanStaleFrameDirs, removeFramesDir
};
