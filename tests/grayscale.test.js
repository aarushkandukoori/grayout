'use strict';
// The grayscale helper drives a real system setting (Accessibility > Display >
// Color Filters), so these tests point the module at a stub binary instead:
// nothing here can change the display of the machine running the suite.
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grayout-gs-'));
const STUB = path.join(dir, 'grayscale');
const STATE_FILE = path.join(dir, 'filter-state');   // "on" / "off"
const CALLS = path.join(dir, 'calls');

process.env.GRAYOUT_USER_DATA = dir;
process.env.GRAYOUT_HELPER_BIN = STUB;

fs.writeFileSync(STUB, `#!/bin/sh
echo "$1" >> "${CALLS}"
case "$1" in
  status) cat "${STATE_FILE}" 2>/dev/null || echo off ;;
  type)   echo 1 ;;
  on)     echo on > "${STATE_FILE}" ;;
  off)    echo off > "${STATE_FILE}" ;;
esac
exit 0
`, { mode: 0o755 });

const grayscale = require('../src/grayscale');
const state = require('../src/state');

const setFilter = v => fs.writeFileSync(STATE_FILE, v + '\n');
const filter = () => { try { return fs.readFileSync(STATE_FILE, 'utf8').trim(); } catch { return 'off'; } };
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

function reset({ filterOn = false, owned = false } = {}) {
  setFilter(filterOn ? 'on' : 'off');
  try { fs.unlinkSync(CALLS); } catch {}
  state._reset();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ grayscaleOwned: owned, firstRunAt: 1 }));
  state._reset();
  grayscale._reset();
}

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('grayscale ownership of the system Color Filters switch', () => {
  beforeEach(() => reset());

  test('a clean start: the switch is ours to use', async () => {
    assert.equal(grayscale.usable(), true);
    assert.equal(await grayscale.set(true), true);
    assert.equal(filter(), 'on');
    assert.equal(await grayscale.set(false), true);
    assert.equal(filter(), 'off');
  });

  test('every command is verified against the helper, not fired and forgotten', async () => {
    await grayscale.set(true);
    const c = calls();
    assert.ok(c.includes('on'), 'it turned the filter on');
    assert.ok(c.filter(x => x === 'status').length >= 2, 'it read the state back');
  });

  test('a filter the user already turned on is left alone', async () => {
    reset({ filterOn: true, owned: false });
    assert.equal(grayscale.usable(), false);
    assert.equal(grayscale.status().userOwns, true);
    assert.match(grayscale.status().lastError, /already on in System Settings/);
    assert.equal(await grayscale.set(true), false);
    assert.equal(filter(), 'on', "the user's setting is untouched");
    assert.equal(await grayscale.set(false), false);
    assert.equal(filter(), 'on', 'and we never turn it off for them either');
  });

  test('our own leftovers from a crash are cleaned up and the switch reclaimed', async () => {
    reset({ filterOn: true, owned: true });
    assert.equal(grayscale.usable(), true, 'we recognise our own doing');
    assert.equal(filter(), 'off', 'the screen is put back on launch');
    assert.equal(state.get().grayscaleOwned, false);
    assert.equal(await grayscale.set(true), true);
    assert.equal(filter(), 'on');
  });

  test('ownership is recorded while gray so the next launch can clean up', async () => {
    await grayscale.set(true);
    assert.equal(state.get().grayscaleOwned, true);
    await grayscale.set(false);
    assert.equal(state.get().grayscaleOwned, false);
  });

  test('forceOffSync always restores color, even when unsure who set it', () => {
    reset({ filterOn: true, owned: false });
    assert.equal(grayscale.usable(), false);
    assert.equal(grayscale.forceOffSync(), true);
    assert.equal(filter(), 'off');
  });

  test('a missing helper is reported, not thrown', async () => {
    reset();
    fs.chmodSync(STUB, 0o644);           // present but not executable
    grayscale._reset();
    assert.equal(grayscale.available(), false);
    assert.equal(await grayscale.set(true), false);
    assert.match(grayscale.status().lastError, /helper missing/);
    fs.chmodSync(STUB, 0o755);
  });
});
