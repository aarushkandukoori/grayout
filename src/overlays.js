'use strict';
// One transparent, click-through, always-on-top window per display that draws
// the flashing red border. Content-protected so it never appears in our own
// screenshots.
const { BrowserWindow, screen } = require('electron');
const paths = require('./paths');

let overlayWindows = [];
let current = false;

function webPrefs() {
  return { preload: paths.preload('overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function recreate() {
  for (const w of overlayWindows) { try { w.destroy(); } catch {} }
  overlayWindows = [];
  for (const display of screen.getAllDisplays()) {
    const win = new BrowserWindow({
      ...display.bounds,
      show: true, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, focusable: false,
      skipTaskbar: true, fullscreenable: false, roundedCorners: false,
      enableLargerThanScreen: true,
      webPreferences: webPrefs()
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    win.loadFile(paths.ui('overlay.html'));
    overlayWindows.push(win);
  }
  paint(current); // re-assert on the fresh windows
}

function paint(on) {
  current = !!on;
  for (const w of overlayWindows) {
    if (w.isDestroyed()) continue;
    const send = () => { try { w.webContents.send('mode', { alert: current }); } catch {} };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
    else send();
  }
}

function destroyAll() {
  for (const w of overlayWindows) { try { w.destroy(); } catch {} }
  overlayWindows = [];
}

module.exports = { recreate, paint, destroyAll };
