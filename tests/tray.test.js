'use strict';
// The menu bar menu (src/tray.js), built from a snapshot without a menu bar.
// The direct edition's menu is unchanged, except that the CLI and key items
// appear only in the personal build (public builds are pay-only); the Mac App
// Store edition also drops the update check, the Terminal fix command, the
// sponsor link and the Color Filters note.
const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('tray');
const opened = [];
const copied = [];
helpers.stubElectron({
  shell: { openExternal: u => opened.push(u) },
  clipboard: { writeText: t => copied.push(t) },
  app: { getVersion: () => '2.0.0', isPackaged: false, getLoginItemSettings: () => ({ status: 'not-registered' }), isInApplicationsFolder: () => true }
});

const channel = require('../src/channel');
const tray = require('../src/tray');
const { TCC_RESET_CMD } = require('../src/permissions');

const SAVED_BACKEND = process.env.GRAYOUT_GRAYSCALE_BACKEND;
delete process.env.GRAYOUT_GRAYSCALE_BACKEND;
afterEach(() => { channel._setForTests(null); channel._setPersonalForTests(null); delete process.env.GRAYOUT_GRAYSCALE_BACKEND; opened.length = 0; copied.length = 0; });
after(() => {
  if (SAVED_BACKEND !== undefined) process.env.GRAYOUT_GRAYSCALE_BACKEND = SAVED_BACKEND;
  helpers.cleanup(dir);
});

const LIVE = {
  paused: false, alerting: false, needsScreenPermission: false, needsKey: false, needsSubscription: false,
  lastLine: 'watching…', lastActivity: 'code editor', lastApp: 'Code', checksUsed: 12, checksIncluded: 100,
  grayscaleUsable: true, configInvalid: false, errorKind: null, cliLogin: null, needsConsent: false
};

function recorder() {
  const calls = [];
  const fn = name => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    ctx: {
      loop: { getLive: () => LIVE, resume: fn('resume'), pause: fn('pause'), pauseFor: fn('pauseFor'), checkNow: fn('checkNow'), dispute: fn('dispute'), restoreColor: fn('restoreColor'), recheckPermission: fn('recheck') },
      windows: { openDashboard: fn('openDashboard'), openOnboarding: fn('openOnboarding') },
      checkForUpdates: fn('checkForUpdates'),
      manageSubscription: fn('manageSubscription')
    }
  };
}

/** A snapshot as tray.snapshot would build it, for the edition in use. */
function view(over = {}, liveOver = {}) {
  const features = channel.features();
  return {
    live: { ...LIVE, ...liveOver },
    cfg: { grayscale: true, camera: false },
    setup: false,
    selfHosted: false,
    needsKey: false,
    perm: { screen: 'granted', camera: 'not-determined' },
    loginItem: { status: 'enabled' },
    update: null,
    spent: { cost: 0, checks: 0 },
    version: '2.0.0',
    features,
    grayscaleBackend: tray.grayscaleBackend(features),
    tccResetCmd: features.tccResetHint ? TCC_RESET_CMD : null,
    sponsorUrl: null,
    ...over
  };
}

/** Every item, submenus included, in order. */
function flat(template) {
  const out = [];
  for (const it of template) { out.push(it); if (Array.isArray(it.submenu)) out.push(...flat(it.submenu)); }
  return out;
}
const labels = template => flat(template).map(i => i.label).filter(Boolean);
const find = (template, re) => flat(template).find(i => re.test(i.label || ''));

