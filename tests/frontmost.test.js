'use strict';
// Frontmost app name: the Mac App Store edition asks `grayout-overlay front`
// (a stub here, plus one run of the real helper in a child process); the
// direct download keeps lsappinfo.
const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('frontmost');
const STUB = path.join(dir, 'grayout-overlay');
const OUT = path.join(dir, 'front.out');
const CODE = path.join(dir, 'front.code');
const CALLS = path.join(dir, 'calls');
const REAL = path.join(__dirname, '..', 'helper', 'grayout-overlay');

process.env.GRAYOUT_OVERLAY_BIN = STUB;
delete process.env.GRAYOUT_CHANNEL;

fs.writeFileSync(STUB, `#!/bin/sh
echo "$*" >> "${CALLS}"
cat "${OUT}" 2>/dev/null
exit "$(cat "${CODE}" 2>/dev/null || echo 0)"
`, { mode: 0o755 });

const channel = require('../src/channel');
const { getFrontmostApp, FAILURE_LIMIT, RETRY_MS, _resetFailures, _setClockForTests } = require('../src/frontmost');

const answer = (out, code = 0) => { fs.writeFileSync(OUT, out); fs.writeFileSync(CODE, String(code)); };
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

let clock = 1_789_905_600_000;
_setClockForTests(() => clock);

after(() => { channel._setForTests(null); _setClockForTests(null); helpers.cleanup(dir); });

describe('frontmost app, Mac App Store (overlay helper)', () => {
  beforeEach(() => {
    channel._setForTests('mas');
    _resetFailures();
    try { fs.unlinkSync(CALLS); } catch {}
    answer('{"bundleId":"com.apple.Safari","name":"Safari"}\n');
  });

  test('runs "grayout-overlay front" and returns the name', async () => {
    assert.equal(await getFrontmostApp(), 'Safari');
    assert.deepEqual(calls(), ['front']);
  });

  test('the lock screen comes through as "loginwindow", which loop.js relies on', async () => {
    answer('{"bundleId":"com.apple.loginwindow","name":"loginwindow"}\n');
    assert.equal(await getFrontmostApp(), 'loginwindow');
  });

  test('no frontmost app is null, and not a failure', async () => {
    answer('{"bundleId":"","name":""}\n');
    for (let i = 0; i < 4; i++) assert.equal(await getFrontmostApp(), null);
    answer('{"bundleId":"com.apple.Terminal","name":"Terminal"}\n');
    assert.equal(await getFrontmostApp(), 'Terminal', 'the breaker did not trip');
  });

  test('junk output, a non-zero exit and a missing name all fail softly', async () => {
    answer('not json\n');
    assert.equal(await getFrontmostApp(), null);
    _resetFailures();
    answer('{"name":"Safari"}\n', 1);
    assert.equal(await getFrontmostApp(), null);
    _resetFailures();
    answer('{"bundleId":"x"}\n');
    assert.equal(await getFrontmostApp(), null);
    _resetFailures();
    answer('');
    assert.equal(await getFrontmostApp(), null);
  });

  test('three failures in a row stop asking for a minute, then it tries again', async () => {
    assert.equal(FAILURE_LIMIT, 3);
    assert.equal(RETRY_MS, 60000);
    answer('garbage\n');
    for (let i = 0; i < 3; i++) assert.equal(await getFrontmostApp(), null);
    assert.equal(calls().length, 3);
    answer('{"bundleId":"com.apple.Safari","name":"Safari"}\n');
    assert.equal(await getFrontmostApp(), null, 'waiting');
    clock += RETRY_MS - 1;
    assert.equal(await getFrontmostApp(), null, 'still waiting');
    assert.equal(calls().length, 3, 'the helper was not run during the wait');
    clock += 1;
    assert.equal(await getFrontmostApp(), 'Safari', 'asks again once the minute is up');
    assert.equal(calls().length, 4);
  });

  test('a retry that fails again waits another minute; one success resets it all', async () => {
    answer('garbage\n');
    for (let i = 0; i < 3; i++) await getFrontmostApp();
    clock += RETRY_MS;
    assert.equal(await getFrontmostApp(), null, 'the retry fails');
    assert.equal(calls().length, 4);
    clock += RETRY_MS - 1;
    assert.equal(await getFrontmostApp(), null);
    assert.equal(calls().length, 4, 'one try per minute while it stays broken, not one per tick');
    clock += 1;
    answer('{"name":"Mail"}\n');
    assert.equal(await getFrontmostApp(), 'Mail');
    answer('garbage\n');
    await getFrontmostApp();
    await getFrontmostApp();
    answer('{"name":"Notes"}\n');
    assert.equal(await getFrontmostApp(), 'Notes', 'the count started over: two failures do not wait');
    assert.equal(calls().length, 8);
  });

  test('a success resets the failure count', async () => {
    answer('garbage\n');
    await getFrontmostApp();
    await getFrontmostApp();
    answer('{"name":"Mail"}\n');
    assert.equal(await getFrontmostApp(), 'Mail');
    answer('garbage\n');
    await getFrontmostApp();
    await getFrontmostApp();
    answer('{"name":"Notes"}\n');
    assert.equal(await getFrontmostApp(), 'Notes', 'never three in a row');
  });

  test('a missing helper fails softly', async () => {
    fs.chmodSync(STUB, 0o644);
    try {
      assert.equal(await getFrontmostApp(), null);
    } finally {
      fs.chmodSync(STUB, 0o755);
    }
  });
});

