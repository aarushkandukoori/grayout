// Everything that talks to Stripe: the client, the Checkout Session, the
// billing portal, reading a customer's subscription, issuing a license for a
// paid session, and cancelling a refunded or disputed subscription.
//
// Two rules hold everywhere in this file:
// 1. A license's status is only ever written from a LIVE read of Stripe
//    (syncCustomer). Event payloads are never trusted for status, because
//    Stripe does not deliver events in order and retries old ones for days.
// 2. Every function is safe to run twice, or twice at the same time.
//
// Field paths are for API version 2026-08-26.dahlia (contract section 17).

import Stripe from 'stripe';
import {
  INTEGRATION_IDENTIFIER, STRIPE_API_VERSION, TRIAL_DAYS, DEVICE_CODE_TTL_SECONDS,
  longSecretOk, modeAllowed, priceFor, productId, siteUrl, stripeKeyOk
} from './config.js';
import { describeError, fail, logLine } from './http.js';
import { keyedHash, licenseKeyFor, maskSessionId, sha256Hex } from './ids.js';
import {
  attachLicense, getCheckoutSession, getDevice, getLicenseByCustomer, getLicenseById, issueLicense, markBought,
  markSessionPaid, markTrialUsed, recordTrialMarks, revokeBySubscription, setTrialDenied, touchSynced,
  writeSubscriptionState
} from './db.js';

/** Subscription statuses that may still grant service (contract 7.2 decides). */
export const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due']);
/**
 * Statuses where the subscription is still open at Stripe: it may charge the
 * buyer again (Smart Retries on a past_due invoice, a paused one resuming, a
 * delayed first payment clearing). Buying again while one of these exists
 * would make a second subscription, so checkout sends the buyer to the
 * billing portal instead. Only canceled and incomplete_expired are over.
 */
export const OPEN_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete']);
/** Session payment states that mean the money is there (or not needed, for a trial). */
export const PAID_SESSION_STATES = new Set(['paid', 'no_payment_required']);

// ---------------------------------------------------------------- the client

// One client per Worker isolate, made the first time it is needed.
let cached = { key: null, client: null };

/** The Stripe client for this environment, or 503 not_configured. */
export function stripeClientFor(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!stripeKeyOk(key)) fail('not_configured');
  if (cached.key !== key) {
    if (key.startsWith('sk_')) {
      // A full secret key works, but a leak of it opens the whole account.
      logLine('stripe_key_warning', { message: 'use a restricted key' });
    }
    cached = {
      key,
      client: new Stripe(key, {
        apiVersion: STRIPE_API_VERSION,
        // Workers have fetch, not Node's http module.
        httpClient: Stripe.createFetchHttpClient()
      })
    };
  }
  return cached.client;
}

/**
 * Check a webhook's signature on the raw body and return the event. Workers
 * have no synchronous crypto, hence the async form and SubtleCrypto.
 * Throws if the signature is wrong or more than 5 minutes old.
 */
export async function verifyWebhookEvent(rawBody, signatureHeader, secret) {
  return Stripe.webhooks.constructEventAsync(
    rawBody, signatureHeader, secret, undefined, Stripe.createSubtleCryptoProvider()
  );
}

/** "cus_123" whether Stripe sent the id or the whole object. */
export function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return typeof value.id === 'string' ? value.id : null;
}

// ---------------------------------------------------------------- checkout and portal

/**
 * The Checkout Session parameters, exactly as contract section 9 lists them.
 *
 * Managed Payments makes Stripe the merchant of record: it works out, collects
 * and pays sales tax and VAT, so there are no tax parameters here at all, and
 * nothing it forbids (automatic_tax, payment_method_types, custom_text, …).
 */
