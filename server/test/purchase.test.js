// Buying: POST /v1/checkout and POST /v1/claim (contract 6.5, 6.6, 9).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { harness, PRICES, T0, DAY, stripeEvent } from './helpers.js';

const SITE = 'https://aarushkandukoori.github.io/grayout';

// Everything Managed Payments forbids or controls itself (contract section 9).
const FORBIDDEN = [
  'automatic_tax', 'tax_id_collection', 'adaptive_pricing', 'payment_method_types', 'payment_method_configuration',
  'customer_update', 'shipping_address_collection', 'shipping_options', 'invoice_creation', 'custom_text',
  'consent_collection', 'submit_type', 'payment_intent_data', 'metadata', 'allow_promotion_codes',
  'billing_address_collection', 'payment_method_collection'
];

describe('POST /v1/checkout: the Checkout Session', () => {
  test('a first monthly purchase from the app: exactly the contract parameters, with the trial', async () => {
    const h = harness();
    const device = await h.mint();
    const code = (await h.call('/v1/device-code', device)).body.deviceCode;
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: code });
    assert.equal(res.status, 200);
    assert.equal(res.body.trial, true);
    assert.match(res.body.sessionId, /^cs_test_/);
    assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);

    const params = h.stripe.callsTo('checkout.sessions.create')[0].args[0];
    assert.deepEqual(params, {
      mode: 'subscription',
      line_items: [{ price: PRICES.monthly, quantity: 1 }],
      managed_payments: { enabled: true },
      integration_identifier: 'grayout_pro_kaklnzxs',
      client_reference_id: device.deviceId,
      subscription_data: { trial_period_days: 7 },
      success_url: `${SITE}/success.html?session_id={CHECKOUT_SESSION_ID}&from=app`,
      cancel_url: `${SITE}/pricing.html?canceled=1&from=app`,
      expires_at: T0 + 3600
    });
    for (const key of FORBIDDEN) assert.equal(key in params, false, `${key} must not be sent`);

    const row = h.db.rows('SELECT * FROM checkout_sessions')[0];
    assert.equal(row.session_id, res.body.sessionId);
    assert.equal(row.device_id, device.deviceId);
    assert.equal(row.device_code, code.replace('-', ''));
    assert.deepEqual([row.plan, row.trial, row.livemode, row.state], ['monthly', 1, 0, 'open']);
  });

  test('yearly never has a trial; a website purchase has no code and no from=app', async () => {
    const h = harness();
    const device = await h.mint();
    const res = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(res.body.trial, false);
    const params = h.stripe.callsTo('checkout.sessions.create')[0].args[0];
    assert.deepEqual(params.line_items, [{ price: PRICES.yearly, quantity: 1 }]);
    assert.equal('subscription_data' in params, false);
    assert.equal(params.success_url, `${SITE}/success.html?session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(params.cancel_url, `${SITE}/pricing.html?canceled=1`, 'a website checkout comes back as before');
    assert.equal(h.db.rows('SELECT device_code FROM checkout_sessions')[0].device_code, null);
  });

  test('bad plans, foreign or expired codes, and malformed codes are refused before Stripe is called', async () => {
    const h = harness();
    const device = await h.mint();
    const other = await h.mint();
    const otherCode = (await h.call('/v1/device-code', other)).body.deviceCode;
    const myCode = (await h.call('/v1/device-code', device)).body.deviceCode;

    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'weekly' })).status, 400);
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: 'nope' })).status, 400);
    const foreign = await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: otherCode });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'code_expired');
    h.clock.advance(3601);
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: myCode })).body.error.code, 'code_expired');
    assert.equal(h.stripe.callsTo('checkout.sessions.create').length, 0);
  });

  test('a missing price or site, or Stripe refusing, is 503 with no Stripe wording leaked', async () => {
    const h = harness({ env: { STRIPE_PRICE_YEARLY: '' } });
    const device = await h.mint();
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'yearly' })).body.error.code, 'not_configured');
    h.stripe.failOn('checkout.sessions.create', { error: Object.assign(new Error('No such price: price_secret_123 on acct_9'), { type: 'StripeInvalidRequestError' }) });
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 503);
    assert.equal(JSON.stringify(res.body).includes('price_secret'), false);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM checkout_sessions')[0].n, 0);
  });

  test('RL_STRIPE_IP caps how often one address can make Stripe calls', async () => {
    const h = harness();
    const device = await h.mint();
    h.limiters.RL_STRIPE_IP.max = 2;
    await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 429);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').length, 2);
  });
});

describe('POST /v1/checkout: never a second subscription', () => {
  test('a device with working service gets 409 already_subscribed and a portal link', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    const before = h.stripe.callsTo('checkout.sessions.create').length;

    const res = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'already_subscribed');
    assert.match(res.body.error.portalUrl, /^https:\/\/billing\.stripe\.com\//);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').length, before);
  });

  test('the 409 portal link returns an app checkout to the app page, and a website checkout home', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    const returnUrl = () => h.stripe.callsTo('billingPortal.sessions.create').at(-1).args[0].return_url;

    // From the app: Subscribe always sends a fresh device code.
    const fromApp = (await h.call('/v1/device-code', device)).body.deviceCode;
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'yearly', deviceCode: fromApp })).status, 409);
    assert.equal(returnUrl(), `${SITE}/account.html?from=app`);

    // From the website: no device code, so the portal returns to the home page as before.
    assert.equal((await h.call('/v1/checkout', { ...device, plan: 'yearly' })).status, 409);
    assert.equal(returnUrl(), `${SITE}/`);
  });

  test('if the portal link cannot be made, portalUrl is null (still 409)', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    h.stripe.failOn('billingPortal.sessions.create');
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.portalUrl, null);
  });

  test('a lapsed subscriber buys again as the same Stripe customer, without a second trial', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, subscription } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    const canceled = h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', canceled));
    h.clock.advance(DAY);

    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 200);
    assert.equal(res.body.trial, false);
    const params = h.stripe.callsTo('checkout.sessions.create').at(-1).args[0];
    assert.equal(params.customer, subscription.customer);
    assert.equal('subscription_data' in params, false);
  });

  test('a revoked license cannot buy again from that device', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    h.db.write("UPDATE licenses SET revoked_at = ?, revoked_reason = 'dispute'", T0);
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'license_revoked');
    assert.match(res.body.error.message, /help@grayout\.test/);
  });

  test('a missed webhook cannot cause a double charge: Stripe is re-read before deciding', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, subscription } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    // The stored row says canceled (a stale event), but Stripe says the subscription is live.
    h.db.write("UPDATE licenses SET status = 'canceled', synced_at = ?", T0 - DAY);
    assert.equal(h.stripe.subs.get(subscription.id).status, 'trialing');
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 409);
  });
});

describe('POST /v1/claim', () => {
  test('app form: pending until paid, then ready at once without waiting for any webhook', async () => {
    const h = harness();
    const device = await h.mint();
    const code = (await h.call('/v1/device-code', device)).body.deviceCode;
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' }, 'no session yet');

    const checkout = await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: code });
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' }, 'session open');

    h.stripe.completeSession(checkout.body.sessionId);
    h.clock.advance(10);
    const ready = await h.call('/v1/claim', { ...device, deviceCode: code });
    assert.equal(ready.body.status, 'ready');
    assert.match(ready.body.license, /^gry_test_[0-9A-HJKMNP-TV-Z]{24}$/);

    const dev = h.db.rows('SELECT * FROM devices WHERE device_id = ?', device.deviceId)[0];
    assert.ok(dev.license_id, 'the app device gets the license');
    assert.ok(dev.trial_used_at);
    assert.equal(h.db.rows('SELECT state FROM checkout_sessions')[0].state, 'paid');
    // Ready is terminal and cheap: no more Stripe reads.
    const reads = h.stripe.callsTo('checkout.sessions.retrieve').length;
    assert.equal((await h.call('/v1/claim', { ...device, deviceCode: code })).body.license, ready.body.license);
    assert.equal(h.stripe.callsTo('checkout.sessions.retrieve').length, reads);
  });

  test('Stripe is asked about one session at most once every 10 seconds', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    h.stripe.sessions.forEach(s => { s.status = 'open'; s.payment_status = 'unpaid'; });
    for (let i = 0; i < 5; i++) await h.call('/v1/claim', { ...device, deviceCode: code });
    assert.equal(h.stripe.callsTo('checkout.sessions.retrieve').length, 1);
    h.clock.advance(10);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    assert.equal(h.stripe.callsTo('checkout.sessions.retrieve').length, 2);
  });

  test('website form: a session id this service created returns the key; the browser device holds nothing', async () => {
    const h = harness();
    const browser = await h.mint();
    const checkout = await h.call('/v1/checkout', { ...browser, plan: 'yearly' });
    h.stripe.completeSession(checkout.body.sessionId);
    const res = await h.call('/v1/claim', { sessionId: checkout.body.sessionId });
    assert.equal(res.body.status, 'ready');
    const dev = h.db.rows('SELECT license_id FROM devices WHERE device_id = ?', browser.deviceId)[0];
    assert.equal(dev.license_id, null, 'a browser device never restores a key');
    assert.deepEqual((await h.call('/v1/restore', browser)).body, { status: 'none' });
  });

  test('an unknown session id is 404 with no call to Stripe; a malformed one is 400', async () => {
    const h = harness();
    const unknown = await h.call('/v1/claim', { sessionId: 'cs_test_a1b2c3d4e5f6g7h8i9j0' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'code_expired');
    assert.match(unknown.body.error.message, /help@grayout\.test/);
    assert.equal((await h.call('/v1/claim', { sessionId: 'cs_bogus' })).status, 400);
    assert.equal((await h.call('/v1/claim', { sessionId: 42 })).status, 400);
    assert.equal((await h.call('/v1/claim', {})).status, 400);
    assert.equal(h.stripe.calls.length, 0);
  });

  test('a code from another device is 404; an expired session ends as failed / expired', async () => {
    const h = harness();
    const device = await h.mint();
    const other = await h.mint();
    const code = (await h.call('/v1/device-code', device)).body.deviceCode;
    assert.equal((await h.call('/v1/claim', { ...other, deviceCode: code })).status, 404);

    const checkout = await h.call('/v1/checkout', { ...device, plan: 'monthly', deviceCode: code });
    h.stripe.expireSession(checkout.body.sessionId);
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'failed', reason: 'expired' });
    h.clock.advance(60);
    assert.deepEqual((await h.call('/v1/claim', { sessionId: checkout.body.sessionId })).body, { status: 'failed', reason: 'expired' });
    assert.equal(h.stripe.callsTo('checkout.sessions.retrieve').length, 1, 'terminal: Stripe is not asked again');
  });

  test('a delayed payment is pending until it clears; a failed one ends as failed / payment_failed', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, session } = await h.appPurchase(device, { plan: 'yearly', paymentStatus: 'unpaid' });
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' });
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0, 'nothing issued for an unpaid session');

    const failed = h.stripe.settleSession(session.id, false);
    await h.deliver(stripeEvent('checkout.session.async_payment_failed', failed));
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'failed', reason: 'payment_failed' });
  });

  test('if Stripe is down the claim says pending, and the next poll succeeds', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    h.stripe.failOn('checkout.sessions.retrieve');
    assert.deepEqual((await h.call('/v1/claim', { ...device, deviceCode: code })).body, { status: 'pending' });
    h.clock.advance(10);
    assert.equal((await h.call('/v1/claim', { ...device, deviceCode: code })).body.status, 'ready');
  });

  test('a revoked license is 403, not ready', async () => {
    const h = harness();
    const device = await h.mint();
    const { code } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    h.db.write("UPDATE licenses SET revoked_at = ?, revoked_reason = 'refund'", T0);
    const res = await h.call('/v1/claim', { ...device, deviceCode: code });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'license_revoked');
  });
});
