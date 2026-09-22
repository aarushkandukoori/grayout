// The Grayout API. One Worker, eight endpoints, no database beyond KV.
//
// Contract: docs/API-CONTRACT.md. Errors are always
// { error: { code, message } } with the code from the contract's list, and
// every response carries X-Grayout-Request-Id.

import { kvStore, keys } from './store.js';
import {
  constantTimeEqual, generateDeviceCode, isDeviceCodeShape, isLicenseShape,
  normalizeDeviceCode, normalizeLicense
} from './license.js';
import {
  MAX_BODY_BYTES, enforceBurstLimit, enforceRateLimits, freeExhausted, freeUsage,
  licenseUsage, overAllowance, readDevice, recordCheck, writeDevice
} from './quota.js';
import { UpstreamError, analyze } from './check.js';
import {
  PLANS, createCheckoutSession, createPortalSession, createStripeClient,
  customerIdOf, handleStripeEvent, retrieveCheckoutSession, sessionIsComplete,
  statusGrantsService, verifyWebhook
} from './stripe.js';

const DEVICE_CODE_TTL_SECONDS = 900;
const MAX_DISPLAYS = 3;
const MAX_TASKS = 20;
const MAX_WORK_DESCRIPTION = 500;
const MAX_FRONT_APP = 80;

const DEFAULT_SITE_ORIGINS = 'https://aarushkandukoori.github.io,https://grayout.app,https://www.grayout.app';

/** Every error code this service can return, with its status and its sentence. */
export const ERRORS = {
  no_license: { status: 401, message: 'This device needs its Grayout license key. Open Grayout and activate it again.' },
  license_invalid: { status: 401, message: 'That license key is not one this service issued.' },
  license_revoked: { status: 403, message: 'That license key has been revoked.' },
  trial_expired: { status: 402, message: 'The free trial has ended. Subscribe to keep Grayout watching.' },
  subscription_inactive: { status: 402, message: 'This subscription is no longer active.' },
  free_exhausted: { status: 402, message: 'The free checks are used up. Subscribe to keep Grayout watching.' },
  quota_exceeded: { status: 429, message: 'This month of checks is used up. Grayout will check less often until the allowance resets.' },
  rate_limited: { status: 429, message: 'Too many checks too quickly. Wait a moment and try again.' },
  upstream_unavailable: { status: 502, message: 'The model provider did not answer. Grayout treats this as on task.' },
  payload_too_large: { status: 413, message: 'That request is larger than the 8 MB limit.' },
  // Not in the contract's list of codes the watch loop handles by name, but
  // returned in the same envelope.
  bad_request: { status: 400, message: 'That request is missing something or has a value this service cannot read.' },
  code_expired: { status: 404, message: 'That device code has expired. Start the purchase again from the app.' },
  invalid_signature: { status: 400, message: 'That webhook signature did not verify.' },
  not_found: { status: 404, message: 'There is nothing at that path.' },
  method_not_allowed: { status: 405, message: 'That path does not take this method.' },
  not_configured: { status: 503, message: 'This service is missing a setting it needs. Try again shortly.' },
  internal_error: { status: 500, message: 'Something went wrong in this service.' }
};

class ApiError extends Error {
  constructor(code, { message, headers } = {}) {
    const known = ERRORS[code] || ERRORS.internal_error;
    super(message || known.message);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'internal_error';
    this.status = known.status;
    this.headers = headers || {};
  }
}

function fail(code, options) { throw new ApiError(code, options); }

// ---------------------------------------------------------------- responses

function allowedOrigins(env) {
  return String(env.SITE_ORIGINS || DEFAULT_SITE_ORIGINS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = { Vary: 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Grayout-Request-Id';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function requestIdFor(request) {
  const given = request.headers.get('X-Grayout-Request-Id');
  if (given && REQUEST_ID_RE.test(given)) return given;
  return crypto.randomUUID();
}

function json(body, { status = 200, requestId, cors = {}, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Grayout-Request-Id': requestId,
      ...cors,
      ...headers
    }
  });
}

