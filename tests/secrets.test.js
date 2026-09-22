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
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: '', grayoutLicense: '' });
  });

  test('canvas token round trip keeps the api key', () => {
    secrets.setCanvasToken('  ctok  ');
    assert.equal(secrets.getCanvasToken(), 'ctok');
    assert.equal(secrets.getApiKey(), KEY);
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: 'ctok', grayoutLicense: '' });
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

describe('the Grayout license', () => {
  const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';

  test('round trips next to the API key, in canonical form', () => {
    secrets._setSafeStorage(identity());
    secrets.setLicense(`  ${LICENSE.toLowerCase()}  `);
    assert.equal(secrets.getLicense(), LICENSE, 'trimmed, prefix lowercase, body uppercase');
    assert.equal(readStore().grayoutLicense, LICENSE);
    assert.equal(secrets.getApiKey(), KEY, 'the self-hosted key is untouched');
  });

  test('only gry_live_ + 24 Crockford base32 characters is accepted', () => {
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    for (const bad of [
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6',      // 23 characters
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6DD',    // 25
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6U',     // U is not in the alphabet
      'gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D',
      'sk-ant-api03-nope'
    ]) {
      assert.throws(() => secrets.setLicense(bad), /Grayout license key/, bad);
      assert.equal(secrets.isLicense(bad), false, bad);
    }
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before, 'nothing was written');
    assert.equal(secrets.isLicense(LICENSE), true);
  });

  test('a paste is normalized exactly the way the service normalizes it', () => {
    // server/src/license.js normalizeLicense: dashes and spaces dropped, the
    // prefix optional and case-insensitive, the body upper-cased with the
    // Crockford look-alikes folded (I and L to 1, O to zero). If the app is
    // stricter than the service, it refuses keys the service would have taken
    // and the person is told their real license is not a license.
    const canonical = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
    for (const typed of [
      canonical,
      `  ${canonical}  `,
      canonical.toUpperCase(),
      'gry_live_7KQ2-R9XW-4M0Z-T8VN-3HJ5-CB6D',   // wrapped in an email
      'gry_live_7KQ2 R9XW 4M0Z T8VN 3HJ5 CB6D',   // read out loud
      '7KQ2R9XW4M0ZT8VN3HJ5CB6D'                  // body only, prefix assumed
    ]) {
      assert.equal(secrets.normalizeLicense(typed), canonical, typed);
    }
    // O and I are not in the alphabet, so someone typing them meant 0 and 1.
    assert.equal(secrets.normalizeLicense('gry_live_7KQ2R9XW4MOZT8VN3HJ5CB6I'),
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB61');
    // The service is still the authority on whether the folded key exists; the
    // app only promises not to reject it before asking.
  });

  test('masking shows the prefix and the last four, never the body', () => {
    assert.equal(secrets.maskLicense(LICENSE), 'gry_live_…CB6D');
    assert.equal(secrets.maskLicense(''), '');
    assert.equal(secrets.maskLicense(null), '');
    assert.equal(secrets.maskLicense('gry_live_'), 'gry_live_…');
    assert.equal(secrets.maskLicense(LICENSE).includes('7KQ2'), false);
  });

  test('clearing blanks it and leaves the API key alone', () => {
    secrets.clearLicense();
    assert.equal(secrets.getLicense(), null);
    assert.equal(readStore().grayoutLicense, '');
    assert.equal(secrets.getApiKey(), KEY);
  });

  test('a session license wins over the environment, and both need no keychain', t => {
    const saved = process.env.GRAYOUT_LICENSE;
    t.after(() => { if (saved === undefined) delete process.env.GRAYOUT_LICENSE; else process.env.GRAYOUT_LICENSE = saved; secrets.useSessionLicense(null); });
    process.env.GRAYOUT_LICENSE = 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ23';
    assert.equal(secrets.getLicense(), 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ23');
    secrets.useSessionLicense(LICENSE);
    assert.equal(secrets.getLicense(), LICENSE);
    secrets.useSessionLicense(null);
    delete process.env.GRAYOUT_LICENSE;
    assert.equal(secrets.getLicense(), null);
  });

  test('the log never prints a license key', () => {
    const log = require('../src/log');
    assert.equal(log.redact(`activated ${LICENSE}`), 'activated [redacted]');
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
