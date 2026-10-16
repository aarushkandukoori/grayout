'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('ipc');

// src/ipc.js (and permissions/loginitem it imports) require 'electron' at top
// level; route that through a fake before loading it.
const handlers = new Map();
const listeners = new Map();
const opened = [];
const copied = [];
const electron = helpers.stubElectron({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) },
  shell: { openExternal: u => opened.push(u), showItemInFolder: () => {}, openPath: async () => '' },
  clipboard: { writeText: t => copied.push(t) },
  dialog: { showMessageBox: async () => ({ response: 1 }) }
});

const paths = require('../src/paths');
const configMod = require('../src/config');
const ipc = require('../src/ipc');
const { sanitizeSettings, ALLOWED_HOSTS, INTERVAL_CHOICES, registerIpc } = ipc;

// The key:* handlers and the CLI engine work only in the personal build
// (src/channel.js), so this file runs as that build. The public builds get
// their own tests under "editions and consent".
require('../src/channel')._setPersonalForTests(true);

after(() => helpers.cleanup(dir));

describe('electron stub', () => {
  test('require("electron") resolves to the fake from src too', () => {
    assert.equal(require('electron'), electron);
    assert.equal(require('../src/permissions').cameraStatus(), 'granted');
    assert.equal(paths.USER_DATA, dir);
  });
});

