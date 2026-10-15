'use strict';
// Grayout — lifecycle only. The watch loop lives in src/loop.js, the tray in
// src/tray.js, windows in src/windows.js, IPC in src/ipc.js.
const { app, screen, session, powerMonitor, nativeImage, Notification } = require('electron');
const fs = require('fs');

app.setName('Grayout');

const paths = require('./src/paths');
const log = require('./src/log');
const channel = require('./src/channel');
const consent = require('./src/consent');
const configMod = require('./src/config');
const secrets = require('./src/secrets');
const state = require('./src/state');
const stats = require('./src/stats');
const { captureScreens } = require('./src/capture');
const { getIdleSeconds } = require('./src/idle');
const { getFrontmostApp } = require('./src/frontmost');
const { gatherTasks } = require('./src/tasks');
const { analyze, resolveEngine } = require('./src/analyzer');
const providers = require('./src/providers');
const framehash = require('./src/framehash');
const { createAccount } = require('./src/account');
const grayscale = require('./src/grayscale');
const overlays = require('./src/overlays');
const camera = require('./src/camera');
const windows = require('./src/windows');
const permissions = require('./src/permissions');
const { createLoop } = require('./src/loop');
const { createTray } = require('./src/tray');
const { createUpdater } = require('./src/updates');
const { registerIpc, afterAccountRefresh } = require('./src/ipc');
const { createTrialReminder } = require('./src/trialreminder');

let config = null;
let loop = null;
let tray = null;
let updater = null;
let account = null;
let trialReminder = null;
let permState = { screen: 'not-determined', camera: 'not-determined' };
let configWatchTimer = null;
let configErrorNotified = false;

/* ---------------- helpers ---------------- */

function logVerdict(entry) {
  if (config && !config.logVerdicts && entry.type !== 'dispute') return;
  try { fs.appendFileSync(paths.VERDICT_LOG, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch {}
}

// `onClick` is optional: what to open when the person clicks the notification.
// The last notification is kept in a variable: if it were garbage-collected,
// its click handler would be lost with it.
let lastNotification = null;
function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (typeof onClick === 'function') n.on('click', onClick);
    n.show();
    lastNotification = n;
  } catch {}
}

// True when checks do not go through the hosted service: this Mac runs them
// on its own model key, or through the local Claude CLI (engine "cli"), where
// no plan and no key apply. Both are documented in the README, never in the UI.
// Never true in the Mac App Store edition (src/channel.js: no self-hosting,
// no CLI engine; providers.resolve and resolveEngine already say so).
function selfHosted() {
  try { return resolveEngine(config) === 'cli' || !providers.isHosted(config, secrets.getApiKey()); } catch { return false; }
}

// A missing model key matters only to a self-hosted API engine; the CLI uses
// its own login.
function keyMissing() {
  return resolveEngine(config) === 'api' && !secrets.getApiKey();
}

function spentToday() {
  try {
    const s = stats.summarize(undefined, { intervalSec: config.checkIntervalSec, strikes: config.strikes });
    return s.isToday ? { cost: s.costToday || 0, checks: s.checksToday || 0 } : { cost: 0, checks: 0 };
  } catch { return { cost: 0, checks: 0 }; }
}

let statusTimer = null;
function onStatus(live) {
  // Coalesce bursts: the loop reports status several times per tick.
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    try { if (tray) tray.refresh(); } catch (e) { log.error('tray', e.message); }
    try {
      const live = loop.getLive();
      const self = selfHosted();
      windows.pushLive({ ...live, selfHosted: self, engine: resolveEngine(config), needsKey: self && (live.needsKey || keyMissing()) });
    } catch {}
  }, 200);
}

async function refreshPermState() {
  try {
    permState = { screen: await permissions.screenStatus(), camera: permissions.cameraStatus() };
    // "stale" means macOS says granted while ScreenCaptureKit returns nothing;
    // the screencapture CLI usually still works, so we let those through and
    // let a real capture failure decide.
    if (loop) loop.setNeedsScreenPermission(permState.screen !== 'granted' && permState.screen !== 'stale');
  } catch {}
  return permState;
}

function loadConfigWithMigration() {
  return configMod.loadConfig({
    onCanvasToken: token => {
      if (secrets.available()) { secrets.setCanvasToken(token); log.info('config', 'moved Canvas token into secure storage'); }
      else throw new Error('secure storage unavailable');
    }
  });
}

function applyConfig(next) {
  config = next;
  if (config.camera) camera.create(); else camera.destroy();
  loop.reload();
  if (updater) { if (config.checkForUpdates) updater.start(); else updater.stop(); }
  onStatus();
}

