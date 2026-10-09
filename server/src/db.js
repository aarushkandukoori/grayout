// Every SQL statement the service runs, as small named functions over D1.
//
// Rules for this file:
// - Values are always bound (?1, ?2, …). SQL is never built by joining strings.
// - Anything that must not be over-spent (a free check, a mint, a paid check)
//   is ONE statement, so two requests at the same moment cannot both slip
//   through. SQLite runs each statement atomically.
// - Times are Unix seconds.
//
// The schema is migrations/0001_init.sql; contract section 12 explains it.

import { MAX_LIVE_DEVICE_CODES } from './config.js';

// ---------------------------------------------------------------- devices

/**
 * Create a device, unless this network already made `maxPerHour` in the last
 * hour. Returns true when the row was created.
 */
export async function insertDevice(db, { deviceId, now, ipHash, maxPerHour }) {
  const row = await db.prepare(
    `INSERT INTO devices (device_id, created_at, mint_ip_hash)
     SELECT ?1, ?2, ?3
     WHERE (SELECT COUNT(*) FROM devices WHERE mint_ip_hash = ?3 AND created_at > ?2 - 3600) < ?4
     RETURNING device_id`
  ).bind(deviceId, now, ipHash, maxPerHour).first();
  return !!row;
}

export async function getDevice(db, deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?1').bind(deviceId).first();
}

/** Take one free check from a device. Returns the new count, or null when it has none left. */
export async function reserveFreeCheck(db, { deviceId, now, limit }) {
  const row = await db.prepare(
    `UPDATE devices SET free_used = free_used + 1, last_seen_at = ?2
     WHERE device_id = ?1 AND free_used < ?3
     RETURNING free_used`
  ).bind(deviceId, now, limit).first();
  return row ? row.free_used : null;
}

/** Give a free check back after the model failed. */
export async function releaseFreeCheck(db, deviceId) {
  await db.prepare('UPDATE devices SET free_used = free_used - 1 WHERE device_id = ?1 AND free_used > 0')
    .bind(deviceId).run();
}

/**
 * Attach a license to a device. Holding a license also counts as having had a
 * trial, so trial_used_at is filled in if it was empty (and never changed if
 * it was not).
 */
export async function attachLicense(db, { deviceId, licenseId, now }) {
  await db.prepare(
    `UPDATE devices SET license_id = ?2, trial_used_at = COALESCE(trial_used_at, ?3), last_seen_at = ?3
     WHERE device_id = ?1`
  ).bind(deviceId, licenseId, now).run();
}

/** Remember that this device bought (or trialled) something. Keeps the first time. */
export async function markTrialUsed(db, { deviceId, now }) {
  await db.prepare('UPDATE devices SET trial_used_at = COALESCE(trial_used_at, ?2) WHERE device_id = ?1')
    .bind(deviceId, now).run();
}

/**
 * Claim this device's one trial, when a trial checkout is CREATED (not only
 * when it is paid), so two checkouts started at once cannot both offer a
 * trial. One statement: only the first caller sees true.
 */
export async function claimTrial(db, { deviceId, now }) {
  const row = await db.prepare(
    'UPDATE devices SET trial_used_at = ?2 WHERE device_id = ?1 AND trial_used_at IS NULL RETURNING device_id'
  ).bind(deviceId, now).first();
  return !!row;
}

/**
 * Hand a trial claim back, because the checkout that claimed it ended unpaid
 * (expired, abandoned, or Stripe refused to create it). Only the claim made
 * at `claimedAt` is undone, and never on a device that bought or holds a
 * license, so a real trial or purchase can never be erased.
 */
export async function releaseTrialClaim(db, { deviceId, claimedAt }) {
  await db.prepare(
    `UPDATE devices SET trial_used_at = NULL
     WHERE device_id = ?1 AND trial_used_at = ?2 AND license_id IS NULL AND bought_license_id IS NULL`
  ).bind(deviceId, claimedAt).run();
}

