'use strict';
const { execFile } = require('child_process');

// Best-effort frontmost app display name via lsappinfo, which needs no
// Automation permission (unlike osascript + System Events). Disables itself
// after repeated failures so we don't spam a broken tool every tick.
let failures = 0;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/lsappinfo', args, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout));
    });
  });
}

async function getFrontmostApp() {
  if (failures >= 3) return null;
  try {
    const asn = (await run(['front'])).trim();
    if (!asn) throw new Error('no front ASN');
    const info = await run(['info', '-only', 'name', asn]);
    const m = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
    failures = 0;
    return m && m[1] ? m[1] : null;
  } catch {
    failures++;
    return null;
  }
}

function _resetFailures() { failures = 0; }

module.exports = { getFrontmostApp, _resetFailures };
