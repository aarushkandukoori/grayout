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
const channel = require('../src/channel');

// The model key exists only in the personal build (src/channel.js). Most of
// this file tests the store itself, so it runs as that build; the public
// builds have describe blocks of their own at the end.
channel._setPersonalForTests(true);

after(() => {
  if (SAVED_ENV_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_ENV_KEY;
  helpers.cleanup(dir);
});

// Fake keys are joined at runtime: secret scanners flag key-shaped literals, even fake ones.
const KEY = ['sk', 'ant', 'api03', 'TESTKEY0123456789abcdefghijklmnop'].join('-');
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
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: '', grayoutLicense: '', grayoutDeviceToken: '' });
  });

  test('canvas token round trip keeps the api key', () => {
    secrets.setCanvasToken('  ctok  ');
    assert.equal(secrets.getCanvasToken(), 'ctok');
    assert.equal(secrets.getApiKey(), KEY);
    assert.deepEqual(readStore(), { anthropicApiKey: KEY, canvasToken: 'ctok', grayoutLicense: '', grayoutDeviceToken: '' });
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

  test('only gry_live_ or gry_test_ + 24 Crockford base32 characters is accepted', () => {
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    for (const bad of [
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6',      // 23 characters
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6DD',    // 25
      'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6U',     // U is not in the alphabet
      'gry_prod_7KQ2R9XW4M0ZT8VN3HJ5CB6D',     // not a prefix the service issues
      'gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6',      // a test key is held to the same shape
      'sk-ant-api03-nope'
    ]) {
      assert.throws(() => secrets.setLicense(bad), /Grayout license key/, bad);
      assert.equal(secrets.isLicense(bad), false, bad);
    }
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before, 'nothing was written');
    assert.equal(secrets.isLicense(LICENSE), true);
  });

  test('a sandbox key (gry_test_) keeps its prefix; it is never turned into a live key', () => {
    // docs/API-CONTRACT.md 4.2: Stripe sandbox purchases get gry_test_ keys.
    const TEST = 'gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
    assert.equal(secrets.normalizeLicense(TEST), TEST);
    assert.equal(secrets.normalizeLicense('GRY_TEST_7kq2-r9xw-4m0z-t8vn-3hj5-cb6d'), TEST);
    assert.equal(secrets.maskLicense(TEST), 'gry_test_…CB6D');
    assert.equal(secrets.isLicense(TEST), true);
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

describe('the device token (docs/API-CONTRACT.md 4.1)', () => {
  const TOKEN = 'abcdefghijABCDEFGHIJ0123456789-_abcdefghijk';

  test('round trips in secrets.bin next to the license, never in plaintext elsewhere', () => {
    secrets._setSafeStorage(identity());
    secrets.setDeviceToken(TOKEN);
    assert.equal(secrets.getDeviceToken(), TOKEN);
    assert.equal(readStore().grayoutDeviceToken, TOKEN);
    assert.equal(secrets.getApiKey(), KEY, 'the self-hosted key is untouched');
  });

  test('only a 43-character base64url token is accepted', () => {
    for (const bad of ['', 'short', TOKEN + 'x', TOKEN.slice(0, 42) + '=', TOKEN.slice(0, 42) + '/']) {
      assert.throws(() => secrets.setDeviceToken(bad), /device token/, bad);
    }
    assert.equal(secrets.getDeviceToken(), TOKEN, 'a bad token never replaces a good one');
  });

  test('clearing blanks it; without a keychain it can only be held for the session', () => {
    secrets.clearDeviceToken();
    assert.equal(secrets.getDeviceToken(), null);
    assert.equal(readStore().grayoutDeviceToken, '');
    secrets._setSafeStorage({ ...identity(), isEncryptionAvailable: () => false });
    assert.throws(() => secrets.setDeviceToken(TOKEN), e => e.name === 'SecretsUnavailable');
    secrets.useSessionDeviceToken(TOKEN);
    assert.equal(secrets.getDeviceToken(), TOKEN);
    secrets.useSessionDeviceToken(null);
    assert.equal(secrets.getDeviceToken(), null);
    secrets._setSafeStorage(identity());
  });
});

describe('the log hides every Grayout credential (safety net)', () => {
  // Regression: the redaction pattern only knew sk-… and gry_live_ keys, so a
  // sandbox key or the device token in an error message or a stack trace
  // would have been written to grayout.log as is.
  const log = require('../src/log');
  const TOKEN = 'abcdefghijABCDEFGHIJ0123456789-_abcdefghijk';

  test('a sandbox license key (gry_test_), in any case', () => {
    assert.equal(log.redact('x gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D y'), 'x [redacted] y');
    assert.equal(log.redact('x gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D y'), 'x [redacted] y');
    assert.equal(log.redact('x GRY_TEST_7kq2r9xw4m0zt8vn3hj5cb6d y'), 'x [redacted] y');
  });

  test('a device token, standalone or in its JSON field', () => {
    assert.equal(log.redact(`x ${TOKEN} y`), 'x [redacted] y');
    assert.equal(log.redact(`token=${TOKEN}.`), 'token=[redacted].');
    const body = JSON.stringify({ deviceId: 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G', deviceToken: TOKEN });
    const out = log.redact(body);
    assert.equal(out.includes(TOKEN), false);
    assert.match(out, /"deviceToken":"\[redacted\]"/);
    assert.match(out, /dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G/, 'the device id is not secret and stays readable');
    // A field holding something of another shape is still hidden.
    assert.equal(log.redact('{"deviceToken":"short"}'), '{"deviceToken":"[redacted]"}');
  });

  test('ordinary log lines are untouched', () => {
    const line = 'activated: status=active service=true /Users/a/Library/Application Support/Grayout/secrets.bin';
    assert.equal(log.redact(line), line);
  });

  test('written to disk redacted', () => {
    log.warn('test', `oops ${TOKEN} gry_test_7KQ2R9XW4M0ZT8VN3HJ5CB6D`);
    const text = fs.readFileSync(paths.LOG_PATH, 'utf8');
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('gry_test_7KQ2'), false);
  });
});

describe('an unreadable secrets.bin is never overwritten in place', () => {
  // If the Keychain refuses (the person pressed Deny after an update), the
  // file still holds the license and the device token. Writing an "empty"
  // store over it would lose a paid key.
  const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
  const TOKEN = 'abcdefghijABCDEFGHIJ0123456789-_abcdefghijk';
  const denied = () => ({ ...identity(), decryptString: () => { throw new Error('denied'); } });

  test('unreadable() says so; clears leave the file alone; a write keeps it as secrets.bin.unreadable', () => {
    secrets._setSafeStorage(identity());
    secrets.setLicense(LICENSE);
    secrets.setDeviceToken(TOKEN);
    const original = fs.readFileSync(paths.SECRETS_PATH);
    try { fs.unlinkSync(paths.SECRETS_PATH + '.unreadable'); } catch {}

    secrets._setSafeStorage(denied());
    assert.equal(secrets.unreadable(), true);
    assert.equal(secrets.getLicense(), null);
    secrets.clearLicense();
    secrets.clearDeviceToken();
    secrets.clearApiKey();
    assert.deepEqual(fs.readFileSync(paths.SECRETS_PATH), original, 'clearing an unreadable store does nothing');

    secrets.setDeviceToken(TOKEN.replace('a', 'b'));
    assert.equal(secrets.unreadable(), false);
    assert.deepEqual(fs.readFileSync(paths.SECRETS_PATH + '.unreadable'), original, 'the old store is kept aside');

    // Put the old file back with a working Keychain: the license is all there.
    fs.renameSync(paths.SECRETS_PATH + '.unreadable', paths.SECRETS_PATH);
    secrets._setSafeStorage(identity());
    assert.equal(secrets.getLicense(), LICENSE);
    assert.equal(secrets.getDeviceToken(), TOKEN);
  });

  test('a missing secrets.bin is not "unreadable"', () => {
    secrets._setSafeStorage(identity());
    const saved = fs.readFileSync(paths.SECRETS_PATH);
    fs.unlinkSync(paths.SECRETS_PATH);
    secrets._setSafeStorage(denied());
    assert.equal(secrets.unreadable(), false);
    fs.writeFileSync(paths.SECRETS_PATH, saved, { mode: 0o600 });
    secrets._setSafeStorage(identity());
  });
});

describe('Mac App Store edition: no own model key (no self-hosting)', () => {
  after(() => { channel._setForTests(null); channel._setPersonalForTests(true); delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; });

  test('getApiKey is null whatever is stored, held in memory or set in the environment; the license is unaffected', () => {
    channel._setForTests(null);
    secrets._setSafeStorage(identity());
    secrets.setApiKey(KEY);
    secrets.useSessionKey('sk-ant-api03-session-key');
    secrets.setLicense('gry_live_ABCDEFGHJKMNPQRSTVWXYZ01');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    process.env.OPENAI_API_KEY = 'sk-proj-env-key';
    channel._setForTests('mas');
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getLicense(), 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ01', 'the subscription credential still works');
    channel._setPersonalForTests(true);
    assert.equal(secrets.getApiKey(), null, 'the personal flag changes nothing in this edition');
    channel._setForTests(null);
    assert.equal(secrets.getApiKey(), 'sk-ant-api03-session-key', 'the personal direct build still sees it');
  });

  test('setApiKey and useSessionKey throw SelfHostingUnavailable and write nothing', () => {
    channel._setForTests(null);
    secrets.clearApiKey();
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    channel._setForTests('mas');
    assert.throws(() => secrets.setApiKey(KEY), e => e instanceof secrets.SelfHostingUnavailable && e.kind === 'unavailable');
    assert.throws(() => secrets.useSessionKey(KEY), e => e.name === 'SelfHostingUnavailable');
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before);
    assert.equal(readStore().anthropicApiKey, '');
  });

  test('forget() drops every credential held in memory', () => {
    channel._setForTests(null);
    secrets.useSessionKey('sk-ant-api03-another-session');
    assert.ok(secrets.getApiKey());
    fs.rmSync(paths.SECRETS_PATH, { force: true });
    secrets.forget();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getLicense(), null);
    assert.equal(secrets.getDeviceToken(), null);
  });
});

describe('public direct build: no own model key (pay-only)', () => {
  const LICENSE = 'gry_live_ABCDEFGHJKMNPQRSTVWXYZ01';
  after(() => { channel._setForTests(null); channel._setPersonalForTests(true); delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; });

  test('a key saved by 1.x stays in secrets.bin, unread; the environment is ignored; the license works', () => {
    channel._setForTests('direct');
    channel._setPersonalForTests(true);
    secrets._setSafeStorage(identity());
    secrets.setApiKey(KEY);
    secrets.setLicense(LICENSE);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    process.env.OPENAI_API_KEY = 'sk-proj-env-key';
    channel._setPersonalForTests(false);
    assert.equal(secrets.getApiKey(), null);
    assert.equal(secrets.getLicense(), LICENSE, 'the subscription credential still works');
    assert.equal(readStore().anthropicApiKey, KEY, 'nothing is deleted: the personal build can still use it');
    channel._setPersonalForTests(true);
    assert.equal(secrets.getApiKey(), 'sk-ant-env-key', 'the personal build, run from source, reads the environment');
  });

  test('setApiKey and useSessionKey throw SelfHostingUnavailable, with wording that fits this edition', () => {
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    const before = fs.readFileSync(paths.SECRETS_PATH, 'utf8');
    assert.throws(() => secrets.setApiKey(['sk', 'ant', 'api03', 'another-key-0123456789'].join('-')), e => e instanceof secrets.SelfHostingUnavailable && e.kind === 'unavailable' && !/App Store/.test(e.message));
    assert.throws(() => secrets.useSessionKey(KEY), e => e.name === 'SelfHostingUnavailable');
    assert.equal(fs.readFileSync(paths.SECRETS_PATH, 'utf8'), before, 'nothing written');
  });
});