/** How long a checkout lock lasts if the request holding it dies half-way. */
const CHECKOUT_LOCK_SECONDS = 30;

/**
 * Take this device's checkout lock, so two /v1/checkout requests for one
 * device (two tabs, a double click) run one after the other, never together.
 * Returns false when another request holds it.
 */
export async function lockCheckout(db, { deviceId, now }) {
  const row = await db.prepare(
    `UPDATE devices SET checkout_lock_at = ?2
     WHERE device_id = ?1 AND (checkout_lock_at IS NULL OR checkout_lock_at <= ?2 - ?3)
     RETURNING device_id`
  ).bind(deviceId, now, CHECKOUT_LOCK_SECONDS).first();
  return !!row;
}

export async function unlockCheckout(db, deviceId) {
  await db.prepare('UPDATE devices SET checkout_lock_at = NULL WHERE device_id = ?1').bind(deviceId).run();
}

/**
 * Remember which license this device bought, from the app OR the website.
 * Only /v1/checkout reads it, to refuse a second purchase. It never grants
 * service and /v1/restore never returns it, so a browser still holds no key.
 */
export async function markBought(db, { deviceId, licenseId }) {
  await db.prepare('UPDATE devices SET bought_license_id = ?2 WHERE device_id = ?1')
    .bind(deviceId, licenseId).run();
}

// ---------------------------------------------------------------- device codes

/**
 * Store a device code, unless this device already holds `maxLive` codes that
 * have not expired. One statement, so two requests at once cannot both slip
 * past the cap. Returns false when nothing was stored: the device is at its
 * cap, or (very rarely) the random code is already taken.
 */
export async function insertDeviceCode(db, { code, deviceId, now, expiresAt, maxLive = MAX_LIVE_DEVICE_CODES }) {
  // SQLite needs the WHERE on an INSERT … SELECT that has ON CONFLICT; this one has it.
  const row = await db.prepare(
    `INSERT INTO device_codes (code, device_id, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM device_codes WHERE device_id = ?2 AND expires_at > ?3) < ?5
     ON CONFLICT (code) DO NOTHING
     RETURNING code`
  ).bind(code, deviceId, now, expiresAt, maxLive).first();
  return !!row;
}

/** { n, first_expiry } for this device's device codes that have not expired yet. */
export async function liveDeviceCodes(db, { deviceId, now }) {
  return db.prepare(
    'SELECT COUNT(*) AS n, MIN(expires_at) AS first_expiry FROM device_codes WHERE device_id = ?1 AND expires_at > ?2'
  ).bind(deviceId, now).first();
}

export async function getDeviceCode(db, code) {
  return db.prepare('SELECT * FROM device_codes WHERE code = ?1').bind(code).first();
}

// ---------------------------------------------------------------- checkout sessions

