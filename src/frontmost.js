'use strict';
const { execFile } = require('child_process');
const channel = require('./channel');
const paths = require('./paths');

// Best-effort display name of the frontmost app. Two ways, picked per call by
// channel.features().frontmostBackend:
//   lsappinfo  direct download: /usr/bin/lsappinfo, which needs no Automation
//              permission (unlike osascript + System Events)
//   helper     Mac App Store: `grayout-overlay front`, a one-shot run that
//              prints {"bundleId","name"} from NSWorkspace (public API)
// Both report "loginwindow" while the screen is locked; src/loop.js relies on
// that. Disables itself after repeated failures so we don't spam a broken tool
// every tick.
let failures = 0;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (err, stdout) => {
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
  if (failures >= 3) return null;
  try {
    const name = channel.features().frontmostBackend === 'helper' ? await viaHelper() : await viaLsappinfo();
    failures = 0;
    return name;
  } catch {
    failures++;
    return null;
  }
}

function _resetFailures() { failures = 0; }

module.exports = { getFrontmostApp, _resetFailures };
