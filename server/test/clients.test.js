// The two clients against this Worker (contract v3): the Mac app's real
// account client (src/account.js, with the real analyzer payload) talks to the
// real request handler in this process, and the website's calls (docs/*.js)
// are checked path by path, header by header.
//
// Why here and not in the app's tests: the app's `npm test` runs in CI before
// server/node_modules is installed, and this file needs the server's fakes.
// Nothing here touches the network: Stripe is the in-memory fake and the
// model is a stub (test/helpers.js).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRequest } from '../src/index.js';
import { ERRORS } from '../src/http.js';
import { FREE_CHECKS, INCLUDED_CHECKS, TRIAL_CHECKS } from '../src/config.js';
import { SCREENSHOT, harness } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');
const SITE = 'https://aarushkandukoori.github.io';
const BASE = 'https://grayout-api.test.workers.dev';

// The app's modules resolve their data folder when they are first required,
// so point it at a throwaway folder before requiring any of them.
const userData = mkdtempSync(join(tmpdir(), 'grayout-clients-'));
process.env.GRAYOUT_USER_DATA = userData;
delete process.env.GRAYOUT_API_BASE;
delete process.env.GRAYOUT_LICENSE;
const require = createRequire(import.meta.url);
const secrets = require('../../src/secrets.js');
const state = require('../../src/state.js');
const accountModule = require('../../src/account.js');
const analyzer = require('../../src/analyzer.js');
const appPricing = require('../../src/pricing.js');
const capture = require('../../src/capture.js');

after(() => rmSync(userData, { recursive: true, force: true }));

/** A Keychain stand-in: "encrypts" by copying, so tests need no macOS. */
const plainSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(s),
  decryptString: b => b.toString()
};

/** A fresh Mac (no device, no key) whose account client talks to harness `h`. */
function macAgainst(h) {
  secrets._setSafeStorage(plainSafeStorage);
  try { secrets.clearLicense(); } catch {}
  try { secrets.useSessionLicense(null); } catch {}
  try { secrets.clearDeviceToken(); } catch {}
  state.update(s => { s.account = null; s.deviceId = null; });
  return accountModule.createAccount({
    getConfig: () => ({ apiBase: BASE }),
    // The app's fetch goes straight into the Worker's handler.
    fetch: (url, init) => handleRequest(new Request(url, init), h.deps),
    claimFastMs: 1, claimSlowMs: 1, claimFastForMs: 10, claimWindowMs: 2000
  });
}

/** One check the way the watch loop makes it: through the real analyzer. */
function appCheck(account) {
  return analyzer.analyzeViaGrayout({
    screenshotsB64: [SCREENSHOT],
    webcamB64: null,
    workDescription: 'Writing a paper',
    canvasTasks: ['Essay draft'],
    fileTasks: [],
    frontApp: 'Code',
    account
  });
}

/** Buy in the app: Subscribe, pay at the (fake) Stripe, poll until the key arrives. */
async function buyInApp(h, account, plan = 'monthly') {
  const start = await account.startCheckout(plan);
  assert.equal(start.ok, true, JSON.stringify(start));
  const [row] = h.db.rows('SELECT session_id FROM checkout_sessions ORDER BY created_at DESC LIMIT 1');
  h.stripe.completeSession(row.session_id);
  const claimed = await account.pollClaim(start.deviceCode);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  return { start, claimed };
}

/** A regular expression literal from a client file, e.g. `LICENSE_RE: /^gry_…$/`. */
function regexFrom(source, name) {
  const m = new RegExp(`${name}\\s*[:=]\\s*\\/(.+?)\\/([gimsuy]*)\\s*[,;\\n]`).exec(source);
  assert.ok(m, `${name} not found`);
  return new RegExp(m[1], m[2]);
}

/** Every '/v1/…' path a client file names. */
function pathsIn(source) {
  return [...new Set([...source.matchAll(/'(\/v1\/[a-z/-]+)'/g)].map(m => m[1]))].sort();
}