export async function insertCheckoutSession(db, s) {
  await db.prepare(
    `INSERT INTO checkout_sessions (session_id, device_id, device_code, plan, trial, livemode, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(s.sessionId, s.deviceId, s.deviceCode, s.plan, s.trial ? 1 : 0, s.livemode ? 1 : 0, s.now, s.expiresAt).run();
}

export async function getCheckoutSession(db, sessionId) {
  return db.prepare('SELECT * FROM checkout_sessions WHERE session_id = ?1').bind(sessionId).first();
}

/** The most recent session started with this device code, or null. */
export async function newestSessionForCode(db, code) {
  return db.prepare(
    'SELECT * FROM checkout_sessions WHERE device_code = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).bind(code).first();
}

export async function setSessionCheckedAt(db, { sessionId, now }) {
  await db.prepare('UPDATE checkout_sessions SET checked_at = ?2 WHERE session_id = ?1').bind(sessionId, now).run();
}

/**
 * Mark a session failed or expired. Only an open session changes: a session
 * that was paid is never turned back into a failure by a late event.
 */
export async function closeSession(db, { sessionId, state }) {
  await db.prepare("UPDATE checkout_sessions SET state = ?2 WHERE session_id = ?1 AND state = 'open'")
    .bind(sessionId, state).run();
}

/** This device's sessions that we still think are open (newest first, at most 5). */
export async function openSessionsForDevice(db, deviceId) {
  const { results } = await db.prepare(
    `SELECT * FROM checkout_sessions WHERE device_id = ?1 AND state = 'open'
     ORDER BY created_at DESC, rowid DESC LIMIT 5`
  ).bind(deviceId).all();
  return results;
}

export async function markSessionPaid(db, { sessionId, licenseId }) {
  await db.prepare("UPDATE checkout_sessions SET state = 'paid', license_id = ?2 WHERE session_id = ?1")
    .bind(sessionId, licenseId).run();
}

// ---------------------------------------------------------------- licenses

/**
 * Issue the license for a customer, or read back the one they already have.
 *
 * The INSERT and the SELECT run in one batch. If two webhook deliveries (or a
 * delivery and a /v1/claim) arrive together, the UNIQUE (customer_id)
 * constraint lets only one row in, and both read back that same row. The key
 * itself is derived from the customer id, so both callers also agree on it.
 *
 * synced_at starts at 0 ("never synced"), so if the Stripe read that follows
 * fails, the first access decision re-reads Stripe instead of trusting the
 * placeholder status.
 */
export async function issueLicense(db, { keyHash, livemode, customerId, now }) {
  const [, read] = await db.batch([
    db.prepare(
      `INSERT INTO licenses (key_hash, livemode, customer_id, synced_at, created_at)
       VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT (customer_id) DO NOTHING`
    ).bind(keyHash, livemode ? 1 : 0, customerId, now),
    db.prepare('SELECT * FROM licenses WHERE customer_id = ?1').bind(customerId)
  ]);
  return read.results[0] || null;
}

export async function getLicenseByHash(db, keyHash) {
  return db.prepare('SELECT * FROM licenses WHERE key_hash = ?1').bind(keyHash).first();
}

export async function getLicenseById(db, id) {
  return db.prepare('SELECT * FROM licenses WHERE id = ?1').bind(id).first();
}

export async function getLicenseByCustomer(db, customerId) {
  return db.prepare('SELECT * FROM licenses WHERE customer_id = ?1').bind(customerId).first();
}

export async function getLicenseBySubscription(db, subscriptionId) {
  return db.prepare('SELECT * FROM licenses WHERE subscription_id = ?1').bind(subscriptionId).first();
}

/**
 * Write what Stripe says about a customer's subscription. The only function
 * that writes these columns; contract section 7.3.
 */
export async function writeSubscriptionState(db, customerId, s) {
  return db.prepare(
    `UPDATE licenses SET subscription_id = ?2, status = ?3, billing_interval = ?4, period_start = ?5,
       period_end = ?6, trial_end = ?7, cancel_at_period_end = ?8, synced_at = ?9
     WHERE customer_id = ?1
     RETURNING *`
  ).bind(customerId, s.subscriptionId, s.status, s.interval, s.periodStart, s.periodEnd, s.trialEnd,
    s.cancelAtPeriodEnd ? 1 : 0, s.now).first();
}

/**
 * Note that a re-read of Stripe is about to be attempted. Written BEFORE the
 * call, so a read that keeps failing is still tried at most once per 15
 * minutes (access.js). synced_at stays the time of the last SUCCESSFUL read.
 */
export async function markSyncTried(db, { licenseId, now }) {
  await db.prepare('UPDATE licenses SET sync_tried_at = ?2 WHERE id = ?1').bind(licenseId, now).run();
}

/** This customer's trial is a repeat (same card or email as an earlier trial). */
export async function setTrialDenied(db, customerId) {
  return db.prepare('UPDATE licenses SET trial_denied = 1 WHERE customer_id = ?1 RETURNING *')
    .bind(customerId).first();
}

/** Stripe was read and had nothing for us: record the read, change nothing else. */
export async function touchSynced(db, { customerId, now }) {
  return db.prepare('UPDATE licenses SET synced_at = ?2 WHERE customer_id = ?1 RETURNING *')
    .bind(customerId, now).first();
}

/**
 * Revoke the license that follows this subscription. Revocation is sticky:
 * the first time and reason are kept, and nothing automatic ever clears them.
 */
export async function revokeBySubscription(db, { subscriptionId, reason, now }) {
  return db.prepare(
    `UPDATE licenses SET revoked_at = COALESCE(revoked_at, ?3), revoked_reason = COALESCE(revoked_reason, ?2)
     WHERE subscription_id = ?1
     RETURNING id`
  ).bind(subscriptionId, reason, now).first();
}

// ---------------------------------------------------------------- usage and budgets

/**
 * Reserve one paid check. Inside the allowance it always succeeds. Past it,
 * it succeeds once per `slowInterval` seconds. Returns the month's count, or
 * null when the license must wait.
 */
export async function reservePaidCheck(db, { licenseId, month, now, included, slowInterval }) {
  const row = await db.prepare(
    `INSERT INTO usage (license_id, month, n, last_at) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (license_id, month) DO UPDATE SET n = n + 1, last_at = ?3
       WHERE usage.n < ?4 OR usage.last_at <= ?3 - ?5
     RETURNING n`
  ).bind(licenseId, month, now, included, slowInterval).first();
  return row ? row.n : null;
}

export async function releasePaidCheck(db, { licenseId, month }) {
  await db.prepare('UPDATE usage SET n = n - 1 WHERE license_id = ?1 AND month = ?2 AND n > 0')
    .bind(licenseId, month).run();
}

/** { n, last_at } for a license this month, or zeros. */
export async function getUsage(db, { licenseId, month }) {
  const row = await db.prepare('SELECT n, last_at FROM usage WHERE license_id = ?1 AND month = ?2')
    .bind(licenseId, month).first();
  return row || { n: 0, last_at: 0 };
}

/** Take one check from today's free budget for everyone. Null when it is spent. */
export async function reserveFreeBudget(db, { day, budget }) {
  // The INSERT branch always succeeds, so an empty budget is refused here.
  if (budget <= 0) return null;
  const row = await db.prepare(
    `INSERT INTO free_budget (day, n) VALUES (?1, 1)
     ON CONFLICT (day) DO UPDATE SET n = n + 1 WHERE free_budget.n < ?2
     RETURNING n`
  ).bind(day, budget).first();
  return row ? row.n : null;
}

export async function releaseFreeBudget(db, day) {
  await db.prepare('UPDATE free_budget SET n = n - 1 WHERE day = ?1 AND n > 0').bind(day).run();
}

/** Take one free check from this network's monthly allowance. Null when it is spent. */
export async function reserveFreeNetwork(db, { netHash, month, cap }) {
  if (cap <= 0) return null;
  const row = await db.prepare(
    `INSERT INTO free_network (net_hash, month, n) VALUES (?1, ?2, 1)
     ON CONFLICT (net_hash, month) DO UPDATE SET n = n + 1 WHERE free_network.n < ?3
     RETURNING n`
  ).bind(netHash, month, cap).first();
  return row ? row.n : null;
}

export async function releaseFreeNetwork(db, { netHash, month }) {
  await db.prepare('UPDATE free_network SET n = n - 1 WHERE net_hash = ?1 AND month = ?2 AND n > 0')
    .bind(netHash, month).run();
}

/** Take one free check from this IPv6 /48 block's share of today. Null when it is spent. */
export async function reserveFreeBlock(db, { blockHash, day, cap }) {
  if (cap <= 0) return null;
  const row = await db.prepare(
    `INSERT INTO free_block (block_hash, day, n) VALUES (?1, ?2, 1)
     ON CONFLICT (block_hash, day) DO UPDATE SET n = n + 1 WHERE free_block.n < ?3
     RETURNING n`
  ).bind(blockHash, day, cap).first();
  return row ? row.n : null;
}

export async function releaseFreeBlock(db, { blockHash, day }) {
  await db.prepare('UPDATE free_block SET n = n - 1 WHERE block_hash = ?1 AND day = ?2 AND n > 0')
    .bind(blockHash, day).run();
}

// ---------------------------------------------------------------- trial marks

/**
 * Record that `customerId` started a trial with these marks (keyed hashes of
 * its email and card), and say whether ANOTHER customer already had any of
 * them. The first customer to use a mark keeps it, so running this twice for
 * the same purchase gives the same answer. One batch, so two purchases at the
 * same moment cannot both be "first".
 */
export async function recordTrialMarks(db, { marks, customerId, now }) {
  // At most two marks: the email and the card. A missing second one repeats the first.
  if (!marks.length) return false;
  const [first, second = marks[0]] = marks;
  const insert = mark => db.prepare(
    'INSERT INTO trial_marks (mark, customer_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (mark) DO NOTHING'
  ).bind(mark, customerId, now);
  const results = await db.batch([
    insert(first),
    insert(second),
    db.prepare('SELECT COUNT(*) AS n FROM trial_marks WHERE customer_id <> ?1 AND mark IN (?2, ?3)')
      .bind(customerId, first, second)
  ]);
  return results[2].results[0].n > 0;
}

// ---------------------------------------------------------------- webhook events

export async function eventSeen(db, eventId) {
  return !!(await db.prepare('SELECT 1 AS seen FROM processed_events WHERE event_id = ?1').bind(eventId).first());
}

export async function recordEvent(db, { eventId, type, now }) {
  await db.prepare(
    `INSERT INTO processed_events (event_id, type, processed_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (event_id) DO NOTHING`
  ).bind(eventId, type, now).run();
}

// ---------------------------------------------------------------- daily cleanup

/** Delete what has outlived its use. Contract section 12.4. */
export async function cleanup(db, { now, sevenDaysAgo, thirteenMonthsAgo, thisMonth }) {
  const monthAgo = now - 30 * 86400;
  await db.batch([
    db.prepare('DELETE FROM free_network WHERE month < ?1').bind(thisMonth),
    db.prepare('DELETE FROM trial_marks WHERE created_at < ?1').bind(now - 365 * 86400),
    db.prepare('DELETE FROM device_codes WHERE expires_at < ?1').bind(now - 86400),
    // Before a month-old checkout row is deleted: if it was an unpaid trial
    // checkout (abandoned, expired), hand its trial claim back, the same way
    // releaseTrialClaim does. Once the row is gone, nothing else could, and
    // the device would never be offered its trial again. Only the claim made
    // by that session (trial_used_at = its created_at) on a device that never
    // bought or held a license; a paid session's device has bought_license_id.
    db.prepare(
      `UPDATE devices SET trial_used_at = NULL
       WHERE license_id IS NULL AND bought_license_id IS NULL AND trial_used_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM checkout_sessions s
                     WHERE s.device_id = devices.device_id AND s.trial = 1 AND s.state <> 'paid'
                       AND s.created_at = devices.trial_used_at AND s.created_at < ?1)`
    ).bind(monthAgo),
    db.prepare('DELETE FROM checkout_sessions WHERE created_at < ?1').bind(monthAgo),
    db.prepare('DELETE FROM processed_events WHERE processed_at < ?1').bind(monthAgo),
    db.prepare('DELETE FROM free_budget WHERE day < ?1').bind(sevenDaysAgo),
    db.prepare('DELETE FROM free_block WHERE day < ?1').bind(sevenDaysAgo),
    db.prepare('DELETE FROM usage WHERE month < ?1').bind(thirteenMonthsAgo),
    db.prepare('UPDATE devices SET mint_ip_hash = NULL WHERE mint_ip_hash IS NOT NULL AND created_at < ?1').bind(now - 172800)
  ]);
}
