// Device identity: minting a device, proving a request comes from one, the
// device code for an app purchase, and restoring a lost key.
// Contract sections 4.1, 6.3, 6.4 and 6.7.
//
// Why the server mints devices: in v2 the app chose its own device id, so
// anyone could get another 100 free checks by sending a new random id. Now an
// id only counts if this server made it (the token proves that), and one
// network can only make 10 an hour.

import {
  DEVICE_CODE_TTL_SECONDS, MAX_LIVE_DEVICE_CODES, MINTS_PER_IP_PER_HOUR, MINT_RETRY_AFTER_SECONDS, longSecretOk,
  modeAllowed
} from './config.js';
import { fail, failRetry } from './http.js';
import {
  DEVICE_ID_RE, DEVICE_TOKEN_RE, constantTimeEqual, deviceTokenFor, formatDeviceCode,
  ipHashFor, newDeviceCode, newDeviceId
} from './ids.js';
import { getDevice, getLicenseById, insertDevice, insertDeviceCode, liveDeviceCodes } from './db.js';
import { limit } from './limits.js';
import { licenseKeyForRow } from './stripe.js';
import { revokedMessage } from './access.js';

const TOO_MANY_CODES_MESSAGE = 'Too many purchases were started from this device in the last hour. Finish the open one, or try again later.';

function requireDeviceSecret(env) {
  if (!longSecretOk(env.DEVICE_SECRET)) fail('not_configured');
}

/**
 * The device row for a request, or 401 device_unverified. A device is
 * verified when its token matches AND the server has a row for it.
 */
export async function requireDevice(deps, body) {
  const { env } = deps;
  requireDeviceSecret(env);
  const { deviceId, deviceToken } = body;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) fail('device_unverified');
  if (typeof deviceToken !== 'string' || !DEVICE_TOKEN_RE.test(deviceToken)) fail('device_unverified');

  // Tokens are never stored: recompute and compare in constant time.
  const expected = await deviceTokenFor(env.DEVICE_SECRET, deviceId);
  if (!constantTimeEqual(expected, deviceToken)) fail('device_unverified');

  const device = await getDevice(env.DB, deviceId);
  if (!device) fail('device_unverified');
  return device;
}

/**
 * POST /v1/device: mint a device identity. Limited per network (`netKey`: an
 * IPv4 address or an IPv6 /56), so rotating through IPv6 /64s does not help.
 */
export async function postDevice(deps, { netKey }) {
  const { env } = deps;
  requireDeviceSecret(env);
  await limit(env, 'RL_MINT', netKey);

  const deviceId = newDeviceId();
  const created = await insertDevice(env.DB, {
    deviceId,
    now: deps.now(),
    // A keyed hash, so the database never holds the address itself.
    ipHash: await ipHashFor(env.DEVICE_SECRET, netKey),
    maxPerHour: MINTS_PER_IP_PER_HOUR
  });
  if (!created) failRetry('rate_limited', MINT_RETRY_AFTER_SECONDS);

  return { deviceId, deviceToken: await deviceTokenFor(env.DEVICE_SECRET, deviceId) };
}

/**
 * POST /v1/device-code: a polling handle for one purchase started in the app.
 *
 * Every call writes a row, so besides RL_IP (per address) it is limited per
 * DEVICE: RL_DEVICE, and at most MAX_LIVE_DEVICE_CODES unexpired codes. An
 * IPv6 /64 is cheap to change, so a per-address limit alone let one device
 * write rows without end.
 */
export async function postDeviceCode(deps, { body }) {
  const db = deps.env.DB;
  const device = await requireDevice(deps, body);
  await limit(deps.env, 'RL_DEVICE', `dev:${device.device_id}`);
  const now = deps.now();
  // 8 symbols is 40 bits. A clash with a live code is very unlikely, but a
  // retry costs nothing and makes "unlikely" not matter.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newDeviceCode();
    const stored = await insertDeviceCode(db, {
      code, deviceId: device.device_id, now, expiresAt: now + DEVICE_CODE_TTL_SECONDS, maxLive: MAX_LIVE_DEVICE_CODES
    });
    if (stored) return { deviceCode: formatDeviceCode(code), expiresIn: DEVICE_CODE_TTL_SECONDS };
    // Not stored: at the cap (then retrying cannot help), or a clash (then it can).
    const live = await liveDeviceCodes(db, { deviceId: device.device_id, now });
    if (live && live.n >= MAX_LIVE_DEVICE_CODES) {
      failRetry('rate_limited', live.first_expiry - now, TOO_MANY_CODES_MESSAGE);
    }
  }
  throw new Error('could not allocate a device code');
}

/**
 * POST /v1/restore: the license on file for this device, for a Mac whose app
 * lost its key. The answer to `no_license`.
 */
export async function postRestore(deps, { body }) {
  const device = await requireDevice(deps, body);
  if (!device.license_id) return { status: 'none' };
  const license = await getLicenseById(deps.env.DB, device.license_id);
  // A license from the other Stripe mode (sandbox vs live) is not this Worker's to hand out.
  if (!license || !modeAllowed(deps.env, license.livemode)) return { status: 'none' };
  if (license.revoked_at) fail('license_revoked', { message: revokedMessage(deps.env) });
  return { status: 'ready', license: await licenseKeyForRow(deps.env, license) };
}
