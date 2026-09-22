// Everything that touches Stripe: checkout, the billing portal, and the webhook
// that turns a completed payment into a license key.
//
// Workers has no Node `http`, so the SDK is constructed with the fetch HTTP
// client. The API version is pinned to the one this SDK release generates
// against, so a Stripe account default can never quietly change the shapes
// this file reads.

import Stripe from 'stripe';
import { keys } from './store.js';
import { generateLicense, normalizeDeviceCode } from './license.js';

/** The version stripe@20.4.1 pins (node_modules/stripe/esm/apiVersion.js). */
export const STRIPE_API_VERSION = '2026-02-25.clover';

export const TRIAL_DAYS = 7;
export const PLANS = ['monthly', 'yearly'];

/** The events the webhook acts on. Everything else is acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed'
];

export function createStripeClient(secretKey, options = {}) {
  if (options.stripeFactory) return options.stripeFactory(secretKey);
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient()
  });
}

/** Stripe's subscription statuses, folded onto the five the contract names. */
export function normalizeStatus(status) {
  switch (status) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': return 'past_due';
    // `unpaid` means Stripe has finished retrying and given up.
    case 'unpaid':
    case 'canceled':
    case 'paused':
    case 'incomplete':
    case 'incomplete_expired': return 'canceled';
    default: return 'canceled';
  }
}

/** A trial and a dunning grace still get service; a dead subscription does not. */
export function statusGrantsService(status) {
  return status === 'trialing' || status === 'active' || status === 'past_due';
}

function isoFromUnix(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * The end of the current billing period. Recent API versions moved
 * `current_period_end` from the subscription onto its items, so read both.
 */
export function periodEndOf(subscription) {
  const item = subscription && subscription.items && subscription.items.data && subscription.items.data[0];
  return isoFromUnix(subscription && subscription.current_period_end) ||
    isoFromUnix(item && item.current_period_end) ||
    isoFromUnix(subscription && subscription.trial_end) ||
    null;
}

/** monthly | yearly, from the price id if we know it, otherwise the interval. */
export function intervalOf(subscription, env = {}) {
  const item = subscription && subscription.items && subscription.items.data && subscription.items.data[0];
  const price = item && item.price;
  const priceId = price && (typeof price === 'string' ? price : price.id);
  if (priceId && priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId && priceId === env.STRIPE_PRICE_YEARLY) return 'yearly';
  const recurring = price && price.recurring;
  if (recurring && recurring.interval === 'year') return 'yearly';
  if (recurring && recurring.interval === 'month') return 'monthly';
  return null;
}

function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : (value.id || null);
}

/** Build the Checkout Session parameters. Separated so a test can read them. */
export function checkoutParams({ plan, deviceId, deviceCode, env }) {
  const price = plan === 'yearly' ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  if (!price) throw new Error(`no Stripe price configured for the ${plan} plan`);

  const site = String(env.SITE_BASE || '').replace(/\/+$/, '');
  const successPath = env.CHECKOUT_SUCCESS_PATH || '/success.html';
  const cancelPath = env.CHECKOUT_CANCEL_PATH || '/pricing.html';

  const params = {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    // The session id lets the thank-you page confirm the payment. The device
    // code is deliberately not in the URL: the app claims the license over the
    // API instead, so the code never travels through a browser address bar.
    success_url: `${site}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}${cancelPath}`,
    allow_promotion_codes: true,
    metadata: { plan, deviceId: deviceId || '', deviceCode: deviceCode || '' },
    subscription_data: { metadata: { plan, deviceId: deviceId || '', deviceCode: deviceCode || '' } }
  };
  // The 7-day trial is on the monthly plan only.
  if (plan === 'monthly') params.subscription_data.trial_period_days = TRIAL_DAYS;
  if (deviceCode) params.client_reference_id = deviceCode;
  return params;
}

export async function createCheckoutSession(stripe, { plan, deviceId, deviceCode, env }) {
  const session = await stripe.checkout.sessions.create(checkoutParams({ plan, deviceId, deviceCode, env }));
  return session;
}

/**
 * Read back a Checkout Session the browser was just redirected from.
 *
 * `expand` is deliberately empty: the only fields this service reads are the
 * customer id and the payment status, both of which are on the session itself.
 */
export async function retrieveCheckoutSession(stripe, sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId);
}

/** The customer id on a session, whether Stripe expanded it or not. */
export function customerIdOf(session) {
  const c = session && session.customer;
  if (typeof c === 'string' && c) return c;
  if (c && typeof c === 'object' && typeof c.id === 'string' && c.id) return c.id;
  return null;
}

/**
 * True once the money is committed. A trial checkout completes with
 * `payment_status: 'no_payment_required'`, which is why the status alone is
 * not enough.
 */
export function sessionIsComplete(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.status === 'expired') return false;
  return session.payment_status === 'paid'
    || session.payment_status === 'no_payment_required'
    || session.status === 'complete';
}

