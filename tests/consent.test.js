'use strict';
// Permission to send screenshots to a third-party AI (src/consent.js), its IPC
// (consent:grant / consent:revoke), and "Erase this Mac's Grayout data"
// (data:erase), against a temp userData folder.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const SAVED_ENV = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const dir = helpers.freshUserData('consent');
const handlers = new Map();
const dialogs = [];
let dialogAnswer = 1;
const appCalls = [];
let primes = 0;
const electron = helpers.stubElectron({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
  shell: { openExternal() {}, showItemInFolder() {}, openPath: async () => '' },
  clipboard: { writeText() {} },
  dialog: { showMessageBox: async o => { dialogs.push(o); return { response: dialogAnswer }; } },
  app: { relaunch: () => appCalls.push('relaunch'), exit: code => appCalls.push(`exit:${code}`) },
  desktopCapturer: { getSources: async () => { primes++; return []; } }
});

const paths = require('../src/paths');
const state = require('../src/state');
const secrets = require('../src/secrets');
const configMod = require('../src/config');
const channel = require('../src/channel');
const consent = require('../src/consent');
const ipc = require('../src/ipc');

after(() => {
  channel._setForTests(null);
  if (SAVED_ENV.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_ENV.anthropic;
  if (SAVED_ENV.openai !== undefined) process.env.OPENAI_API_KEY = SAVED_ENV.openai;
  helpers.cleanup(dir);
});

const loopCalls = [];
const fakeLoop = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'getLive') return () => ({ paused: false, running: true, lastLine: 'watching…' });
    return (...args) => { loopCalls.push({ name, args }); return Promise.resolve(); };
  }
});
const windowCalls = [];
const fakeWindows = { closeOnboarding: () => windowCalls.push('closeOnboarding'), openOnboarding: () => windowCalls.push('openOnboarding') };
let cfg = configMod.coerce({});
const grayOff = [];
function register(extra = {}) {
  ipc.registerIpc({
    loop: fakeLoop, getConfig: () => cfg, applyConfig: c => { cfg = c; }, windows: fakeWindows, updater: null,
    grayscaleAvailable: () => true, forceGrayscaleOff: () => grayOff.push(true), ...extra
  });
}
register();
const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);
const turns = () => helpers.turns(5);

describe('state defaults', () => {
  test('a new install has no consent', () => {
    state._reset();
    assert.deepEqual(state.get().consent, { granted: false, at: null, version: null });
    assert.deepEqual(consent.get(), { granted: false, at: null, version: null });
    assert.equal(consent.valid(), false);
    assert.equal(consent.satisfied(), false, 'both editions ask');
  });

  test('a state.json from before consent existed, or with a broken consent field, reads as no consent', () => {
    for (const bad of [undefined, null, 'yes', ['granted'], 42]) {
      fs.writeFileSync(paths.STATE_PATH, JSON.stringify({ onboarding: { completed: true, step: 5 }, ...(bad === undefined ? {} : { consent: bad }) }));
      state._reset();
      assert.deepEqual(state.get().consent, { granted: false, at: null, version: null }, JSON.stringify(bad));
      assert.equal(state.get().onboarding.completed, true);
      assert.equal(consent.satisfied(), false);
    }
  });
});

