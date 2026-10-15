'use strict';
// Grayscale backend for the Mac App Store edition: helper/grayout-overlay.
//
// The helper grays every display with a click-through overlay window (see
// helper/overlay.swift). Unlike the Color Filters switch, that gray is not
// system state: it lives only inside the helper process. So the rules here are
// simpler than in grayscale-colorfilters.js, and the safety net is stronger:
//
//   - Killing the helper always restores color. When an "off" cannot be
//     confirmed, we SIGKILL it and report success once the process is gone.
//   - There is no ownership question. The overlay never touches the user's own
//     Color Filters setting, so nothing is recorded in state.json.
//   - The helper exits by itself when its stdin closes, so if Grayout crashes
//     the gray goes with it.
//
// Protocol (persistent mode): one command per line on stdin
// (on | off | status | ping | front), exactly one reply line on stdout
// ("on", "off", "pong", JSON, or "error ...").
//
// Commands are serialized (one in flight). A helper that does not answer within
// the reply timeout is treated as wedged and killed, which also keeps the
// one-reply-per-command framing from ever drifting.
//
// Crash breaker: more than 3 helper deaths within 60 s makes usable() false, so
// the red border becomes the only consequence. It re-arms after a cooldown.
const fs = require('fs');
const { spawn } = require('child_process');
const paths = require('./paths');

const opts = {
  replyTimeoutMs: 2000,         // per command
  startupTimeoutMs: 5000,       // first reply from a fresh helper (cold launch)
  exitWaitMs: 1000,             // how long to wait for a killed helper to be gone
  attempts: 3,                  // set(): tries before giving up on "on"
  breakerMax: 3,                // more deaths than this...
  breakerWindowMs: 60 * 1000,   // ...within this window trips the breaker
  breakerCooldownMs: 10 * 60 * 1000,
  now: () => Date.now()
};

const MISSING = 'grayscale overlay helper missing';
const MAX_BUFFER = 64 * 1024;   // a reply is one short line; anything bigger is junk

let desired = false;     // what the app wants the display to be
let acked = false;       // the last state the helper confirmed
let lastError = null;
let helper = null;       // the live helper record, or null
let deaths = [];         // timestamps of helper deaths inside the breaker window
let trippedAt = null;    // when the crash breaker tripped, or null
let opChain = Promise.resolve();    // serializes set()/reassert()
let cmdChain = Promise.resolve();   // serializes commands to the helper

const bin = () => paths.OVERLAY_BIN;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastLine = s => String(s).trim().split('\n').pop().slice(0, 200);

function available() {
  try { fs.accessSync(bin(), fs.constants.X_OK); return true; } catch { return false; }
}

function crashLooping() {
  if (trippedAt === null) return false;
  if (opts.now() - trippedAt >= opts.breakerCooldownMs) {
    trippedAt = null;
    deaths = [];
    return false;
  }
  return true;
}

/** True when this app may drive the display's color. */
function usable() {
  return available() && !crashLooping();
}

const alive = h => !!(h && !h.dead);

function recordDeath(why) {
  const t = opts.now();
  lastError = why;
  deaths = deaths.filter(d => t - d < opts.breakerWindowMs);
  deaths.push(t);
  if (deaths.length > opts.breakerMax && trippedAt === null) {
    trippedAt = t;
    lastError = `the grayscale overlay helper stopped ${deaths.length} times within a minute, so Grayout is using the red border only (last: ${why})`;
    console.error('[grayscale]', lastError);
  }
}

function onExit(h, code, signal, err) {
  if (h.dead) return;
  h.dead = true;
  if (helper === h) { helper = null; acked = false; }
  const how = h.reason || (err ? err.message : signal ? `killed by ${signal}` : `exited with code ${code}`);
  const said = h.stderr.trim() ? `: ${lastLine(h.stderr)}` : '';
  const why = `overlay helper stopped (${how})${said}`;
  if (!h.intentional) recordDeath(why);
  const w = h.waiting;
  h.waiting = null;
  if (w) w.finish({ ok: false, line: null, err: why });
  for (const fn of h.exitWaiters.splice(0)) fn();
}

