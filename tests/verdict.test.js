'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('verdict');
const analyzer = require('../src/analyzer');
const { coerceVerdict, extractJson, classifyApiError, resolveEngine, analyze, NoKeyError, VERDICT_SCHEMA } = analyzer;

after(() => helpers.cleanup(dir));

describe('coerceVerdict', () => {
  test('anything not exactly true is on-task', () => {
    assert.equal(coerceVerdict({ off_task: 'true' }).off_task, false);
    assert.equal(coerceVerdict({ off_task: 1 }).off_task, false);
    assert.equal(coerceVerdict({ off_task: 'yes' }).off_task, false);
    assert.equal(coerceVerdict({}).off_task, false);
    assert.equal(coerceVerdict({ off_task: true }).off_task, true);
  });

  test('confidence must be exactly high|medium|low, else low', () => {
    assert.equal(coerceVerdict({ off_task: true, confidence: 'HIGH' }).confidence, 'low');
    assert.equal(coerceVerdict({ off_task: true, confidence: 'certain' }).confidence, 'low');
    assert.equal(coerceVerdict({ off_task: true }).confidence, 'low');
    assert.equal(coerceVerdict({ off_task: true, confidence: 'high' }).confidence, 'high');
    assert.equal(coerceVerdict({ off_task: true, confidence: 'medium' }).confidence, 'medium');
  });

  test('activity is a string capped at 120 chars with newlines flattened', () => {
    const long = 'a'.repeat(200);
    assert.equal(coerceVerdict({ activity: long }).activity.length, 120);
    assert.equal(coerceVerdict({ activity: 'code\r\neditor\nand terminal' }).activity, 'code editor and terminal');
    assert.equal(coerceVerdict({ activity: 42 }).activity, '');
    assert.equal(coerceVerdict({}).activity, '');
  });

  test('exact shape: only off_task, activity, confidence survive', () => {
    const v = coerceVerdict({ off_task: true, activity: 'x', confidence: 'high', extra: 1 });
    assert.deepEqual(v, { off_task: true, activity: 'x', confidence: 'high' });
  });

  test('non-objects throw', () => {
    for (const bad of [null, undefined, 'str', 5, [], true]) {
      assert.throws(() => coerceVerdict(bad), /verdict is not an object/);
    }
  });
});

describe('extractJson', () => {
  test('finds the JSON object inside surrounding prose', () => {
    const text = 'Sure, here is my verdict:\n```json\n{"off_task": false, "activity": "code editor", "confidence": "high"}\n```\nHope that helps.';
    assert.deepEqual(extractJson(text), { off_task: false, activity: 'code editor', confidence: 'high' });
  });

  test('bare JSON works', () => {
    assert.deepEqual(extractJson('{"off_task":true}'), { off_task: true });
  });

  test('no JSON throws', () => {
    assert.throws(() => extractJson('no braces here'), /no JSON in model output/);
    assert.throws(() => extractJson(''), /no JSON in model output/);
    assert.throws(() => extractJson(null), /no JSON in model output/);
    assert.throws(() => extractJson('} {'), /no JSON in model output/);
  });

  test('malformed JSON between braces throws a parse error', () => {
    assert.throws(() => extractJson('{not json}'), SyntaxError);
  });
});

