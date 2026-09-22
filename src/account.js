'use strict';
// The client for the hosted Grayout service (docs/API-CONTRACT.md).
//
// v2 sells a subscription and the service makes the model calls with its own
// key. This Mac holds a Grayout license key and a random device id, and never
// sees a model key. Everything here is best-effort: no method throws, every
// call times out, and a failure reads as "we could not ask", never as a
// verdict. Nothing about billing may ever gray the screen.

const crypto = require('crypto');
const paths = require('./paths');
const log = require('./log');
const { PLANS, FREE_CHECKS, INCLUDED_CHECKS } = require('./pricing');

const DEFAULT_API_BASE = 'https://api.grayout.app';
const TIMEOUT_MS = 10000;
const STATUS_CACHE_MS = 10 * 60 * 1000;
const CLAIM_POLL_MS = 2000;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;

// Hosts that may be reached over plain http, for a locally run service.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// The contract's failure codes, mapped onto the kinds the loop and the UI act
// on. license_invalid / license_revoked reuse key_rejected: from the app's side
// they mean the same thing — the credential we hold is not accepted.
const SERVICE_ERROR_KINDS = {
  no_license: 'no_license',
  license_invalid: 'key_rejected',
  license_revoked: 'key_rejected',
  trial_expired: 'trial_expired',
  subscription_inactive: 'subscription_inactive',
  free_exhausted: 'free_exhausted',
  quota_exceeded: 'quota_exceeded',
  rate_limited: 'rate_limited',
  upstream_unavailable: 'overloaded',
  payload_too_large: 'payload_too_large',
  // Not a watch-loop code: /v1/claim answers this for a device code that has
  // expired or never existed. It is permanent, so the claim poll must stop on
  // it instead of spending its whole 15-minute window on a dead code.
  code_expired: 'claim_expired'
};

// Kinds that will never fix themselves by asking again. Everything outside this
// set — pending, a blip, a flaky network — is worth another poll.
const CLAIM_STOP_KINDS = new Set(['key_rejected', 'no_license', 'claim_expired']);

// A plan problem the person has to act on. Everything else is transient.
const SUBSCRIPTION_KINDS = new Set(['no_license', 'trial_expired', 'subscription_inactive', 'free_exhausted', 'quota_exceeded', 'key_rejected']);
const BAD_STATUSES = new Set(['past_due', 'canceled', 'cancelled', 'unpaid', 'incomplete', 'incomplete_expired', 'inactive', 'revoked']);

function isPackaged() {
  if (!paths.IN_ELECTRON) return false;
  try { return !!require('electron').app.isPackaged; } catch { return false; }
}

/** https anywhere, http only for a local service; trailing slashes dropped. */
function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Base URL for the service: GRAYOUT_API_BASE (unpackaged only) wins, then
 * `apiBase` in config.json, then https://api.grayout.app.
 */
function apiBaseFrom(config) {
  if (!isPackaged() && process.env.GRAYOUT_API_BASE) {
    const env = normalizeBase(process.env.GRAYOUT_API_BASE);
    if (env) return env;
  }
  return normalizeBase(config && config.apiBase) || DEFAULT_API_BASE;
}

/** A URL the service handed us is untrusted input: https, or a local base. */
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return u.toString();
  return null;
}

function errorFromBody(body, status) {
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' && err.message.trim()
    ? err.message.trim().slice(0, 200)
    : `the Grayout service returned ${status || 'an error'}`;
  let kind = SERVICE_ERROR_KINDS[code];
  if (!kind) {
    if (status === 401 || status === 403) kind = 'key_rejected';
    else if (status === 404) kind = 'unknown';
    else if (status === 413) kind = 'payload_too_large';
    else if (status === 429) kind = 'rate_limited';
    else if (status >= 500) kind = 'overloaded';
    else kind = 'unknown';
  }
  return { kind, message, code, status: status || 0 };
}

function classifyFetchError(e) {
  const msg = String((e && e.message) || e || 'request failed');
  if (e && e.name === 'AbortError') return { kind: 'network', message: 'the Grayout service did not answer in time' };
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|timed out/i.test(msg)) {
    return { kind: 'network', message: 'could not reach the Grayout service' };
  }
  return { kind: 'unknown', message: msg.slice(0, 200) };
}

// Number(null) and Number('') are 0, so "missing" has to be checked first:
// a cleared counter must read as the default, not as zero.
function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/**
 * deps: { getConfig, secrets, state, fetch, now, pollIntervalMs, claimWindowMs }
 * Only getConfig is normally supplied; the rest exist so tests can drive it.
 */