// While the breaker is tripped its message is the one that matters.
function noteError(msg) {
  if (!crashLooping()) lastError = msg;
}

function onData(h, chunk) {
  h.buf += chunk;
  let i;
  while ((i = h.buf.indexOf('\n')) !== -1) {
    const line = h.buf.slice(0, i).trim();
    h.buf = h.buf.slice(i + 1);
    const w = h.waiting;
    if (!w) continue;   // nothing asked: ignore unsolicited output
    h.waiting = null;
    h.answered = true;
    w.finish({ ok: true, line, err: null });
  }
  if (h.buf.length > MAX_BUFFER) h.buf = '';
}

function spawnHelper() {
  let proc;
  try {
    // Pipes, not detached: the helper must die with us (stdin EOF).
    proc = spawn(bin(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    recordDeath(`could not start the overlay helper: ${e.message}`);
    return null;
  }
  const h = {
    proc, buf: '', stderr: '', waiting: null, answered: false,
    dead: false, intentional: false, reason: null, exitWaiters: []
  };
  helper = h;
  acked = false;
  proc.on('error', err => onExit(h, null, null, err));
  proc.on('exit', (code, signal) => onExit(h, code, signal, null));
  // Writing to a helper that just died raises EPIPE on stdin; 'exit' reports it.
  for (const s of [proc.stdin, proc.stdout, proc.stderr]) {
    if (!s) continue;
    s.on('error', () => {});
    if (typeof s.unref === 'function') s.unref();
  }
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => onData(h, chunk));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => { h.stderr = (h.stderr + chunk).slice(-1000); });
  // Never keep a plain-Node process (tests, scripts) alive just for the helper.
  proc.unref();
  return h;
}

function ensureHelper() {
  return alive(helper) ? helper : spawnHelper();
}

/**
 * Stop a helper now. SIGKILL is delivered synchronously; the record is
 * detached at once so no further command is ever sent to it. `intentional`
 * deaths (forceOffSync, _reset) do not count toward the crash breaker.
 */
function kill(h, { intentional = false, reason = null } = {}) {
  if (!h || h.dead) return;
  if (intentional) h.intentional = true;
  if (reason && !h.reason) h.reason = reason;
  if (helper === h) { helper = null; acked = false; }
  try { h.proc.kill('SIGKILL'); } catch {}
}

function waitExit(h, ms = opts.exitWaitMs) {
  if (!h || h.dead) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(h.dead), ms);
    h.exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
  });
}

/** Send one command to the current helper and wait for its one-line reply. */
function send(cmd) {
  const run = () => new Promise(resolve => {
    const h = helper;
    if (!alive(h)) return resolve({ ok: false, line: null, err: 'overlay helper is not running' });
    let done = false;
    const waiter = { finish };
    const ms = h.answered ? opts.replyTimeoutMs : Math.max(opts.replyTimeoutMs, opts.startupTimeoutMs);
    const timer = setTimeout(() => {
      const why = `did not answer "${cmd}" within ${ms} ms`;
      finish({ ok: false, line: null, err: `overlay helper ${why}` });
      // Wedged. Kill it: that ends any gray it holds, and a late reply can
      // never be mistaken for the answer to the next command.
      kill(h, { reason: why });
    }, ms);
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (h.waiting === waiter) h.waiting = null;
      resolve(r);
    }
    h.waiting = waiter;
    try { h.proc.stdin.write(cmd + '\n'); }
    catch (e) { finish({ ok: false, line: null, err: e.message }); }
  });
  const p = cmdChain.then(run, run);
  cmdChain = p.catch(() => {});
  return p;
}

function confirmed(on) {
  acked = on;
  lastError = null;
  return true;
}

