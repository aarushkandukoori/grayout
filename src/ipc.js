'use strict';
// Every ipcMain handler lives here. Each payload is validated (type, length,
// enum) before it touches config, secrets, or the loop.
const { ipcMain, shell, clipboard, dialog, app } = require('electron');
const fs = require('fs');
const paths = require('./paths');
const configMod = require('./config');
const secrets = require('./secrets');
const state = require('./state');
const stats = require('./stats');
const pricing = require('./pricing');
const permissions = require('./permissions');
const loginitem = require('./loginitem');
const { testApiKey } = require('./analyzer');
const providers = require('./providers');
const log = require('./log');

const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com', 'console.anthropic.com', 'aarushkandukoori.github.io', 'docs.anthropic.com', 'platform.claude.com', 'www.anthropic.com', 'platform.openai.com', 'openai.com', 'developers.openai.com']);
const INTERVAL_CHOICES = new Set([30, 45, 60, 90, 120]);

function str(v, max = 500) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function num(v, min, max, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt; }

function estimates(cfg, key) {
  const { provider, model } = providers.resolve(cfg, key === undefined ? secrets.getApiKey() : key);
  const opts = { displays: 1, camera: !!cfg.camera, model };
  const out = {};
  for (const s of [30, 45, 60, 90, 120]) {
    out[s] = { daily: pricing.estimateDaily(s, opts), monthly: pricing.estimateMonthly(s, opts) };
  }
  return { byInterval: out, perCheck: pricing.perCheckUsd(opts), priceDate: pricing.PRICE_DATE, provider, providerLabel: providers.label(provider), model };
}

// Only the keys a user may change from the UI. Everything else is config.json (Advanced).
function sanitizeSettings(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (p.checkIntervalSec !== undefined) out.checkIntervalSec = num(p.checkIntervalSec, 10, 3600, 45);
  if (p.strikes !== undefined) out.strikes = num(p.strikes, 1, 20, 2);
  if (p.workDescription !== undefined) out.workDescription = str(p.workDescription, configMod.MAX_WORK_DESCRIPTION);
  for (const k of ['grayscale', 'redFlash', 'camera', 'startAtLogin', 'checkForUpdates', 'pauseWhenLocked', 'logVerdicts']) {
    if (typeof p[k] === 'boolean') out[k] = p[k];
  }
  for (const k of ['alwaysAllowedApps', 'neverCaptureApps']) {
    if (Array.isArray(p[k])) out[k] = p[k].filter(v => typeof v === 'string').map(v => v.trim().slice(0, 80)).filter(Boolean).slice(0, 100);
  }
  if (p.maxAlertMinutes !== undefined) out.maxAlertMinutes = num(p.maxAlertMinutes, 1, 240, 20);
  if (p.disputeGraceMin !== undefined) out.disputeGraceMin = num(p.disputeGraceMin, 1, 120, 10);
  if (p.dailyCheckCap !== undefined) out.dailyCheckCap = num(p.dailyCheckCap, 50, 20000, 1200);
  if (p.historyDays !== undefined) out.historyDays = num(p.historyDays, 1, 365, 30);
  return out;
}

/**
 * ctx: { loop, getConfig, applyConfig(newCfg), windows, updater, onboarding: {...} }
 */
