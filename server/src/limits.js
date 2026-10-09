// Rate limits, using Cloudflare's Workers Rate Limiting bindings.
//
// The bindings are declared in wrangler.jsonc under `ratelimits`. They count in
// memory at each Cloudflare location and write nothing to storage, so a flood
// of junk requests costs no database writes. Their counts are approximate,
// which is why the limits that must be exact (free checks, the daily budget,
// device mints, the monthly allowance) live in D1 instead (see db.js).
//
// Contract section 11 has the table of which limit guards which route.

import { failRetry, logLine } from './http.js';

/** Every binding's period, in seconds. A refusal asks the client to wait this long. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

const warned = new Set();

/**
 * Spend one unit of `binding` for `key`. Returns true when allowed, false when
 * over the limit. For a caller that would rather skip something than fail.
 *
 * A key never contains a license key or a device token: callers pass an IP
 * key, `dev:<deviceId>` or `lic:<licenses.id>`.
 */
export async function tryLimit(env, binding, key) {
  const limiter = env[binding];
  if (!limiter || typeof limiter.limit !== 'function') {
    // Only happens if wrangler.jsonc lost its `ratelimits` block. The D1
    // limits still cap spending, so carry on, but say so once per isolate.
    if (!warned.has(binding)) {
      warned.add(binding);
      logLine('rate_limit_binding_missing', { binding });
    }
    return true;
  }
  const { success } = await limiter.limit({ key });
  return success;
}

/** Spend one unit of `binding` for `key`, or stop the request with `429 rate_limited`. */
export async function limit(env, binding, key) {
  if (!(await tryLimit(env, binding, key))) failRetry('rate_limited', RATE_LIMIT_PERIOD_SECONDS);
}
