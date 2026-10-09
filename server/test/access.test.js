import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decide, displayStatus, includedChecksFor, neverPaid } from '../src/access.js';
import { INCLUDED_CHECKS, TRIAL_CHECKS } from '../src/config.js';

const NOW = 1_800_000_000;
const DAY = 86400;
const row = patch => ({ revoked_at: null, status: 'active', period_start: NOW - 20 * DAY, period_end: NOW + 10 * DAY, ...patch });

describe('decide(): who gets checks served (contract 7.2)', () => {
  test('active or trialing inside the period, or within 3 days after it: allowed', () => {
    assert.deepEqual(decide(row(), NOW), { allow: true });
    assert.deepEqual(decide(row({ status: 'trialing' }), NOW), { allow: true });
    assert.deepEqual(decide(row({ period_end: NOW - 3 * DAY + 1 }), NOW), { allow: true });
  });

  test('more than 3 days after the period: refused, whatever the stored status says', () => {
    assert.deepEqual(decide(row({ period_end: NOW - 3 * DAY }), NOW), { allow: false, code: 'subscription_inactive' });
    assert.deepEqual(decide(row({ status: 'trialing', period_end: NOW - 4 * DAY }), NOW), { allow: false, code: 'trial_expired' });
  });

  test('past_due counts from period_start, the end of the period that was paid', () => {
    // A failed yearly renewal: period_end is a year away, period_start is when the unpaid year began.
    const yearly = { status: 'past_due', period_start: NOW - 2 * DAY, period_end: NOW + 363 * DAY };
    assert.deepEqual(decide(row(yearly), NOW), { allow: true });
    assert.deepEqual(decide(row({ ...yearly, period_start: NOW - 3 * DAY }), NOW), { allow: false, code: 'subscription_inactive' });
  });

  test('past_due on the first charge after a trial gets no grace: nothing was ever paid (third pass, B22)', () => {
    // The trial ended 1 day ago and its first charge failed: the unpaid period began at trial_end.
    const failedConversion = { status: 'past_due', trial_end: NOW - DAY, period_start: NOW - DAY, period_end: NOW + 29 * DAY };
    assert.deepEqual(decide(row(failedConversion), NOW), { allow: false, code: 'subscription_inactive' });
    assert.equal(includedChecksFor(row(failedConversion)), TRIAL_CHECKS);
    assert.equal(neverPaid(row(failedConversion)), true);
    // A repeat trial ended at once (trial_end = period_start = now) whose charge declined.
    const repeat = { ...failedConversion, trial_denied: 1 };
    assert.deepEqual(decide(row(repeat), NOW), { allow: false, code: 'subscription_inactive', why: 'repeat_trial' });
    assert.deepEqual(decide(row({ ...repeat, trial_end: null }), NOW), { allow: false, code: 'subscription_inactive', why: 'repeat_trial' });
    assert.deepEqual(decide(row({ status: 'trialing', trial_denied: 1 }), NOW), { allow: false, code: 'subscription_inactive', why: 'repeat_trial' });
  });

  test('a failed RENEWAL after a paid period keeps its 3 days and the paid allowance, repeat trial or not', () => {
    // Trial ended 31 days ago, the first month was paid, the renewal 1 day ago failed.
    const renewal = { status: 'past_due', trial_end: NOW - 31 * DAY, period_start: NOW - DAY, period_end: NOW + 29 * DAY };
    for (const patch of [{}, { trial_denied: 1 }, { trial_end: null }]) {
      assert.deepEqual(decide(row({ ...renewal, ...patch }), NOW), { allow: true }, JSON.stringify(patch));
      assert.equal(includedChecksFor(row({ ...renewal, ...patch })), INCLUDED_CHECKS);
    }
    // A repeat trial that paid is active: full service and allowance.
    assert.deepEqual(decide(row({ trial_denied: 1, trial_end: NOW - 5 * DAY, period_start: NOW - 5 * DAY }), NOW), { allow: true });
    assert.equal(includedChecksFor(row({ status: 'trialing' })), TRIAL_CHECKS);
  });

  test('unpaid, incomplete, incomplete_expired, paused and canceled never get service', () => {
    for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled']) {
      assert.deepEqual(decide(row({ status }), NOW), { allow: false, code: 'subscription_inactive' }, status);
    }
  });

  test('a missing period is refused, and a revocation beats everything', () => {
    assert.deepEqual(decide(row({ period_end: null }), NOW), { allow: false, code: 'subscription_inactive' });
    assert.deepEqual(decide(row({ revoked_at: NOW - 1 }), NOW), { allow: false, code: 'license_revoked' });
  });
});

describe('displayStatus(): Stripe status → the five the app shows', () => {
  test('the contract table', () => {
    const table = {
      trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'past_due',
      canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled'
    };
    for (const [stripe, shown] of Object.entries(table)) assert.equal(displayStatus(stripe), shown, stripe);
  });
});