/** The endpoint table of contract section 6: { 'POST /v1/check': true, … }. */
function contractRoutes() {
  const text = read('docs/API-CONTRACT.md');
  const table = text.slice(text.indexOf('## 6. Endpoints'), text.indexOf('### 6.1'));
  return new Set([...table.matchAll(/^\| (GET|POST) \| `(\/v1\/[a-z/-]+)` \|/gm)].map(m => `${m[1]} ${m[2]}`));
}

/** The error table of contract section 8: { code: httpStatus }. */
function contractErrors() {
  const text = read('docs/API-CONTRACT.md');
  const table = text.slice(text.indexOf('## 8. Error codes'), text.indexOf('## 9.'));
  return Object.fromEntries([...table.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map(m => [m[1], Number(m[2])]));
}

const APP_FILES = ['src/account.js'];
const SITE_FILES = ['docs/app.js', 'docs/claim.js', 'docs/account.js'];

// ======================================================================

describe('every call a client makes is one this Worker answers, as the contract lists it', () => {
  const routes = contractRoutes();

  test('the contract table and the Worker agree on every method and path', async () => {
    assert.equal(routes.size, 11, 'section 6 lists 11 endpoints');
    const h = harness();
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const res = await h.call(path, method === 'GET' ? undefined : {}, { method });
      assert.notEqual(res.status, 404, route);
      assert.notEqual(res.status, 405, route);
    }
  });

  test('the app only calls contract endpoints, always with POST', () => {
    const used = pathsIn(read(APP_FILES[0]));
    assert.deepEqual(used, [
      '/v1/activate', '/v1/check', '/v1/checkout', '/v1/claim', '/v1/device', '/v1/device-code',
      '/v1/portal', '/v1/restore', '/v1/status'
    ]);
    for (const path of used) assert.ok(routes.has(`POST ${path}`), path);
    // The one transport function sends POST and JSON, nothing else.
    assert.match(read(APP_FILES[0]), /method: 'POST',\s*headers: \{ 'content-type': 'application\/json'/);
  });

  test('the site only calls contract endpoints, and each one answers the site origin (CORS)', async () => {
    const used = [...new Set(SITE_FILES.flatMap(f => pathsIn(read(f))))].sort();
    assert.deepEqual(used, ['/v1/checkout', '/v1/claim', '/v1/device', '/v1/health', '/v1/portal']);
    const h = harness();
    for (const path of used) {
      const method = path === '/v1/health' ? 'GET' : 'POST';
      assert.ok(routes.has(`${method} ${path}`), path);
      if (path === '/v1/portal') continue; // below: only when config.js turns it on
      // The preflight a browser sends before the site's POST (it sends one header: Content-Type).
      const pre = await h.call(path, null, {
        method: 'OPTIONS',
        headers: { Origin: SITE, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' }
      });
      assert.equal(pre.status, 204, path);
      assert.equal(pre.headers.get('Access-Control-Allow-Origin'), SITE, path);
      assert.ok(pre.headers.get('Access-Control-Allow-Methods').split(/,\s*/).includes(method), path);
      assert.ok(pre.headers.get('Access-Control-Allow-Headers').toLowerCase().split(/,\s*/).includes('content-type'), path);
    }
  });

  test('/v1/portal answers no browser, so the site keeps its paste-a-key form switched off', async () => {
    const h = harness();
    const pre = await h.call('/v1/portal', null, { method: 'OPTIONS', headers: { Origin: SITE } });
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
    assert.match(read('docs/config.js'), /licensePortal: false/);
  });

  test('the site can read the request id and Retry-After on a refusal', async () => {
    const h = harness();
    const res = await h.call('/v1/checkout', {}, { headers: { Origin: SITE } });
    assert.equal(res.status, 401);
    const exposed = (res.headers.get('Access-Control-Expose-Headers') || '').toLowerCase().split(/,\s*/);
    assert.ok(exposed.includes('x-grayout-request-id'), 'checkoutError() shows it');
    assert.ok(exposed.includes('retry-after'), 'api() falls back on it');
    assert.ok(res.headers.get('X-Grayout-Request-Id'));
  });
});

describe('error codes: the Worker, the contract and the app', () => {
  test('the Worker sends exactly the codes in contract section 8, with the same HTTP status', () => {
    const table = contractErrors();
    assert.deepEqual(Object.keys(ERRORS).sort(), Object.keys(table).sort());
    for (const [code, { status }] of Object.entries(ERRORS)) assert.equal(status, table[code], code);
  });

  test('every code the Worker can send to the app has a kind in the app', () => {
    const { SERVICE_ERROR_KINDS } = accountModule;
    // invalid_signature is for Stripe; not_found and method_not_allowed mean a
    // wrong path, which the app falls back on by HTTP status.
    for (const code of Object.keys(ERRORS)) {
      if (['invalid_signature', 'not_found', 'method_not_allowed'].includes(code)) continue;
      assert.ok(SERVICE_ERROR_KINDS[code], `src/account.js has no kind for ${code}`);
    }
  });
});

describe('numbers both sides must agree on', () => {
  test('the monthly allowance is the contract number in the Worker, the app and the site', () => {
    assert.equal(INCLUDED_CHECKS, 10000, 'contract sections 2 and 13');
    assert.equal(appPricing.INCLUDED_CHECKS, INCLUDED_CHECKS, 'src/pricing.js');
    assert.equal(appPricing.FREE_CHECKS, FREE_CHECKS, 'src/pricing.js');
    assert.match(read('docs/API-CONTRACT.md'), /\| 10,000 checks a month \|/);
    assert.match(read('docs/pricing.html'), /10,000 checks a month/);
    assert.match(read('docs/terms.html'), /10,000 checks a month/);
  });

  test('the app shrinks every screenshot to what the Worker accepts (1366 wide, 2732 tall)', () => {
    assert.equal(capture.MAX_WIDTH, 1366);
    assert.equal(capture.MAX_HEIGHT, 2732);
    assert.equal(capture.fitSize(1280, 800), null, 'small enough already');
    assert.deepEqual(capture.fitSize(3024, 1964), { width: 1366, height: 887 });
    // A portrait display narrower than 1366 but taller than 2732: shrunk by height.
    assert.deepEqual(capture.fitSize(1200, 3600), { width: 911, height: 2732 });
    for (const [w, h] of [[5120, 2880], [2880, 5120], [1366, 2733], [7, 99999], [3456, 2234]]) {
      const fit = capture.fitSize(w, h);
      assert.ok(fit.width <= 1366 && fit.height <= 2732, `${w}x${h} → ${fit.width}x${fit.height}`);
    }
  });
});

describe('the Mac app (src/account.js) against this Worker', () => {
  test('free taste: the analyzer payload is accepted and the answer fills the plan panel', async () => {
    const h = harness();
    const mac = macAgainst(h);
    const result = await appCheck(mac);
    assert.equal(result.verdict.off_task, false);
    assert.deepEqual(result.service, {
      plan: 'free', service: true, usage: { checksUsed: 1, checksIncluded: FREE_CHECKS, periodEnd: null, resetsAt: null }
    });
    // What the loop does with it, and what the windows then show.
    const snap = mac.noteCheck(result.service);
    assert.equal(snap.status, 'free');
    assert.deepEqual([snap.usage.checksUsed, snap.usage.checksIncluded], [1, FREE_CHECKS]);
    // The device the Worker minted is the one the app saved.
    const [device] = h.db.rows('SELECT device_id, free_used FROM devices');
    assert.deepEqual([device.device_id, device.free_used], [mac.deviceId(), 1]);
  });

  test('buying in the app: device code, checkout, claim, then the plan and paid checks', async () => {
    const h = harness();
    const mac = macAgainst(h);
    const { start, claimed } = await buyInApp(h, mac, 'monthly');
    assert.match(start.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(start.trial, true);
    assert.match(start.deviceCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // The key is stored, and the plan the Worker reported is what the app shows.
    assert.match(secrets.getLicense(), /^gry_test_[0-9A-HJKMNP-TV-Z]{24}$/);
    assert.equal(claimed.hasLicense, true);
    assert.equal(claimed.status, 'trialing');
    assert.equal(claimed.service, true);
    assert.equal(claimed.interval, 'monthly');
    assert.equal(claimed.usage.checksIncluded, TRIAL_CHECKS, 'a trial shows the trial allowance');
    assert.ok(claimed.trialEnd && Date.parse(claimed.trialEnd) > 0);
    assert.equal(claimed.periodEnd, claimed.trialEnd);

    const paid = await appCheck(mac);
    assert.equal(paid.service.plan, 'trialing');
    assert.equal(paid.service.usage.checksUsed, 1);

    const portal = await mac.portalUrl();
    assert.equal(portal.ok, true);
    assert.match(portal.url, /^https:\/\/billing\.stripe\.com\//);
    assert.match(portal.manageNote, /link\.com/);
  });

  test('Subscribe on a subscribed Mac: 409, a billing link, and no second checkout session', async () => {
    const h = harness();
    const mac = macAgainst(h);
    await buyInApp(h, mac, 'monthly');
    const again = await mac.startCheckout('yearly');
    assert.equal(again.kind, 'already_subscribed');
    assert.match(again.portalUrl, /^https:\/\/billing\.stripe\.com\//);
    assert.match(again.message, /Nothing new was charged\.$/);
    assert.equal(/\bsubscribe\b/i.test(again.message), false);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM checkout_sessions')[0].n, 1);
  });

  test('a failed payment: the Worker says to fix it, and the app shows that, not just "subscribed"', async () => {
    const h = harness();
    const mac = macAgainst(h);
    await buyInApp(h, mac, 'monthly');
    for (const sub of h.stripe.subs.values()) sub.status = 'past_due';
    const again = await mac.startCheckout('monthly');
    assert.equal(again.kind, 'already_subscribed');
    assert.match(again.message, /waiting on a payment/);
    assert.match(again.message, /link\.com/);
    assert.match(again.message, /Nothing new was charged\.$/);
  });

  test('a lost key: no_license on a check, /v1/restore brings it back, and the check goes through', async () => {
    const h = harness();
    const mac = macAgainst(h);
    await buyInApp(h, mac, 'monthly');
    const key = secrets.getLicense();
    secrets.clearLicense();
    const result = await appCheck(mac);
    assert.equal(result.service.plan, 'trialing');
    assert.equal(secrets.getLicense(), key);
  });

  test('pasting the key on a second Mac: /v1/activate answers the account object the app reads', async () => {
    const h = harness();
    const first = macAgainst(h);
    await buyInApp(h, first, 'monthly');
    const key = secrets.getLicense();
    const second = macAgainst(h);
    const r = await second.activate(key);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.status, r.plan, r.service, r.interval, r.cancelAtPeriodEnd], ['trialing', 'trialing', true, 'monthly', false]);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM devices WHERE license_id IS NOT NULL')[0].n, 2);
  });

  test('device_unverified: the app registers again once, retries once, and carries on', async () => {
    const h = harness();
    const mac = macAgainst(h);
    // A well-formed identity this Worker never minted (or one from before a DEVICE_SECRET rotation).
    state.update(s => { s.deviceId = 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G'; });
    secrets.setDeviceToken('abcdefghijABCDEFGHIJ0123456789-_abcdefghijk');
    const result = await appCheck(mac);
    assert.equal(result.service.plan, 'free');
    assert.notEqual(mac.deviceId(), 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G');
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM devices')[0].n, 1);
  });

  test('a Worker that cannot sell yet: checkout is not_configured, and the app says so plainly', async () => {
    // Like the live Worker today: no price ids, no sandbox licenses.
    const h = harness({ env: { STRIPE_PRICE_MONTHLY: '', STRIPE_PRICE_YEARLY: '', ALLOW_TEST_LICENSES: '' } });
    const mac = macAgainst(h);
    const r = await mac.startCheckout('monthly');
    assert.deepEqual([r.ok, r.kind], [false, 'not_configured']);
    assert.match(r.message, /missing a setting/);
    assert.equal(h.stripe.calls.filter(c => c.name === 'checkout.sessions.create').length, 0);
  });
});

describe('the website (docs/) against this Worker', () => {
  const appJs = read('docs/app.js');
  const claimJs = read('docs/claim.js');
  const DEV_ID_RE = regexFrom(appJs, 'DEV_ID_RE');
  const DEV_TOKEN_RE = regexFrom(appJs, 'DEV_TOKEN_RE');
  const LICENSE_RE = regexFrom(appJs, 'LICENSE_RE');
  const SESSION_RE = regexFrom(claimJs, 'SESSION_RE');

  test('a website purchase: mint, checkout, Stripe, claim by session id; every answer passes the site\'s own checks', async () => {
    const h = harness();
    const opts = { headers: { Origin: SITE } };
    // ensureDevice() in docs/app.js
    const device = await h.call('/v1/device', {}, opts);
    assert.equal(device.status, 200);
    assert.match(device.body.deviceId, DEV_ID_RE);
    assert.match(device.body.deviceToken, DEV_TOKEN_RE);
    // initCheckout() → deviceCall('/v1/checkout', { plan })
    const checkout = await h.call('/v1/checkout', { deviceId: device.body.deviceId, deviceToken: device.body.deviceToken, plan: 'monthly' }, opts);
    assert.equal(checkout.status, 200);
    assert.equal(new URL(checkout.body.url).hostname, 'checkout.stripe.com', 'CHECKOUT_HOSTS');
    assert.equal(checkout.body.trial, true);
    assert.match(checkout.body.sessionId, SESSION_RE);
    // Stripe sends the buyer to success.html?session_id=…; claim.js polls.
    const before = await h.call('/v1/claim', { sessionId: checkout.body.sessionId }, opts);
    assert.deepEqual(before.body, { status: 'pending' });
    h.stripe.completeSession(checkout.body.sessionId);
    h.clock.advance(11); // the Worker asks Stripe at most once every 10 seconds per session
    const ready = await h.call('/v1/claim', { sessionId: checkout.body.sessionId }, opts);
    assert.equal(ready.body.status, 'ready');
    assert.match(ready.body.license, LICENSE_RE);
    assert.equal(ready.headers.get('Access-Control-Allow-Origin'), SITE);
  });

  test('the answers claim.js stops on: a malformed id is bad_request, an unknown one code_expired', async () => {
    const h = harness();
    const bad = await h.call('/v1/claim', { sessionId: 'cs_test_short' }, { headers: { Origin: SITE } });
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'bad_request']);
    const unknown = await h.call('/v1/claim', { sessionId: 'cs_test_abcdefghijklmnop' }, { headers: { Origin: SITE } });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'code_expired']);
    assert.equal(h.stripe.calls.length, 0, 'unknown ids never reach Stripe');
    // claim.js maps exactly these codes to its badlink and expired states.
    assert.match(claimJs, /r\.code === 'bad_request'\) \{ show\('badlink'\)/);
    assert.match(claimJs, /r\.code === 'code_expired'\) \{ show\('expired'\)/);
  });

  test('a browser that already bought: the second checkout is 409 with a billing link the site will open', async () => {
    const h = harness();
    const opts = { headers: { Origin: SITE } };
    const device = (await h.call('/v1/device', {}, opts)).body;
    const first = await h.call('/v1/checkout', { ...device, plan: 'yearly' }, opts);
    h.stripe.completeSession(first.body.sessionId);
    await h.call('/v1/claim', { sessionId: first.body.sessionId }, opts);
    const second = await h.call('/v1/checkout', { ...device, plan: 'monthly' }, opts);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'already_subscribed');
    assert.equal(new URL(second.body.error.portalUrl).hostname, 'billing.stripe.com', 'PORTAL_HOSTS');
    assert.equal(second.headers.get('Access-Control-Allow-Origin'), SITE);
  });

  test('a Worker that cannot sell yet answers the site not_configured, which the site words plainly', async () => {
    const h = harness({ env: { STRIPE_PRICE_MONTHLY: '', STRIPE_PRICE_YEARLY: '', ALLOW_TEST_LICENSES: '' } });
    const opts = { headers: { Origin: SITE } };
    const device = (await h.call('/v1/device', {}, opts)).body;
    const res = await h.call('/v1/checkout', { ...device, plan: 'monthly' }, opts);
    assert.deepEqual([res.status, res.body.error.code], [503, 'not_configured']);
    assert.match(appJs, /case 'not_configured':\s*return \[\['Checkout is not available right now\./);
  });
});
