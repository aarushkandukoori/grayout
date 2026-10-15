'use strict';
// The Mac App Store grayscale backend talks to helper/grayout-overlay over a
// line protocol. These tests point it at a small Node stub that speaks the same
// protocol and records what it is told, so nothing here can gray the screen of
// the machine running the suite. "Gray" is simulated by a file the stub writes
// while it is on; the gray counts as visible only while that stub process is
// alive, just like the real overlay windows.
//
// The real compiled helper is exercised at the end, for non-visual commands
// only (ping, status, front, unknown, EOF). Never send it "on" from a test.
const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('gs-blend');
const STUB = path.join(dir, 'grayout-overlay');
const CF_STUB = path.join(dir, 'grayscale');
const CTL = path.join(dir, 'ctl.json');
const CALLS = path.join(dir, 'calls');
const CF_CALLS = path.join(dir, 'cf-calls');
const GRAY = path.join(dir, 'gray');
const REAL = path.join(__dirname, '..', 'helper', 'grayout-overlay');

// Both helpers are stubs before any src module resolves its paths. The Color
// Filters stub matters too: the facade tests switch to the direct backend.
process.env.GRAYOUT_OVERLAY_BIN = STUB;
process.env.GRAYOUT_HELPER_BIN = CF_STUB;
delete process.env.GRAYOUT_GRAYSCALE_BACKEND;
delete process.env.GRAYOUT_CHANNEL;

const STUB_SRC = `#!${process.execPath}
'use strict';
const fs = require('fs');
const ctl = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(CTL)}, 'utf8')); } catch { return {}; } };
const log = s => fs.appendFileSync(${JSON.stringify(CALLS)}, process.pid + ' ' + s + '\\n');
log('start ' + process.argv.slice(2).join(' '));
if (process.argv[2] === 'front') {
  process.stdout.write('{"bundleId":"com.example.editor","name":"Editor"}\\n');
  process.exit(0);
}
if (ctl().crashOnStart) process.exit(3);
let on = false;
const paint = v => {
  on = v;
  if (v) fs.writeFileSync(${JSON.stringify(GRAY)}, String(process.pid));
  else { try { fs.unlinkSync(${JSON.stringify(GRAY)}); } catch {} }
};
const write = (s, c) => {
  log('reply ' + s.trim().split('\\n').join('|'));
  if (!c.split) return process.stdout.write(s);
  // Dribble the reply out a byte at a time, to exercise line framing.
  let i = 0;
  const next = () => { if (i < s.length) { process.stdout.write(s[i++]); setTimeout(next, 3); } };
  next();
};
function handle(cmd) {
  const c = ctl();
  log('recv ' + cmd);
  if ((c.hang || []).includes(cmd)) return;
  if ((c.crashOn || []).includes(cmd)) process.exit(2);
  let out;
  switch (cmd) {
    case 'on': if (c.noDisplays) out = 'error no displays'; else { paint(true); out = 'on'; } break;
    case 'off': if (!c.stuckOn) paint(false); out = 'off'; break;
    case 'status': out = on ? 'on' : 'off'; break;
    case 'ping': out = 'pong'; break;
    case 'front': out = '{"bundleId":"com.example.editor","name":"Editor"}'; break;
    default: out = 'error unknown command';
  }
  const text = c.double ? out + '\\n' + out + '\\n' : out + '\\n';
  if (c.delayMs) setTimeout(() => write(text, c), c.delayMs); else write(text, c);
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const cmd = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (cmd) handle(cmd);
  }
});
process.stdin.on('end', () => { log('eof'); process.exit(0); });
`;

const CF_SRC = `#!/bin/sh
echo "$1" >> "${CF_CALLS}"
case "$1" in
  status) cat "${dir}/cf-state" 2>/dev/null || echo off ;;
  on)     echo on > "${dir}/cf-state" ;;
  off)    echo off > "${dir}/cf-state" ;;
esac
exit 0
`;

fs.writeFileSync(STUB, STUB_SRC, { mode: 0o755 });
fs.writeFileSync(CF_STUB, CF_SRC, { mode: 0o755 });