describe('src/consent.js', () => {
  test('grant stores granted, an ISO time and CONSENT_VERSION; revoke clears it', () => {
    state._reset();
    const g = consent.grant(Date.UTC(2026, 9, 15, 12, 0, 0));
    assert.deepEqual(g, { granted: true, at: '2026-10-15T12:00:00.000Z', version: consent.CONSENT_VERSION });
    assert.equal(consent.CONSENT_VERSION, 1);
    assert.equal(consent.satisfied(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).consent, g, 'persisted');
    state._reset();
    assert.equal(consent.valid(), true, 'survives a restart');
    assert.deepEqual(consent.revoke(), { granted: false, at: null, version: null });
    assert.equal(consent.satisfied(), false);
  });

  test('a grant under another CONSENT_VERSION does not count', () => {
    state.update(s => { s.consent = { granted: true, at: '2026-01-01T00:00:00.000Z', version: 0 }; });
    assert.deepEqual(consent.get(), { granted: false, at: '2026-01-01T00:00:00.000Z', version: 0 });
    assert.equal(consent.satisfied(), false);
    state.update(s => { s.consent = { granted: 'true', at: null, version: 1 }; });
    assert.equal(consent.valid(), false, 'only a real true counts');
  });

  test('processor names who receives screenshots under the engine and provider in use', t => {
    t.after(() => { channel._setForTests(null); secrets.useSessionKey(''); });
    assert.deepEqual(consent.processor(configMod.coerce({})), { name: 'OpenAI', via: 'the Grayout service' });
    assert.deepEqual(consent.processor(configMod.coerce({ provider: 'grayout' }), 'sk-ant-x'), { name: 'OpenAI', via: 'the Grayout service' });
    assert.deepEqual(consent.processor(configMod.coerce({}), 'sk-proj-own-key'), { name: 'OpenAI', via: 'your own API key' });
    assert.deepEqual(consent.processor(configMod.coerce({ provider: 'anthropic' }), null), { name: 'Anthropic', via: 'your own API key' });
    assert.deepEqual(consent.processor(configMod.coerce({}), 'sk-ant-api03-own'), { name: 'Anthropic', via: 'your own API key' });
    assert.deepEqual(consent.processor({ engine: 'cli' }), { name: 'Anthropic', via: 'your Claude CLI login' });
    secrets.useSessionKey('sk-proj-held-in-memory');
    assert.deepEqual(consent.processor(configMod.coerce({})), { name: 'OpenAI', via: 'your own API key' }, 'reads the key in use');
    channel._setForTests('mas');
    assert.deepEqual(consent.processor({ engine: 'cli', provider: 'anthropic' }, 'sk-ant-x'), { name: 'OpenAI', via: 'the Grayout service' }, 'the store edition has only the service');
  });

  test('payload is get() plus the processor', () => {
    consent.revoke();
    assert.deepEqual(consent.payload(configMod.coerce({})), { granted: false, at: null, version: null, processor: { name: 'OpenAI', via: 'the Grayout service' } });
  });
});

describe('consent:grant / consent:revoke', () => {
  test('first run (setup not done): records consent, primes Screen Recording, does not start watching or close the window', async () => {
    state._reset();
    fs.rmSync(paths.STATE_PATH, { force: true });
    state._reset();
    loopCalls.length = 0; windowCalls.length = 0; primes = 0;
    const r = invoke('consent:grant');
    await turns();
    assert.equal(r.ok, true);
    assert.equal(r.consent.granted, true);
    assert.equal(r.consent.version, 1);
    assert.match(r.consent.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(r.consent.processor, { name: 'OpenAI', via: 'the Grayout service' });
    assert.equal(consent.satisfied(), true);
    assert.deepEqual(loopCalls, []);
    assert.deepEqual(windowCalls, []);
    assert.equal(primes, 1, 'the Screen Recording step comes next');
  });

  test('setup already done (an install from before consent): closes the welcome window and resumes watching', async () => {
    consent.revoke();
    state.update(s => { s.onboarding = { completed: true, step: 5 }; });
    loopCalls.length = 0; windowCalls.length = 0;
    const r = invoke('consent:grant');
    await turns();
    assert.equal(r.consent.granted, true);
    assert.deepEqual(windowCalls, ['closeOnboarding']);
    assert.deepEqual(loopCalls.map(c => c.name), ['resume']);
  });

  test('main.js can take over starting the loop (onConsentGranted)', async t => {
    let started = 0;
    register({ onConsentGranted: () => { started++; } });
    t.after(() => register());
    consent.revoke();
    loopCalls.length = 0; windowCalls.length = 0;
    invoke('consent:grant');
    await turns();
    assert.equal(started, 1);
    assert.deepEqual(windowCalls, ['closeOnboarding']);
    assert.deepEqual(loopCalls, [], 'main decides between start and resume');
  });

  test('revoke clears consent and pauses the loop with "consent withdrawn"', async () => {
    consent.grant();
    loopCalls.length = 0;
    const r = await invoke('consent:revoke');
    assert.equal(r.ok, true);
    assert.deepEqual({ granted: r.consent.granted, at: r.consent.at, version: r.consent.version }, { granted: false, at: null, version: null });
    assert.equal(consent.satisfied(), false);
    assert.deepEqual(loopCalls, [{ name: 'pause', args: ['consent withdrawn'] }]);
    assert.equal(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).consent.granted, false);
  });

  test('the payloads follow along', async () => {
    consent.grant();
    assert.equal(invoke('dash:get').consent.granted, true);
    assert.equal((await invoke('settings:get')).consent.granted, true);
    assert.equal((await invoke('onb:getState')).consent.granted, true);
    await invoke('consent:revoke');
    assert.equal((await invoke('onb:getState')).consent.granted, false);
  });
});

