'use strict';
// Two separate things live here.
//
// 1. What Grayout costs the person: the subscription facts (PLANS, FREE_CHECKS,
//    INCLUDED_CHECKS). Every window that prints a price reads them from here so
//    there is one place to change a price.
// 2. What a check costs to run: the model list prices below, in USD per million
//    tokens, as of PRICE_DATE. Those matter only to self-hosters running on
//    their own API key, and to the local cost meter.

// Subscription, decided from measured unit costs (docs/API-CONTRACT.md).
const FREE_CHECKS = 100;        // the free taste: no card, no account, device-bound
const INCLUDED_CHECKS = 15000;  // checks a month on either paid plan

const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    price: 9.99,
    priceLabel: '$9.99',
    period: 'month',
    periodLabel: 'a month',
    trialDays: 7,
    includedChecks: INCLUDED_CHECKS
  },
  yearly: {
    id: 'yearly',
    name: 'Yearly',
    price: 79,
    priceLabel: '$79',
    period: 'year',
    periodLabel: 'a year',
    trialDays: 0,
    includedChecks: INCLUDED_CHECKS
  }
};

// Derived, never hand-written: a stale "save 34%" is a false claim.
PLANS.yearly.perMonth = Math.round((PLANS.yearly.price / 12) * 100) / 100;
PLANS.yearly.perMonthLabel = `$${PLANS.yearly.perMonth.toFixed(2)}`;
PLANS.yearly.savingsPercent = Math.round((1 - PLANS.yearly.price / (PLANS.monthly.price * 12)) * 100);

function planFacts(id) {
  return PLANS[id] || null;
}

const PRICES = {
  // Anthropic
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-5': { input: 2.00, output: 10.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-5': { input: 5.00, output: 25.00 },
  // OpenAI
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-5.6-luna': { input: 0.20, output: 1.20 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 }
};
const PRICE_DATE = '2026-09-21';

// OpenAI bills images as 32-px patches times a per-model multiplier
// (capped at 1536 patches); Anthropic bills roughly width*height/750.
const OPENAI_IMAGE_MULTIPLIER = {
  'gpt-5-nano': 1.5,
  'gpt-4.1-mini': 1.62
};
const OPENAI_DEFAULT_MULTIPLIER = 1.2;

// Typical MacBook capture after Grayout's resize to 1366 px wide (16:10).
const SCREEN_W = 1366, SCREEN_H = 854;
const WEBCAM_W = 640, WEBCAM_H = 480;
const PROMPT_TOKENS = 700;
// Output includes the ~40-token verdict plus, for OpenAI reasoning models,
// the brief reasoning they bill as output at low effort (measured 2026-09-21:
// gpt-5-mini 74-91 output tokens, 2060-2111 input tokens per single-display check).
const OUTPUT_TOKENS = { anthropic: 40, openai: 90 };

function priceFor(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  // Dated aliases like claude-haiku-4-5-20251001 / gpt-5-mini-2025-08-07 share the base price.
  const base = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(k => String(model).startsWith(k));
  return base ? PRICES[base] : null;
}

function providerOf(model) {
  return /^(gpt-|o\d)/i.test(model || '') ? 'openai' : 'anthropic';
}

function imageTokens(model, w = SCREEN_W, h = SCREEN_H) {
  if (providerOf(model) === 'openai') {
    let patches = Math.ceil(w / 32) * Math.ceil(h / 32);
    if (patches > 1536) patches = 1536;
    const base = Object.keys(OPENAI_IMAGE_MULTIPLIER).find(k => String(model).startsWith(k));
    const mult = base ? OPENAI_IMAGE_MULTIPLIER[base] : OPENAI_DEFAULT_MULTIPLIER;
    if (/^gpt-4o/.test(model)) return 8500; // tile-based accounting, much pricier
    return Math.ceil(patches * mult);
  }
  return Math.min(1600, Math.ceil((w * h) / 750));
}

function costUsd(usage, model) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const inp = Number(usage.input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  return (inp * p.input + out * p.output) / 1e6;
}

function perCheckUsd({ displays = 1, camera = false, model = 'claude-haiku-4-5' } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const input = PROMPT_TOKENS + imageTokens(model) * Math.max(1, displays) + (camera ? imageTokens(model, WEBCAM_W, WEBCAM_H) : 0);
  const output = OUTPUT_TOKENS[providerOf(model)];
  return (input * p.input + output * p.output) / 1e6;
}

// Calibrated to the author's observed cadence: 506 successful checks on an
// active day at 30 s, one display, padded ~8% for failed/retried calls that
// still bill. On Haiku 4.5 that lands at about $1.35 / $0.90 / $0.45 per day
// for 30 / 45 / 90 s.
const OBSERVED_CHECKS_PER_DAY_AT_30S = 550;

function checksPerDay(intervalSec) {
  return OBSERVED_CHECKS_PER_DAY_AT_30S * (30 / Math.max(10, intervalSec));
}

function estimateDaily(intervalSec, opts = {}) {
  const per = perCheckUsd(opts);
  if (per === null) return null;
  return per * checksPerDay(intervalSec);
}

function estimateMonthly(intervalSec, opts = {}) {
  const d = estimateDaily(intervalSec, opts);
  return d === null ? null : d * 22;
}

module.exports = {
  PLANS, FREE_CHECKS, INCLUDED_CHECKS, planFacts,
  PRICES, PRICE_DATE, priceFor, providerOf, imageTokens, costUsd, perCheckUsd, estimateDaily, estimateMonthly,
  checksPerDay, PROMPT_TOKENS, OUTPUT_TOKENS, SCREEN_W, SCREEN_H
};
