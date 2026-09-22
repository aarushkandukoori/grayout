'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const helpers = require('./helpers');

const dir = helpers.freshUserData('config');
const paths = require('../src/paths');
const config = require('../src/config');
const { DEFAULT_CONFIG, NUMERIC_BOUNDS, coerce, loadConfig, saveConfig, writeConfig } = config;

after(() => helpers.cleanup(dir));

const writeRaw = text => fs.writeFileSync(paths.CONFIG_PATH, text);
const readRaw = () => fs.readFileSync(paths.CONFIG_PATH, 'utf8');
const readJson = () => JSON.parse(readRaw());

describe('paths isolation', () => {
  test('paths resolve from GRAYOUT_USER_DATA', () => {
    assert.equal(paths.USER_DATA, dir);
    assert.equal(paths.CONFIG_PATH, `${dir}/config.json`);
    assert.equal(paths.IN_ELECTRON, false);
  });
});

describe('coerce', () => {
  test('defaults applied on an empty object, as an independent copy', () => {
    const c = coerce({});
    assert.deepEqual(c, DEFAULT_CONFIG);
    c.alwaysAllowedApps.push('mutated');
    c.canvas.baseUrl = 'x';
    assert.deepEqual(coerce({}), DEFAULT_CONFIG);
  });

  test('numeric strings are coerced; garbage keeps the default', () => {
    assert.equal(coerce({ checkIntervalSec: '30' }).checkIntervalSec, 30);
    assert.equal(coerce({ checkIntervalSec: '1e2' }).checkIntervalSec, 100);
    assert.equal(coerce({ checkIntervalSec: 'abc' }).checkIntervalSec, 45);
  });

  test('null / empty-string / boolean / array numerics keep the default', () => {
    // Number(null), Number('') and Number([]) are 0 and Number(true) is 1; a
    // hand-edited `"checkIntervalSec": null` must NOT land on the 10 s minimum.
    assert.equal(coerce({ checkIntervalSec: null }).checkIntervalSec, 45);
    assert.equal(coerce({ checkIntervalSec: '' }).checkIntervalSec, 45);
    assert.equal(coerce({ checkIntervalSec: true }).checkIntervalSec, 45);
    assert.equal(coerce({ strikes: [] }).strikes, 2);
  });

  test('numbers are rounded and clamped to NUMERIC_BOUNDS', () => {
    assert.equal(coerce({ checkIntervalSec: 0 }).checkIntervalSec, 10);
    assert.equal(coerce({ checkIntervalSec: 3600000 }).checkIntervalSec, 3600);
    assert.equal(coerce({ checkIntervalSec: 44.6 }).checkIntervalSec, 45);
    assert.equal(coerce({ strikes: 99 }).strikes, 20);
    assert.equal(coerce({ strikes: 0 }).strikes, 1);
    assert.equal(coerce({ idleSkipSec: 1 }).idleSkipSec, 30);
    assert.equal(coerce({ heldAlertRecheckSec: 10 }).heldAlertRecheckSec, 60);
    assert.equal(coerce({ maxAlertMinutes: 1000 }).maxAlertMinutes, 240);
    assert.equal(coerce({ disputeGraceMin: 0 }).disputeGraceMin, 1);
    assert.equal(coerce({ wakeGraceSec: -5 }).wakeGraceSec, 0);
    assert.equal(coerce({ dailyCheckCap: 5 }).dailyCheckCap, 50);
    assert.equal(coerce({ dailyCheckCap: 1e9 }).dailyCheckCap, 20000);
    assert.equal(coerce({ historyDays: 0 }).historyDays, 1);
    assert.equal(coerce({ historyDays: 1000 }).historyDays, 365);
    assert.equal(coerce({ schemaVersion: 7 }).schemaVersion, 1);
  });

  test('every numeric default has bounds and sits inside them', () => {
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      if (typeof v !== 'number') continue;
      assert.ok(NUMERIC_BOUNDS[k], `missing bounds for ${k}`);
      assert.ok(v >= NUMERIC_BOUNDS[k].min && v <= NUMERIC_BOUNDS[k].max, `${k} default out of bounds`);
    }
  });

  test('booleans reject non-booleans', () => {
    assert.equal(coerce({ camera: 'yes' }).camera, false);
    assert.equal(coerce({ camera: 1 }).camera, false);
    assert.equal(coerce({ camera: true }).camera, true);
    assert.equal(coerce({ grayscale: 0 }).grayscale, true);
    assert.equal(coerce({ grayscale: false }).grayscale, false);
    assert.equal(coerce({ redFlash: null }).redFlash, true);
    assert.equal(coerce({ pauseWhenLocked: 'false' }).pauseWhenLocked, true);
    assert.equal(coerce({ logVerdicts: 'no' }).logVerdicts, true);
  });

  test('arrays filter non-strings, trim, drop empties, cap at 100', () => {
    assert.deepEqual(coerce({ alwaysAllowedApps: ['  Zoom ', 1, null, '', {}, 'Slack', '   '] }).alwaysAllowedApps, ['Zoom', 'Slack']);
    assert.deepEqual(coerce({ neverCaptureApps: [] }).neverCaptureApps, []);
    assert.deepEqual(coerce({ neverCaptureApps: 'Bitwarden' }).neverCaptureApps, DEFAULT_CONFIG.neverCaptureApps);
    const many = Array.from({ length: 150 }, (_, i) => `app${i}`);
    assert.equal(coerce({ alwaysAllowedApps: many }).alwaysAllowedApps.length, 100);
  });

  test('unknown keys are dropped', () => {
    const c = coerce({ foo: 1, bar: 'x', apiKey: 'sk-ant-nope' });
    assert.equal('foo' in c, false);
    assert.equal('bar' in c, false);
    assert.equal('apiKey' in c, false);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(DEFAULT_CONFIG).sort());
  });

  test('model must be a claude-/gpt-/oN family name; anything else → default', () => {
    // BUILD-SPEC §6 said "allowlist: /^claude-/"; src/config.js now also admits
    // OpenAI names (gpt-*, o1/o3/...) since providers.js landed. Testing the code.
    assert.equal(coerce({ model: 'llama-3-70b' }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: 'claude-sonnet-4-6' }).model, 'claude-sonnet-4-6');
    assert.equal(coerce({ model: 'claude-haiku-4-5-20251001' }).model, 'claude-haiku-4-5-20251001');
    assert.equal(coerce({ model: 'gpt-5-mini' }).model, 'gpt-5-mini');
    assert.equal(coerce({ model: 'gpt-4.1-mini' }).model, 'gpt-4.1-mini');
    assert.equal(coerce({ model: 'o3-mini' }).model, 'o3-mini');
    assert.equal(coerce({ model: 'claude-' }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: 'gpt-' }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: 'claude-x y' }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: 'gpt-5-mini; rm -rf /' }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: 12 }).model, 'claude-haiku-4-5');
    assert.equal(coerce({ model: '' }).model, 'claude-haiku-4-5');
  });

  test('provider is auto | grayout | anthropic | openai, else auto', () => {
    assert.equal(DEFAULT_CONFIG.provider, 'auto');
    assert.equal(coerce({ provider: 'grayout' }).provider, 'grayout');
    assert.equal(coerce({ provider: 'openai' }).provider, 'openai');
    assert.equal(coerce({ provider: 'anthropic' }).provider, 'anthropic');
    assert.equal(coerce({ provider: 'OpenAI' }).provider, 'auto', 'case-sensitive enum');
    assert.equal(coerce({ provider: 'foo' }).provider, 'auto');
    assert.equal(coerce({ provider: 3 }).provider, 'auto');
  });

  test('engine falls back to api for unknown values', () => {
    assert.equal(coerce({ engine: 'foo' }).engine, 'api');
    assert.equal(coerce({ engine: 'api' }).engine, 'api');
    // Accepted by coerce for the maintainer; resolveEngine() ignores config anyway.
    assert.equal(coerce({ engine: 'cli' }).engine, 'cli');
    assert.equal(coerce({ engine: 'auto' }).engine, 'auto');
  });

  test('workDescription is a string capped at 500 chars', () => {
    assert.equal(coerce({ workDescription: 'x'.repeat(600) }).workDescription.length, 500);
    assert.equal(coerce({ workDescription: 42 }).workDescription, '');
    assert.equal(coerce({ workDescription: 'ML research' }).workDescription, 'ML research');
  });

  test('canvas: baseUrl must be http(s), token must be a string', () => {
    assert.equal(coerce({ canvas: { baseUrl: 'ftp://x' } }).canvas.baseUrl, DEFAULT_CONFIG.canvas.baseUrl);
    assert.equal(coerce({ canvas: { baseUrl: '  https://canvas.school.edu  ' } }).canvas.baseUrl, 'https://canvas.school.edu');
    assert.equal(coerce({ canvas: { token: 123 } }).canvas.token, '');
    assert.equal(coerce({ canvas: { token: 'tok' } }).canvas.token, 'tok');
    assert.deepEqual(coerce({ canvas: 'nope' }).canvas, DEFAULT_CONFIG.canvas);
    assert.deepEqual(coerce({ canvas: null }).canvas, DEFAULT_CONFIG.canvas);
  });
});

