// POST /v1/check, the watch loop's one call (contract 6.11).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { harness, T0, DAY } from './helpers.js';

async function subscriber(h) {
  const device = await h.mint();
  const purchase = await h.appPurchase(device);
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code });
  return { device, license: claim.body.license, subscription: purchase.subscription };
}

const freeUsed = (h, deviceId) => h.db.rows('SELECT free_used FROM devices WHERE device_id = ?', deviceId)[0].free_used;
const budgetUsed = h => (h.db.rows('SELECT n FROM free_budget')[0] || { n: 0 }).n;

describe('validation comes first', () => {
  test('malformed bodies are 400 before the device is checked or the model is called', async () => {
    const h = harness();
    const bad = [
      { displays: [] },
      { displays: ['QQ==', 'QQ==', 'QQ==', 'QQ=='] },
      { displays: ['not base64!'] },
      { displays: [42] },
      { displays: ['QQ=='], webcam: 'nope!' },
      { displays: ['QQ=='], context: [] },
      { displays: ['QQ=='], context: { workDescription: 'x'.repeat(501) } },
      { displays: ['QQ=='], context: { frontApp: 'x'.repeat(81) } },
      { displays: ['QQ=='], context: { canvasTasks: Array(21).fill('t') } },
      { displays: ['QQ=='], context: { fileTasks: [1, 2] } },
      { displays: ['QQ=='], license: 12345 }
    ];
    for (const body of bad) {
      const res = await h.call('/v1/check', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, 'bad_request');
    }
    assert.equal(h.fetch.calls.length, 0);
  });

  test('an unverified device is 401 and costs nothing', async () => {
    const h = harness();
    const res = await h.call('/v1/check', h.checkBody({ deviceId: 'dev_0000000000000000000000000Z', deviceToken: 'x'.repeat(43) }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'device_unverified');
    assert.equal(h.fetch.calls.length, 0);
  });
});

describe('the free taste', () => {
  test('a verdict, the usage after this check, plan free, service true', async () => {
    const h = harness();
    const device = await h.mint();
    const res = await h.call('/v1/check', h.checkBody(device, { context: { workDescription: 'thesis', canvasTasks: ['HW 3'], fileTasks: [] } }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      verdict: { off_task: false, activity: 'code editor and terminal', confidence: 'high' },
      usage: { checksUsed: 1, checksIncluded: 100, periodEnd: null, resetsAt: null },
      plan: 'free',
      service: true
    });
    // The server owns the prompt; the client's text only appears as fenced data.
    const sent = h.fetch.calls[0].body;
    const text = sent.input[0].content.find(c => c.type === 'input_text').text;
    assert.match(text, /You are a screen monitor/);
    assert.match(text, /<<<\n- HW 3\n>>>/);
    assert.equal(h.fetch.calls[0].init.headers.Authorization, `Bearer ${h.env.OPENAI_API_KEY}`);
  });

  test('100 checks per device, then free_exhausted / device without calling the model', async () => {
    const h = harness();
    const device = await h.mint();
    h.db.write('UPDATE devices SET free_used = 100');
    const res = await h.call('/v1/check', h.checkBody(device));
    assert.equal(res.status, 402);
    assert.deepEqual(res.body.error, { code: 'free_exhausted', message: res.body.error.message, reason: 'device' });
    assert.equal(h.fetch.calls.length, 0);
  });

  test('the global daily budget: free_exhausted / daily_budget, and the device check is given back', async () => {
    const h = harness({ env: { FREE_DAILY_BUDGET: '2' } });
    const a = await h.mint();
    const b = await h.mint();
    assert.equal((await h.call('/v1/check', h.checkBody(a))).status, 200);
    assert.equal((await h.call('/v1/check', h.checkBody(a))).status, 200);
    const res = await h.call('/v1/check', h.checkBody(b));
    assert.equal(res.status, 402);
    assert.equal(res.body.error.reason, 'daily_budget');
    assert.match(res.body.error.message, /midnight UTC/);
    assert.equal(freeUsed(h, b.deviceId), 0);
    h.clock.advance(DAY);
    assert.equal((await h.call('/v1/check', h.checkBody(b))).status, 200, 'a new UTC day');
  });

  test('RL_FREE_IP: 4 free checks a minute per network', async () => {
    const h = harness();
    const device = await h.mint();
    for (let i = 0; i < 4; i++) assert.equal((await h.call('/v1/check', h.checkBody(device))).status, 200);
    const res = await h.call('/v1/check', h.checkBody(device));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'rate_limited');
    assert.equal(freeUsed(h, device.deviceId), 4);
  });

  test('RL_DEVICE: 40 a minute per device, keyed on the device id', async () => {
    const h = harness();
    const device = await h.mint();
    h.limiters.RL_DEVICE.max = 1;
    await h.call('/v1/check', h.checkBody(device));
    assert.equal((await h.call('/v1/check', h.checkBody(device))).status, 429);
    assert.deepEqual([...new Set(h.limiters.RL_DEVICE.keys)], [`dev:${device.deviceId}`]);
  });

  test('a model failure is 502 and gives back both the device check and the budget', async () => {
    const h = harness({ responder: { status: 500, text: 'boom' } });
    const device = await h.mint();
    const res = await h.call('/v1/check', h.checkBody(device));
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'upstream_unavailable');
    assert.equal(freeUsed(h, device.deviceId), 0);
    assert.equal(budgetUsed(h), 0);
  });

  test('no model key is 503 not_configured, and nothing is reserved', async () => {
    const h = harness({ env: { OPENAI_API_KEY: '' } });
    const device = await h.mint();
    const res = await h.call('/v1/check', h.checkBody(device));
    assert.equal(res.status, 503);
    assert.equal(freeUsed(h, device.deviceId), 0);
  });

  test('a device that has a license on file and sends none gets no_license, never "subscribe"', async () => {
    const h = harness();
    const { device } = await subscriber(h);
    const res = await h.call('/v1/check', h.checkBody(device));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'no_license');
    assert.equal(/subscribe/i.test(res.body.error.message), false);
  });
});

