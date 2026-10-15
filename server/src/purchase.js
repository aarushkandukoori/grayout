// Buying: starting a Checkout Session, and collecting the license it bought.
// Contract sections 6.5 and 6.6.

import {
  DEVICE_CODE_TTL_SECONDS, PLANS, SESSION_RECHECK_SECONDS, modeAllowed, priceFor, sellingAllowed, siteUrl
} from './config.js';
import { ApiError, describeError, fail, failRetry, logLine } from './http.js';
import { SESSION_ID_RE, maskSessionId, normalizeDeviceCode } from './ids.js';
import {
  claimTrial, closeSession, getCheckoutSession, getDevice, getDeviceCode, getLicenseById, insertCheckoutSession,
  lockCheckout, newestSessionForCode, openSessionsForDevice, releaseTrialClaim, setSessionCheckedAt, unlockCheckout
} from './db.js';
import { limit } from './limits.js';
import { requireDevice } from './devices.js';
import { revokedMessage } from './access.js';
import {
  PAID_SESSION_STATES, checkoutParams, fulfilSession, licenseKeyForRow, openSubscriptionFor, portalUrlOrNull
} from './stripe.js';

const CODE_EXPIRED_MESSAGE = 'That purchase link has expired. Start the purchase again, or restore your key in Settings.';
const PAYMENT_PROBLEM_MESSAGE = 'This Grayout subscription is waiting on a payment. Fix it in Manage billing or at link.com instead of buying again.';
const PAYMENT_PROCESSING_MESSAGE = 'A Grayout payment from this device is still being processed. Wait for it to finish before buying again.';
const CHECKOUT_BUSY_MESSAGE = 'A checkout for this device is already starting. Try again in a few seconds.';

function sessionUnknownMessage(env) {
  const email = String(env.SUPPORT_EMAIL || '').trim();
  return `This link has expired. If you need your key again, email ${email || 'Grayout support'}.`;
}

/** A device code from the body that exists, is unexpired, and belongs to this device. */
async function requireOwnCode(deps, device, input) {
  const code = normalizeDeviceCode(input);
  if (!code) fail('bad_request', { message: 'That device code is not the right shape.' });
  const row = await getDeviceCode(deps.env.DB, code);
  if (!row || row.device_id !== device.device_id || row.expires_at <= deps.now()) {
    fail('code_expired', { message: CODE_EXPIRED_MESSAGE });
  }
  return code;
}

/**
 * Run a Stripe call for checkout. If Stripe refuses (a missing key
 * permission, a wrong price id), log a summary and answer 503
 * not_configured: Stripe's own wording can name prices and accounts.
 */
async function askStripe(what, call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logLine(what, { error: describeError(err) });
    fail('not_configured');
  }
}

/**
 * Close this device's older checkouts before opening a new one, so at most
 * one can ever be paid (two tabs, a double click, monthly then yearly).
 *
 * Returns 'paid' if one of them turned out to be paid already (it is
 * fulfilled on the spot, so step 3 of postCheckout sees the purchase),
 * 'processing' if one is waiting on a delayed payment, or null.
 */
async function closeOlderSessions(deps, device) {
  const db = deps.env.DB;
  const stripe = deps.stripe();
  let found = null;
  for (const row of await openSessionsForDevice(db, device.device_id)) {
    let session = null;
    if (row.expires_at > deps.now()) {
      // Stripe only expires a session that is still open. If this one was
      // completed in the meantime, the expire fails and we look at it below.
      try {
        session = await stripe.checkout.sessions.expire(row.session_id);
      } catch {
        session = null;
      }
    }
    if (!session) {
      // Completed, or past its expiry (Stripe has closed it, but it may have been paid first).
      session = await askStripe('checkout_lookup_failed', () => stripe.checkout.sessions.retrieve(row.session_id));
      if (session.status === 'open' && row.expires_at > deps.now()) {
        // Stripe would not expire it, and it can still be paid. Opening a
        // new checkout next to it could end in two subscriptions, so stop
        // here; the next attempt tries the expire again.
        logLine('checkout_expire_failed', { session: maskSessionId(row.session_id) });
        fail('not_configured');
      }
    }

    if (session.status === 'complete' && PAID_SESSION_STATES.has(session.payment_status)) {
      await fulfilSession(deps, session);
      found = 'paid';
    } else if (session.status === 'complete') {
      found = found || 'processing';
    } else {
      await closeSession(db, { sessionId: row.session_id, state: 'expired' });
      // It ended unpaid, so the trial it claimed is this device's again.
      if (row.trial === 1) await releaseTrialClaim(db, { deviceId: row.device_id, claimedAt: row.created_at });
    }
  }
  return found;
}

/**
 * Every license this device knows, as { bought, licenses }:
 * - `bought`: the license this device BOUGHT itself (app or website), or null;
 * - `licenses`: that one first, then the license it last USED, if different.
 *
 * Both count. `license_id` is whatever key was last pasted into or used on
 * this Mac, which can be an old ended key or someone else's. Looking only at
 * that one hid the subscription the device really bought, so a subscriber
 * could start a second one. A license from the other Stripe mode does not count.
 */
