// The plumbing every endpoint shares: the error codes, JSON responses, CORS,
// the request id, reading a body safely, the caller's IP key, and logging.

import { siteOrigins } from './config.js';

/** Every error code the service can return, with its HTTP status and default sentence. */
export const ERRORS = {
  bad_request: { status: 400, message: 'That request is missing something or has a value this service cannot read.' },
  invalid_signature: { status: 400, message: 'That webhook signature did not verify.' },
  device_unverified: { status: 401, message: 'This device is not registered with the Grayout service.' },
  no_license: { status: 401, message: 'This Mac has a Grayout license on file. Restore it in Settings, or paste the key.' },
  license_invalid: { status: 401, message: 'That license key is not one Grayout issued.' },
  free_exhausted: { status: 402, message: 'Free checks used up. Subscribe to keep Grayout watching.' },
  trial_expired: { status: 402, message: 'Your trial ended. Subscribe in Settings.' },
  subscription_inactive: { status: 402, message: 'Your subscription is not active. Update your payment in Manage billing or at link.com.' },
  license_revoked: { status: 403, message: 'This subscription was refunded or disputed.' },
  code_expired: { status: 404, message: 'That purchase link has expired.' },
  not_found: { status: 404, message: 'There is nothing at that path.' },
  method_not_allowed: { status: 405, message: 'That path does not take this method.' },
  already_subscribed: { status: 409, message: 'You already have a Grayout subscription. Manage it in Manage billing instead of buying again.' },
  payload_too_large: { status: 413, message: 'That request is too large.' },
  quota_exceeded: { status: 429, message: 'Monthly checks used up: checking every 10 minutes until the month resets.' },
  rate_limited: { status: 429, message: 'Too many requests. Wait a moment and try again.' },
  internal_error: { status: 500, message: 'Something went wrong in the Grayout service. Try again later.' },
  upstream_unavailable: { status: 502, message: 'The model provider did not give a usable answer. Grayout treats this check as on-task.' },
  not_configured: { status: 503, message: 'The Grayout service is missing a setting it needs. Try again later.' }
};

/**
 * An error with a contract code. `extra` carries the one extra field some
 * codes add (portalUrl, reason, retryAfter); `headers` carries Retry-After.
 */
export class ApiError extends Error {
  constructor(code, { message, extra, headers } = {}) {
    const known = ERRORS[code] || ERRORS.internal_error;
    super(message || known.message);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'internal_error';
    this.status = known.status;
    this.extra = extra || {};
    this.headers = headers || {};
  }
}

/** Stop this request with a contract error. */
export function fail(code, options) {
  throw new ApiError(code, options);
}

/** A 429 with both the Retry-After header and the retryAfter field. */
export function failRetry(code, seconds, message) {
  const retryAfter = Math.max(1, Math.ceil(seconds));
  fail(code, { message, extra: { retryAfter }, headers: { 'Retry-After': String(retryAfter) } });
}

// ---------------------------------------------------------------- responses

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The caller's request id if it is a sane one, otherwise a fresh UUID. */
export function requestIdFor(request) {
  const given = request.headers.get('X-Grayout-Request-Id');
  return given && REQUEST_ID_RE.test(given) ? given : crypto.randomUUID();
}

/** CORS headers, only for an allowed origin. Routes that serve no browser never call this. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !siteOrigins(env).includes(origin)) return { Vary: 'Origin' };
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Grayout-Request-Id',
    // A browser hides every response header except a short safe list unless
    // the server names it here. The site shows the request id when checkout
    // fails (the thing a bug report needs), and falls back on Retry-After
    // when a body has no retryAfter, so both have to be readable.
    'Access-Control-Expose-Headers': 'X-Grayout-Request-Id, Retry-After',
    'Access-Control-Max-Age': '86400'
  };
}

export function jsonResponse(body, { status = 200, requestId, headers = {} } = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Grayout-Request-Id': requestId,
      ...headers
    }
  });
}

/** Turn any thrown error into the contract's envelope. Never leaks a stack. */
export function errorResponse(err, { requestId, headers = {} }) {
  const api = err instanceof ApiError ? err : new ApiError('internal_error');
  const body = { error: { code: api.code, message: api.message, ...api.extra } };
  return jsonResponse(body, { status: api.status, requestId, headers: { ...headers, ...api.headers } });
}