export async function createPortalSession(stripe, { customerId, env }) {
  const site = String(env.SITE_BASE || '').replace(/\/+$/, '');
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${site}${env.PORTAL_RETURN_PATH || '/'}`
  });
  return session;
}

/** Workers has no synchronous crypto, so signature checking is the async one. */
export async function verifyWebhook(stripe, { payload, signature, secret }) {
  return stripe.webhooks.constructEventAsync(payload, signature, secret);
}

/**
 * Issue a license for a customer, or return the one they already have.
 *
 * Stripe retries webhooks, and `checkout.session.completed` can be delivered
 * more than once, so this is idempotent on the customer id: a second delivery
 * finds the existing key rather than minting a stranger a second subscription's
 * worth of licenses.
 */
export async function issueLicense(store, { customerId, subscriptionId, plan, status, periodEnd, deviceId, deviceCode, now = Date.now() }) {
  let license = customerId ? await store.get(keys.customer(customerId)) : null;
  let reused = !!license;

  if (!license) {
    // 120 bits of entropy makes a collision impossible in practice; the loop is
    // here so that "impossible" is not load-bearing.
    for (let i = 0; i < 5; i++) {
      const candidate = generateLicense();
      if (!(await store.get(keys.license(candidate)))) { license = candidate; break; }
    }
    if (!license) throw new Error('could not allocate a license key');
  }

  const existing = (await store.get(keys.license(license))) || {};
  // A subscription event may have arrived before checkout completed.
  const pending = customerId ? await store.get(keys.pendingCustomer(customerId)) : null;

  const record = {
    customerId: customerId || existing.customerId || null,
    subscriptionId: subscriptionId || (pending && pending.subscriptionId) || existing.subscriptionId || null,
    plan: plan || (pending && pending.plan) || existing.plan || null,
    status: (pending && pending.status) || status || existing.status || 'active',
    periodEnd: (pending && pending.periodEnd) || periodEnd || existing.periodEnd || null,
    createdAt: existing.createdAt || new Date(now).toISOString(),
    revokedAt: existing.revokedAt || null
  };

  await store.put(keys.license(license), record);
  if (customerId) {
    await store.put(keys.customer(customerId), license);
    if (pending) await store.delete(keys.pendingCustomer(customerId));
  }

  if (deviceCode) {
    const codeRecord = await store.get(keys.code(deviceCode));
    if (codeRecord) {
      await store.put(keys.code(deviceCode), { ...codeRecord, license }, { expirationTtl: 900 });
      if (codeRecord.deviceId) {
        const dev = (await store.get(keys.device(codeRecord.deviceId))) || {};
        await store.put(keys.device(codeRecord.deviceId), { ...dev, license, lastSeen: new Date(now).toISOString() });
      }
    }
  }
  if (deviceId) {
    const dev = (await store.get(keys.device(deviceId))) || {};
    await store.put(keys.device(deviceId), { ...dev, license, lastSeen: new Date(now).toISOString() });
  }

  return { license, record, reused };
}

/** Write a status change onto the license that belongs to this customer. */
async function applyStatus(store, customerId, patch, now) {
  const license = customerId ? await store.get(keys.customer(customerId)) : null;
  if (!license) {
    // The subscription event beat `checkout.session.completed` here. Park the
    // status so that issuing the license picks it up.
    if (customerId) await store.put(keys.pendingCustomer(customerId), { ...patch, parkedAt: new Date(now).toISOString() }, { expirationTtl: 24 * 3600 });
    return { handled: true, action: 'parked', license: null };
  }
  const existing = (await store.get(keys.license(license))) || {};
  const record = { ...existing, ...patch };
  await store.put(keys.license(license), record);
  return { handled: true, action: 'status_updated', license, record };
}

/**
 * Route one verified Stripe event. Returns what it did, so the webhook handler
 * can log an action name without logging a license key.
 *
 * Unknown events are acknowledged and ignored — Stripe retries anything that is
 * not a 2xx, and an account sends far more event types than this service cares
 * about.
 */
export async function handleStripeEvent(event, { store, env = {}, now = Date.now() } = {}) {
  const type = event && event.type;
  const object = event && event.data && event.data.object;
  if (!type || !object) return { handled: false, action: 'ignored' };

  switch (type) {
    case 'checkout.session.completed': {
      if (object.mode && object.mode !== 'subscription') return { handled: false, action: 'ignored' };
      const customerId = idOf(object.customer);
      const metadata = object.metadata || {};
      // `no_payment_required` is what a session on a trial reports. The
      // subscription events that follow correct this authoritatively.
      const status = object.payment_status === 'no_payment_required' ? 'trialing' : 'active';
      const issued = await issueLicense(store, {
        customerId,
        subscriptionId: idOf(object.subscription),
        plan: PLANS.includes(metadata.plan) ? metadata.plan : null,
        status,
        periodEnd: null,
        deviceId: metadata.deviceId || null,
        // Stripe echoes back whatever was sent. Normalize before it is used as
        // a key, so a code that made the round trip in another form still lands.
        deviceCode: normalizeDeviceCode(object.client_reference_id || metadata.deviceCode || '') || null,
        now
      });
      return { handled: true, action: issued.reused ? 'license_reused' : 'license_issued', license: issued.license, record: issued.record };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      return applyStatus(store, idOf(object.customer), {
        subscriptionId: object.id || null,
        status: normalizeStatus(object.status),
        plan: intervalOf(object, env),
        periodEnd: periodEndOf(object)
      }, now);
    }

    case 'customer.subscription.deleted': {
      return applyStatus(store, idOf(object.customer), {
        subscriptionId: object.id || null,
        status: 'canceled',
        periodEnd: periodEndOf(object)
      }, now);
    }

    case 'invoice.payment_failed': {
      return applyStatus(store, idOf(object.customer), { status: 'past_due' }, now);
    }

    default:
      return { handled: false, action: 'ignored' };
  }
}