describe('data:erase', () => {
  const identity = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const LICENSE = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
  const OURS = ['verdicts.jsonl', 'state.json', 'config.json', 'config.json.invalid', 'secrets.bin', 'secrets.bin.unreadable', 'logs'];
  const THEIRS = ['Preferences', path.join('Local Storage', 'leveldb')];

  function seed() {
    secrets._setSafeStorage(identity);
    secrets.setLicense(LICENSE);
    state.update(s => { s.onboarding = { completed: true, step: 5 }; s.deviceId = 'dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G'; });
    consent.grant();
    configMod.writeConfig({ ...configMod.coerce({}), workDescription: 'thesis' });
    fs.writeFileSync(paths.VERDICT_LOG, '{"ts":1,"activity":"code editor"}\n');
    fs.writeFileSync(paths.CONFIG_PATH + '.invalid', '{ broken');
    fs.writeFileSync(paths.SECRETS_PATH + '.unreadable', 'old');
    fs.mkdirSync(paths.LOG_DIR, { recursive: true });
    fs.writeFileSync(paths.LOG_PATH, 'a log line\n');
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
    fs.mkdirSync(path.join(dir, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb'), 'x');
    for (const f of [...OURS, ...THEIRS]) assert.equal(fs.existsSync(path.join(dir, f)), true, `seeded ${f}`);
  }

  test('asks first; Cancel leaves everything alone and does not restart', async () => {
    seed();
    dialogs.length = 0; appCalls.length = 0; loopCalls.length = 0;
    dialogAnswer = 1;
    assert.deepEqual(await invoke('data:erase'), { ok: false });
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].message, "Erase this Mac's Grayout data?");
    assert.deepEqual(dialogs[0].buttons, ['Erase and Restart', 'Cancel']);
    assert.equal(dialogs[0].cancelId, 1);
    assert.equal(dialogs[0].defaultId, 1, 'Cancel is the default');
    assert.equal(/—/.test(dialogs[0].message + dialogs[0].detail), false, 'no em dash in the copy');
    for (const f of [...OURS, ...THEIRS]) assert.equal(fs.existsSync(path.join(dir, f)), true, f);
    assert.deepEqual(appCalls, []);
    assert.deepEqual(loopCalls, []);
  });

  test('confirmed: color back first, Grayout\'s own files gone, Electron\'s left, then relaunch and exit', async () => {
    seed();
    dialogs.length = 0; appCalls.length = 0; loopCalls.length = 0; grayOff.length = 0;
    dialogAnswer = 0;
    const r = await invoke('data:erase');
    assert.equal(r.ok, true);
    assert.deepEqual([...r.removed].sort(), [...OURS].sort());
    for (const f of OURS) assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} erased`);
    for (const f of THEIRS) assert.equal(fs.existsSync(path.join(dir, f)), true, `${f} is Electron's, kept`);
    assert.deepEqual(loopCalls.map(c => c.name), ['pause', 'restoreColor']);
    assert.equal(grayOff.length, 1, 'grayscale forced off');
    assert.deepEqual(appCalls, ['relaunch', 'exit:0']);

    // Nothing in memory brings the old data back.
    assert.equal(secrets.getLicense(), null);
    assert.equal(secrets.getDeviceToken(), null);
    assert.equal(state.get().deviceId, undefined);
    assert.deepEqual(state.get().consent, { granted: false, at: null, version: null });
    assert.equal(state.get().onboarding.completed, false);
  });

  test('eraseLocalData on an already empty folder removes nothing and does not throw', () => {
    for (const f of OURS) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    assert.deepEqual(ipc.eraseLocalData(), []);
  });
});
