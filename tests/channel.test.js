'use strict';
// src/channel.js: which edition a build is, and what that edition may do.
const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('channel');
const electron = helpers.stubElectron({});
const channel = require('../src/channel');

const savedEnv = process.env.GRAYOUT_CHANNEL;
const savedPersonal = process.env.GRAYOUT_PERSONAL;
function reset() {
  channel._setForTests(null);
  channel._setPersonalForTests(null);
  channel._setMetadataForTests(null);
  delete process.mas;
  electron.app.isPackaged = false;
  if (savedEnv === undefined) delete process.env.GRAYOUT_CHANNEL; else process.env.GRAYOUT_CHANNEL = savedEnv;
  if (savedPersonal === undefined) delete process.env.GRAYOUT_PERSONAL; else process.env.GRAYOUT_PERSONAL = savedPersonal;
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
  // Off in every public build, direct download included: the build is pay-only.
  const PERSONAL_ONLY = ['selfHosting', 'cliEngine'];
  // Off in the personal build: every public release is pay-only, so it must
  // never offer one as an update.
  const OFF_IN_PERSONAL = ['updates'];

  test('personal direct build: everything on but the update check, Color Filters and lsappinfo, consent still required', () => {
    channel._setPersonalForTests(true);
    const f = channel.features();
    for (const k of OFF_IN_MAS.filter(k => !OFF_IN_PERSONAL.includes(k))) assert.equal(f[k], true, k);
    for (const k of OFF_IN_PERSONAL) assert.equal(f[k], false, k);
    assert.equal(f.grayscaleBackend, 'colorFilters');
    assert.equal(f.frontmostBackend, 'lsappinfo');
    assert.equal(f.aiConsentRequired, true);
    assert.equal(f.externalPurchase, true);
    assert.equal(f.manualLicenseEntry, true);
  });

  test('public direct build, run from source: no own key and no Claude CLI; everything else as before', () => {
    channel._setPersonalForTests(false);
    const f = channel.features();
    for (const k of PERSONAL_ONLY) assert.equal(f[k], false, k);
    for (const k of OFF_IN_MAS.filter(k => !PERSONAL_ONLY.includes(k))) assert.equal(f[k], true, k);
    assert.equal(f.grayscaleBackend, 'colorFilters');
    assert.equal(f.aiConsentRequired, true);
  });

  test('a plain run, with no flag anywhere, is the public build', () => {
    delete process.env.GRAYOUT_PERSONAL;
    assert.equal(channel.personal(), false);
    assert.equal(channel.features().selfHosting, false);
    assert.equal(channel.features().cliEngine, false);
    assert.equal(channel.features().updates, true, 'the public direct build checks GitHub for updates');
  });

  test('updates: the public direct build only; never the personal build or the Mac App Store edition', () => {
    const cases = [['direct', false, true], ['direct', true, false], ['mas', false, false], ['mas', true, false]];
    for (const [edition, own, want] of cases) {
      channel._setForTests(edition);
      channel._setPersonalForTests(own);
      assert.equal(channel.features().updates, want, `${edition}, personal=${own}`);
    }
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

describe('personal(): the build-time flag only a deliberate build carries', () => {
  test('unpackaged: GRAYOUT_PERSONAL=1 and nothing else', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      if (v === undefined) delete process.env.GRAYOUT_PERSONAL; else process.env.GRAYOUT_PERSONAL = v;
      assert.equal(channel.personal(), false, JSON.stringify(v));
    }
    process.env.GRAYOUT_PERSONAL = '1';
    assert.equal(channel.personal(), true);
    assert.equal(channel.features().selfHosting, true);
    assert.equal(channel.features().cliEngine, true);
  });

  test('packaged: GRAYOUT_PERSONAL is ignored', () => {
    electron.app.isPackaged = true;
    process.env.GRAYOUT_PERSONAL = '1';
    channel._setMetadataForTests({ name: 'grayout', version: '2.0.0' });
    assert.equal(channel.personal(), false);
    assert.equal(channel.features().selfHosting, false);
    assert.equal(channel.features().cliEngine, false);
  });

  test('packaged: the repository package.json (what dist and pack bundle) is never personal', () => {
    electron.app.isPackaged = true;
    process.env.GRAYOUT_PERSONAL = '1';
    assert.equal(channel.personal(), false);
    assert.equal(channel.features().cliEngine, false);
  });

  test('packaged: "grayoutPersonal": true in the bundled package.json (pack:personal / dist:personal) turns it on', () => {
    electron.app.isPackaged = true;
    delete process.env.GRAYOUT_PERSONAL;
    channel._setMetadataForTests({ name: 'grayout', version: '2.0.0', grayoutPersonal: true });
    assert.equal(channel.personal(), true);
    const f = channel.features();
    assert.equal(f.selfHosting, true);
    assert.equal(f.cliEngine, true, 'the personal build keeps the Claude CLI engine');
    assert.equal(f.updates, false, 'and never offers a pay-only public release as an update');
  });

  test('packaged: only the boolean true counts', () => {
    electron.app.isPackaged = true;
    for (const v of ['true', 1, 'yes', {}, null, false]) {
      channel._setMetadataForTests({ name: 'grayout', grayoutPersonal: v });
      assert.equal(channel.personal(), false, JSON.stringify(v));
    }
  });

  test('the Mac App Store edition never gets the own key or the CLI, even with the flag', () => {
    electron.app.isPackaged = true;
    process.mas = true;
    channel._setMetadataForTests({ name: 'grayout', grayoutPersonal: true });
    assert.equal(channel.personal(), true, 'the flag is read');
    assert.equal(channel.features().selfHosting, false);
    assert.equal(channel.features().cliEngine, false);
    channel._setForTests('mas');
    channel._setPersonalForTests(true);
    assert.equal(channel.features().selfHosting, false);
    assert.equal(channel.features().cliEngine, false);
  });

  test('_setPersonalForTests forces either answer and null clears it', () => {
    channel._setPersonalForTests(true);
    assert.equal(channel.personal(), true);
    channel._setPersonalForTests(false);
    process.env.GRAYOUT_PERSONAL = '1';
    assert.equal(channel.personal(), false);
    channel._setPersonalForTests(null);
    assert.equal(channel.personal(), true, 'back to the real answer');
  });
});

describe('apiBaseOverride: a public packaged build talks only to the address built in', () => {
  const accountMod = require('../src/account');
  const BASE = 'https://grayout-api.test-sub.workers.dev';
  const ELSEWHERE = 'https://my-own-grayout.example';

  test('public packaged direct build: off, so config.json apiBase is ignored', () => {
    electron.app.isPackaged = true;
    assert.equal(channel.personal(), false);
    assert.equal(channel.features().apiBaseOverride, false);
    assert.equal(accountMod.apiBaseFrom({ apiBase: ELSEWHERE }, BASE), BASE);
    assert.equal(accountMod.apiBaseFrom({ apiBase: ELSEWHERE }, '__GRAYOUT_API_BASE__'), null, 'an unfilled build stays not connected');
    const cfg = require('../src/config').coerce({ apiBase: ELSEWHERE });
    assert.equal(cfg.apiBase, '', 'nor does the config in use carry it');
  });

  test('personal packaged build: on', () => {
    electron.app.isPackaged = true;
    channel._setMetadataForTests({ name: 'grayout', grayoutPersonal: true });
    assert.equal(channel.features().apiBaseOverride, true);
    assert.equal(accountMod.apiBaseFrom({ apiBase: ELSEWHERE }, BASE), ELSEWHERE);
  });

  test('running from source: on, flag or not', () => {
    for (const p of [false, true]) {
      channel._setPersonalForTests(p);
      assert.equal(channel.features().apiBaseOverride, true, `personal ${p}`);
    }
  });

  test('Mac App Store: off, flag or not', () => {
    channel._setForTests('mas');
    for (const p of [false, true]) {
      channel._setPersonalForTests(p);
      assert.equal(channel.features().apiBaseOverride, false, `personal ${p}`);
    }
  });
});