describe('sanitizeSettings', () => {
  test('non-objects → {}', () => {
    assert.deepEqual(sanitizeSettings(null), {});
    assert.deepEqual(sanitizeSettings(undefined), {});
    assert.deepEqual(sanitizeSettings('str'), {});
    assert.deepEqual(sanitizeSettings(42), {});
    assert.deepEqual(sanitizeSettings({}), {});
  });

  test('checkIntervalSec: coerced, rounded, clamped 10..3600, default 45 on garbage', () => {
    assert.equal(sanitizeSettings({ checkIntervalSec: '30' }).checkIntervalSec, 30);
    assert.equal(sanitizeSettings({ checkIntervalSec: 0 }).checkIntervalSec, 10);
    assert.equal(sanitizeSettings({ checkIntervalSec: 99999 }).checkIntervalSec, 3600);
    assert.equal(sanitizeSettings({ checkIntervalSec: 44.4 }).checkIntervalSec, 44);
    assert.equal(sanitizeSettings({ checkIntervalSec: 'abc' }).checkIntervalSec, 45);
    assert.equal(sanitizeSettings({ checkIntervalSec: NaN }).checkIntervalSec, 45);
    assert.equal('checkIntervalSec' in sanitizeSettings({ strikes: 2 }), false, 'absent keys stay absent');
  });

  test('strikes clamped 1..20, default 2', () => {
    assert.equal(sanitizeSettings({ strikes: 99 }).strikes, 20);
    assert.equal(sanitizeSettings({ strikes: 0 }).strikes, 1);
    assert.equal(sanitizeSettings({ strikes: '3' }).strikes, 3);
    assert.equal(sanitizeSettings({ strikes: {} }).strikes, 2);
  });

  test('workDescription: strings only, capped at MAX_WORK_DESCRIPTION', () => {
    assert.equal(sanitizeSettings({ workDescription: 'x'.repeat(600) }).workDescription.length, configMod.MAX_WORK_DESCRIPTION);
    assert.equal(sanitizeSettings({ workDescription: 42 }).workDescription, '');
    assert.equal(sanitizeSettings({ workDescription: null }).workDescription, '');
    assert.equal(sanitizeSettings({ workDescription: 'thesis' }).workDescription, 'thesis');
  });

  test('booleans: only real booleans are copied', () => {
    const p = { grayscale: false, redFlash: 'true', camera: 1, startAtLogin: true, checkForUpdates: null, pauseWhenLocked: false, logVerdicts: 'no' };
    assert.deepEqual(sanitizeSettings(p), { grayscale: false, startAtLogin: true, pauseWhenLocked: false });
  });

  test('app lists: strings only, trimmed, 80 chars each, empties dropped, max 100', () => {
    const out = sanitizeSettings({ alwaysAllowedApps: ['  Zoom ', 1, null, '', 'x'.repeat(100), { a: 1 }], neverCaptureApps: 'Bitwarden' });
    assert.deepEqual(out.alwaysAllowedApps, ['Zoom', 'x'.repeat(80)]);
    assert.equal('neverCaptureApps' in out, false);
    const many = Array.from({ length: 150 }, (_, i) => `a${i}`);
    assert.equal(sanitizeSettings({ neverCaptureApps: many }).neverCaptureApps.length, 100);
  });

  test('advanced numerics keep their bounds', () => {
    assert.equal(sanitizeSettings({ maxAlertMinutes: 0 }).maxAlertMinutes, 1);
    assert.equal(sanitizeSettings({ maxAlertMinutes: 1000 }).maxAlertMinutes, 240);
    assert.equal(sanitizeSettings({ maxAlertMinutes: 'x' }).maxAlertMinutes, 20);
    assert.equal(sanitizeSettings({ disputeGraceMin: 500 }).disputeGraceMin, 120);
    assert.equal(sanitizeSettings({ disputeGraceMin: 'x' }).disputeGraceMin, 10);
    assert.equal(sanitizeSettings({ dailyCheckCap: 1 }).dailyCheckCap, 50);
    assert.equal(sanitizeSettings({ dailyCheckCap: 1e9 }).dailyCheckCap, 20000);
    assert.equal(sanitizeSettings({ dailyCheckCap: 'x' }).dailyCheckCap, 1200);
    assert.equal(sanitizeSettings({ historyDays: 0 }).historyDays, 1);
    assert.equal(sanitizeSettings({ historyDays: 9999 }).historyDays, 365);
    assert.equal(sanitizeSettings({ historyDays: 'x' }).historyDays, 30);
  });

  test('keys the UI may not change are dropped', () => {
    const out = sanitizeSettings({
      model: 'claude-opus-5', engine: 'cli', cliPath: '/bin/sh', cliAllowOverage: true, canvas: { token: 'x' }, tasksFile: '/etc/passwd',
      schemaVersion: 9, idleSkipSec: 1, heldAlertRecheckSec: 1, wakeGraceSec: 0,
      anthropicApiKey: 'sk-ant-nope', __proto__: { polluted: true }, constructor: 'x'
    });
    assert.deepEqual(out, {});
    assert.equal(({}).polluted, undefined);
  });

  test('a full settings payload comes back exactly as the allowed subset', () => {
    const out = sanitizeSettings({ checkIntervalSec: 90, strikes: 3, workDescription: 'w', grayscale: true, redFlash: false, camera: true, startAtLogin: false, checkForUpdates: true, pauseWhenLocked: true, logVerdicts: false, alwaysAllowedApps: ['Zoom'], neverCaptureApps: [], maxAlertMinutes: 30, disputeGraceMin: 5, dailyCheckCap: 800, historyDays: 7, model: 'x' });
    assert.deepEqual(Object.keys(out).sort(), ['alwaysAllowedApps', 'camera', 'checkForUpdates', 'checkIntervalSec', 'dailyCheckCap', 'disputeGraceMin', 'grayscale', 'historyDays', 'logVerdicts', 'maxAlertMinutes', 'neverCaptureApps', 'pauseWhenLocked', 'redFlash', 'startAtLogin', 'strikes', 'workDescription']);
    assert.deepEqual(out.neverCaptureApps, []);
    assert.equal(out.historyDays, 7);
  });

  test('sanitized output is accepted by config.coerce unchanged', () => {
    const clean = sanitizeSettings({ checkIntervalSec: '90', strikes: 3, alwaysAllowedApps: [' Zoom '], dailyCheckCap: 800 });
    const cfg = configMod.coerce(clean);
    assert.equal(cfg.checkIntervalSec, 90);
    assert.equal(cfg.strikes, 3);
    assert.deepEqual(cfg.alwaysAllowedApps, ['Zoom']);
    assert.equal(cfg.dailyCheckCap, 800);
  });
});

describe('constants', () => {
  test('external links are limited to https on a short allowlist', () => {
    for (const h of ['github.com', 'console.anthropic.com', 'aarushkandukoori.github.io', 'platform.openai.com']) assert.ok(ALLOWED_HOSTS.has(h), h);
    assert.equal(ALLOWED_HOSTS.has('evil.com'), false);
    assert.equal(ALLOWED_HOSTS.has('github.com.evil.com'), false);
  });
  test('interval picker offers 30/45/60/90/120', () => {
    assert.deepEqual([...INTERVAL_CHOICES].sort((a, b) => a - b), [30, 45, 60, 90, 120]);
  });
});