describe('with a license', () => {
  test('counts against the monthly allowance and reports the subscription', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    const res = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(res.status, 200);
    // A trial gets 1,000 checks a month (TRIAL_CHECKS), not 10,000.
    assert.deepEqual(res.body.usage, { checksUsed: 1, checksIncluded: 1000, periodEnd: '2026-10-15T12:00:00Z', resetsAt: '2026-11-01T00:00:00Z' });
    assert.equal(res.body.plan, 'trialing');
    assert.equal(res.body.service, true);
    const bearer = await h.call('/v1/check', h.checkBody(device), { headers: { Authorization: `Bearer ${license}` } });
    assert.equal(bearer.body.usage.checksUsed, 2);
  });

  test('a key used on a new Mac attaches it there', async () => {
    const h = harness();
    const { license } = await subscriber(h);
    const other = await h.mint();
    assert.equal((await h.call('/v1/check', h.checkBody(other, { license }))).status, 200);
    assert.ok(h.db.rows('SELECT license_id FROM devices WHERE device_id = ?', other.deviceId)[0].license_id);
  });

  test('past 10,000 checks (the contract allowance): one per 10 minutes, with retryAfter, until the month resets', async () => {
    const h = harness();
    // A PAID subscriber (yearly, no trial): a trial's allowance is TRIAL_CHECKS,
    // so a trial here would never reach the 10,000 being tested.
    const device = await h.mint();
    const purchase = await h.appPurchase(device, { plan: 'yearly' });
    const license = (await h.call('/v1/claim', { ...device, deviceCode: purchase.code })).body.license;
    // One under the allowance is still served at full speed.
    h.db.write("INSERT INTO usage (license_id, month, n, last_at) VALUES (1, '2026-10', 9999, ?)", T0 - 100);
    const last = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(last.status, 200);
    assert.deepEqual([last.body.usage.checksUsed, last.body.usage.checksIncluded], [10000, 10000]);
    h.db.write("UPDATE usage SET last_at = ? WHERE license_id = 1", T0 - 100);
    const modelCalls = h.fetch.calls.length;
    const res = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'quota_exceeded');
    assert.equal(res.body.error.retryAfter, 500);
    assert.equal(res.headers.get('Retry-After'), '500');
    assert.match(res.body.error.message, /2026-11-01T00:00:00Z/);
    assert.equal(h.fetch.calls.length, modelCalls, 'a refused check never reaches the model');
    h.clock.advance(500);
    const later = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(later.status, 200);
    assert.equal(later.body.usage.checksUsed, 10001);
    assert.equal(later.body.usage.checksIncluded, 10000);
  });

  test('RL_LICENSE is keyed on the license row id, never the key', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    await h.call('/v1/check', h.checkBody(device, { license }));
    assert.deepEqual(h.limiters.RL_LICENSE.keys, ['lic:1']);
    assert.equal(JSON.stringify(Object.values(h.limiters).map(l => l.keys)).includes(license), false);
  });

  test('a model failure gives the paid check back', async () => {
    const h = harness({ responder: (url, init, n) => ({ status: n === 1 ? 503 : 200 }) });
    const { device, license } = await subscriber(h);
    assert.equal((await h.call('/v1/check', h.checkBody(device, { license }))).status, 502);
    assert.equal((await h.call('/v1/check', h.checkBody(device, { license }))).body.usage.checksUsed, 1);
  });

  test('unknown keys are license_invalid; refused subscriptions are 402 and cost nothing', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    assert.equal((await h.call('/v1/check', h.checkBody(device, { license: 'gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D' }))).body.error.code, 'license_invalid');

    // The trial ran out and Stripe still says trialing (no renewal happened): trial_expired.
    h.clock.advance(11 * DAY);
    let res = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'trial_expired');

    h.stripe.updateSubscription(subscription.id, { status: 'unpaid' });
    h.clock.advance(1000);
    res = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(res.body.error.code, 'subscription_inactive');
    assert.equal(h.fetch.calls.length, 0);
  });
});
