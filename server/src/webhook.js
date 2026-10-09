// POST /v1/stripe/webhook. Contract sections 6.12 and 7.4.
//
// For every delivery:
//   1. Fail closed (503) unless the webhook secret and the Stripe key are real.
//   2. Check the signature on the raw body.
//   3. If this event id was handled before, say "duplicate" and stop.
//   4. Handle it. Subscription, invoice, refund, dispute and fraud-warning
//      events never trust the payload's status: they make the service read
//      Stripe live.
//   5. Only after the handler succeeded, record the event id. If anything
//      threw, answer 500 and record nothing, so Stripe retries. Every handler
//      is safe to repeat, so a retry after a half-finished run is fine.

import { MAX_BODY_BYTES, stripeKeyOk, webhookSecretOk } from './config.js';
import { fail, isJsonContentType, logLine, readBodyText } from './http.js';
import {
  closeSession, eventSeen, getCheckoutSession, getLicenseByCustomer, recordEvent
} from './db.js';
import {
  cancelAndRevoke, fulfilSession, idOf, subscriptionsForPayment, syncCustomer, verifyWebhookEvent
} from './stripe.js';

/** Sync a customer's license from Stripe, if they have one. */
async function syncIfLicensed(deps, customerId) {
  if (!customerId) return 'ignored';
  const license = await getLicenseByCustomer(deps.env.DB, customerId);
  // No license yet: nothing to update. Issuing the license syncs anyway, so
  // an event that arrives before checkout completes is not lost.
  if (!license) return 'ignored';
  await syncCustomer(deps, customerId);
  return 'synced';
}

/** checkout.session.async_payment_failed: the delayed payment did not clear. */
async function sessionPaymentFailed(deps, session) {
  const row = await getCheckoutSession(deps.env.DB, session.id);
  if (!row) return 'ignored';
  await closeSession(deps.env.DB, { sessionId: row.session_id, state: 'failed' });
  const customerId = idOf(session.customer);
  if (customerId && await getLicenseByCustomer(deps.env.DB, customerId)) await syncCustomer(deps, customerId);
  return 'failed';
}

/** Cancel and revoke every subscription a PaymentIntent paid for. */
async function revokeForPayment(deps, eventId, paymentIntentId, reason, unresolvedLog) {
  if (!paymentIntentId) {
    logLine(unresolvedLog, { id: eventId, why: 'no payment intent' });
    return 'ignored';
  }
  const subscriptionIds = await subscriptionsForPayment(deps, paymentIntentId);
  if (!subscriptionIds.length) {
    // We sell nothing but subscriptions, so the owner looks at this by hand.
    logLine(unresolvedLog, { id: eventId, why: 'no subscription invoice' });
    return 'ignored';
  }
  let revoked = false;
  for (const subscriptionId of subscriptionIds) {
    if (await cancelAndRevoke(deps, subscriptionId, reason)) revoked = true;
  }
  return revoked ? 'revoked' : 'ignored';
}

/** charge.refunded: a FULL refund cancels and revokes; a partial one leaves access alone. */
async function chargeRefunded(deps, charge, eventId) {
  // `refunded` is true only when the whole charge was refunded.
  if (charge.refunded !== true) return 'partial_refund';
  return revokeForPayment(deps, eventId, idOf(charge.payment_intent), 'refund', 'refund_unresolved');
}

/**
 * The PaymentIntent behind a dispute or an early fraud warning: its own
 * `payment_intent` field when Stripe filled it in, otherwise the charge's.
 */
async function paymentIntentOf(deps, object) {
  const direct = idOf(object.payment_intent);
  if (direct || !object.charge) return direct;
  const charge = await deps.stripe().charges.retrieve(idOf(object.charge));
  return idOf(charge && charge.payment_intent);
}

/** charge.dispute.created: cancel and revoke. Stripe answers the dispute itself (Managed Payments). */
async function disputeCreated(deps, dispute, eventId) {
  return revokeForPayment(deps, eventId, await paymentIntentOf(deps, dispute), 'dispute', 'dispute_unresolved');
}

/**
 * radar.early_fraud_warning.created: the card's bank says the card was used
 * without the owner's permission. A formal dispute usually follows weeks
 * later; until then a stolen card would keep full service and keep being
 * charged. Cancel and revoke now, exactly as for a dispute.
 */
async function earlyFraudWarning(deps, warning, eventId) {
  return revokeForPayment(deps, eventId, await paymentIntentOf(deps, warning), 'fraud', 'fraud_warning_unresolved');
}

/** Route one verified event to its handler. Returns the action name. */
export async function handleEvent(deps, event) {
  const object = event.data && event.data.object;
  if (!object) return 'ignored';
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return (await fulfilSession(deps, object)).action;
    case 'checkout.session.async_payment_failed':
      return sessionPaymentFailed(deps, object);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'invoice.paid':
    case 'invoice.payment_failed':
      // Never derive a status from the event itself.
      return syncIfLicensed(deps, idOf(object.customer));
    case 'charge.refunded':
      return chargeRefunded(deps, object, event.id);
    case 'charge.dispute.created':
      return disputeCreated(deps, object, event.id);
    case 'radar.early_fraud_warning.created':
      return earlyFraudWarning(deps, object, event.id);
    default:
      return 'ignored';
  }
}

export async function postWebhook(deps, { request }) {
  const { env } = deps;

  // 1. A missing or placeholder secret must never open anything.
  if (!webhookSecretOk(env.STRIPE_WEBHOOK_SECRET) || !stripeKeyOk(env.STRIPE_SECRET_KEY)) fail('not_configured');
  if (!isJsonContentType(request)) fail('bad_request', { message: 'A webhook must be JSON.' });

  // 2. The signature, checked on the raw body before anything else is read from it.
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) fail('invalid_signature');
  const rawBody = await readBodyText(request, MAX_BODY_BYTES);
  let event;
  try {
    event = await verifyWebhookEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    fail('invalid_signature');
  }

  // 3. Seen before?
  const db = env.DB;
  if (await eventSeen(db, event.id)) return { received: true, action: 'duplicate' };

  // 4 and 5. Handle, then record.
  const action = await handleEvent(deps, event);
  await recordEvent(db, { eventId: event.id, type: event.type, now: deps.now() });
  logLine('webhook', { id: event.id, type: event.type, action });
  return { received: true, action };
}
