// Regression tests for the third pass over the 2026-10-08 review: 8 confirmed
// server findings (two of them the same bug), contract Appendix B, B18 to B24.
// Each test reproduces the failure the review found and checks it is gone.
//
//  #  finding                                                          test
//  1  the runbook's "delete a customer" SQL failed on a foreign key     B18 (below)
//  2  an abandoned trial checkout lost the trial once cleanup ran       B19 (below)
//  3  a malformed base64 image (length 1 mod 4) answered 500            B20 (below)
//  4  the webhook-secret check refused ~1 in 1,000 real secrets (xxx)   B21 (below), config.test.js
//  5  a trial whose first charge failed (and a repeat trial) got 3      B22 (below), access.test.js,
//     days of full paid service                                         findings.test.js finding 29
//  6  a pasted, ended key hid the device's own live subscription, so   B23 (below)
//     a subscriber could buy a second one
//  7  no per-device cap on device codes (one device, many /64s)         B24 (below)
//  8  the same bug as 3, before the device is verified                  B20 (below)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { harness, stripeEvent, SCREENSHOT, PRICES, T0, DAY } from './helpers.js';
import { runCleanup } from '../src/cleanup.js';
import { insertCheckoutSession } from '../src/db.js';
import { webhookSecretOk, MAX_LIVE_DEVICE_CODES } from '../src/config.js';
import { deleteCustomerCommand, deleteCustomerSql, deleteCustomerStatements } from '../scripts/delete-customer.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SERVER, '..');

/** Capture every console line written while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const { log, error, warn } = console;
  console.log = console.error = console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, { log, error, warn });
  }
  return lines.join('\n');
}

/** A Mac (on its own address) that bought from the app and claimed its key. */
async function subscriber(h, { plan = 'monthly', ip, email, card } = {}) {
  const device = await h.mint(ip);
  const purchase = await h.appPurchase(device, { plan, email, card });
  const claim = await h.call('/v1/claim', { ...device, deviceCode: purchase.code }, { ip });
  assert.equal(claim.body.status, 'ready');
  return { device, license: claim.body.license, ...purchase };
}

const licenseRow = (h, customerId) => h.db.rows('SELECT * FROM licenses WHERE customer_id = ?', customerId)[0];
const deviceRow = (h, device) => h.db.rows('SELECT * FROM devices WHERE device_id = ?', device.deviceId)[0];

