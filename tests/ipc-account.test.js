'use strict';
// The account channels, the payload every window reads, and the promise that
// both preloads expose the same subscription surface.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('ipc-account');

const handlers = new Map();
const opened = [];
helpers.stubElectron({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
  shell: { openExternal: u => opened.push(u), showItemInFolder: () => {}, openPath: async () => '' },
  clipboard: { writeText: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) }
});

const paths = require('../src/paths');
const configMod = require('../src/config');
const pricing = require('../src/pricing');
const { registerIpc, PAYMENT_HOSTS, ALLOWED_HOSTS, accountPayload } = require('../src/ipc');

after(() => helpers.cleanup(dir));

const API = 'https://grayout-api.test-sub.workers.dev';
const SNAP = {
  configured: true,
  plan: 'active', status: 'active', interval: 'monthly', service: true,
  cancelAtPeriodEnd: false, periodEnd: '2026-11-07T14:03:11Z', trialEnd: null,
  usage: { checksUsed: 412, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' },
  hasLicense: true, licenseMasked: 'gry_live_…CB6D', problem: null, problemReason: null, needsSubscription: false
};

const calls = [];
let checkoutReply = null;   // set by a test to answer startCheckout differently
let refreshReply = { ok: true, restored: false };
const account = {
  snapshot: () => SNAP,
  apiBase: () => API,
  status: async opts => { calls.push(['status', opts]); return { ok: true, cached: false, ...SNAP }; },
  refresh: async () => { calls.push(['refresh']); return refreshReply; },
  restore: async opts => { calls.push(['restore', opts]); return { ok: true, restored: true, ...SNAP }; },
  startCheckout: async plan => { calls.push(['startCheckout', plan]); return checkoutReply || { ok: true, url: checkoutUrl, deviceCode: '7KQ2-R9XW', plan, trial: plan === 'monthly', expiresIn: 3600 }; },
  pollClaim: async code => { calls.push(['pollClaim', code]); return { ok: true, ...SNAP }; },
  cancelClaim: () => { calls.push(['cancelClaim']); return { ok: true, cancelled: true }; },
  activate: async license => { calls.push(['activate', license]); return license.startsWith('gry_live_') ? { ok: true, ...SNAP } : { ok: false, kind: 'license_invalid', message: 'no' }; },
  portalUrl: async () => { calls.push(['portalUrl']); return { ok: true, url: portalLink, manageNote: 'You can also manage it at link.com, where this purchase is listed as Sold through Link.' }; }
};
let checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1';
let portalLink = 'https://billing.stripe.com/p/session/x';

const loopCalls = [];
const loop = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'getLive') return () => ({ paused: false, needsKey: false, alerting: false, lastLine: 'watching…', plan: 'monthly', needsSubscription: false });
    return (...args) => { loopCalls.push(String(name)); return `ret:${String(name)}`; };
  }
});

let cfg = configMod.coerce({});
registerIpc({ loop, account, getConfig: () => cfg, applyConfig: c => { cfg = c; }, windows: {}, updater: null, grayscaleAvailable: () => true });
const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);