export async function knownLicenses(deps, device) {
  const db = deps.env.DB;
  const usable = async id => {
    if (!id) return null;
    const license = await getLicenseById(db, id);
    return license && modeAllowed(deps.env, license.livemode) ? license : null;
  };
  const bought = await usable(device.bought_license_id);
  const used = device.license_id === device.bought_license_id ? null : await usable(device.license_id);
  return { bought, licenses: [bought, used].filter(Boolean) };
}

/**
 * POST /v1/checkout. Never makes a second subscription:
 * - a device with a subscription still open at Stripe, on the license it
 *   bought (app or website) OR the one it uses, gets 409 already_subscribed
 *   with a billing portal link;
 * - an older open checkout from the same device is closed first, and only
 *   one checkout per device runs at a time (a lock in D1);
 * - the Stripe customer of the license this device bought is reused, and
 *   gets no second trial.
 * The trial is once per device here (claimed when the session is created),
 * and once per card and email at fulfilment (stripe.js).
 */
export async function postCheckout(deps, { body, ipKey }) {
  const db = deps.env.DB;
  // 1. Who, and which plan. Both are checked before the lock below, which is
  //    a database write: a flood of bad requests must not turn into writes.
  const device = await requireDevice(deps, body);
  await limit(deps.env, 'RL_DEVICE', `dev:${device.device_id}`);
  if (!PLANS.includes(body.plan)) fail('bad_request', { message: 'The plan has to be monthly or yearly.' });
  // Two checkouts for one device at the same moment would each see "no
  // subscription yet" and could both be paid. The lock makes them take turns.
  if (!(await lockCheckout(db, { deviceId: device.device_id, now: deps.now() }))) {
    failRetry('rate_limited', 5, CHECKOUT_BUSY_MESSAGE);
  }
  try {
    return await checkoutLocked(deps, device, { body, ipKey });
  } finally {
    await unlockCheckout(db, device.device_id);
  }
}

/** The rest of postCheckout, run while this device's checkout lock is held. */
async function checkoutLocked(deps, device, { body, ipKey }) {
  const { env } = deps;
  const db = env.DB;
  const now = deps.now();

  // 1. Which purchase (from the app). The plan was checked before the lock.
  const plan = body.plan;
  const hasCode = body.deviceCode !== undefined && body.deviceCode !== null && body.deviceCode !== '';
  const deviceCode = hasCode ? await requireOwnCode(deps, device, body.deviceCode) : null;
  // A test (sandbox) key only sells on the sandbox Worker (config.js).
  if (!priceFor(env, plan) || !siteUrl(env) || !sellingAllowed(env)) fail('not_configured');

  // Everything from here calls Stripe (a checkout or a portal link).
  await limit(env, 'RL_STRIPE_IP', ipKey);

  // 2. Close this device's older checkouts. One that was paid meanwhile is
  //    fulfilled now, so step 3 sees it.
  const older = await closeOlderSessions(deps, device);
  if (older === 'processing') fail('already_subscribed', { message: PAYMENT_PROCESSING_MESSAGE, extra: { portalUrl: null } });
  // Read the device again: closing old sessions may have recorded a purchase
  // or handed a trial claim back.
  device = await getDevice(db, device.device_id);

  // 3. Does this device already have a subscription? Check the license it
  //    bought AND the one it uses (they differ when another key was pasted in).
  const { bought, licenses } = await knownLicenses(deps, device);
  for (const license of licenses) {
    if (license.revoked_at) fail('license_revoked', { message: revokedMessage(env) });
    // Ask Stripe live. Anything still open there (trialing, active, or even
    // past_due, unpaid or paused, which Stripe may still charge) means
    // "manage the one you have", never "buy another".
    const open = await askStripe('checkout_failed', () => openSubscriptionFor(deps, license.customer_id));
    if (open) {
      const unpaid = open.status !== 'trialing' && open.status !== 'active';
      fail('already_subscribed', {
        message: unpaid ? PAYMENT_PROBLEM_MESSAGE : undefined,
        // A checkout the app started returns from the portal to a page made
        // for the app (stripe.js portalReturnUrl); the website's goes home.
        extra: { portalUrl: await portalUrlOrNull(deps, license.customer_id, { fromApp: deviceCode !== null }) }
      });
    }
  }
  // Everything at Stripe has ended (canceled or incomplete_expired): buy
  // again. Reuse the Stripe customer only of the license this device BOUGHT.
  // A key that was only pasted in may be someone else's: buying on their
  // customer would put this purchase under their email and their key.
  const customerId = bought ? bought.customer_id : null;

  // 4. The trial is for a device that never had a trial or a subscription. A
  //    returning customer never gets one either. It is claimed NOW, when the
  //    session is made, not when it is paid; an unpaid session hands it back
  //    when it is closed (closeOlderSessions, a claim that finds it expired,
  //    or the daily cleanup).
  const trial = plan === 'monthly' && device.trial_used_at === null && licenses.length === 0
    && await claimTrial(db, { deviceId: device.device_id, now });

  // 5. Create the session. If Stripe refuses, the trial claim goes back.
  let session;
  try {
    session = await askStripe('checkout_failed', () => deps.stripe().checkout.sessions.create(checkoutParams({
      env, plan, deviceId: device.device_id, deviceCode, customerId, trial, now
    })));
    if (!session || !session.id || !session.url) fail('not_configured');
  } catch (err) {
    if (trial) await releaseTrialClaim(db, { deviceId: device.device_id, claimedAt: now });
    throw err;
  }

  // 6. Remember it. This row is the only way a payment maps back to a device.
  await insertCheckoutSession(db, {
    sessionId: session.id,
    deviceId: device.device_id,
    deviceCode,
    plan,
    trial,
    livemode: session.livemode === true,
    now,
    expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : now + DEVICE_CODE_TTL_SECONDS
  });

  return { url: session.url, sessionId: session.id, trial };
}