describe('direct edition (unchanged)', () => {
  test('check for updates, the Terminal fix command and the Color Filters note are offered', () => {
    const r = recorder();
    const t = tray.buildTemplate(r.ctx, view({}, { grayscaleUsable: false }));
    const l = labels(t);
    assert.ok(l.includes('Check for updates'));
    assert.ok(l.includes('Captures look blank? Copy the fix command'));
    assert.ok(l.includes('Color Filters is in use — red border only'));
    assert.ok(l.includes('Open Accessibility settings…'));
    find(t, /Copy the fix command/).click();
    assert.deepEqual(copied, [TCC_RESET_CMD]);
    find(t, /Check for updates/).click();
    assert.equal(r.calls.at(-1).name, 'checkForUpdates');
  });

  test('an available update opens only a safe release page', () => {
    const r = recorder();
    const t = tray.buildTemplate(r.ctx, view({ update: { version: '2.1.0', url: 'file:///Applications/Calculator.app' } }));
    const item = find(t, /Update available: v2\.1\.0/);
    item.click();
    assert.deepEqual(opened, ['https://github.com/aarushkandukoori/grayout/releases/latest']);
  });

  test('personal build: CLI and key problems are shown, and a sponsor link when one is passed', () => {
    channel._setPersonalForTests(true);
    const r = recorder();
    let l = labels(tray.buildTemplate(r.ctx, view({}, { errorKind: 'cli_missing' })));
    assert.ok(l.includes('Claude CLI not found: set cliPath in config.json'));
    l = labels(tray.buildTemplate(r.ctx, view({}, { errorKind: 'cli_auth' })));
    assert.ok(l.some(x => /Claude CLI logged out/.test(x)));
    l = labels(tray.buildTemplate(r.ctx, view({ selfHosted: true, needsKey: true })));
    assert.ok(l.includes('API key needed — open Settings…'));
    l = labels(tray.buildTemplate(r.ctx, view({ sponsorUrl: 'https://github.com/sponsors/x' })));
    assert.ok(l.includes('Sponsor'));
  });

  test('a usable display shows no grayscale note at all', () => {
    const l = labels(tray.buildTemplate(recorder().ctx, view()));
    assert.equal(l.some(x => /red border only/.test(x)), false);
  });
});

describe('public direct build (pay-only)', () => {
  test('no CLI or API key items, whatever the live state says; the plan is offered instead', () => {
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    for (const liveOver of [{ errorKind: 'cli_missing' }, { errorKind: 'cli_auth' }, { needsKey: true }, { errorKind: 'key_rejected', needsKey: true }]) {
      const l = labels(tray.buildTemplate(recorder().ctx, view({ needsKey: true }, liveOver)));
      assert.equal(l.some(x => /Claude CLI|API key/.test(x)), false, JSON.stringify(liveOver));
      assert.ok(l.includes('Manage subscription…'), JSON.stringify(liveOver));
    }
    assert.ok(labels(tray.buildTemplate(recorder().ctx, view())).includes('Check for updates'), 'the rest of the direct menu is unchanged');
  });

  test('snapshot(): a 1.x config with engine "cli" is not "key needed"', () => {
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    const r = recorder();
    const v = tray.snapshot({
      ...r.ctx,
      getConfig: () => ({ engine: 'cli', provider: 'anthropic', grayscale: true }),
      onboardingDone: () => true,
      permState: () => ({ screen: 'granted', camera: 'granted' }),
      spentToday: () => ({ cost: 0, checks: 0 }),
      selfHosted: () => false,
      updater: { getAvailable: () => null }
    });
    assert.equal(v.needsKey, false);
    assert.equal(v.features.selfHosting, false);
    assert.equal(v.features.cliEngine, false);
  });
});

