// The conventions every request follows (contract section 5).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest } from '../src/index.js';
import { harness } from './helpers.js';

const SITE = 'https://aarushkandukoori.github.io';
const BASE = 'https://grayout-api.test.workers.dev';

/** A request body that arrives in chunks with no Content-Length, counting how much was pulled. */
function streamingRequest(path, totalBytes, chunkBytes = 64 * 1024) {
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    }
  });
  const request = new Request(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half'
  });
  return { request, sent: () => sent };
}

describe('methods, paths and content types', () => {
  test('GET /v1/health answers with the contract version and configured flags', async () => {
    const h = harness();
    const res = await h.call('/v1/health', null, { method: 'GET' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      ok: true, contract: 3, mode: 'test',
      configured: { stripe: true, webhook: true, model: true, device: true, license: true, db: true, keyMode: true }
    });
    assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  test('credentials never travel in URLs: GET /v1/claim and GET /v1/status do not exist', async () => {
    const h = harness();
    for (const path of ['/v1/claim?deviceCode=ABCD-1234', '/v1/status?license=gry_live_X', '/v1/check']) {
      const res = await h.call(path, null, { method: 'GET' });
      assert.equal(res.status, 405, path);
      assert.equal(res.body.error.code, 'method_not_allowed');
    }
    assert.equal((await h.call('/v1/nope', {})).body.error.code, 'not_found');
  });

  test('query strings are ignored: a license in the URL is never read', async () => {
    const h = harness();
    const device = await h.mint();
    const res = await h.call('/v1/status?license=gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D', device);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
  });

  test('a POST that is not application/json is refused (no preflight-free text/plain)', async () => {
    const h = harness();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await h.call('/v1/device', {}, { headers: { 'Content-Type': type } });
      assert.equal(res.status, 400, type);
    }
    const withCharset = await h.call('/v1/device', {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    assert.equal(withCharset.status, 200);
  });

  test('an empty body is {}; a body that is not a JSON object is 400', async () => {
    const h = harness();
    assert.equal((await h.call('/v1/device', null, { raw: '' })).status, 200);
    for (const raw of ['[1,2]', '"text"', '{not json', 'null']) {
      const res = await h.call('/v1/device', null, { raw });
      assert.equal(res.status, 400, raw);
      assert.equal(res.body.error.code, 'bad_request');
    }
  });

  test('every error has the envelope, and every response has a request id', async () => {
    const h = harness();
    const res = await h.call('/v1/restore', {}, { headers: { 'X-Grayout-Request-Id': 'abc.123_x-y' } });
    assert.equal(res.status, 401);
    assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']);
    assert.equal(res.headers.get('X-Grayout-Request-Id'), 'abc.123_x-y');
    const bad = await h.call('/v1/restore', {}, { headers: { 'X-Grayout-Request-Id': 'has spaces!' } });
    assert.match(bad.headers.get('X-Grayout-Request-Id'), /^[0-9a-f-]{36}$/);
  });

  test('without the database binding every route but health is 503', async () => {
    const h = harness({ env: { DB: undefined } });
    assert.equal((await h.call('/v1/device', {})).status, 503);
    assert.equal((await h.call('/v1/health', null, { method: 'GET' })).body.configured.db, false);
  });
});

describe('body limits are counted while the body streams in', () => {
  test('a declared Content-Length over 1 MiB is refused before reading', async () => {
    const h = harness();
    const res = await h.call('/v1/device', null, { raw: '{}', headers: { 'Content-Length': String(1024 * 1024 + 1) } });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'payload_too_large');
  });

  test('a chunked body with no length stops being read just past 1 MiB', async () => {
    const h = harness();
    const { request, sent } = streamingRequest('/v1/device', 50 * 1024 * 1024);
    const res = await handleRequest(request, h.deps);
    assert.equal(res.status, 413);
    assert.ok(sent() < 2 * 1024 * 1024, `read ${sent()} bytes of 50 MiB`);
  });

  test('/v1/check allows 8 MiB and refuses more, also mid-stream', async () => {
    const h = harness();
    const { request: big, sent } = streamingRequest('/v1/check', 40 * 1024 * 1024);
    const res = await handleRequest(big, h.deps);
    assert.equal(res.status, 413);
    assert.ok(sent() > 8 * 1024 * 1024 && sent() < 9 * 1024 * 1024);
    // 2 MiB of whitespace is under the limit: it is read, then refused as an empty object.
    const { request: ok } = streamingRequest('/v1/check', 2 * 1024 * 1024);
    const under = await handleRequest(ok, h.deps);
    assert.equal(under.status, 400);
  });

  test('the webhook has a 1 MiB limit too', async () => {
    const h = harness();
    const res = await h.call('/v1/stripe/webhook', null, {
      raw: ' '.repeat(1024 * 1024 + 10), headers: { 'Stripe-Signature': 't=1,v1=x' }
    });
    assert.equal(res.status, 413);
  });
});

describe('CORS only on the routes the site uses', () => {
  test('health, device, checkout and claim answer the site origin; others never do', async () => {
    const h = harness();
    for (const path of ['/v1/device', '/v1/checkout', '/v1/claim', '/v1/health']) {
      const res = await h.call(path, null, { method: 'OPTIONS', headers: { Origin: SITE } });
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE, path);
    }
    for (const path of ['/v1/check', '/v1/status', '/v1/activate', '/v1/restore', '/v1/portal', '/v1/device-code', '/v1/stripe/webhook']) {
      const pre = await h.call(path, null, { method: 'OPTIONS', headers: { Origin: SITE } });
      assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null, path);
      const res = await h.call(path, {}, { headers: { Origin: SITE } });
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, path);
    }
  });

  test('an origin that is not the site gets no CORS headers', async () => {
    const h = harness();
    const res = await h.call('/v1/device', {}, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('errors on CORS routes still carry CORS headers, so the site can read them', async () => {
    const h = harness();
    const res = await h.call('/v1/checkout', {}, { headers: { Origin: SITE } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);
  });
});

describe('the per-IP limit', () => {
  test('RL_IP refusals are 429 with Retry-After and retryAfter, keyed on the IP', async () => {
    const h = harness();
    h.limiters.RL_IP.max = 2;
    await h.call('/v1/restore', {});
    await h.call('/v1/restore', {});
    const res = await h.call('/v1/restore', {});
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'rate_limited');
    assert.equal(res.body.error.retryAfter, 60);
    assert.equal(res.headers.get('Retry-After'), '60');
    assert.deepEqual([...new Set(h.limiters.RL_IP.keys)], ['203.0.113.7']);
    const other = await h.call('/v1/restore', {}, { ip: '198.51.100.9' });
    assert.equal(other.status, 401, 'another address is not affected');
  });

  test('/v1/check, the webhook and health are not behind RL_IP', async () => {
    const h = harness();
    h.limiters.RL_IP.max = 0;
    assert.equal((await h.call('/v1/health', null, { method: 'GET' })).status, 200);
    assert.notEqual((await h.call('/v1/check', {})).status, 429);
    assert.notEqual((await h.call('/v1/stripe/webhook', {})).status, 429);
  });
});