export function checkoutParams({ env, plan, deviceId, deviceCode, customerId, trial, now }) {
  const site = siteUrl(env);
  return {
    mode: 'subscription',
    line_items: [{ price: priceFor(env, plan), quantity: 1 }],
    managed_payments: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
    // Shows in the Dashboard. Never used to map a payment back to a device:
    // our own checkout_sessions row does that.
    client_reference_id: deviceId,
    ...(customerId ? { customer: customerId } : {}),
    ...(trial ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {}),
    // A checkout the app started (it has a device code) comes back with
    // from=app, so the page says "go back to Grayout" instead of offering the
    // download the buyer already has. The website's own checkouts are unchanged.
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}${deviceCode ? '&from=app' : ''}`,
    cancel_url: `${site}/pricing.html?canceled=1${deviceCode ? '&from=app' : ''}`,
    // The same life as a device code.
    expires_at: now + DEVICE_CODE_TTL_SECONDS
  };
}

/**
 * Where the billing portal's "Return" link goes. From the app: the account
 * page with from=app, which pushes no download (the buyer already has
 * Grayout). From the website: the home page, as before.
 */
export function portalReturnUrl(site, fromApp) {
  return fromApp ? `${site}/account.html?from=app` : `${site}/`;
}

/**
 * A billing portal link for a customer. Throws on any Stripe error.
 * `fromApp` only picks the return page (portalReturnUrl), never access.
 */
export async function createPortalUrl(deps, customerId, { fromApp = false } = {}) {
  const site = siteUrl(deps.env);
  if (!site) fail('not_configured');
  const session = await deps.stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: portalReturnUrl(site, fromApp)
  });
  if (!session || !session.url) throw new Error('billing portal returned no url');
  return session.url;
}

/** The same, but null instead of an error (for answers where the link is optional). */
export async function portalUrlOrNull(deps, customerId, options) {
  try {
    return await createPortalUrl(deps, customerId, options);
  } catch (err) {
    logLine('portal_failed', { customer: customerId, error: describeError(err) });
    return null;
  }
}

// ---------------------------------------------------------------- reading a customer

function firstItem(sub) {
  return (sub && sub.items && sub.items.data && sub.items.data[0]) || null;
}

/**
 * True for a Grayout Pro subscription. Matched on the product, because a
 * price change makes new price ids while existing subscribers keep their old
 * ones. Today's two prices also count, so nothing breaks before STRIPE_PRODUCT
 * is filled in.
 */
export function isOurSubscription(env, sub) {
  const item = firstItem(sub);
  const price = item && item.price;
  if (!price) return false;
  const product = productId(env);
  if (product && idOf(price.product) === product) return true;
  const todaysPrices = [priceFor(env, 'monthly'), priceFor(env, 'yearly')].filter(Boolean);
  return todaysPrices.includes(idOf(price));
}

/** month → monthly, year → yearly, anything else → null. */
function intervalOf(sub) {
  const item = firstItem(sub);
  const interval = item && item.price && item.price.recurring && item.price.recurring.interval;
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'yearly';
  return null;
}

/** The newest subscription in a list (Stripe's `created`, then id as a tie-break). */
function newest(subs) {
  return [...subs].sort((a, b) => (b.created - a.created) || String(b.id).localeCompare(String(a.id)))[0];
}

/** The columns contract 7.3 writes, read from one subscription. */
export function subscriptionState(sub, now) {
  const item = firstItem(sub) || {};
  return {
    subscriptionId: sub.id,
    status: sub.status,
    interval: intervalOf(sub),
    // Since 2025-03-31.basil the period lives on the subscription items.
    periodStart: Number.isFinite(item.current_period_start) ? item.current_period_start : null,
    periodEnd: Number.isFinite(item.current_period_end) ? item.current_period_end : null,
    trialEnd: Number.isFinite(sub.trial_end) ? sub.trial_end : null,
    // A portal cancellation sets cancel_at_period_end on classic subscriptions
    // and cancel_at on flexible ones; either means "ends at period end".
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || Number.isFinite(sub.cancel_at),
    now
  };
}

/**
 * Read a customer's subscriptions from Stripe and write the one the license
 * should follow. The ONLY way a license's status is ever written.
 *
 * Because every write comes from a fresh read, the order in which events
 * arrive does not matter: a late payment_failed, a retried old "updated", or
 * a replayed checkout all end up writing whatever Stripe says now.
 *
 * Returns the updated license row, or null when the customer has no license.
 */
export async function syncCustomer(deps, customerId) {
  const { env } = deps;
  const list = await deps.stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const ours = (list.data || []).filter(sub => isOurSubscription(env, sub));

  if (!ours.length) {
    // Nothing of ours at Stripe. Keep the row as it is, but note that Stripe
    // was asked, so the next decision does not ask again straight away.
    return touchSynced(env.DB, { customerId, now: deps.now() });
  }

  const live = ours.filter(sub => LIVE_STATUSES.has(sub.status));
  if (live.length > 1) logLine('duplicate_subscription', { customer: customerId });
  const picked = newest(live.length ? live : ours);
  return writeSubscriptionState(env.DB, customerId, subscriptionState(picked, deps.now()));
}

/**
 * This customer's Grayout subscription that is still open at Stripe (any of
 * OPEN_STATUSES), or null. Always a live read: a missed webhook must never
 * let someone buy a second subscription. Stripe's own guidance is to check
 * this before creating a Checkout Session.
 */
export async function openSubscriptionFor(deps, customerId) {
  const list = await deps.stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const open = (list.data || []).filter(sub => isOurSubscription(deps.env, sub) && OPEN_STATUSES.has(sub.status));
  return open.length ? newest(open) : null;
}

// ---------------------------------------------------------------- one trial per card and email

/**
 * An email in the form that matters for "same person": lower case, without a
 * "+tag", and for Gmail without dots (Gmail ignores both). '' when missing.
 */
export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return '';
  let local = email.slice(0, at).split('+')[0];
  let domain = email.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : '';
}

/** The card fingerprint behind a subscription, or null (a wallet with no card, or no permission). */
async function cardFingerprint(deps, subscriptionId) {
  try {
    const sub = await deps.stripe().subscriptions.retrieve(subscriptionId);
    const paymentMethodId = idOf(sub.default_payment_method);
    if (!paymentMethodId) return null;
    const paymentMethod = await deps.stripe().paymentMethods.retrieve(paymentMethodId);
    return (paymentMethod && paymentMethod.card && paymentMethod.card.fingerprint) || null;
  } catch (err) {
    // Usually a restricted key without "Payment Methods: Read". The email still counts.
    logLine('trial_card_unknown', { subscription: subscriptionId, error: describeError(err) });
    return null;
  }
}

/**
 * The marks this trial leaves: keyed hashes of the buyer's email and card
 * fingerprint. Only hashes are stored, keyed with LICENSE_SECRET, so the
 * database never holds the email or the card fingerprint itself.
 */
async function trialMarksFor(deps, session, subscriptionId) {
  const secret = deps.env.LICENSE_SECRET;
  const marks = [];
  const email = normalizeEmail(session.customer_details && session.customer_details.email);
  if (email) marks.push('email:' + await keyedHash(secret, 'trial-email:' + email));
  const fingerprint = await cardFingerprint(deps, subscriptionId);
  if (fingerprint) marks.push('card:' + await keyedHash(secret, 'trial-card:' + fingerprint));
  return marks;
}

/**
 * One free trial per card and per email, whatever device or browser it came
 * from (a device is free to make, so it cannot be what limits trials).
 *
 * If another customer already trialled with this card or email, this trial is
 * ended at once (Stripe then bills the first month right away), and the
 * license is marked so it gets no service while Stripe still says "trialing"
 * (in case Stripe refused to end the trial). Safe to run twice: the first
 * customer to use a mark keeps it.
 */
async function enforceOneTrial(deps, session, license) {
  const subscriptionId = idOf(session.subscription) || license.subscription_id;
  if (license.status !== 'trialing' || !subscriptionId) return license;

  const marks = await trialMarksFor(deps, session, subscriptionId);
  const repeat = await recordTrialMarks(deps.env.DB, { marks, customerId: license.customer_id, now: deps.now() });
  if (!repeat) return license;

  logLine('repeat_trial', { customer: license.customer_id, subscription: subscriptionId });
  await setTrialDenied(deps.env.DB, license.customer_id);
  try {
    await deps.stripe().subscriptions.update(subscriptionId, { trial_end: 'now' });
  } catch (err) {
    // The license is already marked, so the repeat trial still gets no service.
    logLine('trial_end_failed', { subscription: subscriptionId, error: describeError(err) });
  }
  return (await syncCustomer(deps, license.customer_id)) || license;
}

// ---------------------------------------------------------------- a second purchase from one device

/**
 * If this paid session would give its device a SECOND subscription, the
 * license the device already has; otherwise null. "Second" means: the device
 * bought or uses a license of a different customer, and that customer's
 * subscription is still open at Stripe.
 *
 * Both licenses are checked, the bought one first: `license_id` is only the
 * key last used on the device (it can be an old ended key, or someone
 * else's), so looking at it alone could hide the subscription the device
 * really bought.
 *
 * /v1/checkout already refuses this (409), and closes older sessions before
 * opening a new one. This is the last guard, for a session that was opened
 * before either could help (two left open at once, or an expire Stripe did
 * not carry out). It only asks Stripe in that rare case.
 */
async function earlierLicenseFor(deps, row, customerId) {
  const db = deps.env.DB;
  const device = await getDevice(db, row.device_id);
  if (!device) return null;
  const ids = [...new Set([device.bought_license_id, device.license_id].filter(Boolean))];
  for (const id of ids) {
    const earlier = await getLicenseById(db, id);
    if (!earlier || earlier.customer_id === customerId || !modeAllowed(deps.env, earlier.livemode)) continue;
    if (await openSubscriptionFor(deps, earlier.customer_id)) return earlier;
  }
  return null;
}

/**
 * Undo a second purchase: cancel its subscription now, and refund what it
 * charged (a trial charged nothing). Safe to run again: a canceled
 * subscription is not canceled twice, and each refund carries an
 * idempotency key, so a retry returns the same refund instead of a second one.
 * Any failure goes up, so the webhook answers 500 and Stripe retries.
 */
async function undoDuplicate(deps, session) {
  const stripe = deps.stripe();
  const subscriptionId = idOf(session.subscription);
  let invoiceId = idOf(session.invoice);
  if (subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
      await stripe.subscriptions.cancel(subscriptionId);
    }
    invoiceId = invoiceId || idOf(sub.latest_invoice);
  }
  if (session.payment_status !== 'paid') return;
  if (!invoiceId) {
    // Nothing to refund from here; the owner refunds it in the Dashboard.
    logLine('duplicate_refund_unresolved', { subscription: subscriptionId });
    return;
  }
  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
  for (const payment of payments.data || []) {
    const paymentIntent = payment.payment && idOf(payment.payment.payment_intent);
    if (!paymentIntent) continue;
    try {
      await stripe.refunds.create(
        { payment_intent: paymentIntent, reason: 'duplicate' },
        { idempotencyKey: `grayout-duplicate-${paymentIntent}` }
      );
    } catch (err) {
      // Refunded by an earlier run (more than a day ago): nothing left to do.
      if (err && err.code === 'charge_already_refunded') continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------- issuing a license

/** The license key for a licenses row, derived again (keys are never stored). */
export async function licenseKeyForRow(env, row) {
  if (!longSecretOk(env.LICENSE_SECRET)) fail('not_configured');
  return licenseKeyFor(env.LICENSE_SECRET, row.customer_id, row.generation, row.livemode === 1);
}

/**
 * Turn a paid Checkout Session into a license. Used by the webhook AND by
 * /v1/claim, so the two can never disagree. Safe to run any number of times,
 * in any order, at the same time. Contract section 7.1.
 *
 * Returns { action, license? } where action is license_issued,
 * duplicate_refunded, awaiting_payment or ignored.
 */
export async function fulfilSession(deps, session) {
  const { env } = deps;
  const db = env.DB;
  const now = deps.now();

  // 1. Only sessions this service created count, and only in this Worker's
  //    Stripe mode: a sandbox (test card) purchase never issues a license
  //    on the live Worker.
  const row = await getCheckoutSession(db, session.id);
  if (!row) return { action: 'ignored' };
  if (!modeAllowed(env, session.livemode === true)) {
    logLine('session_wrong_mode', { session: maskSessionId(session.id) });
    return { action: 'ignored' };
  }

  // 2. Nothing is issued until the money is there. A delayed payment method
  //    finishes later with checkout.session.async_payment_succeeded.
  if (!PAID_SESSION_STATES.has(session.payment_status)) return { action: 'awaiting_payment' };

  const customerId = idOf(session.customer);
  if (!customerId) {
    logLine('session_without_customer', { session: maskSessionId(session.id) });
    return { action: 'ignored' };
  }

  // 3. A second subscription for a device that already has a live one?
  //    Never move the device onto it. Cancel and refund it, and answer with
  //    the license the device already has (so /v1/claim hands back the key
  //    that works, not a canceled one).
  if (row.state === 'paid' && row.license_id) {
    // An earlier run already undid it: the row points at the OTHER customer's license.
    const done = await getLicenseById(db, row.license_id);
    if (done && done.customer_id !== customerId) return { action: 'duplicate_refunded', license: done };
  }
  const earlier = await earlierLicenseFor(deps, row, customerId);
  if (earlier) {
    logLine('duplicate_purchase', { session: maskSessionId(session.id), subscription: idOf(session.subscription) });
    try {
      await undoDuplicate(deps, session);
    } catch (err) {
      logLine('duplicate_undo_failed', { subscription: idOf(session.subscription), error: describeError(err) });
      throw err;
    }
    await markSessionPaid(db, { sessionId: row.session_id, licenseId: earlier.id });
    return { action: 'duplicate_refunded', license: earlier };
  }

  // 4. Issue (or read back) the one license this customer has.
  if (!longSecretOk(env.LICENSE_SECRET)) fail('not_configured');
  const livemode = session.livemode === true;
  const key = await licenseKeyFor(env.LICENSE_SECRET, customerId, 1, livemode);
  const issued = await issueLicense(db, { keyHash: await sha256Hex(key), livemode, customerId, now });

  // 5. Status comes from Stripe, never from a guess about the session.
  let license = (await syncCustomer(deps, customerId)) || issued;

  // 6. A trial: one per card and per email (may end this trial at once).
  //    Skipped when an earlier run already finished this session.
  if (row.trial === 1 && row.state !== 'paid') license = await enforceOneTrial(deps, session, license);

  // 7. Only now record the purchase against the session and the device.
  await markSessionPaid(db, { sessionId: row.session_id, licenseId: license.id });
  await markTrialUsed(db, { deviceId: row.device_id, now });
  // Every purchase, app or website, is remembered against its device so that
  // device cannot start a second subscription (purchase.js).
  await markBought(db, { deviceId: row.device_id, licenseId: license.id });
  if (row.device_code) {
    // The app started this purchase, so its device gets the license. A
    // purchase from the website is never attached to a browser: the browser
    // cannot restore the key or get service from it.
    await attachLicense(db, { deviceId: row.device_id, licenseId: license.id, now });
  }
  return { action: 'license_issued', license };
}

// ---------------------------------------------------------------- refunds and disputes

/**
 * The subscriptions a PaymentIntent paid for. Stripe's documented path for
 * basil and later: invoice payments → invoices → parent.subscription_details.
 * Contract section 7.5.
 */
export async function subscriptionsForPayment(deps, paymentIntentId) {
  const stripe = deps.stripe();
  const found = new Set();
  let startingAfter = null;
  for (;;) {
    const page = await stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      status: 'paid',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    const items = page.data || [];
    for (const invoicePayment of items) {
      const invoice = await stripe.invoices.retrieve(idOf(invoicePayment.invoice));
      const parent = invoice && invoice.parent;
      if (parent && parent.type === 'subscription_details' && parent.subscription_details) {
        const subId = idOf(parent.subscription_details.subscription);
        if (subId) found.add(subId);
      }
    }
    if (!page.has_more || !items.length) break;
    startingAfter = items[items.length - 1].id;
  }
  return [...found];
}

/**
 * Revoke the license that follows a subscription, then cancel the
 * subscription right away (the buyer has their money back, or their bank says
 * the card was used without permission), and re-read the customer. Returns
 * true when a license was revoked.
 *
 * Revoking comes FIRST. If the cancel fails (a key permission is missing, or
 * Stripe will not cancel it), the error still goes up so the webhook answers
 * 500 and Stripe retries the cancel, but the service has already stopped.
 * Revoking again on the retry changes nothing: it keeps the first time and reason.
 */
export async function cancelAndRevoke(deps, subscriptionId, reason) {
  const { env } = deps;
  const stripe = deps.stripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(sub.customer);

  // A license that was never synced does not know its subscription yet.
  // Sync it first (while the subscription is still live) so it can be matched.
  const before = customerId ? await getLicenseByCustomer(env.DB, customerId) : null;
  if (before && !before.subscription_id) await syncCustomer(deps, customerId);

  // Only the license that follows THIS subscription. A refund of an old,
  // already-ended subscription never touches a newer one's license.
  const revoked = await revokeBySubscription(env.DB, { subscriptionId, reason, now: deps.now() });

  if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      logLine('cancel_failed', { subscription: subscriptionId, error: describeError(err) });
      throw err;
    }
  }
  if (before) await syncCustomer(deps, customerId);
  return !!revoked;
}
