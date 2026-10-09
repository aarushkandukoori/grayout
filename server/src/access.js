// Who gets checks served, and the account object the app shows.
// Contract sections 6.1 and 7.2.

import {
  DENY_RECHECK_SECONDS, FREE_CHECKS, GRACE_SECONDS, INCLUDED_CHECKS, TRIAL_CHECKS, stripeKeyOk, supportSentence
} from './config.js';
import { describeError, fail, logLine } from './http.js';
import { getUsage, markSyncTried } from './db.js';
import { tryLimit } from './limits.js';
import { syncCustomer } from './stripe.js';
import { iso, monthKey, nextMonthStart } from './time.js';

const REPEAT_TRIAL_MESSAGE = 'This card or email already had a Grayout free trial, so this subscription starts when its first payment goes through. Manage it in Manage billing or at link.com.';

/**
 * True when the unpaid period this past_due subscription is in began where
 * its free trial ended. That means the charge that failed was the FIRST one
 * after the trial, so nothing has ever been paid. (After a paid month, a
 * failed renewal starts its unpaid period later than trial_end.)
 *
 * This also covers a repeat trial: stripe.js ends it with trial_end: 'now',
 * which makes Stripe set trial_end and the new period_start to the same moment.
 */
function unpaidSinceTrial(license) {
  const trialEnd = license.trial_end;
  // A repeat trial whose trial end Stripe did not report: we cannot tell
  // whether it ever paid, so assume it did not (repeat trials are the abuse case).
  if (license.trial_denied === 1 && !Number.isFinite(trialEnd)) return true;
  return Number.isFinite(trialEnd) && Number.isFinite(license.period_start) && license.period_start <= trialEnd;
}

/**
 * True for a subscription that has never had a payment go through: still in
 * its free trial, or past_due on the first charge after its trial. Such a
 * license gets the trial's allowance, never the paid one.
 */
export function neverPaid(license) {
  if (license.status === 'trialing') return true;
  return license.status === 'past_due' && unpaidSinceTrial(license);
}

/**
 * Decide from the stored row alone. Returns { allow: true } or
 * { allow: false, code }.
 *
 * Access always has an end date: the paid period plus 3 days of grace,
 * whatever the stored status says. For past_due the paid period ended when the
 * unpaid one began (period_start), because Stripe has already moved
 * period_end a month or a year ahead; using period_end there would let a
 * failed yearly renewal keep working for a year.
 *
 * The 3 days of grace are for someone who HAS paid and whose renewal failed.
 * A subscription that never paid anything gets none: otherwise a card that
 * declines at the end of every trial would get 3 more days at the full paid
 * allowance, and a repeat trial (ended at once at Stripe) would get them too.
 */
export function decide(license, now) {
  if (license.revoked_at) return { allow: false, code: 'license_revoked' };
  const status = license.status;
  const repeatTrial = license.trial_denied === 1;
  // A repeat trial (same card or email as an earlier one) gets no free week.
  // Normally the trial was already ended at Stripe (stripe.js), so the status
  // is no longer trialing; this covers the case where Stripe refused that.
  if (status === 'trialing' && repeatTrial) {
    return { allow: false, code: 'subscription_inactive', why: 'repeat_trial' };
  }
  // The first charge after the trial failed (for a repeat trial: the charge
  // made when its trial was ended at once). Nothing was ever paid, so no grace.
  if (status === 'past_due' && unpaidSinceTrial(license)) {
    return repeatTrial
      ? { allow: false, code: 'subscription_inactive', why: 'repeat_trial' }
      : { allow: false, code: 'subscription_inactive' };
  }
  let paidThrough;
  if (status === 'trialing' || status === 'active') paidThrough = license.period_end;
  else if (status === 'past_due') paidThrough = license.period_start;
  else return { allow: false, code: 'subscription_inactive' };

  if (paidThrough === null || paidThrough === undefined) return { allow: false, code: 'subscription_inactive' };
  if (now < paidThrough + GRACE_SECONDS) return { allow: true };
  return { allow: false, code: status === 'trialing' ? 'trial_expired' : 'subscription_inactive' };
}

/**
 * True when nobody has tried to re-read Stripe for this license in the last
 * 15 minutes. Counts failed attempts too: a read that keeps failing (Stripe
 * down, a missing key permission, a customer Stripe deleted) must not turn
 * every request into another Stripe call.
 */
