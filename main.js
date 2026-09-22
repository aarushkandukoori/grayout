'use strict';
// Grayout — lifecycle only. The watch loop lives in src/loop.js, the tray in
// src/tray.js, windows in src/windows.js, IPC in src/ipc.js.
const { app, screen, session, powerMonitor, nativeImage, Notification } = require('electron');
const fs = require('fs');

app.setName('Grayout');

const paths = require('./src/paths');
const log = require('./src/log');
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
const { registerIpc } = require('./src/ipc');

let config = null;
let loop = null;
let tray = null;
let updater = null;
let account = null;
let permState = { screen: 'not-determined', camera: 'not-determined' };
let configWatchTimer = null;

/* ---------------- helpers ---------------- */

function logVerdict(entry) {
  if (config && !config.logVerdicts && entry.type !== 'dispute') return;
  try { fs.appendFileSync(paths.VERDICT_LOG, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch {}
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  } catch {}
}

// True only when this Mac runs checks on its own model key instead of the
// hosted service. Self-hosting is documented in the README, never in the UI.
function selfHosted() {
  try { return !providers.isHosted(config, secrets.getApiKey()); } catch { return false; }
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
      windows.pushLive({ ...live, selfHosted: self, needsKey: self && (live.needsKey || !secrets.getApiKey()) });
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
        if (JSON.stringify(next) !== JSON.stringify(config)) {
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

function startWatching() {
  if (config.camera) camera.create();
  loop.start();
  // resume() clears the "setup not finished" pause, bumps the epoch and checks
  // immediately. Without it, finishing onboarding would arm the timer on a loop
  // that is still paused and nothing would ever be checked.
  setTimeout(() => loop.resume(), 3000);
  onStatus();
}

if (!app.requestSingleInstanceLock()) {
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
    if (!state.get().onboarding.completed) windows.openOnboarding();
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
    log.info('app', `Grayout ${app.getVersion()} starting (packaged=${app.isPackaged}, engine=${resolveEngine(config)}, provider=${providers.resolve(config, secrets.getApiKey()).provider})`);
    if (config._invalid) log.warn('config', 'config.json is invalid — running on defaults');

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
      // reached with a license key, or with nothing at all on the free taste.
      requiresKey: () => resolveEngine(config) === 'api' && selfHosted(),
      logVerdict,
      displays: () => screen.getAllDisplays().length,
      notify,
      onStatus
    });

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
        windows.closeOnboarding();
        refreshPermState().then(onStatus);
        startWatching();
      }
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

    // Re-validate the license on launch (docs/API-CONTRACT.md §/v1/activate).
    // Best effort and never blocking: a service that cannot be reached changes
    // nothing about what the screen looks like.
    if (!selfHosted()) {
      account.status({ force: true }).then(() => onStatus()).catch(() => {});
    }

    // Registers the app in System Settings > Screen Recording and raises the
    // prompt if it hasn't been approved yet. Must happen before the first tick.
    await permissions.primeScreenPermission();
    await refreshPermState();
    setInterval(() => refreshPermState().then(() => { if (tray) tray.refresh(); }), 60000).unref();

    if (!state.get().onboarding.completed) {
      loop.pause('setup not finished');
      windows.openOnboarding();
      onStatus();
      return;
    }
    startWatching();
  });
}
