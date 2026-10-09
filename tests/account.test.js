'use strict';
// The hosted-service client, against the v3 contract (docs/API-CONTRACT.md).
// fetch is stubbed throughout: no test here touches the network, and every one
// of these calls must answer rather than throw.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('account');
const paths = require('../src/paths');
const secrets = require('../src/secrets');
const state = require('../src/state');
const configMod = require('../src/config');
const accountMod = require('../src/account');
const {
  createAccount, apiBaseFrom, safeUrl, errorFromBody, nextClaimDelay,
  SERVICE_ERROR_KINDS, MESSAGES, DEVICE_ID_RE, DEVICE_TOKEN_RE
} = accountMod;

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

const BASE = 'https://grayout-api.test-sub.workers.dev';
const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
const TEST_LICENSE = 'gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
const OTHER = 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ23';
const DEVICE = 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G';
const TOKEN = 'abcdefghijABCDEFGHIJ0123456789-_abcdefghijk';
const DEVICE2 = 'dev_1A2B3C4D5E6F7G8H9J0K1M2N3P';
const TOKEN2 = 'ZYXWVUTSRQzyxwvutsrq9876543210_-zyxwvutsrqp';
const CODE = '7KQ2-R9XW';

const identity = () => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(s),
  decryptString: b => b.toString()
});

function reply({ status = 200, body = {}, headers = {} } = {}) {
  const h = { 'x-grayout-request-id': 'req_test', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => h[String(name).toLowerCase()] ?? null },
    json: async () => body
  };
}

const ACCOUNT = {
  plan: 'active', status: 'active', service: true, interval: 'monthly', cancelAtPeriodEnd: false,
  periodEnd: '2026-11-07T14:03:11Z', trialEnd: null,
  usage: { checksUsed: 412, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' }
};
const err = (status, code, message = `plain sentence for ${code}`, extra = {}) =>
  ({ status, body: { error: { code, message, ...extra } } });

/**
 * A scripted stand-in for the service. `routes` maps a path to a handler
 * (call, nth call to that path) => reply spec | Error. /v1/device mints
 * DEVICE/TOKEN unless a test overrides it. Every call is recorded.
 */
function service(routes = {}) {
  const calls = [];
  const all = { '/v1/device': () => ({ body: { deviceId: DEVICE, deviceToken: TOKEN } }), ...routes };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const call = {
      url: u,
      path: u.startsWith(BASE) ? u.slice(BASE.length) : u,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null
    };
    calls.push(call);
    const handler = all[call.path];
    const nth = calls.filter(c => c.path === call.path).length;
    const out = handler ? await handler(call, nth) : err(404, 'not_found', 'no such route in this test');
    if (out instanceof Error) throw out;
    return reply(out || {});
  };
  calls.to = p => calls.filter(c => c.path === p);
  return calls;
}

function resetStores() {
  secrets._setSafeStorage(identity());
  try { secrets.clearLicense(); } catch {}
  try { secrets.useSessionLicense(null); } catch {}
  try { secrets.clearDeviceToken(); } catch {}
  state.update(s => { s.account = null; s.deviceId = null; });
}

/** A fresh client talking to BASE, with fast polling for tests. */
function fresh(over = {}) {
  resetStores();
  return createAccount({
    getConfig: () => ({ apiBase: BASE }),
    claimFastMs: 1, claimSlowMs: 1, claimFastForMs: 10, claimWindowMs: 300,
    ...over
  });
}

/** The same, with this Mac already registered. */
function registered(over = {}) {
  const a = fresh(over);
  state.update(s => { s.deviceId = DEVICE; });
  secrets.setDeviceToken(TOKEN);
  return a;
}

/** Registered and holding a license. */
function licensed(over = {}) {
  const a = registered(over);
  secrets.setLicense(LICENSE);
  return a;
}

beforeEach(() => { globalThis.fetch = REAL_FETCH; });

/* ======================================================================= */

describe('the service address (contract section 3)', () => {
  test('the built-in address is one deploy-time constant, and in git it is the placeholder or a real https URL', () => {
    const v = configMod.DEFAULT_API_BASE;
    assert.equal(typeof v, 'string');
    assert.ok(v === '__GRAYOUT_API_BASE__' || /^https:\/\/[^/]+/.test(v), `unexpected DEFAULT_API_BASE ${v}`);
    assert.equal(/grayout\.app/.test(v), false, 'never the unowned grayout.app domain');
    // The placeholder must not parse as a URL: an unfilled build calls nobody.
    assert.equal(configMod.normalizeBase('__GRAYOUT_API_BASE__'), null);
  });

  test('exactly one line in src/ names the service, and no code names grayout.app', () => {
    // Comments may mention hosts; code may not, except the one deploy-time line.
    const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const SRC = path.join(__dirname, '..', 'src');
    const defining = [];
    for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.js'))) {
      const code = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
      for (const line of code.split('\n')) {
        if (/const DEFAULT_API_BASE\s*=/.test(line)) { defining.push(f); continue; }
        assert.equal(/grayout\.app|workers\.dev/.test(line), false, `${f} names a host in code: ${line.trim()}`);
      }
    }
    assert.deepEqual(defining, ['config.js']);
  });

  test('order: GRAYOUT_API_BASE (unpackaged), then config.apiBase, then the built-in address', t => {
    t.after(() => { delete process.env.GRAYOUT_API_BASE; });
    assert.equal(apiBaseFrom({}, '__GRAYOUT_API_BASE__'), null, 'unfilled build: no address at all');
    assert.equal(apiBaseFrom(null, '__GRAYOUT_API_BASE__'), null);
    assert.equal(apiBaseFrom({}, ''), null, 'empty means not configured too');
    assert.equal(apiBaseFrom({}, 'https://grayout-api.sub.workers.dev/'), 'https://grayout-api.sub.workers.dev', 'a filled-in build');
    assert.equal(apiBaseFrom({ apiBase: BASE + '/' }, '__GRAYOUT_API_BASE__'), BASE);
    process.env.GRAYOUT_API_BASE = 'http://localhost:8787';
    assert.equal(apiBaseFrom({ apiBase: BASE }), 'http://localhost:8787', 'the env wins while unpackaged');
  });

  test('only https, or http on a local host; never credentials in the address', () => {
    const { normalizeBase } = configMod;
    assert.equal(normalizeBase(BASE), BASE);
    assert.equal(normalizeBase(BASE + '/v2/'), BASE + '/v2');
    assert.equal(normalizeBase('http://localhost:8787/'), 'http://localhost:8787');
    assert.equal(normalizeBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    assert.equal(normalizeBase('http://[::1]:8787'), 'http://[::1]:8787');
    for (const bad of ['http://example.com', 'ftp://x', 'javascript:alert(1)', 'not a url', '', null, 42, 'https://user:pw@example.com']) {
      assert.equal(normalizeBase(bad), null, String(bad));
    }
    assert.equal(apiBaseFrom({ apiBase: 'http://example.com' }, '__GRAYOUT_API_BASE__'), null, 'a bad base is dropped, never used');
  });

  test('a URL the service returns is checked the same way', () => {
    assert.equal(safeUrl('https://checkout.stripe.com/c/pay/x'), 'https://checkout.stripe.com/c/pay/x');
    assert.equal(safeUrl('http://evil.example'), null);
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('x'.repeat(3000)), null);
    assert.equal(safeUrl(null), null);
  });

  test('not connected: every call answers not_connected and nothing touches the network', async () => {
    resetStores();
    secrets.setLicense(LICENSE);
    const a = createAccount({ getConfig: () => ({}), builtInBase: '__GRAYOUT_API_BASE__' });
    const calls = service();
    assert.equal(a.configured(), false);
    assert.equal(a.snapshot().configured, false);
    for (const [name, call] of [
      ['activate', () => a.activate(OTHER)],
      ['status', () => a.status({ force: true })],
      ['startCheckout', () => a.startCheckout('monthly')],
      ['pollClaim', () => a.pollClaim(CODE)],
      ['restore', () => a.restore({ force: true })],
      ['refresh', () => a.refresh({ force: true })],
      ['portalUrl', () => a.portalUrl()],
      ['check', () => a.check({ displays: ['F'], webcam: null, context: {} })],
      ['ensureDevice', () => a.ensureDevice()]
    ]) {
      const r = await call();
      assert.equal(r.ok, false, name);
      assert.equal(r.kind, 'not_connected', name);
      assert.equal(r.message, MESSAGES.notConnected, name);
    }
    assert.equal(calls.length, 0, 'no request at all');
    assert.equal(MESSAGES.notConnected, 'This build of Grayout is not connected to the Grayout service yet.');
  });
});

