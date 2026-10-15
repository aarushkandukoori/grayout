// Regression tests for the second pass over the 2026-10-08 review of the v3
// server: 21 items (19 confirmed findings and 2 follow-ups), numbered 1 to 21
// in the table below. They cover sandbox licenses getting real service, trial
// abuse, second subscriptions, billed model failures, free checks per
// network and per IPv6 block, the cost of one check, and deploy.sh's Node
// version check (contract Appendix B, B13 to B17).
//
// Most were fixed in the first pass and already have a test in
// test/review-findings.test.js. This table says where each finding's test
// lives; the tests in THIS file cover what the first pass left out.
//
//  #  finding                                                   test
//  1  sandbox licenses got real model service                   fix 1 (below), review 5, review 13
//  2  unlimited trials by re-minting a device                   review 14 (same card), review 4 (same email)
//  3  past_due/unpaid/paused customer sent to a second checkout review 1, review 15
//  4  billed model failures gave the budget back                review 16, fix 10 (below)
//  5  a failed Stripe re-read was not throttled                 review 17
//  6  deploy.sh accepted Node 22.0 to 22.12                     fix 6 (below)
//  7  sandbox licenses kept service after go-live              review 5, review 13
//  8  unlimited trials from fresh devices; trial claimed late   review 6, review 14
//  9  free checks per network; one /48 could drain the budget   review 7, fix 9 (below)
// 10  billed failures (timeout, incomplete) gave the budget back review 8, fix 10 (below)
// 11  second subscription from website buyers and past_due      review 0, review 1, review 9
// 12  revocation waited for a successful Stripe cancel          review 10
// 13  RL_LICENSE too late; status/activate re-reads uncounted   review 11, fix 13 (below)
// 14  per-check model cost not bounded                          fix 14 (below)
// 15  website buyers never linked to their license              review 0
// 16  past_due customer sent to checkout, not the portal       review 1, review 15
// 17  a price change locked out existing subscribers            review 2
// 18  radar.early_fraud_warning.created not handled             review 3
// 19  one trial per browser, not per person                     review 4
// 20  close other sessions; never re-point a device; trial      fix 20 (below), review 9, review 6
//     claimed at creation
// 21  one trial per buyer (email and card), not per device      review 4, review 14

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { harness, responsesPayload, stripeEvent, tinyJpeg, SCREENSHOT, T0, DAY } from './helpers.js';
import { UpstreamError, analyze } from '../src/model.js';
import { MAX_IMAGE_BYTES } from '../src/config.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SERVER, '..');

/** A shaped live key for tests. Not a real key. Assembled at runtime so secret
 *  scanners do not mistake the fixture for a leaked credential. */
const LIVE_KEY = ['rk', 'live', '51TestOnlyRestrictedKey0123456789'].join('_');
const LIVE_ENV = { STRIPE_SECRET_KEY: LIVE_KEY, ALLOW_TEST_LICENSES: undefined };

/** A Mac that bought (yearly unless told otherwise) and claimed its key. */
async function subscriber(h, { plan = 'yearly', ip } = {}) {
  const device = await h.mint(ip);
  const purchase = await h.appPurchase(device, { plan });
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code });
  return { device, license: claim.body.license, ...purchase };
}

const check = (h, device, license, options) => h.call('/v1/check', h.checkBody(device, license ? { license } : {}), options);
const budgetUsed = h => h.db.rows('SELECT COALESCE(SUM(n), 0) AS n FROM free_budget')[0].n;

/** Every per-minute limiter reset: "a minute passed". */
function minutePasses(h) {
  for (const limiter of Object.values(h.limiters)) limiter.reset();
}