describe('the channels exist and forward', () => {
  test('every account channel both preloads call is registered', () => {
    const preloadDir = path.join(paths.APP_ROOT, 'ui', 'preload');
    const wanted = new Set();
    for (const f of ['dashboard.js', 'onboarding.js']) {
      const src = fs.readFileSync(path.join(preloadDir, f), 'utf8');
      for (const m of src.matchAll(/invoke\('(account:[^']+)'/g)) wanted.add(m[1]);
    }
    assert.deepEqual([...wanted].sort(), ['account:activate', 'account:cancelClaim', 'account:pollClaim', 'account:portal', 'account:restore', 'account:startCheckout', 'account:status']);
    for (const ch of wanted) assert.ok(handlers.has(ch), ch);
  });

  test('account:status passes the force flag through', async () => {
    const r = await invoke('account:status', { force: true });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'active');
    assert.equal(r.interval, 'monthly');
    assert.deepEqual(calls.at(-1), ['status', { force: true }]);
    await invoke('account:status');
    assert.deepEqual(calls.at(-1), ['status', { force: false }]);
  });

  test('account:startCheckout clamps the plan and opens the link', async () => {
    const r = await invoke('account:startCheckout', 'yearly');
    assert.equal(r.ok, true);
    assert.equal(r.opened, true);
    assert.deepEqual(calls.at(-1), ['startCheckout', 'yearly']);
    assert.equal(opened.at(-1), checkoutUrl);
    await invoke('account:startCheckout', 'lifetime');
    assert.deepEqual(calls.at(-1), ['startCheckout', 'monthly'], 'anything else means monthly');
    await invoke('account:startCheckout');
    assert.deepEqual(calls.at(-1), ['startCheckout', 'monthly']);
  });

  test('a checkout link outside the payment allowlist is never opened', async () => {
    const before = opened.length;
    for (const bad of ['https://evil.example/pay', 'http://checkout.stripe.com/x', 'https://checkout.stripe.com.evil.example/x', 'javascript:alert(1)']) {
      checkoutUrl = bad;
      const r = await invoke('account:startCheckout', 'monthly');
      assert.equal(r.opened, false, bad);
    }
    assert.equal(opened.length, before, 'nothing was opened');
    assert.deepEqual([...PAYMENT_HOSTS].sort(), ['billing.stripe.com', 'checkout.stripe.com', 'pay.stripe.com']);
    checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1';
  });

  test('the service\'s own host is allowed, so a self-run service still works', async () => {
    checkoutUrl = `${API}/checkout/abc`;
    const r = await invoke('account:startCheckout', 'monthly');
    assert.equal(r.opened, true);
    checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1';
  });

  test('already_subscribed opens the billing page instead of a second checkout, and a restored key reloads the loop', async () => {
    loopCalls.length = 0;
    const before = opened.length;
    checkoutReply = {
      ok: false, kind: 'already_subscribed', message: 'This Mac already has a Grayout subscription, so nothing new was charged.',
      portalUrl: 'https://billing.stripe.com/p/session/abc', restored: true, manageNote: 'You can also manage it at link.com, where this purchase is listed as Sold through Link.'
    };
    const r = await invoke('account:startCheckout', 'monthly');
    assert.equal(r.kind, 'already_subscribed');
    assert.equal(r.opened, true);
    assert.equal(opened.at(-1), 'https://billing.stripe.com/p/session/abc');
    assert.ok(loopCalls.includes('reload'));

    checkoutReply = { ok: false, kind: 'already_subscribed', message: 'x', portalUrl: null, restored: false };
    const none = await invoke('account:startCheckout', 'monthly');
    assert.equal(none.opened, false, 'no link, nothing opened');
    checkoutReply = { ok: false, kind: 'already_subscribed', message: 'x', portalUrl: 'https://evil.example/portal', restored: false };
    assert.equal((await invoke('account:startCheckout', 'monthly')).opened, false, 'a link off the allowlist is never opened');
    assert.equal(opened.length, before + 1);
    checkoutReply = null;
  });

  test('account:restore forwards (forced) and reloads the loop when a key came back', async () => {
    loopCalls.length = 0;
    const r = await invoke('account:restore');
    assert.equal(r.restored, true);
    assert.deepEqual(calls.at(-1), ['restore', { force: true }]);
    assert.ok(loopCalls.includes('reload'));
  });

  test('account:pollClaim and cancelClaim forward, and a claim reloads the loop', async () => {
    loopCalls.length = 0;
    const r = await invoke('account:pollClaim', '  7KQ2-R9XW  ');
    assert.equal(r.ok, true);
    assert.deepEqual(calls.at(-1), ['pollClaim', '7KQ2-R9XW']);
    assert.ok(loopCalls.includes('reload'));
    assert.deepEqual(invoke('account:cancelClaim'), { ok: true, cancelled: true });
    await invoke('account:pollClaim', { not: 'a string' });
    assert.deepEqual(calls.at(-1), ['pollClaim', '']);
  });

  test('account:activate reloads the loop only when the key is accepted', async () => {
    loopCalls.length = 0;
    const ok = await invoke('account:activate', ' gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D ');
    assert.equal(ok.ok, true);
    assert.deepEqual(calls.at(-1), ['activate', 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D']);
    assert.ok(loopCalls.includes('reload'));
    loopCalls.length = 0;
    const bad = await invoke('account:activate', 'nope');
    assert.equal(bad.ok, false);
    assert.equal(loopCalls.includes('reload'), false);
    await invoke('account:activate', 'x'.repeat(400));
    assert.equal(calls.at(-1)[1].length, 120, 'oversized input is cut before it travels');
  });

  test('account:portal opens the billing portal and carries the link.com note', async () => {
    const r = await invoke('account:portal');
    assert.equal(r.ok, true);
    assert.equal(r.opened, true);
    assert.match(r.manageNote, /link\.com/);
    assert.equal(opened.at(-1), portalLink);
    portalLink = 'https://evil.example/portal';
    assert.equal((await invoke('account:portal')).opened, false);
    portalLink = 'https://billing.stripe.com/p/session/x';
  });
});

describe('links a window may open', () => {
  test('link.com is allowed (Managed Payments buyers manage there); the unowned grayout.app is not', async () => {
    assert.ok(ALLOWED_HOSTS.has('link.com'));
    assert.ok(ALLOWED_HOSTS.has('support.link.com'));
    assert.equal(ALLOWED_HOSTS.has('grayout.app'), false);
    assert.equal(ALLOWED_HOSTS.has('www.grayout.app'), false);
    const before = opened.length;
    assert.equal(await invoke('shell:openExternal', 'https://link.com'), true);
    assert.equal(opened.at(-1), 'https://link.com/');
    assert.equal(await invoke('shell:openExternal', 'https://grayout.app/'), false);
    assert.equal(opened.length, before + 1);
  });
});

describe('the payload every window reads', () => {
  test('settings:get carries the account, the plans and the self-hosted flag', async () => {
    const s = await invoke('settings:get');
    assert.deepEqual(s.account, {
      configured: true,
      plan: 'active', status: 'active', interval: 'monthly', service: true,
      cancelAtPeriodEnd: false, periodEnd: '2026-11-07T14:03:11Z', trialEnd: null,
      usage: { checksUsed: 412, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' },
      hasLicense: true, licenseMasked: 'gry_live_…CB6D', problem: null, problemReason: null, needsSubscription: false,
      secretsLocked: false,
      manageNote: 'You can also manage it at link.com, where this purchase is listed as Sold through Link.',
      linkUrl: 'https://link.com'
    });
    assert.equal(s.selfHosted, false);
    assert.equal(s.plans.monthly.priceLabel, '$9.99');
    assert.equal(s.plans.yearly.priceLabel, '$79');
    assert.equal(s.freeChecks, pricing.FREE_CHECKS);
    assert.equal(s.includedChecks, pricing.INCLUDED_CHECKS);
    assert.equal(JSON.stringify(s).includes('gry_live_7KQ2'), false, 'only the mask travels');
  });

  test('opening Settings refreshes the account in the background, and a restored key reloads the loop', async () => {
    calls.length = 0;
    loopCalls.length = 0;
    refreshReply = { ok: true, restored: true };
    await invoke('settings:get');
    await helpers.turns(5);
    assert.deepEqual(calls.filter(c => c[0] === 'refresh'), [['refresh']]);
    assert.ok(loopCalls.includes('reload'));
    refreshReply = { ok: true, restored: false };
    loopCalls.length = 0;
    await invoke('settings:get');
    await helpers.turns(5);
    assert.equal(loopCalls.includes('reload'), false);
  });

  test('on the CLI engine, or with config.json invalid, opening Settings never asks the service', async t => {
    // The CLI engine exists only in the personal build (src/channel.js).
    const channel = require('../src/channel');
    channel._setPersonalForTests(true);
    t.after(() => channel._setPersonalForTests(null));
    const saved = cfg;
    try {
      for (const c of [configMod.coerce({ engine: 'cli' }), { ...configMod.coerce({}), _invalid: true }]) {
        cfg = c;
        calls.length = 0;
        const s = await invoke('settings:get');
        await helpers.turns(5);
        assert.deepEqual(calls.filter(x => x[0] === 'refresh'), [], JSON.stringify({ engine: c.engine, invalid: !!c._invalid }));
        if (c.engine === 'cli') {
          assert.equal(s.selfHosted, true, 'the plan panel is hidden');
          assert.equal(s.estimates.engine, 'cli');
        }
      }
    } finally { cfg = saved; }
    const main = fs.readFileSync(path.join(paths.APP_ROOT, 'main.js'), 'utf8');
    assert.match(main, /if \(!selfHosted\(\) && !config\._invalid\) \{\s*account\.refresh\(\{ force: true \}\)/, 'nor the launch refresh');
    assert.match(main, /function selfHosted\(\) \{\s*try \{ return resolveEngine\(config\) === 'cli' \|\|/);
  });

  test('public build: engine "cli" in config.json is the hosted plan, so Settings re-reads it', async t => {
    const channel = require('../src/channel');
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    t.after(() => { channel._setForTests(null); channel._setPersonalForTests(null); });
    const saved = cfg;
    try {
      cfg = configMod.coerce({ engine: 'cli', cliPath: '/opt/homebrew/bin/claude', provider: 'anthropic' });
      calls.length = 0;
      const s = await invoke('settings:get');
      await helpers.turns(5);
      assert.equal(calls.filter(x => x[0] === 'refresh').length, 1, 'the plan is read like any hosted install');
      assert.equal(s.selfHosted, false, 'the plan panel shows');
      assert.equal(s.channel.personal, false);
      assert.equal(s.channel.features.selfHosting, false);
      assert.equal(s.channel.features.cliEngine, false);
      assert.equal(s.estimates.engine, 'api');
    } finally { cfg = saved; }
  });

  test('a fresh "served" answer lifts the loop\'s plan wait; a cached or free answer does not', async () => {
    // Regression: a subscriber who fixed the card at link.com and opened
    // Settings saw "Subscribed" while the menu bar kept saying the
    // subscription needed attention for up to 15 minutes.
    const cases = [
      [{ ok: true, cached: false, hasLicense: true, service: true, status: 'active' }, ['clearPlanHold']],
      [{ ok: true, cached: true, hasLicense: true, service: true, status: 'active' }, []],
      [{ ok: true, cached: false, hasLicense: true, service: false, status: 'past_due' }, []],
      // The free taste's restore answer carries the last stored `service`; it is not news.
      [{ ok: true, restored: false, hasLicense: false, service: true, status: 'free' }, []],
      [{ ok: false, kind: 'network', cached: false, hasLicense: true, service: true }, []],
      [{ ok: true, restored: true, cached: false, hasLicense: true, service: true }, ['reload']]
    ];
    for (const [reply, expected] of cases) {
      refreshReply = reply;
      loopCalls.length = 0;
      await invoke('settings:get');
      await helpers.turns(5);
      assert.deepEqual(loopCalls.filter(n => n === 'clearPlanHold' || n === 'reload'), expected, JSON.stringify(reply));
    }
    refreshReply = { ok: true, restored: false };
  });

  test('account:status with a fresh served answer lifts the plan wait too', async () => {
    loopCalls.length = 0;
    await invoke('account:status', { force: true });
    assert.deepEqual(loopCalls.filter(n => n === 'clearPlanHold'), ['clearPlanHold'], 'SNAP is active and served');
  });

  test('afterAccountRefresh is what main.js runs after the launch refresh', () => {
    const { afterAccountRefresh } = require('../src/ipc');
    const seen = [];
    const fakeLoop = { reload: () => seen.push('reload'), clearPlanHold: () => seen.push('clear') };
    afterAccountRefresh(fakeLoop, { restored: true });
    afterAccountRefresh(fakeLoop, { ok: true, cached: false, hasLicense: true, service: true });
    afterAccountRefresh(fakeLoop, null);
    afterAccountRefresh(null, { restored: true });
    assert.deepEqual(seen, ['reload', 'clear']);
    const main = fs.readFileSync(path.join(paths.APP_ROOT, 'main.js'), 'utf8');
    assert.match(main, /account\.refresh\(\{ force: true \}\)\s*\.then\(r => \{ afterAccountRefresh\(loop, r\)/);
  });

  test('a build with no service address says so in every payload', () => {
    const p = accountPayload({ snapshot: () => ({ ...SNAP, configured: false, hasLicense: false }) });
    assert.equal(p.configured, false);
    assert.equal(accountPayload(null).configured, false);
  });

  test('the welcome window gets the same facts and no key state at all', async () => {
    const o = await invoke('onb:getState');
    assert.equal(o.account.status, 'active');
    assert.equal(o.account.interval, 'monthly');
    assert.equal(o.account.configured, true);
    assert.equal(o.plans.monthly.trialDays, 7);
    assert.equal(o.freeChecks, 100);
    assert.equal('hasKey' in o, false, 'onboarding no longer knows about API keys');
    assert.equal('keyMasked' in o, false);
  });

  test('dash:get carries it too', () => {
    const r = invoke('dash:get');
    assert.equal(r.account.licenseMasked, 'gry_live_…CB6D');
    assert.equal(r.includedChecks, 10000);
    assert.equal(r.selfHosted, false);
  });

  test('onb:startFree moves past the plan step, and the v1 channel still works', () => {
    const state = require('../src/state');
    invoke('onb:setStep', 1);
    invoke('onb:startFree');
    assert.equal(state.get().onboarding.step, 4);
    invoke('onb:setStep', 1);
    invoke('onb:skipKey');
    assert.equal(state.get().onboarding.step, 4);
  });

  test('without an account the payload is a free snapshot rather than a crash', () => {
    const empty = accountPayload(null);
    assert.equal(empty.plan, 'free');
    assert.equal(empty.usage.checksIncluded, 100);
    assert.equal(empty.hasLicense, false);
    assert.deepEqual(accountPayload({ snapshot: () => { throw new Error('gone'); } }), empty);
  });
});

describe('the preload bridges', () => {
  const read = f => fs.readFileSync(path.join(paths.APP_ROOT, 'ui', 'preload', f), 'utf8');

  test('both windows expose the same subscription methods under the same names', () => {
    const names = src => new Set([...src.matchAll(/^\s*(\w+): [^\n]*invoke\('account:/gm)].map(m => m[1]));
    const dash = names(read('dashboard.js'));
    const onb = names(read('onboarding.js'));
    assert.deepEqual([...dash].sort(), ['accountStatus', 'activateLicense', 'cancelClaim', 'openBillingPortal', 'pollClaim', 'restoreLicense', 'startCheckout']);
    assert.deepEqual([...onb].sort(), [...dash].sort());
  });

  test('the welcome window has no API key surface left', () => {
    const src = read('onboarding.js');
    for (const gone of ['key:test', 'key:set', 'key:session', 'testApiKey', 'saveApiKey', 'useKeyForSession']) {
      assert.equal(src.includes(gone), false, gone);
    }
    assert.ok(src.includes('startFree'));
  });

  test('the dashboard keeps the self-hosted key affordance', () => {
    const src = read('dashboard.js');
    for (const kept of ['key:set', 'key:test', 'key:clear']) assert.ok(src.includes(kept), kept);
  });
});
