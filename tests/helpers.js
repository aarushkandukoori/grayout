'use strict';
// Shared test helpers. Plain Node, no Electron.
//
// Every test file must call freshUserData() BEFORE requiring any src module:
// src/paths.js resolves every path from GRAYOUT_USER_DATA at require time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');
const FIXTURES = path.join(__dirname, 'fixtures');

// A developer's shell may export any of these, and each one changes what a run
// from source does: an own model key, the Claude CLI engine, the personal
// build, the Mac App Store edition, another service address. Every test file
// that requires this module starts from a plain public direct run instead, and
// a test that wants one of them sets it itself. node --test runs each file in
// its own process, so this never leaks between files.
const DEVELOPER_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GRAYOUT_DEV_ENGINE', 'GRAYOUT_PERSONAL', 'GRAYOUT_CHANNEL', 'GRAYOUT_API_BASE'];
for (const k of DEVELOPER_ENV) delete process.env[k];

/** Create a unique temp userData dir and point GRAYOUT_USER_DATA at it. */
function freshUserData(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grayout-test-${name}-`));
  process.env.GRAYOUT_USER_DATA = dir;
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** The minimal `electron` surface src/ipc.js and its imports touch at require time. */
function fakeElectron(overrides = {}) {
  const base = {
    ipcMain: { handle() {}, on() {} },
    shell: {},
    clipboard: {},
    dialog: {},
    app: {
      getVersion: () => '1.0.0',
      isPackaged: false,
      getPath: () => process.env.GRAYOUT_USER_DATA
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    desktopCapturer: { getSources: async () => [] }
  };
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v && typeof v === 'object' && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

let stub = null;
let hooked = false;

/**
 * Make `require('electron')` (from any module, src/ included) return a fake.
 * Call before requiring src/ipc.js, src/permissions.js or src/loginitem.js.
 */
function stubElectron(overrides) {
  stub = fakeElectron(overrides);
  if (!hooked) {
    hooked = true;
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'electron' && stub) return stub;
      return origLoad.call(this, request, ...rest);
    };
  }
  return stub;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function fileMode(file) {
  return fs.statSync(file).mode & 0o777;
}

/** Resolve a promise after `n` turns of the event loop. */
function turns(n = 3) {
  return new Promise(resolve => {
    const go = () => (n-- > 0 ? setImmediate(go) : resolve());
    go();
  });
}

module.exports = { SRC, FIXTURES, DEVELOPER_ENV, freshUserData, cleanup, fakeElectron, stubElectron, readJsonl, fileMode, turns };