// ---------------------------------------------------------------- reading a body

/** True for application/json, with or without a charset parameter. */
export function isJsonContentType(request) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/**
 * Read the body as text, counting bytes as they arrive and stopping the moment
 * the limit is crossed. A chunked upload with no Content-Length can therefore
 * never fill the isolate's memory.
 */
export async function readBodyText(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) fail('payload_too_large');
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch {
      fail('bad_request', { message: 'This service could not read that request body.' });
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > limit) {
      // Tell the sender to stop; the rest is never read.
      reader.cancel().catch(() => {});
      fail('payload_too_large');
    }
    chunks.push(step.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('bad_request', { message: 'That request body is not UTF-8 text.' });
  }
}

/** Parse a JSON object body. An empty body is {}. */
export function parseJsonObject(text) {
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('bad_request', { message: 'That request body is not valid JSON.' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('bad_request', { message: 'This service expects a JSON object.' });
  }
  return parsed;
}

// ---------------------------------------------------------------- the caller's network

/**
 * The rate-limit key for the caller's address: the full IPv4 address, or the
 * first `v6Bits` bits of an IPv6 address. "local" when there is no header
 * (wrangler dev, tests).
 *
 * Most routes use /64, because one IPv6 customer usually owns at least a /64.
 * Minting devices and free checks use /56 (NETWORK_V6_PREFIX_BITS): many hosts
 * own a /56 or more, and could otherwise rotate through 256 /64s for free.
 */
export function ipKeyFor(request, v6Bits = 64) {
  const raw = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (!raw) return 'local';
  // IPv4, or IPv4 written inside IPv6 (::ffff:1.2.3.4).
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (v4 && (!raw.includes(':') || /^::ffff:/i.test(raw))) return v4[1];
  if (!raw.includes(':')) return raw;
  return ipv6Prefix(raw, v6Bits);
}

/**
 * The IPv6 block (the first `bits` bits, /48 by default) the caller is in, or
 * null for IPv4 and for a missing header. IPv4 needs no block: one IPv4
 * network is a single address.
 */
export function v6BlockKeyFor(request, bits = 48) {
  const key = ipKeyFor(request, bits);
  return key.endsWith(`::/${bits}`) ? key : null;
}

/** "2001:db8:1:2::5", 64 → "2001:db8:1:2::/64"; "2001:db8:1:2ab::5", 56 → "2001:db8:1:200::/56". */
function ipv6Prefix(address, bits) {
  const [head, tail = ''] = address.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(g => parseInt(g, 16) || 0);
  // Keep the first `bits` bits: whole 16-bit groups, then part of the next one.
  const kept = [];
  for (let i = 0; i * 16 < bits; i++) {
    const bitsInGroup = Math.min(16, bits - i * 16);
    const mask = (0xffff << (16 - bitsInGroup)) & 0xffff;
    kept.push((groups[i] & mask).toString(16));
  }
  return `${kept.join(':')}::/${bits}`;
}

// ---------------------------------------------------------------- logging

/**
 * Remove anything secret-shaped from a line before it is logged: license keys,
 * session ids (all but the last 4), Stripe keys and webhook secrets. A second
 * line of defence; the first is never passing request bodies to a log at all.
 */
export function scrub(text) {
  return String(text)
    .replace(/gry_(live|test)_[0-9A-Za-z]+/g, 'gry_$1_…')
    .replace(/cs_(live|test)_[A-Za-z0-9]*([A-Za-z0-9]{4})/g, 'cs_$1_…$2')
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_…')
    .replace(/whsec_[A-Za-z0-9+/=_-]+/g, 'whsec_…')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** One structured log line. Only the fields the contract allows go in. */
export function logLine(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/** A short, safe description of a thrown error for the log. */
export function describeError(err) {
  if (!err) return 'unknown error';
  // Stripe errors carry a type and code that say enough without the message,
  // which can quote ids.
  if (err.type && typeof err.type === 'string' && err.type.startsWith('Stripe')) {
    return `${err.type}${err.code ? ` ${err.code}` : ''}${err.statusCode ? ` ${err.statusCode}` : ''}`;
  }
  return scrub(`${err.name || 'Error'}: ${err.message || ''}`);
}