function watchConfigFile() {
  try {
    fs.watchFile(paths.CONFIG_PATH, { interval: 2000 }, () => {
      clearTimeout(configWatchTimer);
      configWatchTimer = setTimeout(() => {
        const next = loadConfigWithMigration();
        const action = configMod.reloadAction(config, next);
        if (action === 'invalid') {
          // Keep the settings in use; say so once per broken stretch.
          if (!configErrorNotified) {
            configErrorNotified = true;
            log.warn('config', 'config.json has a JSON error — keeping the last good settings');
            notify('config.json has an error', 'Grayout keeps using the last good settings until the file is fixed.');
          }
          return;
        }
        configErrorNotified = false;
        if (action === 'apply') {
          log.info('config', 'config.json changed on disk — reloaded');
          applyConfig(next);
        }
      }, 500);
    });
  } catch {}
}

function pruneHistory() {
  try {
    const removed = stats.prune(config.historyDays);
    if (removed) log.info('history', `pruned ${removed} old verdict lines`);
    state.update(s => { s.lastPrune = Date.now(); });
  } catch {}
}

/* ---------------- display safety ---------------- */

// Restore the display on every exit path. Synchronous, because async work is
// not guaranteed to run during teardown. Registered only by the instance that
// owns the lock: grayscale is global CoreGraphics state, so a second copy
// shutting down would otherwise clear the running instance's consequence.
function hardResetDisplay() {
  try { overlays.paint(false); } catch {}
  grayscale.forceOffSync();
  paths.removeFramesDir();
}

/* ---------------- startup ---------------- */

// Shown while the loop waits for the person's permission to send screenshots.
const CONSENT_PAUSE_LINE = 'waiting for your permission to send screenshots';

// Setup is done but there is no valid permission to send screenshots: an
// install from before consent existed, a withdrawn permission, or a newer
// CONSENT_VERSION. The welcome window then shows only the permission card.
function waitForConsent() {
  loop.pause(CONSENT_PAUSE_LINE);
  windows.openOnboarding();
  onStatus();
}

function startWatching() {
  // Nothing is captured or sent before the person allows it (5.1.2(i)), in
  // both editions. The loop checks this on every tick as well.
  if (!consent.satisfied()) { waitForConsent(); return false; }
  if (config.camera) camera.create();
  loop.start();
  // resume() clears the "setup not finished" pause, bumps the epoch and checks
  // immediately. Without it, finishing onboarding would arm the timer on a loop
  // that is still paused and nothing would ever be checked.
  setTimeout(() => loop.resume(), 3000);
  onStatus();
  return true;
}