function errorResponse(err, { requestId, cors }) {
  const api = err instanceof ApiError ? err : new ApiError('internal_error');
  return json({ error: { code: api.code, message: api.message } }, {
    status: api.status, requestId, cors, headers: api.headers
  });
}

// ---------------------------------------------------------------- input

async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) fail('payload_too_large');
  let text;
  try {
    text = await request.text();
  } catch {
    fail('bad_request', { message: 'This service could not read that request body.' });
  }
  // A chunked request can arrive without a length, so measure it too.
  if (text.length > MAX_BODY_BYTES) fail('payload_too_large');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('bad_request', { message: 'This service expects a JSON object.' });
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail('bad_request', { message: 'That request body is not valid JSON.' });
  }
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function requireDeviceId(value) {
  const id = String(value === null || value === undefined ? '' : value).trim();
  if (!DEVICE_ID_RE.test(id)) fail('bad_request', { message: 'That request needs a deviceId.' });
  return id;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function requireImage(value, label) {
  const data = String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');
  if (!data || !BASE64_RE.test(data)) {
    fail('bad_request', { message: `The ${label} is not base64 image data.` });
  }
  return data;
}

function cleanTasks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(t => typeof t === 'string' && t.trim())
    .slice(0, MAX_TASKS)
    .map(t => t.slice(0, 400));
}

function cleanContext(value) {
  const ctx = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const frontApp = typeof ctx.frontApp === 'string' ? ctx.frontApp.slice(0, MAX_FRONT_APP) : null;
  return {
    workDescription: typeof ctx.workDescription === 'string' ? ctx.workDescription.slice(0, MAX_WORK_DESCRIPTION) : '',
    frontApp: frontApp || null,
    canvasTasks: cleanTasks(ctx.canvasTasks),
    fileTasks: cleanTasks(ctx.fileTasks)
  };
}

// ---------------------------------------------------------------- licenses

/**
 * Resolve a supplied license to its record, or throw the contract's code.
 *
 * The second comparison looks redundant next to the KV lookup, and it is not:
 * it is the one place a supplied key is checked against a stored key, and the
 * contract requires that comparison to be constant time.
 */
async function loadLicense(store, supplied) {
  const key = normalizeLicense(supplied);
  if (!isLicenseShape(key)) fail('license_invalid');
  const record = await store.get(keys.license(key));
  if (!record) fail('license_invalid');
  if (record.customerId) {
    const canonical = await store.get(keys.customer(record.customerId));
    if (canonical && !constantTimeEqual(canonical, key)) fail('license_invalid');
  }
  if (record.revokedAt) fail('license_revoked');
  return { license: key, record };
}

function assertServiceable(record, now) {
  const status = record.status || 'canceled';
  if (status === 'trialing' && record.periodEnd && Date.parse(record.periodEnd) <= now) fail('trial_expired');
  if (!statusGrantsService(status)) fail('subscription_inactive');
  return status;
}

// ---------------------------------------------------------------- endpoints