describe('error codes (contract section 8)', () => {
  test('every code the app handles by name has a kind', () => {
    for (const code of ['device_unverified', 'no_license', 'license_invalid', 'license_revoked', 'trial_expired',
      'subscription_inactive', 'free_exhausted', 'quota_exceeded', 'rate_limited', 'upstream_unavailable',
      'payload_too_large', 'code_expired', 'already_subscribed', 'not_configured']) {
      assert.ok(SERVICE_ERROR_KINDS[code], code);
    }
    // Most keep their own name, so the windows can match on the contract's words.
    for (const code of ['device_unverified', 'license_invalid', 'license_revoked', 'code_expired', 'already_subscribed', 'not_configured']) {
      assert.equal(SERVICE_ERROR_KINDS[code], code);
    }
    // These reuse the loop's "busy, try again later".
    assert.equal(SERVICE_ERROR_KINDS.upstream_unavailable, 'overloaded');
    assert.equal(SERVICE_ERROR_KINDS.internal_error, 'overloaded');
  });

  test('an unknown body falls back to the HTTP status, and never guesses a plan problem', () => {
    assert.equal(errorFromBody(null, 401).kind, 'unknown', 'a bare 401 is not a license problem');
    assert.equal(errorFromBody(null, 403).kind, 'unknown');
    assert.equal(errorFromBody(null, 429).kind, 'rate_limited');
    assert.equal(errorFromBody(null, 503).kind, 'overloaded');
    assert.equal(errorFromBody(null, 413).kind, 'payload_too_large');
    assert.equal(errorFromBody({ error: { code: 'trial_expired', message: 'Your trial ended.' } }, 402).message, 'Your trial ended.');
    assert.match(errorFromBody({}, 500).message, /returned 500/);
  });

  test('the extra fields: retryAfter (body or header), reason, portalUrl (checked)', () => {
    assert.equal(errorFromBody({ error: { code: 'rate_limited', message: 'x', retryAfter: 60 } }, 429).retryAfter, 60);
    assert.equal(errorFromBody({ error: { code: 'rate_limited', message: 'x' } }, 429, '30').retryAfter, 30);
    assert.equal(errorFromBody({ error: { code: 'rate_limited', message: 'x' } }, 429).retryAfter, undefined);
    assert.equal(errorFromBody({ error: { code: 'free_exhausted', message: 'x', reason: 'daily_budget' } }, 402).reason, 'daily_budget');
    assert.equal(errorFromBody({ error: { code: 'free_exhausted', message: 'x', reason: 'weird' } }, 402).reason, undefined);
    assert.equal(errorFromBody({ error: { code: 'already_subscribed', message: 'x', portalUrl: 'https://billing.stripe.com/p/session/x' } }, 409).portalUrl, 'https://billing.stripe.com/p/session/x');
    assert.equal(errorFromBody({ error: { code: 'already_subscribed', message: 'x', portalUrl: 'javascript:alert(1)' } }, 409).portalUrl, null);
    assert.equal(errorFromBody({ error: { code: 'already_subscribed', message: 'x', portalUrl: null } }, 409).portalUrl, null);
  });
});

