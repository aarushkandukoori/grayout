'use strict';
// src/channel.js: which edition a build is, and what that edition may do.
const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('channel');
const electron = helpers.stubElectron({});
const channel = require('../src/channel');

const savedEnv = process.env.GRAYOUT_CHANNEL;
function reset() {
  channel._setForTests(null);
  delete process.mas;
  electron.app.isPackaged = false;
  if (savedEnv === undefined) delete process.env.GRAYOUT_CHANNEL; else process.env.GRAYOUT_CHANNEL = savedEnv;
}
afterEach(reset);
after(() => { reset(); helpers.cleanup(dir); });

describe('name / isMAS', () => {
  test('a plain run is the direct edition', () => {
    delete process.env.GRAYOUT_CHANNEL;
    assert.equal(channel.name(), 'direct');
    assert.equal(channel.isMAS(), false);
  });

  test('GRAYOUT_CHANNEL=mas selects the Mac App Store edition only when unpackaged', () => {
    process.env.GRAYOUT_CHANNEL = 'mas';
    assert.equal(channel.name(), 'mas');
    assert.equal(channel.isMAS(), true);
    electron.app.isPackaged = true;
    assert.equal(channel.name(), 'direct', 'a packaged direct build can never be switched by the environment');
  });

  test('process.mas decides a packaged build, whatever the environment says', () => {
    electron.app.isPackaged = true;
    process.mas = true;
    process.env.GRAYOUT_CHANNEL = 'direct';
    assert.equal(channel.name(), 'mas');
    delete process.mas;
    process.env.GRAYOUT_CHANNEL = 'mas';
    assert.equal(channel.name(), 'direct');
  });

  test('_setForTests forces either edition and null clears it', () => {
    channel._setForTests('mas');
    assert.equal(channel.isMAS(), true);
    channel._setForTests('direct');
    assert.equal(channel.isMAS(), false);
    channel._setForTests(null);
    assert.equal(channel.name(), 'direct');
  });
});

describe('features', () => {
  const OFF_IN_MAS = ['updates', 'selfHosting', 'cliEngine', 'apiBaseOverride', 'loginItemFallback', 'moveToApplications',
    'tccResetHint', 'sponsorLink', 'tasksFile', 'canvas', 'licenseInOnboarding'];

  test('direct: everything on, Color Filters and lsappinfo, consent still required', () => {
    const f = channel.features();
    for (const k of OFF_IN_MAS) assert.equal(f[k], true, k);
    assert.equal(f.grayscaleBackend, 'colorFilters');
    assert.equal(f.frontmostBackend, 'lsappinfo');
    assert.equal(f.aiConsentRequired, true);
    assert.equal(f.externalPurchase, true);
    assert.equal(f.manualLicenseEntry, true);
  });

  test('mas: the App Review gates are off, the blend overlay and helper are used, consent is required', () => {
    channel._setForTests('mas');
    const f = channel.features();
    for (const k of OFF_IN_MAS) assert.equal(f[k], false, k);
    assert.equal(f.grayscaleBackend, 'blend');
    assert.equal(f.frontmostBackend, 'helper');
    assert.equal(f.aiConsentRequired, true);
    assert.equal(f.externalPurchase, true, 'US storefront link-out (3.1.1(a))');
  });

  test('features() is frozen and read fresh on every call, so flipping the channel takes effect at once', () => {
    const a = channel.features();
    assert.equal(Object.isFrozen(a), true);
    assert.throws(() => { 'use strict'; a.updates = false; });
    channel._setForTests('mas');
    assert.equal(channel.features().updates, false);
    assert.equal(a.updates, true, 'an earlier answer is not mutated');
  });
});