/** { status: 'ready', license } for a license row, or 403 if it was revoked. */
async function readyAnswer(deps, license) {
  if (license.revoked_at) fail('license_revoked', { message: revokedMessage(deps.env) });
  return { status: 'ready', license: await licenseKeyForRow(deps.env, license) };
}

/**
 * Answer a claim for one checkout_sessions row. Asks Stripe at most once every
 * 10 seconds per session, and issues the license on the spot when Stripe says
 * it is paid, so a buyer never waits on webhook timing.
 */
async function answerForSession(deps, row, ipKey) {
  const { env } = deps;
  const db = env.DB;
  const now = deps.now();

  if (row.license_id) {
    const license = await getLicenseById(db, row.license_id);
    if (license) return readyAnswer(deps, license);
  }
  if (row.state === 'failed') return { status: 'failed', reason: 'payment_failed' };
  if (row.state === 'expired') return { status: 'failed', reason: 'expired' };
  if (row.checked_at !== null && now - row.checked_at < SESSION_RECHECK_SECONDS) return { status: 'pending' };

  await limit(env, 'RL_STRIPE_IP', ipKey);
  // Set before asking, so a burst of polls makes one Stripe call, not many.
  await setSessionCheckedAt(db, { sessionId: row.session_id, now });

  let session;
  try {
    session = await deps.stripe().checkout.sessions.retrieve(row.session_id);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logLine('claim_retrieve_failed', { session: maskSessionId(row.session_id), error: describeError(err) });
    return { status: 'pending' };
  }

  if (session.status === 'complete' && PAID_SESSION_STATES.has(session.payment_status)) {
    let result;
    try {
      result = await fulfilSession(deps, session);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Fulfilment is idempotent, so the next poll simply tries again.
      logLine('claim_fulfil_failed', { session: maskSessionId(row.session_id), error: describeError(err) });
      return { status: 'pending' };
    }
    return result.license ? readyAnswer(deps, result.license) : { status: 'pending' };
  }
  if (session.status === 'expired') {
    await closeSession(db, { sessionId: row.session_id, state: 'expired' });
    // It ended unpaid, so the trial it claimed is this device's again. Once
    // the row says 'expired', closeOlderSessions never looks at it again, so
    // this is the moment to hand the claim back.
    if (row.trial === 1) await releaseTrialClaim(db, { deviceId: row.device_id, claimedAt: row.created_at });
    return { status: 'failed', reason: 'expired' };
  }
  // Open, or complete but a delayed payment has not cleared yet.
  return { status: 'pending' };
}

/**
 * POST /v1/claim, two forms:
 * - { deviceCode, deviceId, deviceToken } from the app, for a purchase it started;
 * - { sessionId } from success.html, for any purchase (the id is in the redirect URL).
 */
export async function postClaim(deps, { body, ipKey }) {
  const db = deps.env.DB;

  if (body.sessionId !== undefined) {
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      fail('bad_request', { message: 'That checkout session id is not the right shape.' });
    }
    // Only sessions this service created. An unknown id never reaches Stripe.
    const row = await getCheckoutSession(db, sessionId);
    // A session from the other Stripe mode is not this Worker's to answer.
    if (!row || !modeAllowed(deps.env, row.livemode)) fail('code_expired', { message: sessionUnknownMessage(deps.env) });
    return answerForSession(deps, row, ipKey);
  }

  if (body.deviceCode !== undefined) {
    const device = await requireDevice(deps, body);
    const code = await requireOwnCode(deps, device, body.deviceCode);
    const row = await newestSessionForCode(db, code);
    if (!row || !modeAllowed(deps.env, row.livemode)) return { status: 'pending' };
    return answerForSession(deps, row, ipKey);
  }

  fail('bad_request', { message: 'A claim needs a deviceCode or a sessionId.' });
}
