// The Grayout API: one Cloudflare Worker. This file is the front door. It
// finds the route, applies the shared rules (methods, content type, body
// limits, CORS, the per-IP limit, the request id) and turns any error into the
// contract's envelope. Each endpoint lives in its own file.
//
// The specification is docs/API-CONTRACT.md (v3). Where this code and the
// contract disagree, the contract wins.

import {
  BLOCK_V6_PREFIX_BITS, CONTRACT_VERSION, MAX_BODY_BYTES, MAX_CHECK_BODY_BYTES, NETWORK_V6_PREFIX_BITS,
  configuredFlags, liveKeyMode, stripeKeyOk
} from './config.js';
import {
  ApiError, corsHeaders, describeError, errorResponse, fail, ipKeyFor, isJsonContentType,
  jsonResponse, logLine, parseJsonObject, readBodyText, requestIdFor, v6BlockKeyFor
} from './http.js';
import { limit } from './limits.js';
import { postDevice, postDeviceCode, postRestore } from './devices.js';
import { postCheckout, postClaim } from './purchase.js';
import { postActivate, postPortal, postStatus } from './account.js';
import { postCheck } from './check.js';
import { postWebhook } from './webhook.js';
import { runCleanup } from './cleanup.js';
import { stripeClientFor } from './stripe.js';
import { nowSeconds } from './time.js';

/**
 * GET /v1/health. `mode` says whether the Stripe key is live or a sandbox
 * key ("test"), or null when there is no usable key. Never a secret's value.
 */
function getHealth(deps) {
  const env = deps.env;
  const mode = stripeKeyOk(env.STRIPE_SECRET_KEY) ? (liveKeyMode(env) ? 'live' : 'test') : null;
  return { ok: true, contract: CONTRACT_VERSION, mode, configured: configuredFlags(env) };
}

/**
 * Every route. `cors`: browsers on the site may read it. `ipLimit`: the
 * per-IP rate-limit binding it counts against (spent BEFORE the body is read).
 * `maxBytes`: body limit. `raw`: the handler reads the body itself (the
 * webhook needs the exact bytes for its signature).
 *
 * /v1/check has its own binding, RL_CHECK_IP: its bodies are up to 8 MB, so
 * without a per-IP limit in front, anyone could make the Worker read and parse
 * 8 MB of junk as often as they liked before any device check refused it.
 */
const ROUTES = {
  'GET /v1/health': { handler: getHealth, cors: true, noDb: true },
  'POST /v1/device': { handler: postDevice, cors: true, ipLimit: 'RL_IP' },
  'POST /v1/device-code': { handler: postDeviceCode, ipLimit: 'RL_IP' },
  'POST /v1/checkout': { handler: postCheckout, cors: true, ipLimit: 'RL_IP' },
  'POST /v1/claim': { handler: postClaim, cors: true, ipLimit: 'RL_IP' },
  'POST /v1/restore': { handler: postRestore, ipLimit: 'RL_IP' },
  'POST /v1/activate': { handler: postActivate, ipLimit: 'RL_IP' },
  'POST /v1/status': { handler: postStatus, ipLimit: 'RL_IP' },
  'POST /v1/portal': { handler: postPortal, ipLimit: 'RL_IP' },
  'POST /v1/check': { handler: postCheck, ipLimit: 'RL_CHECK_IP', maxBytes: MAX_CHECK_BODY_BYTES },
  'POST /v1/stripe/webhook': { handler: postWebhook, raw: true }
};

const PATHS = new Map();
for (const key of Object.keys(ROUTES)) {
  const [method, path] = key.split(' ');
  if (!PATHS.has(path)) PATHS.set(path, []);
  PATHS.get(path).push(method);
}

/** True if any method on this path serves browsers. */
function pathAllowsCors(path) {
  return (PATHS.get(path) || []).some(method => ROUTES[`${method} ${path}`].cors);
}

/**
 * The whole service, with its dependencies passed in so a test can drive it:
 * deps = { env, now() (Unix seconds), stripe() (a client), fetchImpl }.
 */
export async function handleRequest(request, deps) {
  const requestId = requestIdFor(request);
  // Query strings are ignored everywhere: nothing secret may ride in a URL.
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const route = ROUTES[`${request.method} ${path}`];
  const cors = pathAllowsCors(path) ? corsHeaders(request, deps.env) : {};

  // A browser's preflight, for the routes that serve the site.
  if (request.method === 'OPTIONS' && pathAllowsCors(path)) {
    return jsonResponse(null, { status: 204, requestId, headers: cors });
  }

  try {
    if (!route) fail(PATHS.has(path) ? 'method_not_allowed' : 'not_found');
    if (!route.noDb && !deps.env.DB) fail('not_configured');

    // ipKey: the address (IPv6 by /64) for ordinary limits. netKey: the
    // network (IPv6 by /56) for minting devices and free checks. blockKey:
    // the IPv6 /48 a network sits in (null for IPv4), for the daily share of
    // free checks one block may take.
    const ipKey = ipKeyFor(request);
    const netKey = ipKeyFor(request, NETWORK_V6_PREFIX_BITS);
    const blockKey = v6BlockKeyFor(request, BLOCK_V6_PREFIX_BITS);
    // The per-IP limit comes first, so a flood is refused before its body is read.
    if (route.ipLimit) await limit(deps.env, route.ipLimit, ipKey);
    let body = null;
    if (request.method === 'POST' && !route.raw) {
      // JSON only. A text/plain POST would skip the browser's preflight and
      // let a hostile page spend our model key through its visitors.
      if (!isJsonContentType(request)) fail('bad_request', { message: 'Send the request as application/json.' });
      body = parseJsonObject(await readBodyText(request, route.maxBytes || MAX_BODY_BYTES));
    }

    const payload = await route.handler(deps, { request, body, ipKey, netKey, blockKey, requestId });
    return jsonResponse(payload, { requestId, headers: cors });
  } catch (err) {
    if (!(err instanceof ApiError)) {
      // A bug or a failed dependency. Log what happened, never a request body.
      logLine('internal_error', { requestId, route: path, error: describeError(err) });
    } else if (err.status >= 500) {
      logLine('request_failed', { requestId, route: path, status: err.status, code: err.code });
    }
    return errorResponse(err, { requestId, headers: cors });
  }
}

/** The real dependencies, for the deployed Worker. */
function liveDeps(env) {
  return {
    env,
    now: nowSeconds,
    fetchImpl: (url, init) => fetch(url, init),
    stripe: () => stripeClientFor(env)
  };
}

export default {
  fetch(request, env) {
    return handleRequest(request, liveDeps(env));
  },
  // The daily cron in wrangler.jsonc (contract 12.4).
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runCleanup(env, nowSeconds()));
  }
};
