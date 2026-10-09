// POST /v1/check: the one call the watch loop makes. Contract section 6.11.
//
// The order matters, so nobody is charged for a request that was going to be
// refused anyway:
//   1. read and validate the body;
//   2. verify the device;
//   3. reserve ONE check (paid allowance, or free taste + this network's
//      month + an IPv6 block's share of today + today's budget);
//   4. ask the model; give the reservation back only if the provider
//      certainly did not charge for the call;
//   5. answer.
// Reserving before the model call is what makes the limits exact: two
// requests at the same moment cannot both use the last free check.

import {
  FREE_CHECKS, FREE_CHECKS_PER_NETWORK, MAX_IMAGE_BYTES, MAX_IMAGE_HEIGHT, MAX_IMAGE_WIDTH,
  OVER_ALLOWANCE_INTERVAL_SECONDS, freeDailyBudget, freeDailyShare, modelKeyOk
} from './config.js';
import { fail, failRetry } from './http.js';
import {
  attachLicense, getUsage, releaseFreeBlock, releaseFreeBudget, releaseFreeCheck, releaseFreeNetwork,
  releasePaidCheck, reserveFreeBlock, reserveFreeBudget, reserveFreeCheck, reserveFreeNetwork, reservePaidCheck
} from './db.js';
import { limit } from './limits.js';
import { requireDevice } from './devices.js';
import { licenseFromRequest, loadLicense } from './account.js';
import { accessFor, displayStatus, failAccess, freeUsage, includedChecksFor, paidUsage } from './access.js';
import { UpstreamError, analyze } from './model.js';
import { ipHashFor } from './ids.js';
import { dayKey, iso, monthKey, nextDayStart, nextMonthStart } from './time.js';

const MAX_DISPLAYS = 3;
const MAX_TASKS = 20;
const MAX_TASK_LENGTH = 400;
const MAX_WORK_DESCRIPTION = 500;
const MAX_FRONT_APP = 80;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const DAILY_BUDGET_MESSAGE = 'Free checks are paused for today because of demand. They come back after midnight UTC, or subscribe to keep going.';
const NETWORK_USED_UP_MESSAGE = 'This network has used its free checks for this month. Subscribe to keep Grayout watching.';
const BLOCK_SHARE_MESSAGE = 'Free checks from this network are paused for today because of demand. They come back after midnight UTC, or subscribe to keep going.';
const SANDBOX_BUDGET_MESSAGE = 'This is the sandbox service, and its checks for today are used up. They come back after midnight UTC.';

// ---------------------------------------------------------------- validation

/**
 * Width and height from a JPEG's frame header (its SOF marker), or null when
 * the bytes are not a JPEG we can read. JPEG is a list of segments, each
 * "FF <marker> <2-byte length> <data>"; the frame header holds the size.
 */
export function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // no start-of-image
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // not at a segment: not a JPEG we understand
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; } // padding byte
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data, before any frame header
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // C0-CF are frame headers, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * Bytes from the start of a base64 string, or null when it cannot be decoded.
 * atob() throws on a malformed string; that must come back as 400 bad_request,
 * never as a 500 (which the app would retry with the same bad body).
 */
function base64Prefix(data, chars) {
  // A multiple of 4 characters is always a whole number of bytes.
  let binary;
  try {
    binary = atob(data.slice(0, chars - (chars % 4)));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * One image of a check: base64 JPEG data, at most MAX_IMAGE_BYTES, at most
 * MAX_IMAGE_WIDTH wide and MAX_IMAGE_HEIGHT tall. Bigger images cost more per
 * check than the budgets and the price assume, so they are refused outright.
 */
function image(value, label) {
  if (typeof value !== 'string') fail('bad_request', { message: `The ${label} is not base64 image data.` });
  const data = value.replace(/\s+/g, '');
  if (!data || !BASE64_RE.test(data)) fail('bad_request', { message: `The ${label} is not base64 image data.` });
  // Base64 comes in groups of 4 characters. A string 1 character past a whole
  // group can never be decoded, and "=" may only pad a complete last group.
  // Checked on the whole string, because only the start is decoded below.
  if (data.length % 4 === 1 || (data.endsWith('=') && data.length % 4 !== 0)) {
    fail('bad_request', { message: `The ${label} is not base64 image data.` });
  }

  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) fail('bad_request', { message: `The ${label} is larger than ${MAX_IMAGE_BYTES} bytes.` });

  // The frame header is near the start; 64 KiB of base64 is plenty for the
  // JPEGs the app makes, and saves decoding the whole picture.
  const prefix = base64Prefix(data, 65536);
  if (!prefix) fail('bad_request', { message: `The ${label} is not base64 image data.` });
  const size = jpegSize(prefix);
  if (!size) fail('bad_request', { message: `The ${label} is not a JPEG this service can read.` });
  if (size.width > MAX_IMAGE_WIDTH || size.height > MAX_IMAGE_HEIGHT) {
    fail('bad_request', { message: `The ${label} must be at most ${MAX_IMAGE_WIDTH} pixels wide and ${MAX_IMAGE_HEIGHT} tall.` });
  }
  return data;
}

function optionalString(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    fail('bad_request', { message: `The ${label} must be text of at most ${max} characters.` });
  }
  return value;
}