async function postCheck(request, deps, body) {
  const { store, env, now } = deps;
  const deviceId = requireDeviceId(body.deviceId);

  const displays = Array.isArray(body.displays) ? body.displays : [];
  if (!displays.length) fail('bad_request', { message: 'That check has no screenshots.' });
  if (displays.length > MAX_DISPLAYS) fail('bad_request', { message: `A check takes at most ${MAX_DISPLAYS} displays.` });
  const frames = displays.map((d, i) => requireImage(d, `screenshot of display ${i + 1}`));
  const webcam = body.webcam === null || body.webcam === undefined || body.webcam === ''
    ? null
    : requireImage(body.webcam, 'webcam photo');
  const context = cleanContext(body.context);

  const supplied = typeof body.license === 'string' ? body.license.trim() : '';
  const device = await readDevice(store, deviceId);

  // The device window is spent before the license is even looked at, so a
  // client guessing keys is capped at the same 40 a minute as a real one.
  const deviceLimited = await enforceRateLimits(store, { deviceId, now: now() });
  if (!deviceLimited.ok) {
    fail('rate_limited', { headers: { 'Retry-After': String(deviceLimited.retryAfter) } });
  }

  let license = null;
  let record = null;
  let plan = 'free';

  if (supplied) {
    const resolved = await loadLicense(store, supplied);
    license = resolved.license;
    record = resolved.record;
    plan = assertServiceable(record, now());
  } else if (device.license) {
    // This device has paid before and has now turned up without its key.
    fail('no_license');
  } else if (freeExhausted(device)) {
    fail('free_exhausted');
  }

  if (license) {
    const licenseLimited = await enforceRateLimits(store, { license, now: now() });
    if (!licenseLimited.ok) {
      fail('rate_limited', { headers: { 'Retry-After': String(licenseLimited.retryAfter) } });
    }
  }

  let usage = license ? await licenseUsage(store, license, record, now()) : freeUsage(device);
  if (license && overAllowance(usage)) {
    fail('quota_exceeded', { headers: { 'Retry-After': '3600' } });
  }

  let result;
  try {
    result = await analyze({ displays: frames, webcam, context }, {
      apiKey: env.OPENAI_API_KEY,
      model: env.MODEL,
      fetchImpl: deps.fetchImpl
    });
  } catch (err) {
    if (err instanceof UpstreamError) fail('upstream_unavailable', { message: err.message });
    throw err;
  }

  // Only a real verdict is billed.
  usage = await recordCheck(store, { deviceId, license, record, now: now() });

  return { verdict: result.verdict, usage, plan };
}

async function postDeviceCode(request, deps, body) {
  const { store, now } = deps;
  const deviceId = requireDeviceId(body.deviceId);
  await burst(deps, `code:${deviceId}`);

  const deviceCode = generateDeviceCode();
  await store.put(keys.code(normalizeDeviceCode(deviceCode)), {
    deviceId,
    createdAt: new Date(now()).toISOString()
  }, { expirationTtl: DEVICE_CODE_TTL_SECONDS });

  return { deviceCode, expiresIn: DEVICE_CODE_TTL_SECONDS };
}

async function postCheckout(request, deps, body) {
  const { store, env } = deps;
  const deviceId = requireDeviceId(body.deviceId);
  await burst(deps, `checkout:${deviceId}`);

  const plan = PLANS.includes(body.plan) ? body.plan : null;
  if (!plan) fail('bad_request', { message: 'The plan has to be monthly or yearly.' });

  let deviceCode = null;
  if (body.deviceCode) {
    deviceCode = normalizeDeviceCode(body.deviceCode);
    if (!isDeviceCodeShape(deviceCode)) fail('bad_request', { message: 'That device code is not the right shape.' });
    if (!(await store.get(keys.code(deviceCode)))) fail('code_expired');
  }

  const stripe = deps.stripe();
  let session;
  try {
    session = await createCheckoutSession(stripe, { plan, deviceId, deviceCode, env });
  } catch (err) {
    // Stripe's own wording names prices and accounts. It belongs in the log,
    // not in a response.
    console.error(`checkout failed: ${oneLine(err)}`);
    fail('not_configured');
  }
  if (!session || !session.url) fail('not_configured');
  return { url: session.url };
}

// Stripe's own id shape. It arrives in the success URL, so it is a bearer
// credential with the same weight as a device code: whoever holds it can read
// the license it bought, and nothing else.
const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{8,200}$/;

/**
 * Claim by Checkout Session id, for a purchase that started on the website.
 *
 * The app's own flow never needs this: it makes a device code first and the
 * webhook attaches the license to it. A purchase begun in a browser has no
 * device code to attach to, so without this the person pays and has no way at
 * all to reach their key.
 */
