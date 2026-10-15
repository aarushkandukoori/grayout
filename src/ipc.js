'use strict';
// Every ipcMain handler lives here. Each payload is validated (type, length,
// enum) before it touches config, secrets, or the loop.
const { ipcMain, shell, clipboard, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const configMod = require('./config');
const secrets = require('./secrets');
const state = require('./state');
const stats = require('./stats');
const pricing = require('./pricing');
const permissions = require('./permissions');
const loginitem = require('./loginitem');
const { testApiKey, resolveEngine, UNAVAILABLE_KEY_MESSAGE } = require('./analyzer');
const providers = require('./providers');
const claudecli = require('./claudecli');
const log = require('./log');
const channel = require('./channel');
const consent = require('./consent');
const { MESSAGES: ACCOUNT_MESSAGES, LINK_URL } = require('./account');

const MANAGE_NOTE = ACCOUNT_MESSAGES.manageElsewhere;

// Pages a window may open in the browser. link.com is where Managed Payments
// buyers manage a purchase "Sold through Link". grayout.app is deliberately
// absent: nobody here owns it yet.
const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com', 'console.anthropic.com', 'aarushkandukoori.github.io', 'docs.anthropic.com', 'platform.claude.com', 'www.anthropic.com', 'platform.openai.com', 'openai.com', 'developers.openai.com', 'link.com', 'support.link.com']);
const INTERVAL_CHOICES = new Set([30, 45, 60, 90, 120]);
// Checkout and billing links come back from the network, so they are untrusted
// input: only Stripe's own hosted pages, or the service's own host, are opened.
const PAYMENT_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com', 'pay.stripe.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const PLANS_PAYLOAD = { plans: pricing.PLANS, freeChecks: pricing.FREE_CHECKS, includedChecks: pricing.INCLUDED_CHECKS };
const NO_ACCOUNT = { ok: false, kind: 'unknown', message: 'The Grayout service is not available in this build.' };
// What every key:* handler answers in a build without self-hosting (Mac App Store).
const KEY_UNAVAILABLE = Object.freeze({ ok: false, kind: 'unavailable', message: UNAVAILABLE_KEY_MESSAGE });

/** Which edition this is and what it may do; the windows hide what it cannot. */
function channelPayload() {
  return { name: channel.name(), isMAS: channel.isMAS(), features: { ...channel.features() } };
}

/**
 * "Erase this Mac's Grayout data": Grayout's own files in its data folder,
 * which is everything that says what this Mac did or who it is (check history,
 * the stats built from it, state with the device id and onboarding, settings,
 * and secrets.bin with the license key and device token), plus the logs.
 * Chromium's caches beside them are Electron's, not Grayout data, and are left.
 * Returns the names removed.
 */
function eraseLocalData() {
  const files = [
    paths.VERDICT_LOG, paths.VERDICT_LOG + '.tmp',
    paths.STATE_PATH, paths.STATE_PATH + '.tmp',
    paths.CONFIG_PATH, paths.CONFIG_PATH + '.tmp', paths.CONFIG_PATH + '.invalid',
    paths.SECRETS_PATH, paths.SECRETS_PATH + '.tmp', paths.SECRETS_PATH + '.unreadable'
  ];
  const removed = [];
  for (const f of files) {
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch {}
  }
  try {
    if (fs.existsSync(paths.LOG_DIR)) { fs.rmSync(paths.LOG_DIR, { recursive: true, force: true }); removed.push(path.basename(paths.LOG_DIR)); }
  } catch {}
  return removed;
}

function str(v, max = 500) { return typeof v === 'string' ? v.slice(0, max) : ''; }

/**
 * What every window prints about the plan. Only the masked key travels; the
 * key itself and the device token never leave the main process.
 */
function accountPayload(account) {
  const empty = {
    configured: false,
    plan: 'free', status: 'free', interval: null, service: null,
    cancelAtPeriodEnd: false, periodEnd: null, trialEnd: null,
    usage: { checksUsed: 0, checksIncluded: pricing.FREE_CHECKS, periodEnd: null, resetsAt: null },
    hasLicense: false, licenseMasked: '', problem: null, problemReason: null, needsSubscription: false,
    secretsLocked: false,
    manageNote: MANAGE_NOTE, linkUrl: LINK_URL
  };
  if (!account || !account.snapshot) return empty;
  try {
    const s = account.snapshot();
    return {
      configured: s.configured !== false,
      plan: s.plan, status: s.status, interval: s.interval || null, service: typeof s.service === 'boolean' ? s.service : null,
      cancelAtPeriodEnd: !!s.cancelAtPeriodEnd, periodEnd: s.periodEnd || null, trialEnd: s.trialEnd || null,
      usage: s.usage,
      hasLicense: s.hasLicense, licenseMasked: s.licenseMasked,
      problem: s.problem || null, problemReason: s.problemReason || null,
      needsSubscription: s.needsSubscription,
      secretsLocked: !!s.secretsLocked,
      manageNote: MANAGE_NOTE, linkUrl: LINK_URL
    };
  } catch { return empty; }
}

function openPaymentUrl(account, url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return false;
  let apiHost = null;
  try { apiHost = account && account.apiBase ? new URL(account.apiBase()).hostname : null; } catch { apiHost = null; }
  if (!PAYMENT_HOSTS.has(u.hostname) && u.hostname !== apiHost) return false;
  shell.openExternal(u.toString());
  return true;
}
/**
 * What the watch loop does after the plan was read again from the service
 * (at launch, when Settings opens, from the trial reminder):
 *   - a key came back (restored): it is a new plan, so reload the loop;
 *   - a FRESH answer (not the 10-minute cache) says the plan is served: a
 *     refusal the loop is still waiting out (a card fixed at link.com, for
 *     example) is over, so lift it and check again now.
 */
function afterAccountRefresh(loop, r) {
  if (!loop || !r) return;
  if (r.restored) { loop.reload(); return; }
  const freshlyServed = r.ok === true && r.cached === false && r.hasLicense === true && r.service === true;
  if (freshlyServed && typeof loop.clearPlanHold === 'function') loop.clearPlanHold();
}

function num(v, min, max, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt; }

/**
 * Who answers the checks: the Claude CLI (engine "cli"), or the provider
 * providers.resolve picks for the API engine (the hosted service or a
 * self-hosted model key).
 */
function activeProvider(cfg, key) {
  if (resolveEngine(cfg) === 'cli') {
    return { engine: 'cli', provider: 'claude-cli', providerLabel: 'Claude CLI', model: claudecli.cliModel(cfg), hosted: false };
  }
  const { provider, model } = providers.resolve(cfg, key === undefined ? secrets.getApiKey() : key);
  return { engine: 'api', provider, providerLabel: providers.label(provider), model, hosted: provider === providers.HOSTED };
}

/**
 * What each interval means. On the hosted plan the dollar figures are null —
 * the subscription is the price, and printing a model bill there would be a
 * number nobody pays. On the CLI engine they are 0: a Claude subscription has
 * no per-check charge (checks count toward its usage limits instead). The
 * check counts apply either way (they are an upper bound: change-gating
 * removes roughly half of them).
 */
function estimates(cfg, key) {
  const active = activeProvider(cfg, key);
  const { model, hosted } = active;
  const cli = active.engine === 'cli';
  const opts = { displays: 1, camera: !!cfg.camera, model };
  const out = {};
  for (const s of [30, 45, 60, 90, 120]) {
    const checks = Math.round(pricing.checksPerDay(s));
    out[s] = {
      daily: cli ? 0 : hosted ? null : pricing.estimateDaily(s, opts),
      monthly: cli ? 0 : hosted ? null : pricing.estimateMonthly(s, opts),
      checks,
      checksMonthly: checks * 22
    };
  }
  return {
    byInterval: out,
    perCheck: cli ? 0 : hosted ? null : pricing.perCheckUsd(opts),
    priceDate: pricing.PRICE_DATE,
    ...active
  };
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
 * ctx: { loop, account, getConfig, applyConfig(newCfg), windows, updater,
 *        grayscaleAvailable(), onCameraStatus(s), onOnboardingFinished(),
 *        onConsentGranted() (setup was done: start or resume watching),
 *        forceGrayscaleOff() (data:erase) }
 */
function registerIpc(ctx) {
  const { loop, getConfig, applyConfig, windows, updater } = ctx;
  const account = ctx.account || null;

  // Self-hosting is the escape hatch, not the product: true when checks do
  // not go through the hosted service (a model key, or the Claude CLI). A
  // model key is only ever needed on the first of those.
  const selfHosted = () => activeProvider(getConfig()).hosted === false;
  const selfHostingOff = () => !channel.features().selfHosting;
  const consentPayload = () => consent.payload(getConfig());
  const keyMissing = () => resolveEngine(getConfig()) === 'api' && !secrets.getApiKey();
  const liveWithExtras = () => {
    const l = loop.getLive();
    const self = selfHosted();
    return { ...l, selfHosted: self, engine: resolveEngine(getConfig()), needsKey: self && (l.needsKey || keyMissing()) };
  };

  ipcMain.handle('dash:get', (_e, day) => {
    const cfg = getConfig();
    const requested = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
    const active = activeProvider(cfg);
    return {
      stats: stats.summarize(requested, { intervalSec: cfg.checkIntervalSec, strikes: cfg.strikes }),
      live: liveWithExtras(),
      config: { checkIntervalSec: cfg.checkIntervalSec, strikes: cfg.strikes, engine: active.engine, model: active.model, provider: active.provider, providerLabel: active.providerLabel, camera: cfg.camera, grayscale: cfg.grayscale, redFlash: cfg.redFlash, historyDays: cfg.historyDays, disputeGraceMin: cfg.disputeGraceMin },
      version: app.getVersion(),
      account: accountPayload(account),
      ...PLANS_PAYLOAD,
      selfHosted: selfHosted(),
      hasKey: !!secrets.getApiKey(),
      keyMasked: secrets.maskKey(secrets.getApiKey()),
      update: updater ? updater.getAvailable() : null,
      dataDir: paths.USER_DATA,
      channel: channelPayload(),
      consent: consentPayload()
    };
  });

  ipcMain.handle('settings:get', async () => {
    const cfg = getConfig();
    // Settings opening is one of the two moments the contract says to look
    // again (6.6): re-read the plan, or collect a key a purchase left behind.
    // In the background, so the window never waits on the network; the
    // dashboard re-reads dash:get every few seconds and picks up the result.
    refreshAccountInBackground();
    return {
      config: cfg,
      account: accountPayload(account),
      ...PLANS_PAYLOAD,
      // The dashboard shows the self-hosted key affordance only on this path.
      selfHosted: selfHosted(),
      keyMasked: secrets.maskKey(secrets.getApiKey()),
      hasKey: !!secrets.getApiKey(),
      secureStorage: secrets.available(),
      loginItem: loginitem.getStatus(),
      estimates: estimates(cfg),
      permissions: { screen: await permissions.screenStatus({ fresh: false }), camera: permissions.cameraStatus() },
      paths: { userData: paths.USER_DATA, config: paths.CONFIG_PATH, verdicts: paths.VERDICT_LOG, helper: paths.HELPER_BIN },
      tccResetCmd: permissions.tccResetCmd(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      channel: channelPayload(),
      consent: consentPayload()
    };
  });

  ipcMain.handle('settings:save', async (_e, partial) => {
    // config.json did not parse at launch, so the settings in use are only
    // defaults: writing them over the file would lose engine, cliPath and the
    // rest. The dashboard shows the JSON error; fix the file first.
    if (getConfig()._invalid) {
      log.warn('settings', 'not saved: config.json has a JSON error');
      return { error: 'config.json has a JSON error. Fix it first, then save again.' };
    }
    const clean = sanitizeSettings(partial);
    let loginItem = loginitem.getStatus();
    if (clean.startAtLogin !== undefined) {
      loginItem = await loginitem.setStartAtLogin(clean.startAtLogin);
      if (loginItem.status === 'not-in-applications') clean.startAtLogin = false;
    }
    // engine, cliPath and cliAllowOverage are config.json only: sanitizeSettings
    // drops them, and the merge keeps what the file (or, if it no longer
    // parses, the config in use) says.
    const cfg = configMod.saveConfig(clean, getConfig());
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
    tccResetCmd: permissions.tccResetCmd()
  }));
  ipcMain.handle('perm:openScreen', () => permissions.openScreenSettings());
  ipcMain.handle('perm:openCamera', () => permissions.openCameraSettings());
  ipcMain.handle('perm:openLoginItems', () => permissions.openLoginItems());
  ipcMain.handle('perm:requestCamera', async () => {
    const ok = await permissions.requestCamera();
    return { granted: ok, status: permissions.cameraStatus() };
  });
  ipcMain.handle('perm:recheck', () => loop.recheckPermission());

  // No own model key in the Mac App Store edition: every key:* handler says
  // so before touching secrets or the network.
  ipcMain.handle('key:test', async (_e, key, frameB64) => {
    if (selfHostingOff()) return { ...KEY_UNAVAILABLE };
    const k = str(key, 400).trim();
    if (!k) return { ok: false, kind: 'no_key', message: 'Paste a key first.' };
    const frame = typeof frameB64 === 'string' && frameB64.length < 4_000_000 ? frameB64 : null;
    if (!frame) return { ok: false, kind: 'unknown', message: 'No test frame.' };
    const r = await testApiKey(k, frame, getConfig().model, getConfig().provider);
    log.info('key', `test: ${r.ok ? 'ok' : r.kind}`);
    return r;
  });
  ipcMain.handle('key:set', (_e, key) => {
    if (selfHostingOff()) return { ...KEY_UNAVAILABLE };
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
    if (selfHostingOff()) return { ...KEY_UNAVAILABLE };
    try { secrets.useSessionKey(str(key, 400)); loop.reload(); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('key:clear', () => {
    if (selfHostingOff()) return { ...KEY_UNAVAILABLE };
    secrets.clearApiKey(); loop.reload(); return { ok: true };
  });

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
  // Everything Grayout keeps about this Mac, gone, then a fresh start (App
  // Review 5.1.1(v)). The color comes back first, so a gray screen can never
  // outlive the data that made it.
  ipcMain.handle('data:erase', async () => {
    const r = await dialog.showMessageBox({
      type: 'warning', buttons: ['Erase and Restart', 'Cancel'], defaultId: 1, cancelId: 1,
      message: "Erase this Mac's Grayout data?",
      detail: "This deletes Grayout's check history, settings, saved license key and this Mac's device identity, then restarts Grayout as if it were new. " +
        'A subscription stays active: to use it here again, connect it with your license key. This cannot be undone.'
    });
    if (r.response !== 0) return { ok: false };
    log.info('data', "erasing this Mac's Grayout data, then restarting");
    try { loop.pause('erasing Grayout data'); } catch {}
    try { loop.restoreColor(); } catch {}
    try { if (ctx.forceGrayscaleOff) ctx.forceGrayscaleOff(); } catch {}
    const removed = eraseLocalData();
    // Nothing still in memory may write the old state or keys back.
    state._reset();
    secrets.forget();
    app.relaunch();
    app.exit(0);
    return { ok: true, removed };
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
    // Mac App Store: the store updates the app; no check, no dialog.
    if (!channel.features().updates) return { checked: false, disabled: true };
    if (!updater) return { checked: false };
    const r = await updater.check({ manual: true });
    if (r && r.disabled) return r;
    if (r.checked && !r.newer) {
      dialog.showMessageBox({ type: 'info', message: `You're on the latest version (${app.getVersion()}).`, buttons: ['OK'] });
    } else if (!r.checked) {
      dialog.showMessageBox({ type: 'info', message: 'Could not reach GitHub to check for updates.', buttons: ['OK'] });
    }
    return r;
  });

  /* ---------------- account (the hosted service) ----------------
     Every handler answers with a plain { ok, ... } object: the windows show
     what happened, and a failure here never changes what the screen looks
     like. Nothing about a plan can gray a Mac. */

  let refreshing = false;
  function refreshAccountInBackground() {
    if (!account || !account.refresh || selfHosted() || getConfig()._invalid || refreshing) return;
    refreshing = true;
    Promise.resolve()
      .then(() => account.refresh())
      .then(r => afterAccountRefresh(loop, r))
      .catch(() => {})
      .finally(() => { refreshing = false; });
  }

  ipcMain.handle('account:status', async (_e, opts) => {
    if (!account) return { ...NO_ACCOUNT, ...accountPayload(null) };
    const r = await account.status({ force: !!(opts && opts.force) });
    afterAccountRefresh(loop, r);
    return r;
  });

  ipcMain.handle('account:startCheckout', async (_e, plan) => {
    if (!account) return NO_ACCOUNT;
    const r = await account.startCheckout(plan === 'yearly' ? 'yearly' : 'monthly');
    if (r.kind === 'already_subscribed') {
      // This Mac already has working service: nothing was charged. Open the
      // billing page so the person can see or change what they have.
      if (r.restored) loop.reload();
      return { ...r, opened: r.portalUrl ? openPaymentUrl(account, r.portalUrl) : false };
    }
    if (!r.ok) { log.info('account', `checkout failed: ${r.kind}`); return r; }
    return { ...r, opened: openPaymentUrl(account, r.url) };
  });

  // Long-running by design: it resolves when the browser checkout finishes,
  // when account:cancelClaim is called, or when the device code expires (an hour).
  ipcMain.handle('account:pollClaim', async (_e, deviceCode) => {
    if (!account) return NO_ACCOUNT;
    const r = await account.pollClaim(str(deviceCode, 128).trim());
    if (r.ok) loop.reload();
    return r;
  });

  ipcMain.handle('account:cancelClaim', () => (account ? account.cancelClaim() : { ok: true, cancelled: false }));

  ipcMain.handle('account:activate', async (_e, license) => {
    if (!account) return NO_ACCOUNT;
    const r = await account.activate(str(license, 120).trim());
    if (r.ok) loop.reload();
    return r;
  });

  // "Restore my key": ask the service for the license it has on file for this Mac.
  ipcMain.handle('account:restore', async () => {
    if (!account) return NO_ACCOUNT;
    const r = await account.restore({ force: true });
    if (r.ok && r.restored) loop.reload();
    return r;
  });

  ipcMain.handle('account:portal', async () => {
    if (!account) return NO_ACCOUNT;
    const r = await account.portalUrl();
    if (!r.ok) return r;
    return { ...r, opened: openPaymentUrl(account, r.url) };
  });

  /* ---------------- onboarding ---------------- */

  ipcMain.handle('onb:getState', async () => {
    const cfg = getConfig();
    const st = state.get();
    return {
      step: st.onboarding.step || 1,
      completed: !!st.onboarding.completed,
      engine: resolveEngine(cfg),
      inApplications: loginitem.inApplications(),
      screen: await permissions.screenStatus({ fresh: false }),
      cameraStatus: permissions.cameraStatus(),
      account: accountPayload(account),
      ...PLANS_PAYLOAD,
      selfHosted: selfHosted(),
      secureStorage: secrets.available(),
      loginItem: loginitem.getStatus(),
      config: { workDescription: cfg.workDescription, checkIntervalSec: cfg.checkIntervalSec, camera: cfg.camera, startAtLogin: cfg.startAtLogin, model: cfg.model },
      estimates: estimates(cfg),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      grayscaleAvailable: ctx.grayscaleAvailable ? ctx.grayscaleAvailable() : true,
      tccResetCmd: permissions.tccResetCmd(),
      channel: channelPayload(),
      consent: consentPayload()
    };
  });
  ipcMain.handle('onb:setStep', (_e, n) => {
    state.update(s => { s.onboarding.step = num(n, 1, 5, 1); });
    return true;
  });
  ipcMain.handle('onb:moveToApplications', () => {
    // The store installs the app itself, and Electron's move can ask for an
    // admin password (2.4.5(v)): never in the Mac App Store edition.
    if (!channel.features().moveToApplications) return false;
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
  // "Try it free": no card, no account, 100 checks on this device.
  const startFree = () => { state.update(s => { s.onboarding.step = 4; }); return true; };
  ipcMain.handle('onb:startFree', startFree);
  ipcMain.handle('onb:skipKey', startFree); // v1 channel name, kept so an older window still works
  ipcMain.handle('onb:finish', () => {
    state.update(s => { s.onboarding.completed = true; s.onboarding.step = 5; });
    if (ctx.onOnboardingFinished) ctx.onOnboardingFinished();
    return true;
  });

  /* ---------------- consent (src/consent.js) ----------------
     Nothing is captured or sent until the person allows it, and the Settings
     switch takes it back. The loop checks consent itself on every tick too. */

  ipcMain.handle('consent:grant', () => {
    consent.grant();
    log.info('consent', 'screenshots for checks allowed');
    // An install that finished setup before consent existed (or withdrew it)
    // was shown only the permission card: close it and start watching.
    if (state.get().onboarding.completed) {
      try { if (windows && windows.closeOnboarding) windows.closeOnboarding(); } catch {}
      if (ctx.onConsentGranted) ctx.onConsentGranted();
      else loop.resume();
    }
    // Touching the capturer is what lists Grayout under Screen Recording in
    // System Settings and raises the prompt. It waits for this answer; the
    // Screen Recording step comes next.
    Promise.resolve().then(() => permissions.primeScreenPermission()).catch(() => {});
    return { ok: true, consent: consentPayload() };
  });

  ipcMain.handle('consent:revoke', async () => {
    consent.revoke();
    log.info('consent', 'screenshots for checks withdrawn');
    try { await loop.pause('consent withdrawn'); } catch {}
    return { ok: true, consent: consentPayload() };
  });

  // Camera renderer → main
  ipcMain.on('camera-status', (_e, status) => { if (ctx.onCameraStatus) ctx.onCameraStatus(String(status)); });
}

module.exports = {
  registerIpc, sanitizeSettings, accountPayload, openPaymentUrl, afterAccountRefresh, estimates, activeProvider,
  channelPayload, eraseLocalData, ALLOWED_HOSTS, PAYMENT_HOSTS, INTERVAL_CHOICES, MANAGE_NOTE, KEY_UNAVAILABLE
};
