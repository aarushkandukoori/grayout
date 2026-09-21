'use strict';
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const paths = require('./paths');

const BIN = paths.HELPER_BIN;

// The whole point of this module: `off` must actually happen. CGDisplayForceToGray
// is global system state that outlives this process and is NOT reflected in
// System Settings, so a silently-dropped `off` leaves the Mac gray with no
// obvious way for the user to undo it. Every command is therefore verified
// against the helper's `status` output and retried.

let desired = false;   // what the app wants the display to be
let lastError = null;

function available() {
  try { fs.accessSync(BIN, fs.constants.X_OK); return true; } catch { return false; }
}

function run(args, timeout = 5000) {
  return new Promise(resolve => {
    execFile(BIN, args, { timeout }, (err, stdout) => {
      if (err) return resolve({ ok: false, out: '', err: err.message });
      resolve({ ok: true, out: String(stdout).trim(), err: null });
    });
  });
}

async function readActual() {
  if (!available()) return null;
  const r = await run(['status']);
  if (!r.ok) return null;
  if (r.out === 'on') return true;
  if (r.out === 'off') return false;
  return null;
}

/**
 * Drive the display to `desired`, verifying the result. Safe to call every
 * tick: it is a no-op when the OS already matches, and it self-heals a command
 * that was dropped earlier (a fire-and-forget failure would otherwise never be
 * retried, because state transitions only happen once).
 */
async function reconcile(attempts = 3) {
  if (!available()) { lastError = 'grayscale helper missing'; return false; }
  for (let i = 0; i < attempts; i++) {
    const actual = await readActual();
    if (actual === desired) { lastError = null; return true; }

    const r = await run([desired ? 'on' : 'off']);
    if (!r.ok) lastError = r.err;

    const after = await readActual();
    if (after === desired) { lastError = null; return true; }

    await new Promise(res => setTimeout(res, 150 * (i + 1)));
  }

  // Last resort for the dangerous direction: block and force it.
  if (!desired) {
    try {
      execFileSync(BIN, ['off'], { timeout: 3000 });
      lastError = null;
      return true;
    } catch (e) {
      lastError = `could not restore color: ${e.message}`;
    }
  }
  console.error('[grayscale]', lastError || 'state did not converge');
  return false;
}

function set(on) {
  desired = !!on;
  return reconcile();
}

// Re-assert the last intent without changing it (called every tick).
function reassert() {
  return reconcile(1);
}

// Synchronous, best-effort — used on process exit paths where async won't run.
function forceOffSync() {
  desired = false;
  if (!available()) return false;
  try { execFileSync(BIN, ['off'], { timeout: 3000 }); return true; }
  catch { return false; }
}

function status() {
  return { desired, available: available(), lastError, bin: BIN };
}

module.exports = { available, set, reassert, forceOffSync, readActual, status };
