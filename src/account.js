'use strict';
// The client for the hosted Grayout service (docs/API-CONTRACT.md, v3).
//
// The service makes the model calls with its own key. This Mac holds:
//   - a device identity the SERVICE minted (POST /v1/device): a deviceId, kept
//     in state.json, and a deviceToken, kept encrypted in secrets.bin. Every
//     device-scoped call sends both.
//   - a Grayout license key, once somebody pays (also in secrets.bin).
//
// Everything here is best-effort: no method throws, every call times out, and
// a failure reads as "we could not ask", never as a verdict. Nothing about
// billing may ever gray the screen.
//
// Every endpoint we use is a POST with a JSON body. Nothing secret (license,
// device token, device code) ever goes in a URL.

const paths = require('./paths');
const log = require('./log');
const { DEFAULT_API_BASE, normalizeBase, LOCAL_HOSTS } = require('./config');
const { PLANS, FREE_CHECKS, INCLUDED_CHECKS } = require('./pricing');
const channel = require('./channel');

const TIMEOUT_MS = 10000;          // every account call
const CHECK_TIMEOUT_MS = 60000;    // /v1/check carries screenshots and waits on the model
const STATUS_CACHE_MS = 10 * 60 * 1000;

// Waiting for a browser checkout (contract 6.6): ask every 2 seconds for the
// first 2 minutes, then every 5 seconds, until the device code expires.
const CLAIM_FAST_MS = 2000;
const CLAIM_FAST_FOR_MS = 2 * 60 * 1000;
const CLAIM_SLOW_MS = 5000;
const CLAIM_WINDOW_MS = 3600 * 1000;   // a device code lives 3,600 seconds

// Asking for a lost key back is cheap, but the Settings window can open many
// times a minute. Once a minute is plenty.
const RESTORE_EVERY_MS = 60 * 1000;

// Pressing Subscribe again reopens the checkout that is still open rather than
// starting a second one, unless it has less than this long to live. Then a
// new one starts, because the old page would expire under the buyer.
const CHECKOUT_REUSE_MARGIN_MS = 5 * 60 * 1000;

// secrets.bin exists but the Keychain will not unlock it. Wait this long for
// the person to fix that before treating the old store as lost.
const LOCKED_GIVE_UP_MS = 24 * 3600 * 1000;

// The shapes the contract promises (section 4). Anything else from the
// network is refused rather than stored.
const DEVICE_ID_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_CODE_RE = /^[0-9A-Za-z-]{4,32}$/;

// What the person reads. One place, so the windows and the loop agree.
const MESSAGES = {
  // Contract section 3: the deploy step never filled in DEFAULT_API_BASE.
  notConnected: 'This build of Grayout is not connected to the Grayout service yet.',
  // Contract 4.1: after one re-registration and one retry, stop and say this.
  deviceUnverified: 'Grayout could not register this Mac with the service. Try again later.',
  // Contract 6.5 / 16.1: never a second subscription, and never the word "subscribe".
  alreadySubscribed: 'This Mac already has a Grayout subscription, so nothing new was charged.',
  // Contract 6.10 / 10: Managed Payments buyers can always manage at link.com.
  manageElsewhere: 'You can also manage it at link.com, where this purchase is listed as Sold through Link.',
  // secrets.bin is there but macOS would not unlock it (see ensureDevice).
  secretsLocked: 'Grayout could not unlock its saved keys in the macOS Keychain. Quit and reopen Grayout, and choose Always Allow if macOS asks about "Grayout Safe Storage". Or paste your license key in Settings.'
};
const LINK_URL = 'https://link.com';

// The contract's error codes (section 8), each mapped to the "kind" the loop
// and the windows act on. Most keep their own name. Two reuse a kind the
// watch loop already treats as "busy, try again later".
const SERVICE_ERROR_KINDS = {
  bad_request: 'bad_request',
  device_unverified: 'device_unverified',
  no_license: 'no_license',
  license_invalid: 'license_invalid',
  license_revoked: 'license_revoked',
  free_exhausted: 'free_exhausted',
  trial_expired: 'trial_expired',
  subscription_inactive: 'subscription_inactive',
  code_expired: 'code_expired',
  already_subscribed: 'already_subscribed',
  payload_too_large: 'payload_too_large',
  quota_exceeded: 'quota_exceeded',
  rate_limited: 'rate_limited',
  internal_error: 'overloaded',
  upstream_unavailable: 'overloaded',
  // The SERVICE is missing a secret or a Stripe setting (503). Not the same as
  // this app having no service address at all, which is 'not_connected'.
  not_configured: 'not_configured'
};

// Problems with the plan that the person has to act on. They show as
// "Subscription needs attention" in the menu bar.
const NEEDS_ACTION_KINDS = new Set(['no_license', 'license_invalid', 'license_revoked', 'trial_expired', 'subscription_inactive', 'free_exhausted']);
// Plan states worth remembering until a good check clears them. quota_exceeded
// is here but needs no action: past the monthly allowance the service only
// slows down to one check every 10 minutes until the month resets.
const PLAN_PROBLEM_KINDS = new Set([...NEEDS_ACTION_KINDS, 'quota_exceeded']);

