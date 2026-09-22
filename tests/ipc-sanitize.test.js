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
      model: 'claude-opus-5', engine: 'cli', canvas: { token: 'x' }, tasksFile: '/etc/passwd',
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
    assert.deepEqual(Object.keys(r.config).sort(), ['camera', 'checkIntervalSec', 'disputeGraceMin', 'grayscale', 'historyDays', 'model', 'provider', 'providerLabel', 'redFlash', 'strikes']);
    assert.equal(r.config.provider, 'grayout', 'no model key → the hosted service');
    assert.equal(r.config.model, 'grayout');
    assert.equal(r.selfHosted, false);
    assert.equal(r.live.needsKey, false, 'the hosted path never asks for an API key');
    assert.deepEqual(Object.keys(r.account).sort(), ['hasLicense', 'licenseMasked', 'needsSubscription', 'plan', 'status', 'usage']);
    assert.equal(r.account.plan, 'free');
    assert.equal(r.account.hasLicense, false);
    assert.equal(r.freeChecks, 100);
    assert.equal(r.includedChecks, 15000);
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

  test('updates:check with no updater', async () => {
    assert.deepEqual(await invoke('updates:check'), { checked: false });
  });
});