describe('loadConfig', () => {
  test('missing file: defaults written with mode 0600', () => {
    try { fs.unlinkSync(paths.CONFIG_PATH); } catch {}
    const c = loadConfig();
    assert.deepEqual(c, DEFAULT_CONFIG);
    assert.equal('_invalid' in c, false);
    assert.ok(fs.existsSync(paths.CONFIG_PATH));
    assert.equal(helpers.fileMode(paths.CONFIG_PATH), 0o600);
    assert.deepEqual(readJson(), DEFAULT_CONFIG);
    assert.equal(fs.existsSync(paths.CONFIG_PATH + '.tmp'), false);
  });

  test('malformed JSON: backed up to .invalid, defaults with _invalid, original untouched', t => {
    t.mock.method(console, 'error', () => {});
    writeRaw('{ "checkIntervalSec": 30, oops');
    const c = loadConfig();
    assert.equal(c._invalid, true);
    const { _invalid, ...rest } = c;
    assert.deepEqual(rest, DEFAULT_CONFIG);
    assert.equal(fs.readFileSync(paths.CONFIG_PATH + '.invalid', 'utf8'), '{ "checkIntervalSec": 30, oops');
    assert.equal(readRaw(), '{ "checkIntervalSec": 30, oops');
    assert.equal(console.error.mock.callCount(), 1);
    fs.unlinkSync(paths.CONFIG_PATH + '.invalid');
  });

  test('a JSON array or scalar counts as malformed', t => {
    t.mock.method(console, 'error', () => {});
    writeRaw('[1, 2]');
    assert.equal(loadConfig()._invalid, true);
    writeRaw('42');
    assert.equal(loadConfig()._invalid, true);
    fs.unlinkSync(paths.CONFIG_PATH + '.invalid');
  });

  test('a valid, already-normalized file is not rewritten', () => {
    writeConfig(coerce({ checkIntervalSec: 30 }));
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(paths.CONFIG_PATH, old, old);
    const before = fs.statSync(paths.CONFIG_PATH).mtimeMs;
    const c = loadConfig();
    assert.equal(c.checkIntervalSec, 30);
    assert.equal(fs.statSync(paths.CONFIG_PATH).mtimeMs, before, 'file was rewritten');
  });

  test('a valid file differing only in surrounding whitespace is not rewritten', () => {
    const text = JSON.stringify(coerce({ strikes: 3 }), null, 2); // no trailing newline
    writeRaw(text);
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(paths.CONFIG_PATH, old, old);
    const before = fs.statSync(paths.CONFIG_PATH).mtimeMs;
    assert.equal(loadConfig().strikes, 3);
    assert.equal(fs.statSync(paths.CONFIG_PATH).mtimeMs, before);
  });

  test('a file that needs normalization is rewritten in place', () => {
    writeRaw('{"checkIntervalSec":"30","foo":1,"strikes":99}\n');
    const c = loadConfig();
    assert.equal(c.checkIntervalSec, 30);
    assert.equal(c.strikes, 20);
    const onDisk = readJson();
    assert.equal(onDisk.checkIntervalSec, 30);
    assert.equal(onDisk.strikes, 20);
    assert.equal('foo' in onDisk, false);
    assert.equal(helpers.fileMode(paths.CONFIG_PATH), 0o600);
  });

  test('legacy canvas token is handed to onCanvasToken and blanked on disk', () => {
    writeRaw(JSON.stringify({ canvas: { baseUrl: 'https://canvas.cmu.edu', token: 'tok123' } }) + '\n');
    const seen = [];
    const c = loadConfig({ onCanvasToken: t => seen.push(t) });
    assert.deepEqual(seen, ['tok123']);
    assert.equal(c.canvas.token, '');
    assert.equal(readJson().canvas.token, '');
    assert.equal(readRaw().includes('tok123'), false);
  });

  test('legacy canvas token stays put when no handler is given or it throws', () => {
    // Actual behavior: the token is only blanked once a handler has accepted it,
    // so a failed move never loses the token.
    writeRaw(JSON.stringify({ canvas: { token: 'tok456' } }) + '\n');
    assert.equal(loadConfig().canvas.token, 'tok456');
    assert.equal(readJson().canvas.token, 'tok456');
    assert.equal(loadConfig({ onCanvasToken: () => { throw new Error('keychain down'); } }).canvas.token, 'tok456');
    assert.equal(readJson().canvas.token, 'tok456');
  });
});

