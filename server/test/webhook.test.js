// POST /v1/stripe/webhook (contract 6.12, 7.1, 7.3–7.5).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

import { harness, stripeEvent, T0, DAY } from './helpers.js';

/** An app purchase that has completed at Stripe, delivered by webhook (not claimed). */
async function purchased(h, options) {
  const device = await h.mint();
  const purchase = await h.appPurchase(device, options);
  const res = await h.deliver(stripeEvent('checkout.session.completed', purchase.session));
  return { device, ...purchase, res };
}

const license = h => h.db.rows('SELECT * FROM licenses')[0];

describe('fail closed and verify first', () => {
  for (const [name, patch] of [
    ['no webhook secret', { STRIPE_WEBHOOK_SECRET: '' }],
    ['the old public placeholder', { STRIPE_WEBHOOK_SECRET: 'whsec_placeholder' }],
    ['a long placeholder', { STRIPE_WEBHOOK_SECRET: 'whsec_replace_with_the_real_secret_0123456789' }],
    ['no Stripe key', { STRIPE_SECRET_KEY: '' }]
  ]) {
    test(`${name}: 503 not_configured and nothing processed, even with a valid signature`, async () => {
      const h = harness({ env: patch });
      const event = stripeEvent('checkout.session.completed', { id: 'cs_test_x', payment_status: 'paid', customer: 'cus_1' });
      const secret = patch.STRIPE_WEBHOOK_SECRET || 'whsec_anything';
      const res = await h.deliver(event, { secret });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'not_configured');
      assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM processed_events')[0].n, 0);
    });
  }

  test('a missing, wrong or stale signature is 400 invalid_signature', async () => {
    const h = harness();
    const payload = JSON.stringify(stripeEvent('invoice.paid', { customer: 'cus_1' }));
    const noSig = await h.call('/v1/stripe/webhook', null, { raw: payload });
    assert.equal(noSig.body.error.code, 'invalid_signature');
    const wrong = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_someone_else_0123456789abcdefghijklmno' });
    assert.equal((await h.call('/v1/stripe/webhook', null, { raw: payload, headers: { 'Stripe-Signature': wrong } })).status, 400);
    const old = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: h.env.STRIPE_WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 600 });
    assert.equal((await h.call('/v1/stripe/webhook', null, { raw: payload, headers: { 'Stripe-Signature': old } })).status, 400);
    const tampered = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: h.env.STRIPE_WEBHOOK_SECRET });
    assert.equal((await h.call('/v1/stripe/webhook', null, { raw: payload.replace('cus_1', 'cus_2'), headers: { 'Stripe-Signature': tampered } })).status, 400);
  });

  test('anything but JSON is refused', async () => {
    const h = harness();
    const res = await h.call('/v1/stripe/webhook', null, { raw: 'x', headers: { 'Content-Type': 'text/plain', 'Stripe-Signature': 't=1,v1=x' } });
    assert.equal(res.status, 400);
  });
});

describe('de-duplication and retries', () => {
  test('the same event id twice: the second is "duplicate" and does nothing', async () => {
    const h = harness();
    const { session } = await purchased(h);
    const event = stripeEvent('invoice.paid', { customer: session.customer });
    assert.equal((await h.deliver(event)).body.action, 'synced');
    const lists = h.stripe.callsTo('subscriptions.list').length;
    assert.deepEqual((await h.deliver(event)).body, { received: true, action: 'duplicate' });
    assert.equal(h.stripe.callsTo('subscriptions.list').length, lists);
  });

  test('if handling throws, the answer is 500, the id is not recorded, and the retry works', async () => {
    const h = harness();
    const device = await h.mint();
    const { session } = await h.appPurchase(device);
    const event = stripeEvent('checkout.session.completed', session);
    h.stripe.failOn('subscriptions.list');
    const first = await h.deliver(event);
    assert.equal(first.status, 500);
    assert.equal(first.body.error.code, 'internal_error');
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM processed_events')[0].n, 0);
    assert.equal(h.db.rows("SELECT state FROM checkout_sessions")[0].state, 'open', 'not marked paid before the sync succeeded');
    const retry = await h.deliver(event);
    assert.equal(retry.body.action, 'license_issued');
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 1);
  });
});

