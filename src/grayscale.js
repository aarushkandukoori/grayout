'use strict';
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const paths = require('./paths');
const state = require('./state');

const BIN = paths.HELPER_BIN;

// The whole point of this module: `off` must actually happen. The helper drives
// the system-wide Color Filters switch, which outlives this process, so a
// silently-dropped `off` would leave the Mac gray. Every command is therefore
// verified against the helper's `status` output and retried.
//
// Two things make that switch different from a private flag: it is shared with
// the user (someone color-blind may already depend on it, and we must not take
// it from them), and it survives a crash (so we record while we own it).

let desired = false;   // what the app wants the display to be
let lastError = null;
let userOwns = null;   // true when Color Filters was already the user's, before us

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

function readStatusSync() {
  if (!available()) return null;
  try {
    const out = String(execFileSync(BIN, ['status'], { timeout: 3000, encoding: 'utf8' })).trim();
    return out === 'on' ? true : out === 'off' ? false : null;
  } catch { return null; }
}

/**
 * Decide, once per launch, whether the Color Filters switch is ours to use.
 *
 * If it is on right now and we did not leave it that way, someone turned it on
 * deliberately and we keep our hands off it: the red border becomes the only
 * consequence. If our own last run died while the screen was gray, we clean up
 * instead of inheriting it.
 */
function claimOwnership() {
  if (userOwns !== null) return !userOwns;
  if (!available()) { userOwns = false; return true; }
  const on = readStatusSync();
  const weLeftItOn = !!state.get().grayscaleOwned;
  if (on && !weLeftItOn) {
    userOwns = true;
    lastError = 'Color Filters is already on in System Settings, so Grayout will leave it alone';
    return false;
  }
  if (on && weLeftItOn) {
    // Our own leftovers from a crash: put the screen back.
    try { execFileSync(BIN, ['off'], { timeout: 3000 }); } catch {}
  }
  state.update(s => { s.grayscaleOwned = false; });
  userOwns = false;
  return true;
}

/** True when this app may drive the display's color. */
function usable() {
  return available() && claimOwnership();
}

function markOwned(on) {
  try { state.update(s => { s.grayscaleOwned = !!on; }); } catch {}
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
  if (!claimOwnership()) return false;   // the switch belongs to the user
  markOwned(desired);
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
  // Deliberately not gated on ownership: on the way out we always put the
  // switch back, even if we are unsure who set it.
  try { execFileSync(BIN, ['off'], { timeout: 3000 }); markOwned(false); return true; }
  catch { return false; }
}

function status() {
  return { desired, available: available(), usable: usable(), userOwns: !!userOwns, lastError, bin: BIN };
}

function _reset() { userOwns = null; desired = false; lastError = null; }

module.exports = { available, usable, set, reassert, forceOffSync, readActual, readStatusSync, status, _reset };
