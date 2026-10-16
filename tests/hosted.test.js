'use strict';
// The hosted provider inside the analyzer: what goes over the wire to
// /v1/check, what comes back, and how the contract's failure codes land on the
// kinds the loop already knows how to act on. The analyzer hands the frames to
// the account client (src/account.js), which adds this Mac's device identity
// and license key; these tests drive the real client over a stubbed fetch.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('hosted');
const analyzer = require('../src/analyzer');
const { analyze, analyzeViaGrayout, serviceContext, classifyApiError } = analyzer;
const providers = require('../src/providers');
const secrets = require('../src/secrets');
const state = require('../src/state');
const { createAccount } = require('../src/account');

const REAL_FETCH = globalThis.fetch;
const SAVED_BASE = process.env.GRAYOUT_API_BASE;
const SAVED_LICENSE = process.env.GRAYOUT_LICENSE;
delete process.env.GRAYOUT_API_BASE;
delete process.env.GRAYOUT_LICENSE;

after(() => {
  globalThis.fetch = REAL_FETCH;
  if (SAVED_BASE === undefined) delete process.env.GRAYOUT_API_BASE; else process.env.GRAYOUT_API_BASE = SAVED_BASE;
  if (SAVED_LICENSE !== undefined) process.env.GRAYOUT_LICENSE = SAVED_LICENSE;
  helpers.cleanup(dir);
});
beforeEach(() => { globalThis.fetch = REAL_FETCH; });

const BASE = 'https://grayout-api.test-sub.workers.dev';
const DEVICE = 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G';
const TOKEN = 'abcdefghijABCDEFGHIJ0123456789-_abcdefghijk';
const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
const VERDICT = { off_task: false, activity: 'code editor and terminal', confidence: 'high' };
const USAGE = { checksUsed: 412, checksIncluded: 10000, periodEnd: '2026-11-07T14:03:11Z', resetsAt: '2026-11-01T00:00:00Z' };

/** A registered Mac, with or without a license, talking to BASE (or `apiBase`). */
function account({ license = LICENSE, apiBase = BASE, builtInBase } = {}) {
  secrets._setSafeStorage({ isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() });
  secrets.clearLicense();
  state.update(s => { s.account = null; s.deviceId = DEVICE; });
  secrets.setDeviceToken(TOKEN);
  if (license) secrets.setLicense(license);
  return createAccount({ getConfig: () => ({ apiBase }), ...(builtInBase !== undefined ? { builtInBase } : {}) });
}

function stubFetch(out) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = typeof out === 'function' ? out(calls.length) : out;
    if (r instanceof Error) throw r;
    const { status = 200, body = {}, headers = {} } = r || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: n => (String(n).toLowerCase() === 'x-grayout-request-id' ? 'req_abc' : headers[String(n).toLowerCase()] ?? null) },
      json: async () => body
    };
  };
  return calls;
}

// The secret store is shared, so a default account is made only when the test
// did not bring its own (making one sets a license).
const ctx = (over = {}) => ({
  screenshotsB64: ['FRAME1'],
  webcamB64: null,
  workDescription: 'thesis writing',
  canvasTasks: ['Problem Set 4'],
  fileTasks: ['write report'],
  frontApp: 'Code',
  apiKey: null,
  ...over,
  account: 'account' in over ? over.account : account()
});

