'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('pricing');
const pricing = require('../src/pricing');
const { PRICES, PRICE_DATE, priceFor, costUsd, perCheckUsd, estimateDaily, estimateMonthly, imageTokens, providerOf, checksPerDay } = pricing;

// Independent view of the per-check arithmetic for one 1366x854 display on Haiku:
// Anthropic bills about w*h/750 image tokens (capped), plus the ~700-token prompt, 40 out.
const HAIKU_IMAGE = Math.min(1600, Math.ceil(1366 * 854 / 750));   // 1556
const HAIKU_WEBCAM = Math.min(1600, Math.ceil(640 * 480 / 750));   // 410
const HAIKU_CHECK = ((700 + HAIKU_IMAGE) * 1.0 + 40 * 5.0) / 1e6;  // 0.002456

after(() => helpers.cleanup(dir));

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg || `${actual} not within ${tol} of ${expected}`);

describe('costUsd', () => {
  test('one check on haiku: 1568+700 in / 40 out ≈ $0.00247', () => {
    const c = costUsd({ input_tokens: 1568 + 700, output_tokens: 40 }, 'claude-haiku-4-5');
    near(c, 0.00247, 0.00001);
    assert.equal(c, 0.002468);
  });

  test('unknown model or missing usage → null', () => {
    assert.equal(costUsd({ input_tokens: 10, output_tokens: 1 }, 'gpt-4o'), null);
    assert.equal(costUsd({ input_tokens: 10, output_tokens: 1 }, ''), null);
    assert.equal(costUsd({ input_tokens: 10, output_tokens: 1 }, undefined), null);
    assert.equal(costUsd(null, 'claude-haiku-4-5'), null);
    assert.equal(costUsd(undefined, 'claude-haiku-4-5'), null);
  });

  test('missing or non-numeric token counts are treated as zero', () => {
    assert.equal(costUsd({}, 'claude-haiku-4-5'), 0);
    assert.equal(costUsd({ input_tokens: 'x', output_tokens: 40 }, 'claude-haiku-4-5'), 40 * 5 / 1e6);
  });

  test('dated aliases share the base price (longest prefix wins)', () => {
    assert.equal(priceFor('claude-haiku-4-5-20251001'), PRICES['claude-haiku-4-5']);
    assert.equal(costUsd({ input_tokens: 2268, output_tokens: 40 }, 'claude-haiku-4-5-20251001'), 0.002468);
    assert.equal(priceFor('gpt-5-mini-2025-08-07'), PRICES['gpt-5-mini']);
    assert.equal(priceFor('gpt-5.4-mini-2026-01-01'), PRICES['gpt-5.4-mini']);
    assert.equal(priceFor('haiku'), null);
    assert.equal(priceFor(null), null);
  });

  test('price table and date', () => {
    assert.deepEqual(PRICES['claude-haiku-4-5'], { input: 1.0, output: 5.0 });
    assert.deepEqual(PRICES['gpt-5-mini'], { input: 0.25, output: 2.0 });
    assert.equal(PRICE_DATE, '2026-09-21');
  });

  test('an OpenAI check is priced with its own token counts', () => {
    assert.equal(costUsd({ input_tokens: 2100, output_tokens: 90 }, 'gpt-5-mini'), (2100 * 0.25 + 90 * 2) / 1e6);
  });
});

