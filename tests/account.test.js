'use strict';
// The hosted-service client. fetch is stubbed throughout: no test here touches
// the network, and every one of these calls must answer rather than throw.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const helpers = require('./helpers');

const dir = helpers.freshUserData('account');
const paths = require('../src/paths');
const secrets = require('../src/secrets');
const state = require('../src/state');
const accountMod = require('../src/account');
const { createAccount, apiBaseFrom, normalizeBase, safeUrl, errorFromBody, SERVICE_ERROR_KINDS, DEFAULT_API_BASE } = accountMod;

const REAL_FETCH = globalThis.fetch;
const SAVED_ENV = { base: process.env.GRAYOUT_API_BASE, license: process.env.GRAYOUT_LICENSE };

after(() => {
  globalThis.fetch = REAL_FETCH;
  if (SAVED_ENV.base === undefined) delete process.env.GRAYOUT_API_BASE; else process.env.GRAYOUT_API_BASE = SAVED_ENV.base;
  if (SAVED_ENV.license === undefined) delete process.env.GRAYOUT_LICENSE; else process.env.GRAYOUT_LICENSE = SAVED_ENV.license;
  helpers.cleanup(dir);
});

delete process.env.GRAYOUT_API_BASE;
delete process.env.GRAYOUT_LICENSE;

const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
const OTHER = 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ23';
const identity = () => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(s),
  decryptString: b => b.toString()
});

function reply({ status = 200, body = {}, requestId = 'req_test' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (String(name).toLowerCase() === 'x-grayout-request-id' ? requestId : null) },
    json: async () => body
  };
}

