'use strict';
const childProcess = require('child_process');
const channel = require('./channel');
const paths = require('./paths');

// Best-effort display name of the frontmost app. Two ways, picked per call by
// channel.features().frontmostBackend:
//   lsappinfo  direct download: /usr/bin/lsappinfo, which needs no Automation
//              permission (unlike osascript + System Events)
//   helper     Mac App Store: `grayout-overlay front`, a one-shot run that
//              prints {"bundleId","name"} from NSWorkspace (public API)
// Both report "loginwindow" while the screen is locked; src/loop.js relies on
// that. After FAILURE_LIMIT failures in a row it stops asking for RETRY_MS, so
// a broken tool is not run every tick, then tries again; one success resets
// it. It never gives up for good, and while it answers null src/loop.js skips
// any check that a "Never capture" app could be in.
const FAILURE_LIMIT = 3;
const RETRY_MS = 60000;
let failures = 0;
let retryAt = 0;
let now = () => Date.now();

function run(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout));
    });
  });
}

async function viaLsappinfo() {
  const asn = (await run('/usr/bin/lsappinfo', ['front'])).trim();
  if (!asn) throw new Error('no front ASN');
  const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', asn]);
  const m = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
  return m && m[1] ? m[1] : null;
}

async function viaHelper() {
  const out = await run(paths.OVERLAY_BIN, ['front']);
  const line = out.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
  if (!line) throw new Error('no JSON from the overlay helper');
  const obj = JSON.parse(line);   // throws on junk, which counts as a failure
  if (!obj || typeof obj !== 'object') throw new Error('bad JSON from the overlay helper');
  return typeof obj.name === 'string' && obj.name ? obj.name : null;
}

async function getFrontmostApp() {
  if (failures >= FAILURE_LIMIT && now() < retryAt) return null;
  try {
    const name = channel.features().frontmostBackend === 'helper' ? await viaHelper() : await viaLsappinfo();
    failures = 0;
    retryAt = 0;
    return name;
  } catch {
    failures++;
    // Still failing after a wait counts too: wait again rather than retry every tick.
    if (failures >= FAILURE_LIMIT) retryAt = now() + RETRY_MS;
    return null;
  }
}

function _resetFailures() { failures = 0; retryAt = 0; }
function _setClockForTests(fn) { now = typeof fn === 'function' ? fn : () => Date.now(); }

module.exports = { getFrontmostApp, FAILURE_LIMIT, RETRY_MS, _resetFailures, _setClockForTests };
