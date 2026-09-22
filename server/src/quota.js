// What a caller is allowed to spend: the free taste, the monthly allowance,
// and the two rate limits. All numbers come from docs/API-CONTRACT.md.

import { keys } from './store.js';

/** 100 checks, device-bound, no card. It never resets. */
export const FREE_CHECKS = 100;
/** Included with Pro, per calendar month. */
export const INCLUDED_CHECKS = 15000;
export const DEVICE_CHECKS_PER_MINUTE = 40;
export const LICENSE_CHECKS_PER_HOUR = 1200;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** `YYYY-MM` in UTC — the second half of the `use:<license>:<YYYY-MM>` key. */
export function monthKey(now) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The instant the calendar-month counter rolls over, as an ISO string. */
export function monthResetsAt(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Two fixed windows: 40 checks a minute for a device, 1,200 an hour for a
 * license. A fixed window can let a burst straddle a boundary; that is fine
 * for a limiter whose job is to stop a runaway loop, not to shape traffic.
 *
 * A rejected request still counts against the window it was rejected in. That
 * is deliberate — a client hammering a closed door should not reset the clock.
 */
export async function enforceRateLimits(store, { deviceId, license, now = Date.now() } = {}) {
  if (deviceId) {
    const bucket = Math.floor(now / MINUTE_MS);
    const used = await store.incr(keys.rateDevice(deviceId, bucket), 1, { expirationTtl: 120 });
    if (used > DEVICE_CHECKS_PER_MINUTE) {
      return { ok: false, scope: 'device', retryAfter: Math.ceil(((bucket + 1) * MINUTE_MS - now) / 1000) };
    }
  }
  if (license) {
    const bucket = Math.floor(now / HOUR_MS);
    const used = await store.incr(keys.rateLicense(license, bucket), 1, { expirationTtl: 2 * 3600 });
    if (used > LICENSE_CHECKS_PER_HOUR) {
      return { ok: false, scope: 'license', retryAfter: Math.ceil(((bucket + 1) * HOUR_MS - now) / 1000) };
    }
  }
  return { ok: true };
}

/** The `dev:<deviceId>` record, or a blank one. Does not write. */
export async function readDevice(store, deviceId) {
  const rec = await store.get(keys.device(deviceId));
  return {
    freeUsed: rec && Number.isFinite(rec.freeUsed) ? rec.freeUsed : 0,
    firstSeen: (rec && rec.firstSeen) || null,
    lastSeen: (rec && rec.lastSeen) || null,
    license: (rec && rec.license) || null
  };
}

/** Write the `dev:<deviceId>` record, filling in first/last seen. */
export async function writeDevice(store, deviceId, patch, now = Date.now()) {
  const current = await readDevice(store, deviceId);
  const next = {
    ...current,
    ...patch,
    firstSeen: current.firstSeen || new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString()
  };
  await store.put(keys.device(deviceId), next);
  return next;
}

/** The usage object the contract returns alongside a verdict, for the free taste. */
export function freeUsage(device) {
  return {
    checksUsed: device.freeUsed,
    checksIncluded: FREE_CHECKS,
    // The free taste is a one-off, so there is no date on which it comes back.
    periodEnd: null,
    resetsAt: null
  };
}

/** The same object for a license, from the month counter and the subscription record. */
export async function licenseUsage(store, license, record, now = Date.now()) {
  const used = await store.get(keys.usage(license, monthKey(now)));
  const resetsAt = monthResetsAt(now);
  return {
    checksUsed: Number.isFinite(used) ? used : 0,
    checksIncluded: INCLUDED_CHECKS,
    // What the person is billed on, when the subscription tells us. The
    // allowance itself resets on `resetsAt`.
    periodEnd: (record && record.periodEnd) || resetsAt,
    resetsAt
  };
}

/** Has this device used up its 100 free checks? */
export function freeExhausted(device) {
  return device.freeUsed >= FREE_CHECKS;
}

/** Is this license past its monthly allowance? */
export function overAllowance(usage) {
  return usage.checksUsed >= INCLUDED_CHECKS;
}

/**
 * Bill one successful check. Free checks count against the device record;
 * paid checks against `use:<license>:<YYYY-MM>`, which rolls over on its own
 * because the month is part of the key.
 */
export async function recordCheck(store, { deviceId, license, record, now = Date.now() } = {}) {
  if (license) {
    const month = monthKey(now);
    const used = await store.incr(keys.usage(license, month), 1);
    if (deviceId) await writeDevice(store, deviceId, { license }, now);
    const resetsAt = monthResetsAt(now);
    return {
      checksUsed: used,
      checksIncluded: INCLUDED_CHECKS,
      periodEnd: (record && record.periodEnd) || resetsAt,
      resetsAt
    };
  }
  const device = await readDevice(store, deviceId);
  const next = await writeDevice(store, deviceId, { freeUsed: device.freeUsed + 1 }, now);
  return freeUsage(next);
}

/** Per-device ceiling for the endpoints that are not the watch loop. */
export const BURST_LIMIT = 30;

/**
 * A generic fixed-window limiter for the cheap endpoints: device-code,
 * checkout, activate and status. None of these is on the watch loop's path, so
 * they get their own window and cannot eat a subscriber's check budget.
 */
export async function enforceBurstLimit(store, { key, limit, windowMs = MINUTE_MS, now = Date.now() } = {}) {
  const ceiling = Number.isFinite(limit) ? limit : BURST_LIMIT;
  const bucket = Math.floor(now / windowMs);
  const used = await store.incr(`rl:burst:${key}:${bucket}`, 1, { expirationTtl: Math.ceil((windowMs * 2) / 1000) });
  if (used > ceiling) {
    return { ok: false, retryAfter: Math.ceil(((bucket + 1) * windowMs - now) / 1000) };
  }
  return { ok: true };
}
