'use strict';
// Who runs the check.
//
// By default that is the hosted Grayout service ('grayout'): the app sends the
// frames with its license key and the service calls the model with its own.
// Self-hosters keep the v1 path — set `provider` to anthropic/openai in
// config.json, or just save a model key, and the app talks to that provider
// directly and never touches the service.

const HOSTED = 'grayout';

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  // The hosted service picks and pays for the model; the client never names one.
  grayout: 'grayout'
};

const PROVIDERS = ['grayout', 'anthropic', 'openai'];

const FAMILY = {
  anthropic: /^claude-/i,
  openai: /^(gpt-|o\d)/i
};

function detectProviderFromKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (/^sk-/.test(k)) return 'openai';
  return null;
}

function providerOfModel(model) {
  if (FAMILY.anthropic.test(model || '')) return 'anthropic';
  if (FAMILY.openai.test(model || '')) return 'openai';
  return null;
}

/**
 * Resolve { provider, model } for a config + key. An explicit config.provider
 * wins; otherwise a saved model key means self-hosting on that provider;
 * otherwise the hosted service. The model is used only if it belongs to the
 * provider's family.
 */
function resolve(config, key) {
  const cfg = config || {};
  const explicit = PROVIDERS.includes(cfg.provider) ? cfg.provider : null;
  if (explicit === HOSTED) return { provider: HOSTED, model: DEFAULT_MODELS[HOSTED] };
  // No choice made and no model key on this Mac: the product is the service.
  const provider = explicit || detectProviderFromKey(key);
  if (!provider) return { provider: HOSTED, model: DEFAULT_MODELS[HOSTED] };
  const model = providerOfModel(cfg.model) === provider ? cfg.model : DEFAULT_MODELS[provider];
  return { provider, model };
}

/** True when this config + key runs through the hosted service. */
function isHosted(config, key) {
  return resolve(config, key).provider === HOSTED;
}

function label(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === HOSTED) return 'Grayout';
  return 'Anthropic';
}

function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model || '');
}

module.exports = { HOSTED, PROVIDERS, DEFAULT_MODELS, FAMILY, detectProviderFromKey, providerOfModel, resolve, isHosted, label, isReasoningModel };