describe('the request', () => {
  test('posts frames, context, the device identity and the license to /v1/check — and no prompt text', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'active', service: true } });
    await analyzeViaGrayout(ctx({ webcamB64: 'WEBCAM' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, BASE + '/v1/check', 'no query string');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, {
      displays: ['FRAME1'],
      webcam: 'WEBCAM',
      context: { workDescription: 'thesis writing', frontApp: 'Code', canvasTasks: ['Problem Set 4'], fileTasks: ['write report'] },
      license: LICENSE,
      deviceId: DEVICE,
      deviceToken: TOKEN
    });
    // The server owns the prompt: none of it may travel with the pixels.
    assert.equal(JSON.stringify(calls[0].body).includes('off_task'), false);
    assert.equal(JSON.stringify(calls[0].body).includes('WORK COMPUTER'), false);
  });

  test('the license is omitted entirely on the free taste', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: { checksUsed: 3, checksIncluded: 100, periodEnd: null, resetsAt: null }, plan: 'free', service: true } });
    await analyzeViaGrayout(ctx({ account: account({ license: null }) }));
    assert.equal('license' in calls[0].body, false);
    assert.equal(calls[0].body.deviceId, DEVICE);
    assert.equal(calls[0].body.deviceToken, TOKEN);
  });

  test('config.apiBase and GRAYOUT_API_BASE redirect the call', async t => {
    t.after(() => { delete process.env.GRAYOUT_API_BASE; });
    let calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx({ account: account({ apiBase: 'https://grayout-api.other.workers.dev' }) }));
    assert.equal(calls[0].url, 'https://grayout-api.other.workers.dev/v1/check');
    process.env.GRAYOUT_API_BASE = 'http://localhost:8787';
    calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx());
    assert.equal(calls[0].url, 'http://localhost:8787/v1/check');
  });

  test('a build with no service address sends nothing and says so', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT } });
    const a = account({ apiBase: '', builtInBase: '__GRAYOUT_API_BASE__' });
    const err = await analyzeViaGrayout(ctx({ account: a })).then(() => null, e => e);
    assert.equal(err.kind, 'not_connected');
    assert.equal(err.message, 'This build of Grayout is not connected to the Grayout service yet.');
    assert.equal(calls.length, 0);
    const none = await analyzeViaGrayout(ctx({ account: null })).then(() => null, e => e);
    assert.equal(none.kind, 'not_connected', 'no account client at all reads the same way');
  });

  test('the payload is trimmed to the contract caps', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx({
      screenshotsB64: ['A', 'B', 'C', 'D'],
      workDescription: 'w'.repeat(900),
      canvasTasks: Array.from({ length: 30 }, (_, i) => `task ${i}`),
      fileTasks: ['line\none', ''],
      frontApp: null
    }));
    assert.deepEqual(calls[0].body.displays, ['A', 'B', 'C'], 'at most three displays');
    assert.equal(calls[0].body.context.workDescription.length, 500);
    assert.equal(calls[0].body.context.canvasTasks.length, 20);
    assert.deepEqual(calls[0].body.context.fileTasks, ['line one'], 'newlines flattened, empties dropped');
    assert.equal(calls[0].body.context.frontApp, null);
  });

  test('serviceContext caps each task line at 200 characters', () => {
    const out = serviceContext({ canvasTasks: ['x'.repeat(400)], fileTasks: [], workDescription: '', frontApp: '' });
    assert.equal(out.canvasTasks[0].length, 200);
    assert.equal(out.frontApp, null);
  });
});

describe('the response', () => {
  test('maps onto the shape the loop already expects', async () => {
    stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'active', service: true } });
    const r = await analyzeViaGrayout(ctx());
    assert.deepEqual(r.verdict, VERDICT);
    assert.equal(r.usage, null, 'token usage is the service\'s business, not a bill here');
    assert.equal(r.model, 'grayout');
    assert.equal(r.provider, 'grayout');
    assert.deepEqual(r.service, { plan: 'active', service: true, usage: USAGE });
  });

  test('a surprising verdict is coerced to on-task, exactly as on the direct path', async () => {
    stubFetch({ body: { verdict: { off_task: 'yes', activity: 42, confidence: 'certain' }, plan: 'free' } });
    const r = await analyzeViaGrayout(ctx());
    assert.deepEqual(r.verdict, { off_task: false, activity: '', confidence: 'low' });
  });

  test('a missing or unparseable body throws rather than inventing a verdict', async () => {
    stubFetch({ body: { plan: 'active' } });
    await assert.rejects(analyzeViaGrayout(ctx()), /verdict is not an object/);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } });
    await assert.rejects(analyzeViaGrayout(ctx()), /returned no verdict/);
  });
});