describe('perCheckUsd', () => {
  test('one display, no camera ≈ $0.0025 (about a quarter of a cent)', () => {
    near(perCheckUsd(), 0.0025, 0.0001);
    assert.equal(perCheckUsd(), HAIKU_CHECK);
    assert.equal(perCheckUsd(), 0.002456);
  });

  test('image tokens: Anthropic ≈ w*h/750 capped at 1600; OpenAI = 32-px patches × multiplier', () => {
    assert.equal(imageTokens('claude-haiku-4-5'), HAIKU_IMAGE);
    assert.equal(imageTokens('claude-haiku-4-5', 640, 480), HAIKU_WEBCAM);
    assert.equal(imageTokens('claude-haiku-4-5', 4000, 4000), 1600);
    const patches = Math.ceil(1366 / 32) * Math.ceil(854 / 32);
    assert.equal(imageTokens('gpt-5-mini'), Math.ceil(patches * 1.2));
    assert.equal(imageTokens('gpt-5-nano'), Math.ceil(patches * 1.5));
    assert.equal(imageTokens('gpt-5-mini', 4000, 4000), Math.ceil(1536 * 1.2), 'patch cap');
    assert.equal(imageTokens('gpt-4o-mini'), 8500);
    assert.equal(providerOf('gpt-5-mini'), 'openai');
    assert.equal(providerOf('o3-mini'), 'openai');
    assert.equal(providerOf('claude-haiku-4-5'), 'anthropic');
  });

  test('camera adds ~15%; a second display roughly doubles the image cost', () => {
    const base = perCheckUsd();
    const cam = perCheckUsd({ camera: true });
    near(cam / base, 1.17, 0.03);
    assert.equal(cam, ((700 + HAIKU_IMAGE + HAIKU_WEBCAM) * 1.0 + 40 * 5.0) / 1e6);
    const two = perCheckUsd({ displays: 2 });
    assert.equal(two, ((700 + 2 * HAIKU_IMAGE) * 1.0 + 40 * 5.0) / 1e6);
    near(two / base, 1.7, 0.1);
    assert.equal(perCheckUsd({ displays: 0 }), base, 'displays clamps to at least 1');
  });

  test('OpenAI per-check uses 90 output tokens (reasoning) and its own image math', () => {
    const patches = Math.ceil(1366 / 32) * Math.ceil(854 / 32);
    const input = 700 + Math.ceil(patches * 1.2);
    assert.equal(perCheckUsd({ model: 'gpt-5-mini' }), (input * 0.25 + 90 * 2.0) / 1e6);
    assert.ok(perCheckUsd({ model: 'gpt-5-mini' }) < perCheckUsd(), 'gpt-5-mini is cheaper than haiku per check');
  });

  test('unknown model → null', () => {
    assert.equal(perCheckUsd({ model: 'llama-3' }), null);
    assert.equal(perCheckUsd({ model: 'gpt-9-ultra' }), null);
  });
});

describe('estimateDaily / estimateMonthly', () => {
  test('30 s ≈ $1.35, 45 s ≈ $0.90, 90 s ≈ $0.45 per day', () => {
    near(estimateDaily(30), 1.35, 0.1);
    near(estimateDaily(45), 0.90, 0.1);
    near(estimateDaily(90), 0.45, 0.1);
    // The printed figures (BUILD-CONTEXT) at two decimals:
    assert.equal(estimateDaily(30).toFixed(2), '1.35');
    assert.equal(estimateDaily(45).toFixed(2), '0.90');
    assert.equal(estimateDaily(90).toFixed(2), '0.45');
  });

  test('monthly = daily × 22 working days', () => {
    assert.equal(estimateMonthly(45), estimateDaily(45) * 22);
    near(estimateMonthly(30), 30, 1);
    near(estimateMonthly(45), 20, 1);
    near(estimateMonthly(90), 10, 1);
  });

  test('daily = per-check × calibrated checks/day', () => {
    assert.equal(checksPerDay(30), 550);
    near(checksPerDay(45), 550 * 30 / 45, 1e-9);
    assert.equal(checksPerDay(5), checksPerDay(10), 'interval floor of 10 s');
    assert.equal(estimateDaily(45), perCheckUsd() * checksPerDay(45));
  });

  test('interval clamps at 10 s; options flow through; unknown model → null', () => {
    assert.equal(estimateDaily(1), estimateDaily(10));
    assert.ok(estimateDaily(30, { camera: true }) > estimateDaily(30));
    assert.ok(estimateDaily(30, { displays: 2 }) > estimateDaily(30, { camera: true }));
    assert.equal(estimateDaily(30, { model: 'llama-3' }), null);
    assert.equal(estimateMonthly(30, { model: 'llama-3' }), null);
  });
});
