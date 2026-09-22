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
const { registerIpc, PAYMENT_HOSTS, accountPayload } = require('../src/ipc');

after(() => helpers.cleanup(dir));

const SNAP = {
  plan: 'monthly', status: 'active',
  usage: { checksUsed: 412, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' },
  hasLicense: true, licenseMasked: 'gry_live_…CB6D', problem: null, needsSubscription: false
};

const calls = [];
const account = {
  snapshot: () => SNAP,
  apiBase: () => 'https://api.grayout.app',
  status: async opts => { calls.push(['status', opts]); return { ok: true, ...SNAP }; },
  startCheckout: async plan => { calls.push(['startCheckout', plan]); return { ok: true, url: checkoutUrl, deviceCode: 'dc_abc', plan, expiresIn: 900 }; },
  pollClaim: async code => { calls.push(['pollClaim', code]); return { ok: true, ...SNAP }; },
  cancelClaim: () => { calls.push(['cancelClaim']); return { ok: true, cancelled: true }; },
  activate: async license => { calls.push(['activate', license]); return license.startsWith('gry_live_') ? { ok: true, ...SNAP } : { ok: false, kind: 'license_invalid', message: 'no' }; },
  portalUrl: async () => { calls.push(['portalUrl']); return { ok: true, url: portalLink }; }
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
    assert.deepEqual([...wanted].sort(), ['account:activate', 'account:cancelClaim', 'account:pollClaim', 'account:portal', 'account:startCheckout', 'account:status']);
    for (const ch of wanted) assert.ok(handlers.has(ch), ch);
  });

  test('account:status passes the force flag through', async () => {
    const r = await invoke('account:status', { force: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan, 'monthly');
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
    checkoutUrl = 'https://api.grayout.app/checkout/abc';
    const r = await invoke('account:startCheckout', 'monthly');
    assert.equal(r.opened, true);
    checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1';
  });

  test('account:pollClaim and cancelClaim forward, and a claim reloads the loop', async () => {
    loopCalls.length = 0;
    const r = await invoke('account:pollClaim', '  dc_abc  ');
    assert.equal(r.ok, true);
    assert.deepEqual(calls.at(-1), ['pollClaim', 'dc_abc']);
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

  test('account:portal opens the billing portal', async () => {
    const r = await invoke('account:portal');
    assert.equal(r.ok, true);
    assert.equal(r.opened, true);
    assert.equal(opened.at(-1), portalLink);
    portalLink = 'https://evil.example/portal';
    assert.equal((await invoke('account:portal')).opened, false);
    portalLink = 'https://billing.stripe.com/p/session/x';
  });
});

describe('the payload every window reads', () => {
  test('settings:get carries the account, the plans and the self-hosted flag', async () => {
    const s = await invoke('settings:get');
    assert.deepEqual(s.account, {
      plan: 'monthly', status: 'active',
      usage: { checksUsed: 412, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' },
      hasLicense: true, licenseMasked: 'gry_live_…CB6D', needsSubscription: false
    });
    assert.equal(s.selfHosted, false);
    assert.equal(s.plans.monthly.priceLabel, '$9.99');
    assert.equal(s.plans.yearly.priceLabel, '$79');
    assert.equal(s.freeChecks, pricing.FREE_CHECKS);
    assert.equal(s.includedChecks, pricing.INCLUDED_CHECKS);
    assert.equal(JSON.stringify(s).includes('gry_live_7KQ2'), false, 'only the mask travels');
  });

  test('the welcome window gets the same facts and no key state at all', async () => {
    const o = await invoke('onb:getState');
    assert.equal(o.account.plan, 'monthly');
    assert.equal(o.plans.monthly.trialDays, 7);
    assert.equal(o.freeChecks, 100);
    assert.equal('hasKey' in o, false, 'onboarding no longer knows about API keys');
    assert.equal('keyMasked' in o, false);
  });

  test('dash:get carries it too', () => {
    const r = invoke('dash:get');
    assert.equal(r.account.licenseMasked, 'gry_live_…CB6D');
    assert.equal(r.includedChecks, 15000);
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
    assert.deepEqual([...dash].sort(), ['accountStatus', 'activateLicense', 'cancelClaim', 'openBillingPortal', 'pollClaim', 'startCheckout']);
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
