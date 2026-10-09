// One regression test for each of the 19 problems the 2026-10-08 review of
// the v3 server confirmed (contract Appendix B). Several findings were
// reported twice in different words; each still gets its own test, aimed at
// the part that finding stressed. Each test fails on the first v3 draft.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { harness, parseJsonc, responsesPayload, stripeEvent, T0, DAY } from './helpers.js';
import { cspProblems } from '../scripts/check-csp.js';
import { ipKeyFor } from '../src/http.js';
import { FREE_CHECKS_PER_NETWORK, TRIAL_CHECKS } from '../src/config.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SERVER, '..');
const read = path => readFileSync(join(SERVER, path), 'utf8');

/** A shaped live key for tests. Not a real key. Assembled at runtime so secret
 *  scanners do not mistake the fixture for a leaked credential. */
const LIVE_KEY = ['rk', 'live', '51TestOnlyRestrictedKey0123456789'].join('_');

/** A Mac that bought (monthly trial unless told otherwise) and claimed its key. */
async function subscriber(h, options) {
  const device = await h.mint();
  const purchase = await h.appPurchase(device, options);
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code });
  return { device, license: claim.body.license, ...purchase };
}

/** A browser that bought on the website (no device code) and got its key on success.html. */
async function websiteBuyer(h, { plan = 'yearly', email, card } = {}) {
  const browser = await h.mint();
  const checkout = await h.call('/v1/checkout', { ...browser, plan });
  const { subscription } = h.stripe.completeSession(checkout.body.sessionId, { email, card });
  const claim = await h.call('/v1/claim', { sessionId: checkout.body.sessionId });
  return { browser, checkout, subscription, license: claim.body.license };
}

const licenseRow = h => h.db.rows('SELECT * FROM licenses ORDER BY id')[0];
const check = (h, device, license) => h.call('/v1/check', h.checkBody(device, license ? { license } : {}));
const creates = h => h.stripe.callsTo('checkout.sessions.create').length;

/** Every per-minute limiter reset: "a minute passed". */
function minutePasses(h) {
  for (const limiter of Object.values(h.limiters)) limiter.reset();
}

