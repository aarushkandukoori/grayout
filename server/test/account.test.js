// A subscriber's account: /v1/activate, /v1/status, /v1/portal (contract 6.1, 6.8–6.10).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { harness, T0, DAY } from './helpers.js';

/** A device with a working trial license. */
async function subscriber(h, options) {
  const device = await h.mint();
  const purchase = await h.appPurchase(device, options);
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code });
  return { device, license: claim.body.license, subscription: purchase.subscription };
}

describe('POST /v1/activate', () => {
  test('attaches a pasted key to another Mac and answers the account object', async () => {
    const h = harness();
    const { license } = await subscriber(h);
    const other = await h.mint();
    const res = await h.call('/v1/activate', { ...other, license: ` ${license.toLowerCase()} ` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      plan: 'trialing',
      status: 'trialing',
      service: true,
      interval: 'monthly',
      cancelAtPeriodEnd: false,
      periodEnd: '2026-10-15T12:00:00Z',
      trialEnd: '2026-10-15T12:00:00Z',
      usage: { checksUsed: 0, checksIncluded: 1000, periodEnd: '2026-10-15T12:00:00Z', resetsAt: '2026-11-01T00:00:00Z' }
    });
    const dev = h.db.rows('SELECT license_id, trial_used_at FROM devices WHERE device_id = ?', other.deviceId)[0];
    assert.ok(dev.license_id);
    assert.equal(dev.trial_used_at, T0, 'holding a license counts as having had a trial');
  });

  test('the key may come in an Authorization: Bearer header instead of the body', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    const res = await h.call('/v1/activate', device, { headers: { Authorization: `Bearer ${license}` } });
    assert.equal(res.status, 200);
  });

  test('unknown or malformed keys are license_invalid; a missing key is bad_request', async () => {
    const h = harness();
    const device = await h.mint();
    assert.equal((await h.call('/v1/activate', { ...device, license: 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D' })).body.error.code, 'license_invalid');
    assert.equal((await h.call('/v1/activate', { ...device, license: 'not a key' })).body.error.code, 'license_invalid');
    assert.equal((await h.call('/v1/activate', device)).body.error.code, 'bad_request');
  });

  test('a canceled license still activates, with service false', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    h.clock.advance(2 * DAY); // the row is now over 24 hours old, so activate re-reads Stripe
    const res = await h.call('/v1/activate', { ...device, license });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'canceled');
    assert.equal(res.body.service, false);
  });

  test('a revoked license is 403 and is not attached', async () => {
    const h = harness();
    const { license } = await subscriber(h);
    h.db.write("UPDATE licenses SET revoked_at = ?, revoked_reason = 'refund'", T0);
    const other = await h.mint();
    const res = await h.call('/v1/activate', { ...other, license });
    assert.equal(res.status, 403);
    assert.equal(h.db.rows('SELECT license_id FROM devices WHERE device_id = ?', other.deviceId)[0].license_id, null);
  });
});

describe('POST /v1/status', () => {
  test('re-reads Stripe when the row is more than 24 hours old, and not before', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    h.stripe.updateSubscription(subscription.id, { cancel_at: T0 + 7 * DAY });
    const lists = () => h.stripe.callsTo('subscriptions.list').length;

    const before = lists();
    h.clock.advance(DAY - 10);
    const fresh = await h.call('/v1/status', { ...device, license });
    assert.equal(lists(), before);
    assert.equal(fresh.body.cancelAtPeriodEnd, false);

    h.clock.advance(20);
    const stale = await h.call('/v1/status', { ...device, license });
    assert.equal(lists(), before + 1);
    assert.equal(stale.body.cancelAtPeriodEnd, true, 'a portal cancellation (cancel_at) shows up');
    assert.equal(stale.body.portalUrl, null, 'no portal link unless asked');
  });

  test('portal: true adds a fresh billing portal link and counts against RL_STRIPE_IP', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    const res = await h.call('/v1/status', { ...device, license, portal: true });
    assert.equal(res.body.portalUrl, `https://billing.stripe.com/p/session/test_${subscription.customer}`);
    const portal = h.stripe.callsTo('billingPortal.sessions.create').at(-1).args[0];
    // The app sends no Origin header, so the portal returns to the app page.
    assert.deepEqual(portal, { customer: subscription.customer, return_url: 'https://aarushkandukoori.github.io/grayout/account.html?from=app' });
    h.limiters.RL_STRIPE_IP.max = 0;
    assert.equal((await h.call('/v1/status', { ...device, license, portal: true })).status, 429);
    assert.equal((await h.call('/v1/status', { ...device, license })).status, 200);
  });

  test('a Stripe outage never breaks status: the stored row answers', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    h.clock.advance(2 * DAY);
    h.stripe.failOn('subscriptions.list', { once: false });
    const res = await h.call('/v1/status', { ...device, license });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, true);
  });
});

describe('POST /v1/portal', () => {
  test('a billing portal link for the license customer', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    const res = await h.call('/v1/portal', { ...device, license });
    assert.deepEqual(res.body, { url: `https://billing.stripe.com/p/session/test_${subscription.customer}` });
  });

  test('the portal returns the app to account.html?from=app and a browser (it sends Origin) to the home page', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    const returnUrl = () => h.stripe.callsTo('billingPortal.sessions.create').at(-1).args[0].return_url;
    await h.call('/v1/portal', { ...device, license });
    assert.equal(returnUrl(), 'https://aarushkandukoori.github.io/grayout/account.html?from=app');
    const browser = { headers: { Origin: 'https://aarushkandukoori.github.io' } };
    assert.equal((await h.call('/v1/portal', { ...device, license }, browser)).status, 200);
    assert.equal(returnUrl(), 'https://aarushkandukoori.github.io/grayout/');
    assert.equal((await h.call('/v1/status', { ...device, license, portal: true }, browser)).status, 200);
    assert.equal(returnUrl(), 'https://aarushkandukoori.github.io/grayout/');
  });

  test('Stripe refusing is 503 not_configured; a revoked license is 403', async () => {
    const h = harness();
    const { device, license } = await subscriber(h);
    h.stripe.failOn('billingPortal.sessions.create');
    assert.equal((await h.call('/v1/portal', { ...device, license })).body.error.code, 'not_configured');
    h.db.write("UPDATE licenses SET revoked_at = ?, revoked_reason = 'dispute'", T0);
    assert.equal((await h.call('/v1/portal', { ...device, license })).status, 403);
  });
});
