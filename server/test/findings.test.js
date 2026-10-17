// One regression test for each of the 29 confirmed problems in the v2 server
// (contract Appendix A). Each test reproduces the v2 failure and checks that it
// can no longer happen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { harness, parseJsonc, stripeEvent, T0, DAY } from './helpers.js';
import { STRIPE_API_VERSION } from '../src/config.js';
import { ApiVersion } from '../node_modules/stripe/esm/apiVersion.js';
import { stripeClientFor } from '../src/stripe.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(SERVER, path), 'utf8');

/** A Mac that bought (monthly trial unless told otherwise) and claimed its key. */
async function subscriber(h, options) {
  const device = await h.mint();
  const purchase = await h.appPurchase(device, options);
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code });
  return { device, license: claim.body.license, ...purchase };
}

const row = h => h.db.rows('SELECT * FROM licenses')[0];
const check = (h, device, license) => h.call('/v1/check', h.checkBody(device, license ? { license } : {}));

/** Capture every console line written while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const { log, error, warn } = console;
  console.log = console.error = console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, { log, error, warn });
  }
  return lines.join('\n');
}

describe('v2 findings, fixed', () => {
  test('finding 1: a late invoice.payment_failed cannot turn a canceled subscription back into service', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    // Dunning ran out: Stripe canceled the subscription.
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    // The last payment_failed arrives second (v2 set past_due = service forever).
    await h.deliver(stripeEvent('invoice.payment_failed', { id: 'in_1', customer: subscription.customer }));
    assert.equal(row(h).status, 'canceled');
    const res = await check(h, device, license);
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'subscription_inactive');
  });

  test('finding 2: subscription events that arrive early and out of order cannot lock out a paying customer', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, session, subscription } = await h.appPurchase(device, { plan: 'yearly' });
    // updated(active) first, then the older created(incomplete), both before checkout completed.
    await h.deliver(stripeEvent('customer.subscription.updated', { ...subscription, status: 'active' }));
    await h.deliver(stripeEvent('customer.subscription.created', { ...subscription, status: 'incomplete' }));
    await h.deliver(stripeEvent('checkout.session.completed', session));
    assert.equal(row(h).status, 'active');
    const key = (await h.call('/v1/claim', { ...device, deviceCode: code })).body.license;
    assert.equal((await check(h, device, key)).status, 200);
  });

  test('finding 3: a redelivered checkout.session.completed is a duplicate and never overwrites newer status', async () => {
    const h = harness();
    const device = await h.mint();
    const { session, subscription } = await h.appPurchase(device);
    const completed = stripeEvent('checkout.session.completed', session);
    await h.deliver(completed);
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    assert.deepEqual((await h.deliver(completed)).body, { received: true, action: 'duplicate' });
    assert.equal(row(h).status, 'canceled');
  });

  test('finding 4: checkout reuses the known customer and refuses a second subscription', async () => {
    const h = harness();
    const { device, subscription } = await subscriber(h);
    const again = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_subscribed');
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    const rebuy = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(rebuy.status, 200);
    const params = h.stripe.callsTo('checkout.sessions.create').at(-1).args[0];
    assert.equal(params.customer, subscription.customer, 'no new Customer');
    assert.equal(params.subscription_data, undefined, 'no second trial');
  });

  test('finding 5: refunds and disputes are handled and write revoked_at', async () => {
    for (const kind of ['refund', 'dispute']) {
      const h = harness();
      const { subscription } = await subscriber(h);
      const { paymentIntent, charge } = h.stripe.addPaidInvoice(subscription.id);
      const event = kind === 'refund'
        ? stripeEvent('charge.refunded', { id: charge, payment_intent: paymentIntent, refunded: true })
        : stripeEvent('charge.dispute.created', { id: 'dp_1', charge, payment_intent: paymentIntent });
      assert.equal((await h.deliver(event)).body.action, 'revoked', kind);
      assert.ok(row(h).revoked_at, kind);
      assert.equal(row(h).revoked_reason, kind);
    }
  });

  test('finding 6: the SDK and API version are current, pinned, and match; the webhook endpoint is pinned too', async () => {
    assert.equal(STRIPE_API_VERSION, '2026-08-26.dahlia');
    assert.equal(ApiVersion, STRIPE_API_VERSION, 'stripe-node pins the same version');
    assert.equal(JSON.parse(read('package.json')).dependencies.stripe, '^22.6.0');
    assert.match(read('README.md'), /API version: `2026-08-26\.dahlia`/);
    const h = harness();
    const device = await h.mint();
    await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(h.stripe.callsTo('checkout.sessions.create')[0].args[0].integration_identifier, 'grayout_pro_kaklnzxs');
  });

  test('finding 7: tax is collected, because Stripe is the merchant of record (Managed Payments)', async () => {
    const h = harness();
    const device = await h.mint();
    await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    const params = h.stripe.callsTo('checkout.sessions.create')[0].args[0];
    assert.deepEqual(params.managed_payments, { enabled: true });
    for (const forbidden of ['automatic_tax', 'tax_id_collection', 'payment_method_types', 'invoice_creation', 'custom_text']) {
      assert.equal(forbidden in params, false, forbidden);
    }
  });

  test('finding 8: the runbook uses a restricted key and sandboxes, not sk_ and shared test mode', () => {
    const readme = read('README.md');
    assert.match(readme, /Create restricted key/);
    assert.match(readme, /sandbox/i);
    assert.equal(/sk_(live|test)_…/.test(readme.replace(/never use the full `sk_` secret key/, '')), false);
    assert.match(read('.dev.vars.example'), /^STRIPE_SECRET_KEY=rk_test_/m);
  });

  test('finding 9: the portal set-up turns on plan switching and end-of-period cancellation', () => {
    const readme = read('README.md');
    assert.match(readme, /\*\*switch\s+plans\*\* on, with Grayout Pro's monthly and yearly prices/);
    assert.match(readme, /cancellations \*\*at the end of\s+the billing period\*\*/);
  });

  test('finding 10: a webhook signed with the public whsec_placeholder can never mint a license', async () => {
    const h = harness({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_placeholder' } });
    const device = await h.mint();
    const code = (await h.call('/v1/device-code', device)).body.deviceCode;
    const checkout = await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: code });
    // The attacker forges "completed" for their own session with the public secret.
    const forged = stripeEvent('checkout.session.completed', { id: checkout.body.sessionId, payment_status: 'paid', customer: 'cus_forged', livemode: false });
    const res = await h.deliver(forged, { secret: 'whsec_placeholder' });
    assert.equal(res.status, 503);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0);
    // And claiming asks Stripe, which knows the session was never paid.
    h.clock.advance(10);
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' });
    assert.equal(read('README.md').includes('whsec_placeholder'), false);

    // A long, well-shaped placeholder is refused too.
    const long = 'whsec_placeholder_0123456789abcdefghijklmnopqrstuv';
    const h2 = harness({ env: { STRIPE_WEBHOOK_SECRET: long } });
    assert.equal((await h2.deliver(forged, { secret: long })).status, 503);
  });

  test('finding 11: stale events cannot re-grant service, and a trial always has an end', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    const staleUpdate = stripeEvent('customer.subscription.updated', { ...subscription, status: 'active' });
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    await h.deliver(staleUpdate); // a retry of an old delivery
    assert.equal(row(h).status, 'canceled');
    assert.equal((await check(h, device, license)).status, 402);

    // A trial row with no period end never grants service.
    h.db.write("UPDATE licenses SET status = 'trialing', period_end = NULL, synced_at = ?", T0);
    assert.equal((await check(h, device, license)).body.error.code, 'subscription_inactive');
  });

  test('finding 12: the free tier cannot be multiplied by inventing device ids, and is budgeted globally', async () => {
    const h = harness({ env: { FREE_DAILY_BUDGET: '5' } });
    // A self-chosen id is not a device.
    const invented = await h.call('/v1/check', h.checkBody({ deviceId: 'dev_0123456789ABCDEFGHJKMNPQRS', deviceToken: 'A'.repeat(43) }));
    assert.equal(invented.body.error.code, 'device_unverified');
    // Minting is limited per network.
    for (let i = 0; i < 10; i++) { h.limiters.RL_MINT.reset(); await h.mint(); }
    h.limiters.RL_MINT.reset();
    assert.equal((await h.call('/v1/device', {})).status, 429);
    // The global budget caps spend however many devices exist.
    const ok = [];
    for (let i = 0; i < 8; i++) {
      const device = await h.mint(`198.51.100.${i}`);
      h.limiters.RL_FREE_IP.reset(); // a minute passes between these
      ok.push((await check(h, device)).status);
    }
    assert.deepEqual(ok, [200, 200, 200, 200, 200, 402, 402, 402]);
    assert.equal(h.fetch.calls.length, 5);
    // text/plain is refused, and /v1/check answers no browser.
    const plain = await h.call('/v1/check', {}, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(plain.status, 400);
    const fromSite = await h.call('/v1/check', {}, { headers: { Origin: 'https://aarushkandukoori.github.io' } });
    assert.equal(fromSite.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('finding 13: the service trusts no unowned grayout.app origin', async () => {
    const config = parseJsonc(read('wrangler.jsonc'));
    assert.equal(JSON.stringify(config).includes('grayout.app'), false);
    const h = harness({ env: { SITE_ORIGINS: config.vars.SITE_ORIGINS } });
    const res = await h.call('/v1/device', {}, { headers: { Origin: 'https://grayout.app' } });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('finding 14: junk unauthenticated requests write nothing and never reach Stripe', async () => {
    const h = harness();
    const tables = () => h.db.rows("SELECT (SELECT COUNT(*) FROM devices) + (SELECT COUNT(*) FROM device_codes) + (SELECT COUNT(*) FROM checkout_sessions) + (SELECT COUNT(*) FROM licenses) AS n")[0].n;
    const before = tables();
    for (let i = 0; i < 30; i++) {
      await h.call('/v1/claim', { sessionId: `cs_test_${String(i).padStart(12, 'a')}` });
      await h.call('/v1/claim', { deviceCode: `ABCD-${String(1000 + i)}`, deviceId: 'dev_0123456789ABCDEFGHJKMNPQRS', deviceToken: 'A'.repeat(43) });
      await h.call('/v1/checkout', { deviceId: 'dev_0123456789ABCDEFGHJKMNPQRS', deviceToken: 'A'.repeat(43), plan: 'monthly' });
    }
    assert.equal(tables(), before);
    assert.equal(h.stripe.calls.length, 0);
  });

  test('finding 15: an unpaid (delayed) checkout gets no license until the money clears', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, session } = await h.appPurchase(device, { plan: 'yearly', paymentStatus: 'unpaid' });
    assert.equal((await h.deliver(stripeEvent('checkout.session.completed', session))).body.action, 'awaiting_payment');
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' });
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0);
    await h.deliver(stripeEvent('checkout.session.async_payment_succeeded', h.stripe.settleSession(session.id, true)));
    h.clock.advance(10);
    assert.equal((await h.call('/v1/claim', { ...device, deviceCode: code })).body.status, 'ready');
  });

  test('finding 16: license keys, tokens and session ids never appear in URLs or logs', async () => {
    let secrets = [];
    const logs = await captureLogs(async () => {
      const h = harness();
      const { device, license, checkout } = await subscriber(h);
      secrets = [license, device.deviceToken, checkout.body.sessionId];
      await h.call('/v1/status', { ...device, license, portal: true });
      await check(h, device, license);
      h.stripe.failOn('checkout.sessions.retrieve', { error: Object.assign(new Error(`No such session ${checkout.body.sessionId}`), { type: 'StripeInvalidRequestError' }) });
      await h.call('/v1/claim', { sessionId: checkout.body.sessionId });
      await h.call('/v1/check', h.checkBody(device, { license: license + 'X' }));
      // GET with a license in the URL does not exist.
      assert.equal((await h.call(`/v1/status?license=${license}`, null, { method: 'GET' })).status, 405);
    });
    for (const secret of secrets) assert.equal(logs.includes(secret), false, 'a secret reached a log line');
  });

  test('finding 17: concurrent completions (webhook, webhook, claim) mint exactly one key', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, session } = await h.appPurchase(device);
    const [a, b, claim] = await Promise.all([
      h.deliver(stripeEvent('checkout.session.completed', session)),
      h.deliver(stripeEvent('checkout.session.completed', session)),
      h.call('/v1/claim', { ...device, deviceCode: code })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 1);
    const restored = (await h.call('/v1/restore', device)).body.license;
    if (claim.body.status === 'ready') assert.equal(claim.body.license, restored);
    assert.equal((await check(h, device, restored)).status, 200);
  });

  test('finding 18: a full sk_ key works but is flagged; a restricted rk_ key is the documented choice', async () => {
    // Keys joined at runtime: secret scanners flag key-shaped literals, even fake ones.
    const logs = await captureLogs(async () => {
      stripeClientFor({ STRIPE_SECRET_KEY: ['sk', 'test', '51FullSecretKeyForThisTestOnly'].join('_') });
    });
    assert.match(logs, /use a restricted key/);
    const quiet = await captureLogs(async () => {
      stripeClientFor({ STRIPE_SECRET_KEY: ['rk', 'test', '51RestrictedKeyForThisTestOnly'].join('_') });
    });
    assert.equal(quiet.includes('restricted'), false);
  });

  test('finding 19: bodies are measured while they stream and cut off at the limit', async () => {
    const h = harness();
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 65536;
        if (pulled > 64 * 1024 * 1024) return controller.close();
        controller.enqueue(new Uint8Array(65536).fill(0x20));
      }
    });
    const { handleRequest } = await import('../src/index.js');
    const res = await handleRequest(new Request('https://x.test/v1/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half'
    }), h.deps);
    assert.equal(res.status, 413);
    assert.ok(pulled <= 9 * 1024 * 1024, `pulled ${pulled} bytes`);
  });

  test('finding 20: a retried checkout event after a cancellation cannot revive the subscription', async () => {
    const h = harness();
    const device = await h.mint();
    const { session, subscription } = await h.appPurchase(device);
    const completed = stripeEvent('checkout.session.completed', session);
    // First attempt fails half-way (Stripe read errors), so Stripe will retry it.
    h.stripe.failOn('subscriptions.list');
    assert.equal((await h.deliver(completed)).status, 500);
    // Meanwhile the customer cancels.
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    // The retry arrives: it issues the license but writes what Stripe says now.
    assert.equal((await h.deliver(completed)).body.action, 'license_issued');
    assert.equal(row(h).status, 'canceled');
    const key = (await h.call('/v1/restore', device)).body.license;
    assert.equal((await check(h, device, key)).status, 402);
  });

  test('finding 21: no ordering trap: late events and old subscriptions cannot overwrite the current one', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    const oldSub = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    const current = h.stripe.addSubscription({ customer: subscription.customer, status: 'active', created: T0 + 60 });
    await h.deliver(stripeEvent('invoice.paid', { customer: subscription.customer }));
    assert.equal(row(h).subscription_id, current.id);
    // A late event about the OLD subscription, claiming it is active.
    await h.deliver(stripeEvent('customer.subscription.updated', { ...oldSub, status: 'active' }));
    await h.deliver(stripeEvent('invoice.payment_failed', { customer: subscription.customer }));
    assert.equal(row(h).subscription_id, current.id);
    assert.equal(row(h).status, 'active');
    assert.equal((await check(h, device, license)).status, 200);
  });

  test('finding 22: a paid Mac that lost its key is told to restore it, can restore it, and cannot buy twice', async () => {
    const h = harness();
    const device = await h.mint();
    const { session } = await h.appPurchase(device);
    // The app was quit before it claimed; only the webhook ran.
    await h.deliver(stripeEvent('checkout.session.completed', session));
    const res = await check(h, device);
    assert.equal(res.body.error.code, 'no_license');
    assert.equal(/subscribe/i.test(res.body.error.message), false);
    const restore = await h.call('/v1/restore', device);
    assert.equal(restore.body.status, 'ready');
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'monthly' })).status, 409);
    assert.equal((await check(h, device, restore.body.license)).status, 200);
  });

  test('finding 23: no Workers KV anywhere; durable state is in D1', () => {
    const config = parseJsonc(read('wrangler.jsonc'));
    assert.equal(config.kv_namespaces, undefined);
    assert.equal(config.d1_databases[0].binding, 'DB');
    for (const file of readdirSync(join(SERVER, 'src'))) {
      assert.equal(/GRAYOUT_KV|\.put\(|kvStore/.test(read(`src/${file}`)), false, file);
    }
    assert.match(read('README.md'), /Workers Paid/);
  });

  test('finding 24: the 100 free checks are exact under a burst, and reserved before the model call', async () => {
    const h = harness();
    h.limiters.RL_DEVICE.max = 1000;
    h.limiters.RL_FREE_IP.max = 1000;
    h.limiters.RL_CHECK_IP.max = 1000;
    const device = await h.mint();
    const results = await Promise.all(Array.from({ length: 130 }, () => check(h, device)));
    assert.equal(results.filter(r => r.status === 200).length, 100);
    assert.equal(results.filter(r => r.status === 402).length, 30);
    assert.equal(h.fetch.calls.length, 100, 'the model is never called for a refused check');
    assert.equal(h.db.rows('SELECT free_used FROM devices')[0].free_used, 100);
  });

  test('finding 25: a website purchase gets its key synchronously, with no webhook at all', async () => {
    const h = harness();
    const browser = await h.mint();
    const checkout = await h.call('/v1/checkout', { ...browser, plan: 'monthly' });
    h.stripe.completeSession(checkout.body.sessionId);
    const res = await h.call('/v1/claim', { sessionId: checkout.body.sessionId });
    assert.equal(res.body.status, 'ready');
    assert.match(res.body.license, /^gry_test_/);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM processed_events')[0].n, 0, 'no webhook was involved');
  });

  test('finding 26: subscription.created racing checkout.session.completed loses nothing', async () => {
    const h = harness();
    const device = await h.mint();
    const { session, subscription } = await h.appPurchase(device);
    await Promise.all([
      h.deliver(stripeEvent('customer.subscription.created', subscription)),
      h.deliver(stripeEvent('checkout.session.completed', session))
    ]);
    const r = row(h);
    assert.equal(r.status, 'trialing');
    assert.equal(r.period_end, T0 + 7 * DAY, 'the trial has an end date');
    assert.equal(r.subscription_id, subscription.id);
  });

  test('finding 27: one trial per device and per customer', async () => {
    const h = harness();
    // App: trial, cancel, buy again → no trial.
    const { device, subscription } = await subscriber(h);
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'monthly' })).body.trial, false);

    // Website: a browser that already bought a trial cannot even start a
    // second checkout (2026-10-08 review: it is now 409, not a paid second one).
    const browser = await h.mint();
    const first = await h.call('/v1/checkout', { ...browser, plan: 'monthly' });
    assert.equal(first.body.trial, true);
    h.stripe.completeSession(first.body.sessionId);
    await h.call('/v1/claim', { sessionId: first.body.sessionId });
    assert.equal((await h.call('/v1/checkout', { ...browser, plan: 'monthly' })).status, 409);
  });

  test('finding 28: a refund or dispute cuts off access at once', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    assert.equal((await check(h, device, license)).status, 200);
    const { charge } = h.stripe.addPaidInvoice(subscription.id);
    await h.deliver(stripeEvent('charge.dispute.created', { id: 'dp_1', charge, payment_intent: null }));
    const res = await check(h, device, license);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'license_revoked');
    assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled', 'no renewal will charge the disputed card again');
  });

  test('finding 29: active and past_due end 3 days after the paid period, even if no event ever arrives', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'monthly' });
    // The trial converted: the first month (T0+7d to T0+37d) was PAID.
    h.stripe.updateSubscription(subscription.id, { status: 'active', periodStart: T0 + 7 * DAY, periodEnd: T0 + 37 * DAY });
    h.clock.set(T0 + 20 * DAY);
    const paid = await check(h, device, license);
    assert.equal(paid.status, 200);
    // Then the first RENEWAL failed. Stripe moved the period forward and says
    // past_due; no webhook reached us. (A trial whose first charge fails is a
    // different case, with no grace at all: test/third-pass.test.js.)
    h.stripe.updateSubscription(subscription.id, { status: 'past_due', periodStart: T0 + 37 * DAY, periodEnd: T0 + 67 * DAY });
    h.clock.set(T0 + 39 * DAY);
    // The app's daily /v1/status re-reads the day-old row, so past_due is stored.
    const status = await h.call('/v1/status', { ...device, license });
    assert.equal(status.body.status, 'past_due');
    assert.equal(status.body.service, true);
    const grace = await check(h, device, license);
    assert.equal(grace.status, 200, 'inside the 3-day grace');
    assert.equal(grace.body.plan, 'past_due');
    assert.equal(grace.body.usage.checksIncluded, 10000, 'a customer who paid keeps the paid allowance in grace');
    h.clock.set(T0 + 40 * DAY + 1);
    const res = await check(h, device, license);
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'subscription_inactive');
    // And a stored "active" with no fresh period ends too.
    h.stripe.updateSubscription(subscription.id, { status: 'active', periodStart: T0 + 7 * DAY, periodEnd: T0 + 37 * DAY });
    h.clock.set(T0 + 60 * DAY);
    assert.equal((await check(h, device, license)).status, 402);
  });
});
