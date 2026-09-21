'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const helpers = require('./helpers');

// A developer shell may export a real key; the secrets module honors it
// outside Electron, so it must be gone before the module is exercised.
const SAVED_ENV_KEY = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const dir = helpers.freshUserData('secrets');
const paths = require('../src/paths');
const secrets = require('../src/secrets');

after(() => {
  if (SAVED_ENV_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_ENV_KEY;
  helpers.cleanup(dir);
});

const KEY = 'sk-ant-api03-TESTKEY0123456789abcdefghijklmnop';
const identity = () => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(s),
  decryptString: b => b.toString()
});
const readStore = () => JSON.parse(fs.readFileSync(paths.SECRETS_PATH, 'utf8'));

describe('without safeStorage (plain Node default)', () => {
  test('nothing is available and writes throw SecretsUnavailable', () => {
    assert.equal(secrets.available(), false);
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getCanvasToken(), '');
    assert.throws(() => secrets.setApiKey(KEY), e => e instanceof secrets.SecretsUnavailable && e.name === 'SecretsUnavailable');
    assert.equal(fs.existsSync(paths.SECRETS_PATH), false, 'no plaintext fallback file');
  });
});

describe('with a fake safeStorage (identity encryption)', () => {
  test('round trip; file mode 0600; no temp file left behind', () => {
    secrets._setSafeStorage(identity());
    assert.equal(secrets.available(), true);
    secrets.setApiKey(`  ${KEY}  `);
    assert.equal(secrets.getApiKey(), KEY, 'trimmed');
    assert.ok(fs.existsSync(paths.SECRETS_PATH));
    assert.equal(helpers.fileMode(paths.SECRETS_PATH), 0o600);
    assert.equal(fs.existsSync(paths.SECRETS_PATH + '.tmp'), false);
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: '' });
  });

  test('canvas token round trip keeps the api key', () => {
    secrets.setCanvasToken('  ctok  ');
    assert.equal(secrets.getCanvasToken(), 'ctok');
    assert.equal(secrets.getApiKey(), KEY);
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: 'ctok' });
    secrets.setCanvasToken(null);
    assert.equal(secrets.getCanvasToken(), '');
  });

  test('values survive a restart (cache dropped, re-read from disk)', () => {
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getApiKey(), KEY);
  });

  test('a key with whitespace inside or over 400 chars is rejected and nothing is written', () => {
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    assert.throws(() => secrets.setApiKey('sk-ant with space'), /does not look like an API key/);
    assert.throws(() => secrets.setApiKey('x'.repeat(401)), /does not look like an API key/);
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before);
    assert.equal(secrets.getApiKey(), KEY);
  });

  test('a corrupt store reads as no key', () => {
    fs.writeFileSync(paths.SECRETS_PATH, 'not json');
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getApiKey(), null);
    secrets.setApiKey(KEY); // repairs it
    assert.equal(secrets.getApiKey(), KEY);
  });

  test('clearApiKey blanks the key on disk', () => {
    secrets.clearApiKey();
    assert.equal(secrets.getApiKey(), null);
    assert.equal(readStore().anthropicApiKey, '');
    secrets.setApiKey(KEY);
  });

  test('setApiKey("") clears too', () => {
    secrets.setApiKey('');
    assert.equal(secrets.getApiKey(), null);
    secrets.setApiKey(KEY);
    assert.equal(secrets.getApiKey(), KEY);
  });

  test('maskKey shows only the prefix and last 4', () => {
    assert.equal(secrets.maskKey(''), '');
    assert.equal(secrets.maskKey(null), '');
    assert.equal(secrets.maskKey('short'), 'sk-ant-…');
    assert.equal(secrets.maskKey(KEY), 'sk-ant-…mnop');
    assert.equal(secrets.maskKey(KEY).includes('TESTKEY'), false);
  });

  test('the env key is honored outside Electron, below the session key', () => {
    secrets.clearApiKey();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    assert.equal(secrets.getApiKey(), 'sk-ant-env-key');
    secrets.useSessionKey('sk-ant-session-key');
    assert.equal(secrets.getApiKey(), 'sk-ant-session-key');
    secrets.useSessionKey('');
    assert.equal(secrets.getApiKey(), 'sk-ant-env-key');
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(secrets.getApiKey(), null);
  });

  test('setApiKey drops a session key; the stored key wins afterwards', () => {
    secrets.useSessionKey('sk-ant-session-key');
    secrets.setApiKey(KEY);
    assert.equal(secrets.getApiKey(), KEY);
  });
});

describe('when encryption is unavailable', () => {
  test('stored key unreadable, set throws SecretsUnavailable, clear is silent', () => {
    assert.equal(readStore().anthropicApiKey, KEY, 'precondition: a key is on disk');
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => false });
    assert.equal(secrets.available(), false);
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getCanvasToken(), '');
    assert.throws(() => secrets.setApiKey(KEY), e => e.name === 'SecretsUnavailable' && /secure storage is not available/.test(e.message));
    assert.throws(() => secrets.setCanvasToken('t'), secrets.SecretsUnavailable);
    assert.doesNotThrow(() => secrets.clearApiKey());
    assert.equal(readStore().anthropicApiKey, KEY, 'clear must not touch a store it cannot read');
  });

  test('a session-only key still works and never touches disk', () => {
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    secrets.useSessionKey(KEY);
    assert.equal(secrets.getApiKey(), KEY);
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before);
    assert.throws(() => secrets.useSessionKey('bad key'), /does not look like/);
    secrets.useSessionKey(null);
    assert.equal(secrets.getApiKey(), null);
  });

  test('isEncryptionAvailable throwing counts as unavailable', () => {
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => { throw new Error('keychain locked'); } });
    assert.equal(secrets.available(), false);
    assert.equal(secrets.getApiKey(), null);
  });
});

describe('decrypt failure', () => {
  test('reads as no key and logs one redacted warning', () => {
    secrets._setSafeStorage({
      ...identity(),
      decryptString: () => { throw new Error(`keychain denied for ${KEY}`); }
    });
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getApiKey(), null);
    const log = fs.readFileSync(paths.LOG_PATH, 'utf8');
    // (the earlier corrupt-store test produced its own "could not decrypt" line)
    const warns = log.split('\n').filter(l => l.includes('could not decrypt secrets.bin: keychain denied'));
    assert.equal(warns.length, 1, 'warned once, not on every read');
    assert.ok(warns[0].includes('keychain denied for [redacted]'));
    assert.equal(log.includes(KEY), false);
    assert.equal(log.includes('TESTKEY'), false);
    assert.equal(helpers.fileMode(paths.LOG_PATH), 0o600);
  });

  test('after the failure, setApiKey overwrites the unreadable store', () => {
    secrets._setSafeStorage({ ...identity(), decryptString: () => { throw new Error('nope'); } });
    secrets.setApiKey(KEY);
    assert.equal(secrets.getApiKey(), KEY);
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getApiKey(), KEY);
  });
});