// Inside the App Sandbox, the first launch after a force-kill gets a stale
// false from requestSingleInstanceLock; asking again in the same process
// returns true (measured on a sandboxed build, 2 of 2). When another copy
// really is running, the second answer is false too.
let gotLock = app.requestSingleInstanceLock();
if (!gotLock && process.mas) gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another copy is already watching. Leave the display alone and exit without
  // registering any handler that could touch it.
  app.exit(0);
} else {
  app.on('before-quit', hardResetDisplay);
  app.on('will-quit', hardResetDisplay);
  process.on('exit', hardResetDisplay);
  process.on('SIGINT', () => { hardResetDisplay(); app.quit(); });
  process.on('SIGTERM', () => { hardResetDisplay(); app.quit(); });
  process.on('uncaughtException', err => {
    log.error('uncaught', String(err && err.stack || err));
    // Clear the consequence and the flag, so the app doesn't keep running with
    // a flashing overlay it thinks it already turned off.
    try { if (loop) loop.restoreColor(); } catch {}
    hardResetDisplay();
  });

  app.on('window-all-closed', () => {}); // tray app: never quit on window close

  // Launching the app again (or double-clicking it) should show the dashboard
  // rather than appearing to do nothing.
  app.on('second-instance', () => {
    if (!state.get().onboarding.completed || !consent.satisfied()) windows.openOnboarding();
    else windows.openDashboard();
  });

  app.whenReady().then(async () => {
    if (app.dock) app.dock.hide(); // menu-bar app, no dock icon, no windows

    paths.init();
    // Global state outlives a force-kill: never start gray.
    grayscale.forceOffSync();
    paths.cleanStaleFrameDirs();

    config = loadConfigWithMigration();
    state.get();
    const engine = resolveEngine(config);
    log.info('app', `Grayout ${app.getVersion()} starting (channel=${channel.name()}, packaged=${app.isPackaged}, engine=${engine}, provider=${engine === 'cli' ? 'claude-cli' : providers.resolve(config, secrets.getApiKey()).provider}, consent=${consent.satisfied() ? 'yes' : 'no'})`);
    if (config._invalid) log.warn('config', 'config.json is invalid — checks paused until it is fixed');

    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));

    account = createAccount({ getConfig: () => config });

    loop = createLoop({
      config: () => config,
      state,
      account,
      capture: n => captureScreens(nativeImage, n),
      // Perceptual hashes for change-gating. nativeImage is injected so
      // src/framehash.js stays loadable (and testable) under plain Node.
      hashFrames: images => framehash.hashFrames(nativeImage, images),
      analyze,
      getIdleSeconds,
      getFrontmostApp,
      gatherTasks,
      captureWebcam: () => camera.captureWebcam(),
      grayscale,
      overlays,
      secrets,
      // A model key is needed only when self-hosting; the hosted service is
      // reached with a license key, or with nothing at all on the free taste,
      // and the CLI engine with the CLI's own login.
      requiresKey: () => resolveEngine(config) === 'api' && selfHosted(),
      engine: () => resolveEngine(config),
      configInvalid: () => !!(config && config._invalid),
      // No capture and no request without the person's permission (src/consent.js).
      hasConsent: () => consent.satisfied(),
      logVerdict,
      displays: () => screen.getAllDisplays().length,
      notify,
      onStatus
    });

    // A stub that never touches the network in the Mac App Store edition
    // (src/updates.js): the store updates the app.
    updater = createUpdater({
      currentVersion: app.getVersion(),
      isEnabled: () => !!config.checkForUpdates,
      state,
      onAvailable: () => onStatus()
    });

    tray = createTray({
      loop,
      getConfig: () => config,
      windows,
      updater,
      selfHosted,
      manageSubscription: () => windows.openDashboard('account'),
      onboardingDone: () => !!state.get().onboarding.completed,
      permState: () => permState,
      spentToday,
      checkForUpdates: () => updater.check({ manual: true }),
      // No sponsor link (the tray also drops it where channel.features says so).
      sponsorUrl: null
    });

    registerIpc({
      loop,
      account,
      getConfig: () => config,
      applyConfig,
      windows,
      updater,
      grayscaleAvailable: () => grayscale.available(),
      onCameraStatus: s => camera.setStatus(s),
      onOnboardingFinished: () => {
        // The permission card comes first in the welcome window, so this is
        // normally granted. If not, startWatching keeps the window open on it.
        if (consent.satisfied()) windows.closeOnboarding();
        refreshPermState().then(onStatus);
        startWatching();
      },
      // Setup was already done and the person has just allowed screenshots
      // (from the permission card, or the Settings switch): start watching,
      // or pick up again if the loop was only paused.
      onConsentGranted: () => {
        refreshPermState().then(onStatus);
        if (loop.getLive().running) loop.resume();
        else startWatching();
      },
      forceGrayscaleOff: () => grayscale.forceOffSync()
    });

    overlays.recreate();
    const recreateOverlays = () => { overlays.recreate(); loop.applyAlertState(); };
    screen.on('display-added', recreateOverlays);
    screen.on('display-removed', recreateOverlays);
    screen.on('display-metrics-changed', recreateOverlays);

    powerMonitor.on('lock-screen', () => { if (config.pauseWhenLocked) loop.setLocked(true); });
    powerMonitor.on('unlock-screen', () => { if (config.pauseWhenLocked) loop.setLocked(false); });
    powerMonitor.on('suspend', () => loop.setLocked(true));
    powerMonitor.on('resume', () => loop.setLocked(false));
    powerMonitor.on('shutdown', hardResetDisplay);

    pruneHistory();
    setInterval(pruneHistory, 24 * 3600 * 1000).unref();
    watchConfigFile();
    if (config.checkForUpdates) updater.start();

    // On launch, re-read the plan, or collect a key that a purchase finished
    // after the app stopped waiting for it (docs/API-CONTRACT.md 6.6). Best
    // effort and never blocking: a service that cannot be reached changes
    // nothing about what the screen looks like. A build with no service
    // address makes no request at all.
    // A fresh answer that the plan is served also lifts a plan refusal the
    // loop may already be waiting out (afterAccountRefresh in src/ipc.js).
    // Not on the CLI engine (selfHosted), and not while config.json is
    // invalid: its defaults say "hosted" whatever the file meant.
    if (!selfHosted() && !config._invalid) {
      account.refresh({ force: true })
        .then(r => { afterAccountRefresh(loop, r); onStatus(); })
        .catch(() => {});
    }

    // Link sends no reminder before a 7-day trial turns into a charge, so the
    // app sends one itself, about two days before (src/trialreminder.js).
    trialReminder = createTrialReminder({
      account,
      state,
      notify: (title, body) => notify(title, body, () => windows.openDashboard('account')),
      onRefreshed: r => { afterAccountRefresh(loop, r); onStatus(); }
    });
    trialReminder.start();

    // Registers the app in System Settings > Screen Recording and raises the
    // prompt if it hasn't been approved yet. Must happen before the first tick.
    // Not before the person has allowed screenshots: on a first run the
    // consent card comes first, and consent:grant primes it (src/ipc.js).
    if (consent.satisfied()) await permissions.primeScreenPermission();
    await refreshPermState();
    setInterval(() => refreshPermState().then(() => { if (tray) tray.refresh(); }), 60000).unref();

    if (!state.get().onboarding.completed) {
      loop.pause('setup not finished');
      windows.openOnboarding();
      onStatus();
      return;
    }
    // Setup done but no valid permission: the welcome window shows only the
    // permission card, and nothing is watched until the person answers.
    startWatching();
  });
}