function registerIpc(ctx) {
  const { loop, getConfig, applyConfig, windows, updater } = ctx;

  const liveWithExtras = () => { const l = loop.getLive(); return { ...l, needsKey: l.needsKey || !secrets.getApiKey() }; };

  ipcMain.handle('dash:get', (_e, day) => {
    const cfg = getConfig();
    const requested = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
    const active = providers.resolve(cfg, secrets.getApiKey());
    return {
      stats: stats.summarize(requested, { intervalSec: cfg.checkIntervalSec, strikes: cfg.strikes }),
      live: liveWithExtras(),
      config: { checkIntervalSec: cfg.checkIntervalSec, strikes: cfg.strikes, model: active.model, provider: active.provider, providerLabel: providers.label(active.provider), camera: cfg.camera, grayscale: cfg.grayscale, redFlash: cfg.redFlash, historyDays: cfg.historyDays, disputeGraceMin: cfg.disputeGraceMin },
      version: app.getVersion(),
      hasKey: !!secrets.getApiKey(),
      keyMasked: secrets.maskKey(secrets.getApiKey()),
      update: updater ? updater.getAvailable() : null,
      dataDir: paths.USER_DATA
    };
  });

  ipcMain.handle('settings:get', async () => {
    const cfg = getConfig();
    return {
      config: cfg,
      keyMasked: secrets.maskKey(secrets.getApiKey()),
      hasKey: !!secrets.getApiKey(),
      secureStorage: secrets.available(),
      loginItem: loginitem.getStatus(),
      estimates: estimates(cfg),
      permissions: { screen: await permissions.screenStatus({ fresh: false }), camera: permissions.cameraStatus() },
      paths: { userData: paths.USER_DATA, config: paths.CONFIG_PATH, verdicts: paths.VERDICT_LOG, helper: paths.HELPER_BIN },
      tccResetCmd: permissions.TCC_RESET_CMD,
      version: app.getVersion(),
      isPackaged: app.isPackaged
    };
  });

  ipcMain.handle('settings:save', async (_e, partial) => {
    const clean = sanitizeSettings(partial);
    let loginItem = loginitem.getStatus();
    if (clean.startAtLogin !== undefined) {
      loginItem = await loginitem.setStartAtLogin(clean.startAtLogin);
      if (loginItem.status === 'not-in-applications') clean.startAtLogin = false;
    }
    const cfg = configMod.saveConfig(clean);
    applyConfig(cfg);
    log.info('settings', `saved: ${Object.keys(clean).join(',')}`);
    return { config: cfg, loginItem, estimates: estimates(cfg) };
  });

  ipcMain.handle('loop:pause', () => loop.pause());
  ipcMain.handle('loop:resume', () => loop.resume());
  ipcMain.handle('loop:pauseFor', (_e, minutes) => loop.pauseFor(num(minutes, 1, 24 * 60, 15) * 60000));
  ipcMain.handle('loop:checkNow', () => loop.checkNow());
  ipcMain.handle('loop:dispute', (_e, ts) => loop.dispute(typeof ts === 'number' ? ts : null));
  ipcMain.handle('loop:restoreColor', () => loop.restoreColor());
  ipcMain.handle('loop:previewGray', () => loop.previewGray(3000));

  ipcMain.handle('perm:get', async () => ({
    screen: await permissions.screenStatus(),
    camera: permissions.cameraStatus(),
    loginItem: loginitem.getStatus(),
    tccResetCmd: permissions.TCC_RESET_CMD
  }));
  ipcMain.handle('perm:openScreen', () => permissions.openScreenSettings());
  ipcMain.handle('perm:openCamera', () => permissions.openCameraSettings());
  ipcMain.handle('perm:openLoginItems', () => permissions.openLoginItems());
  ipcMain.handle('perm:requestCamera', async () => {
    const ok = await permissions.requestCamera();
    return { granted: ok, status: permissions.cameraStatus() };
  });
  ipcMain.handle('perm:recheck', () => loop.recheckPermission());

  ipcMain.handle('key:test', async (_e, key, frameB64) => {
    const k = str(key, 400).trim();
    if (!k) return { ok: false, kind: 'no_key', message: 'Paste a key first.' };
    const frame = typeof frameB64 === 'string' && frameB64.length < 4_000_000 ? frameB64 : null;
    if (!frame) return { ok: false, kind: 'unknown', message: 'No test frame.' };
    const r = await testApiKey(k, frame, getConfig().model, getConfig().provider);
    log.info('key', `test: ${r.ok ? 'ok' : r.kind}`);
    return r;
  });
  ipcMain.handle('key:set', (_e, key) => {
    try {
      secrets.setApiKey(str(key, 400).trim());
      loop.reload();
      return { ok: true, secureStorage: true, keyMasked: secrets.maskKey(secrets.getApiKey()) };
    } catch (e) {
      const unavailable = e && e.name === 'SecretsUnavailable';
      log.warn('key', `save failed: ${unavailable ? 'secure storage unavailable' : e.message}`);
      return { ok: false, secureStorage: !unavailable, message: unavailable ? 'Secure storage is not available on this Mac.' : e.message };
    }
  });
  ipcMain.handle('key:session', (_e, key) => {
    try { secrets.useSessionKey(str(key, 400)); loop.reload(); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('key:clear', () => { secrets.clearApiKey(); loop.reload(); return { ok: true }; });

  ipcMain.handle('data:clearHistory', async e => {
    const r = await dialog.showMessageBox({
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Delete all check history?',
      detail: 'This empties verdicts.jsonl. The dashboard will start over. Nothing else is affected.'
    });
    if (r.response !== 0) return { ok: false };
    stats.clearHistory();
    return { ok: true };
  });
  ipcMain.handle('data:reveal', () => { shell.showItemInFolder(paths.VERDICT_LOG); return true; });
  ipcMain.handle('data:openConfig', () => {
    try { if (!fs.existsSync(paths.CONFIG_PATH)) configMod.writeConfig(getConfig()); } catch {}
    return shell.openPath(paths.CONFIG_PATH);
  });
  ipcMain.handle('data:copyVerdict', (_e, ts) => {
    const row = stats.readAll().find(r => r.ts === ts);
    if (!row) return false;
    clipboard.writeText(JSON.stringify({ ...row, app: row.app || null }));
    return true;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return false;
    shell.openExternal(u.toString());
    return true;
  });
  ipcMain.handle('clipboard:copy', (_e, text) => { clipboard.writeText(str(text, 2000)); return true; });
  ipcMain.handle('updates:check', async () => {
    if (!updater) return { checked: false };
    const r = await updater.check({ manual: true });
    if (r.checked && !r.newer) {
      dialog.showMessageBox({ type: 'info', message: `You're on the latest version (${app.getVersion()}).`, buttons: ['OK'] });
    } else if (!r.checked) {
      dialog.showMessageBox({ type: 'info', message: 'Could not reach GitHub to check for updates.', buttons: ['OK'] });
    }
    return r;
  });

  /* ---------------- onboarding ---------------- */

  ipcMain.handle('onb:getState', async () => {
    const cfg = getConfig();
    const st = state.get();
    return {
      step: st.onboarding.step || 1,
      completed: !!st.onboarding.completed,
      inApplications: loginitem.inApplications(),
      screen: await permissions.screenStatus({ fresh: false }),
      cameraStatus: permissions.cameraStatus(),
      hasKey: !!secrets.getApiKey(),
      keyMasked: secrets.maskKey(secrets.getApiKey()),
      secureStorage: secrets.available(),
      loginItem: loginitem.getStatus(),
      config: { workDescription: cfg.workDescription, checkIntervalSec: cfg.checkIntervalSec, camera: cfg.camera, startAtLogin: cfg.startAtLogin, model: cfg.model },
      estimates: estimates(cfg),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      grayscaleAvailable: ctx.grayscaleAvailable ? ctx.grayscaleAvailable() : true,
      tccResetCmd: permissions.TCC_RESET_CMD
    };
  });
  ipcMain.handle('onb:setStep', (_e, n) => {
    state.update(s => { s.onboarding.step = num(n, 1, 5, 1); });
    return true;
  });
  ipcMain.handle('onb:moveToApplications', () => {
    try {
      state.update(s => { s.onboarding.step = 1; });
      return app.moveToApplicationsFolder({ conflictHandler: () => true });
    } catch (e) { return false; }
  });
  ipcMain.handle('app:relaunch', () => {
    state.update(s => { if (s.onboarding.step < 3) s.onboarding.step = 3; });
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('onb:skipKey', () => { state.update(s => { s.onboarding.step = 4; }); return true; });
  ipcMain.handle('onb:finish', () => {
    state.update(s => { s.onboarding.completed = true; s.onboarding.step = 5; });
    if (ctx.onOnboardingFinished) ctx.onOnboardingFinished();
    return true;
  });

  // Camera renderer → main
  ipcMain.on('camera-status', (_e, status) => { if (ctx.onCameraStatus) ctx.onCameraStatus(String(status)); });
}

module.exports = { registerIpc, sanitizeSettings, ALLOWED_HOSTS, INTERVAL_CHOICES };