describe('device identity (contract 4.1)', () => {
  test('the first device-scoped call registers this Mac with POST /v1/device {}', async () => {
    const a = fresh();
    const calls = service({ '/v1/device-code': () => ({ body: { deviceCode: CODE, expiresIn: 3600 } }), '/v1/checkout': () => ({ body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1', trial: true } }) });
    assert.equal(a.deviceId(), null, 'nothing minted just by asking');
    const r = await a.startCheckout('monthly');
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device', '/v1/device-code', '/v1/checkout']);
    assert.deepEqual(calls[0].body, {});
    assert.equal(calls[0].method, 'POST');
    assert.equal(a.deviceId(), DEVICE);
    assert.equal(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).deviceId, DEVICE, 'the id lives in state.json');
    assert.equal(fs.readFileSync(paths.STATE_PATH, 'utf8').includes(TOKEN), false, 'the token never does');
    assert.equal(secrets.getDeviceToken(), TOKEN, 'the token lives in secrets.bin');
    assert.equal(JSON.parse(fs.readFileSync(paths.SECRETS_PATH, 'utf8')).grayoutDeviceToken, TOKEN);
    for (const c of calls.slice(1)) {
      assert.equal(c.body.deviceId, DEVICE, c.path);
      assert.equal(c.body.deviceToken, TOKEN, c.path);
    }
  });

  test('a registered Mac never registers again', async () => {
    const a = registered();
    const calls = service({ '/v1/restore': () => ({ body: { status: 'none' } }) });
    await a.restore({ force: true });
    await a.restore({ force: true });
    assert.equal(calls.to('/v1/device').length, 0);
    assert.equal(calls.to('/v1/restore').length, 2);
  });

  test('calls made at the same moment share one registration', async () => {
    const a = fresh();
    let release;
    const gate = new Promise(r => { release = r; });
    const calls = service({
      '/v1/device': async () => { await gate; return { body: { deviceId: DEVICE, deviceToken: TOKEN } }; },
      '/v1/restore': () => ({ body: { status: 'none' } })
    });
    const p = Promise.all([a.ensureDevice(), a.ensureDevice(), a.ensureDevice()]);
    await helpers.turns(3);
    release();
    const out = await p;
    assert.deepEqual(out.map(o => o.deviceId), [DEVICE, DEVICE, DEVICE]);
    assert.equal(calls.to('/v1/device').length, 1);
  });

  test('device_unverified: register again once, retry once, and carry on', async () => {
    const a = licensed();
    let mints = 0;
    const calls = service({
      '/v1/device': () => { mints++; return { body: { deviceId: DEVICE2, deviceToken: TOKEN2 } }; },
      '/v1/status': c => (c.body.deviceId === DEVICE ? err(401, 'device_unverified') : { body: ACCOUNT })
    });
    const r = await a.status({ force: true });
    assert.equal(r.ok, true);
    assert.equal(mints, 1);
    assert.deepEqual(calls.map(c => [c.path, c.body.deviceId || null]), [['/v1/status', DEVICE], ['/v1/device', null], ['/v1/status', DEVICE2]]);
    assert.equal(a.deviceId(), DEVICE2);
    assert.equal(secrets.getDeviceToken(), TOKEN2);
  });

  test('device_unverified twice: stop after one re-registration and say so plainly', async () => {
    const a = licensed();
    const calls = service({
      '/v1/device': () => ({ body: { deviceId: DEVICE2, deviceToken: TOKEN2 } }),
      '/v1/status': () => err(401, 'device_unverified', 'Device not recognized.')
    });
    const r = await a.status({ force: true });
    assert.deepEqual([r.ok, r.kind], [false, 'device_unverified']);
    assert.equal(r.message, 'Grayout could not register this Mac with the service. Try again later.');
    assert.deepEqual(calls.map(c => c.path), ['/v1/status', '/v1/device', '/v1/status'], 'no loop of registrations');
  });

  test('an identity of the wrong shape is refused and nothing is stored', async () => {
    const a = fresh();
    service({ '/v1/device': () => ({ body: { deviceId: 'a'.repeat(32), deviceToken: 'short' } }) });
    const r = await a.ensureDevice();
    assert.equal(r.ok, false);
    assert.equal(a.deviceId(), null);
    assert.equal(secrets.getDeviceToken(), null);
    assert.match(DEVICE, DEVICE_ID_RE);
    assert.match(TOKEN, DEVICE_TOKEN_RE);
  });

  test('a v2 random hex id left in state.json is ignored: the service mints the identity now', async () => {
    const a = fresh();
    state.update(s => { s.deviceId = 'a'.repeat(32); });
    const calls = service();
    const r = await a.ensureDevice();
    assert.equal(r.deviceId, DEVICE);
    assert.equal(calls.to('/v1/device').length, 1);
  });

  test('a refused registration (rate limit) answers with the wait, and stores nothing', async () => {
    const a = fresh();
    service({ '/v1/device': () => err(429, 'rate_limited', 'Too many new devices.', { retryAfter: 60 }) });
    const r = await a.restore({ force: true });
    assert.deepEqual([r.ok, r.kind, r.retryAfter], [false, 'rate_limited', 60]);
    assert.equal(a.deviceId(), null);
  });

  test('without a keychain the token is held for this session only', async () => {
    const a = fresh();
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => false });
    service();
    const r = await a.ensureDevice();
    assert.equal(r.ok, true);
    assert.equal(secrets.getDeviceToken(), TOKEN);
    secrets.useSessionDeviceToken(null);
    secrets._setSafeStorage(identity());
  });
});

describe('no credential ever travels in a URL (contract 5, finding 16)', () => {
  test('every call is a JSON POST to a bare path; the key and token are only in bodies', async () => {
    const a = licensed();
    const calls = service({
      '/v1/status': () => ({ body: ACCOUNT }),
      '/v1/activate': () => ({ body: ACCOUNT }),
      '/v1/portal': () => ({ body: { url: 'https://billing.stripe.com/p/session/x' } }),
      '/v1/restore': () => ({ body: { status: 'none' } }),
      '/v1/device-code': () => ({ body: { deviceCode: CODE, expiresIn: 3600 } }),
      '/v1/checkout': () => ({ body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1', trial: false } }),
      '/v1/claim': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/check': () => ({ body: { verdict: { off_task: false, activity: 'x', confidence: 'high' } } })
    });
    await a.status({ force: true });
    await a.activate(LICENSE);
    await a.portalUrl();
    await a.restore({ force: true });
    await a.startCheckout('yearly');
    await a.pollClaim(CODE);
    await a.check({ displays: ['F'], webcam: null, context: {} });
    assert.ok(calls.length >= 8);
    for (const c of calls) {
      assert.equal(c.method, 'POST', c.path);
      assert.equal(c.url, BASE + c.path, 'no query string');
      assert.equal(c.url.includes('?'), false);
      assert.equal(c.url.includes('gry_'), false);
      assert.equal(c.url.includes(TOKEN), false);
      assert.equal(c.headers['content-type'], 'application/json');
    }
  });
});

describe('activate (contract 6.8)', () => {
  test('posts the license with the device identity, stores it, and records the account object', async () => {
    const a = registered();
    const calls = service({ '/v1/activate': () => ({ body: ACCOUNT }) });
    const r = await a.activate(LICENSE);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, BASE + '/v1/activate');
    assert.deepEqual(calls[0].body, { license: LICENSE, deviceId: DEVICE, deviceToken: TOKEN });
    assert.equal(r.status, 'active');
    assert.equal(r.plan, 'active', 'plan and status carry the same value in v3');
    assert.equal(r.interval, 'monthly');
    assert.equal(r.service, true);
    assert.equal(r.periodEnd, '2026-11-07T14:03:11Z');
    assert.deepEqual(r.usage, { checksUsed: 412, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' });
    assert.equal(r.hasLicense, true);
    assert.equal(r.licenseMasked, 'gry_live_…CB6D');
    assert.equal(r.needsSubscription, false);
    assert.equal(secrets.getLicense(), LICENSE);
  });

  test('a sandbox key (gry_test_) is accepted and kept as a test key', async () => {
    const a = registered();
    const calls = service({ '/v1/activate': () => ({ body: ACCOUNT }) });
    const r = await a.activate(TEST_LICENSE.toLowerCase());
    assert.equal(r.ok, true);
    assert.equal(calls[0].body.license, TEST_LICENSE);
    assert.equal(secrets.getLicense(), TEST_LICENSE);
    assert.equal(r.licenseMasked, 'gry_test_…CB6D');
  });

  test('a malformed key is refused without any network', async () => {
    const a = registered();
    const calls = service();
    for (const bad of ['', 'nope', 'sk-ant-api03-x', 'gry_live_TOOSHORT', null]) {
      const r = await a.activate(bad);
      assert.equal(r.ok, false, String(bad));
      assert.ok(r.kind === 'license_invalid' || r.kind === 'no_license');
    }
    assert.equal(calls.length, 0);
    assert.equal(secrets.getLicense(), null);
  });

  test('license_invalid and license_revoked are not stored and keep their own kind and sentence', async () => {
    const a = registered();
    service({ '/v1/activate': () => err(401, 'license_invalid', 'That license key is not one Grayout issued.') });
    const bad = await a.activate(OTHER);
    assert.deepEqual([bad.ok, bad.kind, bad.message], [false, 'license_invalid', 'That license key is not one Grayout issued.']);
    service({ '/v1/activate': () => err(403, 'license_revoked', 'This subscription was refunded or disputed. Email help@example.com to start again.') });
    const gone = await a.activate(OTHER);
    assert.deepEqual([gone.ok, gone.kind], [false, 'license_revoked']);
    assert.match(gone.message, /refunded or disputed/);
    assert.equal(secrets.getLicense(), null, 'a refused key is never written');
  });

  test('a canceled license still activates; service: false says checks are not served', async () => {
    const a = registered();
    service({ '/v1/activate': () => ({ body: { ...ACCOUNT, plan: 'canceled', status: 'canceled', service: false } }) });
    const r = await a.activate(LICENSE);
    assert.equal(r.ok, true);
    assert.equal(r.service, false);
    assert.equal(r.status, 'canceled');
    assert.equal(r.needsSubscription, true);
  });

  test('without secure storage the license is held for the session instead of lost', async () => {
    const a = registered();
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => false });
    secrets.useSessionDeviceToken(TOKEN);
    service({ '/v1/activate': () => ({ body: ACCOUNT }) });
    const r = await a.activate(LICENSE);
    assert.equal(r.ok, true);
    assert.equal(r.secureStorage, false);
    assert.match(r.storeMessage, /session only/);
    assert.equal(secrets.getLicense(), LICENSE);
    secrets._setSafeStorage(identity());
    secrets.useSessionLicense(null);
    secrets.useSessionDeviceToken(null);
  });
});

describe('status (contract 6.9)', () => {
  test('no license: the free snapshot, and no request at all', async () => {
    const a = registered();
    const calls = service();
    const r = await a.status();
    assert.equal(calls.length, 0);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'free');
    assert.equal(r.usage.checksIncluded, 100);
    assert.equal(r.usage.checksUsed, 0);
    assert.equal(r.hasLicense, false);
    assert.equal(r.licenseMasked, '');
  });

  test('POST /v1/status with the license in the body; cached ten minutes; refreshed by force', async () => {
    let clock = 1789905600000;
    const a = licensed({ now: () => clock });
    let used = 1;
    const calls = service({ '/v1/status': () => ({ body: { ...ACCOUNT, usage: { ...ACCOUNT.usage, checksUsed: used++ } } }) });
    await a.status({ force: true });
    assert.equal((await a.status()).cached, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { license: LICENSE, deviceId: DEVICE, deviceToken: TOKEN });

    clock += 10 * 60000;
    const live = await a.status();
    assert.equal(live.cached, false);
    assert.equal(calls.length, 2);
    assert.equal(live.usage.checksUsed, 2);
    assert.equal((await a.status({ force: true })).cached, false);
    assert.equal(calls.length, 3);
  });

  test('a failure keeps the last known plan and reports the kind', async () => {
    const a = licensed();
    service({ '/v1/status': () => ({ body: ACCOUNT }) });
    await a.status({ force: true });
    service({ '/v1/status': () => err(403, 'license_revoked', 'This subscription was refunded or disputed.') });
    const r = await a.status({ force: true });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'license_revoked');
    assert.equal(r.interval, 'monthly', 'the last known plan still shows');
    assert.equal(r.problem, 'license_revoked');
    assert.equal(r.needsSubscription, true);
  });

  test('trial and cancel facts are kept for the windows', async () => {
    const a = licensed();
    service({ '/v1/status': () => ({ body: { ...ACCOUNT, plan: 'trialing', status: 'trialing', cancelAtPeriodEnd: true, trialEnd: '2026-10-15T00:00:00Z', periodEnd: '2026-10-15T00:00:00Z' } }) });
    const r = await a.status({ force: true });
    assert.equal(r.status, 'trialing');
    assert.equal(r.cancelAtPeriodEnd, true);
    assert.equal(r.trialEnd, '2026-10-15T00:00:00Z');
  });

  test('an unknown status string from the service is not repeated as fact', async () => {
    const a = licensed();
    service({ '/v1/status': () => ({ body: { ...ACCOUNT, plan: 'weird', status: 'weird' } }) });
    assert.equal((await a.status({ force: true })).status, 'unknown');
  });
});

