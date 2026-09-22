'use strict';
const fs = require('fs');
const { Tray, Menu, nativeImage, app, shell, clipboard } = require('electron');
const paths = require('./paths');
const permissions = require('./permissions');
const loginitem = require('./loginitem');
const secrets = require('./secrets');

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

function refresh(ctx) {
  if (!tray) return;
  const live = ctx.loop.getLive();
  const cfg = ctx.getConfig();
  const setup = !ctx.onboardingDone();
  // A model key is only ever needed when self-hosting; on the hosted plan the
  // credential is a license key and the tray talks about the subscription.
  const selfHosted = ctx.selfHosted ? ctx.selfHosted() : true;
  const needsKey = selfHosted && (live.needsKey || !secrets.getApiKey());
  const perm = ctx.permState();

  const icon = live.needsScreenPermission ? 'trayBlockedTemplate'
    : live.paused || setup ? 'trayPausedTemplate'
    : live.alerting ? 'trayAlertTemplate'
    : 'trayTemplate';
  tray.setImage(loadIcon(icon));

  // A bare icon in a crowded menu bar is impossible to find, and this app has
  // no window or dock icon — the title is the only proof it's running.
  tray.setTitle(
    setup ? ' setup'
      : live.needsScreenPermission ? ' ⚠ no screen access'
      : live.paused ? ' paused'
      : live.alerting ? ' OFF TASK'
      : ''
  );
  const tip = setup ? 'setup not finished'
    : live.needsScreenPermission ? 'blocked — no screen access'
    : live.paused ? (live.pausedUntil ? `paused until ${fmtTime(live.pausedUntil)}` : 'paused')
    : live.alerting ? 'off task' : 'watching';
  tray.setToolTip(`Grayout — ${tip}`);

  const spent = ctx.spentToday();
  const usageLine = !selfHosted && Number.isFinite(live.checksUsed) && Number.isFinite(live.checksIncluded)
    ? `${live.checksUsed.toLocaleString()} of ${live.checksIncluded.toLocaleString()} checks this period`
    : (spent.checks ? `Spent today: $${spent.cost.toFixed(2)} · ${spent.checks} checks` : live.lastLine);
  const secondLine = live.lastActivity
    ? `last check: ${live.lastActivity}${live.lastApp ? ` (${live.lastApp})` : ''}`
    : usageLine;

  const statusLabel = setup ? 'Setup not finished'
    : live.paused ? (live.pausedUntil ? `Paused until ${fmtTime(live.pausedUntil)}` : 'Paused')
    : live.alerting ? 'Off task' : 'Watching';

  const permissionItems = live.needsScreenPermission ? [
    { label: '⚠ Blocked: no Screen Recording access', enabled: false },
    { label: 'Open Screen Recording settings…', click: () => permissions.openScreenSettings() },
    { label: 'Recheck', click: () => ctx.loop.recheckPermission() },
    { type: 'separator' }
  ] : [];

  const keyItems = (!setup && needsKey) ? [
    { label: 'API key needed — open Settings…', click: () => ctx.windows.openDashboard('settings') },
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

  const update = ctx.updater ? ctx.updater.getAvailable() : null;
  const updateItem = update
    ? { label: `Update available: v${update.version} — Download`, click: () => shell.openExternal(update.url) }
    : { label: 'Check for updates', click: () => ctx.checkForUpdates() };

  const li = loginitem.getStatus();
  const liLabel = li.status === 'enabled' ? 'enabled' : li.status === 'requires-approval' ? 'needs approval' : li.status === 'not-in-applications' ? 'app not in Applications' : 'not registered';
  const screenLabel = perm.screen === 'granted' ? 'Allowed' : perm.screen === 'stale' ? 'Stale' : perm.screen === 'not-determined' ? 'Not asked yet' : 'Not allowed';
  const cameraLabel = perm.camera === 'granted' ? 'Allowed' : perm.camera === 'not-determined' ? 'Not asked yet' : 'Not allowed';

  // If the display cannot be grayed, say so once rather than letting the user
  // wonder why nothing happens.
  const grayNote = (cfg.grayscale && live.grayscaleUsable === false) ? [
    { label: 'Color Filters is in use — red border only', enabled: false },
    { label: 'Open Accessibility settings…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Seeing_Display') },
    { type: 'separator' }
  ] : [];

  const template = [
    ...permissionItems,
    ...grayNote,
    ...subscriptionItems,
    ...keyItems,
    ...setupItems,
    { label: statusLabel, enabled: false },
    { label: String(secondLine || '').slice(0, 60), enabled: false },
    { type: 'separator' },
    ...(live.alerting ? [{ label: "I'm working", click: () => ctx.loop.dispute() }] : []),
    live.paused
      ? { label: 'Resume', enabled: !setup, click: () => ctx.loop.resume() }
      : {
        label: 'Pause', enabled: !setup, submenu: [
          { label: 'For 15 minutes', click: () => ctx.loop.pauseFor(15 * 60000) },
          { label: 'For 1 hour', click: () => ctx.loop.pauseFor(60 * 60000) },
          { label: 'Until tomorrow', click: () => ctx.loop.pauseFor(minutesUntilTomorrow6() * 60000) },
          { label: 'Until I resume', click: () => ctx.loop.pause() }
        ]
      },
    { label: 'Check now', enabled: !live.paused && !setup, click: () => ctx.loop.checkNow() },
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
        { label: 'Captures look blank? Copy the fix command', click: () => clipboard.writeText(permissions.TCC_RESET_CMD) }
      ]
    },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => ctx.windows.openDashboard('settings') },
    ...(selfHosted ? [] : [{ label: 'Manage subscription…', click: () => (ctx.manageSubscription ? ctx.manageSubscription() : ctx.windows.openDashboard('account')) }]),
    { label: 'Restore color now', click: () => ctx.loop.restoreColor() },
    updateItem,
    {
      label: 'About Grayout', submenu: [
        { label: `Grayout ${app.getVersion()}`, enabled: false },
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/aarushkandukoori/grayout') },
        { label: 'Privacy', click: () => shell.openExternal('https://aarushkandukoori.github.io/grayout/privacy.html') },
        { label: 'Report a wrong call', click: () => shell.openExternal('https://github.com/aarushkandukoori/grayout/issues/new?template=wrong-call.yml') },
        ...(ctx.sponsorUrl ? [{ label: 'Sponsor', click: () => shell.openExternal(ctx.sponsorUrl) }] : [])
      ]
    },
    { type: 'separator' },
    { label: 'Quit Grayout', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

module.exports = { createTray };
