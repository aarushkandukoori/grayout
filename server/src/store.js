// A tiny JSON store over Workers KV.
//
// Everything the service persists goes through this interface, so the tests can
// swap in `memoryStore()` and never touch the network. Values are JSON in and
// JSON out; callers never see strings.
//
// KV is eventually consistent and has no compare-and-set, so `incr` is
// read-modify-write and can lose a racing increment. That is acceptable here:
// the counters it guards are a usage meter and a rate limiter, both of which
// are allowed to undercount slightly, and neither of which gates anything
// dangerous. Nothing that must be exact (a license record, a claim) uses it.

// KV refuses a TTL below 60 seconds.
export const MIN_TTL_SECONDS = 60;

function normalizeTtl(options) {
  if (!options || options.expirationTtl === undefined || options.expirationTtl === null) return undefined;
  const ttl = Math.ceil(Number(options.expirationTtl));
  if (!Number.isFinite(ttl)) return undefined;
  return Math.max(MIN_TTL_SECONDS, ttl);
}

function parse(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A value that is not JSON is a value written by something that is not this
    // service. Treat it as absent rather than throwing inside a request.
    return null;
  }
}

/** Wrap a Workers KV namespace binding. */
export function kvStore(kv) {
  if (!kv) throw new Error('kvStore needs a KV namespace binding');
  return {
    async get(key) {
      return parse(await kv.get(key, 'text'));
    },
    async put(key, value, options) {
      const ttl = normalizeTtl(options);
      await kv.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
      return value;
    },
    async delete(key) {
      await kv.delete(key);
    },
    async incr(key, by = 1, options) {
      const current = parse(await kv.get(key, 'text'));
      const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + by;
      const ttl = normalizeTtl(options);
      await kv.put(key, JSON.stringify(next), ttl ? { expirationTtl: ttl } : undefined);
      return next;
    }
  };
}

/**
 * A Map-backed store with the same shape, for tests and `wrangler dev` smoke
 * runs. TTLs are honored against `now()` so expiry can be tested by moving a
 * clock rather than by sleeping.
 */
export function memoryStore(options = {}) {
  const map = new Map();
  const now = options.now || (() => Date.now());

  const live = key => {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      map.delete(key);
      return null;
    }
    return entry;
  };

  const expiryFor = opts => {
    const ttl = normalizeTtl(opts);
    return ttl ? now() + ttl * 1000 : null;
  };

  return {
    async get(key) {
      const entry = live(key);
      return entry ? parse(entry.value) : null;
    },
    async put(key, value, opts) {
      map.set(key, { value: JSON.stringify(value), expiresAt: expiryFor(opts) });
      return value;
    },
    async delete(key) {
      map.delete(key);
    },
    async incr(key, by = 1, opts) {
      const entry = live(key);
      const current = entry ? parse(entry.value) : null;
      const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + by;
      map.set(key, { value: JSON.stringify(next), expiresAt: expiryFor(opts) });
      return next;
    },
    // Test-only handles. Not part of the interface the service uses.
    _map: map,
    _keys: () => [...map.keys()]
  };
}

/** The key names in docs/API-CONTRACT.md, in one place so nothing drifts. */
export const keys = {
  license: license => `lic:${license}`,
  device: deviceId => `dev:${deviceId}`,
  code: deviceCode => `code:${deviceCode}`,
  usage: (license, month) => `use:${license}:${month}`,
  customer: customerId => `cus:${customerId}`,
  // Not in the contract's table: short-lived operational keys.
  pendingCustomer: customerId => `cus:pending:${customerId}`,
  rateDevice: (deviceId, minute) => `rl:dev:${deviceId}:${minute}`,
  rateLicense: (license, hour) => `rl:lic:${license}:${hour}`
};
