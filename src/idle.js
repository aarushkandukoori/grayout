'use strict';
const { execFile } = require('child_process');

/**
 * Seconds since the last keyboard/mouse event, via the HID system.
 * Returns null if it can't be determined (caller should then just proceed).
 */
function getIdleSeconds() {
  return new Promise(resolve => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/"HIDIdleTime"\s*=\s*(\d+)/);
      if (!m) return resolve(null);
      resolve(Math.floor(Number(m[1]) / 1e9)); // nanoseconds -> seconds
    });
  });
}

module.exports = { getIdleSeconds };