describe('checkout events', () => {
  test('completed + paid: the license is issued, synced from Stripe, and attached to the app device', async () => {
    const h = harness();
    const { device, subscription, res } = await purchased(h);
    assert.deepEqual(res.body, { received: true, action: 'license_issued' });
    const row = license(h);
    assert.equal(row.customer_id, subscription.customer);
    assert.equal(row.subscription_id, subscription.id);
    assert.equal(row.status, 'trialing');
    assert.equal(row.billing_interval, 'monthly');
    assert.equal(row.period_end, T0 + 7 * DAY);
    assert.equal(row.trial_end, T0 + 7 * DAY);
    assert.equal(row.synced_at, T0);
    assert.equal(row.livemode, 0);
    assert.equal(h.db.rows('SELECT license_id FROM devices WHERE device_id = ?', device.deviceId)[0].license_id, row.id);
    const restore = await h.call('/v1/restore', device);
    assert.match(restore.body.license, /^gry_test_/);
  });

  test('a session this service did not create is ignored', async () => {
    const h = harness();
    const res = await h.deliver(stripeEvent('checkout.session.completed', { id: 'cs_test_notours0000', payment_status: 'paid', customer: 'cus_x', livemode: false }));
    assert.equal(res.body.action, 'ignored');
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0);
  });

  test('completed but unpaid waits; async_payment_succeeded issues; async_payment_failed marks failed', async () => {
    const h = harness();
    const { session, res } = await purchased(h, { plan: 'yearly', paymentStatus: 'unpaid' });
    assert.equal(res.body.action, 'awaiting_payment');
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0);
    const paid = h.stripe.settleSession(session.id, true);
    assert.equal((await h.deliver(stripeEvent('checkout.session.async_payment_succeeded', paid))).body.action, 'license_issued');
    assert.equal(license(h).status, 'active');

    const h2 = harness();
    const second = await purchased(h2, { paymentStatus: 'unpaid' });
    const failed = h2.stripe.settleSession(second.session.id, false);
    assert.equal((await h2.deliver(stripeEvent('checkout.session.async_payment_failed', failed))).body.action, 'failed');
    assert.equal(h2.db.rows('SELECT state FROM checkout_sessions')[0].state, 'failed');
  });
});

describe('subscription and invoice events read Stripe live', () => {
  test('with no license yet they are ignored (issuing the license syncs anyway)', async () => {
    const h = harness();
    for (const type of ['customer.subscription.created', 'invoice.paid', 'invoice.payment_failed']) {
      assert.equal((await h.deliver(stripeEvent(type, { id: 'x', customer: 'cus_nobody' }))).body.action, 'ignored', type);
    }
    assert.equal(h.stripe.calls.length, 0);
  });

  test('each type writes whatever Stripe says now, never the payload', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    for (const [type, live] of [
      ['customer.subscription.updated', { status: 'active', periodEnd: T0 + 37 * DAY }],
      ['invoice.paid', { status: 'active' }],
      ['customer.subscription.paused', { status: 'paused' }],
      ['customer.subscription.resumed', { status: 'active' }],
      ['invoice.payment_failed', { status: 'past_due' }],
      ['customer.subscription.deleted', { status: 'canceled' }]
    ]) {
      h.stripe.updateSubscription(subscription.id, live);
      // The payload claims something else entirely; it must be ignored.
      const res = await h.deliver(stripeEvent(type, { id: subscription.id, customer: subscription.customer, status: 'active' }));
      assert.equal(res.body.action, 'synced', type);
      assert.equal(license(h).status, live.status, type);
    }
  });

  test('a customer with an old canceled and a new active subscription: the license follows the live one', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    const newer = h.stripe.addSubscription({ customer: subscription.customer, interval: 'year', status: 'active', created: T0 + 10 });
    await h.deliver(stripeEvent('customer.subscription.updated', { id: subscription.id, customer: subscription.customer }));
    assert.equal(license(h).subscription_id, newer.id);
    assert.equal(license(h).billing_interval, 'yearly');
  });

  test('subscriptions to other products are not ours and are ignored', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    h.stripe.addSubscription({ customer: subscription.customer, status: 'active', created: T0 + 10, price: 'price_some_other_product', product: 'prod_some_other_product' });
    await h.deliver(stripeEvent('invoice.paid', { customer: subscription.customer }));
    assert.equal(license(h).subscription_id, subscription.id);
  });
});