describe('second pass over the 2026-10-08 review', () => {
  test('fix 1: on the sandbox Worker, test-key checks come out of the daily budget, so test cards cannot spend the model key without limit', async () => {
    const h = harness({ env: { FREE_DAILY_BUDGET: '3' } });
    const { device, license } = await subscriber(h);
    assert.match(license, /^gry_test_/);
    const statuses = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await check(h, device, license);
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal(last.body.error.code, 'quota_exceeded');
    assert.match(last.body.error.message, /sandbox/);
    assert.equal(last.body.error.retryAfter, 12 * 3600, 'until midnight UTC (T0 is noon)');
    assert.equal(h.fetch.calls.length, 3, 'the model was called three times, not four');
    assert.equal(budgetUsed(h), 3);
    assert.equal(h.db.rows('SELECT n FROM usage')[0].n, 3, 'the refused check was not counted against the license');
    // A second test key bought the same way shares the same daily cap.
    minutePasses(h);
    const second = await subscriber(h, { ip: '198.51.100.20' });
    assert.equal((await check(h, second.device, second.license, { ip: '198.51.100.20' })).status, 429);
  });

  test('fix 1: on the live Worker, live keys never touch the free budget, and a sandbox customer is never passed to live Checkout', async () => {
    const h = harness({ env: { ...LIVE_ENV, FREE_DAILY_BUDGET: '1' } });
    const { device, license } = await subscriber(h);
    assert.match(license, /^gry_live_/);
    for (let i = 0; i < 3; i++) assert.equal((await check(h, device, license)).status, 200);
    assert.equal(budgetUsed(h), 0);

    // A device that somehow holds a sandbox license (a database copied by
    // mistake): the live Worker ignores it and makes a fresh customer.
    const other = await h.mint('198.51.100.30');
    h.db.write(
      "INSERT INTO licenses (key_hash, livemode, customer_id, status, period_end, synced_at, created_at) VALUES ('x', 0, 'cus_sandbox1', 'active', ?, ?, ?)",
      T0 + 300 * DAY, T0, T0
    );
    const id = h.db.rows("SELECT id FROM licenses WHERE customer_id = 'cus_sandbox1'")[0].id;
    h.db.write('UPDATE devices SET license_id = ?, bought_license_id = ? WHERE device_id = ?', id, id, other.deviceId);
    const before = h.stripe.callsTo('subscriptions.list').length;
    const res = await h.call('/v1/checkout', { ...other, plan: 'yearly' }, { ip: '198.51.100.30' });
    assert.equal(res.status, 200);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').at(-1).args[0].customer, undefined);
    assert.equal(h.stripe.callsTo('subscriptions.list').length, before, 'the sandbox customer was never looked up at live Stripe');
  });

  test('fix 6: deploy.sh stops on Node 22.12 with a plain message, and goes on with 22.13', () => {
    const run = version => {
      const bin = mkdtempSync(join(tmpdir(), 'grayout-node-'));
      // A stand-in `node` that only reports a version. The real check runs first.
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; else echo ${version}; fi\n`);
      chmodSync(join(bin, 'node'), 0o755);
      return spawnSync('bash', [join(SERVER, 'scripts/deploy.sh'), 'sandbox'], {
        env: { ...process.env, DRY_RUN: '1', PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8'
      });
    };
    const old = run('22.12.0');
    assert.equal(old.status, 1);
    assert.match(old.stderr, /Node 22\.13 or newer is needed \(you have v22\.12\.0\)/);
    const ok = run('22.13.0');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(join(SERVER, 'README.md'), 'utf8'), /Node 22\.13 or newer/);
    assert.match(readFileSync(join(SERVER, 'package.json'), 'utf8'), /"node": ">=22\.13"/);
  });

  test('fix 9: one IPv6 /48 block cannot drain the day, however many /56 networks it holds', async () => {
    // Budget 2,000: a /48 block may take 1/20 of it, but never fewer than 100.
    const h = harness({ env: { FREE_DAILY_BUDGET: '2000' } });
    const a = '2001:db8:1:100::1'; // /56 network 2001:db8:1:100::
    const b = '2001:db8:1:200::1'; // another /56 in the same /48
    const deviceA = await h.mint(a);
    let served = 0;
    for (let i = 0; i < 100; i++) {
      if (i % 4 === 0) minutePasses(h);
      if ((await check(h, deviceA, null, { ip: a })).status === 200) served++;
    }
    assert.equal(served, 100);
    minutePasses(h);
    const deviceB = await h.mint(b);
    const refused = await check(h, deviceB, null, { ip: b });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.error.code, 'free_exhausted');
    assert.equal(refused.body.error.reason, 'daily_budget');
    assert.match(refused.body.error.message, /this network/);
    assert.equal(budgetUsed(h), 100, 'the global budget kept 1,900 for everyone else');
    // Everything handed back on the refusal: the device and the network kept their checks.
    assert.equal(h.db.rows('SELECT free_used FROM devices WHERE device_id = ?', deviceB.deviceId)[0].free_used, 0);
    // Another /48 is not affected, IPv4 is not affected, and tomorrow the block is free again.
    const c = '2001:db8:2:100::1';
    assert.equal((await check(h, await h.mint(c), null, { ip: c })).status, 200);
    assert.equal((await check(h, await h.mint('198.51.100.40'), null, { ip: '198.51.100.40' })).status, 200);
    h.clock.advance(DAY);
    minutePasses(h);
    assert.equal((await check(h, deviceB, null, { ip: b })).status, 200);
    // Only keyed hashes are stored, never the address.
    const hashes = h.db.rows('SELECT block_hash FROM free_block').map(r => r.block_hash).join(' ');
    assert.equal(/2001|db8/.test(hashes), false);
  });

  test('fix 10: only failures the provider certainly did not bill give a check back, and a timeout is billed', async () => {
    const ctx = { displays: [SCREENSHOT], webcam: null, context: { workDescription: '', canvasTasks: [], fileTasks: [] } };
    const json = payload => async () => new Response(JSON.stringify(payload), { status: 200 });
    const cases = [
      ['no connection', async () => { throw new TypeError('fetch failed'); }, false],
      ['an error status', async () => new Response('{}', { status: 503 }), false],
      ['a timeout after sending', async () => { throw new DOMException('timed out', 'TimeoutError'); }, true],
      ['a refusal', json(responsesPayload(undefined, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })), true],
      ['an incomplete answer', json(responsesPayload(undefined, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })), true],
      ['a body that is not JSON', async () => new Response('nope', { status: 200 }), true],
      ['no text', json(responsesPayload(undefined, { output: [] })), true]
    ];
    for (const [name, fetchImpl, billed] of cases) {
      const err = await analyze(ctx, { apiKey: 'k', fetchImpl }).then(() => null, e => e);
      assert.ok(err instanceof UpstreamError, name);
      assert.equal(err.billed, billed, name);
    }
    // End to end: a timeout keeps the free check and the day's budget spent.
    const h = harness({ responder: () => { throw new DOMException('timed out', 'TimeoutError'); } });
    const device = await h.mint();
    assert.equal((await check(h, device)).status, 502);
    assert.equal(h.db.rows('SELECT free_used FROM devices')[0].free_used, 1);
    assert.equal(budgetUsed(h), 1);
  });

  test('fix 13: a stale /v1/activate re-read counts against RL_STRIPE_IP, and over it the stored row is used', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    h.clock.advance(2 * DAY);
    h.limiters.RL_STRIPE_IP.max = 0;
    const before = h.stripe.callsTo('subscriptions.list').length;
    const res = await h.call('/v1/activate', { ...device, license });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, true);
    assert.equal(h.stripe.callsTo('subscriptions.list').length, before, 'no Stripe read over the limit');
    h.limiters.RL_STRIPE_IP.max = 10;
    h.clock.advance(20 * 60);
    await h.call('/v1/activate', { ...device, license });
    assert.equal(h.stripe.callsTo('subscriptions.list').length, before + 1);
  });

  test('fix 14: images bigger than the price assumes are refused before anything is spent, and the webcam goes at low detail', async () => {
    const h = harness();
    const device = await h.mint();
    const huge = Buffer.concat([Buffer.from(tinyJpeg(1366, 854), 'base64'), Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const refused = [
      ['a 1920 px wide screenshot', { displays: [tinyJpeg(1920, 1080)] }, /1366 pixels wide/],
      ['a screenshot taller than 2732 px', { displays: [tinyJpeg(1366, 3000)] }, /2732 tall/],
      ['an image over 1.5 MiB', { displays: [huge] }, /larger than/],
      ['a PNG', { displays: [png] }, /not a JPEG/],
      ['a 4K webcam photo', { displays: [SCREENSHOT], webcam: tinyJpeg(3840, 2160) }, /webcam photo must be at most/]
    ];
    for (const [name, patch, message] of refused) {
      const res = await h.call('/v1/check', h.checkBody(device, patch));
      assert.equal(res.status, 400, name);
      assert.equal(res.body.error.code, 'bad_request', name);
      assert.match(res.body.error.message, message, name);
    }
    assert.equal(h.fetch.calls.length, 0, 'the model was never called');
    assert.equal(h.db.rows('SELECT free_used FROM devices')[0].free_used, 0, 'nothing was counted');
    // The app's real sizes pass: three 1366 px displays and a 640x480 webcam photo.
    const ok = await h.call('/v1/check', h.checkBody(device, { displays: [SCREENSHOT, SCREENSHOT, SCREENSHOT], webcam: tinyJpeg(640, 480) }));
    assert.equal(ok.status, 200);
    const sent = h.fetch.calls[0].body.input[0].content.filter(part => part.type === 'input_image');
    assert.deepEqual(sent.map(part => part.detail), ['auto', 'auto', 'auto', 'low']);
    // The contract states the limits.
    const contract = readFileSync(join(REPO, 'docs/API-CONTRACT.md'), 'utf8');
    assert.match(contract, /MAX_IMAGE_WIDTH/);
  });

  test('fix 20: a second paid subscription for a device that already has one is canceled and refunded, and the device keeps its key', async () => {
    const h = harness();
    const device = await h.mint();
    // Session 1 is open. Session 2 was opened next to it before any guard
    // could help (it stands for a race, or an expire Stripe did not carry out).
    const first = await h.appPurchase(device, { plan: 'yearly' });
    const code2 = (await h.call('/v1/device-code', device)).body.deviceCode;
    const params = h.stripe.sessions.get(first.checkout.body.sessionId).params;
    const second = await h.stripe.checkout.sessions.create({ ...params });
    h.db.write(
      "INSERT INTO checkout_sessions (session_id, device_id, device_code, plan, trial, livemode, created_at, expires_at) VALUES (?, ?, ?, 'yearly', 0, 0, ?, ?)",
      second.id, device.deviceId, code2.replace('-', ''), T0, T0 + 3600
    );
    // Session 1 is paid and claimed: the device has a working key.
    const key = (await h.call('/v1/claim', { ...device, deviceCode: first.code })).body.license;
    assert.equal((await check(h, device, key)).status, 200);

    // Then session 2 is paid too, as a NEW customer.
    const { session, subscription } = h.stripe.completeSession(second.id);
    assert.notEqual(subscription.customer, first.subscription.customer);
    const event = stripeEvent('checkout.session.completed', session);
    assert.equal((await h.deliver(event)).body.action, 'duplicate_refunded');
    assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled', 'the second subscription will never bill again');
    assert.equal(h.stripe.refundList.length, 1, 'its payment was refunded');
    assert.equal(h.stripe.refundList[0].idempotencyKey.startsWith('grayout-duplicate-'), true);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 1, 'no license for the duplicate');
    const row = h.db.rows('SELECT license_id, bought_license_id FROM devices')[0];
    const firstId = h.db.rows('SELECT id FROM licenses')[0].id;
    assert.deepEqual([row.license_id, row.bought_license_id], [firstId, firstId], 'the device was not moved');
    // The app's poll for session 2 gets the key that works, not a canceled one.
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code2 })).body, { status: 'ready', license: key });
    assert.equal((await check(h, device, key)).status, 200);

    // A retried delivery, and the refund's own charge.refunded event, change nothing.
    assert.equal((await h.deliver(stripeEvent('checkout.session.completed', session))).body.action, 'duplicate_refunded');
    assert.equal(h.stripe.refundList.length, 1);
    const charge = [...h.stripe.chargeMap.values()].find(c => c.refunded);
    const refunded = await h.deliver(stripeEvent('charge.refunded', { id: charge.id, payment_intent: charge.payment_intent, refunded: true }));
    assert.equal(refunded.body.action, 'ignored');
    assert.equal(h.db.rows('SELECT revoked_at FROM licenses')[0].revoked_at, null, 'the first license is untouched');
  });

  test('fix 20: when Stripe will not expire an older open session, no second session is opened next to it', async () => {
    const h = harness();
    const device = await h.mint();
    const first = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(first.status, 200);
    h.stripe.failOn('checkout.sessions.expire');
    const second = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(second.status, 503);
    assert.equal(second.body.error.code, 'not_configured');
    assert.equal(h.stripe.callsTo('checkout.sessions.create').length, 1, 'no second payable session');
    assert.equal(h.stripe.sessions.get(first.body.sessionId).status, 'open');
    assert.equal(h.db.rows('SELECT state FROM checkout_sessions')[0].state, 'open', 'not marked expired while Stripe still takes payment');
    // Next time the expire works, and the new checkout goes ahead.
    const third = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(third.status, 200);
    assert.equal(h.stripe.sessions.get(first.body.sessionId).status, 'expired');
  });
});