describe('restore and refresh (contract 6.7, 6.6)', () => {
  test('"ready" stores the key and reads the plan', async () => {
    const a = registered();
    const calls = service({
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: ACCOUNT })
    });
    const r = await a.restore({ force: true });
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(r.status, 'active');
    assert.deepEqual(calls.map(c => c.path), ['/v1/restore', '/v1/status']);
    assert.deepEqual(calls[0].body, { deviceId: DEVICE, deviceToken: TOKEN });
  });

  test('"none" is an answer, not an error; a revoked key is refused', async () => {
    const a = registered();
    service({ '/v1/restore': () => ({ body: { status: 'none' } }) });
    const none = await a.restore({ force: true });
    assert.deepEqual([none.ok, none.restored], [true, false]);
    service({ '/v1/restore': () => err(403, 'license_revoked') });
    const gone = await a.restore({ force: true });
    assert.deepEqual([gone.ok, gone.kind], [false, 'license_revoked']);
    assert.equal(secrets.getLicense(), null);
  });

  test('unforced restores are asked at most once a minute', async () => {
    let clock = 1789905600000;
    const a = registered({ now: () => clock });
    const calls = service({ '/v1/restore': () => ({ body: { status: 'none' } }) });
    await a.restore();
    const second = await a.restore();
    assert.equal(second.skipped, true);
    assert.equal(calls.length, 1);
    clock += 61000;
    await a.restore();
    assert.equal(calls.length, 2);
  });

  test('refresh: re-read the plan with a key; ask for the key back without one', async () => {
    const withKey = licensed();
    let calls = service({ '/v1/status': () => ({ body: ACCOUNT }) });
    assert.equal((await withKey.refresh({ force: true })).ok, true);
    assert.deepEqual(calls.map(c => c.path), ['/v1/status']);

    const noKey = registered();
    calls = service({ '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }), '/v1/status': () => ({ body: ACCOUNT }) });
    const r = await noKey.refresh({ force: true });
    assert.equal(r.restored, true, 'a purchase that finished after the app stopped waiting is collected');
    assert.equal(secrets.getLicense(), LICENSE);
  });

  test('refresh on a Mac that never registered asks nothing and registers nothing', async () => {
    const a = fresh();
    const calls = service();
    const r = await a.refresh({ force: true });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 0);
  });
});