describe('refunds and disputes', () => {
  test('a full refund cancels the subscription at Stripe and revokes the license', async () => {
    const h = harness();
    const { device, subscription } = await purchased(h);
    const { paymentIntent, charge } = h.stripe.addPaidInvoice(subscription.id, { extraInvoices: 3 });
    const res = await h.deliver(stripeEvent('charge.refunded', { id: charge, payment_intent: paymentIntent, refunded: true, customer: subscription.customer }));
    assert.equal(res.body.action, 'revoked');
    assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled');
    assert.equal(h.stripe.callsTo('subscriptions.cancel').length, 1);
    const row = license(h);
    assert.equal(row.revoked_reason, 'refund');
    assert.equal(row.status, 'canceled');
    assert.ok(h.stripe.callsTo('invoicePayments.list').length >= 2, 'followed has_more across pages');
    const restore = await h.call('/v1/restore', device);
    assert.equal(restore.body.error.code, 'license_revoked');
  });

  test('a partial refund leaves access alone', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    const { paymentIntent, charge } = h.stripe.addPaidInvoice(subscription.id);
    const res = await h.deliver(stripeEvent('charge.refunded', { id: charge, payment_intent: paymentIntent, refunded: false }));
    assert.equal(res.body.action, 'partial_refund');
    assert.equal(license(h).revoked_at, null);
    assert.equal(h.stripe.callsTo('subscriptions.cancel').length, 0);
  });

  test('a dispute with no payment_intent on it is resolved through its charge', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    const { charge } = h.stripe.addPaidInvoice(subscription.id);
    const res = await h.deliver(stripeEvent('charge.dispute.created', { id: 'dp_1', charge, payment_intent: null }));
    assert.equal(res.body.action, 'revoked');
    assert.equal(license(h).revoked_reason, 'dispute');
    assert.equal(h.stripe.callsTo('charges.retrieve').length, 1);
  });

  test('an already-canceled subscription is not canceled twice', async () => {
    const h = harness();
    const { subscription } = await purchased(h);
    const { paymentIntent } = h.stripe.addPaidInvoice(subscription.id);
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('charge.dispute.created', { id: 'dp_2', charge: 'ch_x', payment_intent: paymentIntent }));
    assert.equal(h.stripe.callsTo('subscriptions.cancel').length, 0);
    assert.equal(license(h).revoked_reason, 'dispute');
  });

  test('a refund that cannot be traced to a subscription is logged and ignored', async () => {
    const h = harness();
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try {
      const none = await h.deliver(stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: null, refunded: true }));
      const unknown = await h.deliver(stripeEvent('charge.refunded', { id: 'ch_2', payment_intent: 'pi_unknown', refunded: true }));
      assert.equal(none.body.action, 'ignored');
      assert.equal(unknown.body.action, 'ignored');
    } finally {
      console.log = original;
    }
    assert.equal(logs.filter(l => l.includes('refund_unresolved')).length, 2);
  });

  test('anything else is acknowledged and ignored', async () => {
    const h = harness();
    assert.deepEqual((await h.deliver(stripeEvent('customer.created', { id: 'cus_1' }))).body, { received: true, action: 'ignored' });
  });
});