describe('classifyApiError', () => {
  const withStatus = (status, message) => Object.assign(new Error(message), { status });

  test('err.kind passes through untouched (NoKeyError → no_key)', () => {
    const e = new NoKeyError();
    assert.equal(e.kind, 'no_key');
    assert.deepEqual(classifyApiError(e), { kind: 'no_key', message: 'no API key configured' });
    assert.equal(classifyApiError(Object.assign(new Error('x'), { kind: 'refused' })).kind, 'refused');
  });

  test('401/403 → key_rejected', () => {
    assert.equal(classifyApiError(withStatus(401, '401 authentication_error: invalid x-api-key')).kind, 'key_rejected');
    assert.equal(classifyApiError(withStatus(403, 'permission denied')).kind, 'key_rejected');
  });

  test('400 credit balance → no_credit; other 400 → unknown', () => {
    assert.equal(classifyApiError(withStatus(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')).kind, 'no_credit');
    assert.equal(classifyApiError(withStatus(400, 'invalid_request_error: max_tokens')).kind, 'unknown');
  });

  test('429 → rate_limited; 529/5xx/overloaded → overloaded', () => {
    assert.equal(classifyApiError(withStatus(429, 'rate_limit_error')).kind, 'rate_limited');
    assert.equal(classifyApiError(withStatus(529, 'overloaded_error')).kind, 'overloaded');
    assert.equal(classifyApiError(withStatus(500, 'api_error')).kind, 'overloaded');
    assert.equal(classifyApiError(new Error('Overloaded')).kind, 'overloaded');
  });

  test('connection failures → network', () => {
    for (const m of ['connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND api.anthropic.com', 'ETIMEDOUT', 'fetch failed', 'Connection error.', 'Request timed out']) {
      assert.equal(classifyApiError(new Error(m)).kind, 'network', m);
    }
  });

  test('SDK error classes are recognized by instance', () => {
    const Anthropic = require('@anthropic-ai/sdk');
    const h = new Headers();
    assert.equal(classifyApiError(new Anthropic.AuthenticationError(401, { message: 'invalid x-api-key' }, undefined, h)).kind, 'key_rejected');
    assert.equal(classifyApiError(new Anthropic.PermissionDeniedError(403, { message: 'nope' }, undefined, h)).kind, 'key_rejected');
    assert.equal(classifyApiError(new Anthropic.RateLimitError(429, { message: 'slow down' }, undefined, h)).kind, 'rate_limited');
    assert.equal(classifyApiError(new Anthropic.InternalServerError(529, { message: 'overloaded' }, undefined, h)).kind, 'overloaded');
    assert.equal(classifyApiError(new Anthropic.APIConnectionError({ message: 'Connection error.' })).kind, 'network');
    const bad = new Anthropic.BadRequestError(400, { message: 'Your credit balance is too low' }, undefined, h);
    assert.equal(classifyApiError(bad).kind, 'no_credit');
  });

  test('OpenAI-style errors: code/type fields and quota wording', () => {
    const e1 = Object.assign(new Error('Incorrect API key provided: sk-proj-***'), { status: 401, code: 'invalid_api_key' });
    assert.equal(classifyApiError(e1).kind, 'key_rejected');
    assert.equal(classifyApiError({ message: 'x', error: { type: 'authentication_error' } }).kind, 'key_rejected');
    assert.equal(classifyApiError({ message: 'x', code: 'invalid_api_key' }).kind, 'key_rejected');
    const quota = Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), { status: 429, code: 'insufficient_quota' });
    assert.equal(classifyApiError(quota).kind, 'no_credit', 'quota exhaustion beats the 429 rate-limit rule');
    assert.equal(classifyApiError({ message: 'x', error: { code: 'insufficient_quota' } }).kind, 'no_credit');
    assert.equal(classifyApiError({ message: 'x', name: 'APIConnectionError' }).kind, 'network');
  });

  test('bad_model: 404, model_not_found, or "does not exist" wording', () => {
    assert.equal(classifyApiError(withStatus(404, 'not found')).kind, 'bad_model');
    assert.equal(classifyApiError({ message: 'x', code: 'model_not_found' }).kind, 'bad_model');
    assert.equal(classifyApiError(new Error('The model `gpt-9` does not exist or you do not have access to it.')).kind, 'bad_model');
    assert.equal(classifyApiError(new Error('model: claude-x not found')).kind, 'bad_model');
    assert.equal(classifyApiError(new Error('Your organization does not have access to model gpt-5-pro')).kind, 'bad_model');
  });

  test('refusal and unknown', () => {
    assert.equal(classifyApiError(new Error('model refused the request')).kind, 'refused');
    assert.equal(classifyApiError(new Error('something odd')).kind, 'unknown');
    assert.deepEqual(classifyApiError(null), { kind: 'unknown', message: 'unknown error' });
    assert.deepEqual(classifyApiError('plain string'), { kind: 'unknown', message: 'plain string' });
  });
});

describe('engine and key guard', () => {
  test('resolveEngine is api unless the maintainer opts into cli', t => {
    const saved = process.env.GRAYOUT_DEV_ENGINE;
    t.after(() => { if (saved === undefined) delete process.env.GRAYOUT_DEV_ENGINE; else process.env.GRAYOUT_DEV_ENGINE = saved; });
    delete process.env.GRAYOUT_DEV_ENGINE;
    assert.equal(resolveEngine({ engine: 'cli' }), 'api', 'config cannot select cli');
    assert.equal(resolveEngine({ engine: 'auto' }), 'api');
    process.env.GRAYOUT_DEV_ENGINE = 'cli';
    assert.equal(resolveEngine({ engine: 'api' }), 'cli', 'unpackaged + env var → cli');
    process.env.GRAYOUT_DEV_ENGINE = 'yes';
    assert.equal(resolveEngine({}), 'api');
  });

  test('analyze() without an apiKey throws NoKeyError before any network', async t => {
    const saved = process.env.GRAYOUT_DEV_ENGINE;
    t.after(() => { if (saved === undefined) delete process.env.GRAYOUT_DEV_ENGINE; else process.env.GRAYOUT_DEV_ENGINE = saved; });
    delete process.env.GRAYOUT_DEV_ENGINE;
    const ctx = { screenshotsB64: ['AAAA'], webcamB64: null, workDescription: '', canvasTasks: [], fileTasks: [], frontApp: 'Code', apiKey: null };
    await assert.rejects(analyze(ctx, { model: 'claude-haiku-4-5' }), e => e instanceof NoKeyError && e.kind === 'no_key');
    await assert.rejects(analyze({ ...ctx, apiKey: '' }, { model: 'claude-haiku-4-5' }), NoKeyError);
    assert.equal(ctx.screenshotCount, 1);
    assert.equal(ctx.hasWebcam, false);
  });

  test('providers.resolve: explicit provider > key prefix > model family > anthropic; model must match the family', () => {
    const providers = require('../src/providers');
    assert.deepEqual(providers.resolve({ provider: 'auto', model: 'claude-haiku-4-5' }, 'sk-ant-api03-x'), { provider: 'anthropic', model: 'claude-haiku-4-5' });
    assert.deepEqual(providers.resolve({ provider: 'auto', model: 'claude-haiku-4-5' }, 'sk-proj-x'), { provider: 'openai', model: 'gpt-5-mini' });
    assert.deepEqual(providers.resolve({ provider: 'auto', model: 'gpt-5-nano' }, 'sk-proj-x'), { provider: 'openai', model: 'gpt-5-nano' });
    assert.deepEqual(providers.resolve({ provider: 'auto', model: 'gpt-5-nano' }, null), { provider: 'openai', model: 'gpt-5-nano' }, 'no key: model family decides');
    assert.deepEqual(providers.resolve({ provider: 'auto', model: 'nonsense' }, null), { provider: 'anthropic', model: 'claude-haiku-4-5' });
    assert.deepEqual(providers.resolve({ provider: 'openai', model: 'claude-haiku-4-5' }, 'sk-ant-x'), { provider: 'openai', model: 'gpt-5-mini' }, 'explicit provider wins over the key');
    assert.deepEqual(providers.resolve({ provider: 'anthropic', model: 'gpt-5-mini' }, 'sk-proj-x'), { provider: 'anthropic', model: 'claude-haiku-4-5' });
    assert.deepEqual(providers.resolve(null, undefined), { provider: 'anthropic', model: 'claude-haiku-4-5' });
    assert.equal(providers.detectProviderFromKey('  sk-ant-api03-x '), 'anthropic');
    assert.equal(providers.detectProviderFromKey('sk-proj-abc'), 'openai');
    assert.equal(providers.detectProviderFromKey('abc'), null);
    assert.equal(providers.detectProviderFromKey(''), null);
    assert.equal(providers.label('openai'), 'OpenAI');
    assert.equal(providers.label('anthropic'), 'Anthropic');
    assert.equal(providers.label(undefined), 'Anthropic');
    assert.equal(providers.isReasoningModel('gpt-5-mini'), true);
    assert.equal(providers.isReasoningModel('o3-mini'), true);
    assert.equal(providers.isReasoningModel('gpt-4.1-mini'), false);
    assert.equal(providers.isReasoningModel('claude-haiku-4-5'), false);
  });

  test('VERDICT_SCHEMA is strict', () => {
    assert.deepEqual(VERDICT_SCHEMA.required, ['off_task', 'activity', 'confidence']);
    assert.equal(VERDICT_SCHEMA.additionalProperties, false);
    assert.deepEqual(VERDICT_SCHEMA.properties.confidence.enum, ['high', 'medium', 'low']);
    assert.equal(analyzer.API_TIMEOUT_MS, 60000);
  });
});
