'use strict';
// The hosted provider inside the analyzer: what goes over the wire to
// /v1/check, what comes back, and how the contract's failure codes land on the
// kinds the loop already knows how to act on.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('hosted');
const analyzer = require('../src/analyzer');
const { analyze, analyzeViaGrayout, serviceContext, classifyApiError } = analyzer;
const providers = require('../src/providers');

const REAL_FETCH = globalThis.fetch;
const SAVED_BASE = process.env.GRAYOUT_API_BASE;
delete process.env.GRAYOUT_API_BASE;

after(() => {
  globalThis.fetch = REAL_FETCH;
  if (SAVED_BASE === undefined) delete process.env.GRAYOUT_API_BASE; else process.env.GRAYOUT_API_BASE = SAVED_BASE;
  helpers.cleanup(dir);
});
beforeEach(() => { globalThis.fetch = REAL_FETCH; });

const DEVICE = 'a'.repeat(32);
const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
const VERDICT = { off_task: false, activity: 'code editor and terminal', confidence: 'high' };
const USAGE = { checksUsed: 412, checksIncluded: 15000, periodEnd: '2026-10-22T00:00:00Z' };

function stubFetch(out) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = typeof out === 'function' ? out(calls.length) : out;
    if (r instanceof Error) throw r;
    const { status = 200, body = {} } = r || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'req_abc' },
      json: async () => body
    };
  };
  return calls;
}

const ctx = (over = {}) => ({
  screenshotsB64: ['FRAME1'],
  webcamB64: null,
  workDescription: 'thesis writing',
  canvasTasks: ['Problem Set 4'],
  fileTasks: ['write report'],
  frontApp: 'Code',
  apiKey: null,
  license: LICENSE,
  deviceId: DEVICE,
  ...over
});

describe('the request', () => {
  test('posts frames and context to /v1/check — and no prompt text', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'active' } });
    await analyzeViaGrayout(ctx({ webcamB64: 'WEBCAM' }), {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.grayout.app/v1/check');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, {
      deviceId: DEVICE,
      displays: ['FRAME1'],
      webcam: 'WEBCAM',
      context: { workDescription: 'thesis writing', frontApp: 'Code', canvasTasks: ['Problem Set 4'], fileTasks: ['write report'] },
      license: LICENSE
    });
    // The server owns the prompt: none of it may travel with the pixels.
    assert.equal(JSON.stringify(calls[0].body).includes('off_task'), false);
    assert.equal(JSON.stringify(calls[0].body).includes('WORK COMPUTER'), false);
  });

  test('the license is omitted entirely on the free taste', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: { checksUsed: 3, checksIncluded: 100 }, plan: 'free' } });
    await analyzeViaGrayout(ctx({ license: null }), {});
    assert.equal('license' in calls[0].body, false);
    assert.equal(calls[0].body.deviceId, DEVICE);
  });

  test('config.apiBase and GRAYOUT_API_BASE redirect the call', async t => {
    t.after(() => { delete process.env.GRAYOUT_API_BASE; });
    let calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx(), { apiBase: 'https://grayout-api.workers.dev' });
    assert.equal(calls[0].url, 'https://grayout-api.workers.dev/v1/check');
    process.env.GRAYOUT_API_BASE = 'http://localhost:8787';
    calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx(), {});
    assert.equal(calls[0].url, 'http://localhost:8787/v1/check');
  });

  test('the payload is trimmed to the contract caps', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT } });
    await analyzeViaGrayout(ctx({
      screenshotsB64: ['A', 'B', 'C', 'D'],
      workDescription: 'w'.repeat(900),
      canvasTasks: Array.from({ length: 30 }, (_, i) => `task ${i}`),
      fileTasks: ['line\none', ''],
      frontApp: null
    }), {});
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

  test('no device id is refused before any network call', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT } });
    await assert.rejects(analyzeViaGrayout(ctx({ deviceId: null }), {}), e => e.kind === 'unknown');
    assert.equal(calls.length, 0);
  });
});