describe('registerIpc with fakes', () => {
  const calls = [];
  const fakeLoop = new Proxy({}, {
    get: (_t, name) => {
      if (name === 'getLive') return () => ({ paused: false, needsKey: false, alerting: false, lastLine: 'watching…' });
      return (...args) => { calls.push({ name, args }); return `ret:${String(name)}`; };
    }
  });
  const applied = [];
  let cfg = configMod.coerce({});
  registerIpc({ loop: fakeLoop, getConfig: () => cfg, applyConfig: c => { cfg = c; applied.push(c); }, windows: {}, updater: null, grayscaleAvailable: () => true });
  const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);

  test('every channel the preload scripts invoke has a handler', () => {
    const preloadDir = path.join(paths.APP_ROOT, 'ui', 'preload');
    const wanted = new Set();
    for (const f of ['dashboard.js', 'onboarding.js']) {
      const src = fs.readFileSync(path.join(preloadDir, f), 'utf8');
      for (const m of src.matchAll(/invoke\('([^']+)'/g)) wanted.add(m[1]);
    }
    assert.ok(wanted.size >= 30, `parsed ${wanted.size} channels`);
    const missing = [...wanted].filter(ch => !handlers.has(ch));
    assert.deepEqual(missing, []);
    assert.ok(listeners.has('camera-status'));
  });

  test('shell:openExternal only opens https URLs on the allowlist', () => {
    assert.equal(invoke('shell:openExternal', 'https://github.com/aarushkandukoori/grayout'), true);
    assert.deepEqual(opened, ['https://github.com/aarushkandukoori/grayout']);
    for (const bad of ['http://github.com/x', 'https://evil.com', 'https://github.com.evil.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', null, 42, 'https://user:pw@github.com@evil.com/']) {
      assert.equal(invoke('shell:openExternal', bad), false, String(bad));
    }
    assert.equal(opened.length, 1);
  });

  test('"Get a key" (personal build key panel): each provider\'s key page passes the allowlist', () => {
    const urls = ['https://console.anthropic.com/settings/keys', 'https://platform.openai.com/api-keys'];
    const before = opened.length;
    for (const url of urls) assert.equal(invoke('shell:openExternal', url), true, url);
    assert.deepEqual(opened.slice(before), urls);
  });

  test('clipboard:copy truncates to 2000 chars and ignores non-strings', () => {
    assert.equal(invoke('clipboard:copy', 'x'.repeat(3000)), true);
    assert.equal(copied.at(-1).length, 2000);
    invoke('clipboard:copy', { a: 1 });
    assert.equal(copied.at(-1), '');
  });

  test('loop:* channels forward with sanitized arguments', () => {
    assert.equal(invoke('loop:pauseFor', '15'), 'ret:pauseFor');
    assert.deepEqual(calls.at(-1), { name: 'pauseFor', args: [15 * 60000] });
    invoke('loop:pauseFor', 100000);
    assert.deepEqual(calls.at(-1).args, [24 * 60 * 60000], 'capped at a day');
    invoke('loop:pauseFor', 'zzz');
    assert.deepEqual(calls.at(-1).args, [15 * 60000], 'default 15 min');
    invoke('loop:dispute', 'not-a-ts');
    assert.deepEqual(calls.at(-1), { name: 'dispute', args: [null] });
    invoke('loop:dispute', 1789905600000);
    assert.deepEqual(calls.at(-1).args, [1789905600000]);
    invoke('loop:previewGray');
    assert.deepEqual(calls.at(-1), { name: 'previewGray', args: [3000] });
    for (const ch of ['loop:pause', 'loop:resume', 'loop:checkNow', 'loop:restoreColor']) {
      invoke(ch);
      assert.equal(calls.at(-1).name, ch.split(':')[1]);
    }
  });

  test('settings:save sanitizes, writes config.json and applies it', async () => {
    const r = await invoke('settings:save', { checkIntervalSec: '90', model: 'gpt-4o', strikes: 99, apiKey: 'sk-ant-nope' });
    assert.equal(r.config.checkIntervalSec, 90);
    assert.equal(r.config.strikes, 20);
    assert.equal(r.config.model, 'claude-haiku-4-5');
    assert.equal(applied.length, 1);
    assert.equal(cfg.checkIntervalSec, 90);
    const onDisk = JSON.parse(fs.readFileSync(paths.CONFIG_PATH, 'utf8'));
    assert.equal(onDisk.checkIntervalSec, 90);
    assert.equal('apiKey' in onDisk, false);
    assert.equal(JSON.stringify(onDisk).includes('sk-ant'), false);
    // No model key on this Mac → the hosted plan, where a model bill is not
    // this person's bill. Check counts still come back.
    assert.equal(r.estimates.hosted, true);
    assert.equal(r.estimates.perCheck, null);
    assert.equal(r.estimates.byInterval[45].daily, null);
    assert.equal(r.estimates.byInterval[45].checks, Math.round(require('../src/pricing').checksPerDay(45)));
    assert.equal(r.loginItem.status, 'not-in-applications');
  });

  test('key:test refuses an empty key or a missing frame without any network', async () => {
    assert.deepEqual(await invoke('key:test', '   ', 'AAAA'), { ok: false, kind: 'no_key', message: 'Paste a key first.' });
    assert.deepEqual(await invoke('key:test', 'sk-ant-x', null), { ok: false, kind: 'unknown', message: 'No test frame.' });
    assert.deepEqual(await invoke('key:test', 'sk-ant-x', 'x'.repeat(4_000_000)), { ok: false, kind: 'unknown', message: 'No test frame.' });
  });

  test('key:set without secure storage reports secureStorage:false', () => {
    const r = invoke('key:set', 'sk-ant-api03-abc');
    assert.deepEqual(r, { ok: false, secureStorage: false, message: 'Secure storage is not available on this Mac.' });
    assert.equal(fs.existsSync(paths.SECRETS_PATH), false);
  });

  test('key:session holds a key in memory and key:clear drops it', () => {
    assert.deepEqual(invoke('key:session', 'sk-ant-api03-session'), { ok: true });
    assert.equal(require('../src/secrets').getApiKey(), 'sk-ant-api03-session');
    assert.deepEqual(invoke('key:clear'), { ok: true });
    assert.equal(require('../src/secrets').getApiKey(), null);
    assert.deepEqual(invoke('key:session', 'bad key'), { ok: false, message: 'that does not look like an API key' });
  });

  test('dash:get returns the dashboard shape without leaking secrets', () => {
    const r = invoke('dash:get', 'not-a-date');
    assert.equal(r.version, '1.0.0');
    assert.equal(r.dataDir, dir);
    assert.equal(r.hasKey, false);
    assert.equal(r.keyMasked, '');
    assert.equal(r.update, null);
    assert.equal(r.stats.empty, true);
    assert.equal(r.live.lastLine, 'watching…');
    assert.deepEqual(Object.keys(r.config).sort(), ['camera', 'checkIntervalSec', 'disputeGraceMin', 'engine', 'grayscale', 'historyDays', 'model', 'provider', 'providerLabel', 'redFlash', 'strikes']);
    assert.equal(r.config.engine, 'api');
    assert.equal(r.live.engine, 'api');
    assert.equal(r.config.provider, 'grayout', 'no model key → the hosted service');
    assert.equal(r.config.model, 'grayout');
    assert.equal(r.selfHosted, false);
    assert.equal(r.live.needsKey, false, 'the hosted path never asks for an API key');
    assert.deepEqual(Object.keys(r.account).sort(), ['cancelAtPeriodEnd', 'configured', 'hasLicense', 'interval', 'licenseMasked', 'linkUrl', 'manageNote',
      'needsSubscription', 'periodEnd', 'plan', 'problem', 'problemReason', 'secretsLocked', 'service', 'status', 'trialEnd', 'usage']);
    assert.equal(r.account.plan, 'free');
    assert.equal(r.account.hasLicense, false);
    assert.equal(r.freeChecks, 100);
    assert.equal(r.includedChecks, 10000);
    assert.equal(r.plans.monthly.price, 9.99);
  });

  test('a saved key self-hosts and brings the cost meter back; clearing it returns to the hosted plan', async () => {
    invoke('key:session', 'sk-proj-openai-looking-key');
    const s = await invoke('settings:get');
    assert.equal(s.selfHosted, true);
    assert.equal(s.estimates.hosted, false);
    assert.equal(s.estimates.provider, 'openai');
    assert.equal(s.estimates.providerLabel, 'OpenAI');
    assert.equal(s.estimates.model, 'gpt-5-mini', 'claude model is not in the openai family → provider default');
    assert.ok(s.estimates.byInterval[45].daily < 0.90);
    assert.equal(s.hasKey, true);
    assert.equal(s.keyMasked.includes('openai-looking'), false);
    assert.equal(s.plans.yearly.price, 79);
    invoke('key:clear');
    const a = await invoke('settings:get');
    assert.equal(a.selfHosted, false);
    assert.equal(a.estimates.provider, 'grayout');
    assert.equal(a.estimates.providerLabel, 'Grayout');
    assert.equal(a.estimates.byInterval[45].daily, null);
    assert.equal(a.estimates.priceDate, '2026-09-21');
    assert.equal(a.account.usage.checksIncluded, 100, 'no license → the free taste');
  });

  test('an explicit anthropic provider prices the self-hosted path', async () => {
    const saved = cfg;
    cfg = configMod.coerce({ ...saved, provider: 'anthropic' });
    const s = await invoke('settings:get');
    assert.equal(s.selfHosted, true);
    assert.equal(s.estimates.provider, 'anthropic');
    assert.equal(s.estimates.byInterval[45].daily.toFixed(2), '0.90');
    cfg = saved;
  });

  test('onb:setStep clamps to 1..5 and persists; onb:finish marks completion', () => {
    const state = require('../src/state');
    invoke('onb:setStep', 99);
    assert.equal(state.get().onboarding.step, 5);
    invoke('onb:setStep', 'x');
    assert.equal(state.get().onboarding.step, 1);
    invoke('onb:skipKey');
    assert.equal(state.get().onboarding.step, 4);
    invoke('onb:finish');
    assert.deepEqual(state.get().onboarding, { completed: true, step: 5 });
    assert.equal(JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')).onboarding.completed, true);
  });

  test('data:clearHistory honors a cancelled dialog', async () => {
    fs.writeFileSync(paths.VERDICT_LOG, '{"ts":1}\n');
    assert.deepEqual(await invoke('data:clearHistory'), { ok: false });
    assert.equal(fs.readFileSync(paths.VERDICT_LOG, 'utf8'), '{"ts":1}\n');
    electron.dialog.showMessageBox = async () => ({ response: 0 });
    assert.deepEqual(await invoke('data:clearHistory'), { ok: true });
    assert.equal(fs.readFileSync(paths.VERDICT_LOG, 'utf8'), '');
  });

  test('updates:check with no updater; the personal build has no update check at all', async t => {
    const channelMod = require('../src/channel');
    t.after(() => channelMod._setPersonalForTests(true));
    channelMod._setPersonalForTests(false);
    assert.deepEqual(await invoke('updates:check'), { checked: false });
    channelMod._setPersonalForTests(true);
    assert.deepEqual(await invoke('updates:check'), { checked: false, disabled: true }, 'a public release is pay-only');
  });

  test('engine "cli": a settings save keeps engine and cliPath, no key is not "key needed", the CLI is named, no plan is shown', async () => {
    const cli = path.join(dir, 'fake-claude-bin');
    fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 });
    const onDisk = () => JSON.parse(fs.readFileSync(paths.CONFIG_PATH, 'utf8'));
    configMod.writeConfig({ ...onDisk(), engine: 'cli', cliPath: cli, model: 'claude-haiku-4-5' });
    invoke('key:clear');

    // A dashboard save sends only form fields; the disk values must survive it.
    const r = await invoke('settings:save', { strikes: 3, checkIntervalSec: 60 });
    assert.equal(r.config.engine, 'cli');
    assert.equal(r.config.cliPath, cli);
    assert.equal(onDisk().engine, 'cli');
    assert.equal(onDisk().cliPath, cli);
    assert.equal(r.estimates.engine, 'cli');
    assert.equal(r.estimates.hosted, false);
    assert.equal(r.estimates.provider, 'claude-cli');
    assert.equal(r.estimates.providerLabel, 'Claude CLI');
    assert.equal(r.estimates.perCheck, 0);
    assert.equal(r.estimates.byInterval[45].daily, 0, 'no per-check charge on a subscription');
    assert.equal(r.estimates.byInterval[45].checks, Math.round(require('../src/pricing').checksPerDay(45)));

    const d = invoke('dash:get');
    assert.equal(d.live.needsKey, false, 'no API key is fine on the CLI engine');
    assert.equal(d.live.engine, 'cli');
    assert.equal(d.selfHosted, true, 'not on the hosted service: the plan panel stays hidden');
    assert.equal(d.hasKey, false);
    assert.equal(d.config.engine, 'cli');
    assert.equal(d.config.provider, 'claude-cli');
    assert.equal(d.config.providerLabel, 'Claude CLI');
    assert.equal(d.config.model, 'claude-haiku-4-5');
    const onb = await invoke('onb:getState');
    assert.equal(onb.engine, 'cli');
    assert.equal(onb.selfHosted, true);
    assert.equal((await invoke('settings:get')).selfHosted, true);

    // The UI cannot switch the engine or the binary.
    const r2 = await invoke('settings:save', { engine: 'api', cliPath: '/bin/sh', strikes: 2 });
    assert.equal(r2.config.engine, 'cli');
    assert.equal(r2.config.cliPath, cli);

    // cliAllowOverage is config.json only, and a UI save keeps it.
    configMod.writeConfig({ ...onDisk(), cliAllowOverage: true });
    const r3 = await invoke('settings:save', { cliAllowOverage: false, strikes: 3 });
    assert.equal(r3.config.cliAllowOverage, true);
    assert.equal(onDisk().cliAllowOverage, true);

    // A gpt-* model in config.json means nothing to the CLI: Haiku is named, and used.
    configMod.writeConfig({ ...onDisk(), model: 'gpt-5-mini' });
    const r4 = await invoke('settings:save', { strikes: 2 });
    assert.equal(r4.estimates.model, 'claude-haiku-4-5');

    // Back on the API engine with no key: the hosted service again (v2's default), no key needed.
    configMod.writeConfig({ ...onDisk(), engine: 'api', cliPath: '', model: 'claude-haiku-4-5' });
    const back = await invoke('settings:save', { strikes: 2 });
    assert.equal(back.config.engine, 'api');
    assert.equal(back.estimates.hosted, true);
    assert.equal(invoke('dash:get').live.needsKey, false);
    assert.equal(invoke('dash:get').selfHosted, false);
    // ...and self-hosted on anthropic with no key: key needed, as before.
    configMod.writeConfig({ ...onDisk(), provider: 'anthropic' });
    await invoke('settings:save', { strikes: 2 });
    assert.equal(invoke('dash:get').live.needsKey, true, 'self-hosted on the API engine, no key → needsKey');
    configMod.writeConfig({ ...onDisk(), provider: 'auto' });
    await invoke('settings:save', { strikes: 2 });
  });

  test('config.json broken on disk while the last good config (engine cli) is in use: a save builds on that', async () => {
    const cli = path.join(dir, 'fake-claude-bin');
    configMod.writeConfig({ ...configMod.coerce({}), engine: 'cli', cliPath: cli, checkIntervalSec: 90 });
    await invoke('settings:save', { strikes: 2 }); // in-memory config = the good file
    fs.writeFileSync(paths.CONFIG_PATH, '{ "engine": "cli", oops');
    const r = await invoke('settings:save', { strikes: 3 });
    assert.equal(r.config.engine, 'cli', 'defaults would move checks to the hosted service');
    assert.equal(r.config.cliPath, cli);
    assert.equal(r.config.checkIntervalSec, 90);
    assert.equal(r.config.strikes, 3);
    assert.equal(JSON.parse(fs.readFileSync(paths.CONFIG_PATH, 'utf8')).engine, 'cli');
  });

  test('config.json invalid at launch (in-memory config is defaults): settings:save refuses to write', async () => {
    const broken = '{ "engine": "cli", oops';
    fs.writeFileSync(paths.CONFIG_PATH, broken);
    const before = applied.length;
    cfg = { ...configMod.coerce({}), _invalid: true };
    const r = await invoke('settings:save', { strikes: 4 });
    assert.equal(r.config, undefined);
    assert.match(r.error, /JSON error/);
    assert.equal(fs.readFileSync(paths.CONFIG_PATH, 'utf8'), broken, 'the file is not replaced with defaults');
    assert.equal(applied.length, before, 'nothing applied');
    cfg = configMod.coerce({});
    configMod.writeConfig(cfg);
  });

  /* ---------------- editions and consent ---------------- */
  const channel = require('../src/channel');
  const secretsMod = require('../src/secrets');
  const { TCC_RESET_CMD } = require('../src/permissions');

  test('dash:get, settings:get and onb:getState carry the edition and the consent answer', async () => {
    channel._setForTests(null);
    const payloads = [invoke('dash:get'), await invoke('settings:get'), await invoke('onb:getState')];
    for (const p of payloads) {
      assert.equal(p.channel.name, 'direct');
      assert.equal(p.channel.isMAS, false);
      assert.equal(p.channel.personal, true);
      assert.equal(p.channel.features.updates, false, 'the personal build has no update check');
      assert.equal(p.channel.features.grayscaleBackend, 'colorFilters');
      assert.equal(p.channel.features.aiConsentRequired, true);
      assert.deepEqual(p.consent, { granted: false, at: null, version: null, processor: { name: 'OpenAI', via: 'the Grayout service' } });
    }
    assert.equal(payloads[1].tccResetCmd, TCC_RESET_CMD, 'the direct edition keeps the Terminal fix');
    assert.equal(payloads[2].tccResetCmd, TCC_RESET_CMD);
    assert.equal((await invoke('perm:get')).tccResetCmd, TCC_RESET_CMD);
  });

  test('Mac App Store: payloads say mas, no Terminal command, the hosted service even with a key or another provider', async t => {
    t.after(() => { channel._setForTests(null); invoke('key:clear'); cfg = configMod.coerce({}); });
    channel._setForTests(null);
    invoke('key:session', 'sk-ant-api03-held-in-memory');
    cfg = { ...configMod.coerce({}), provider: 'anthropic' };
    channel._setForTests('mas');
    const d = invoke('dash:get');
    const st = await invoke('settings:get');
    const onb = await invoke('onb:getState');
    for (const p of [d, st, onb]) {
      assert.equal(p.channel.name, 'mas');
      assert.equal(p.channel.isMAS, true);
      assert.equal(p.channel.features.updates, false);
      assert.equal(p.channel.features.grayscaleBackend, 'blend');
      assert.equal(p.selfHosted, false);
      assert.deepEqual(p.consent.processor, { name: 'OpenAI', via: 'the Grayout service' });
    }
    assert.equal(st.tccResetCmd, null);
    assert.equal(onb.tccResetCmd, null);
    assert.equal((await invoke('perm:get')).tccResetCmd, null);
    assert.equal(d.hasKey, false);
    assert.equal(d.keyMasked, '');
    assert.equal(d.config.provider, 'grayout');
    assert.equal(st.estimates.hosted, true);
    assert.equal(onb.engine, 'api');
  });

  test('Mac App Store: every key:* handler answers unavailable and touches nothing', async t => {
    t.after(() => channel._setForTests(null));
    channel._setForTests('mas');
    const reloads = calls.filter(c => c.name === 'reload').length;
    assert.deepEqual(await invoke('key:test', 'sk-ant-api03-x', 'AAAA'), { ok: false, kind: 'unavailable', message: ipc.KEY_UNAVAILABLE.message });
    assert.deepEqual(invoke('key:set', 'sk-ant-api03-x'), { ...ipc.KEY_UNAVAILABLE });
    assert.deepEqual(invoke('key:session', 'sk-ant-api03-x'), { ...ipc.KEY_UNAVAILABLE });
    assert.deepEqual(invoke('key:clear'), { ...ipc.KEY_UNAVAILABLE });
    assert.match(ipc.KEY_UNAVAILABLE.message, /not available in this version of Grayout/);
    assert.equal(secretsMod.getApiKey(), null);
    assert.equal(fs.existsSync(paths.SECRETS_PATH), false);
    assert.equal(calls.filter(c => c.name === 'reload').length, reloads, 'the loop is not reloaded');
  });

  test('public direct build: every key:* handler answers unavailable and touches nothing', async t => {
    t.after(() => { channel._setForTests(null); channel._setPersonalForTests(true); });
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    const reloads = calls.filter(c => c.name === 'reload').length;
    assert.deepEqual(await invoke('key:test', 'sk-ant-api03-x', 'AAAA'), { ok: false, kind: 'unavailable', message: ipc.KEY_UNAVAILABLE.message });
    assert.deepEqual(invoke('key:set', 'sk-ant-api03-x'), { ...ipc.KEY_UNAVAILABLE });
    assert.deepEqual(invoke('key:session', 'sk-ant-api03-x'), { ...ipc.KEY_UNAVAILABLE });
    assert.deepEqual(invoke('key:clear'), { ...ipc.KEY_UNAVAILABLE });
    assert.doesNotMatch(ipc.KEY_UNAVAILABLE.message, /App Store/, 'the wording fits the direct download too');
    assert.equal(secretsMod.getApiKey(), null);
    assert.equal(fs.existsSync(paths.SECRETS_PATH), false);
    assert.equal(calls.filter(c => c.name === 'reload').length, reloads, 'the loop is not reloaded');
  });

  test('public direct build: a 1.x key and provider, or engine "cli", land on the hosted plan in every payload', async t => {
    t.after(() => { channel._setForTests(null); channel._setPersonalForTests(true); invoke('key:clear'); cfg = configMod.coerce({}); });
    channel._setForTests(null);
    channel._setPersonalForTests(true);
    invoke('key:session', 'sk-ant-api03-held-in-memory');
    channel._setForTests('direct');
    channel._setPersonalForTests(false);
    for (const raw of [{ provider: 'anthropic' }, { engine: 'cli', cliPath: '/opt/homebrew/bin/claude' }]) {
      cfg = configMod.coerce(raw);
      const d = invoke('dash:get');
      const st = await invoke('settings:get');
      const onb = await invoke('onb:getState');
      for (const p of [d, st, onb]) {
        assert.equal(p.channel.name, 'direct');
        assert.equal(p.channel.personal, false);
        assert.equal(p.channel.features.selfHosting, false);
        assert.equal(p.channel.features.cliEngine, false);
        assert.equal(p.channel.features.updates, true, 'the rest of the direct edition is unchanged');
        assert.equal(p.selfHosted, false, JSON.stringify(raw));
        assert.deepEqual(p.consent.processor, { name: 'OpenAI', via: 'the Grayout service' });
      }
      assert.equal(d.hasKey, false);
      assert.equal(d.live.needsKey, false, 'never "API key needed"');
      assert.equal(d.config.provider, 'grayout');
      assert.equal(d.config.engine, 'api');
      assert.equal(st.estimates.hosted, true);
      assert.equal(onb.engine, 'api');
    }
  });

  test('Mac App Store: updates:check is disabled with no dialog and no request', async t => {
    const dialogs = [];
    const savedBox = electron.dialog.showMessageBox;
    electron.dialog.showMessageBox = async o => { dialogs.push(o); return { response: 1 }; };
    t.after(() => { channel._setForTests(null); electron.dialog.showMessageBox = savedBox; });
    channel._setForTests('mas');
    assert.deepEqual(await invoke('updates:check'), { checked: false, disabled: true });
    assert.equal(dialogs.length, 0);
  });

  test('Mac App Store: onb:moveToApplications returns false without calling app.moveToApplicationsFolder', async t => {
    let moved = 0;
    electron.app.moveToApplicationsFolder = () => { moved++; return true; };
    t.after(() => { channel._setForTests(null); delete electron.app.moveToApplicationsFolder; });
    channel._setForTests('mas');
    assert.equal(invoke('onb:moveToApplications'), false);
    assert.equal(moved, 0);
    channel._setForTests('direct');
    assert.equal(invoke('onb:moveToApplications'), true, 'the direct edition still moves itself');
    assert.equal(moved, 1);
  });

  test('the new channels are bridged: consent:grant, consent:revoke and data:erase have handlers', () => {
    for (const ch of ['consent:grant', 'consent:revoke', 'data:erase']) assert.equal(handlers.has(ch), true, ch);
  });
});

describe('activeProvider and estimates', () => {
  test('engine "cli" is named the same way everywhere; the API engine is unchanged', () => {
    assert.deepEqual(ipc.activeProvider(configMod.coerce({ engine: 'cli' }), null),
      { engine: 'cli', provider: 'claude-cli', providerLabel: 'Claude CLI', model: 'claude-haiku-4-5', hosted: false });
    assert.deepEqual(ipc.activeProvider(configMod.coerce({ engine: 'cli', provider: 'grayout' }), 'sk-ant-api03-x').provider, 'claude-cli', 'neither provider nor key matter');
    assert.deepEqual(ipc.activeProvider(configMod.coerce({}), null),
      { engine: 'api', provider: 'grayout', providerLabel: 'Grayout', model: 'grayout', hosted: true });
    assert.deepEqual(ipc.activeProvider(configMod.coerce({}), 'sk-proj-x'),
      { engine: 'api', provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5-mini', hosted: false });
    const e = ipc.estimates(configMod.coerce({}), null);
    assert.equal(e.byInterval[45].daily, null, 'hosted estimates unchanged');
    assert.equal(e.engine, 'api');
  });
});