describe('third pass over the 2026-10-08 review', () => {
  // ------------------------------------------------------------ B18
  test('B18: the delete-customer script runs after a real purchase, removes only that customer, and can run twice', async () => {
    const h = harness();
    // Customer A: a trial from the app (trial marks), fulfilled by the webhook, with one paid check (usage).
    const a = await subscriber(h, { ip: '198.51.100.1' });
    await h.deliver(stripeEvent('checkout.session.completed', a.session));
    assert.equal((await h.call('/v1/check', h.checkBody(a.device, { license: a.license }), { ip: '198.51.100.1' })).status, 200);
    // Customer B: must be left alone.
    const b = await subscriber(h, { plan: 'yearly', ip: '198.51.100.2' });
    const customerA = a.subscription.customer;
    const idA = licenseRow(h, customerA).id;
    assert.equal(deviceRow(h, a.device).bought_license_id, idA, 'the purchase set bought_license_id (the column the old SQL missed)');
    assert.ok(h.db.rows('SELECT * FROM trial_marks WHERE customer_id = ?', customerA).length > 0);
    assert.ok(h.db.rows('SELECT * FROM usage WHERE license_id = ?', idA).length > 0);

    // Run it the way wrangler's --command does: statement after statement,
    // with foreign keys on (the shim enforces them, like D1).
    await h.db.exec(deleteCustomerSql(customerA));
    assert.equal(licenseRow(h, customerA), undefined);
    assert.equal(h.db.rows('SELECT * FROM devices WHERE license_id = ? OR bought_license_id = ?', idA, idA).length, 0);
    assert.equal(h.db.rows('SELECT * FROM checkout_sessions WHERE license_id = ?', idA).length, 0);
    assert.equal(h.db.rows('SELECT * FROM usage WHERE license_id = ?', idA).length, 0);
    assert.equal(h.db.rows('SELECT * FROM trial_marks WHERE customer_id = ?', customerA).length, 0);
    // Customer B is untouched.
    const idB = licenseRow(h, b.subscription.customer).id;
    assert.equal(deviceRow(h, b.device).license_id, idB);
    assert.equal(deviceRow(h, b.device).bought_license_id, idB);
    // Safe to run again (if it stopped half-way, running it again finishes the job).
    await h.db.exec(deleteCustomerSql(customerA));
  });

  test('B18: the script covers every column that points at licenses or holds a customer id, so a schema change cannot break it silently', () => {
    const h = harness();
    const sql = deleteCustomerStatements('cus_test123').join('\n');
    const tables = h.db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map(r => r.name);
    for (const table of tables) {
      for (const fk of h.db.rows(`PRAGMA foreign_key_list(${table})`)) {
        if (fk.table !== 'licenses') continue;
        const handled = sql.includes(`UPDATE ${table} SET ${fk.from} = NULL WHERE ${fk.from} IN`)
          || sql.includes(`DELETE FROM ${table} WHERE ${fk.from} IN`);
        assert.ok(handled, `${table}.${fk.from} points at licenses: scripts/delete-customer.js must clear it`);
      }
      const columns = h.db.rows(`PRAGMA table_info(${table})`).map(c => c.name);
      if (columns.includes('customer_id')) {
        assert.ok(sql.includes(`DELETE FROM ${table} WHERE customer_id = 'cus_test123'`), `${table} holds customer ids`);
      }
    }
    // The license itself goes last, after everything that points at it.
    assert.match(deleteCustomerStatements('cus_test123').at(-1), /^DELETE FROM licenses /);
  });

  test('B18: only a real customer id gets into the SQL, and the command line works from a terminal', () => {
    for (const bad of ["cus_1'; DROP TABLE licenses; --", 'cus_', 'sub_123', '', undefined, 'cus_a b']) {
      assert.throws(() => deleteCustomerSql(bad), /not a Stripe customer id/, String(bad));
    }
    assert.match(deleteCustomerCommand('cus_abc123'), /^npx wrangler d1 execute grayout --remote --command "UPDATE devices/);
    assert.match(deleteCustomerCommand('cus_abc123', { sandbox: true }), /^npx wrangler d1 execute grayout-sandbox --remote --env sandbox --command /);

    const run = args => spawnSync(process.execPath, [join(SERVER, 'scripts/delete-customer.js'), ...args], { encoding: 'utf8', stdin: 'ignore' });
    const ok = run(['cus_abc123']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), deleteCustomerCommand('cus_abc123'));
    const refused = run(["cus_1'--"]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '', 'nothing to paste when the id is wrong');

    // The runbook points at the script instead of the old inline SQL.
    const contract = readFileSync(join(REPO, 'docs/API-CONTRACT.md'), 'utf8');
    const runbook = contract.slice(contract.indexOf('### 14.6'), contract.indexOf('## 15.'));
    assert.ok(runbook.includes('scripts/delete-customer.js'));
    assert.equal(runbook.includes('DELETE FROM licenses'), false);
  });

  // ------------------------------------------------------------ B19
  test('B19: a trial checkout abandoned for more than 30 days hands the trial back before cleanup deletes its row', async () => {
    const h = harness();
    const browser = await h.mint();
    const first = await h.call('/v1/checkout', { ...browser, plan: 'monthly' });
    assert.equal(first.body.trial, true);
    // The buyer closed the Stripe tab; the session expired at Stripe. Nobody came back for a month.
    h.stripe.expireSession(first.body.sessionId);
    h.clock.advance(31 * DAY);
    await captureLogs(() => runCleanup(h.env, h.clock.now()));
    assert.equal(h.db.rows('SELECT * FROM checkout_sessions').length, 0, 'the old row is gone');
    assert.equal(deviceRow(h, browser).trial_used_at, null, 'and its trial claim was handed back first');

    const again = await h.call('/v1/checkout', { ...browser, plan: 'monthly' });
    assert.equal(again.status, 200);
    assert.equal(again.body.trial, true, 'the 7-day trial is offered again');
  });

  test('B19: cleanup never hands back a trial that was used, or one a newer checkout holds', async () => {
    const h = harness();
    // A device whose trial was paid for (a real trial subscription).
    const buyer = await subscriber(h, { ip: '198.51.100.3' });
    const usedAt = deviceRow(h, buyer.device).trial_used_at;
    // A device with an old abandoned trial checkout AND a newer open one (its claim is the newer one's).
    const browser = await h.mint('198.51.100.4');
    const old = await h.call('/v1/checkout', { ...browser, plan: 'monthly' }, { ip: '198.51.100.4' });
    assert.equal(old.body.trial, true);
    h.clock.advance(20 * DAY);
    const newer = await h.call('/v1/checkout', { ...browser, plan: 'monthly' }, { ip: '198.51.100.4' });
    assert.equal(newer.body.trial, true, 'closing the old one gave the claim back, and the new one took it');
    const claimedAt = deviceRow(h, browser).trial_used_at;
    h.clock.advance(11 * DAY);
    await captureLogs(() => runCleanup(h.env, h.clock.now()));
    assert.equal(deviceRow(h, buyer.device).trial_used_at, usedAt, 'a used trial stays used');
    assert.equal(deviceRow(h, browser).trial_used_at, claimedAt, 'the newer checkout still holds its claim');
  });

  test('B19: a claim that finds the session expired at Stripe hands the trial back at once', async () => {
    const h = harness();
    const mac = await h.mint();
    const code = await h.call('/v1/device-code', mac);
    const checkout = await h.call('/v1/checkout', { ...mac, plan: 'monthly', deviceCode: code.body.deviceCode });
    assert.equal(checkout.body.trial, true);
    h.stripe.expireSession(checkout.body.sessionId);
    const claim = await h.call('/v1/claim', { ...mac, deviceCode: code.body.deviceCode });
    assert.deepEqual(claim.body, { status: 'failed', reason: 'expired' });
    // The row is now 'expired', so closeOlderSessions will never see it; the claim gave the trial back.
    assert.equal(deviceRow(h, mac).trial_used_at, null);
    const again = await h.call('/v1/checkout', { ...mac, plan: 'monthly' });
    assert.equal(again.body.trial, true);
  });

  // ------------------------------------------------------------ B20
  test('B20: a malformed base64 image is 400 bad_request, never 500, with or without a verified device', async () => {
    const h = harness();
    const mac = await h.mint();
    // SCREENSHOT is whole groups of 4; one more character makes its length 1 more than a multiple of 4.
    assert.equal(SCREENSHOT.length % 4, 0);
    const bad = [
      'QQQQQ',               // the review's example: length 1 mod 4
      SCREENSHOT + 'A',      // a real JPEG plus one character
      'QUJD=',               // "=" padding on an incomplete group
      SCREENSHOT.slice(0, -2) + '='
    ];
    const logs = await captureLogs(async () => {
      for (const image of bad) {
        assert.equal(image.length % 4 === 0, false);
        for (const body of [h.checkBody(mac, { displays: [image] }), h.checkBody(mac, { webcam: image }), { displays: [image] }]) {
          const res = await h.call('/v1/check', body);
          assert.equal(res.status, 400, `${image.slice(0, 12)}…`);
          assert.equal(res.body.error.code, 'bad_request');
        }
      }
    });
    assert.equal(logs.includes('internal_error'), false, 'nothing reaches the error log');
    assert.equal(h.fetch.calls.length, 0, 'the model is never asked');

    // Valid base64 without its "=" padding is still a picture the service can read.
    assert.ok(SCREENSHOT.endsWith('='));
    const unpadded = SCREENSHOT.replace(/=+$/, '');
    assert.equal((await h.call('/v1/check', h.checkBody(mac, { displays: [unpadded] }))).status, 200);
  });

  // ------------------------------------------------------------ B21
  test('B21: real webhook secrets that happen to contain xxx are accepted, and the webhook works with one', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomSecret = () => 'whsec_' + [...randomBytes(32)].map(b => alphabet[b % alphabet.length]).join('');
    // Twenty thousand random secrets shaped like the Dashboard's: none refused
    // (the old substring rule refused about twenty of them).
    for (let i = 0; i < 20000; i++) {
      const secret = randomSecret();
      assert.equal(webhookSecretOk(secret), true, `a real-shaped secret was refused (${secret.slice(0, 6)}…)`);
    }
    for (const lucky of ['whsec_a1B2xxx3c4D5e6F7g8H9i0J1k2L3m4N5', 'whsec_XxXa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5', 'whsec_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5XXX']) {
      assert.equal(webhookSecretOk(lucky), true, lucky);
    }
    // Placeholders are still refused.
    for (const placeholder of ['whsec_placeholder', 'whsec_' + 'x'.repeat(32), 'whsec_XXX_paste_the_secret_here_0123456789', 'whsec_' + 'a'.repeat(40)]) {
      assert.equal(webhookSecretOk(placeholder), false, placeholder);
    }

    const h = harness({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_a1B2xxx3c4D5e6F7g8H9i0J1k2L3m4N5' } });
    const health = await h.call('/v1/health', undefined, { method: 'GET' });
    assert.equal(health.body.configured.webhook, true);
    const res = await h.deliver(stripeEvent('invoice.paid', { id: 'in_1', customer: 'cus_nobody' }));
    assert.equal(res.status, 200, 'not 503 not_configured');
  });

  // ------------------------------------------------------------ B22
  test('B22: a trial whose first charge fails gets no grace and never the paid allowance', async () => {
    const h = harness();
    const { device, license, subscription } = await subscriber(h);
    // The trial ends at T0+7d, its first charge declines, Stripe says past_due
    // with the unpaid period starting where the trial ended.
    h.clock.set(T0 + 7 * DAY + 60);
    h.stripe.updateSubscription(subscription.id, { status: 'past_due', periodStart: T0 + 7 * DAY, periodEnd: T0 + 37 * DAY });
    await h.deliver(stripeEvent('invoice.payment_failed', { id: 'in_1', customer: subscription.customer }));
    assert.equal(licenseRow(h, subscription.customer).status, 'past_due');

    const res = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(res.status, 402, 'no 3 days of service for a subscription that never paid');
    assert.equal(res.body.error.code, 'subscription_inactive');
    const status = await h.call('/v1/status', { ...device, license });
    assert.equal(status.body.service, false);
    assert.equal(status.body.usage.checksIncluded, 1000, 'never shown the paid 10,000');

    // Smart Retries collect the payment: service comes back, with the paid allowance.
    h.stripe.updateSubscription(subscription.id, { status: 'active' });
    await h.deliver(stripeEvent('invoice.paid', { id: 'in_1', customer: subscription.customer }));
    const paid = await h.call('/v1/check', h.checkBody(device, { license }));
    assert.equal(paid.status, 200);
    assert.equal(paid.body.usage.checksIncluded, 10000);
  });

  test('B22: a repeat trial whose immediate charge declines gets no service at all', async () => {
    const h = harness();
    await subscriber(h, { ip: '198.51.100.5', email: 'same@example.test', card: 'fp_same' });
    // Stripe ends the repeat trial at once and charges; the card declines, so
    // the subscription is past_due from that moment instead of active.
    h.stripe.updateFromApi = function (id, params) {
      const sub = this.getOr404(this.subs, id);
      if (params.trial_end === 'now') {
        const now = this.now();
        sub.status = 'past_due';
        sub.trial_end = now;
        sub.items.data[0].current_period_start = now;
        sub.items.data[0].current_period_end = now + 30 * DAY;
      }
      return sub;
    };
    const repeat = await subscriber(h, { ip: '198.51.100.6', email: 'same@example.test', card: 'fp_same' });
    const row = licenseRow(h, repeat.subscription.customer);
    assert.equal(row.trial_denied, 1);
    assert.equal(row.status, 'past_due');

    const res = await h.call('/v1/check', h.checkBody(repeat.device, { license: repeat.license }), { ip: '198.51.100.6' });
    assert.equal(res.status, 402, 'not 3 days of 10,000 free checks');
    assert.match(res.body.error.message, /already had a Grayout free trial/);
  });

  // ------------------------------------------------------------ B23
  test('B23: a subscriber who pastes in an ended key still gets 409, never a second subscription', async () => {
    const h = harness();
    const mine = await subscriber(h, { plan: 'yearly', ip: '198.51.100.10' });
    // Someone else's key whose subscription has ended (or an old one of their own).
    const other = await subscriber(h, { plan: 'yearly', ip: '198.51.100.11' });
    h.stripe.updateSubscription(other.subscription.id, { status: 'canceled' });
    const activate = await h.call('/v1/activate', { ...mine.device, license: other.license }, { ip: '198.51.100.10' });
    assert.equal(activate.status, 200);
    assert.equal(deviceRow(h, mine.device).license_id, licenseRow(h, other.subscription.customer).id, 'the device now USES the other key');

    const sessionsBefore = h.stripe.callsTo('checkout.sessions.create').length;
    const res = await h.call('/v1/checkout', { ...mine.device, plan: 'monthly' }, { ip: '198.51.100.10' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'already_subscribed');
    assert.equal(res.body.error.portalUrl, `https://billing.stripe.com/p/session/test_${mine.subscription.customer}`, 'the portal of the subscription it bought');
    assert.equal(h.stripe.callsTo('checkout.sessions.create').length, sessionsBefore, 'no checkout was opened');
  });

  test('B23: buying again reuses only the customer this device bought as, never one from a pasted key', async () => {
    const h = harness();
    const mine = await subscriber(h, { plan: 'yearly', ip: '198.51.100.12' });
    const other = await subscriber(h, { plan: 'yearly', ip: '198.51.100.13' });
    h.stripe.updateSubscription(mine.subscription.id, { status: 'canceled' });
    h.stripe.updateSubscription(other.subscription.id, { status: 'canceled' });
    await h.call('/v1/activate', { ...mine.device, license: other.license }, { ip: '198.51.100.12' });
    const res = await h.call('/v1/checkout', { ...mine.device, plan: 'yearly' }, { ip: '198.51.100.12' });
    assert.equal(res.status, 200);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').at(-1).args[0].customer, mine.subscription.customer);

    // A Mac that only ever pasted in someone's ended key buys as a NEW customer.
    const borrower = await h.mint('198.51.100.14');
    await h.call('/v1/activate', { ...borrower, license: other.license }, { ip: '198.51.100.14' });
    const fresh = await h.call('/v1/checkout', { ...borrower, plan: 'monthly' }, { ip: '198.51.100.14' });
    assert.equal(fresh.status, 200);
    assert.equal(h.stripe.callsTo('checkout.sessions.create').at(-1).args[0].customer, undefined, 'not the key owner\'s customer');
    assert.equal(fresh.body.trial, false, 'holding a key already counted as this device\'s trial');
  });

  test('B23: at fulfilment, a paid session on another customer is undone when the device BOUGHT a live subscription', async () => {
    const h = harness();
    const mine = await subscriber(h, { plan: 'yearly', ip: '198.51.100.15' });
    const other = await subscriber(h, { plan: 'yearly', ip: '198.51.100.16' });
    h.stripe.updateSubscription(other.subscription.id, { status: 'canceled' });
    await h.call('/v1/activate', { ...mine.device, license: other.license }, { ip: '198.51.100.15' });
    // A session opened on the pasted key's customer before any guard could stop it.
    const now = h.clock.now();
    const stray = h.stripe.createSession({
      mode: 'subscription', line_items: [{ price: PRICES.monthly, quantity: 1 }], customer: other.subscription.customer, expires_at: now + 3600
    });
    await insertCheckoutSession(h.db, {
      sessionId: stray.id, deviceId: mine.device.deviceId, deviceCode: null, plan: 'monthly', trial: false, livemode: false, now, expiresAt: now + 3600
    });
    const { session, subscription } = h.stripe.completeSession(stray.id);
    const res = await captureLogs(() => h.deliver(stripeEvent('checkout.session.completed', session)));
    assert.match(res, /duplicate_purchase/);
    assert.equal(h.stripe.subs.get(subscription.id).status, 'canceled', 'the second subscription is canceled');
    assert.equal(h.stripe.refundList.length, 1, 'and refunded');
    assert.equal(h.stripe.subs.get(mine.subscription.id).status, 'active', 'the one the device bought is untouched');
  });

  // ------------------------------------------------------------ B24
  test('B24: one device gets at most 5 live device codes, however many IPv6 /64s it uses', async () => {
    const h = harness();
    const mac = await h.mint();
    let stored = 0;
    let refused = null;
    for (let i = 0; i < 40; i++) {
      const res = await h.call('/v1/device-code', mac, { ip: `2001:db8:0:${i.toString(16)}::1` });
      if (res.status === 200) stored += 1;
      else refused = res;
    }
    assert.equal(stored, MAX_LIVE_DEVICE_CODES);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM device_codes')[0].n, MAX_LIVE_DEVICE_CODES);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'rate_limited');
    assert.equal(refused.body.error.retryAfter, 3600, 'until the oldest code expires');
    assert.ok(h.limiters.RL_DEVICE.keys.includes(`dev:${mac.deviceId}`), 'RL_DEVICE counts device codes too');

    // An hour later the old codes have expired and a new one is given.
    h.clock.advance(3601);
    h.limiters.RL_DEVICE.reset();
    assert.equal((await h.call('/v1/device-code', mac)).status, 200);
  });

  test('B24: /v1/checkout spends RL_DEVICE and checks the plan before it writes the checkout lock', async () => {
    const h = harness();
    const mac = await h.mint();
    const statements = [];
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = sql => { statements.push(sql); return prepare(sql); };

    const badPlan = await h.call('/v1/checkout', { ...mac, plan: 'weekly' });
    assert.equal(badPlan.status, 400);
    h.limiters.RL_DEVICE.max = 0;
    const limited = await h.call('/v1/checkout', { ...mac, plan: 'monthly' });
    assert.equal(limited.status, 429);
    assert.equal(statements.some(sql => sql.includes('checkout_lock_at')), false, 'no lock was written for either');
    assert.ok(h.limiters.RL_DEVICE.keys.includes(`dev:${mac.deviceId}`));
  });
});