describe('the watch loop call (contract 6.11)', () => {
  const PAYLOAD = { displays: ['FRAME'], webcam: null, context: { workDescription: '', frontApp: 'Code', canvasTasks: [], fileTasks: [] } };

  test('adds the device identity and the license to the frames', async () => {
    const a = licensed();
    const calls = service({ '/v1/check': () => ({ body: { verdict: {}, plan: 'active', service: true } }) });
    const r = await a.check(PAYLOAD);
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].body, { ...PAYLOAD, license: LICENSE, deviceId: DEVICE, deviceToken: TOKEN });
  });

  test('the free taste sends no license field at all', async () => {
    const a = registered();
    const calls = service({ '/v1/check': () => ({ body: { verdict: {} } }) });
    await a.check(PAYLOAD);
    assert.equal('license' in calls[0].body, false);
  });

  test('no_license: get the key back and try once more; never "subscribe"', async () => {
    const a = registered();
    const calls = service({
      '/v1/check': c => (c.body.license ? { body: { verdict: {}, plan: 'active' } } : err(401, 'no_license')),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: ACCOUNT })
    });
    const r = await a.check(PAYLOAD);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map(c => c.path), ['/v1/check', '/v1/restore', '/v1/status', '/v1/check']);
    assert.equal(calls.at(-1).body.license, LICENSE);
  });

  test('no_license with nothing to restore answers no_license once', async () => {
    const a = registered();
    const calls = service({ '/v1/check': () => err(401, 'no_license'), '/v1/restore': () => ({ body: { status: 'none' } }) });
    const r = await a.check(PAYLOAD);
    assert.deepEqual([r.ok, r.kind], [false, 'no_license']);
    assert.equal(calls.to('/v1/check').length, 1);
  });

  test('the check gets the long timeout; everything else the short one', async () => {
    const a = registered({ timeoutMs: 5, checkTimeoutMs: 40 });
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      const started = Date.now();
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error(`aborted after ${Date.now() - started}`), { name: 'AbortError' })));
    });
    const t0 = Date.now();
    const r = await a.check(PAYLOAD);
    assert.equal(r.kind, 'network');
    assert.ok(Date.now() - t0 >= 30, 'waited for the check timeout, not the 5 ms one');
  });
});

describe('checkout (contract 6.5)', () => {
  test('a device code, then a link; the body carries plan, code and identity', async () => {
    const a = registered();
    const calls = service({
      '/v1/device-code': () => ({ body: { deviceCode: CODE, expiresIn: 3600 } }),
      '/v1/checkout': () => ({ body: { url: 'https://checkout.stripe.com/c/pay/cs_test_123', sessionId: 'cs_test_123', trial: true } })
    });
    const r = await a.startCheckout('yearly');
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.equal(r.deviceCode, CODE);
    assert.equal(r.plan, 'yearly');
    assert.equal(r.trial, true);
    assert.equal(r.expiresIn, 3600);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device-code', '/v1/checkout']);
    assert.deepEqual(calls[0].body, { deviceId: DEVICE, deviceToken: TOKEN });
    assert.deepEqual(calls[1].body, { plan: 'yearly', deviceCode: CODE, deviceId: DEVICE, deviceToken: TOKEN });
  });

  test('an unknown plan means monthly; a non-https link is refused', async () => {
    const a = registered();
    service({ '/v1/device-code': () => ({ body: { deviceCode: CODE } }), '/v1/checkout': () => ({ body: { url: 'http://evil.example/pay' } }) });
    const r = await a.startCheckout('lifetime');
    assert.deepEqual([r.ok, r.kind], [false, 'unknown']);
    assert.match(r.message, /checkout link/);

    const calls = service({ '/v1/device-code': () => ({ body: { deviceCode: CODE } }), '/v1/checkout': () => ({ body: { url: 'https://checkout.stripe.com/x' } }) });
    await a.startCheckout(undefined);
    assert.equal(calls[1].body.plan, 'monthly');
  });

  test('a failed device code never asks for a checkout link', async () => {
    const a = registered();
    const calls = service({ '/v1/device-code': () => err(429, 'rate_limited', 'Slow down.', { retryAfter: 60 }) });
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind, r.retryAfter], [false, 'rate_limited', 60]);
    assert.equal(calls.length, 1);
  });

  test('already_subscribed: no second purchase; the billing link comes back and the key is restored', async () => {
    const a = registered();
    const calls = service({
      '/v1/device-code': () => ({ body: { deviceCode: CODE, expiresIn: 3600 } }),
      '/v1/checkout': () => err(409, 'already_subscribed', 'This Mac already has an active Grayout subscription.', { portalUrl: 'https://billing.stripe.com/p/session/abc' }),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: ACCOUNT })
    });
    const r = await a.startCheckout('monthly');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'already_subscribed');
    assert.equal(r.portalUrl, 'https://billing.stripe.com/p/session/abc');
    assert.equal(r.restored, true);
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(/subscribe/i.test(r.message.replace(/subscription/gi, '')), false, 'the copy never says "subscribe"');
    assert.match(r.manageNote, /link\.com/);
    assert.match(r.manageNote, /Sold through Link/);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device-code', '/v1/checkout', '/v1/restore', '/v1/status']);
  });

  test('already_subscribed with a key on this Mac asks nothing more; a null portalUrl is fine', async () => {
    const a = licensed();
    const calls = service({
      '/v1/device-code': () => ({ body: { deviceCode: CODE } }),
      '/v1/checkout': () => err(409, 'already_subscribed', 'x', { portalUrl: null })
    });
    const r = await a.startCheckout('yearly');
    assert.deepEqual([r.kind, r.portalUrl, r.restored], ['already_subscribed', null, false]);
    assert.equal(calls.length, 2);
  });
});