describe('Mac App Store edition', () => {
  test('no update item, no Terminal command, no Color Filters note or Accessibility link, no sponsor', () => {
    channel._setForTests('mas');
    const t = tray.buildTemplate(recorder().ctx, view({ update: { version: '9.9.9', url: 'x' }, sponsorUrl: 'https://github.com/sponsors/x' }, { grayscaleUsable: false }));
    const l = labels(t);
    for (const gone of ['Check for updates', 'Captures look blank? Copy the fix command', 'Color Filters is in use — red border only', 'Open Accessibility settings…']) {
      assert.equal(l.includes(gone), false, gone);
    }
    assert.equal(l.some(x => /Update available/.test(x)), false);
    assert.ok(l.includes('Grayscale unavailable, red border only'), 'the blend overlay says plainly what is left');
    assert.ok(l.includes('Restore color now'));
    assert.ok(l.includes('Quit Grayout'));
  });

  test('the grayscale note appears only when the overlay cannot gray the display', () => {
    channel._setForTests('mas');
    const l = labels(tray.buildTemplate(recorder().ctx, view()));
    assert.equal(l.some(x => /red border only/.test(x)), false);
  });

  test('no CLI or API key items, whatever the live state says', () => {
    channel._setForTests('mas');
    for (const liveOver of [{ errorKind: 'cli_missing' }, { errorKind: 'cli_auth' }, { needsKey: true }]) {
      const l = labels(tray.buildTemplate(recorder().ctx, view({ selfHosted: true, needsKey: true }, liveOver)));
      assert.equal(l.some(x => /Claude CLI|API key/.test(x)), false, JSON.stringify(liveOver));
    }
  });

  test('snapshot() reads the edition at refresh time: no update, no command, no sponsor', () => {
    channel._setForTests('mas');
    const r = recorder();
    const v = tray.snapshot({
      ...r.ctx,
      getConfig: () => ({ engine: 'api', grayscale: true }),
      onboardingDone: () => true,
      permState: () => ({ screen: 'granted', camera: 'granted' }),
      spentToday: () => ({ cost: 0, checks: 0 }),
      selfHosted: () => false,
      updater: { getAvailable: () => ({ version: '9.9.9', url: 'x' }) },
      sponsorUrl: 'https://github.com/sponsors/x'
    });
    assert.equal(v.update, null);
    assert.equal(v.tccResetCmd, null);
    assert.equal(v.sponsorUrl, null);
    assert.equal(v.grayscaleBackend, 'blend');
    channel._setForTests('direct');
    assert.equal(tray.snapshot({ ...r.ctx, getConfig: () => ({ engine: 'api' }), onboardingDone: () => true, permState: () => ({}), spentToday: () => ({}), selfHosted: () => false, updater: { getAvailable: () => ({ version: '9.9.9' }) } }).tccResetCmd, TCC_RESET_CMD);
  });
});

describe('grayscaleBackend', () => {
  test('follows the edition, with the unpackaged GRAYOUT_GRAYSCALE_BACKEND override', () => {
    assert.equal(tray.grayscaleBackend(channel.features()), 'colorFilters');
    channel._setForTests('mas');
    assert.equal(tray.grayscaleBackend(channel.features()), 'blend');
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'colorFilters';
    assert.equal(tray.grayscaleBackend(channel.features()), 'colorFilters');
    process.env.GRAYOUT_GRAYSCALE_BACKEND = 'nonsense';
    assert.equal(tray.grayscaleBackend(channel.features()), 'blend');
  });
});

describe('consent (both editions)', () => {
  for (const edition of ['direct', 'mas']) {
    test(`${edition}: without permission the menu says checks are off, offers the permission card, and cannot resume or check`, () => {
      channel._setForTests(edition);
      const r = recorder();
      const v = view({}, { needsConsent: true, paused: true });
      const t = tray.buildTemplate(r.ctx, v);
      assert.ok(find(t, /^Checks are off until you allow screenshots$/));
      assert.ok(find(t, /^Paused: sending screenshots is off$/));
      find(t, /^Allow screenshots for checks…$/).click();
      assert.equal(r.calls.at(-1).name, 'openOnboarding');
      assert.equal(find(t, /^Resume$/).enabled, false);
      assert.equal(find(t, /^Check now$/).enabled, false);
      const look = tray.appearance(v);
      assert.equal(look.icon, 'trayPausedTemplate');
      assert.equal(look.title, ' paused');
      assert.equal(look.tooltip, 'Grayout — paused, sending screenshots is off');
    });
  }

  test('with permission nothing about it is shown', () => {
    const t = tray.buildTemplate(recorder().ctx, view());
    assert.equal(labels(t).some(x => /screenshots/i.test(x)), false);
    assert.equal(find(t, /^Check now$/).enabled, true);
    assert.deepEqual(tray.appearance(view()), { icon: 'trayTemplate', title: '', tooltip: 'Grayout — watching' });
  });

  test('during setup the setup items win', () => {
    const t = tray.buildTemplate(recorder().ctx, view({ setup: true }, { needsConsent: true }));
    assert.ok(find(t, /^Finish setup…$/));
    assert.equal(find(t, /^Allow screenshots for checks…$/), undefined);
  });
});