function taskList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TASKS || value.some(t => typeof t !== 'string')) {
    fail('bad_request', { message: `The ${label} must be a list of at most ${MAX_TASKS} lines of text.` });
  }
  return value.filter(t => t.trim()).map(t => t.slice(0, MAX_TASK_LENGTH));
}

/** Every field of a check body, checked before anything else happens. */
export function validateCheckBody(body) {
  const displays = body.displays;
  if (!Array.isArray(displays) || displays.length < 1 || displays.length > MAX_DISPLAYS) {
    fail('bad_request', { message: `A check needs 1 to ${MAX_DISPLAYS} screenshots.` });
  }
  const frames = displays.map((d, i) => image(d, `screenshot of display ${i + 1}`));
  const webcam = body.webcam === undefined || body.webcam === null || body.webcam === ''
    ? null
    : image(body.webcam, 'webcam photo');

  const ctx = body.context === undefined || body.context === null ? {} : body.context;
  if (typeof ctx !== 'object' || Array.isArray(ctx)) fail('bad_request', { message: 'The context must be an object.' });
  const context = {
    workDescription: optionalString(ctx.workDescription, MAX_WORK_DESCRIPTION, 'work description') || '',
    frontApp: optionalString(ctx.frontApp, MAX_FRONT_APP, 'front app name') || null,
    canvasTasks: taskList(ctx.canvasTasks, 'coursework list'),
    fileTasks: taskList(ctx.fileTasks, 'task list')
  };
  return { displays: frames, webcam, context };
}

// ---------------------------------------------------------------- reservations

/** Reserve one paid check for a licensed request. */
async function reservePaid(deps, device, key, ipKey) {
  const { env } = deps;
  const db = env.DB;
  const license = await loadLicense(deps, key);
  // The per-license limit comes BEFORE the access decision, because deciding
  // can mean a Stripe read: a flood of checks is stopped before it costs one.
  await limit(env, 'RL_LICENSE', `lic:${license.id}`);
  const access = await accessFor(deps, license, { ipKey });
  if (!access.allow) failAccess(env, access.code, access.why);

  const now = deps.now();
  const month = monthKey(now);
  // 10,000 a month, or 1,000 while the subscription is still a free trial.
  const used = await reservePaidCheck(db, {
    licenseId: license.id, month, now, included: includedChecksFor(access.license), slowInterval: OVER_ALLOWANCE_INTERVAL_SECONDS
  });
  if (used === null) {
    // Over the allowance: one check per 10 minutes until the month resets.
    const usage = await getUsage(db, { licenseId: license.id, month });
    const resetsAt = iso(nextMonthStart(now));
    failRetry('quota_exceeded', usage.last_at + OVER_ALLOWANCE_INTERVAL_SECONDS - now,
      `Monthly checks used up: checking every 10 minutes until ${resetsAt}.`);
  }

  // A test license (only the sandbox Worker serves them) was bought with a
  // test card, so nobody paid for its checks. Each one also comes out of
  // today's free budget, so test keys can never spend more on the model than
  // FREE_DAILY_BUDGET a day, however many of them someone makes.
  const testDay = license.livemode === 1 ? null : dayKey(now);
  if (testDay && (await reserveFreeBudget(db, { day: testDay, budget: freeDailyBudget(env) })) === null) {
    await releasePaidCheck(db, { licenseId: license.id, month });
    failRetry('quota_exceeded', nextDayStart(now) - now, SANDBOX_BUDGET_MESSAGE);
  }

  if (device.license_id !== license.id) {
    await attachLicense(db, { deviceId: device.device_id, licenseId: license.id, now });
  }
  return {
    giveBack: async () => {
      await releasePaidCheck(db, { licenseId: license.id, month });
      if (testDay) await releaseFreeBudget(db, testDay);
    },
    usage: paidUsage(access.license, used, now),
    plan: displayStatus(access.license.status)
  };
}