const channel = require('../src/channel');
const blend = require('../src/grayscale-blend');
const grayscale = require('../src/grayscale');

const FAST = { replyTimeoutMs: 300, startupTimeoutMs: 1500, exitWaitMs: 1000 };

const setCtl = o => fs.writeFileSync(CTL, JSON.stringify(o));
const lines = () => { try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const received = () => lines().map(l => l.split(' ').slice(1).join(' ')).filter(l => l.startsWith('recv ')).map(l => l.slice(5));
const starts = () => lines().filter(l => / start/.test(l)).length;
const cfCalls = () => { try { return fs.readFileSync(CF_CALLS, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The simulated gray is on screen only while the stub that drew it is alive. */
function grayVisible() {
  let pid;
  try { pid = Number(fs.readFileSync(GRAY, 'utf8')); } catch { return false; }
  return isAlive(pid);
}

async function waitFor(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function reset(ctl = {}) {
  blend._reset();
  blend._configure({ ...FAST, now: () => Date.now() });
  setCtl(ctl);
  for (const f of [CALLS, CF_CALLS, GRAY]) { try { fs.unlinkSync(f); } catch {} }
  channel._setForTests(null);
}

after(() => {
  blend._reset();
  channel._setForTests(null);
  helpers.cleanup(dir);
});

describe('blend backend: talking to the overlay helper', () => {
  beforeEach(() => reset());

  test('on, status and off round trip, each verified', async () => {
    assert.equal(blend.available(), true);
    assert.equal(blend.usable(), true);
    assert.equal(await blend.set(true), true);
    assert.equal(grayVisible(), true, 'the overlay is up');
    assert.equal(blend.readStatusSync(), true);
    assert.equal(await blend.readActual(), true);
    assert.deepEqual(received().slice(0, 3), ['status', 'on', 'status'], 'asked, acted, then read it back');

    const pid = blend.status().pid;
    assert.equal(await blend.set(false), true);
    assert.equal(grayVisible(), false, 'color is back');
    assert.equal(blend.readStatusSync(), false);
    assert.equal(blend.status().pid, pid, 'the helper stays up for next time');
    assert.equal(blend.status().lastError, null);
    assert.equal(blend.status().userOwns, false, 'no ownership concept');
  });

  test('re-asserting a state the helper already has is one status round trip', async () => {
    await blend.set(true);
    const before = received().length;
    assert.equal(await blend.reassert(), true);
    assert.deepEqual(received().slice(before), ['status']);
  });

  test('turning off with no helper running spawns nothing', async () => {
    assert.equal(await blend.set(false), true);
    assert.equal(await blend.reassert(), true);
    assert.equal(starts(), 0);
    assert.equal(blend.readStatusSync(), false);
    assert.equal(await blend.readActual(), false);
  });

  test('replies split across chunks are reassembled', async () => {
    setCtl({ split: true });
    assert.equal(await blend.set(true), true);
    assert.equal(await blend.set(false), true);
    assert.equal(grayVisible(), false);
  });

  test('two lines in one chunk: the extra is ignored and framing holds', async () => {
    setCtl({ double: true });
    assert.equal(await blend.set(true), true);
    setCtl({});
    assert.equal(await blend.readActual(), true);
    assert.equal(await blend.set(false), true);
    assert.equal(await blend.readActual(), false);
  });

  test('commands are serialized: never two in flight', async () => {
    setCtl({ delayMs: 25 });
    const all = await Promise.all([blend.set(true), blend.readActual(), blend.reassert(), blend.readActual(), blend.set(false)]);
    assert.equal(all[0], true);
    assert.equal(all[4], true);
    assert.equal(grayVisible(), false, 'the last intent wins');
    const seq = lines().map(l => l.split(' ')[1]).filter(w => w === 'recv' || w === 'reply');
    for (let i = 0; i < seq.length; i++) assert.equal(seq[i], i % 2 === 0 ? 'recv' : 'reply', `one in flight at step ${i}: ${seq.join(',')}`);
  });

  test('an "off" the helper does not answer gets the helper SIGKILLed, and success waits for it to be gone', async () => {
    await blend.set(true);
    const pid = blend.status().pid;
    setCtl({ hang: ['off'] });
    assert.equal(await blend.set(false), true);
    assert.equal(isAlive(pid), false, 'the helper is gone');
    assert.equal(grayVisible(), false, 'so the gray is gone');
    assert.equal(blend.status().running, false);
    assert.match(blend.status().lastError, /did not answer "off"/);
  });

  test('a status the helper does not answer while turning off also ends in a kill', async () => {
    await blend.set(true);
    const pid = blend.status().pid;
    setCtl({ hang: ['status'] });
    assert.equal(await blend.set(false), true);
    assert.equal(isAlive(pid), false);
    assert.equal(grayVisible(), false);
  });

  test('a helper that claims "off" but stays gray is killed', async () => {
    await blend.set(true);
    const pid = blend.status().pid;
    setCtl({ stuckOn: true });
    assert.equal(await blend.set(false), true);
    assert.equal(isAlive(pid), false);
    assert.equal(grayVisible(), false);
    assert.match(blend.status().lastError, /could not confirm "off"/);
  });

  test('an "on" that times out kills the wedged helper and retries with a fresh one', async () => {
    setCtl({ hang: ['on'] });
    const p = blend.set(true);
    await waitFor(() => starts() >= 1, 3000, 'first helper');
    await waitFor(() => received().includes('on'), 3000, 'the hung on');
    setCtl({});
    assert.equal(await p, true);
    assert.ok(starts() >= 2, 'respawned');
    assert.equal(grayVisible(), true);
    assert.equal(blend.status().recentDeaths, 1);
    assert.equal(blend.usable(), true);
  });

  test('"error no displays" is a failed on, not a crash', async () => {
    setCtl({ noDisplays: true });
    assert.equal(await blend.set(true), false);
    assert.match(blend.status().lastError, /no displays/);
    assert.equal(blend.status().recentDeaths, 0);
    assert.equal(blend.status().running, true);
    assert.equal(await blend.set(false), true);
  });

  test('a helper that crashes is respawned by reassert while gray is wanted', async () => {
    await blend.set(true);
    const pid = blend.status().pid;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !blend.status().running, 3000, 'crash noticed');
    assert.equal(blend.readStatusSync(), false, 'no helper, no gray');
    assert.match(blend.status().lastError, /SIGKILL/);
    assert.equal(await blend.reassert(), true);
    assert.notEqual(blend.status().pid, pid);
    assert.equal(grayVisible(), true);
  });

  test('a helper that crashes on a command is respawned on the next try', async () => {
    setCtl({ crashOn: ['on'] });
    const p = blend.set(true);
    await waitFor(() => received().includes('on'), 3000, 'the fatal on');
    setCtl({});
    assert.equal(await p, true);
    assert.equal(grayVisible(), true);
  });

  test('crash breaker: more than 3 deaths within a minute means red border only', async () => {
    let clock = 1_000_000;
    blend._configure({ now: () => clock });
    setCtl({ crashOnStart: true });
    assert.equal(await blend.set(true), false, 'three tries, three deaths');
    assert.equal(blend.status().recentDeaths, 3);
    assert.equal(blend.usable(), true, 'three is still within bounds');
    clock += 1000;
    assert.equal(await blend.reassert(), false);
    assert.equal(blend.usable(), false, 'the fourth trips it');
    assert.equal(blend.status().crashLooping, true);
    assert.match(blend.status().lastError, /red border only/);

    const n = starts();
    assert.equal(await blend.set(true), false);
    assert.equal(starts(), n, 'no more spawns while tripped');
    assert.equal(await blend.set(false), true, 'off still works');

    setCtl({});
    clock += 10 * 60 * 1000;
    assert.equal(blend.usable(), true, 're-arms after the cooldown');
    assert.equal(await blend.set(true), true);
  });

  test('deaths older than the window do not count toward the breaker', async () => {
    let clock = 5_000_000;
    blend._configure({ now: () => clock });
    setCtl({ crashOnStart: true });
    await blend.set(true);
    assert.equal(blend.status().recentDeaths, 3);
    clock += 61 * 1000;
    await blend.reassert();
    assert.equal(blend.status().recentDeaths, 1);
    assert.equal(blend.usable(), true);
  });

  test('forceOffSync kills the helper synchronously and does not count as a crash', async () => {
    await blend.set(true);
    const pid = blend.status().pid;
    assert.equal(blend.forceOffSync(), true);
    assert.equal(blend.status().running, false, 'detached at once');
    assert.equal(blend.readStatusSync(), false);
    await waitFor(() => !isAlive(pid), 2000, 'helper gone');
    assert.equal(grayVisible(), false);
    assert.equal(blend.status().recentDeaths, 0);
    assert.equal(blend.usable(), true);
    assert.equal(await blend.set(false), true, 'the next tick has nothing to do');
    assert.equal(blend.forceOffSync(), true, 'and it is safe to repeat');
  });

  test('forceOffSync during an in-flight "on" wins', async () => {
    setCtl({ delayMs: 100 });
    const p = blend.set(true);
    await waitFor(() => starts() >= 1, 3000, 'helper started');
    blend.forceOffSync();
    await p;
    assert.equal(grayVisible(), false);
    assert.equal(blend.status().desired, false);
  });

  test('a missing helper is reported, not thrown', async () => {
    fs.chmodSync(STUB, 0o644);
    try {
      assert.equal(blend.available(), false);
      assert.equal(blend.usable(), false);
      assert.equal(await blend.set(true), false);
      assert.match(blend.status().lastError, /helper missing/);
      assert.equal(await blend.set(false), true, 'nothing can be gray without the helper');
    } finally {
      fs.chmodSync(STUB, 0o755);
    }
  });

  test('a helper that cannot start does not crash the app', async () => {
    fs.writeFileSync(STUB, '#!/nonexistent/interpreter\n', { mode: 0o755 });
    try {
      assert.equal(await blend.set(true), false);
      assert.ok(blend.status().lastError, 'the failure is explained');
      assert.equal(blend.status().running, false);
    } finally {
      fs.writeFileSync(STUB, STUB_SRC, { mode: 0o755 });
    }
  });

  test('state.json is never touched (no ownership to record)', async () => {
    const stateFile = path.join(dir, 'state.json');
    try { fs.unlinkSync(stateFile); } catch {}
    await blend.set(true);
    await blend.set(false);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('the stub exits when its stdin closes, like the real helper', async () => {
    const child = spawn(STUB, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise(r => child.on('exit', code => r(code)));
    child.stdin.end();
    assert.equal(await exited, 0);
  });

  test('if Grayout itself dies, the helper (and its gray) goes with it', async () => {
    const script = `
      const blend = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'grayscale-blend'))});
      blend.set(true).then(ok => {
        process.stdout.write(JSON.stringify({ ok, pid: blend.status().pid }) + '\\n', () => process.kill(process.pid, 'SIGKILL'));
      });`;
    const parent = spawn(process.execPath, ['-e', script], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    parent.stdout.on('data', c => { out += c; });
    const sig = await new Promise(r => parent.on('exit', (code, signal) => r(signal)));
    assert.equal(sig, 'SIGKILL');
    const { ok, pid } = JSON.parse(out.trim());
    assert.equal(ok, true);
    assert.ok(pid > 0);
    await waitFor(() => !isAlive(pid), 3000, 'orphaned helper to exit');
    assert.equal(grayVisible(), false);
  });
});

describe('grayscale facade: backend per channel', () => {
  beforeEach(() => {
    reset();
    grayscale._reset();
    try { fs.unlinkSync(path.join(dir, 'cf-state')); } catch {}
    delete process.env.GRAYOUT_GRAYSCALE_BACKEND;
  });
  after(() => { delete process.env.GRAYOUT_GRAYSCALE_BACKEND; delete process.mas; });

  test('keeps exactly the export contract loop.js and main.js rely on', () => {
    assert.deepEqual(Object.keys(grayscale).sort(),
      ['_reset', 'available', 'forceOffSync', 'readActual', 'readStatusSync', 'reassert', 'set', 'status', 'usable']);
    for (const k of Object.keys(grayscale)) assert.equal(typeof blend[k], 'function', `blend has ${k}`);
  });

  test('Mac App Store: the overlay helper, never the Color Filters switch', async () => {
    channel._setForTests('mas');
    assert.equal(grayscale.status().backend, 'blend');
    assert.equal(await grayscale.set(true), true);
    assert.equal(grayVisible(), true);
    assert.equal(grayscale.readStatusSync(), true);
    assert.equal(await grayscale.set(false), true);
    assert.equal(grayscale.forceOffSync(), true);
    assert.deepEqual(cfCalls(), [], 'helper/grayscale was never run');
  });

  test('direct download: the Color Filters switch, never the overlay', async () => {
    channel._setForTests('direct');
    assert.equal(grayscale.status().backend, 'colorFilters');
    assert.equal(await grayscale.set(true), true);
    assert.ok(cfCalls().includes('on'));
    assert.equal(await grayscale.set(false), true);
    assert.equal(starts(), 0, 'the overlay helper was never run');
  });

  test('the channel is read on every call, not cached', async () => {
    channel._setForTests('mas');
    assert.equal(grayscale.status().backend, 'blend');
    channel._setForTests('direct');
    assert.equal(grayscale.status().backend, 'colorFilters');
  });

  test('GRAYOUT_GRAYSCALE_BACKEND overrides the channel when unpackaged', async () => {
    channel._setForTests('direct');
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'blend';
    assert.equal(grayscale.status().backend, 'blend');
    channel._setForTests('mas');
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'colorFilters';
    assert.equal(grayscale.status().backend, 'colorFilters');
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'nonsense';
    assert.equal(grayscale.status().backend, 'blend', 'unknown values fall back to the channel');
  });

  test('a real Mac App Store build (process.mas) is always blend, override or not', () => {
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'colorFilters';
    process.mas = true;
    try {
      assert.equal(grayscale.status().backend, 'blend');
    } finally {
      delete process.mas;
    }
  });

  test('forceOffSync on the direct backend also kills a leftover overlay helper', async () => {
    channel._setForTests('mas');
    await grayscale.set(true);
    const pid = blend.status().pid;
    channel._setForTests('direct');
    assert.equal(grayscale.forceOffSync(), true);
    await waitFor(() => !isAlive(pid), 2000, 'overlay helper gone');
    assert.equal(grayVisible(), false);
  });
});

describe('the real compiled overlay helper (non-visual commands only)', () => {
  const skip = process.platform !== 'darwin' || !(() => { try { fs.accessSync(REAL, fs.constants.X_OK); return true; } catch { return false; } })()
    ? 'helper/grayout-overlay is not built (npm run helper)' : false;

  test('one-shot "front" prints the frontmost app as JSON', { skip }, () => {
    const out = execFileSync(REAL, ['front'], { encoding: 'utf8', timeout: 10000 });
    const obj = JSON.parse(out.trim());
    assert.equal(typeof obj.name, 'string');
    assert.equal(typeof obj.bundleId, 'string');
  });

  test('persistent mode: one reply line per command, and it exits on stdin EOF', { skip }, async () => {
    const child = spawn(REAL, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
    let buf = '';
    const waiting = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const w = waiting.shift();
        if (w) w(line);
      }
    });
    const ask = cmd => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${cmd}`)), 10000);
      waiting.push(line => { clearTimeout(t); resolve(line); });
      child.stdin.write(cmd + '\n');
    });
    try {
      assert.equal(await ask('ping'), 'pong');
      assert.equal(await ask('status'), 'off');
      const front = JSON.parse(await ask('front'));
      assert.equal(typeof front.name, 'string');
      assert.match(await ask('bogus'), /^error /);
    } finally {
      child.stdin.end();
    }
    let timer;
    const r = await Promise.race([exited, new Promise(res => { timer = setTimeout(() => res('timeout'), 5000); })]);
    clearTimeout(timer);
    if (r === 'timeout') child.kill('SIGKILL');
    assert.deepEqual(r, { code: 0, signal: null }, 'closing stdin ends the helper');
  });
});