async function claimBySession(deps, sessionId) {
  const { store } = deps;
  if (!SESSION_ID_RE.test(sessionId)) fail('bad_request', { message: 'That checkout session id is not the right shape.' });
  // The success page asks once; a poll behind it is somebody probing.
  await burst(deps, `claim:s:${sessionId}`, 20);

  let session;
  try {
    session = await retrieveCheckoutSession(deps.stripe(), sessionId);
  } catch (err) {
    // A session id that Stripe does not know is the same dead end as an
    // expired device code, and Stripe's wording names the account.
    console.error(`claim by session failed: ${oneLine(err)}`);
    fail('code_expired');
  }
  if (!sessionIsComplete(session)) return { status: 'pending' };

  const customerId = customerIdOf(session);
  if (!customerId) return { status: 'pending' };
  // The webhook issues the license; it may not have landed yet.
  const license = await store.get(keys.customer(customerId));
  if (!license) return { status: 'pending' };

  const record = await store.get(keys.license(license));
  if (!record || record.revokedAt) fail('license_revoked');
  return { status: 'ready', license };
}

async function getClaim(request, deps, url) {
  const { store } = deps;
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (sessionId) return claimBySession(deps, sessionId);

  const deviceCode = normalizeDeviceCode(url.searchParams.get('deviceCode') || '');
  if (!isDeviceCodeShape(deviceCode)) fail('bad_request', { message: 'That device code is not the right shape.' });
  // The app polls this every 2 seconds, which is 30 a minute. The ceiling sits
  // above that so honest polling never trips it and a runaway client does.
  await burst(deps, `claim:${deviceCode}`, 45);

  const record = await store.get(keys.code(deviceCode));
  if (!record) fail('code_expired');
  if (!record.license) return { status: 'pending' };
  return { status: 'ready', license: record.license };
}

async function postActivate(request, deps, body) {
  const { store, now } = deps;
  const deviceId = requireDeviceId(body.deviceId);
  await burst(deps, `activate:${deviceId}`);

  const { license, record } = await loadLicense(store, body.license);
  await writeDevice(store, deviceId, { license }, now());

  const status = record.status || 'canceled';
  return {
    plan: status,
    status,
    interval: record.plan || null,
    usage: await licenseUsage(store, license, record, now())
  };
}

async function getStatus(request, deps, url) {
  const { store, env, now } = deps;
  const deviceId = url.searchParams.get('deviceId');
  if (deviceId) requireDeviceId(deviceId);
  await burst(deps, `status:${deviceId || 'anon'}`);

  const { license, record } = await loadLicense(store, url.searchParams.get('license'));
  if (deviceId) await writeDevice(store, deviceId, { license }, now());

  const status = record.status || 'canceled';
  // A billing portal session is a live Stripe call and a single-use link, so it
  // is minted only when the app is about to open one.
  let portalUrl = null;
  if (record.customerId && url.searchParams.get('portal') === '1') {
    try {
      const session = await createPortalSession(deps.stripe(), { customerId: record.customerId, env });
      portalUrl = (session && session.url) || null;
    } catch {
      portalUrl = null;
    }
  }

  return {
    plan: status,
    status,
    interval: record.plan || null,
    usage: await licenseUsage(store, license, record, now()),
    portalUrl
  };
}

async function postPortal(request, deps, body) {
  const { store, env } = deps;
  const { record } = await loadLicense(store, body.license);
  if (!record.customerId) fail('subscription_inactive', { message: 'That license has no billing account to manage.' });

  let session;
  try {
    session = await createPortalSession(deps.stripe(), { customerId: record.customerId, env });
  } catch (err) {
    console.error(`billing portal failed: ${oneLine(err)}`);
    fail('not_configured');
  }
  if (!session || !session.url) fail('not_configured');
  return { url: session.url };
}

