'use strict';
// Idle time: Electron's powerMonitor when it can answer, ioreg otherwise.
// Electron is faked through the shared require hook; the ioreg fallback runs
// the real (read-only) tool.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const { getIdleSeconds, _parseIoreg } = require('../src/idle');

const plausible = v => v === null || (Number.isInteger(v) && v >= 0);

describe('idle seconds', () => {
  // Runs before the electron stub exists: plain Node falls back to ioreg.
  test('plain Node (no Electron) falls back to ioreg', async () => {
    const p = getIdleSeconds();
    assert.ok(p instanceof Promise);
    assert.ok(plausible(await p));
  });

  test('uses powerMonitor.getSystemIdleTime() when Electron has it', async () => {
    let asked = 0;
    helpers.stubElectron({ powerMonitor: { getSystemIdleTime: () => { asked++; return 42; } } });
    const p = getIdleSeconds();
    assert.ok(p instanceof Promise, 'same shape as before: a promise');
    assert.equal(await p, 42);
    assert.equal(asked, 1, 'Electron is looked up at call time, not require time');
  });

  test('whole seconds, like the ioreg path', async () => {
    helpers.stubElectron({ powerMonitor: { getSystemIdleTime: () => 12.9 } });
    assert.equal(await getIdleSeconds(), 12);
  });

  test('zero is a real answer, not a reason to fall back', async () => {
    helpers.stubElectron({ powerMonitor: { getSystemIdleTime: () => 0 } });
    assert.equal(await getIdleSeconds(), 0);
  });

  test('a powerMonitor that throws (before app ready) falls back to ioreg', async () => {
    helpers.stubElectron({ powerMonitor: { getSystemIdleTime: () => { throw new Error('not ready'); } } });
    assert.ok(plausible(await getIdleSeconds()));
  });

  test('nonsense from powerMonitor falls back to ioreg', async () => {
    for (const bad of [NaN, -1, undefined, '5', Infinity]) {
      helpers.stubElectron({ powerMonitor: { getSystemIdleTime: () => bad } });
      const v = await getIdleSeconds();
      assert.ok(plausible(v), `for ${String(bad)}`);
    }
  });

  test('an Electron without powerMonitor falls back to ioreg', async () => {
    helpers.stubElectron({});
    assert.ok(plausible(await getIdleSeconds()));
  });
});

describe('ioreg HIDIdleTime parsing', () => {
  test('nanoseconds to whole seconds', () => {
    assert.equal(_parseIoreg('    | |   "HIDIdleTime" = 5500000000\n'), 5);
    assert.equal(_parseIoreg('"HIDIdleTime"=0'), 0);
  });

  test('missing or malformed is null', () => {
    assert.equal(_parseIoreg(''), null);
    assert.equal(_parseIoreg('"HIDIdleTime" = abc'), null);
    assert.equal(_parseIoreg('"SomethingElse" = 12'), null);
  });
});