async function turnOn() {
  if (!available()) { lastError = MISSING; return false; }
  if (crashLooping()) return false;   // lastError already says why
  if (!ensureHelper()) return false;

  const s = await send('status');
  if (!s.ok) { noteError(s.err); return false; }
  if (s.line === 'on') return confirmed(true);

  const r = await send('on');
  if (!r.ok) { noteError(r.err); return false; }
  if (r.line !== 'on') noteError(`overlay helper: ${r.line}`);

  const v = await send('status');
  if (v.ok && v.line === 'on') return confirmed(true);
  if (!v.ok) noteError(v.err);
  return false;
}

async function turnOff() {
  const h = helper;
  // The gray cannot outlive the helper process.
  if (!alive(h)) { acked = false; return true; }

  const s = await send('status');
  if (s.ok && s.line === 'off' && helper === h) return confirmed(false);
  if (alive(h) && helper === h) {
    const r = await send('off');
    if (r.ok && r.line === 'off') {
      const v = await send('status');
      if (v.ok && v.line === 'off' && helper === h) return confirmed(false);
    }
  }

  // Could not confirm: kill it. The overlay windows belong to the helper, so
  // they go with it. Success only once the process is really gone.
  kill(h, { reason: 'could not confirm "off"' });
  if (await waitExit(h)) { acked = false; return true; }
  lastError = 'could not stop the grayscale overlay helper';
  console.error('[grayscale]', lastError);
  return false;
}

/**
 * Drive the display to `desired`, verifying the result. Safe to call every
 * tick: a no-op round trip when the helper already matches, and it respawns a
 * dead helper while the display should be gray.
 */
async function reconcile(attempts) {
  for (let i = 0; i < attempts; i++) {
    // Re-read `desired` each pass: a later set() wins as soon as it is made.
    if (!desired) return turnOff();
    if (await turnOn()) return true;
    if (!available() || crashLooping()) break;
    if (i < attempts - 1) await sleep(150 * (i + 1));
  }
  if (!desired) return turnOff();
  // A missing helper or a tripped breaker was already reported; say nothing
  // more every tick.
  if (available() && !crashLooping()) console.error('[grayscale]', lastError || 'the overlay did not turn on');
  return false;
}

function enqueue(fn) {
  const p = opChain.then(fn, fn);
  opChain = p.catch(() => {});
  return p;
}

function set(on) {
  desired = !!on;
  return enqueue(() => reconcile(opts.attempts));
}

// Re-assert the last intent without changing it (called every tick).
function reassert() {
  return enqueue(() => reconcile(1));
}

// Synchronous. Used on exit paths and by "restore color": killing the helper
// is the one thing that always ends the gray.
function forceOffSync() {
  desired = false;
  acked = false;
  if (helper) kill(helper, { intentional: true });
  return true;
}

// Nothing synchronous to ask the helper, so: the last state it confirmed.
function readStatusSync() {
  return alive(helper) ? acked : false;
}

async function readActual() {
  if (!alive(helper)) return false;
  const r = await send('status');
  if (!r.ok) return alive(helper) ? null : false;
  return r.line === 'on' ? true : r.line === 'off' ? false : null;
}

function status() {
  const running = alive(helper);
  return {
    desired, available: available(), usable: usable(), userOwns: false, lastError, bin: bin(),
    running, pid: running ? helper.proc.pid : null, acknowledged: running ? acked : false,
    crashLooping: crashLooping(), recentDeaths: deaths.length
  };
}

function _reset() {
  if (helper) kill(helper, { intentional: true });
  helper = null;
  desired = false;
  acked = false;
  lastError = null;
  deaths = [];
  trippedAt = null;
  opChain = Promise.resolve();
  cmdChain = Promise.resolve();
}

// Tests only: shorten timeouts, swap the clock.
function _configure(o) { Object.assign(opts, o); }

module.exports = {
  available, usable, set, reassert, forceOffSync, readActual, readStatusSync, status, _reset, _configure
};
