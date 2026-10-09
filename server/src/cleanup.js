// The daily cleanup, run by the cron trigger in wrangler.jsonc. It deletes
// what has outlived its use: expired device codes, month-old checkout sessions
// (an unpaid trial checkout first hands its device's trial claim back) and
// webhook ids (Stripe retries for 3 days at most), old daily budgets and
// daily IPv6 block counts, usage older than 13 months, the 48-hour IP hashes,
// last month's per-network free counts, and trial marks older than a year.
// Contract section 12.4.

import { cleanup } from './db.js';
import { logLine } from './http.js';
import { dayKey, monthKey, monthKeyMonthsAgo } from './time.js';

export async function runCleanup(env, now) {
  await cleanup(env.DB, {
    now,
    sevenDaysAgo: dayKey(now - 7 * 86400),
    thirteenMonthsAgo: monthKeyMonthsAgo(now, 13),
    thisMonth: monthKey(now)
  });
  logLine('cleanup_done', {});
}
