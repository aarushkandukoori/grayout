import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { keys, memoryStore } from '../src/store.js';
import {
  BURST_LIMIT, DEVICE_CHECKS_PER_MINUTE, FREE_CHECKS, INCLUDED_CHECKS,
  LICENSE_CHECKS_PER_HOUR, MAX_BODY_BYTES, enforceBurstLimit, enforceRateLimits,
  freeExhausted, freeUsage, licenseUsage, monthKey, monthResetsAt, overAllowance,
  readDevice, recordCheck, writeDevice
} from '../src/quota.js';
import { DEVICE_ID, LICENSE, T0, clock } from './helpers.js';

describe('the numbers come from the contract', () => {
  test('free taste, allowance, rate limits and body cap', () => {
    assert.equal(FREE_CHECKS, 100);
    assert.equal(INCLUDED_CHECKS, 15000);
    assert.equal(DEVICE_CHECKS_PER_MINUTE, 40);
    assert.equal(LICENSE_CHECKS_PER_HOUR, 1200);
    assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
  });
});

describe('month arithmetic', () => {
  test('monthKey is UTC and zero padded', () => {
    assert.equal(monthKey(Date.parse('2026-09-22T12:00:00Z')), '2026-09');
    assert.equal(monthKey(Date.parse('2026-01-01T00:00:00Z')), '2026-01');
    assert.equal(monthKey(Date.parse('2026-12-31T23:59:59Z')), '2026-12');
  });

  test('the last instant of a month and the first of the next are different keys', () => {
    assert.equal(monthKey(Date.parse('2026-09-30T23:59:59.999Z')), '2026-09');
    assert.equal(monthKey(Date.parse('2026-10-01T00:00:00.000Z')), '2026-10');
  });

  test('monthResetsAt is the first instant of the next month, and rolls the year', () => {
    assert.equal(monthResetsAt(Date.parse('2026-09-22T12:00:00Z')), '2026-10-01T00:00:00.000Z');
    assert.equal(monthResetsAt(Date.parse('2026-12-05T00:00:00Z')), '2027-01-01T00:00:00.000Z');
  });
});

describe('the free taste', () => {
  test('a device starts with nothing used', async () => {
    const store = memoryStore();
    const device = await readDevice(store, DEVICE_ID);
    assert.deepEqual(device, { freeUsed: 0, firstSeen: null, lastSeen: null, license: null });
    assert.equal(freeExhausted(device), false);
  });

  test('exhausts at exactly 100, not at 99', async () => {
    const store = memoryStore();
    await writeDevice(store, DEVICE_ID, { freeUsed: 99 }, T0);
    assert.equal(freeExhausted(await readDevice(store, DEVICE_ID)), false);
    await writeDevice(store, DEVICE_ID, { freeUsed: 100 }, T0);
    assert.equal(freeExhausted(await readDevice(store, DEVICE_ID)), true);
  });

  test('spending 100 checks walks the counter up and then stops', async () => {
    const store = memoryStore();
    let usage;
    for (let i = 0; i < FREE_CHECKS; i++) {
      assert.equal(freeExhausted(await readDevice(store, DEVICE_ID)), false, `check ${i + 1} should be allowed`);
      usage = await recordCheck(store, { deviceId: DEVICE_ID, now: T0 });
    }
    assert.deepEqual(usage, { checksUsed: 100, checksIncluded: 100, periodEnd: null, resetsAt: null });
    assert.equal(freeExhausted(await readDevice(store, DEVICE_ID)), true);
  });

  test('never resets: the free taste has no period end', () => {
    assert.deepEqual(freeUsage({ freeUsed: 7 }), {
      checksUsed: 7, checksIncluded: 100, periodEnd: null, resetsAt: null
    });
  });

  test('first seen is set once and last seen moves', async () => {
    const store = memoryStore();
    await writeDevice(store, DEVICE_ID, {}, T0);
    await writeDevice(store, DEVICE_ID, {}, T0 + 86400000);
    const device = await readDevice(store, DEVICE_ID);
    assert.equal(device.firstSeen, new Date(T0).toISOString());
    assert.equal(device.lastSeen, new Date(T0 + 86400000).toISOString());
  });
});

