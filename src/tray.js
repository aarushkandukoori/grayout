'use strict';
const fs = require('fs');
const { Tray, Menu, nativeImage, app, shell, clipboard } = require('electron');
const paths = require('./paths');
const permissions = require('./permissions');
const loginitem = require('./loginitem');
const secrets = require('./secrets');
const { safeReleaseUrl } = require('./updates');
const { resolveEngine } = require('./analyzer');
const channel = require('./channel');

let tray = null;
const icons = {};

function loadIcon(name) {
  if (icons[name]) return icons[name];
  const primary = paths.asset(`${name}.png`);
  const file = fs.existsSync(primary) ? primary : paths.asset('trayTemplate.png');
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true);
  icons[name] = img;
  return img;
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

function minutesUntilTomorrow6() {
  const now = new Date();
  const t = new Date(now);
  t.setDate(t.getDate() + 1); t.setHours(6, 0, 0, 0);
  return Math.max(60, Math.round((t - now) / 60000));
}

/**
 * The grayscale backend in use, for the one place the menu differs: the
 * Color Filters note. Matches the facade in src/grayscale.js (channel feature,
 * or GRAYOUT_GRAYSCALE_BACKEND when unpackaged).
 */
function grayscaleBackend(features) {
  let dev = null;
  try { dev = !app.isPackaged ? process.env.GRAYOUT_GRAYSCALE_BACKEND : null; } catch { dev = null; }
  if (dev === 'blend' || dev === 'colorFilters') return dev;
  return features.grayscaleBackend;
}

/**
 * ctx: { loop, getConfig, windows, updater, onboardingDone: () => bool,
 *        permState: () => {screen, camera}, spentToday: () => {cost, checks},
 *        selfHosted: () => bool, manageSubscription: () => void, sponsorUrl }
 */
function createTray(ctx) {
  tray = new Tray(loadIcon('trayTemplate'));
  tray.on('click', () => tray.popUpContextMenu());
  refresh(ctx);
  return { refresh: () => refresh(ctx), destroy: () => { try { tray.destroy(); } catch {} tray = null; } };
}

/**
 * Everything the menu shows, read from the app once per refresh. buildTemplate
 * and appearance only look at this, so the menu can be tested without a menu
 * bar. features is read here, at refresh time, never cached.
 */
function snapshot(ctx) {
  const live = ctx.loop.getLive();
  const cfg = ctx.getConfig();
  const features = channel.features();
  // A model key is only ever needed when self-hosting on the API engine; on the
  // hosted plan the credential is a license key and the tray talks about the
  // subscription, and the CLI engine uses the CLI's own login.
  const selfHosted = ctx.selfHosted ? ctx.selfHosted() : true;
  return {
    live,
    cfg,
    setup: !ctx.onboardingDone(),
    selfHosted,
    needsKey: selfHosted && (live.needsKey || (resolveEngine(cfg) === 'api' && !secrets.getApiKey())),
    perm: ctx.permState(),
    loginItem: loginitem.getStatus(),
    update: features.updates && ctx.updater ? ctx.updater.getAvailable() : null,
    spent: ctx.spentToday(),
    version: app.getVersion(),
    features,
    grayscaleBackend: grayscaleBackend(features),
    tccResetCmd: permissions.tccResetCmd(),
    sponsorUrl: features.sponsorLink ? (ctx.sponsorUrl || null) : null
  };
}

/** { icon, title, tooltip } for the menu bar item. */
function appearance(view) {
  const { live, setup } = view;
  const noConsent = !setup && !!live.needsConsent;
  const icon = live.needsScreenPermission ? 'trayBlockedTemplate'
    : live.paused || setup || noConsent ? 'trayPausedTemplate'
    : live.alerting ? 'trayAlertTemplate'
    : 'trayTemplate';

  // A bare icon in a crowded menu bar is impossible to find, and this app has
  // no window or dock icon — the title is the only proof it's running.
  const title = setup ? ' setup'
    : live.needsScreenPermission ? ' ⚠ no screen access'
    : live.paused || noConsent ? ' paused'
    : live.alerting ? ' OFF TASK'
    : '';
  const tip = setup ? 'setup not finished'
    : live.needsScreenPermission ? 'blocked — no screen access'
    : noConsent ? 'paused, sending screenshots is off'
    : live.paused ? (live.pausedUntil ? `paused until ${fmtTime(live.pausedUntil)}` : 'paused')
    : live.alerting ? 'off task' : 'watching';
  return { icon, title, tooltip: `Grayout — ${tip}` };
}