describe('claim polling (contract 6.6)', () => {
  test('the cadence: every 2 s for 2 minutes, then every 5 s; a longer retryAfter wins', () => {
    assert.equal(accountMod.CLAIM_FAST_MS, 2000);
    assert.equal(accountMod.CLAIM_FAST_FOR_MS, 120000);
    assert.equal(accountMod.CLAIM_SLOW_MS, 5000);
    assert.equal(accountMod.CLAIM_WINDOW_MS, 3600000, 'until the device code expires');
    assert.equal(nextClaimDelay(0), 2000);
    assert.equal(nextClaimDelay(119999), 2000);
    assert.equal(nextClaimDelay(120000), 5000);
    assert.equal(nextClaimDelay(3000000), 5000);
    assert.equal(nextClaimDelay(0, 30), 30000);
    assert.equal(nextClaimDelay(200000, 1), 5000, 'a shorter retryAfter does not speed things up');
  });

  test('POST /v1/claim with the code and identity until "ready"; then the key is stored and the plan read', async () => {
    const a = registered();
    const calls = service({
      '/v1/claim': (c, n) => (n < 3 ? { body: { status: 'pending' } } : { body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: { ...ACCOUNT, plan: 'trialing', status: 'trialing' } })
    });
    const r = await a.pollClaim(CODE);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'trialing');
    assert.equal(r.hasLicense, true);
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(calls.to('/v1/claim').length, 3);
    assert.deepEqual(calls[0].body, { deviceCode: CODE, deviceId: DEVICE, deviceToken: TOKEN });
    assert.equal(calls.at(-1).path, '/v1/status');
  });

  test('"failed" stops at once with the reason', async () => {
    const a = registered();
    let calls = service({ '/v1/claim': () => ({ body: { status: 'failed', reason: 'payment_failed' } }) });
    let r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'payment_failed']);
    assert.equal(calls.length, 1);
    calls = service({ '/v1/claim': () => ({ body: { status: 'failed', reason: 'expired' } }) });
    r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'checkout_expired']);
    assert.equal(calls.length, 1);
  });

  test('terminal errors stop the poll: 400, 403 license_revoked, 401 device_unverified', async () => {
    for (const [status, code] of [[400, 'bad_request'], [403, 'license_revoked']]) {
      const a = registered();
      const calls = service({ '/v1/claim': () => err(status, code) });
      const r = await a.pollClaim(CODE);
      assert.deepEqual([r.ok, r.kind], [false, code], code);
      assert.equal(calls.length, 1, code);
    }
    const a = registered();
    const calls = service({ '/v1/claim': () => err(401, 'device_unverified'), '/v1/device': () => ({ body: { deviceId: DEVICE2, deviceToken: TOKEN2 } }) });
    const r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'device_unverified']);
    assert.deepEqual(calls.map(c => c.path), ['/v1/claim', '/v1/device', '/v1/claim'], 'one re-registration, then stop');
  });

  test('code_expired stops the poll, but asks once whether the purchase went through anyway', async () => {
    const a = registered();
    let calls = service({ '/v1/claim': () => err(404, 'code_expired', 'That device code has expired.'), '/v1/restore': () => ({ body: { status: 'none' } }) });
    let r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'code_expired']);
    assert.deepEqual(calls.map(c => c.path), ['/v1/claim', '/v1/restore']);

    const b = registered();
    calls = service({
      '/v1/claim': () => err(404, 'code_expired'),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: ACCOUNT })
    });
    r = await b.pollClaim(CODE);
    assert.equal(r.ok, true, 'paid after all: the key arrives');
    assert.equal(secrets.getLicense(), LICENSE);
  });

  test('transient failures are retried: network, 500, 429', async () => {
    const a = registered();
    const calls = service({
      '/v1/claim': (c, n) => {
        if (n === 1) return new Error('fetch failed');
        if (n === 2) return { status: 500, body: {} };
        if (n === 3) return err(429, 'rate_limited', 'Slow down.');
        return { body: { status: 'ready', license: LICENSE } };
      },
      '/v1/status': () => ({ body: ACCOUNT })
    });
    const r = await a.pollClaim(CODE);
    assert.equal(r.ok, true);
    assert.equal(calls.to('/v1/claim').length, 4);
  });

  test('when the window closes it asks /v1/restore once, then reports the timeout', async () => {
    let clock = 0;
    const a = registered({ now: () => (clock += 60000), claimWindowMs: 15 * 60000 });
    const calls = service({ '/v1/claim': () => ({ body: { status: 'pending' } }), '/v1/restore': () => ({ body: { status: 'none' } }) });
    const r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'timeout']);
    assert.equal(calls.to('/v1/restore').length, 1);
  });

  test('the window is the device code\'s own life from startCheckout', async () => {
    let clock = 1789905600000;
    const a = registered({ now: () => clock, claimWindowMs: 3600 * 1000 });
    service({
      '/v1/device-code': () => ({ body: { deviceCode: CODE, expiresIn: 1 } }),
      '/v1/checkout': () => ({ body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' } })
    });
    await a.startCheckout('monthly');
    const calls = service({
      '/v1/claim': () => { clock += 600; return { body: { status: 'pending' } }; },
      '/v1/restore': () => ({ body: { status: 'none' } })
    });
    const r = await a.pollClaim(CODE);
    assert.equal(r.kind, 'timeout');
    assert.ok(calls.to('/v1/claim').length <= 2, 'stopped when the 1-second code expired, not after an hour');
  });

  test('cancelClaim stops the wait; the promise resolves as cancelled', async () => {
    const a = registered({ claimFastMs: 50, claimSlowMs: 50, claimWindowMs: 60000 });
    let polls = 0;
    service({ '/v1/claim': () => { polls++; return { body: { status: 'pending' } }; } });
    const pending = a.pollClaim(CODE);
    await helpers.turns(5);
    assert.deepEqual(a.cancelClaim(), { ok: true, cancelled: true });
    const r = await pending;
    assert.deepEqual([r.ok, r.kind], [false, 'cancelled']);
    const seen = polls;
    await helpers.turns(5);
    assert.equal(polls, seen, 'polling really stopped');
    assert.deepEqual(a.cancelClaim(), { ok: true, cancelled: false });
  });

  test('an empty or odd code never calls', async () => {
    const a = registered();
    const calls = service();
    for (const bad of ['', '  ', 'x', 'a b c d', null, 'dc_abc']) assert.equal((await a.pollClaim(bad)).ok, false, String(bad));
    assert.equal(calls.length, 0);
  });
});

describe('billing portal (contract 6.10, section 10)', () => {
  test('needs a license, then POSTs it with the identity and returns the link and the link.com note', async () => {
    const a = registered();
    const none = await a.portalUrl();
    assert.deepEqual([none.ok, none.kind], [false, 'no_license']);
    assert.match(none.manageNote, /link\.com/);

    secrets.setLicense(LICENSE);
    const calls = service({ '/v1/portal': () => ({ body: { url: 'https://billing.stripe.com/p/session/x' } }) });
    const r = await a.portalUrl();
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://billing.stripe.com/p/session/x');
    assert.equal(r.manageNote, 'You can also manage it at link.com, where this purchase is listed as Sold through Link.');
    assert.deepEqual(calls[0].body, { license: LICENSE, deviceId: DEVICE, deviceToken: TOKEN });
  });

  test('a failure still carries the link.com route', async () => {
    const a = licensed();
    service({ '/v1/portal': () => err(503, 'not_configured', 'Billing is not set up.') });
    const r = await a.portalUrl();
    assert.deepEqual([r.ok, r.kind], [false, 'not_configured']);
    assert.match(r.manageNote, /link\.com/);
  });
});

