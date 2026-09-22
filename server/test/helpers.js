// Shared fixtures. Nothing in here reaches the network: the store is a Map, the
// model provider is a stub `fetch`, and Stripe is a hand-written object with
// the three methods this service calls.

import { memoryStore, keys } from '../src/store.js';

export const T0 = Date.parse('2026-09-22T12:00:00Z');
export const DEVICE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';

export const BASE_ENV = {
  SITE_BASE: 'https://grayout.app',
  SITE_ORIGINS: 'https://grayout.app',
  CHECKOUT_SUCCESS_PATH: '/success.html',
  CHECKOUT_CANCEL_PATH: '/pricing.html',
  PORTAL_RETURN_PATH: '/',
  MODEL: 'gpt-5-mini',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_MONTHLY: 'price_monthly_999',
  STRIPE_PRICE_YEARLY: 'price_yearly_79'
};

/** A clock the tests move by hand, so month rollover needs no sleeping. */
export function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    set(ms) { t = ms; },
    advance(ms) { t += ms; return t; }
  };
}

/** A verdict payload shaped like the OpenAI Responses API's. */
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

/**
 * A `fetch` that never leaves the process. Records every call so a test can
 * assert on the request body, and fails loudly if something asks for a host
 * this stub was not told about.
 */
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

/** The three Stripe methods this service uses, and a log of what it asked for. */
export function stubStripe(overrides = {}) {
  const calls = { checkout: [], retrieve: [], portal: [], webhook: [] };
  const client = {
    checkout: {
      sessions: {
        create: async params => {
          calls.checkout.push(params);
          if (overrides.checkoutError) throw overrides.checkoutError;
          return { id: 'cs_test_123', url: overrides.checkoutUrl || 'https://checkout.stripe.com/c/pay/cs_test_123' };
        },
        retrieve: async id => {
          calls.retrieve.push(id);
          if (overrides.retrieveError) throw overrides.retrieveError;
          return overrides.session || {
            id,
            status: 'complete',
            payment_status: 'paid',
            customer: 'cus_test_1',
            client_reference_id: null
          };
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async params => {
          calls.portal.push(params);
          if (overrides.portalError) throw overrides.portalError;
          return { id: 'bps_test', url: overrides.portalUrl || 'https://billing.stripe.com/p/session/test' };
        }
      }
    },
    webhooks: {
      constructEventAsync: async (payload, signature, secret) => {
        calls.webhook.push({ payload, signature, secret });
        if (overrides.verifyError) throw overrides.verifyError;
        return overrides.event || JSON.parse(payload);
      }
    }
  };
  client.calls = calls;
  return client;
}

/** Dependencies for `handleRequest`, all of them local. */
export function makeDeps(options = {}) {
  const c = options.clock || clock();
  const store = options.store || memoryStore({ now: c.now });
  const stripe = options.stripe || stubStripe(options.stripeOptions);
  const fetchImpl = options.fetchImpl || stubFetch(options.responder);
  return {
    store,
    env: { ...BASE_ENV, ...(options.env || {}) },
    now: c.now,
    clock: c,
    stripe: () => stripe,
    stripeClient: stripe,
    fetchImpl
  };
}

const ORIGIN = 'https://api.grayout.app';

export function post(path, body, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body || {})
  });
}

export function get(path, headers = {}) {
  return new Request(`${ORIGIN}${path}`, { method: 'GET', headers });
}

/** A working license record in the store, ready to be checked against. */
export async function seedLicense(store, patch = {}) {
  const license = patch.license || LICENSE;
  const record = {
    customerId: 'cus_test_1',
    subscriptionId: 'sub_test_1',
    plan: 'monthly',
    status: 'active',
    periodEnd: '2026-10-22T00:00:00.000Z',
    createdAt: '2026-09-22T00:00:00.000Z',
    revokedAt: null,
    ...patch
  };
  delete record.license;
  await store.put(keys.license(license), record);
  if (record.customerId) await store.put(keys.customer(record.customerId), license);
  return { license, record };
}

/** A minimal valid /v1/check body. */
export function checkBody(patch = {}) {
  return {
    deviceId: DEVICE_ID,
    displays: ['QUJDRA=='],
    webcam: null,
    context: { workDescription: '', frontApp: 'Code', canvasTasks: [], fileTasks: [] },
    ...patch
  };
}

export const jsonOf = res => res.json();