describe('the monthly allowance', () => {
  const record = { periodEnd: '2026-10-22T00:00:00.000Z' };

  test('counts against use:<license>:<YYYY-MM>', async () => {
    const store = memoryStore();
    await recordCheck(store, { deviceId: DEVICE_ID, license: LICENSE, record, now: T0 });
    await recordCheck(store, { deviceId: DEVICE_ID, license: LICENSE, record, now: T0 });
    assert.equal(await store.get(keys.usage(LICENSE, '2026-09')), 2);
    const usage = await licenseUsage(store, LICENSE, record, T0);
    assert.equal(usage.checksUsed, 2);
    assert.equal(usage.checksIncluded, 15000);
  });

  test('reports the billing period end, and separately when the meter resets', async () => {
    const usage = await licenseUsage(memoryStore(), LICENSE, record, T0);
    assert.equal(usage.periodEnd, '2026-10-22T00:00:00.000Z');
    assert.equal(usage.resetsAt, '2026-10-01T00:00:00.000Z');
  });

  test('falls back to the reset date when the subscription has no period end', async () => {
    const usage = await licenseUsage(memoryStore(), LICENSE, {}, T0);
    assert.equal(usage.periodEnd, '2026-10-01T00:00:00.000Z');
  });

  test('rolls over on the calendar month without anything being cleared', async () => {
    const store = memoryStore();
    for (let i = 0; i < 5; i++) await recordCheck(store, { license: LICENSE, record, now: T0 });
    const october = Date.parse('2026-10-01T00:00:01Z');
    assert.equal((await licenseUsage(store, LICENSE, record, T0)).checksUsed, 5);
    assert.equal((await licenseUsage(store, LICENSE, record, october)).checksUsed, 0, 'October starts fresh');
    // September's count is still there, which is what makes the rollover free.
    assert.equal(await store.get(keys.usage(LICENSE, '2026-09')), 5);
  });

  test('over the allowance is 15,000, not 15,001', () => {
    assert.equal(overAllowance({ checksUsed: 14999, checksIncluded: INCLUDED_CHECKS }), false);
    assert.equal(overAllowance({ checksUsed: 15000, checksIncluded: INCLUDED_CHECKS }), true);
  });

  test('a paid check binds the license to the device', async () => {
    const store = memoryStore();
    await recordCheck(store, { deviceId: DEVICE_ID, license: LICENSE, record, now: T0 });
    assert.equal((await readDevice(store, DEVICE_ID)).license, LICENSE);
    assert.equal((await readDevice(store, DEVICE_ID)).freeUsed, 0, 'a paid check does not spend free ones');
  });
});

describe('rate limits', () => {
  test('a device gets 40 checks a minute and the 41st is refused', async () => {
    const store = memoryStore();
    for (let i = 0; i < DEVICE_CHECKS_PER_MINUTE; i++) {
      const r = await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 });
      assert.equal(r.ok, true, `check ${i + 1} should pass`);
    }
    const refused = await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 });
    assert.equal(refused.ok, false);
    assert.equal(refused.scope, 'device');
    assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 60);
  });

  test('the window is fixed: the next minute starts clean', async () => {
    const store = memoryStore();
    for (let i = 0; i < DEVICE_CHECKS_PER_MINUTE + 5; i++) await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 });
    const next = await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 + 60_000 });
    assert.equal(next.ok, true);
  });

  test('retryAfter counts the seconds to the next window', async () => {
    const store = memoryStore();
    const at = Date.parse('2026-09-22T12:00:20Z');
    for (let i = 0; i < DEVICE_CHECKS_PER_MINUTE; i++) await enforceRateLimits(store, { deviceId: DEVICE_ID, now: at });
    const refused = await enforceRateLimits(store, { deviceId: DEVICE_ID, now: at });
    assert.equal(refused.retryAfter, 40);
  });

  test('a license gets 1,200 an hour across however many devices', async () => {
    const store = memoryStore();
    for (let i = 0; i < LICENSE_CHECKS_PER_HOUR; i++) {
      assert.equal((await enforceRateLimits(store, { license: LICENSE, now: T0 })).ok, true);
    }
    const refused = await enforceRateLimits(store, { license: LICENSE, now: T0 });
    assert.equal(refused.ok, false);
    assert.equal(refused.scope, 'license');
    const nextHour = await enforceRateLimits(store, { license: LICENSE, now: T0 + 3600_000 });
    assert.equal(nextHour.ok, true);
  });

  test('a refused request still counts, so hammering does not reset the clock', async () => {
    const store = memoryStore();
    for (let i = 0; i < DEVICE_CHECKS_PER_MINUTE + 10; i++) await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 });
    const bucket = Math.floor(T0 / 60000);
    assert.equal(await store.get(keys.rateDevice(DEVICE_ID, bucket)), DEVICE_CHECKS_PER_MINUTE + 10);
  });

  test('the two windows are separate keys, so one device cannot spend another', async () => {
    const store = memoryStore();
    for (let i = 0; i < DEVICE_CHECKS_PER_MINUTE; i++) await enforceRateLimits(store, { deviceId: 'device-one-aaaa', now: T0 });
    assert.equal((await enforceRateLimits(store, { deviceId: 'device-two-bbbb', now: T0 })).ok, true);
  });
});

describe('the burst limit on the cheap endpoints', () => {
  test('allows 30 a minute per key and then refuses', async () => {
    const store = memoryStore();
    for (let i = 0; i < BURST_LIMIT; i++) {
      assert.equal((await enforceBurstLimit(store, { key: `checkout:${DEVICE_ID}`, now: T0 })).ok, true);
    }
    const refused = await enforceBurstLimit(store, { key: `checkout:${DEVICE_ID}`, now: T0 });
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfter > 0);
  });

  test('does not share a window with the watch loop', async () => {
    const store = memoryStore();
    for (let i = 0; i < BURST_LIMIT + 1; i++) await enforceBurstLimit(store, { key: `checkout:${DEVICE_ID}`, now: T0 });
    assert.equal((await enforceRateLimits(store, { deviceId: DEVICE_ID, now: T0 })).ok, true);
  });
});

describe('the clock the store uses', () => {
  test('a rate-limit key is written with a TTL so it cannot accumulate forever', async () => {
    const c = clock();
    const store = memoryStore({ now: c.now });
    await enforceRateLimits(store, { deviceId: DEVICE_ID, now: c.now() });
    const bucket = Math.floor(c.now() / 60000);
    assert.equal(await store.get(keys.rateDevice(DEVICE_ID, bucket)), 1);
    c.advance(130 * 1000);
    assert.equal(await store.get(keys.rateDevice(DEVICE_ID, bucket)), null);
  });
});