describe('saveConfig', () => {
  test('merges a partial into the on-disk config and validates', () => {
    writeConfig(coerce({}));
    const c1 = saveConfig({ checkIntervalSec: 90, canvas: { baseUrl: 'https://x.edu' } });
    assert.equal(c1.checkIntervalSec, 90);
    assert.equal(c1.canvas.baseUrl, 'https://x.edu');
    assert.equal(c1.canvas.token, '');
    const c2 = saveConfig({ strikes: '3', model: 'not-a-model' });
    assert.equal(c2.checkIntervalSec, 90, 'earlier save lost');
    assert.equal(c2.strikes, 3);
    assert.equal(c2.model, 'claude-haiku-4-5');
    assert.equal(c2.canvas.baseUrl, 'https://x.edu', 'nested canvas lost');
    assert.deepEqual(readJson(), c2);
    assert.equal(helpers.fileMode(paths.CONFIG_PATH), 0o600);
  });

  test('a malformed on-disk file is replaced by partial-over-defaults', () => {
    writeRaw('{ broken');
    const c = saveConfig({ strikes: 4 });
    assert.equal(c.strikes, 4);
    assert.equal(c.checkIntervalSec, 45);
    assert.deepEqual(readJson(), c);
  });
});

describe('v2 keys', () => {
  test('change-gating is on by default with a 3-minute forced check', () => {
    assert.equal(DEFAULT_CONFIG.changeGating, true);
    assert.equal(DEFAULT_CONFIG.forceCheckSec, 180);
    assert.equal(coerce({ changeGating: false }).changeGating, false);
    assert.equal(coerce({ changeGating: 'no' }).changeGating, true, 'only real booleans');
    assert.equal(coerce({ forceCheckSec: 10 }).forceCheckSec, 30, 'clamped to the bounds');
    assert.equal(coerce({ forceCheckSec: 99999 }).forceCheckSec, 3600);
    assert.equal(coerce({ forceCheckSec: '300' }).forceCheckSec, 300);
    assert.equal(coerce({ forceCheckSec: null }).forceCheckSec, 180);
  });

  test('apiBase is empty by default and must be https, or http on localhost', () => {
    assert.equal(DEFAULT_CONFIG.apiBase, '');
    assert.equal(coerce({ apiBase: 'https://grayout-api.workers.dev' }).apiBase, 'https://grayout-api.workers.dev');
    assert.equal(coerce({ apiBase: 'https://api.grayout.app/' }).apiBase, 'https://api.grayout.app', 'trailing slash dropped');
    assert.equal(coerce({ apiBase: 'http://localhost:8787' }).apiBase, 'http://localhost:8787');
    // Frames must never be posted to a plain-http host on the open internet.
    for (const bad of ['http://example.com', 'ftp://x', 'not a url', 'javascript:alert(1)', 42, null]) {
      assert.equal(coerce({ apiBase: bad }).apiBase, '', String(bad));
    }
  });

  test('a hand-edited file keeps the new keys through a load/save round trip', () => {
    writeRaw(JSON.stringify({ changeGating: false, forceCheckSec: 240, apiBase: 'https://api.grayout.app', provider: 'grayout' }));
    const c = loadConfig();
    assert.equal(c.changeGating, false);
    assert.equal(c.forceCheckSec, 240);
    assert.equal(c.provider, 'grayout');
    assert.equal(readJson().forceCheckSec, 240);
  });
});