describe('snapshot, usage and problems', () => {
  test('the free taste counts up from the checks and is not a plan problem until the service says so', () => {
    const a = registered();
    assert.equal(a.snapshot().usage.checksIncluded, 100);
    a.noteCheck({ plan: 'free', service: true, usage: { checksUsed: 100, checksIncluded: 100, periodEnd: null, resetsAt: null } });
    assert.equal(a.snapshot().usage.checksUsed, 100);
    assert.equal(a.snapshot().needsSubscription, false, 'access is the service\'s decision, not worked out here');
    a.noteProblem('free_exhausted', { reason: 'device' });
    assert.equal(a.snapshot().needsSubscription, true);
    assert.equal(a.snapshot().problemReason, 'device');
  });

  test('a paused daily budget leaves this Mac\'s own count alone', () => {
    const a = registered();
    a.noteCheck({ plan: 'free', usage: { checksUsed: 7, checksIncluded: 100 } });
    a.noteProblem('free_exhausted', { reason: 'daily_budget' });
    const s = a.snapshot();
    assert.equal(s.usage.checksUsed, 7);
    assert.equal(s.problem, 'free_exhausted');
    assert.equal(s.problemReason, 'daily_budget');
  });

  test('a check records status, service and the reset date, and clears a problem', async () => {
    const a = licensed();
    a.noteProblem('trial_expired');
    assert.equal(a.snapshot().needsSubscription, true);
    a.noteCheck({ plan: 'active', service: true, usage: { checksUsed: 40, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' } });
    const s = a.snapshot();
    assert.equal(s.status, 'active');
    assert.equal(s.service, true);
    assert.equal(s.usage.resetsAt, '2026-11-01T00:00:00Z');
    assert.equal(s.problem, null);
    assert.equal(s.needsSubscription, false);
  });

  test('past_due and service:false need attention; quota_exceeded does not', () => {
    const a = licensed();
    a.noteCheck({ plan: 'past_due', service: true, usage: { checksUsed: 1, checksIncluded: 10000 } });
    assert.equal(a.snapshot().needsSubscription, true, 'payment needed');
    a.noteCheck({ plan: 'canceled', service: false, usage: { checksUsed: 1, checksIncluded: 10000 } });
    assert.equal(a.snapshot().needsSubscription, true);
    a.noteCheck({ plan: 'active', service: true, usage: { checksUsed: 10000, checksIncluded: 10000 } });
    a.noteProblem('quota_exceeded');
    assert.equal(a.snapshot().problem, 'quota_exceeded');
    assert.equal(a.snapshot().needsSubscription, false, 'past the allowance the service only slows down');
  });

  test('noteProblem with a passing kind clears the flag', () => {
    const a = registered();
    a.noteProblem('trial_expired');
    a.noteProblem('overloaded');
    assert.equal(a.snapshot().problem, null, 'a busy service is not a plan problem');
  });

  test('the free counters do not carry over into a paid plan', async () => {
    const a = registered();
    a.noteCheck({ plan: 'free', usage: { checksUsed: 100, checksIncluded: 100 } });
    a.noteProblem('free_exhausted', { reason: 'device' });
    service({ '/v1/activate': () => ({ body: { plan: 'active', status: 'active', service: true } }) });   // no usage in the answer
    const r = await a.activate(LICENSE);
    assert.equal(r.usage.checksIncluded, 10000, 'the paid allowance (contract section 2), not the free one');
    assert.equal(r.usage.checksUsed, 0);
    assert.equal(r.needsSubscription, false);
  });

  test('clearing the license goes back to the free snapshot', async () => {
    const a = licensed();
    a.noteCheck({ plan: 'active', service: true, usage: { checksUsed: 10, checksIncluded: 10000 } });
    const s = a.clearLicense();
    assert.equal(s.hasLicense, false);
    assert.equal(s.status, 'free');
    assert.equal(s.usage.checksIncluded, 100);
    assert.equal(secrets.getLicense(), null);
  });

  test('counters and a plan problem survive a restart', () => {
    const a = registered();
    a.noteCheck({ plan: 'free', usage: { checksUsed: 7, checksIncluded: 100 } });
    a.noteProblem('free_exhausted', { reason: 'device' });
    state._reset();
    const again = createAccount({ getConfig: () => ({ apiBase: BASE }) }).snapshot();
    assert.equal(again.usage.checksUsed, 100);
    assert.equal(again.problem, 'free_exhausted');
  });

  test('the snapshot never carries the key or the device token', async () => {
    const a = licensed();
    const text = JSON.stringify(a.snapshot());
    assert.equal(text.includes(LICENSE), false);
    assert.equal(text.includes(TOKEN), false);
  });
});

describe('failures never escape', () => {
  test('a network error answers with kind network', async () => {
    const a = registered();
    service({ '/v1/activate': () => new Error('fetch failed'), '/v1/device-code': () => new Error('fetch failed') });
    for (const call of [a.activate(LICENSE), a.startCheckout('monthly')]) {
      const r = await call;
      assert.deepEqual([r.ok, r.kind], [false, 'network'], JSON.stringify(r));
    }
  });

  test('a call that never answers is aborted and reads as network', async () => {
    const a = registered({ timeoutMs: 10 });
    globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    });
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'network']);
    assert.match(r.message, /did not answer in time/);
  });

  test('a body that is not JSON is still an answer, not a crash', async () => {
    const a = registered();
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('not json'); } });
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'unknown']);
    const c = await a.check({ displays: [], webcam: null, context: {} });
    assert.equal(c.ok, true);
    assert.equal(c.data, null, 'the analyzer reads this as "no verdict"');
  });
});

/* ======================================================================= */
/* Regressions from the 2026-10-08 review.                                  */

describe('Subscribe twice never opens two payable checkouts', () => {
  const routes = () => {
    let n = 0;
    return {
      '/v1/device-code': () => ({ body: { deviceCode: `CODE-000${++n}`, expiresIn: 3600 } }),
      '/v1/checkout': c => ({ body: { url: `https://checkout.stripe.com/c/pay/cs_test_${c.body.deviceCode}`, sessionId: 'cs_test_x', trial: true } })
    };
  };

  test('two startCheckout calls in a row create ONE session; the second reopens it', async () => {
    const a = registered();
    const calls = service(routes());
    const first = await a.startCheckout('monthly');
    const second = await a.startCheckout('monthly');
    assert.equal(calls.to('/v1/device-code').length, 1, 'one device code');
    assert.equal(calls.to('/v1/checkout').length, 1, 'one Checkout Session');
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.url, first.url, 'the same page');
    assert.equal(second.deviceCode, first.deviceCode, 'the same code to poll');
    assert.equal(second.trial, true, 'the trial answer is remembered');
    assert.ok(second.expiresIn <= 3600 && second.expiresIn > 3000);
  });

  test('cancelling the wait keeps the checkout; Subscribe picks it up again', async () => {
    const a = registered({ claimFastMs: 50, claimSlowMs: 50, claimWindowMs: 60000 });
    const calls = service({ ...routes(), '/v1/claim': () => ({ body: { status: 'pending' } }) });
    const first = await a.startCheckout('yearly');
    const pending = a.pollClaim(first.deviceCode);
    await helpers.turns(5);
    a.cancelClaim();
    assert.equal((await pending).kind, 'cancelled');
    const again = await a.startCheckout('yearly');
    assert.equal(again.reused, true);
    assert.equal(calls.to('/v1/checkout').length, 1);
  });

  test('a different plan, a finished checkout, or one about to expire starts a new session', async () => {
    let clock = 1789905600000;
    const a = registered({ now: () => clock });
    let calls = service({ ...routes(), '/v1/claim': () => ({ body: { status: 'ready', license: LICENSE } }), '/v1/status': () => ({ body: ACCOUNT }) });
    const monthly = await a.startCheckout('monthly');
    await a.startCheckout('yearly');
    assert.equal(calls.to('/v1/checkout').length, 2, 'switching plans is a new checkout');

    // Paid: the next Subscribe is a new purchase, not the paid page.
    const yearly = await a.startCheckout('yearly');
    assert.equal(yearly.reused, true);
    assert.equal((await a.pollClaim(yearly.deviceCode)).ok, true);
    secrets.clearLicense();
    await a.startCheckout('yearly');
    assert.equal(calls.to('/v1/checkout').length, 3);

    // Less than 5 minutes left on the page: start fresh rather than send the
    // buyer to a page that expires under them.
    calls = service(routes());
    await a.startCheckout('monthly');
    clock += 3600 * 1000 - accountMod.CHECKOUT_REUSE_MARGIN_MS + 1000;
    const late = await a.startCheckout('monthly');
    assert.equal(late.reused, false);
    assert.equal(calls.to('/v1/checkout').length, 2);
    assert.ok(monthly.url);
  });

  test('a failed payment or an expired code is over: Subscribe starts again', async () => {
    const a = registered();
    const calls = service({ ...routes(), '/v1/claim': () => ({ body: { status: 'failed', reason: 'payment_failed' } }) });
    const r = await a.startCheckout('monthly');
    assert.equal((await a.pollClaim(r.deviceCode)).kind, 'payment_failed');
    assert.equal((await a.startCheckout('monthly')).reused, false);
    assert.equal(calls.to('/v1/checkout').length, 2);
  });
});