function createAccount(deps = {}) {
  const d = {
    getConfig: () => ({}),
    secrets: require('./secrets'),
    state: require('./state'),
    now: () => Date.now(),
    pollIntervalMs: CLAIM_POLL_MS,
    claimWindowMs: CLAIM_WINDOW_MS,
    timeoutMs: TIMEOUT_MS,
    ...deps
  };
  // Looked up per call so a test can swap globalThis.fetch at any point.
  const doFetch = (...args) => (d.fetch || globalThis.fetch)(...args);

  let statusCache = null;   // { license, at, value }
  let problemKind = null;   // set by the loop when a check comes back blocked
  let activeClaim = null;

  /* ---------------- identity ---------------- */

  // 128 random bits, generated once and kept in state.json. Nothing about this
  // Mac is hashed into it: it scopes the free taste, it does not identify you.
  function deviceId() {
    const st = d.state.get();
    if (typeof st.deviceId === 'string' && /^[0-9a-f]{32}$/.test(st.deviceId)) return st.deviceId;
    const id = crypto.randomBytes(16).toString('hex');
    try { d.state.update(s => { s.deviceId = id; }); } catch {}
    return id;
  }

  function getLicense() { try { return d.secrets.getLicense(); } catch { return null; } }
  function hasLicense() { return !!getLicense(); }

  function storeLicense(license) {
    try {
      d.secrets.setLicense(license);
      return { ok: true, secureStorage: true };
    } catch (e) {
      // No keychain: keep it for this session rather than losing a paid license.
      try { d.secrets.useSessionLicense(license); } catch {}
      const unavailable = e && e.name === 'SecretsUnavailable';
      return { ok: false, secureStorage: !unavailable, message: unavailable ? 'Secure storage is not available on this Mac, so the license is held for this session only.' : String(e.message || e) };
    }
  }

  function clearLicense() {
    try { d.secrets.clearLicense(); } catch {}
    statusCache = null;
    problemKind = null;
    try { d.state.update(s => { s.account = null; }); } catch {}
    return { ok: true, ...snapshot() };
  }

  /* ---------------- local snapshot ---------------- */

  function readStored() {
    const a = d.state.get().account;
    return a && typeof a === 'object' ? a : {};
  }

  function writeStored(next) {
    try { d.state.update(s => { s.account = { ...readStored(), ...next, updatedAt: d.now() }; }); } catch {}
    statusCache = null;
  }

  /** Fold a { plan, status, usage } body from any endpoint into local state. */
  function record(body) {
    if (!body || typeof body !== 'object') return;
    const next = {};
    if (typeof body.plan === 'string' && body.plan) next.plan = body.plan.slice(0, 32);
    if (typeof body.status === 'string' && body.status) next.status = body.status.slice(0, 32);
    // /v1/check answers with `plan` carrying the subscription state.
    if (!next.status && next.plan) next.status = next.plan;
    const u = body.usage && typeof body.usage === 'object' ? body.usage : null;
    if (u) {
      const used = finiteOr(u.checksUsed, null);
      const included = finiteOr(u.checksIncluded, null);
      if (used !== null) next.checksUsed = used;
      if (included !== null) next.checksIncluded = included;
      next.periodEnd = typeof u.periodEnd === 'string' ? u.periodEnd.slice(0, 40) : null;
    }
    if (Object.keys(next).length) writeStored(next);
  }

  function snapshot() {
    const s = readStored();
    const license = getLicense();
    const plan = s.plan || (license ? 'unknown' : 'free');
    const status = s.status || (license ? 'unknown' : 'free');
    const checksIncluded = finiteOr(s.checksIncluded, license ? INCLUDED_CHECKS : FREE_CHECKS);
    const checksUsed = finiteOr(s.checksUsed, 0);
    const exhausted = !license && checksUsed >= FREE_CHECKS;
    return {
      plan,
      status,
      usage: { checksUsed, checksIncluded, periodEnd: s.periodEnd || null },
      hasLicense: !!license,
      licenseMasked: license ? d.secrets.maskLicense(license) : '',
      problem: problemKind,
      needsSubscription: !!problemKind || exhausted || BAD_STATUSES.has(status)
    };
  }

  /** The loop calls this with the { plan, usage } every /v1/check returns. */
  function noteCheck(service) {
    problemKind = null;
    if (service && typeof service === 'object') {
      const body = { usage: service.usage };
      // /v1/check reports the subscription STATE in `plan` (free | trialing |
      // active | past_due | canceled). The plan NAME (monthly/yearly) only ever
      // comes from activate/status, so a check must not overwrite it.
      if (typeof service.plan === 'string' && service.plan) {
        body.status = service.plan;
        if (!readStored().plan) body.plan = service.plan;
      }
      record(body);
    }
    return snapshot();
  }

  /** The loop calls this when a check comes back blocked on the plan. */
  function noteProblem(kind) {
    problemKind = SUBSCRIPTION_KINDS.has(kind) ? kind : null;
    if (kind === 'free_exhausted') writeStored({ checksUsed: Math.max(finiteOr(readStored().checksUsed, 0), FREE_CHECKS) });
    return snapshot();
  }

  /* ---------------- transport ---------------- */

  async function request(method, path, { body, query, timeoutMs } = {}) {
    const base = apiBaseFrom(d.getConfig());
    let url = base + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += '?' + s;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs || d.timeoutMs);
    try {
      const res = await doFetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const status = Number(res && res.status) || 0;
      const ok = res && res.ok !== undefined ? !!res.ok : status >= 200 && status < 300;
      let json = null;
      try { json = await res.json(); } catch {}
      const requestId = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('X-Grayout-Request-Id') : null;
      if (!ok) return { ok: false, ...errorFromBody(json, status), requestId };
      return { ok: true, data: json && typeof json === 'object' ? json : {}, requestId };
    } catch (e) {
      return { ok: false, ...classifyFetchError(e), status: 0, requestId: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- public API ---------------- */

  /** Paste-a-key path, and the launch re-validation. */
  async function activate(license) {
    let key;
    try { key = d.secrets.normalizeLicense(license); } catch {
      return { ok: false, kind: 'license_invalid', message: 'That does not look like a Grayout license key.', ...snapshot() };
    }
    if (!key) return { ok: false, kind: 'no_license', message: 'Paste your license key first.', ...snapshot() };

    const r = await request('POST', '/v1/activate', { body: { deviceId: deviceId(), license: key } });
    if (!r.ok) {
      log.info('account', `activate failed: ${r.kind}`);
      return { ok: false, kind: r.kind, message: r.message, ...snapshot() };
    }
    const stored = storeLicense(key);
    problemKind = null;
    // The free taste's counters do not carry over to a paid plan. If the
    // service did not send fresh ones, forget the old ones rather than showing
    // "100 of 100 checks" to somebody who just paid.
    if (!r.data || !r.data.usage) writeStored({ checksUsed: null, checksIncluded: null, periodEnd: null });
    record(r.data);
    statusCache = { license: key, at: d.now(), value: snapshot() };
    log.info('account', `activated: plan=${snapshot().plan} status=${snapshot().status}`);
    return { ok: true, secureStorage: stored.secureStorage !== false, storeMessage: stored.message || null, ...snapshot() };
  }

  /**
   * Current plan and usage, cached for 10 minutes. On the free taste there is
   * nothing to ask: the counts come back with every check.
   */
  async function status(opts = {}) {
    const license = getLicense();
    if (!license) return { ok: true, cached: false, ...snapshot() };
    if (!opts.force && statusCache && statusCache.license === license && d.now() - statusCache.at < STATUS_CACHE_MS) {
      return { ok: true, cached: true, ...statusCache.value };
    }
    const r = await request('GET', '/v1/status', { query: { license, deviceId: deviceId() } });
    if (!r.ok) {
      if (SUBSCRIPTION_KINDS.has(r.kind)) problemKind = r.kind;
      return { ok: false, kind: r.kind, message: r.message, cached: false, ...snapshot() };
    }
    problemKind = null;
    record(r.data);
    const value = snapshot();
    statusCache = { license, at: d.now(), value };
    return { ok: true, cached: false, ...value };
  }

  /**
   * Take a device code, then a Stripe Checkout link for it. The caller opens
   * the URL and hands the device code to pollClaim().
   */
  async function startCheckout(plan) {
    const wanted = plan === 'yearly' ? 'yearly' : 'monthly';
    const code = await request('POST', '/v1/device-code', { body: { deviceId: deviceId() } });
    if (!code.ok) return { ok: false, kind: code.kind, message: code.message };
    const deviceCode = typeof code.data.deviceCode === 'string' ? code.data.deviceCode.slice(0, 128) : '';
    if (!deviceCode) return { ok: false, kind: 'unknown', message: 'The service did not return a device code.' };

    const out = await request('POST', '/v1/checkout', { body: { deviceId: deviceId(), plan: wanted, deviceCode } });
    if (!out.ok) return { ok: false, kind: out.kind, message: out.message };
    const url = safeUrl(out.data.url);
    if (!url) return { ok: false, kind: 'unknown', message: 'The service did not return a checkout link.' };
    log.info('account', `checkout started: ${wanted}`);
    return { ok: true, url, deviceCode, plan: wanted, expiresIn: finiteOr(code.data.expiresIn, 900) };
  }

  function sleep(ms, token) {
    return new Promise(resolve => {
      const t = setTimeout(() => { token.wake = null; resolve(); }, ms);
      token.wake = () => { clearTimeout(t); token.wake = null; resolve(); };
    });
  }

  /**
   * Poll /v1/claim every 2 s for 15 minutes while the person pays in the
   * browser. Resolves with the license stored, or cancelled/timed out. Starting
   * a new poll cancels the previous one.
   */
  function pollClaim(deviceCode) {
    const code = String(deviceCode || '').trim().slice(0, 128);
    if (!code) return Promise.resolve({ ok: false, kind: 'unknown', message: 'No device code to claim.' });
    cancelClaim();

    const token = { cancelled: false, wake: null };
    activeClaim = token;
    const deadline = d.now() + d.claimWindowMs;

    return (async () => {
      try {
        while (!token.cancelled && d.now() < deadline) {
          const r = await request('GET', '/v1/claim', { query: { deviceCode: code } });
          if (token.cancelled) break;

          if (r.ok && r.data && r.data.status === 'ready') {
            let key;
            try { key = d.secrets.normalizeLicense(r.data.license); } catch { key = ''; }
            if (!key) return { ok: false, kind: 'unknown', message: 'The service returned a license key this app does not recognize.' };
            const stored = storeLicense(key);
            problemKind = null;
            // Best effort: bind the license to this device and learn the plan.
            const act = await activate(key);
            log.info('account', 'license claimed');
            return { ok: true, secureStorage: stored.secureStorage !== false, storeMessage: stored.message || null, ...(act.ok ? act : snapshot()) };
          }
          // A hard failure (expired code, bad code, revoked) will not fix itself.
          // A 400 means this client sent something the service cannot read, and
          // it will send the same thing again, so that stops too.
          if (!r.ok && (CLAIM_STOP_KINDS.has(r.kind) || r.status === 400)) {
            return { ok: false, kind: r.kind, message: r.message };
          }
          if (token.cancelled || d.now() >= deadline) break;
          await sleep(d.pollIntervalMs, token);
        }
        return token.cancelled
          ? { ok: false, kind: 'cancelled', message: 'Waiting for checkout was cancelled.' }
          : { ok: false, kind: 'timeout', message: 'Checkout was not finished in time.' };
      } finally {
        if (activeClaim === token) activeClaim = null;
      }
    })();
  }

  function cancelClaim() {
    if (!activeClaim) return { ok: true, cancelled: false };
    activeClaim.cancelled = true;
    if (activeClaim.wake) activeClaim.wake();
    activeClaim = null;
    return { ok: true, cancelled: true };
  }

  /** A Stripe billing portal link for managing or cancelling. */
  async function portalUrl() {
    const license = getLicense();
    if (!license) return { ok: false, kind: 'no_license', message: 'There is no license key on this Mac.' };
    const r = await request('POST', '/v1/portal', { body: { license } });
    if (!r.ok) return { ok: false, kind: r.kind, message: r.message };
    const url = safeUrl(r.data.url);
    return url ? { ok: true, url } : { ok: false, kind: 'unknown', message: 'The service did not return a billing link.' };
  }

  return {
    deviceId, getLicense, hasLicense, clearLicense, snapshot, noteCheck, noteProblem,
    activate, status, startCheckout, pollClaim, cancelClaim, portalUrl,
    apiBase: () => apiBaseFrom(d.getConfig()),
    plans: PLANS, freeChecks: FREE_CHECKS, includedChecks: INCLUDED_CHECKS,
    _request: request
  };
}

module.exports = {
  createAccount, apiBaseFrom, normalizeBase, safeUrl, errorFromBody, classifyFetchError,
  SERVICE_ERROR_KINDS, SUBSCRIPTION_KINDS, BAD_STATUSES, CLAIM_STOP_KINDS,
  DEFAULT_API_BASE, TIMEOUT_MS, STATUS_CACHE_MS, CLAIM_POLL_MS, CLAIM_WINDOW_MS
};
