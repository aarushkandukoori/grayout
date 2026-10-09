// A subscriber's account: attaching a pasted key, reading the subscription
// state, and the billing portal link. Contract sections 6.8 to 6.10.

import { STALE_SYNC_SECONDS, modeAllowed } from './config.js';
import { ApiError, describeError, fail, logLine } from './http.js';
import { normalizeLicense, sha256Hex } from './ids.js';
import { attachLicense, getLicenseByHash } from './db.js';
import { limit } from './limits.js';
import { requireDevice } from './devices.js';
import { accessFor, accountObject, revokedMessage } from './access.js';
import { createPortalUrl, portalUrlOrNull } from './stripe.js';

/**
 * The license key a request carries: `license` in the JSON body, or an
 * `Authorization: Bearer gry_…` header. Never a URL. Returns '' when there is
 * none; a value that is there but malformed is 401 license_invalid.
 */
export function licenseFromRequest(request, body) {
  let raw = null;
  if (body.license !== undefined && body.license !== null && body.license !== '') {
    if (typeof body.license !== 'string') fail('bad_request', { message: 'The license has to be a string.' });
    raw = body.license;
  } else {
    const header = request.headers.get('Authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match) raw = match[1];
  }
  if (raw === null) return '';
  const key = normalizeLicense(raw);
  if (!key) fail('license_invalid');
  return key;
}

/**
 * The licenses row for a key, found by its hash, or 401 license_invalid.
 * A license from the other Stripe mode is refused the same way: a gry_test_
 * key (bought with a test card) never works on the live Worker, and a live
 * key never works on the sandbox one.
 */
export async function loadLicense(deps, key) {
  const row = await getLicenseByHash(deps.env.DB, await sha256Hex(key));
  if (!row || !modeAllowed(deps.env, row.livemode)) fail('license_invalid');
  return row;
}

/** Device + license, both required, and the license must not be revoked. */
async function deviceAndLicense(deps, request, body) {
  const device = await requireDevice(deps, body);
  const key = licenseFromRequest(request, body);
  if (!key) fail('bad_request', { message: 'That request needs a license key.' });
  const license = await loadLicense(deps, key);
  if (license.revoked_at) fail('license_revoked', { message: revokedMessage(deps.env) });
  return { device, license };
}

/**
 * POST /v1/activate: attach a pasted key to this device, and re-validate on
 * launch. A canceled license still activates; the answer just says
 * service: false.
 */
export async function postActivate(deps, { request, body, ipKey }) {
  const { device, license } = await deviceAndLicense(deps, request, body);
  await attachLicense(deps.env.DB, { deviceId: device.device_id, licenseId: license.id, now: deps.now() });
  // A re-read of Stripe here counts against this address's Stripe limit.
  const access = await accessFor(deps, license, { maxAge: STALE_SYNC_SECONDS, ipKey });
  return accountObject(deps, access);
}

/** POST /v1/status: the account object, plus a portal link when asked for. */
export async function postStatus(deps, { request, body, ipKey }) {
  const { license } = await deviceAndLicense(deps, request, body);
  const wantsPortal = body.portal === true;
  // A portal link is a live Stripe call, so it has its own limit.
  if (wantsPortal) await limit(deps.env, 'RL_STRIPE_IP', ipKey);

  const access = await accessFor(deps, license, { maxAge: STALE_SYNC_SECONDS, ipKey });
  const account = await accountObject(deps, access);
  // Made only when asked: the link expires 5 minutes after it is made.
  const portalUrl = wantsPortal ? await portalUrlOrNull(deps, license.customer_id) : null;
  return { ...account, portalUrl };
}

/** POST /v1/portal: a Stripe billing portal link. */
export async function postPortal(deps, { request, body, ipKey }) {
  const { license } = await deviceAndLicense(deps, request, body);
  await limit(deps.env, 'RL_STRIPE_IP', ipKey);
  try {
    return { url: await createPortalUrl(deps, license.customer_id) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logLine('portal_failed', { customer: license.customer_id, error: describeError(err) });
    fail('not_configured');
  }
}
