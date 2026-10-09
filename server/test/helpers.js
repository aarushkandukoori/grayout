// Shared test setup. One `harness()` call gives a fresh in-memory database,
// fake rate limiters, a fake Stripe, a stub model provider and a clock that
// only moves when a test moves it. Nothing reaches the network.

import Stripe from 'stripe';
import { handleRequest } from '../src/index.js';
import { D1Shim } from './d1.js';
import { FakeStripe, fakeLimiters } from './fakes.js';

/** 2026-10-08T12:00:00Z in Unix seconds. */
export const T0 = Date.parse('2026-10-08T12:00:00Z') / 1000;
export const DAY = 86400;

export const PRICES = { monthly: 'price_monthly_test1', yearly: 'price_yearly_test1' };
export const PRODUCT = 'prod_grayout_test1';

/**
 * A tiny JPEG with the given size, as base64: start-of-image, a JFIF header,
 * a frame header (which holds the width and height), end-of-image. It has no
 * pixels, which is fine: the fake model never looks at them, and the service
 * only reads the size.
 */
export function tinyJpeg(width = 1366, height = 854) {
  const bytes = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9
  ];
  return Buffer.from(bytes).toString('base64');
}

/** A screenshot-sized JPEG, the image every check in the tests sends. */
export const SCREENSHOT = tinyJpeg(1366, 854);

// Test-only values. None of them is a real key; each has the right shape so
// the configuration checks accept it.
export const SECRETS = {
  STRIPE_SECRET_KEY: 'rk_test_51TestOnlyRestrictedKey0123456789',
  STRIPE_WEBHOOK_SECRET: 'whsec_TestOnlySigningSecret0123456789abcdefgh',
  OPENAI_API_KEY: 'sk-test-model-key-not-real',
  DEVICE_SECRET: 'test-device-secret-0123456789-abcdefghijklmnop',
  LICENSE_SECRET: 'test-license-secret-0123456789-abcdefghijklmn'
};

export function baseEnv() {
  return {
    SITE_URL: 'https://aarushkandukoori.github.io/grayout',
    SITE_ORIGINS: 'https://aarushkandukoori.github.io',
    STRIPE_PRODUCT: PRODUCT,
    STRIPE_PRICE_MONTHLY: PRICES.monthly,
    STRIPE_PRICE_YEARLY: PRICES.yearly,
    // The tests run as the sandbox Worker: a test key, and test licenses allowed.
    ALLOW_TEST_LICENSES: '1',
    FREE_DAILY_BUDGET: '3000',
    SUPPORT_EMAIL: 'help@grayout.test',
    MODEL: 'gpt-5-mini',
    ...SECRETS
  };
}

/** A verdict shaped like the OpenAI Responses API's answer. */
export function responsesPayload(verdict = { off_task: false, activity: 'code editor and terminal', confidence: 'high' }, extra = {}) {
  return {
    id: 'resp_test',
    model: 'gpt-5-mini-2026-01-01',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(verdict) }] }],
    usage: { input_tokens: 2122, output_tokens: 90 },
    ...extra
  };
}

/** A fetch that never leaves the process and records what it was asked. */
export function stubFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const out = typeof responder === 'function' ? await responder(url, init, calls.length) : responder;
    if (out instanceof Response) return out;
    const { status = 200, json: payload = responsesPayload(), text = null } = out || {};
    return new Response(text !== null ? text : JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  impl.calls = calls;
  return impl;
}

const BASE = 'https://grayout-api.test.workers.dev';

/**
 * A fresh world for one test.
 * Returns { env, deps, db, stripe, clock, fetch, call, mint, ... }.
 */
export function harness({ env: envPatch = {}, responder } = {}) {
  let now = T0;
  const clock = {
    now: () => now,
    set(t) { now = t; },
    advance(seconds) { now += seconds; return now; }
  };
  const db = new D1Shim();
  const limiters = fakeLimiters();
  const env = { DB: db, ...limiters, ...baseEnv(), ...envPatch };
  // Sessions are live-mode when the harness runs as the live Worker (a live key).
  const livemode = /^(rk|sk)_live_/.test(String(env.STRIPE_SECRET_KEY || ''));
  const stripe = new FakeStripe({ now: clock.now, prices: PRICES, product: PRODUCT, livemode });
  const fetchImpl = stubFetch(responder);
  const deps = { env, now: clock.now, stripe: () => stripe, fetchImpl };

  /** Send one request. Returns { status, body, headers }. */
  async function call(path, body, { method = 'POST', headers = {}, ip = '203.0.113.7', raw = null } = {}) {
    const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
    if (method !== 'GET' && method !== 'OPTIONS' && method !== 'HEAD') {
      init.headers = { 'Content-Type': 'application/json', ...init.headers };
      init.body = raw !== null ? raw : JSON.stringify(body === undefined ? {} : body);
    }
    const res = await handleRequest(new Request(BASE + path, init), deps);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  /** Mint a device. Returns { deviceId, deviceToken }. */
  async function mint(ip = '203.0.113.7') {
    const res = await call('/v1/device', {}, { ip });
    if (res.status !== 200) throw new Error(`mint failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** Deliver a Stripe event, signed with the configured secret. */
  async function deliver(event, { secret = env.STRIPE_WEBHOOK_SECRET } = {}) {
    const payload = JSON.stringify(event);
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    return call('/v1/stripe/webhook', null, { raw: payload, headers: { 'Stripe-Signature': signature } });
  }

  /**
   * The app's whole purchase: device code → checkout → buyer pays at Stripe.
   * Returns everything a test needs to continue.
   */
  async function appPurchase(device, { plan = 'monthly', paymentStatus, email, card } = {}) {
    const code = await call('/v1/device-code', device);
    const checkout = await call('/v1/checkout', { ...device, plan, deviceCode: code.body.deviceCode });
    if (checkout.status !== 200) return { checkout };
    const { session, subscription } = stripe.completeSession(checkout.body.sessionId, { paymentStatus, email, card });
    return { code: code.body.deviceCode, checkout, session, subscription };
  }

  return {
    env, deps, db, stripe, clock, limiters, fetch: fetchImpl, call, mint, deliver, appPurchase,
    checkBody: (device, patch = {}) => ({
      ...device,
      displays: [SCREENSHOT],
      webcam: null,
      context: { workDescription: '', frontApp: 'Code', canvasTasks: [], fileTasks: [] },
      ...patch
    })
  };
}

let eventCounter = 0;

/** A Stripe event envelope around an object. */
export function stripeEvent(type, object, { id } = {}) {
  eventCounter += 1;
  return {
    id: id || `evt_test_${String(eventCounter).padStart(6, '0')}`,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: T0,
    livemode: false,
    type,
    data: { object }
  };
}

/** Parse wrangler.jsonc: JSON with // comments (but "https://" inside strings is kept). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i]; continue; }
      if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
