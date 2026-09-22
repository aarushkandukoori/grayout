import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { keys, memoryStore } from '../src/store.js';
import { isLicenseShape } from '../src/license.js';
import {
  HANDLED_EVENTS, PLANS, STRIPE_API_VERSION, TRIAL_DAYS, checkoutParams,
  createCheckoutSession, createPortalSession, handleStripeEvent, intervalOf,
  issueLicense, normalizeStatus, periodEndOf, statusGrantsService, verifyWebhook
} from '../src/stripe.js';
import { BASE_ENV, T0, stubStripe } from './helpers.js';

const env = BASE_ENV;

describe('the pinned API version', () => {
  test('matches the version the installed SDK generates against', async () => {
    // Read the SDK's generated file rather than importing it: the subpath is
    // not exported, and this has to break loudly when the dependency moves.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../node_modules/stripe/esm/apiVersion.js', import.meta.url));
    const pinned = /ApiVersion = '([^']+)'/.exec(readFileSync(path, 'utf8'));
    assert.ok(pinned, 'the SDK should declare an ApiVersion');
    assert.equal(STRIPE_API_VERSION, pinned[1]);
  });
});

describe('checkoutParams', () => {
  test('monthly is a subscription with a 7-day trial', () => {
    const p = checkoutParams({ plan: 'monthly', deviceId: 'dev', deviceCode: 'ABCDEFGH', env });
    assert.equal(p.mode, 'subscription');
    assert.deepEqual(p.line_items, [{ price: 'price_monthly_999', quantity: 1 }]);
    assert.equal(p.subscription_data.trial_period_days, TRIAL_DAYS);
    assert.equal(TRIAL_DAYS, 7);
  });

  test('yearly carries no trial', () => {
    const p = checkoutParams({ plan: 'yearly', deviceId: 'dev', deviceCode: 'ABCDEFGH', env });
    assert.deepEqual(p.line_items, [{ price: 'price_yearly_79', quantity: 1 }]);
    assert.equal('trial_period_days' in p.subscription_data, false);
  });

  test('client_reference_id is the device code, which is how the app claims the key', () => {
    assert.equal(checkoutParams({ plan: 'monthly', deviceId: 'dev', deviceCode: 'ABCDEFGH', env }).client_reference_id, 'ABCDEFGH');
    assert.equal('client_reference_id' in checkoutParams({ plan: 'monthly', deviceId: 'dev', env }), false);
  });

  test('the device id and plan ride along in metadata, on the session and the subscription', () => {
    const p = checkoutParams({ plan: 'yearly', deviceId: 'dev-1', deviceCode: 'ABCDEFGH', env });
    assert.deepEqual(p.metadata, { plan: 'yearly', deviceId: 'dev-1', deviceCode: 'ABCDEFGH' });
    assert.deepEqual(p.subscription_data.metadata, { plan: 'yearly', deviceId: 'dev-1', deviceCode: 'ABCDEFGH' });
  });

  test('success and cancel point at the site, and the device code is not in either URL', () => {
    const p = checkoutParams({ plan: 'monthly', deviceId: 'dev', deviceCode: 'ABCDEFGH', env });
    assert.equal(p.success_url, 'https://grayout.app/success.html?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(p.cancel_url, 'https://grayout.app/pricing.html');
    assert.equal(p.success_url.includes('ABCDEFGH'), false, 'a claim code must not travel in an address bar');
  });

  test('a trailing slash on SITE_BASE does not become a double slash', () => {
    const p = checkoutParams({ plan: 'monthly', deviceId: 'dev', env: { ...env, SITE_BASE: 'https://grayout.app/' } });
    assert.equal(p.success_url, 'https://grayout.app/success.html?session_id={CHECKOUT_SESSION_ID}');
  });

  test('a missing price is an error, not a checkout for nothing', () => {
    assert.throws(() => checkoutParams({ plan: 'yearly', deviceId: 'd', env: { ...env, STRIPE_PRICE_YEARLY: '' } }), /no Stripe price/);
  });

  test('both plans are named', () => assert.deepEqual(PLANS, ['monthly', 'yearly']));
});

describe('sessions', () => {
  test('createCheckoutSession hands the params to Stripe and returns the session', async () => {
    const stripe = stubStripe();
    const session = await createCheckoutSession(stripe, { plan: 'monthly', deviceId: 'dev', deviceCode: 'ABCDEFGH', env });
    assert.equal(stripe.calls.checkout.length, 1);
    assert.equal(stripe.calls.checkout[0].mode, 'subscription');
    assert.match(session.url, /^https:\/\/checkout\.stripe\.com\//);
  });

  test('createPortalSession asks for the customer and a return to the site', async () => {
    const stripe = stubStripe();
    await createPortalSession(stripe, { customerId: 'cus_1', env });
    assert.deepEqual(stripe.calls.portal[0], { customer: 'cus_1', return_url: 'https://grayout.app/' });
  });

  test('verifyWebhook goes through constructEventAsync', async () => {
    const stripe = stubStripe({ event: { type: 'ping' } });
    const event = await verifyWebhook(stripe, { payload: '{}', signature: 't=1,v1=abc', secret: 'whsec_test' });
    assert.deepEqual(event, { type: 'ping' });
    assert.equal(stripe.calls.webhook[0].secret, 'whsec_test');
  });
});

describe('subscription status', () => {
  test('folds onto the five values the contract names', () => {
    assert.equal(normalizeStatus('trialing'), 'trialing');
    assert.equal(normalizeStatus('active'), 'active');
    assert.equal(normalizeStatus('past_due'), 'past_due');
    for (const dead of ['canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'something_new']) {
      assert.equal(normalizeStatus(dead), 'canceled', dead);
    }
  });

  test('a trial and a dunning grace still get service; a dead subscription does not', () => {
    assert.equal(statusGrantsService('trialing'), true);
    assert.equal(statusGrantsService('active'), true);
    assert.equal(statusGrantsService('past_due'), true);
    assert.equal(statusGrantsService('canceled'), false);
  });
});

describe('reading a subscription object', () => {
  test('period end comes from the item when the top level does not carry it', () => {
    const at = Math.floor(Date.parse('2026-10-22T00:00:00Z') / 1000);
    assert.equal(periodEndOf({ current_period_end: at }), '2026-10-22T00:00:00.000Z');
    assert.equal(periodEndOf({ items: { data: [{ current_period_end: at }] } }), '2026-10-22T00:00:00.000Z');
    assert.equal(periodEndOf({ trial_end: at }), '2026-10-22T00:00:00.000Z');
    assert.equal(periodEndOf({}), null);
  });

  test('the interval comes from the price id first, then the recurring interval', () => {
    assert.equal(intervalOf({ items: { data: [{ price: { id: 'price_yearly_79' } }] } }, env), 'yearly');
    assert.equal(intervalOf({ items: { data: [{ price: { id: 'price_monthly_999' } }] } }, env), 'monthly');
    assert.equal(intervalOf({ items: { data: [{ price: { id: 'price_other', recurring: { interval: 'year' } } }] } }, env), 'yearly');
    assert.equal(intervalOf({ items: { data: [{ price: { id: 'price_other', recurring: { interval: 'month' } } }] } }, env), 'monthly');
    assert.equal(intervalOf({}, env), null);
  });
});

// ------------------------------------------------------------------ events

const session = (patch = {}) => ({
  id: 'cs_1',
  object: 'checkout.session',
  mode: 'subscription',
  customer: 'cus_1',
  subscription: 'sub_1',
  client_reference_id: 'ABCDEFGH',
  payment_status: 'paid',
  metadata: { plan: 'monthly', deviceId: 'device-aaaa-bbbb', deviceCode: 'ABCDEFGH' },
  ...patch
});

const subscription = (patch = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_1',
  status: 'active',
  items: { data: [{ price: { id: 'price_monthly_999' }, current_period_end: Math.floor(Date.parse('2026-10-22T00:00:00Z') / 1000) }] },
  ...patch
});

const evt = (type, object) => ({ id: 'evt_1', type, data: { object } });

async function withCode(store) {
  await store.put(keys.code('ABCDEFGH'), { deviceId: 'device-aaaa-bbbb', createdAt: new Date(T0).toISOString() }, { expirationTtl: 900 });
}

describe('handleStripeEvent', () => {
  test('the handled list is the one the contract names', () => {
    assert.deepEqual(HANDLED_EVENTS, [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_failed'
    ]);
  });

  test('checkout.session.completed issues a license and attaches it to the code and the device', async () => {
    const store = memoryStore();
    await withCode(store);
    const out = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 });

    assert.equal(out.action, 'license_issued');
    assert.ok(isLicenseShape(out.license));
    assert.deepEqual(await store.get(keys.license(out.license)), {
      customerId: 'cus_1', subscriptionId: 'sub_1', plan: 'monthly', status: 'active',
      periodEnd: null, createdAt: new Date(T0).toISOString(), revokedAt: null
    });
    assert.equal(await store.get(keys.customer('cus_1')), out.license);
    assert.equal((await store.get(keys.code('ABCDEFGH'))).license, out.license);
    assert.equal((await store.get(keys.device('device-aaaa-bbbb'))).license, out.license);
  });

  test('a session on a trial starts the license as trialing', async () => {
    const store = memoryStore();
    await withCode(store);
    const out = await handleStripeEvent(evt('checkout.session.completed', session({ payment_status: 'no_payment_required' })), { store, env, now: T0 });
    assert.equal((await store.get(keys.license(out.license))).status, 'trialing');
  });

  test('a second delivery of the same event reuses the license instead of minting another', async () => {
    const store = memoryStore();
    await withCode(store);
    const first = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 });
    const second = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 + 1000 });
    assert.equal(second.action, 'license_reused');
    assert.equal(second.license, first.license);
    assert.equal((await store.get(keys.license(first.license))).createdAt, new Date(T0).toISOString());
  });

  test('a one-off payment session is ignored', async () => {
    const store = memoryStore();
    const out = await handleStripeEvent(evt('checkout.session.completed', session({ mode: 'payment' })), { store, env, now: T0 });
    assert.equal(out.handled, false);
    assert.equal(out.action, 'ignored');
  });

  test('checkout without a device code still issues a license', async () => {
    const store = memoryStore();
    const out = await handleStripeEvent(evt('checkout.session.completed', session({ client_reference_id: null, metadata: { plan: 'yearly' } })), { store, env, now: T0 });
    assert.ok(isLicenseShape(out.license));
    assert.equal((await store.get(keys.license(out.license))).plan, 'yearly');
  });

  for (const type of ['customer.subscription.created', 'customer.subscription.updated']) {
    test(`${type} writes status, plan and period end onto the license`, async () => {
      const store = memoryStore();
      await withCode(store);
      const { license } = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 });

      const out = await handleStripeEvent(evt(type, subscription({ status: 'trialing' })), { store, env, now: T0 });
      assert.equal(out.action, 'status_updated');
      const record = await store.get(keys.license(license));
      assert.equal(record.status, 'trialing');
      assert.equal(record.plan, 'monthly');
      assert.equal(record.periodEnd, '2026-10-22T00:00:00.000Z');
      assert.equal(record.subscriptionId, 'sub_1');
    });
  }

  test('customer.subscription.deleted cancels the license', async () => {
    const store = memoryStore();
    await withCode(store);
    const { license } = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 });
    await handleStripeEvent(evt('customer.subscription.deleted', subscription({ status: 'canceled' })), { store, env, now: T0 });
    assert.equal((await store.get(keys.license(license))).status, 'canceled');
  });

  test('invoice.payment_failed moves the license to past_due and leaves the rest alone', async () => {
    const store = memoryStore();
    await withCode(store);
    const { license } = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 });
    await handleStripeEvent(evt('invoice.payment_failed', { id: 'in_1', customer: 'cus_1' }), { store, env, now: T0 });
    const record = await store.get(keys.license(license));
    assert.equal(record.status, 'past_due');
    assert.equal(record.plan, 'monthly');
    assert.equal(statusGrantsService(record.status), true, 'dunning is a grace, not a cut-off');
  });

  test('an unknown event type is acknowledged and changes nothing', async () => {
    const store = memoryStore();
    const out = await handleStripeEvent(evt('customer.updated', { id: 'cus_1' }), { store, env, now: T0 });
    assert.equal(out.handled, false);
    assert.equal(out.action, 'ignored');
    assert.equal(store._keys().length, 0);
  });

  test('an event with no object at all does not throw', async () => {
    assert.deepEqual(await handleStripeEvent({ type: 'x' }, { store: memoryStore(), env, now: T0 }), { handled: false, action: 'ignored' });
    assert.deepEqual(await handleStripeEvent(null, { store: memoryStore(), env, now: T0 }), { handled: false, action: 'ignored' });
  });

  test('a subscription event that arrives before checkout is parked, then merged', async () => {
    const store = memoryStore();
    await withCode(store);

    const early = await handleStripeEvent(evt('customer.subscription.created', subscription({ status: 'trialing' })), { store, env, now: T0 });
    assert.equal(early.action, 'parked');
    assert.equal(early.license, null);

    const out = await handleStripeEvent(evt('checkout.session.completed', session()), { store, env, now: T0 + 500 });
    const record = await store.get(keys.license(out.license));
    assert.equal(record.status, 'trialing', 'the parked status wins over the guess from the session');
    assert.equal(record.periodEnd, '2026-10-22T00:00:00.000Z');
    assert.equal(await store.get(keys.pendingCustomer('cus_1')), null, 'the parked record is cleared');
  });
});

describe('issueLicense', () => {
  test('never hands out a key that is already in the store', async () => {
    const store = memoryStore();
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const { license } = await issueLicense(store, { customerId: `cus_${i}`, now: T0 });
      assert.equal(seen.has(license), false);
      seen.add(license);
    }
  });

  test('maps the customer to the license both ways', async () => {
    const store = memoryStore();
    const { license } = await issueLicense(store, { customerId: 'cus_9', subscriptionId: 'sub_9', plan: 'yearly', status: 'active', now: T0 });
    assert.equal(await store.get(keys.customer('cus_9')), license);
    assert.equal((await store.get(keys.license(license))).customerId, 'cus_9');
  });
});