describe('failure codes', () => {
  const cases = {
    no_license: 'no_license',
    license_invalid: 'license_invalid',
    license_revoked: 'license_revoked',
    trial_expired: 'trial_expired',
    subscription_inactive: 'subscription_inactive',
    free_exhausted: 'free_exhausted',
    quota_exceeded: 'quota_exceeded',
    rate_limited: 'rate_limited',
    upstream_unavailable: 'overloaded',
    payload_too_large: 'payload_too_large',
    not_configured: 'not_configured'
  };

  test('every documented code reaches the loop as its kind, with the service\'s own sentence', async () => {
    for (const [code, kind] of Object.entries(cases)) {
      // no_license would make the client ask /v1/restore; answer "none".
      stubFetch(n => (n === 2 ? { body: { status: 'none' } } : { status: 402, body: { error: { code, message: `plain sentence for ${code}` } } }));
      const err = await analyzeViaGrayout(ctx({ account: account({ license: code === 'no_license' ? null : LICENSE }) })).then(() => null, e => e);
      assert.ok(err, code);
      assert.equal(err.kind, kind, code);
      assert.equal(err.serviceCode, code);
      assert.equal(err.message, `plain sentence for ${code}`);
      assert.equal(classifyApiError(err).kind, kind, `classifyApiError ${code}`);
    }
  });

  test('retryAfter and reason ride along for the loop', async () => {
    stubFetch({ status: 429, body: { error: { code: 'quota_exceeded', message: 'Monthly checks used up.', retryAfter: 420 } }, headers: { 'retry-after': '420' } });
    const q = await analyzeViaGrayout(ctx()).then(() => null, e => e);
    assert.deepEqual([q.kind, q.retryAfter], ['quota_exceeded', 420]);
    stubFetch({ status: 402, body: { error: { code: 'free_exhausted', message: 'Paused for today.', reason: 'daily_budget' } } });
    const f = await analyzeViaGrayout(ctx({ account: account({ license: null }) })).then(() => null, e => e);
    assert.deepEqual([f.kind, f.reason], ['free_exhausted', 'daily_budget']);
  });

  test('device_unverified twice reaches the loop with the plain sentence', async () => {
    stubFetch(n => (n === 2
      ? { body: { deviceId: 'dev_1A2B3C4D5E6F7G8H9J0K1M2N3P', deviceToken: 'ZYXWVUTSRQzyxwvutsrq9876543210_-zyxwvutsrqp' } }
      : { status: 401, body: { error: { code: 'device_unverified', message: 'Unknown device.' } } }));
    const err = await analyzeViaGrayout(ctx()).then(() => null, e => e);
    assert.equal(err.kind, 'device_unverified');
    assert.equal(err.message, 'Grayout could not register this Mac with the service. Try again later.');
  });

  test('a bare error object with a service code classifies too', () => {
    assert.equal(classifyApiError({ message: 'x', error: { code: 'free_exhausted' } }).kind, 'free_exhausted');
    assert.equal(classifyApiError({ message: 'x', code: 'trial_expired' }).kind, 'trial_expired');
  });

  test('an unrecognized failure falls back to the HTTP status', async () => {
    stubFetch({ status: 500, body: {} });
    const err = await analyzeViaGrayout(ctx()).then(() => null, e => e);
    assert.equal(err.kind, 'overloaded');
    assert.equal(err.requestId, 'req_abc');
  });

  test('a network failure reads as network, never as a verdict', async () => {
    stubFetch(new Error('fetch failed'));
    const err = await analyzeViaGrayout(ctx()).then(() => null, e => e);
    assert.equal(err.kind, 'network');
    assert.equal(classifyApiError(err).kind, 'network');
  });
});

describe('dispatch', () => {
  test('analyze() takes the hosted path by default and reports engine api', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'trialing', service: true } });
    const r = await analyze(ctx(), { model: 'claude-haiku-4-5' });
    assert.equal(calls.length, 1);
    assert.equal(r.engine, 'api');
    assert.equal(r.provider, 'grayout');
    assert.equal(r.service.plan, 'trialing');
  });

  test('personal build: an explicit self-hosted provider never touches the service', async t => {
    const channel = require('../src/channel');
    channel._setPersonalForTests(true);
    t.after(() => channel._setPersonalForTests(null));
    const calls = stubFetch({ body: { verdict: VERDICT } });
    await assert.rejects(analyze(ctx({ apiKey: null }), { provider: 'anthropic', model: 'claude-haiku-4-5' }), analyzer.NoKeyError);
    assert.equal(calls.length, 0);
    assert.equal(providers.resolve({ provider: 'auto' }, 'sk-ant-key').provider, 'anthropic');
  });
});