describe('2026-10-08 review findings, fixed', () => {
  test('review 0: a website buyer who checks out again from the same browser gets 409, not a second subscription', async () => {
    const h = harness();
    const { browser } = await websiteBuyer(h, { plan: 'monthly' });
    const again = await h.call('/v1/checkout', { ...browser, plan: 'yearly' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_subscribed');
    assert.match(again.body.error.portalUrl, /^https:\/\/billing\.stripe\.com\//);
    assert.equal(creates(h), 1, 'no second Checkout Session');
    // The browser still holds no key: the purchase only blocks a repeat.
    assert.deepEqual((await h.call('/v1/restore', browser)).body, { status: 'none' });
  });

  test('review 1: a past_due, unpaid or paused customer is sent to the portal, not to a second checkout', async () => {
    for (const status of ['past_due', 'unpaid', 'paused']) {
      const h = harness();
      const { device, subscription } = await subscriber(h, { plan: 'monthly' });
      // The first renewal failed 5 days ago: past the 3-day grace, but Stripe is still retrying.
      h.stripe.updateSubscription(subscription.id, { status, periodStart: T0 + 7 * DAY, periodEnd: T0 + 37 * DAY });
      h.clock.set(T0 + 12 * DAY);
      const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
      assert.equal(res.status, 409, status);
      assert.equal(res.body.error.code, 'already_subscribed', status);
      assert.match(res.body.error.message, /link\.com/, status);
      assert.ok(res.body.error.portalUrl, status);
      assert.equal(creates(h), 1, `${status}: no second subscription`);
    }
  });

  test('review 2: a price change does not lock out subscribers still on the old price', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    // New prices for new buyers; this subscriber stays on the old yearly price.
    h.env.STRIPE_PRICE_MONTHLY = 'price_monthly_new2027';
    h.env.STRIPE_PRICE_YEARLY = 'price_yearly_new2027';
    // A year later the old-price subscription renews.
    h.stripe.updateSubscription(subscription.id, { status: 'active', periodStart: T0 + 365 * DAY, periodEnd: T0 + 730 * DAY });
    await h.deliver(stripeEvent('invoice.paid', { id: 'in_renew', customer: subscription.customer }));
    assert.equal(licenseRow(h).period_end, T0 + 730 * DAY, 'the renewal was recognised as ours');
    h.clock.set(T0 + 400 * DAY);
    assert.equal((await check(h, device, license)).status, 200);
  });

  test('review 3: radar.early_fraud_warning.created revokes and cancels, through the charge if needed', async () => {
    for (const viaCharge of [false, true]) {
      const h = harness();
      const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
      const { paymentIntent, charge } = h.stripe.addPaidInvoice(subscription.id);
      const warning = { id: 'issfr_1', object: 'radar.early_fraud_warning', charge, payment_intent: viaCharge ? null : paymentIntent, fraud_type: 'unauthorized_use_of_card' };
      const res = await h.deliver(stripeEvent('radar.early_fraud_warning.created', warning));
      assert.equal(res.body.action, 'revoked');
      assert.equal(licenseRow(h).revoked_reason, 'fraud');
      assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled', 'the stolen card is not charged again');
      assert.equal((await check(h, device, license)).status, 403);
    }
    // The owner's setup lists all 13 events, this one included.
    for (const text of [read('README.md'), read('scripts/deploy.sh')]) {
      assert.match(text, /radar\.early_fraud_warning\.created/);
      assert.match(text, /13 events/);
    }
    assert.match(read('migrations/0001_init.sql'), /'fraud'/);
  });

  test('review 4: a new browser with the same email gets no second free week', async () => {
    const h = harness();
    await websiteBuyer(h, { plan: 'monthly', email: 'Sam.Lee+grayout@gmail.com' });
    minutePasses(h);
    // A private window: a fresh device, a new Stripe customer, the same person.
    const second = await websiteBuyer(h, { plan: 'monthly', email: 'samlee@gmail.com' });
    assert.equal(second.checkout.body.trial, true, 'the new browser was offered a trial');
    const update = h.stripe.callsTo('subscriptions.update').at(-1);
    assert.deepEqual(update.args, [second.subscription.id, { trial_end: 'now' }]);
    const rows = h.db.rows('SELECT status, trial_denied FROM licenses ORDER BY id');
    assert.equal(rows[1].status, 'active', 'billed at once, not trialing');
    assert.equal(rows[1].trial_denied, 1);
    // Only keyed hashes are stored, never the email.
    const marks = h.db.rows('SELECT mark FROM trial_marks').map(r => r.mark).join(' ');
    assert.equal(/samlee|gmail/i.test(marks), false);
  });

  test('review 5: a gry_test_ key bought on the sandbox gets nothing once the key is live', async () => {
    const h = harness();
    const { device, license } = await subscriber(h, { plan: 'yearly' });
    assert.match(license, /^gry_test_/);
    assert.equal((await check(h, device, license)).status, 200);
    // Go-live on the same Worker by mistake: live key, no sandbox flag.
    h.env.STRIPE_SECRET_KEY = LIVE_KEY;
    delete h.env.ALLOW_TEST_LICENSES;
    h.clock.set(T0 + 200 * DAY);
    for (const path of ['/v1/check', '/v1/status', '/v1/activate']) {
      const body = path === '/v1/check' ? h.checkBody(device, { license }) : { ...device, license };
      const res = await h.call(path, body);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'license_invalid', path);
    }
    assert.deepEqual((await h.call('/v1/restore', device)).body, { status: 'none' });
    assert.equal(h.fetch.calls.length, 1, 'the model was only called before go-live');
    // The two Workers have separate databases in wrangler.jsonc.
    const config = parseJsonc(read('wrangler.jsonc'));
    assert.notEqual(config.d1_databases[0].database_name, config.env.sandbox.d1_databases[0].database_name);
    assert.equal(config.vars.ALLOW_TEST_LICENSES, undefined);
    assert.equal(config.env.sandbox.vars.ALLOW_TEST_LICENSES, '1');
  });

  test('review 6: two checkouts at once from one device cannot both get a trial, and the trial is claimed at creation', async () => {
    const h = harness();
    const device = await h.mint();
    const [a, b] = await Promise.all([
      h.call('/v1/checkout', { ...device, plan: 'monthly' }),
      h.call('/v1/checkout', { ...device, plan: 'monthly' })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429], 'one at a time per device');
    assert.equal(creates(h), 1);
    assert.notEqual(h.db.rows('SELECT trial_used_at FROM devices')[0].trial_used_at, null, 'claimed before payment');
    // A trial license serves at most TRIAL_CHECKS a month.
    const h2 = harness();
    const { device: mac, license } = await subscriber(h2);
    const id = licenseRow(h2).id;
    h2.db.write('INSERT INTO usage (license_id, month, n, last_at) VALUES (?, ?, ?, ?)', id, '2026-10', TRIAL_CHECKS, T0);
    const res = await check(h2, mac, license);
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'quota_exceeded');
  });

  test('review 7: one network cannot take more than its monthly free checks by minting devices', async () => {
    const h = harness({ env: { FREE_DAILY_BUDGET: '100000' } });
    const served = [];
    let last;
    for (let d = 0; d < 4; d++) {
      minutePasses(h);
      const device = await h.mint(); // every request from 203.0.113.7
      for (let i = 0; i < 100; i++) {
        if (i % 4 === 0) minutePasses(h);
        last = await check(h, device);
        if (last.status === 200) served.push(1);
      }
    }
    assert.equal(served.length, FREE_CHECKS_PER_NETWORK);
    assert.equal(last.body.error.code, 'free_exhausted');
    assert.equal(last.body.error.reason, 'device');
    assert.match(last.body.error.message, /network/);
    // Another network still gets its free checks: the global budget was not drained.
    minutePasses(h);
    const elsewhere = await h.mint('198.51.100.9');
    assert.equal((await h.call('/v1/check', h.checkBody(elsewhere), { ip: '198.51.100.9' })).status, 200);
    // IPv6: every /64 inside one /56 is the same network.
    const req = ip => new Request('https://x.test/', { headers: { 'CF-Connecting-IP': ip } });
    assert.equal(ipKeyFor(req('2001:db8:0:1::1'), 56), ipKeyFor(req('2001:db8:0:2::1'), 56));
  });

  test('review 8: billed model failures keep the free budget spent', async () => {
    const h = harness({
      env: { FREE_DAILY_BUDGET: '2' },
      responder: () => ({ json: responsesPayload(undefined, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) })
    });
    const results = [];
    for (let i = 0; i < 5; i++) {
      minutePasses(h);
      results.push((await check(h, await h.mint(`198.51.100.${i}`))).status);
    }
    assert.deepEqual(results, [502, 502, 402, 402, 402]);
    assert.equal(h.fetch.calls.length, 2, 'only two calls ever reached the provider');
    assert.equal(h.db.rows('SELECT n FROM free_budget')[0].n, 2);
  });

  test('review 9: two app checkouts in a row leave only one payable session', async () => {
    const h = harness();
    const device = await h.mint();
    const first = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    const second = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(second.status, 200);
    assert.equal(h.stripe.sessions.get(first.body.sessionId).status, 'expired', 'the older session was expired at Stripe');
    assert.equal(h.db.rows("SELECT COUNT(*) AS n FROM checkout_sessions WHERE state = 'open'")[0].n, 1);
    // The first one's trial claim came back when it was closed, so a later
    // monthly checkout still gets the trial.
    const third = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(third.body.trial, true);
    // A browser that bought on the site and comes back: 409 (also review 0).
    minutePasses(h);
    const { browser } = await websiteBuyer(h);
    assert.equal((await h.call('/v1/checkout', { ...browser, plan: 'monthly' })).status, 409);
  });

  test('review 10: a refund revokes access even when the Stripe cancel fails, and the retry cancels', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    const { paymentIntent, charge } = h.stripe.addPaidInvoice(subscription.id);
    const refunded = stripeEvent('charge.refunded', { id: charge, payment_intent: paymentIntent, refunded: true });
    h.stripe.failOn('subscriptions.cancel', { once: false, error: Object.assign(new Error('permission'), { type: 'StripePermissionError' }) });
    assert.equal((await h.deliver(refunded)).status, 500, 'Stripe will retry');
    assert.ok(licenseRow(h).revoked_at, 'revoked anyway');
    assert.equal((await check(h, device, license)).status, 403);
    h.stripe.failures.clear();
    assert.equal((await h.deliver(refunded)).body.action, 'revoked');
    assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled');
  });

  test('review 11: RL_LICENSE comes before the access decision, and /v1/status re-reads count RL_STRIPE_IP', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', h.stripe.subs.get(subscription.id)));
    h.clock.advance(20 * 60);
    const before = h.stripe.callsTo('subscriptions.list').length;
    h.limiters.RL_LICENSE.max = 0;
    assert.equal((await check(h, device, license)).status, 429);
    assert.equal(h.stripe.callsTo('subscriptions.list').length, before, 'refused before any Stripe read');
    // A stale /v1/status over the Stripe limit answers from the stored row.
    h.limiters.RL_LICENSE.max = 20;
    h.clock.advance(2 * DAY);
    h.limiters.RL_STRIPE_IP.max = 0;
    const status = await h.call('/v1/status', { ...device, license });
    assert.equal(status.status, 200);
    assert.equal(h.stripe.callsTo('subscriptions.list').length, before);
  });

  test('review 12: /v1/check spends a per-IP limit before it reads the body', async () => {
    const h = harness();
    h.limiters.RL_CHECK_IP.max = 2;
    const junk = '{' + 'x'.repeat(1024 * 1024);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await h.call('/v1/check', null, { raw: junk })).status);
    assert.deepEqual(statuses, [400, 400, 429], 'the third is refused without parsing');
    assert.deepEqual(h.limiters.RL_CHECK_IP.keys, ['203.0.113.7', '203.0.113.7', '203.0.113.7']);
    assert.ok(parseJsonc(read('wrangler.jsonc')).ratelimits.some(r => r.name === 'RL_CHECK_IP'));
  });

  test('review 13: a live Worker never sells or fulfils with test data', async () => {
    // A test key on a Worker without the sandbox flag sells nothing.
    const h = harness({ env: { ALLOW_TEST_LICENSES: undefined } });
    const device = await h.mint();
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' });
    assert.equal(res.status, 503);
    assert.equal(creates(h), 0);
    // A live Worker that somehow sees a test-mode session never issues a key for it.
    const live = harness({ env: { STRIPE_SECRET_KEY: LIVE_KEY, ALLOW_TEST_LICENSES: undefined } });
    live.stripe.livemode = false; // make the fake hand out test-mode sessions, as a mix-up would
    const browser = await live.mint();
    const checkout = await live.call('/v1/checkout', { ...browser, plan: 'yearly' });
    const { session } = live.stripe.completeSession(checkout.body.sessionId);
    assert.equal((await live.deliver(stripeEvent('checkout.session.completed', session))).body.action, 'ignored');
    assert.equal(live.db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 0);
    assert.equal((await live.call('/v1/claim', { sessionId: checkout.body.sessionId })).body.error.code, 'code_expired');
  });

  test('review 14: the same card with a different email gets no second trial either', async () => {
    const h = harness();
    await subscriber(h, { card: 'fp_same_card', email: 'one@example.test' });
    minutePasses(h);
    const second = await subscriber(h, { card: 'fp_same_card', email: 'two@example.test' });
    assert.equal(second.checkout.body.trial, true);
    assert.equal(licenseRow(h) && h.db.rows('SELECT status FROM licenses ORDER BY id')[1].status, 'active');
    // The first buyer's trial is untouched.
    assert.equal(h.db.rows('SELECT status FROM licenses ORDER BY id')[0].status, 'trialing');
    // If Stripe refuses to end the trial, the repeat still gets no service.
    const h2 = harness();
    await subscriber(h2, { email: 'same@example.test' });
    minutePasses(h2);
    h2.stripe.failOn('subscriptions.update');
    const repeat = await subscriber(h2, { email: 'same@example.test' });
    assert.equal(h2.db.rows('SELECT status FROM licenses ORDER BY id')[1].status, 'trialing');
    const res = await check(h2, repeat.device, repeat.license);
    assert.equal(res.status, 402);
    assert.match(res.body.error.message, /already had a Grayout free trial/);
  });

  test('review 15: a past_due customer inside Smart Retries never reaches checkout.sessions.create', async () => {
    const h = harness();
    const { device, subscription } = await subscriber(h, { plan: 'yearly' });
    h.stripe.updateSubscription(subscription.id, { status: 'past_due', periodStart: T0 + 365 * DAY, periodEnd: T0 + 730 * DAY });
    h.clock.set(T0 + 370 * DAY);
    // The stored row and the access decision both say "no service"...
    assert.equal((await check(h, device, (await h.call('/v1/restore', device)).body.license)).status, 402);
    // ...but checkout still refuses, because Stripe may yet collect the old invoice.
    const res = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(res.body.error.code, 'already_subscribed');
    assert.equal(h.stripe.callsTo('checkout.sessions.create').some(c => c.args[0].customer === subscription.customer), false);
    // Once Stripe has canceled it, buying again as the same customer is fine.
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    const rebuy = await h.call('/v1/checkout', { ...device, plan: 'yearly' });
    assert.equal(rebuy.status, 200);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').at(-1).args[0].customer, subscription.customer);
  });

  test('review 16: a refusal from the model consumes the free check (only unbilled failures are given back)', async () => {
    const refusal = { json: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } };
    const h = harness({ responder: () => refusal });
    const device = await h.mint();
    assert.equal((await check(h, device)).status, 502);
    assert.equal(h.db.rows('SELECT free_used FROM devices')[0].free_used, 1);
    // A provider error status was never billed: given back.
    const h2 = harness({ responder: () => ({ status: 500, text: 'oops' }) });
    const device2 = await h2.mint();
    assert.equal((await check(h2, device2)).status, 502);
    assert.equal(h2.db.rows('SELECT free_used FROM devices')[0].free_used, 0);
    assert.equal(h2.db.rows('SELECT COALESCE(SUM(n), 0) AS n FROM free_budget')[0].n, 0);
    // The contract says so.
    const contract = readFileSync(join(REPO, 'docs/API-CONTRACT.md'), 'utf8');
    assert.equal(contract.includes('The model provider failed; nothing was counted'), false);
  });

  test('review 17: a failing Stripe re-read is tried at most once per 15 minutes', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h, { plan: 'yearly' });
    h.stripe.updateSubscription(subscription.id, { status: 'canceled' });
    await h.deliver(stripeEvent('customer.subscription.deleted', h.stripe.subs.get(subscription.id)));
    h.stripe.failOn('subscriptions.list', { once: false });
    h.clock.advance(16 * 60);
    const before = h.stripe.callsTo('subscriptions.list').length;
    for (let i = 0; i < 10; i++) {
      assert.equal((await check(h, device, license)).status, 402);
      h.clock.advance(30);
    }
    assert.equal(h.stripe.callsTo('subscriptions.list').length - before, 1, 'one read in 5 minutes, though it failed');
    h.clock.advance(15 * 60);
    await check(h, device, license);
    assert.equal(h.stripe.callsTo('subscriptions.list').length - before, 2);
  });

  test('review 18: the site CSP is checked against the API address, and deploy.sh stops on a page that would block it', () => {
    // Today's pages allow any workers.dev address, success.html included.
    assert.deepEqual(cspProblems(join(REPO, 'docs'), 'https://grayout-api.someone.workers.dev'), []);
    // A page that still names api.grayout.app, or an unfilled placeholder, is caught.
    const dir = mkdtempSync(join(tmpdir(), 'grayout-csp-'));
    const page = src => `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${src}"><script src="config.js"></script>`;
    writeFileSync(join(dir, 'success.html'), page('https://api.grayout.app'));
    writeFileSync(join(dir, 'pricing.html'), page('__GRAYOUT_API_BASE__'));
    writeFileSync(join(dir, 'account.html'), page('https://grayout-api.someone.workers.dev'));
    const problems = cspProblems(dir, 'https://grayout-api.someone.workers.dev');
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /success\.html: .*grayout\.app/);
    assert.match(problems.join('\n'), /pricing\.html: .*placeholder/);
    // deploy.sh runs the check for live and stops on a problem.
    const script = read('scripts/deploy.sh');
    assert.match(script, /check-csp\.js/);
    assert.match(script, /STOP: the site pages above would block the API/);
    const out = execFileSync('bash', [join(SERVER, 'scripts/deploy.sh'), 'live'], { env: { ...process.env, DRY_RUN: '1' }, encoding: 'utf8' });
    assert.match(out, /every page that calls the API allows it/);
  });
});