describe('frontmost app, direct download (lsappinfo)', () => {
  beforeEach(() => {
    _resetFailures();
    try { fs.unlinkSync(CALLS); } catch {}
  });

  test('never runs the overlay helper', async () => {
    channel._setForTests('direct');
    const name = await getFrontmostApp();
    assert.ok(name === null || typeof name === 'string');
    assert.deepEqual(calls(), []);
  });

  // lsappinfo, faked: execFile answers for /usr/bin/lsappinfo, and the
  // overlay helper stub still runs for real.
  function fakeLsappinfo(t, answerFor) {
    const cp = require('child_process');
    const real = cp.execFile;
    const seen = [];
    t.mock.method(cp, 'execFile', (file, args, opts, cb) => {
      if (file !== '/usr/bin/lsappinfo') return real(file, args, opts, cb);
      seen.push(args[0]);
      const r = answerFor(args);
      setImmediate(() => (r instanceof Error ? cb(r, '') : cb(null, r)));
    });
    return seen;
  }

  test('lsappinfo: the name from LSDisplayName', async t => {
    channel._setForTests('direct');
    fakeLsappinfo(t, args => (args[0] === 'front' ? 'ASN:0x0-0x1d01d:\n' : '"LSDisplayName"="Safari"\n'));
    assert.equal(await getFrontmostApp(), 'Safari');
  });

  test('lsappinfo failing three times waits a minute too, then tries again', async t => {
    channel._setForTests('direct');
    let broken = true;
    const seen = fakeLsappinfo(t, args => (broken ? new Error('lsappinfo: timed out')
      : args[0] === 'front' ? 'ASN:0x0-0x1d01d:\n' : '"LSDisplayName"="Terminal"\n'));
    for (let i = 0; i < 3; i++) assert.equal(await getFrontmostApp(), null);
    assert.equal(seen.length, 3);
    broken = false;
    clock += RETRY_MS - 1;
    assert.equal(await getFrontmostApp(), null);
    assert.equal(seen.length, 3, 'not run during the wait');
    clock += 1;
    assert.equal(await getFrontmostApp(), 'Terminal', 'never latched off for the session');
    assert.deepEqual(seen.slice(3), ['front', 'info']);
  });

  test('the backend is picked on every call, not cached', async () => {
    answer('{"name":"FromHelper"}\n');
    channel._setForTests('mas');
    assert.equal(await getFrontmostApp(), 'FromHelper');
    channel._setForTests('direct');
    await getFrontmostApp();
    assert.equal(calls().length, 1);
  });
});

describe('frontmost app through the real compiled helper', () => {
  const skip = process.platform !== 'darwin' || !(() => { try { fs.accessSync(REAL, fs.constants.X_OK); return true; } catch { return false; } })()
    ? 'helper/grayout-overlay is not built (npm run helper)' : false;

  test('GRAYOUT_CHANNEL=mas returns a name from NSWorkspace', { skip }, async () => {
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'frontmost'))})
      .getFrontmostApp().then(n => process.stdout.write(JSON.stringify(n)));`;
    const env = { ...process.env, GRAYOUT_CHANNEL: 'mas', GRAYOUT_OVERLAY_BIN: REAL };
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', script], { env, timeout: 15000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    const name = JSON.parse(out);
    // null only without a GUI session (nothing is frontmost); never junk.
    assert.ok(name === null || (typeof name === 'string' && name.length > 0), `got ${out}`);
  });
});