const STATUSES = new Set(['free', 'trialing', 'active', 'past_due', 'canceled']);

function isPackaged() {
  if (!paths.IN_ELECTRON) return false;
  try { return !!require('electron').app.isPackaged; } catch { return false; }
}

/**
 * Base URL for the service, or null when there is none.
 * Order: GRAYOUT_API_BASE (unpackaged builds only), then `apiBase` in
 * config.json, then the address the deploy step built in (DEFAULT_API_BASE).
 * null means "not connected": no request is ever made.
 * The Mac App Store edition has no override (2.3.1, 5.1.2), and neither has a
 * public packaged direct build (it is pay-only; channel.features()
 * apiBaseOverride): only the address built in, so a config file or an
 * environment variable can never send screenshots anywhere else.
 */
function apiBaseFrom(config, builtIn = DEFAULT_API_BASE) {
  if (!channel.features().apiBaseOverride) return normalizeBase(builtIn) || null;
  if (!isPackaged() && process.env.GRAYOUT_API_BASE) {
    const env = normalizeBase(process.env.GRAYOUT_API_BASE);
    if (env) return env;
  }
  return normalizeBase(config && config.apiBase) || normalizeBase(builtIn) || null;
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

/** Whole seconds from a body field or a Retry-After header, or null. */
function secondsOrNull(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(86400, Math.ceil(n));
}

/**
 * Turn a failed response into { kind, message, code, status, ... }.
 * `code` is the contract's error code, or '' when the body had none.
 */
function errorFromBody(body, status, retryAfterHeader) {
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' && err.message.trim()
    ? err.message.trim().slice(0, 300)
    : `the Grayout service returned ${status || 'an error'}`;
  let kind = SERVICE_ERROR_KINDS[code];
  if (!kind) {
    // A body we do not understand. Fall back on the HTTP status, and never
    // guess a plan problem from it: a bare 401 could be anything.
    if (status === 413) kind = 'payload_too_large';
    else if (status === 429) kind = 'rate_limited';
    else if (status >= 500) kind = 'overloaded';
    else kind = 'unknown';
  }
  const out = { kind, message, code, status: status || 0 };
  // The three codes that carry one extra field (contract section 5).
  const retryAfter = secondsOrNull(err && err.retryAfter) || secondsOrNull(retryAfterHeader);
  if (retryAfter) out.retryAfter = retryAfter;
  if (err && (err.reason === 'device' || err.reason === 'daily_budget')) out.reason = err.reason;
  if (err && 'portalUrl' in err) out.portalUrl = safeUrl(err.portalUrl);
  return out;
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
 * How long to wait before asking /v1/claim again (contract 6.6): 2 seconds
 * for the first 2 minutes, then 5 seconds. A rate limit's retryAfter (whole
 * seconds) wins when it is longer.
 */
function nextClaimDelay(elapsedMs, retryAfterSec, timing = {}) {
  const fastMs = timing.fastMs || CLAIM_FAST_MS;
  const fastForMs = timing.fastForMs || CLAIM_FAST_FOR_MS;
  const slowMs = timing.slowMs || CLAIM_SLOW_MS;
  const ms = elapsedMs < fastForMs ? fastMs : slowMs;
  return retryAfterSec > 0 ? Math.max(ms, retryAfterSec * 1000) : ms;
}

/**
 * What to say on 409 already_subscribed. The service uses this one code for
 * three different situations and says which one in its message (contract 6.5
 * step 3 and 4): the plan is already active, a payment needs fixing ("waiting
 * on a payment... fix it in Manage billing or at link.com"), or a payment is
 * still being processed. Showing our own fixed sentence hid the last two, so
 * somebody whose card had failed was only told they were subscribed.
 *
 * So the service's sentence is shown, followed by "Nothing new was charged."
 * Our own sentence is used instead when the service sent none (errorFromBody
 * then fills in "the Grayout service returned 409"), or when its sentence
 * says "subscribe": contract 16.1 forbids telling a subscriber to subscribe.
 */
function alreadySubscribedMessage(serviceMessage) {
  const text = typeof serviceMessage === 'string' ? serviceMessage.replace(/\s+/g, ' ').trim() : '';
  if (!text || /^the Grayout service returned\b/.test(text) || /\bsubscribe\b/i.test(text)) return MESSAGES.alreadySubscribed;
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return `${sentence.slice(0, 280)} Nothing new was charged.`;
}

/** An ISO time from the service, or null. Short strings only. */
function isoOrNull(value) {
  return typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value.slice(0, 40) : null;
}

/**
 * deps: { getConfig, secrets, state, fetch, now, timeoutMs, claimWindowMs,
 *         claimFastMs, claimFastForMs, claimSlowMs, builtInBase }
 * Only getConfig is normally supplied; the rest exist so tests can drive it.
 */
function createAccount(deps = {}) {
  const d = {
    getConfig: () => ({}),
    secrets: require('./secrets'),
    state: require('./state'),
    now: () => Date.now(),
    timeoutMs: TIMEOUT_MS,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    claimWindowMs: CLAIM_WINDOW_MS,
    claimFastMs: CLAIM_FAST_MS,
    claimFastForMs: CLAIM_FAST_FOR_MS,
    claimSlowMs: CLAIM_SLOW_MS,
    builtInBase: DEFAULT_API_BASE,
    ...deps
  };
  // Looked up per call so a test can swap globalThis.fetch at any point.
  const doFetch = (...args) => (d.fetch || globalThis.fetch)(...args);

  let statusCache = null;   // { license, at, value }
  let activeClaim = null;   // the poll that is running, so a new one can cancel it
  // The checkout started last: { deviceCode, url, plan, trial, expiresAt }.
  // Kept until it is paid, fails, or expires, so Subscribe can reopen it.
  let lastCheckout = null;
  let minting = null;       // the one /v1/device call in flight, shared by everyone waiting
  let lastRestoreAt = 0;

  const base = () => apiBaseFrom(d.getConfig(), d.builtInBase);

  /** True when this build knows where the service is. */
  function configured() { return !!base(); }

  /* ---------------- the license on this Mac ---------------- */

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
    try { d.state.update(s => { s.account = null; }); } catch {}
    return { ok: true, ...snapshot() };
  }

  /* ---------------- the device identity ---------------- */

  /** The identity saved on this Mac, or null if there is none (or half of one). */
  function storedDevice() {
    let id = null;
    try { id = d.state.get().deviceId; } catch {}
    let token = null;
    try { token = d.secrets.getDeviceToken(); } catch {}
    if (typeof id === 'string' && DEVICE_ID_RE.test(id) && typeof token === 'string' && DEVICE_TOKEN_RE.test(token)) {
      return { deviceId: id, deviceToken: token };
    }
    return null;
  }

  function saveDevice(deviceId, deviceToken) {
    try { d.state.update(s => { s.deviceId = deviceId; }); } catch {}
    try { d.secrets.setDeviceToken(deviceToken); } catch {
      // No keychain: hold the token for this session. Next launch registers again.
      try { d.secrets.useSessionDeviceToken(deviceToken); } catch {}
    }
  }

  function forgetDevice() {
    try { d.state.update(s => { s.deviceId = null; }); } catch {}
    try { d.secrets.clearDeviceToken(); } catch {}
  }

  /**
   * Ask the service for a new identity. Only one request runs at a time:
   * anyone who asks while it is running waits for the same answer, so a burst
   * of calls cannot register this Mac five times.
   */
  function mintDevice() {
    if (!minting) {
      minting = (async () => {
        const r = await post('/v1/device', {});
        if (!r.ok) return r;
        const id = r.data && r.data.deviceId;
        const token = r.data && r.data.deviceToken;
        if (typeof id !== 'string' || !DEVICE_ID_RE.test(id) || typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) {
          return { ok: false, kind: 'unknown', code: '', status: r.status, message: 'The service returned a device identity this app does not recognize.' };
        }
        saveDevice(id, token);
        log.info('account', 'registered this Mac with the service');
        return { ok: true, deviceId: id, deviceToken: token };
      })().finally(() => { minting = null; });
    }
    return minting;
  }

  /** True when secrets.bin exists but this session could not unlock it. */
  function secretsLocked() {
    try { return !!(d.secrets.unreadable && d.secrets.unreadable()); } catch { return false; }
  }

  /**
   * True once secrets.bin has been locked for a whole day. The first time it
   * is seen locked is written to state.json, so the day counts across launches.
   */
  function lockedForADay() {
    let since = null;
    try { since = d.state.get().secretsLockedSince; } catch {}
    if (!Number.isFinite(since)) {
      try { d.state.update(st => { st.secretsLockedSince = d.now(); }); } catch {}
      return false;
    }
    return d.now() - since >= LOCKED_GIVE_UP_MS;
  }

  function forgetLockedSince() {
    let since = null;
    try { since = d.state.get().secretsLockedSince; } catch {}
    if (since !== undefined && since !== null) {
      try { d.state.update(st => { delete st.secretsLockedSince; }); } catch {}
    }
  }

  /**
   * The saved identity, or a freshly minted one.
   *
   * One exception: secrets.bin is there but the Keychain will not unlock it
   * (macOS asked and the person said Deny, or its key is gone). That file may
   * hold this Mac's device token AND its license, so registering again would
   * bury both and hand out a second free taste. Instead this answers
   * 'secrets_locked' and waits for the person. It starts fresh only when
   * `startFresh` is set (they just pasted a license key, so nothing is lost)
   * or when the file has stayed locked for a whole day.
   */
  async function ensureDevice(opts = {}) {
    const have = storedDevice();
    if (have) { forgetLockedSince(); return { ok: true, ...have }; }
    if (secretsLocked()) {
      if (!opts.startFresh && !lockedForADay()) {
        return { ok: false, kind: 'secrets_locked', code: '', status: 0, message: MESSAGES.secretsLocked, requestId: null };
      }
      log.warn('account', 'saved keys stayed locked; starting a new store for this Mac');
      try { d.secrets.setAsideUnreadable(); } catch {}
      forgetLockedSince();
    }
    return mintDevice();
  }

  /** The device id, if this Mac has one. Never mints. For display and logs only. */
  function deviceId() {
    const have = storedDevice();
    return have ? have.deviceId : null;
  }

  /* ---------------- local snapshot ---------------- */

  function readStored() {
    let a = null;
    try { a = d.state.get().account; } catch {}
    return a && typeof a === 'object' ? a : {};
  }

  function writeStored(next) {
    try { d.state.update(s => { s.account = { ...readStored(), ...next, updatedAt: d.now() }; }); } catch {}
    statusCache = null;
  }

  // Written whenever the service has just answered for the plan: whatever
  // refusal this Mac remembered no longer applies.
  const NO_PROBLEM = { problem: null, problemReason: null };
  // Written when a key arrives (claimed or restored): the free taste's
  // counters and status say nothing about the paid plan, so forget them until
  // the service says what the plan is.
  const FRESH_PLAN = { status: null, service: null, interval: null, cancelAtPeriodEnd: null, periodEnd: null, trialEnd: null, checksUsed: null, checksIncluded: null, resetsAt: null };

  /**
   * The fields worth remembering from an account object (contract 6.1), or
   * from the { plan, service, usage } that every /v1/check returns. Only the
   * fields the body actually has; anything odd is dropped.
   */
  function fieldsFrom(body) {
    const next = {};
    if (!body || typeof body !== 'object') return next;
    // `plan` and `status` carry the same value in v3. Either will do.
    const status = typeof body.status === 'string' ? body.status : typeof body.plan === 'string' ? body.plan : '';
    if (status) next.status = STATUSES.has(status) ? status : 'unknown';
    if ('interval' in body) next.interval = body.interval === 'monthly' || body.interval === 'yearly' ? body.interval : null;
    if (typeof body.service === 'boolean') next.service = body.service;
    if (typeof body.cancelAtPeriodEnd === 'boolean') next.cancelAtPeriodEnd = body.cancelAtPeriodEnd;
    if ('periodEnd' in body) next.periodEnd = isoOrNull(body.periodEnd);
    if ('trialEnd' in body) next.trialEnd = isoOrNull(body.trialEnd);
    const u = body.usage && typeof body.usage === 'object' ? body.usage : null;
    if (u) {
      const used = finiteOr(u.checksUsed, null);
      const included = finiteOr(u.checksIncluded, null);
      if (used !== null) next.checksUsed = used;
      if (included !== null) next.checksIncluded = included;
      if ('periodEnd' in u) next.periodEnd = isoOrNull(u.periodEnd);
      if ('resetsAt' in u) next.resetsAt = isoOrNull(u.resetsAt);
    }
    return next;
  }

  function snapshot() {
    const s = readStored();
    const license = getLicense();
    const status = s.status || (license ? 'unknown' : 'free');
    const problem = PLAN_PROBLEM_KINDS.has(s.problem) ? s.problem : null;
    const service = typeof s.service === 'boolean' ? s.service : null;
    return {
      configured: configured(),
      status,
      plan: status,                       // the contract keeps `plan` equal to `status`
      interval: s.interval || null,       // monthly | yearly | null
      service,                            // what the service last said; null = not asked yet
      cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
      periodEnd: s.periodEnd || null,
      trialEnd: s.trialEnd || null,
      usage: {
        checksUsed: finiteOr(s.checksUsed, 0),
        checksIncluded: finiteOr(s.checksIncluded, license ? INCLUDED_CHECKS : FREE_CHECKS),
        periodEnd: s.periodEnd || null,
        resetsAt: s.resetsAt || null
      },
      hasLicense: !!license,
      licenseMasked: license ? d.secrets.maskLicense(license) : '',
      problem,
      problemReason: problem === 'free_exhausted' && s.problemReason ? s.problemReason : null,
      // secrets.bin is there but the Keychain will not unlock it (ensureDevice).
      secretsLocked: secretsLocked(),
      // A display hint for the menu bar and the windows. Whether checks are
      // served is the service's decision (`service`), never worked out here.
      needsSubscription: NEEDS_ACTION_KINDS.has(problem) || service === false || status === 'past_due'
    };
  }

  /** The loop calls this with the { plan, service, usage } every /v1/check returns. */
  function noteCheck(result) {
    // A check was served, so no refusal applies any more. One write per check.
    writeStored({ ...fieldsFrom(result), ...NO_PROBLEM });
    return snapshot();
  }

  /** The loop calls this when a check comes back refused because of the plan. */
  function noteProblem(kind, detail = {}) {
    if (!PLAN_PROBLEM_KINDS.has(kind)) {
      writeStored(NO_PROBLEM);
      return snapshot();
    }
    const reason = kind === 'free_exhausted' && (detail.reason === 'device' || detail.reason === 'daily_budget') ? detail.reason : null;
    const next = { problem: kind, problemReason: reason };
    // This Mac used its free checks. A paused daily budget says nothing about
    // this Mac's own count, so only `device` (or no reason) fills the meter.
    if (kind === 'free_exhausted' && reason !== 'daily_budget') {
      next.checksUsed = Math.max(finiteOr(readStored().checksUsed, 0), FREE_CHECKS);
    }
    writeStored(next);
    return snapshot();
  }

  /* ---------------- transport ---------------- */

  /**
   * POST a JSON body. Answers { ok: true, data } or { ok: false, kind,
   * message, code, status, ... }. Never throws. With no service address it
   * answers 'not_connected' without touching the network.
   */
  async function post(path, body, { timeoutMs } = {}) {
    const root = base();
    if (!root) return { ok: false, kind: 'not_connected', code: '', status: 0, message: MESSAGES.notConnected, requestId: null };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs || d.timeoutMs);
    try {
      const res = await doFetch(root + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
      const status = Number(res && res.status) || 0;
      const ok = res && res.ok !== undefined ? !!res.ok : status >= 200 && status < 300;
      let json = null;
      try { json = await res.json(); } catch {}
      const header = name => (res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
      const requestId = header('X-Grayout-Request-Id');
      if (!ok) return { ok: false, ...errorFromBody(json, status, header('Retry-After')), requestId };
      // `data` is null when the body was not a JSON object. Callers that need
      // a field check for it; /v1/check treats it as "no verdict".
      return { ok: true, status, data: json && typeof json === 'object' && !Array.isArray(json) ? json : null, requestId };
    } catch (e) {
      return { ok: false, ...classifyFetchError(e), code: '', status: 0, requestId: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST to a device-scoped endpoint: adds deviceId and deviceToken to the
   * body (registering this Mac first if it never was).
   *
   * If the service answers device_unverified, this Mac's identity is no good
   * (for example the service rotated its secret). Register again ONCE and
   * retry ONCE. A second refusal stops there with a plain message: the
   * contract forbids a loop of registrations.
   */
  async function deviceCall(path, fields = {}, opts = {}) {
    const dev = await ensureDevice({ startFresh: !!opts.startFresh });
    if (!dev.ok) return dev;
    const r = await post(path, { ...fields, deviceId: dev.deviceId, deviceToken: dev.deviceToken }, opts);
    if (r.ok || r.code !== 'device_unverified') return r;

    log.info('account', 'the service did not recognize this Mac; registering again');
    // Another call may already have re-registered while this one was waiting.
    const current = storedDevice();
    let fresh;
    if (current && current.deviceId !== dev.deviceId) {
      fresh = { ok: true, ...current };
    } else {
      forgetDevice();
      fresh = await mintDevice();
    }
    if (!fresh.ok) return fresh;

    const again = await post(path, { ...fields, deviceId: fresh.deviceId, deviceToken: fresh.deviceToken }, opts);
    if (!again.ok && again.code === 'device_unverified') {
      log.warn('account', 'the service refused a freshly registered device; giving up until later');
      return { ...again, message: MESSAGES.deviceUnverified };
    }
    return again;
  }

  /** The plain { ok:false, kind, message, ... } a failed call hands back to a window. */
  function failure(r, extra = {}) {
    const out = { ok: false, kind: r.kind || 'unknown', message: r.message || 'Something went wrong. Try again.' };
    if (r.kind === 'device_unverified') out.message = MESSAGES.deviceUnverified;
    if (r.kind === 'secrets_locked') out.message = MESSAGES.secretsLocked;
    if (r.retryAfter) out.retryAfter = r.retryAfter;
    return { ...out, ...extra };
  }

  /* ---------------- the watch loop's one call ---------------- */

  /**
   * POST /v1/check (contract 6.11). `payload` is { displays, webcam, context }
   * from the analyzer; this adds the device identity and, when this Mac has
   * one, the license key. Answers like post().
   */
  async function check(payload) {
    const opts = { timeoutMs: d.checkTimeoutMs };
    const license = getLicense();
    const r = await deviceCall('/v1/check', license ? { ...payload, license } : { ...payload }, opts);
    // no_license: this device has a license on file, but this Mac sent none
    // (the key was lost, or never arrived after a purchase). Get it back and
    // try once more. Never tell somebody who paid to subscribe.
    if (!r.ok && r.code === 'no_license' && !license) {
      const back = await restore({ force: true });
      const key = back.ok && back.restored ? getLicense() : null;
      if (key) return deviceCall('/v1/check', { ...payload, license: key }, opts);
      // The license on file was refunded or disputed (contract 6.7). That is
      // the true state, so report it rather than "your key is missing":
      // pasting the key again would not help, and the plan panel then shows
      // the revoked sentence instead of the free taste with a Subscribe button.
      if (!back.ok && back.kind === 'license_revoked') {
        return { ok: false, kind: 'license_revoked', code: 'license_revoked', status: 403, message: back.message, requestId: null };
      }
    }
    return r;
  }

  /* ---------------- public API ---------------- */

  /** Paste-a-key path. Attaches the key to this Mac and learns its plan. */
  async function activate(license) {
    let key;
    try { key = d.secrets.normalizeLicense(license); } catch {
      return { ok: false, kind: 'license_invalid', message: 'That does not look like a Grayout license key.', ...snapshot() };
    }
    if (!key) return { ok: false, kind: 'no_license', message: 'Paste your license key first.', ...snapshot() };

    // Pasting a key is the one moment it is safe to start a new identity on a
    // Mac whose saved keys are locked: the key that matters is right here.
    const r = await deviceCall('/v1/activate', { license: key }, { startFresh: true });
    if (!r.ok) {
      log.info('account', `activate failed: ${r.kind}`);
      return { ...failure(r), ...snapshot() };
    }
    const stored = storeLicense(key);
    // The free taste's counters do not carry over to a paid plan. Start from a
    // clean slate and keep only what the service just said, rather than
    // showing "100 of 100 checks" to somebody who just paid.
    writeStored({ ...FRESH_PLAN, ...NO_PROBLEM, ...fieldsFrom(r.data) });
    const snap = snapshot();
    statusCache = { license: key, at: d.now(), value: snap };
    log.info('account', `activated: status=${snap.status} service=${snap.service}`);
    return { ok: true, secureStorage: stored.secureStorage !== false, storeMessage: stored.message || null, ...snap };
  }

  /**
   * Current plan and usage from POST /v1/status, cached for 10 minutes. On
   * the free taste there is nothing to ask: the counts come with every check.
   */
  async function status(opts = {}) {
    const license = getLicense();
    if (!license) return { ok: true, cached: false, ...snapshot() };
    if (!opts.force && statusCache && statusCache.license === license && d.now() - statusCache.at < STATUS_CACHE_MS) {
      return { ok: true, cached: true, ...statusCache.value };
    }
    const r = await deviceCall('/v1/status', { license });
    if (!r.ok) {
      if (PLAN_PROBLEM_KINDS.has(r.kind)) writeStored({ problem: r.kind, problemReason: null });
      return { ...failure(r), cached: false, ...snapshot() };
    }
    // The service just said what the plan is. A remembered refusal no longer applies.
    writeStored({ ...fieldsFrom(r.data), ...NO_PROBLEM });
    const value = snapshot();
    statusCache = { license, at: d.now(), value };
    return { ok: true, cached: false, ...value };
  }

  /**
   * POST /v1/restore: get back the license the service has on file for this
   * Mac. Used when a purchase finished after the app stopped waiting, when a
   * check says no_license, and after "already subscribed".
   * Answers { ok: true, restored: true|false, ...snapshot } or a failure.
   */
  async function restore(opts = {}) {
    if (!opts.force && d.now() - lastRestoreAt < RESTORE_EVERY_MS) {
      return { ok: true, restored: false, skipped: true, ...snapshot() };
    }
    lastRestoreAt = d.now();
    const r = await deviceCall('/v1/restore', {});
    if (!r.ok) return { ...failure(r), restored: false, ...snapshot() };
    const data = r.data || {};
    if (data.status !== 'ready') return { ok: true, restored: false, ...snapshot() };

    let key;
    try { key = d.secrets.normalizeLicense(data.license); } catch { key = ''; }
    if (!key) return { ok: false, kind: 'unknown', restored: false, message: 'The service returned a license key this app does not recognize.', ...snapshot() };
    const stored = storeLicense(key);
    writeStored({ ...FRESH_PLAN, ...NO_PROBLEM });
    log.info('account', 'license restored from the service');
    // Best effort: learn the plan now rather than at the next check.
    const st = await status({ force: true });
    return { ok: true, restored: true, secureStorage: stored.secureStorage !== false, storeMessage: stored.message || null, ...(st.ok ? st : snapshot()), cached: false };
  }

  /**
   * What main.js runs at launch and the windows run when Settings opens:
   * re-read the plan when this Mac has a key, or ask for its key back when it
   * has none. A Mac that never registered has nothing to get back, so it is
   * not registered just to ask.
   */
  async function refresh(opts = {}) {
    if (!configured()) return { ok: false, kind: 'not_connected', message: MESSAGES.notConnected, ...snapshot() };
    if (hasLicense()) return status({ force: !!opts.force });
    if (!storedDevice()) return { ok: true, restored: false, ...snapshot() };
    return restore({ force: !!opts.force });
  }

  /**
   * The checkout started earlier for this plan, if its page still has a few
   * minutes to live. null otherwise.
   */
  function openCheckout(plan) {
    if (!lastCheckout || lastCheckout.plan !== plan) return null;
    if (lastCheckout.expiresAt - d.now() <= CHECKOUT_REUSE_MARGIN_MS) return null;
    return lastCheckout;
  }

  /**
   * Start a purchase: a device code (the handle the app polls with), then a
   * Stripe Checkout link for it. The caller opens the URL and calls pollClaim.
   *
   * Pressing Subscribe again while that checkout is still open reopens the
   * SAME page and polls the same code (`reused: true`). Two open checkouts
   * could both be paid, and the buyer would then be billed twice every month.
   *
   * If this Mac already has working service the service answers 409
   * already_subscribed and starts nothing. Then this hands back the billing
   * link (`portalUrl`) and fetches this Mac's key if it lost it.
   */
  async function startCheckout(plan) {
    const wanted = plan === 'yearly' ? 'yearly' : 'monthly';
    const open = openCheckout(wanted);
    if (open) {
      log.info('account', `checkout reopened: ${wanted}`);
      const left = Math.floor((open.expiresAt - d.now()) / 1000);
      return { ok: true, url: open.url, deviceCode: open.deviceCode, plan: wanted, trial: open.trial, expiresIn: left, reused: true };
    }
    const code = await deviceCall('/v1/device-code', {});
    if (!code.ok) return failure(code);
    const codeData = code.data || {};
    const deviceCode = typeof codeData.deviceCode === 'string' && DEVICE_CODE_RE.test(codeData.deviceCode) ? codeData.deviceCode : '';
    if (!deviceCode) return { ok: false, kind: 'unknown', message: 'The service did not return a device code.' };

    const out = await deviceCall('/v1/checkout', { plan: wanted, deviceCode });
    if (!out.ok) {
      if (out.code === 'already_subscribed') { lastCheckout = null; return alreadySubscribed(out); }
      return failure(out);
    }
    const data = out.data || {};
    const url = safeUrl(data.url);
    if (!url) return { ok: false, kind: 'unknown', message: 'The service did not return a checkout link.' };
    const expiresIn = finiteOr(codeData.expiresIn, CLAIM_WINDOW_MS / 1000);
    const trial = data.trial === true;
    lastCheckout = { deviceCode, url, plan: wanted, trial, expiresAt: d.now() + expiresIn * 1000 };
    log.info('account', `checkout started: ${wanted}`);
    return { ok: true, url, deviceCode, plan: wanted, trial, expiresIn, reused: false };
  }

  /** That checkout is over (paid, failed or expired), so Subscribe starts a new one. */
  function forgetCheckout(code) {
    if (lastCheckout && lastCheckout.deviceCode === code) lastCheckout = null;
  }

  async function alreadySubscribed(out) {
    let restored = false;
    if (!hasLicense()) {
      const back = await restore({ force: true });
      restored = !!(back.ok && back.restored);
    }
    log.info('account', `checkout refused: already subscribed (key restored: ${restored})`);
    return {
      ok: false,
      kind: 'already_subscribed',
      message: alreadySubscribedMessage(out.message),
      portalUrl: out.portalUrl || null,
      restored,
      manageNote: MESSAGES.manageElsewhere,
      ...snapshot()
    };
  }

  function sleep(ms, token) {
    return new Promise(resolve => {
      const t = setTimeout(() => { token.wake = null; resolve(); }, ms);
      token.wake = () => { clearTimeout(t); token.wake = null; resolve(); };
    });
  }

  function claimDelay(startedAt, r) {
    // A rate limit says how long to wait. Honour it.
    const retryAfter = r && !r.ok && r.retryAfter ? r.retryAfter : 0;
    return nextClaimDelay(d.now() - startedAt, retryAfter, { fastMs: d.claimFastMs, fastForMs: d.claimFastForMs, slowMs: d.claimSlowMs });
  }

  /** Answers from /v1/claim that asking again cannot change. */
  function claimIsFinal(r) {
    if (r.kind === 'not_connected') return true;
    // 400 bad_request, 401 device_unverified (after the one re-registration),
    // 403 license_revoked, 404 code_expired: all permanent. 429 is not.
    return r.status >= 400 && r.status < 500 && r.status !== 429;
  }

  async function claimSucceeded(license) {
    let key;
    try { key = d.secrets.normalizeLicense(license); } catch { key = ''; }
    if (!key) return { ok: false, kind: 'unknown', message: 'The service returned a license key this app does not recognize.' };
    const stored = storeLicense(key);
    writeStored({ ...FRESH_PLAN, ...NO_PROBLEM });
    log.info('account', 'license claimed');
    // Best effort: learn the plan now. A failure here changes nothing: the key is saved.
    const st = await status({ force: true });
    return { ok: true, secureStorage: stored.secureStorage !== false, storeMessage: stored.message || null, ...(st.ok ? st : snapshot()), cached: false };
  }

  /**
   * Before giving up on a purchase, ask once whether it went through anyway.
   *
   * /v1/restore hands back whatever key this Mac has on file, and a Mac whose
   * old subscription lapsed still has that old key on file. So a key coming
   * back is not proof of a purchase: only a key whose plan is served now
   * (`service: true`, or trialing/active) counts. A lapsed key is still saved
   * on this Mac, but the buyer is told the truth: the checkout did not finish.
   */
  async function lastChance(result) {
    const back = await restore({ force: true });
    const served = back.service === true || (back.service !== false && (back.status === 'trialing' || back.status === 'active'));
    if (back.ok && back.restored && served) return { ...back, ok: true, claimedBy: 'restore' };
    return result;
  }

  /**
   * Poll POST /v1/claim while the person pays in the browser: every 2 s for
   * the first 2 minutes, then every 5 s, until the device code expires.
   * Resolves with the license stored, or with why it stopped. Starting a new
   * poll cancels the previous one.
   */
  function pollClaim(deviceCode) {
    const code = String(deviceCode || '').trim();
    if (!DEVICE_CODE_RE.test(code)) return Promise.resolve({ ok: false, kind: 'unknown', message: 'No device code to claim.' });
    cancelClaim();

    const token = { cancelled: false, wake: null };
    activeClaim = token;
    const startedAt = d.now();
    const window = lastCheckout && lastCheckout.deviceCode === code
      ? Math.max(0, lastCheckout.expiresAt - startedAt)
      : d.claimWindowMs;
    const deadline = startedAt + Math.min(window, d.claimWindowMs);

    return (async () => {
      try {
        while (!token.cancelled && d.now() < deadline) {
          const r = await deviceCall('/v1/claim', { deviceCode: code });
          if (token.cancelled) break;

          if (r.ok) {
            const data = r.data || {};
            if (data.status === 'ready') { forgetCheckout(code); return await claimSucceeded(data.license); }
            if (data.status === 'failed') {
              forgetCheckout(code);
              return data.reason === 'payment_failed'
                ? { ok: false, kind: 'payment_failed', message: 'The payment did not go through, so nothing was charged.' }
                : { ok: false, kind: 'checkout_expired', message: 'That checkout expired before it was finished.' };
            }
            // Anything else is "pending": keep waiting.
          } else if (claimIsFinal(r)) {
            // An expired code may still have been paid for (the person took
            // longer than an hour, or the app was asleep). Ask before giving up.
            forgetCheckout(code);
            if (r.code === 'code_expired') return await lastChance(failure(r));
            return failure(r);
          }
          if (token.cancelled || d.now() >= deadline) break;
          await sleep(claimDelay(startedAt, r), token);
        }
        // Cancelled: only the waiting stops. The checkout page in the browser
        // still works, and Subscribe reopens it (lastCheckout is kept).
        if (token.cancelled) return { ok: false, kind: 'cancelled', message: 'Waiting for checkout was cancelled.' };
        // The window closed: the device code has expired. Settings and the
        // next launch will ask again (refresh), so a payment that lands later
        // is never lost.
        forgetCheckout(code);
        return await lastChance({ ok: false, kind: 'timeout', message: 'Checkout was not finished in time.' });
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

  /** A Stripe billing portal link (POST /v1/portal) for managing or cancelling. */
  async function portalUrl() {
    const license = getLicense();
    if (!license) return { ok: false, kind: 'no_license', message: 'There is no license key on this Mac.', manageNote: MESSAGES.manageElsewhere };
    const r = await deviceCall('/v1/portal', { license });
    if (!r.ok) return failure(r, { manageNote: MESSAGES.manageElsewhere });
    const url = safeUrl(r.data && r.data.url);
    return url
      ? { ok: true, url, manageNote: MESSAGES.manageElsewhere }
      : { ok: false, kind: 'unknown', message: 'The service did not return a billing link.', manageNote: MESSAGES.manageElsewhere };
  }

  return {
    configured, deviceId, ensureDevice, getLicense, hasLicense, clearLicense, snapshot, noteCheck, noteProblem,
    check, activate, status, restore, refresh, startCheckout, pollClaim, cancelClaim, portalUrl,
    apiBase: base,
    plans: PLANS, freeChecks: FREE_CHECKS, includedChecks: INCLUDED_CHECKS,
    _post: post, _deviceCall: deviceCall
  };
}

module.exports = {
  createAccount, apiBaseFrom, safeUrl, errorFromBody, classifyFetchError, nextClaimDelay, alreadySubscribedMessage,
  SERVICE_ERROR_KINDS, NEEDS_ACTION_KINDS, PLAN_PROBLEM_KINDS, MESSAGES, LINK_URL,
  DEVICE_ID_RE, DEVICE_TOKEN_RE,
  TIMEOUT_MS, CHECK_TIMEOUT_MS, STATUS_CACHE_MS, CLAIM_FAST_MS, CLAIM_FAST_FOR_MS, CLAIM_SLOW_MS, CLAIM_WINDOW_MS, RESTORE_EVERY_MS,
  CHECKOUT_REUSE_MARGIN_MS, LOCKED_GIVE_UP_MS
};
