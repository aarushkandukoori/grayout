import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { D1Shim } from './d1.js';
import {
  cleanup, closeSession, eventSeen, insertCheckoutSession, insertDevice, insertDeviceCode, issueLicense,
  markSessionPaid, recordEvent, recordTrialMarks, releaseFreeBudget, reserveFreeNetwork, releaseFreeCheck, releasePaidCheck, reserveFreeBudget,
  reserveFreeCheck, reservePaidCheck, revokeBySubscription, getCheckoutSession, getUsage
} from '../src/db.js';

const NOW = 1_800_000_000;

async function device(db, id = 'dev_A', now = NOW, ipHash = 'net1') {
  await insertDevice(db, { deviceId: id, now, ipHash, maxPerHour: 10 });
  return id;
}

describe('the schema', () => {
  test('foreign keys are on: a device code for an unknown device is refused', async () => {
    const db = new D1Shim();
    await assert.rejects(insertDeviceCode(db, { code: 'ABCD1234', deviceId: 'dev_nobody', now: NOW, expiresAt: NOW + 60 }));
  });

  test('one license per customer, and no key column at all', async () => {
    const db = new D1Shim();
    const cols = db.rows('PRAGMA table_info(licenses)').map(c => c.name);
    assert.ok(cols.includes('key_hash'));
    assert.equal(cols.some(c => c === 'key' || c === 'license_key'), false);
    db.write("INSERT INTO licenses (key_hash, livemode, customer_id, synced_at, created_at) VALUES ('h1', 0, 'cus_1', 0, 0)");
    assert.throws(() => db.write("INSERT INTO licenses (key_hash, livemode, customer_id, synced_at, created_at) VALUES ('h2', 0, 'cus_1', 0, 0)"));
  });
});

describe('minting is limited per network per rolling hour', () => {
  test('10 devices an hour from one network, then refused; another network is unaffected; an hour later it works', async () => {
    const db = new D1Shim();
    for (let i = 0; i < 10; i++) assert.equal(await insertDevice(db, { deviceId: `dev_${i}`, now: NOW, ipHash: 'net1', maxPerHour: 10 }), true);
    assert.equal(await insertDevice(db, { deviceId: 'dev_x', now: NOW, ipHash: 'net1', maxPerHour: 10 }), false);
    assert.equal(await insertDevice(db, { deviceId: 'dev_y', now: NOW, ipHash: 'net2', maxPerHour: 10 }), true);
    assert.equal(await insertDevice(db, { deviceId: 'dev_z', now: NOW + 3600, ipHash: 'net1', maxPerHour: 10 }), true);
  });

  test('simultaneous mints cannot slip past the limit', async () => {
    const db = new D1Shim();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      insertDevice(db, { deviceId: `dev_${i}`, now: NOW, ipHash: 'net1', maxPerHour: 10 })));
    assert.equal(results.filter(Boolean).length, 10);
  });
});

describe('free checks', () => {
  test('a device gets exactly 100, even when 150 ask at once', async () => {
    const db = new D1Shim();
    await device(db);
    const results = await Promise.all(Array.from({ length: 150 }, () => reserveFreeCheck(db, { deviceId: 'dev_A', now: NOW, limit: 100 })));
    assert.equal(results.filter(r => r !== null).length, 100);
    assert.equal(db.rows('SELECT free_used FROM devices')[0].free_used, 100);
    await releaseFreeCheck(db, 'dev_A');
    assert.equal(await reserveFreeCheck(db, { deviceId: 'dev_A', now: NOW, limit: 100 }), 100);
  });

  test('the daily budget is exact, per day, and 0 means none', async () => {
    const db = new D1Shim();
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveFreeBudget(db, { day: '2026-10-08', budget: 5 })));
    assert.equal(results.filter(r => r !== null).length, 5);
    assert.equal(await reserveFreeBudget(db, { day: '2026-10-09', budget: 5 }), 1);
    await releaseFreeBudget(db, '2026-10-08');
    assert.equal(await reserveFreeBudget(db, { day: '2026-10-08', budget: 5 }), 5);
    assert.equal(await reserveFreeBudget(db, { day: '2026-10-10', budget: 0 }), null);
  });
});

describe('paid checks', () => {
  function licensed(db, id = 1, customer = 'cus_1') {
    db.write("INSERT INTO licenses (id, key_hash, livemode, customer_id, synced_at, created_at) VALUES (?, ?, 0, ?, 0, 0)", id, `h${id}`, customer);
    return id;
  }

  test('inside the allowance every check counts; past it, one per 10 minutes after the last one', async () => {
    const db = new D1Shim();
    const licenseId = licensed(db);
    const args = { licenseId, month: '2026-10', included: 3, slowInterval: 600 };
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW }), 1);
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 1 }), 2);
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 2 }), 3);
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 3 }), null, 'over the allowance and inside the slow interval');
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 601 }), null);
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 602 }), 4, '10 minutes after the last served check');
    assert.equal(await reservePaidCheck(db, { ...args, now: NOW + 603 }), null);
    assert.equal(await reservePaidCheck(db, { ...args, month: '2026-11', now: NOW + 604 }), 1, 'a new month starts at 1');
    await releasePaidCheck(db, { licenseId, month: '2026-11' });
    assert.deepEqual(await getUsage(db, { licenseId, month: '2026-11' }), { n: 0, last_at: NOW + 604 });
    assert.deepEqual(await getUsage(db, { licenseId, month: '2027-01' }), { n: 0, last_at: 0 });
  });

  test('simultaneous checks at the edge of the allowance: exactly one gets through', async () => {
    const db = new D1Shim();
    const licenseId = licensed(db);
    db.write("INSERT INTO usage (license_id, month, n, last_at) VALUES (1, '2026-10', 2, ?)", NOW);
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      reservePaidCheck(db, { licenseId, month: '2026-10', now: NOW + 1, included: 3, slowInterval: 600 })));
    assert.deepEqual(results.filter(r => r !== null), [3]);
  });
});

