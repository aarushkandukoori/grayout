'use strict';
// The person's permission to send screenshots to a third-party AI for checks.
//
// App Review 5.1.2(i) asks for explicit permission before personal data goes
// to a third-party AI, and 5.1.1(ii) for an easy way to take it back. Both
// editions ask: nothing is captured or sent until the person taps "Allow and
// continue", and the Settings switch "Send screenshots for checks" withdraws it.
//
// Stored in state.json as { granted, at, version }. A grant counts only for the
// CONSENT_VERSION it was given under: raise the version when what is sent, or
// who receives it, changes, and everyone is asked again.
const state = require('./state');
const providers = require('./providers');
const secrets = require('./secrets');
const channel = require('./channel');

const CONSENT_VERSION = 1;
const EMPTY = Object.freeze({ granted: false, at: null, version: null });

function stored() {
  const c = state.get().consent;
  return c && typeof c === 'object' && !Array.isArray(c) ? c : EMPTY;
}

/** True when the person said yes under the current CONSENT_VERSION. */
function valid() {
  const c = stored();
  return c.granted === true && c.version === CONSENT_VERSION;
}

/** Does this build ask at all? Both editions do (channel.features). */
function required() {
  return channel.features().aiConsentRequired !== false;
}

/** True when checks may capture and send: consent is not required, or it is valid. */
function satisfied() {
  return !required() || valid();
}

/**
 * { granted, at, version }. `granted` is the answer that counts: a grant made
 * under an older CONSENT_VERSION reads as false. `at` and `version` are what
 * was stored.
 */
function get() {
  const c = stored();
  return {
    granted: valid(),
    at: typeof c.at === 'string' ? c.at : null,
    version: Number.isInteger(c.version) ? c.version : null
  };
}

function grant(now = Date.now()) {
  state.update(s => { s.consent = { granted: true, at: new Date(now).toISOString(), version: CONSENT_VERSION }; });
  return get();
}

function revoke() {
  state.update(s => { s.consent = { ...EMPTY }; });
  return get();
}

/**
 * Who receives the screenshots under the engine and provider in use, for the
 * consent screen: { name, via }.
 *   hosted service  -> OpenAI, via the Grayout service
 *   own OpenAI key  -> OpenAI, via your own API key
 *   own Claude key  -> Anthropic, via your own API key
 *   Claude CLI      -> Anthropic, via your Claude CLI login
 */
function processor(config, apiKey) {
  // Required here, not at the top: analyzer pulls in the account client, and
  // nothing about consent should depend on load order.
  const { resolveEngine } = require('./analyzer');
  const cfg = config || {};
  if (resolveEngine(cfg) === 'cli') return { name: 'Anthropic', via: 'your Claude CLI login' };
  let key = apiKey;
  if (key === undefined) { try { key = secrets.getApiKey(); } catch { key = null; } }
  const { provider } = providers.resolve(cfg, key);
  if (provider === providers.HOSTED) return { name: 'OpenAI', via: 'the Grayout service' };
  if (provider === 'openai') return { name: 'OpenAI', via: 'your own API key' };
  return { name: 'Anthropic', via: 'your own API key' };
}

/** What the windows get: get() plus the processor. */
function payload(config, apiKey) {
  return { ...get(), processor: processor(config, apiKey) };
}

module.exports = { CONSENT_VERSION, get, grant, revoke, valid, required, satisfied, processor, payload };