describe('Mac App Store edition: every check goes through the Grayout service', () => {
  const channel = require('../src/channel');
  after(() => channel._setForTests(null));

  test('providers.resolve is always the hosted service, whatever config.json or a key says', () => {
    channel._setForTests('mas');
    for (const [cfg, key] of [[{ provider: 'anthropic' }, null], [{ provider: 'openai', model: 'gpt-5-mini' }, 'sk-proj-x'], [{ provider: 'auto' }, 'sk-ant-key'], [{}, null]]) {
      assert.deepEqual(providers.resolve(cfg, key), { provider: 'grayout', model: 'grayout' }, JSON.stringify(cfg));
      assert.equal(providers.isHosted(cfg, key), true);
    }
  });

  test('analyze() with an explicit provider and a key still posts to the service, never to a model provider', async () => {
    channel._setForTests('mas');
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'active', service: true } });
    // The store edition reaches only the address built into the app.
    const r = await analyze(ctx({ apiKey: 'sk-ant-api03-not-used', account: account({ builtInBase: BASE }) }), { provider: 'anthropic', engine: 'cli', model: 'claude-haiku-4-5' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/v1/check`);
    assert.equal(r.engine, 'api');
    assert.equal(r.provider, 'grayout');
  });

  test('testApiKey refuses without any network', async () => {
    channel._setForTests('mas');
    const calls = stubFetch({ body: {} });
    const r = await analyzer.testApiKey('sk-ant-api03-x', 'AAAA', 'claude-haiku-4-5', 'anthropic');
    assert.deepEqual(r, { ok: false, kind: 'unavailable', message: analyzer.UNAVAILABLE_KEY_MESSAGE });
    assert.equal(calls.length, 0);
  });
});

describe('public direct build (pay-only): every check goes through the Grayout service', () => {
  const channel = require('../src/channel');
  after(() => { channel._setForTests(null); channel._setPersonalForTests(null); });
  const publicDirect = () => { channel._setForTests('direct'); channel._setPersonalForTests(false); };

  test('providers.resolve is always the hosted service, whatever config.json or a key says', () => {
    publicDirect();
    for (const [cfg, key] of [[{ provider: 'anthropic' }, null], [{ provider: 'openai', model: 'gpt-5-mini' }, 'sk-proj-x'], [{ provider: 'auto' }, 'sk-ant-key'], [{}, null]]) {
      assert.deepEqual(providers.resolve(cfg, key), { provider: 'grayout', model: 'grayout' }, JSON.stringify(cfg));
      assert.equal(providers.isHosted(cfg, key), true);
    }
  });

  test('analyze() with a 1.x provider, a key and engine "cli" still posts to the service', async () => {
    publicDirect();
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'free', service: true } });
    const r = await analyze(ctx({ apiKey: 'sk-ant-api03-saved-by-1x' }), { provider: 'anthropic', engine: 'cli', model: 'claude-haiku-4-5' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/v1/check`);
    assert.equal(r.engine, 'api');
    assert.equal(r.provider, 'grayout');
  });

  test('testApiKey refuses without any network, in words that fit this edition', async () => {
    publicDirect();
    const calls = stubFetch({ body: {} });
    const r = await analyzer.testApiKey('sk-ant-api03-x', 'AAAA', 'claude-haiku-4-5', 'anthropic');
    assert.deepEqual(r, { ok: false, kind: 'unavailable', message: analyzer.UNAVAILABLE_KEY_MESSAGE });
    assert.doesNotMatch(analyzer.UNAVAILABLE_KEY_MESSAGE, /App Store/);
    assert.equal(calls.length, 0);
  });
});
