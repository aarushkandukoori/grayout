'use strict';
const { execFile } = require('child_process');

/**
 * Seconds since the last keyboard/mouse event.
 *
 * In the app: Electron's powerMonitor.getSystemIdleTime() (public API, no
 * process spawn). Electron is required here, inside the function, so plain-Node
 * tests can load this module. When Electron is not available, or powerMonitor
 * cannot answer (before app ready), it falls back to the HIDIdleTime that
 * `ioreg -c IOHIDSystem` reports.
 *
 * Returns null if it can't be determined (caller should then just proceed).
 */
function fromPowerMonitor() {
  try {
    const electron = require('electron');
    const pm = electron && typeof electron === 'object' ? electron.powerMonitor : null;
    if (!pm || typeof pm.getSystemIdleTime !== 'function') return null;
    const s = pm.getSystemIdleTime();
    return Number.isFinite(s) && s >= 0 ? Math.floor(s) : null;
  } catch {
    return null;
  }
}

function parseIoreg(text) {
  const m = String(text).match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  return Math.floor(Number(m[1]) / 1e9); // nanoseconds -> seconds
}

function fromIoreg() {
  return new Promise(resolve => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseIoreg(stdout));
    });
  });
}

function getIdleSeconds() {
  const s = fromPowerMonitor();
  if (s !== null) return Promise.resolve(s);
  return fromIoreg();
}

module.exports = { getIdleSeconds, _parseIoreg: parseIoreg };