describe('an abandoned re-subscribe never reads as "Subscribed" (lastChance)', () => {
  // A Mac whose old subscription lapsed still has that key on file, so
  // /v1/restore always hands it back. That is not a purchase.
  const LAPSED = { ...ACCOUNT, plan: 'canceled', status: 'canceled', service: false };

  test('window closes, restore returns the old lapsed key: still a timeout', async () => {
    let clock = 0;
    const a = registered({ now: () => (clock += 60000), claimWindowMs: 15 * 60000 });
    service({
      '/v1/claim': () => ({ body: { status: 'pending' } }),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: LAPSED })
    });
    const r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'timeout']);
    assert.equal(r.claimedBy, undefined);
  });

  test('code expired, restore returns the old lapsed key: still code_expired', async () => {
    const a = licensed();
    service({
      '/v1/claim': () => err(404, 'code_expired'),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: LAPSED })
    });
    const r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.kind], [false, 'code_expired']);
  });

  test('the same flow with a plan that is served IS the purchase', async () => {
    let clock = 0;
    const a = registered({ now: () => (clock += 60000), claimWindowMs: 15 * 60000 });
    service({
      '/v1/claim': () => ({ body: { status: 'pending' } }),
      '/v1/restore': () => ({ body: { status: 'ready', license: LICENSE } }),
      '/v1/status': () => ({ body: { ...ACCOUNT, plan: 'trialing', status: 'trialing' } })
    });
    const r = await a.pollClaim(CODE);
    assert.deepEqual([r.ok, r.claimedBy, r.status], [true, 'restore', 'trialing']);
  });
});

describe('no_license whose key on file was revoked', () => {
  const PAYLOAD = { displays: ['FRAME'], webcam: null, context: {} };

  test('check() reports license_revoked, not "your key is missing"', async () => {
    const a = registered();
    const calls = service({
      '/v1/check': () => err(401, 'no_license'),
      '/v1/restore': () => err(403, 'license_revoked', 'This subscription was refunded or disputed. Email help@example.com to start again.')
    });
    const r = await a.check(PAYLOAD);
    assert.deepEqual([r.ok, r.kind, r.code, r.status], [false, 'license_revoked', 'license_revoked', 403]);
    assert.match(r.message, /refunded or disputed/);
    assert.equal(calls.to('/v1/check').length, 1, 'no second check');
    // What the loop then records, and what the plan panel reads.
    const snap = a.noteProblem(r.kind);
    assert.deepEqual([snap.problem, snap.hasLicense, snap.needsSubscription], ['license_revoked', false, true]);
  });
});

describe('saved keys the Keychain will not unlock (secrets.bin)', () => {
  const locked = () => ({ ...identity(), decryptString: () => { throw new Error('user denied keychain access'); } });
  const PAYLOAD = { displays: ['FRAME'], webcam: null, context: {} };

  /** A registered, licensed Mac whose secrets.bin then stops decrypting. */
  function lockedMac(over = {}) {
    const a = licensed(over);
    state.update(s => { delete s.secretsLockedSince; });
    secrets._setSafeStorage(locked());
    return a;
  }

  test('the app does not mint a new identity, and the old store is left alone', async () => {
    const a = lockedMac();
    const before = fs.readFileSync(paths.SECRETS_PATH);
    const calls = service({ '/v1/check': () => ({ body: { verdict: {} } }) });
    const r = await a.check(PAYLOAD);
    assert.deepEqual([r.ok, r.kind], [false, 'secrets_locked']);
    assert.match(r.message, /Keychain/);
    assert.equal(calls.length, 0, 'no /v1/device, no /v1/check');
    assert.deepEqual(fs.readFileSync(paths.SECRETS_PATH), before, 'the license and token on disk are untouched');
    assert.equal(a.deviceId(), null);
    assert.equal(a.snapshot().secretsLocked, true, 'the windows can say what is wrong');
    // The Keychain comes back (next launch, "Always Allow"): everything is still there.
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(secrets.getDeviceToken(), TOKEN);
  });

  test('a checkout is not started on a locked Mac either (it could buy a second subscription)', async () => {
    const a = lockedMac();
    const calls = service();
    const r = await a.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'secrets_locked']);
    assert.equal(calls.length, 0);
  });

  test('pasting a key starts fresh: the old file is kept aside and the Mac registers again', async () => {
    const a = lockedMac();
    const calls = service({ '/v1/device': () => ({ body: { deviceId: DEVICE2, deviceToken: TOKEN2 } }), '/v1/activate': () => ({ body: ACCOUNT }) });
    const r = await a.activate(OTHER);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device', '/v1/activate']);
    assert.ok(fs.existsSync(paths.SECRETS_PATH + '.unreadable'), 'the unreadable store is kept, not destroyed');
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getLicense(), OTHER);
    assert.equal(secrets.getDeviceToken(), TOKEN2);
  });

  test('after a whole day locked, the store is treated as lost and the Mac registers again', async () => {
    let clock = 1789905600000;
    const a = lockedMac({ now: () => clock });
    let calls = service({ '/v1/check': () => ({ body: { verdict: {} } }) });
    assert.equal((await a.check(PAYLOAD)).kind, 'secrets_locked');
    clock += accountMod.LOCKED_GIVE_UP_MS - 1000;
    assert.equal((await a.check(PAYLOAD)).kind, 'secrets_locked', 'not yet');
    assert.equal(calls.length, 0);
    clock += 2000;
    calls = service({ '/v1/device': () => ({ body: { deviceId: DEVICE2, deviceToken: TOKEN2 } }), '/v1/check': () => ({ body: { verdict: {} } }) });
    const r = await a.check(PAYLOAD);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map(c => c.path), ['/v1/device', '/v1/check']);
    assert.equal(state.get().secretsLockedSince, undefined, 'the clock is cleared once a new store exists');
  });
});