/**
 * Reserve one free check, in up to four steps: one of this device's 100, one
 * of this network's 300 for the month (so minting new devices does not help),
 * for IPv6 one of its /48 block's share of today (so a whole /48 of networks
 * cannot drain the day), and one of today's budget for everyone. A step that
 * fails gives back the ones before it.
 */
async function reserveFree(deps, device, netKey, blockKey) {
  const { env } = deps;
  const db = env.DB;
  // A device that paid before and turned up without its key is told to
  // restore it, never to subscribe again.
  if (device.license_id) fail('no_license');
  await limit(env, 'RL_FREE_IP', netKey);

  const now = deps.now();
  const deviceId = device.device_id;
  const used = await reserveFreeCheck(db, { deviceId, now, limit: FREE_CHECKS });
  if (used === null) fail('free_exhausted', { extra: { reason: 'device' } });

  // A keyed hash of the network, so the database never holds the address.
  const network = { netHash: await ipHashFor(env.DEVICE_SECRET, netKey), month: monthKey(now) };
  const networkUsed = await reserveFreeNetwork(db, { ...network, cap: FREE_CHECKS_PER_NETWORK });
  if (networkUsed === null) {
    await releaseFreeCheck(db, deviceId);
    fail('free_exhausted', { message: NETWORK_USED_UP_MESSAGE, extra: { reason: 'device' } });
  }

  const day = dayKey(now);
  // IPv6 only (blockKey is null for IPv4, whose network is one address).
  const block = blockKey ? { blockHash: await ipHashFor(env.DEVICE_SECRET, blockKey), day } : null;
  if (block && (await reserveFreeBlock(db, { ...block, cap: freeDailyShare(env) })) === null) {
    await releaseFreeCheck(db, deviceId);
    await releaseFreeNetwork(db, network);
    fail('free_exhausted', { message: BLOCK_SHARE_MESSAGE, extra: { reason: 'daily_budget' } });
  }

  const spent = await reserveFreeBudget(db, { day, budget: freeDailyBudget(env) });
  if (spent === null) {
    await releaseFreeCheck(db, deviceId);
    await releaseFreeNetwork(db, network);
    if (block) await releaseFreeBlock(db, block);
    fail('free_exhausted', { message: DAILY_BUDGET_MESSAGE, extra: { reason: 'daily_budget' } });
  }
  return {
    giveBack: async () => {
      await releaseFreeCheck(db, deviceId);
      await releaseFreeNetwork(db, network);
      if (block) await releaseFreeBlock(db, block);
      await releaseFreeBudget(db, day);
    },
    usage: freeUsage(used),
    plan: 'free'
  };
}

// ---------------------------------------------------------------- the endpoint

export async function postCheck(deps, { request, body, ipKey, netKey, blockKey = null }) {
  const { env } = deps;

  // 1. Validate everything first.
  const input = validateCheckBody(body);
  if (body.license !== undefined && body.license !== null && typeof body.license !== 'string') {
    fail('bad_request', { message: 'The license has to be a string.' });
  }

  // 2. The device.
  const device = await requireDevice(deps, body);
  await limit(env, 'RL_DEVICE', `dev:${device.device_id}`);
  if (!modelKeyOk(env.OPENAI_API_KEY)) fail('not_configured');

  // 3. Reserve one check.
  const key = licenseFromRequest(request, body);
  const reservation = key
    ? await reservePaid(deps, device, key, ipKey)
    : await reserveFree(deps, device, netKey || ipKey, blockKey);

  // 4. Ask the model. A failure the provider did not charge for (no
  //    connection, an error status) gives the check back. A failure it DID
  //    charge for (a refusal, an incomplete or unreadable answer, a timeout)
  //    stays counted: otherwise a caller who makes the model fail on purpose
  //    could spend the model key without limit. The app treats both as on-task.
  let result;
  try {
    result = await analyze(input, { apiKey: env.OPENAI_API_KEY, model: env.MODEL, fetchImpl: deps.fetchImpl });
  } catch (err) {
    const billed = err instanceof UpstreamError && err.billed;
    if (!billed) await reservation.giveBack();
    if (err instanceof UpstreamError) fail('upstream_unavailable');
    throw err;
  }

  // 5. The verdict and the usage after this check.
  return { verdict: result.verdict, usage: reservation.usage, plan: reservation.plan, service: true };
}