describe('issuing a license', () => {
  test('two simultaneous issues for one customer make one row and read back the same one', async () => {
    const db = new D1Shim();
    const [a, b] = await Promise.all([
      issueLicense(db, { keyHash: 'hash_c1', livemode: false, customerId: 'cus_1', now: NOW }),
      issueLicense(db, { keyHash: 'hash_c1', livemode: false, customerId: 'cus_1', now: NOW })
    ]);
    assert.equal(a.id, b.id);
    assert.equal(db.rows('SELECT COUNT(*) AS n FROM licenses')[0].n, 1);
    assert.equal(a.synced_at, 0, 'never synced yet');
    assert.equal(a.status, 'incomplete', 'grants nothing until Stripe is read');
  });

  test('revocation is sticky: the first time and reason are kept', async () => {
    const db = new D1Shim();
    db.write("INSERT INTO licenses (key_hash, livemode, customer_id, subscription_id, synced_at, created_at) VALUES ('h', 0, 'cus_1', 'sub_1', 0, 0)");
    assert.ok(await revokeBySubscription(db, { subscriptionId: 'sub_1', reason: 'refund', now: NOW }));
    await revokeBySubscription(db, { subscriptionId: 'sub_1', reason: 'dispute', now: NOW + 5 });
    assert.deepEqual(db.rows('SELECT revoked_at, revoked_reason FROM licenses')[0], { revoked_at: NOW, revoked_reason: 'refund' });
    assert.equal(await revokeBySubscription(db, { subscriptionId: 'sub_other', reason: 'refund', now: NOW }), null);
  });
});

describe('checkout sessions and events', () => {
  test('a paid session is never turned back into a failure', async () => {
    const db = new D1Shim();
    await device(db);
    await insertCheckoutSession(db, { sessionId: 'cs_test_1', deviceId: 'dev_A', deviceCode: null, plan: 'monthly', trial: true, livemode: false, now: NOW, expiresAt: NOW + 3600 });
    db.write("INSERT INTO licenses (id, key_hash, livemode, customer_id, synced_at, created_at) VALUES (1, 'h', 0, 'cus_1', 0, 0)");
    await markSessionPaid(db, { sessionId: 'cs_test_1', licenseId: 1 });
    await closeSession(db, { sessionId: 'cs_test_1', state: 'failed' });
    assert.equal((await getCheckoutSession(db, 'cs_test_1')).state, 'paid');
  });

  test('event ids are remembered once', async () => {
    const db = new D1Shim();
    assert.equal(await eventSeen(db, 'evt_1'), false);
    await recordEvent(db, { eventId: 'evt_1', type: 'invoice.paid', now: NOW });
    await recordEvent(db, { eventId: 'evt_1', type: 'invoice.paid', now: NOW });
    assert.equal(await eventSeen(db, 'evt_1'), true);
  });
});

describe('daily cleanup', () => {
  test('deletes what has outlived its use and keeps the rest', async () => {
    const db = new D1Shim();
    await device(db, 'dev_old', NOW - 3 * 86400, 'net1');
    await device(db, 'dev_new', NOW, 'net1');
    await insertDeviceCode(db, { code: 'OLDC0DE1', deviceId: 'dev_old', now: NOW - 3 * 86400, expiresAt: NOW - 2 * 86400 });
    await insertDeviceCode(db, { code: 'NEWC0DE1', deviceId: 'dev_new', now: NOW, expiresAt: NOW + 3600 });
    await recordEvent(db, { eventId: 'evt_old', type: 't', now: NOW - 31 * 86400 });
    await recordEvent(db, { eventId: 'evt_new', type: 't', now: NOW });
    await reserveFreeBudget(db, { day: '2026-01-01', budget: 5 });
    await reserveFreeNetwork(db, { netHash: 'net1', month: '2026-09', cap: 300 });
    await reserveFreeNetwork(db, { netHash: 'net1', month: '2026-10', cap: 300 });
    await recordTrialMarks(db, { marks: ['email:old'], customerId: 'cus_old', now: NOW - 366 * 86400 });
    await recordTrialMarks(db, { marks: ['email:new'], customerId: 'cus_new', now: NOW - 300 * 86400 });
    await cleanup(db, { now: NOW, sevenDaysAgo: '2026-10-01', thirteenMonthsAgo: '2025-09', thisMonth: '2026-10' });
    assert.deepEqual(db.rows('SELECT code FROM device_codes').map(r => r.code), ['NEWC0DE1']);
    assert.deepEqual(db.rows('SELECT event_id FROM processed_events').map(r => r.event_id), ['evt_new']);
    assert.equal(db.rows('SELECT COUNT(*) AS n FROM free_budget')[0].n, 0);
    const hashes = Object.fromEntries(db.rows('SELECT device_id, mint_ip_hash FROM devices').map(r => [r.device_id, r.mint_ip_hash]));
    assert.deepEqual(hashes, { dev_old: null, dev_new: 'net1' }, 'IP hashes are dropped after 48 hours');
    assert.deepEqual(db.rows('SELECT month FROM free_network').map(r => r.month), ['2026-10'], 'only this month\'s network counts are kept');
    assert.deepEqual(db.rows('SELECT mark FROM trial_marks').map(r => r.mark), ['email:new'], 'trial marks last a year');
  });
});
