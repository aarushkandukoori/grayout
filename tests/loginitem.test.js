'use strict';
// Start at login (src/loginitem.js). SMAppService in both editions; the
// LaunchAgent fallback only in the direct one. Nothing here may touch the real
// ~/Library/LaunchAgents or launchd: HOME points at a temp dir before the
// module computes its plist path, and launchctl is a recording fake.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('loginitem');
const SAVED_HOME = process.env.HOME;
process.env.HOME = dir;

let status = 'not-registered';
let inApps = true;
const settingsCalls = [];
helpers.stubElectron({
  app: {
    isInApplicationsFolder: () => inApps,
    getLoginItemSettings: () => ({ status }),
    setLoginItemSettings: s => settingsCalls.push(s),
    getPath: n => (n === 'exe' ? '/Applications/Grayout.app/Contents/MacOS/Grayout' : dir)
  }
});

const channel = require('../src/channel');
const loginitem = require('../src/loginitem');

const launchctlCalls = [];
loginitem._setLaunchctl(async args => { launchctlCalls.push(args); return true; });

after(() => {
  loginitem._setLaunchctl(null);
  channel._setForTests(null);
  process.env.HOME = SAVED_HOME;
  helpers.cleanup(dir);
});
beforeEach(() => {
  settingsCalls.length = 0;
  launchctlCalls.length = 0;
  status = 'not-registered';
  inApps = true;
  try { fs.unlinkSync(loginitem.PLIST_PATH); } catch {}
});

test('the plist path is inside the test HOME, never the real one', () => {
  assert.ok(loginitem.PLIST_PATH.startsWith(dir + path.sep), loginitem.PLIST_PATH);
});

describe('direct edition', () => {
  test('SMAppService first; when macOS will not register it, the LaunchAgent fallback', async () => {
    channel._setForTests('direct');
    const r = await loginitem.setStartAtLogin(true);
    assert.deepEqual(settingsCalls, [{ openAtLogin: true, type: 'mainAppService' }]);
    assert.equal(fs.existsSync(loginitem.PLIST_PATH), true);
    assert.match(fs.readFileSync(loginitem.PLIST_PATH, 'utf8'), /<string>\/Applications\/Grayout\.app\/Contents\/MacOS\/Grayout<\/string>/);
    assert.deepEqual(launchctlCalls.map(a => a[0]), ['bootout', 'bootstrap']);
    assert.deepEqual(r, { status: 'enabled', inApplications: true, launchAgent: true });
    assert.equal(loginitem.getStatus().status, 'enabled', 'the LaunchAgent counts as enabled');
  });

  test('turning it off removes the LaunchAgent too', async () => {
    channel._setForTests('direct');
    await loginitem.setStartAtLogin(true);
    launchctlCalls.length = 0;
    const r = await loginitem.setStartAtLogin(false);
    assert.equal(fs.existsSync(loginitem.PLIST_PATH), false);
    assert.deepEqual(launchctlCalls.map(a => a[0]), ['bootout']);
    assert.equal(r.launchAgent, false);
  });

  test('a registered SMAppService item needs no fallback', async () => {
    channel._setForTests('direct');
    status = 'enabled';
    const r = await loginitem.setStartAtLogin(true);
    assert.equal(r.status, 'enabled');
    assert.equal(fs.existsSync(loginitem.PLIST_PATH), false);
    assert.equal(launchctlCalls.length, 0);
  });
});

describe('Mac App Store edition: SMAppService only (2.4.5(iii), App Sandbox)', () => {
  test('on: only setLoginItemSettings, no plist written, no launchctl, even when macOS says not registered', async () => {
    channel._setForTests('mas');
    const r = await loginitem.setStartAtLogin(true);
    assert.deepEqual(settingsCalls, [{ openAtLogin: true, type: 'mainAppService' }]);
    assert.equal(fs.existsSync(loginitem.PLIST_PATH), false);
    assert.deepEqual(launchctlCalls, []);
    assert.deepEqual(r, { status: 'not-registered', inApplications: true, launchAgent: false });
  });

  test('off: only setLoginItemSettings, no launchctl', async () => {
    channel._setForTests('mas');
    status = 'enabled';
    const r = await loginitem.setStartAtLogin(false);
    assert.deepEqual(settingsCalls, [{ openAtLogin: false, type: 'mainAppService' }]);
    assert.deepEqual(launchctlCalls, []);
    assert.equal(r.launchAgent, false);
  });

  test('getStatus reports SMAppService alone; a leftover plist is not "enabled"', () => {
    channel._setForTests('mas');
    fs.mkdirSync(path.dirname(loginitem.PLIST_PATH), { recursive: true });
    fs.writeFileSync(loginitem.PLIST_PATH, '<plist/>');
    assert.deepEqual(loginitem.getStatus(), { status: 'not-registered', inApplications: true, launchAgent: false });
  });

  test('outside /Applications nothing is registered', async () => {
    channel._setForTests('mas');
    inApps = false;
    const r = await loginitem.setStartAtLogin(true);
    assert.deepEqual(r, { status: 'not-in-applications', inApplications: false, launchAgent: false });
    assert.deepEqual(settingsCalls, []);
  });
});