describe('the response', () => {
  test('maps onto the shape the loop already expects', async () => {
    stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'active' } });
    const r = await analyzeViaGrayout(ctx(), {});
    assert.deepEqual(r.verdict, VERDICT);
    assert.equal(r.usage, null, 'token usage is the service\'s business, not a bill here');
    assert.equal(r.model, 'grayout');
    assert.equal(r.provider, 'grayout');
    assert.deepEqual(r.service, { plan: 'active', usage: USAGE });
  });

  test('a surprising verdict is coerced to on-task, exactly as on the direct path', async () => {
    stubFetch({ body: { verdict: { off_task: 'yes', activity: 42, confidence: 'certain' }, plan: 'free' } });
    const r = await analyzeViaGrayout(ctx(), {});
    assert.deepEqual(r.verdict, { off_task: false, activity: '', confidence: 'low' });
  });

  test('a missing or unparseable body throws rather than inventing a verdict', async () => {
    stubFetch({ body: { plan: 'active' } });
    await assert.rejects(analyzeViaGrayout(ctx(), {}), /verdict is not an object/);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } });
    await assert.rejects(analyzeViaGrayout(ctx(), {}), /returned no verdict/);
  });
});

describe('failure codes', () => {
  const cases = {
    no_license: 'no_license',
    license_invalid: 'key_rejected',
    license_revoked: 'key_rejected',
    trial_expired: 'trial_expired',
    subscription_inactive: 'subscription_inactive',
    free_exhausted: 'free_exhausted',
    quota_exceeded: 'quota_exceeded',
    rate_limited: 'rate_limited',
    upstream_unavailable: 'overloaded',
    payload_too_large: 'payload_too_large'
  };

  test('every documented code reaches the loop as its kind, with the service\'s own sentence', async () => {
    for (const [code, kind] of Object.entries(cases)) {
      stubFetch({ status: 402, body: { error: { code, message: `plain sentence for ${code}` } } });
      const err = await analyzeViaGrayout(ctx(), {}).then(() => null, e => e);
      assert.ok(err, code);
      assert.equal(err.kind, kind, code);
      assert.equal(err.serviceCode, code);
      assert.equal(err.message, `plain sentence for ${code}`);
      assert.equal(classifyApiError(err).kind, kind, `classifyApiError ${code}`);
    }
  });

  test('a bare error object with a service code classifies too', () => {
    assert.equal(classifyApiError({ message: 'x', error: { code: 'free_exhausted' } }).kind, 'free_exhausted');
    assert.equal(classifyApiError({ message: 'x', code: 'trial_expired' }).kind, 'trial_expired');
  });

  test('an unrecognized failure falls back to the HTTP status', async () => {
    stubFetch({ status: 500, body: {} });
    const err = await analyzeViaGrayout(ctx(), {}).then(() => null, e => e);
    assert.equal(err.kind, 'overloaded');
    assert.equal(err.requestId, 'req_abc');
  });

  test('a network failure reads as network, never as a verdict', async () => {
    stubFetch(new Error('fetch failed'));
    const err = await analyzeViaGrayout(ctx(), {}).then(() => null, e => e);
    assert.equal(err.kind, 'network');
    assert.equal(classifyApiError(err).kind, 'network');
  });
});

describe('dispatch', () => {
  test('analyze() takes the hosted path by default and reports engine api', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT, usage: USAGE, plan: 'trialing' } });
    const r = await analyze(ctx(), { model: 'claude-haiku-4-5' });
    assert.equal(calls.length, 1);
    assert.equal(r.engine, 'api');
    assert.equal(r.provider, 'grayout');
    assert.equal(r.service.plan, 'trialing');
  });

  test('an explicit self-hosted provider never touches the service', async () => {
    const calls = stubFetch({ body: { verdict: VERDICT } });
    await assert.rejects(analyze(ctx({ apiKey: null }), { provider: 'anthropic', model: 'claude-haiku-4-5' }), analyzer.NoKeyError);
    assert.equal(calls.length, 0);
    assert.equal(providers.resolve({ provider: 'auto' }, 'sk-ant-key').provider, 'anthropic');
  });
});