function mayAskStripe(license, now) {
  return now - (license.sync_tried_at || 0) > DENY_RECHECK_SECONDS;
}

/**
 * Re-read Stripe, but never let a Stripe hiccup break the request.
 * With `ipKey`, the read also counts against that address's RL_STRIPE_IP
 * limit; over it, the stored row is used as it is.
 */
async function trySync(deps, license, ipKey) {
  if (!stripeKeyOk(deps.env.STRIPE_SECRET_KEY)) return license;
  if (ipKey && !(await tryLimit(deps.env, 'RL_STRIPE_IP', ipKey))) return license;

  // Record the attempt BEFORE asking, so a failure still counts as an attempt.
  const now = deps.now();
  await markSyncTried(deps.env.DB, { licenseId: license.id, now });
  const tried = { ...license, sync_tried_at: now };
  try {
    return (await syncCustomer(deps, license.customer_id)) || tried;
  } catch (err) {
    logLine('sync_failed', { customer: license.customer_id, error: describeError(err) });
    return tried;
  }
}

/**
 * Decide with fresh data where it matters:
 * - `maxAge`: re-read first when the row is older than this (status/activate use 24 h).
 * - Before refusing anyone (except a revocation), re-read if the row is more
 *   than 15 minutes old, so a missed or late webhook never locks out someone
 *   who paid.
 * - Either way, at most one attempt per license per 15 minutes (mayAskStripe).
 * - `ipKey`: count each re-read against that address's RL_STRIPE_IP.
 *
 * Returns { license, allow, code?, why? } with the freshest row.
 */
export async function accessFor(deps, license, { maxAge = null, ipKey = null } = {}) {
  let row = license;
  if (maxAge !== null && deps.now() - row.synced_at > maxAge && mayAskStripe(row, deps.now())) {
    row = await trySync(deps, row, ipKey);
  }

  let verdict = decide(row, deps.now());
  const stale = deps.now() - row.synced_at > DENY_RECHECK_SECONDS;
  if (!verdict.allow && verdict.code !== 'license_revoked' && stale && mayAskStripe(row, deps.now())) {
    row = await trySync(deps, row, ipKey);
    verdict = decide(row, deps.now());
  }
  return { license: row, ...verdict };
}

/** The error for a refusal from decide(). */
export function failAccess(env, code, why) {
  if (code === 'license_revoked') fail('license_revoked', { message: revokedMessage(env) });
  if (why === 'repeat_trial') fail(code, { message: REPEAT_TRIAL_MESSAGE });
  fail(code);
}

export function revokedMessage(env) {
  return `This subscription was refunded or disputed. ${supportSentence(env)}`;
}

/** Stripe's subscription status, folded onto the five the app shows. Display only. */
export function displayStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete': return 'past_due';
    default: return 'canceled';
  }
}

/**
 * Checks a month for this license: the trial's 1,000 until a payment has gone
 * through, then 10,000. Keyed on "never paid", not on the status alone, so a
 * trial whose first charge failed never shows (or gets) the paid allowance.
 */
export function includedChecksFor(license) {
  return neverPaid(license) ? TRIAL_CHECKS : INCLUDED_CHECKS;
}

/** The usage block for a license. */
export function paidUsage(license, checksUsed, now) {
  return {
    checksUsed,
    checksIncluded: includedChecksFor(license),
    periodEnd: iso(license.period_end),
    resetsAt: iso(nextMonthStart(now))
  };
}

/** The usage block for the free taste. It never comes back, so no dates. */
export function freeUsage(freeUsed) {
  return { checksUsed: freeUsed, checksIncluded: FREE_CHECKS, periodEnd: null, resetsAt: null };
}

/** The account object of contract 6.1, for a license and an access decision. */
export async function accountObject(deps, access) {
  const license = access.license;
  const now = deps.now();
  const usage = await getUsage(deps.env.DB, { licenseId: license.id, month: monthKey(now) });
  const status = displayStatus(license.status);
  return {
    plan: status,
    status,
    service: access.allow === true,
    interval: license.billing_interval || null,
    cancelAtPeriodEnd: license.cancel_at_period_end === 1,
    periodEnd: iso(license.period_end),
    trialEnd: license.status === 'trialing' ? iso(license.trial_end) : null,
    usage: paidUsage(license, usage.n, now)
  };
}