/** Record every call and answer from a scripted handler. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      path: String(url).replace(DEFAULT_API_BASE, ''),
      method: opts.method || 'GET',
      body: opts.body ? JSON.parse(opts.body) : null
    };
    calls.push(call);
    const out = await handler(call, calls.length);
    if (out instanceof Error) throw out;
    return reply(out || {});
  };
  return calls;
}

function fresh(over = {}) {
  secrets._setSafeStorage(identity());
  try { secrets.clearLicense(); } catch {}
  try { secrets.useSessionLicense(null); } catch {}
  state.update(s => { s.account = null; });
  return createAccount({ getConfig: () => ({}), pollIntervalMs: 1, claimWindowMs: 200, ...over });
}

beforeEach(() => { globalThis.fetch = REAL_FETCH; });

describe('base URL', () => {
  test('defaults to api.grayout.app; config.apiBase and GRAYOUT_API_BASE override it', t => {
    t.after(() => { delete process.env.GRAYOUT_API_BASE; });
    assert.equal(apiBaseFrom({}), 'https://api.grayout.app');
    assert.equal(apiBaseFrom(null), 'https://api.grayout.app');
    assert.equal(apiBaseFrom({ apiBase: 'https://grayout-api.workers.dev/' }), 'https://grayout-api.workers.dev');
    process.env.GRAYOUT_API_BASE = 'http://localhost:8787';
    assert.equal(apiBaseFrom({ apiBase: 'https://grayout-api.workers.dev' }), 'http://localhost:8787', 'the env wins while unpackaged');
  });

  test('only https, or http on a local host', () => {
    assert.equal(normalizeBase('https://api.grayout.app'), 'https://api.grayout.app');
    assert.equal(normalizeBase('https://api.grayout.app/v2/'), 'https://api.grayout.app/v2');
    assert.equal(normalizeBase('http://localhost:8787/'), 'http://localhost:8787');
    assert.equal(normalizeBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    for (const bad of ['http://example.com', 'ftp://x', 'javascript:alert(1)', 'not a url', '', null, 42]) {
      assert.equal(normalizeBase(bad), null, String(bad));
    }
    assert.equal(apiBaseFrom({ apiBase: 'http://example.com' }), DEFAULT_API_BASE, 'a bad base falls back, it never posts frames there');
  });

  test('a URL the service returns is checked the same way', () => {
    assert.equal(safeUrl('https://checkout.stripe.com/c/pay/x'), 'https://checkout.stripe.com/c/pay/x');
    assert.equal(safeUrl('http://evil.example'), null);
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('x'.repeat(3000)), null);
    assert.equal(safeUrl(null), null);
  });
});

describe('error mapping', () => {
  test('every contract failure code maps to a kind the loop handles', () => {
    assert.deepEqual(SERVICE_ERROR_KINDS, {
      no_license: 'no_license',
      license_invalid: 'key_rejected',
      license_revoked: 'key_rejected',
      trial_expired: 'trial_expired',
      subscription_inactive: 'subscription_inactive',
      free_exhausted: 'free_exhausted',
      quota_exceeded: 'quota_exceeded',
      rate_limited: 'rate_limited',
      upstream_unavailable: 'overloaded',
      payload_too_large: 'payload_too_large',
      // Not a watch-loop code; /v1/claim's permanent failure.
      code_expired: 'claim_expired'
    });
  });

  test('an unknown body falls back to the HTTP status', () => {
    assert.equal(errorFromBody(null, 401).kind, 'key_rejected');
    assert.equal(errorFromBody(null, 429).kind, 'rate_limited');
    assert.equal(errorFromBody(null, 503).kind, 'overloaded');
    assert.equal(errorFromBody(null, 413).kind, 'payload_too_large');
    assert.equal(errorFromBody({ error: { code: 'trial_expired', message: 'Your trial ended.' } }, 402).message, 'Your trial ended.');
    assert.match(errorFromBody({}, 500).message, /returned 500/);
  });
});

describe('device id', () => {
  test('128 random bits, generated once, kept in state.json', () => {
    const a = fresh();
    const id = a.deviceId();
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(a.deviceId(), id, 'stable within a session');
    assert.equal(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).deviceId, id);
    assert.equal(fresh().deviceId(), id, 'and across instances');
  });
});

describe('activate', () => {
  test('posts the license, stores it, and records the plan', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({ body: { plan: 'monthly', status: 'active', usage: { checksUsed: 412, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' } } }));
    const r = await a.activate(LICENSE);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.grayout.app/v1/activate');
    assert.deepEqual(calls[0].body, { deviceId: a.deviceId(), license: LICENSE });
    assert.equal(r.plan, 'monthly');
    assert.equal(r.status, 'active');
    assert.deepEqual(r.usage, { checksUsed: 412, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' });
    assert.equal(r.hasLicense, true);
    assert.equal(r.licenseMasked, 'gry_live_…CB6D');
    assert.equal(r.needsSubscription, false);
    assert.equal(secrets.getLicense(), LICENSE);
  });

  test('a malformed key is refused without any network', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({}));
    for (const bad of ['', 'nope', 'sk-ant-api03-x', 'gry_live_TOOSHORT', null]) {
      const r = await a.activate(bad);
      assert.equal(r.ok, false, String(bad));
      assert.ok(r.kind === 'license_invalid' || r.kind === 'no_license');
    }
    assert.equal(calls.length, 0);
    assert.equal(secrets.getLicense(), null);
  });

  test('a lowercase paste is normalized; a rejected key is not stored', async () => {
    const a = fresh();
    stubFetch(() => ({ body: { plan: 'yearly', status: 'active' } }));
    assert.equal((await a.activate(LICENSE.toLowerCase())).ok, true);
    assert.equal(secrets.getLicense(), LICENSE);

    const b = fresh();
    stubFetch(() => ({ status: 403, body: { error: { code: 'license_revoked', message: 'That key was revoked.' } } }));
    const r = await b.activate(OTHER);
    assert.deepEqual([r.ok, r.kind, r.message], [false, 'key_rejected', 'That key was revoked.']);
    assert.equal(secrets.getLicense(), null, 'a rejected key is never written');
  });

  test('without secure storage the license is held for the session instead of lost', async () => {
    const a = fresh();
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => false });
    stubFetch(() => ({ body: { plan: 'monthly', status: 'active' } }));
    const r = await a.activate(LICENSE);
    assert.equal(r.ok, true);
    assert.equal(r.secureStorage, false);
    assert.match(r.storeMessage, /session only/);
    assert.equal(secrets.getLicense(), LICENSE);
    secrets._setSafeStorage(identity());
    secrets.useSessionLicense(null);
  });
});

describe('status', () => {
  test('no license: the free snapshot, and no request at all', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({}));
    const r = await a.status();
    assert.equal(calls.length, 0);
    assert.equal(r.ok, true);
    assert.equal(r.plan, 'free');
    assert.equal(r.usage.checksIncluded, 100);
    assert.equal(r.usage.checksUsed, 0);
    assert.equal(r.hasLicense, false);
    assert.equal(r.licenseMasked, '');
  });

  test('cached for ten minutes, refreshed by force', async () => {
    let clock = 1789905600000;
    const a = fresh({ now: () => clock });
    stubFetch(() => ({ body: { plan: 'monthly', status: 'active', usage: { checksUsed: 1, checksIncluded: 15000 } } }));
    await a.activate(LICENSE);

    const calls = stubFetch(() => ({ body: { plan: 'monthly', status: 'active', usage: { checksUsed: 2, checksIncluded: 15000 } } }));
    assert.equal((await a.status()).cached, true, 'activate primed the cache');
    assert.equal(calls.length, 0);

    clock += 10 * 60000;
    const live = await a.status();
    assert.equal(live.cached, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/v1\/status\?license=gry_live_[0-9A-Z]{24}&deviceId=[0-9a-f]{32}$/);
    assert.equal(live.usage.checksUsed, 2);

    assert.equal((await a.status()).cached, true);
    assert.equal(calls.length, 1);
    assert.equal((await a.status({ force: true })).cached, false);
    assert.equal(calls.length, 2);
  });

  test('a failure keeps the last known plan and reports the kind', async () => {
    const a = fresh();
    stubFetch(() => ({ body: { plan: 'monthly', status: 'active', usage: { checksUsed: 5, checksIncluded: 15000 } } }));
    await a.activate(LICENSE);
    stubFetch(() => ({ status: 402, body: { error: { code: 'subscription_inactive', message: 'Payment failed.' } } }));
    const r = await a.status({ force: true });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'subscription_inactive');
    assert.equal(r.plan, 'monthly', 'the last known plan still shows');
    assert.equal(r.needsSubscription, true);
  });
});

describe('checkout and claim', () => {
  test('startCheckout takes a device code, then a link', async () => {
    const a = fresh();
    const calls = stubFetch((call, n) => (n === 1
      ? { body: { deviceCode: 'dc_abc', expiresIn: 900 } }
      : { body: { url: 'https://checkout.stripe.com/c/pay/cs_test_123' } }));
    const r = await a.startCheckout('yearly');
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.equal(r.deviceCode, 'dc_abc');
    assert.equal(r.plan, 'yearly');
    assert.equal(r.expiresIn, 900);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device-code', '/v1/checkout']);
    assert.deepEqual(calls[1].body, { deviceId: a.deviceId(), plan: 'yearly', deviceCode: 'dc_abc' });
  });

  test('an unknown plan falls back to monthly; a non-https link is refused', async () => {
    const a = fresh();
    stubFetch((call, n) => (n === 1 ? { body: { deviceCode: 'dc' } } : { body: { url: 'http://evil.example/pay' } }));
    const r = await a.startCheckout('lifetime');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'unknown');
    assert.match(r.message, /checkout link/);

    const b = fresh();
    const calls = stubFetch((call, n) => (n === 1 ? { body: { deviceCode: 'dc' } } : { body: { url: 'https://checkout.stripe.com/x' } }));
    await b.startCheckout(undefined);
    assert.equal(calls[1].body.plan, 'monthly');
  });

  test('a failed device code never asks for a checkout link', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({ status: 429, body: { error: { code: 'rate_limited', message: 'Slow down.' } } }));
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'rate_limited']);
    assert.equal(calls.length, 1);
  });

  test('pollClaim waits for "ready", stores the license and activates it', async () => {
    const a = fresh();
    const calls = stubFetch((call, n) => {
      if (call.path.startsWith('/v1/claim')) return n < 3 ? { body: { status: 'pending' } } : { body: { status: 'ready', license: LICENSE } };
      return { body: { plan: 'monthly', status: 'trialing', usage: { checksUsed: 0, checksIncluded: 15000 } } };
    });
    const r = await a.pollClaim('dc_abc');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'trialing');
    assert.equal(r.hasLicense, true);
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(calls.filter(c => c.path.startsWith('/v1/claim')).length, 3);
    assert.match(calls[0].url, /\/v1\/claim\?deviceCode=dc_abc$/);
    assert.equal(calls.at(-1).path, '/v1/activate');
  });

  test('cancelClaim stops the wait; the promise resolves as cancelled', async () => {
    const a = fresh({ pollIntervalMs: 50, claimWindowMs: 60000 });
    let polls = 0;
    stubFetch(() => { polls++; return { body: { status: 'pending' } }; });
    const pending = a.pollClaim('dc_abc');
    await helpers.turns(3);
    assert.deepEqual(a.cancelClaim(), { ok: true, cancelled: true });
    const r = await pending;
    assert.deepEqual([r.ok, r.kind], [false, 'cancelled']);
    const seen = polls;
    await helpers.turns(5);
    assert.equal(polls, seen, 'polling really stopped');
    assert.deepEqual(a.cancelClaim(), { ok: true, cancelled: false });
  });

  test('it gives up after the claim window', async () => {
    let clock = 0;
    const a = fresh({ now: () => (clock += 60000), pollIntervalMs: 1, claimWindowMs: 15 * 60000 });
    stubFetch(() => ({ body: { status: 'pending' } }));
    const r = await a.pollClaim('dc_abc');
    assert.deepEqual([r.ok, r.kind], [false, 'timeout']);
  });

  test('a revoked code gives up at once; an empty code never calls', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({ status: 403, body: { error: { code: 'license_invalid', message: 'Unknown code.' } } }));
    const r = await a.pollClaim('dc_abc');
    assert.deepEqual([r.ok, r.kind], [false, 'key_rejected']);
    assert.equal(calls.length, 1);
    assert.equal((await a.pollClaim('  ')).ok, false);
    assert.equal(calls.length, 1);
  });

  test('an expired device code stops the poll at once instead of burning the window', async () => {
    // The service answers 404 code_expired for a code that has expired or never
    // existed. That is permanent: polling it for 15 minutes is ~450 pointless
    // requests and a generic timeout message instead of a useful one.
    const a = fresh({ pollIntervalMs: 1, claimWindowMs: 15 * 60000 });
    const calls = stubFetch(() => ({ status: 404, body: { error: { code: 'code_expired', message: 'That device code has expired.' } } }));
    const r = await a.pollClaim('dc_abc');
    assert.deepEqual([r.ok, r.kind], [false, 'claim_expired']);
    assert.equal(calls.length, 1);
  });

  test('a 400 stops the poll: the same request would only be sent again', async () => {
    const a = fresh({ pollIntervalMs: 1, claimWindowMs: 15 * 60000 });
    const calls = stubFetch(() => ({ status: 400, body: { error: { code: 'bad_request', message: 'That device code is not the right shape.' } } }));
    const r = await a.pollClaim('dc_abc');
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
  });

  test('a transient failure is retried rather than given up on', async () => {
    const a = fresh();
    const calls = stubFetch((call, n) => {
      if (call.path.startsWith('/v1/claim')) {
        if (n === 1) return new Error('fetch failed');
        return n < 3 ? { status: 500, body: {} } : { body: { status: 'ready', license: LICENSE } };
      }
      return { body: { plan: 'monthly', status: 'active' } };
    });
    const r = await a.pollClaim('dc_abc');
    assert.equal(r.ok, true);
    assert.equal(calls.filter(c => c.path.startsWith('/v1/claim')).length, 3);
  });
});

describe('billing portal', () => {
  test('needs a license, then returns the link', async () => {
    const a = fresh();
    const calls = stubFetch(() => ({ body: { url: 'https://billing.stripe.com/p/session/x' } }));
    const none = await a.portalUrl();
    assert.deepEqual([none.ok, none.kind], [false, 'no_license']);
    assert.equal(calls.length, 0);

    stubFetch(() => ({ body: { plan: 'monthly', status: 'active' } }));
    await a.activate(LICENSE);
    const withKey = stubFetch(() => ({ body: { url: 'https://billing.stripe.com/p/session/x' } }));
    const r = await a.portalUrl();
    assert.deepEqual(r, { ok: true, url: 'https://billing.stripe.com/p/session/x' });
    assert.equal(withKey[0].method, 'POST');
    assert.deepEqual(withKey[0].body, { license: LICENSE });
  });
});

describe('snapshot, usage and problems', () => {
  test('the free taste counts down from 100 and then needs a subscription', async () => {
    const a = fresh();
    assert.equal(a.snapshot().usage.checksIncluded, 100);
    a.noteCheck({ plan: 'free', usage: { checksUsed: 99, checksIncluded: 100 } });
    assert.equal(a.snapshot().needsSubscription, false);
    a.noteCheck({ plan: 'free', usage: { checksUsed: 100, checksIncluded: 100 } });
    assert.equal(a.snapshot().needsSubscription, true);
  });

  test('a check reports the subscription state without renaming the plan', async () => {
    const a = fresh();
    stubFetch(() => ({ body: { plan: 'yearly', status: 'active', usage: { checksUsed: 1, checksIncluded: 15000 } } }));
    await a.activate(LICENSE);
    a.noteCheck({ plan: 'past_due', usage: { checksUsed: 40, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' } });
    const s = a.snapshot();
    assert.equal(s.plan, 'yearly', 'the plan name comes from activate/status, not from a check');
    assert.equal(s.status, 'past_due');
    assert.equal(s.usage.checksUsed, 40);
    assert.equal(s.needsSubscription, true);
  });

  test('the free counters do not carry over into a paid plan', async () => {
    const a = fresh();
    a.noteCheck({ plan: 'free', usage: { checksUsed: 100, checksIncluded: 100 } });
    assert.equal(a.snapshot().needsSubscription, true);
    stubFetch(() => ({ body: { plan: 'monthly', status: 'active' } }));   // no usage in the answer
    const r = await a.activate(LICENSE);
    assert.equal(r.usage.checksIncluded, 15000, 'the paid allowance, not the free one');
    assert.equal(r.usage.checksUsed, 0);
    assert.equal(r.needsSubscription, false);
  });

  test('noteProblem flags the plan until the next good check', () => {
    const a = fresh();
    a.noteProblem('trial_expired');
    assert.equal(a.snapshot().problem, 'trial_expired');
    assert.equal(a.snapshot().needsSubscription, true);
    a.noteCheck({ plan: 'active', usage: { checksUsed: 1, checksIncluded: 15000 } });
    assert.equal(a.snapshot().problem, null);
    assert.equal(a.snapshot().needsSubscription, false);
    a.noteProblem('overloaded');
    assert.equal(a.snapshot().problem, null, 'a busy service is not a plan problem');
  });

  test('a bad subscription status needs attention on its own', async () => {
    const a = fresh();
    stubFetch(() => ({ body: { plan: 'monthly', status: 'past_due', usage: { checksUsed: 10, checksIncluded: 15000 } } }));
    const r = await a.activate(LICENSE);
    assert.equal(r.needsSubscription, true);
    assert.equal(a.snapshot().status, 'past_due');
  });

  test('clearing the license goes back to the free snapshot', async () => {
    const a = fresh();
    stubFetch(() => ({ body: { plan: 'monthly', status: 'active', usage: { checksUsed: 10, checksIncluded: 15000 } } }));
    await a.activate(LICENSE);
    const after2 = a.clearLicense();
    assert.equal(after2.hasLicense, false);
    assert.equal(after2.plan, 'free');
    assert.equal(after2.usage.checksIncluded, 100);
    assert.equal(secrets.getLicense(), null);
  });

  test('usage counters survive a restart', async () => {
    const a = fresh();
    a.noteCheck({ plan: 'free', usage: { checksUsed: 7, checksIncluded: 100 } });
    state._reset();
    assert.equal(createAccount({ getConfig: () => ({}) }).snapshot().usage.checksUsed, 7);
  });
});

describe('failures never escape', () => {
  test('a network error answers with kind network', async () => {
    const a = fresh();
    stubFetch(() => new Error('fetch failed'));
    for (const call of [a.activate(LICENSE), a.startCheckout('monthly')]) {
      const r = await call;
      assert.deepEqual([r.ok, r.kind], [false, 'network'], JSON.stringify(r));
    }
  });

  test('a call that never answers is aborted and reads as network', async () => {
    const a = fresh({ timeoutMs: 10 });
    globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    });
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'network']);
    assert.match(r.message, /did not answer in time/);
  });

  test('a body that is not JSON is still an answer, not a crash', async () => {
    const a = fresh();
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('not json'); } });
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'unknown']);
  });
});
