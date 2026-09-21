'use strict';
// Dashboard and onboarding window factories. The app runs dock-hidden
// (LSUIElement), so the dock icon is shown while a window is open and hidden
// again when the last one closes — otherwise the window never comes forward.
//
// There is deliberately NO app.on('activate') handler anywhere: it fires
// whenever macOS brings the app forward and would yank the user out of their
// work. Windows open only on explicit request.
const { BrowserWindow, screen, app } = require('electron');
const paths = require('./paths');

let dashboardWindow = null;
let onboardingWindow = null;

function openWindows() {
  return [dashboardWindow, onboardingWindow].filter(w => w && !w.isDestroyed()).length;
}

function dockShow() { if (app.dock) app.dock.show(); }
function dockHideIfIdle() { if (app.dock && openWindows() === 0) app.dock.hide(); }

function prefs(preloadName) {
  return { preload: paths.preload(preloadName), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function workAreaUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}

function openDashboard(section) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    if (section) dashboardWindow.webContents.send('navigate', section);
    return dashboardWindow;
  }
  dockShow();

  // Size to the actual work area. A fixed height taller than the screen leaves
  // the bottom of the window hanging off the bottom edge with no way to reach it.
  const wa = workAreaUnderCursor();
  const width = Math.min(940, wa.width - 40);
  const height = Math.min(880, wa.height - 40);

  dashboardWindow = new BrowserWindow({
    width, height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: 560, minHeight: 400,
    maxHeight: wa.height,
    show: false,
    title: 'Grayout',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f7f9',
    webPreferences: prefs('dashboard.js')
  });
  // Deliberately NOT content-protected, unlike the alert overlay: you should be
  // able to screenshot your own stats. The analyzer prompt tells the model to
  // ignore this app's own windows.
  dashboardWindow.loadFile(paths.ui('dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = null; dockHideIfIdle(); });
  dashboardWindow.once('ready-to-show', () => {
    dashboardWindow.show();
    if (section) dashboardWindow.webContents.send('navigate', section);
    app.focus({ steal: true });
  });
  return dashboardWindow;
}

function openOnboarding() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return onboardingWindow;
  }
  dockShow();
  const wa = workAreaUnderCursor();
  const width = Math.min(560, wa.width - 40);
  const height = Math.min(700, wa.height - 40);
  onboardingWindow = new BrowserWindow({
    width, height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    resizable: false, minimizable: true, maximizable: false, fullscreenable: false,
    show: false,
    title: 'Welcome to Grayout',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f7f9',
    webPreferences: prefs('onboarding.js')
  });
  onboardingWindow.loadFile(paths.ui('onboarding.html'));
  onboardingWindow.on('closed', () => { onboardingWindow = null; dockHideIfIdle(); });
  onboardingWindow.once('ready-to-show', () => {
    onboardingWindow.show();
    app.focus({ steal: true });
  });
  return onboardingWindow;
}

function closeOnboarding() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
}

function pushLive(live) {
  for (const w of [dashboardWindow, onboardingWindow]) {
    if (w && !w.isDestroyed()) { try { w.webContents.send('live', live); } catch {} }
  }
}

module.exports = { openDashboard, openOnboarding, closeOnboarding, pushLive };