/** The context menu template for a snapshot. Pure apart from the click handlers. */
function buildTemplate(ctx, view) {
  const { live, cfg, setup, selfHosted, needsKey, perm, features } = view;
  const noConsent = !setup && !!live.needsConsent;

  const spent = view.spent || { cost: 0, checks: 0 };
  const usageLine = !selfHosted && Number.isFinite(live.checksUsed) && Number.isFinite(live.checksIncluded)
    ? `${live.checksUsed.toLocaleString()} of ${live.checksIncluded.toLocaleString()} checks this period`
    : (spent.checks ? `Spent today: $${spent.cost.toFixed(2)} · ${spent.checks} checks` : live.lastLine);
  const secondLine = live.lastActivity
    ? `last check: ${live.lastActivity}${live.lastApp ? ` (${live.lastApp})` : ''}`
    : usageLine;

  const statusLabel = setup ? 'Setup not finished'
    : noConsent ? 'Paused: sending screenshots is off'
    : live.paused ? (live.pausedUntil ? `Paused until ${fmtTime(live.pausedUntil)}` : 'Paused')
    : live.alerting ? 'Off task' : 'Watching';

  const permissionItems = live.needsScreenPermission ? [
    { label: '⚠ Blocked: no Screen Recording access', enabled: false },
    { label: 'Open Screen Recording settings…', click: () => permissions.openScreenSettings() },
    { label: 'Recheck', click: () => ctx.loop.recheckPermission() },
    { type: 'separator' }
  ] : [];

  // Nothing is captured or sent until the person allows it (src/consent.js).
  // The welcome window shows only the permission card when setup is done.
  const consentItems = noConsent ? [
    { label: 'Checks are off until you allow screenshots', enabled: false },
    { label: 'Allow screenshots for checks…', click: () => ctx.windows.openOnboarding() },
    { type: 'separator' }
  ] : [];

  // An invalid config.json at launch means engine is only the default: say that instead.
  const keyItems = (features.selfHosting && !setup && needsKey && !live.configInvalid) ? [
    { label: 'API key needed — open Settings…', click: () => ctx.windows.openDashboard('settings') },
    { type: 'separator' }
  ] : [];

  // How to log back in depends on the binary (a wrapper has its own way).
  const login = live.cliLogin || { command: 'claude auth login', text: 'run claude auth login in Terminal' };
  const cliItems = live.configInvalid ? [
    { label: 'config.json has a JSON error: checks paused', enabled: false },
    { type: 'separator' }
  ] : (features.cliEngine && !setup && live.errorKind === 'cli_auth') ? [
    { label: login.command ? `Claude CLI logged out: run ${login.command}` : 'Claude CLI logged out', enabled: false },
    ...(login.command ? [{ label: `Copy "${login.command}"`, click: () => clipboard.writeText(login.command) }] : []),
    { type: 'separator' }
  ] : (features.cliEngine && !setup && live.errorKind === 'cli_missing') ? [
    { label: 'Claude CLI not found: set cliPath in config.json', enabled: false },
    { type: 'separator' }
  ] : [];

  // A plan problem never grays the Mac; it says so here and offers the fix.
  const subscriptionItems = (!setup && live.needsSubscription) ? [
    { label: 'Subscription needs attention', enabled: false },
    { label: 'Manage subscription…', click: () => (ctx.manageSubscription ? ctx.manageSubscription() : ctx.windows.openDashboard('account')) },
    { type: 'separator' }
  ] : [];

  const setupItems = setup ? [
    { label: 'Finish setup…', click: () => ctx.windows.openOnboarding() },
    { type: 'separator' }
  ] : [];

  // No update item at all in the Mac App Store edition: the store updates it.
  const update = features.updates ? view.update : null;
  // update.url came from the network. safeReleaseUrl only lets an https page
  // of this repo's releases through, so the menu never opens anything else.
  const updateItems = !features.updates ? [] : [update
    ? { label: `Update available: v${update.version} — Download`, click: () => shell.openExternal(safeReleaseUrl(update.url)) }
    : { label: 'Check for updates', click: () => ctx.checkForUpdates() }];

  const li = view.loginItem || {};
  const liLabel = li.status === 'enabled' ? 'enabled' : li.status === 'requires-approval' ? 'needs approval' : li.status === 'not-in-applications' ? 'app not in Applications' : 'not registered';
  const screenLabel = perm.screen === 'granted' ? 'Allowed' : perm.screen === 'stale' ? 'Stale' : perm.screen === 'not-determined' ? 'Not asked yet' : 'Not allowed';
  const cameraLabel = perm.camera === 'granted' ? 'Allowed' : perm.camera === 'not-determined' ? 'Not asked yet' : 'Not allowed';

  // If the display cannot be grayed, say so once rather than letting the user
  // wonder why nothing happens. With the blend overlay (Mac App Store) the
  // system Color Filters switch plays no part: the overlay helper is missing
  // or keeps crashing, and only the red border is left.
  const grayNote = !(cfg.grayscale && live.grayscaleUsable === false) ? []
    : view.grayscaleBackend === 'blend' ? [
      { label: 'Grayscale unavailable, red border only', enabled: false },
      { type: 'separator' }
    ] : [
      { label: 'Color Filters is in use — red border only', enabled: false },
      { label: 'Open Accessibility settings…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Seeing_Display') },
      { type: 'separator' }
    ];

  return [
    ...permissionItems,
    ...consentItems,
    ...grayNote,
    ...subscriptionItems,
    ...keyItems,
    ...cliItems,
    ...setupItems,
    { label: statusLabel, enabled: false },
    { label: String(secondLine || '').slice(0, 60), enabled: false },
    { type: 'separator' },
    ...(live.alerting ? [{ label: "I'm working", click: () => ctx.loop.dispute() }] : []),
    live.paused
      ? { label: 'Resume', enabled: !setup && !noConsent, click: () => ctx.loop.resume() }
      : {
        label: 'Pause', enabled: !setup, submenu: [
          { label: 'For 15 minutes', click: () => ctx.loop.pauseFor(15 * 60000) },
          { label: 'For 1 hour', click: () => ctx.loop.pauseFor(60 * 60000) },
          { label: 'Until tomorrow', click: () => ctx.loop.pauseFor(minutesUntilTomorrow6() * 60000) },
          { label: 'Until I resume', click: () => ctx.loop.pause() }
        ]
      },
    { label: 'Check now', enabled: !live.paused && !setup && !noConsent, click: () => ctx.loop.checkNow() },
    { label: 'Open dashboard…', accelerator: 'CmdOrCtrl+D', click: () => ctx.windows.openDashboard() },
    { type: 'separator' },
    {
      label: 'Permissions', submenu: [
        { label: `Screen Recording: ${screenLabel}`, enabled: false },
        { label: 'Open Screen Recording settings…', click: () => permissions.openScreenSettings() },
        ...(cfg.camera ? [
          { label: `Camera: ${cameraLabel}`, enabled: false },
          { label: 'Open Camera settings…', click: () => permissions.openCameraSettings() }
        ] : []),
        { label: `Login item: ${liLabel}`, enabled: false },
        { label: 'Open Login Items settings…', click: () => permissions.openLoginItems() },
        { type: 'separator' },
        { label: 'Recheck', click: () => ctx.loop.recheckPermission() },
        ...(view.tccResetCmd ? [{ label: 'Captures look blank? Copy the fix command', click: () => clipboard.writeText(view.tccResetCmd) }] : [])
      ]
    },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => ctx.windows.openDashboard('settings') },
    ...(selfHosted ? [] : [{ label: 'Manage subscription…', click: () => (ctx.manageSubscription ? ctx.manageSubscription() : ctx.windows.openDashboard('account')) }]),
    { label: 'Restore color now', click: () => ctx.loop.restoreColor() },
    ...updateItems,
    {
      label: 'About Grayout', submenu: [
        { label: `Grayout ${view.version}`, enabled: false },
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/aarushkandukoori/grayout') },
        { label: 'Privacy', click: () => shell.openExternal('https://aarushkandukoori.github.io/grayout/privacy.html') },
        { label: 'Report a wrong call', click: () => shell.openExternal('https://github.com/aarushkandukoori/grayout/issues/new?template=wrong-call.yml') },
        ...(view.sponsorUrl ? [{ label: 'Sponsor', click: () => shell.openExternal(view.sponsorUrl) }] : [])
      ]
    },
    { type: 'separator' },
    { label: 'Quit Grayout', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
  ];
}

function refresh(ctx) {
  if (!tray) return;
  const view = snapshot(ctx);
  const look = appearance(view);
  tray.setImage(loadIcon(look.icon));
  tray.setTitle(look.title);
  tray.setToolTip(look.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(ctx, view)));
}

module.exports = { createTray, snapshot, appearance, buildTemplate, grayscaleBackend };
