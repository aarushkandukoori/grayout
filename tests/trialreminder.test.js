'use strict';
// The app's own reminder before a 7-day trial turns into a charge. Link sends
// one only for trials longer than 7 days (Stripe docs, "How Managed Payments
// works"), so without this nobody would warn the buyer.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('trialreminder');
const { createTrialReminder, reminderDue, REMIND_BEFORE_MS, REFRESH_EVERY_MS } = require('../src/trialreminder');
const pricing = require('../src/pricing');

after(() => helpers.cleanup(dir));

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 3600 * 1000;
const trialing = (trialEnd, extra = {}) => ({
  hasLicense: true, status: 'trialing', interval: 'monthly', cancelAtPeriodEnd: false, trialEnd, ...extra
});

describe('reminderDue', () => {
  test('due once 48 hours or less are left, and names the price and how to cancel', () => {
    assert.equal(REMIND_BEFORE_MS, 48 * HOUR);
    const end = new Date(NOW + 47 * HOUR).toISOString();
    const due = reminderDue(trialing(end), NOW, null);
    assert.ok(due);
    assert.match(due.body, new RegExp(`\\${pricing.PLANS.monthly.priceLabel} ${pricing.PLANS.monthly.periodLabel}`));
    assert.match(due.body, /plus tax where it applies/);
    assert.match(due.body, /link\.com/);
    assert.match(due.body, /Settings/);
  });

  test('not yet, not after the end, not twice for the same trial', () => {
    const end = new Date(NOW + 47 * HOUR).toISOString();
    assert.equal(reminderDue(trialing(new Date(NOW + 49 * HOUR).toISOString()), NOW, null), null, 'too early');
    assert.equal(reminderDue(trialing(new Date(NOW - HOUR).toISOString()), NOW, null), null, 'already over');
    assert.equal(reminderDue(trialing(end), NOW, end), null, 'already shown for this trial end');
    assert.ok(reminderDue(trialing(end), NOW, '2026-01-01T00:00:00Z'), 'an older trial does not count');
  });

  test('nothing to warn about: set to cancel, not trialing, no key, no date', () => {
    const end = new Date(NOW + 10 * HOUR).toISOString();
    assert.equal(reminderDue(trialing(end, { cancelAtPeriodEnd: true }), NOW, null), null);
    assert.equal(reminderDue(trialing(end, { status: 'active' }), NOW, null), null);
    assert.equal(reminderDue(trialing(end, { hasLicense: false }), NOW, null), null);
    assert.equal(reminderDue(trialing(null), NOW, null), null);
    assert.equal(reminderDue(null, NOW, null), null);
  });
});

describe('createTrialReminder', () => {
  function rig({ snap, statusReply } = {}) {
    let now = NOW;
    let current = snap;
    const stored = {};
    const shown = [];
    const statusCalls = [];
    const refreshed = [];
    const r = createTrialReminder({
      now: () => now,
      account: {
        snapshot: () => current,
        status: async opts => { statusCalls.push(opts); if (statusReply) current = statusReply; return { ok: true, cached: false, ...current }; }
      },
      state: { get: () => stored, update: fn => fn(stored) },
      notify: (title, body) => shown.push({ title, body }),
      onRefreshed: x => refreshed.push(x)
    });
    return { r, shown, stored, statusCalls, refreshed, advance: ms => { now += ms; }, setSnap: s => { current = s; } };
  }

  test('shows one notification per trial and records it in state.json', async () => {
    const end = new Date(NOW + 30 * HOUR).toISOString();
    const t = rig({ snap: trialing(end) });
    assert.ok(await t.r.tick());
    assert.equal(await t.r.tick(), null);
    t.advance(2 * HOUR);
    assert.equal(await t.r.tick(), null);
    assert.equal(t.shown.length, 1);
    assert.equal(t.stored.trialReminderFor, end);
  });

  test('reads the plan again about once a day while trialing; a trial canceled elsewhere is not warned about', async () => {
    const end = new Date(NOW + REFRESH_EVERY_MS + 30 * HOUR).toISOString();
    const t = rig({ snap: trialing(end), statusReply: trialing(end, { cancelAtPeriodEnd: true }) });
    await t.r.tick();
    assert.equal(t.statusCalls.length, 0, 'the launch refresh just ran');
    t.advance(REFRESH_EVERY_MS);
    await t.r.tick();
    assert.deepEqual(t.statusCalls, [{ force: true }]);
    assert.equal(t.refreshed.length, 1, 'the result goes back to main.js (it may lift a plan wait)');
    assert.equal(t.shown.length, 0, 'set to cancel: no charge, no reminder');
  });

  test('nothing at all for a Mac that is not trialing', async () => {
    const t = rig({ snap: { hasLicense: true, status: 'active' } });
    t.advance(3 * REFRESH_EVERY_MS);
    assert.equal(await t.r.tick(), null);
    assert.equal(t.statusCalls.length, 0);
    assert.equal(t.shown.length, 0);
  });

  test('main.js starts it, and a click opens the plan panel', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /createTrialReminder\(/);
    assert.match(main, /trialReminder\.start\(\)/);
    assert.match(main, /windows\.openDashboard\('account'\)/);
  });
});