async function postWebhook(request, deps) {
  const { store, env, now } = deps;
  const signature = request.headers.get('stripe-signature');
  if (!signature) fail('invalid_signature', { message: 'That webhook arrived without a signature.' });
  if (!env.STRIPE_WEBHOOK_SECRET) fail('not_configured');

  const payload = await request.text();
  if (payload.length > MAX_BODY_BYTES) fail('payload_too_large');

  let event;
  try {
    event = await verifyWebhook(deps.stripe(), { payload, signature, secret: env.STRIPE_WEBHOOK_SECRET });
  } catch {
    fail('invalid_signature');
  }

  const outcome = await handleStripeEvent(event, { store, env, now: now() });
  // Anything that is not a 2xx makes Stripe retry, so an unknown event type is
  // acknowledged rather than rejected.
  return { received: true, action: outcome.action };
}

// ---------------------------------------------------------------- plumbing

function oneLine(err) {
  return String((err && err.message) || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);
}

/** A cheap per-device limiter for the endpoints that are not the watch loop. */
async function burst(deps, key, limit) {
  const limited = await enforceBurstLimit(deps.store, { key, limit, now: deps.now() });
  if (!limited.ok) fail('rate_limited', { headers: { 'Retry-After': String(limited.retryAfter) } });
}

const ROUTES = {
  'POST /v1/check': (req, deps, url, body) => postCheck(req, deps, body),
  'POST /v1/checkout': (req, deps, url, body) => postCheckout(req, deps, body),
  'POST /v1/device-code': (req, deps, url, body) => postDeviceCode(req, deps, body),
  'GET /v1/claim': (req, deps, url) => getClaim(req, deps, url),
  'POST /v1/activate': (req, deps, url, body) => postActivate(req, deps, body),
  'GET /v1/status': (req, deps, url) => getStatus(req, deps, url),
  'POST /v1/portal': (req, deps, url, body) => postPortal(req, deps, body),
  'POST /v1/stripe/webhook': (req, deps) => postWebhook(req, deps),
  'GET /v1/health': () => ({ ok: true })
};

const PATHS = new Set(Object.keys(ROUTES).map(k => k.split(' ')[1]));

/**
 * The whole service, with its dependencies passed in so a test can drive it
 * against a Map and a stub fetch.
 *
 * deps: { store, env, now(), stripe(), fetchImpl }
 */
export async function handleRequest(request, deps) {
  const url = new URL(request.url);
  const requestId = requestIdFor(request);
  const cors = corsHeaders(request, deps.env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'X-Grayout-Request-Id': requestId, ...cors } });
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = ROUTES[`${request.method} ${path}`];

  try {
    if (!route) {
      // A known path with the wrong verb is a different mistake from a typo.
      if (PATHS.has(path)) fail('method_not_allowed');
      fail('not_found');
    }
    // The webhook needs the raw body for its signature, so it reads its own.
    const body = request.method === 'POST' && path !== '/v1/stripe/webhook' ? await readJson(request) : null;
    const payload = await route(request, deps, url, body);
    return json(payload, { requestId, cors });
  } catch (err) {
    if (!(err instanceof ApiError)) {
      // Never let a stack trace or a provider message out.
      console.error(`[${requestId}] ${path} ${oneLine(err)}`);
    }
    return errorResponse(err, { requestId, cors });
  }
}

export default {
  async fetch(request, env) {
    const store = kvStore(env.GRAYOUT_KV);
    let stripeClient = null;
    const deps = {
      store,
      env,
      now: () => Date.now(),
      fetchImpl: fetch,
      stripe: () => {
        if (!env.STRIPE_SECRET_KEY) throw new ApiError('not_configured');
        if (!stripeClient) stripeClient = createStripeClient(env.STRIPE_SECRET_KEY);
        return stripeClient;
      }
    };
    return handleRequest(request, deps);
  }
};

export { ApiError };
