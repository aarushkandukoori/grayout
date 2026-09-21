'use strict';
// Which AI provider a key belongs to, and which model to use with it.
// Grayout speaks to Anthropic (claude-*) or OpenAI (gpt-*) with the user's own
// key; the provider is detected from the key so there is nothing to configure.

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini'
};

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
 * wins; otherwise the key decides; otherwise the model family; otherwise
 * Anthropic. The model is used only if it belongs to the provider's family.
 */
function resolve(config, key) {
  const cfg = config || {};
  let provider = (cfg.provider === 'anthropic' || cfg.provider === 'openai') ? cfg.provider : null;
  if (!provider) provider = detectProviderFromKey(key);
  if (!provider) provider = providerOfModel(cfg.model) || 'anthropic';
  const model = providerOfModel(cfg.model) === provider ? cfg.model : DEFAULT_MODELS[provider];
  return { provider, model };
}

function label(provider) {
  return provider === 'openai' ? 'OpenAI' : 'Anthropic';
}

function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model || '');
}

module.exports = { DEFAULT_MODELS, FAMILY, detectProviderFromKey, providerOfModel, resolve, label, isReasoningModel };
