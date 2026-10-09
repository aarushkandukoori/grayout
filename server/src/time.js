// Time helpers. The service counts time in whole Unix seconds everywhere,
// because that is what both D1 rows and Stripe objects use. Only responses
// turn seconds into ISO strings.

/** Unix seconds right now. */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** "2026-11-07T14:03:11Z", or null for a missing time. */
export function iso(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "2026-11" in UTC: the key of the monthly check counter. */
export function monthKey(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 7);
}

/** "2026-11-07" in UTC: the key of the daily free budget. */
export function dayKey(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** 00:00 UTC on the 1st of next month, in seconds: when the check meter resets. */
export function nextMonthStart(seconds) {
  const d = new Date(seconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

/** The month key `count` months before this moment (for cleanup). */
export function monthKeyMonthsAgo(seconds, count) {
  const d = new Date(seconds * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - count, 1)).toISOString().slice(0, 7);
}

/** 00:00 UTC tomorrow, in seconds: when the daily budgets reset. */
export function nextDayStart(seconds) {
  const d = new Date(seconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000;
}
