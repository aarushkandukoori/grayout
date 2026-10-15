'use strict';
// Hidden renderer that owns the webcam. Frames are requested over IPC and
// returned as base64 JPEG; nothing touches the disk. Destroying the window
// releases the device and turns the camera light off.
const { BrowserWindow, ipcMain } = require('electron');
const paths = require('./paths');

let cameraWindow = null;
let cameraStatus = 'off';

function create() {
  if (cameraWindow && !cameraWindow.isDestroyed()) return;
  cameraWindow = new BrowserWindow({
    show: false, width: 660, height: 500,
    webPreferences: { preload: paths.preload('camera.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  cameraWindow.on('closed', () => { cameraWindow = null; cameraStatus = 'off'; });
  cameraWindow.loadFile(paths.ui('camera.html'));
}

function destroy() {
  if (!cameraWindow) return;
  try { cameraWindow.destroy(); } catch {}
  cameraWindow = null;
  cameraStatus = 'off';
}

/**
 * Should the webcam be open right now? Only while a check could use a frame:
 * the camera option is on, the person has allowed screenshots (src/consent.js)
 * and the loop is watching, meaning started and not paused for any reason
 * ('setup not finished' and the consent wait are pauses too).
 */
function shouldRun({ camera, consent, running, paused } = {}) {
  return camera === true && consent === true && running === true && paused === false;
}

/** Open or close the camera to match shouldRun. Idempotent: create() keeps an open window. */
function sync(conditions) {
  const want = shouldRun(conditions);
  if (want) create(); else destroy();
  return want;
}

function setStatus(status) { cameraStatus = status === 'ok' ? 'ok' : status; }
function getStatus() { return cameraStatus; }

function captureWebcam() {
  return new Promise(resolve => {
    if (!cameraWindow || cameraWindow.isDestroyed() || cameraStatus !== 'ok') return resolve(null);
    let settled = false;
    const done = v => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('frame-response', onFrame);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4000);
    function onFrame(_e, b64) { clearTimeout(timer); done(typeof b64 === 'string' && b64.length < 4_000_000 ? b64 : null); }
    ipcMain.on('frame-response', onFrame);
    try { cameraWindow.webContents.send('request-frame'); } catch { clearTimeout(timer); done(null); }
  });
}

module.exports = { create, destroy, shouldRun, sync, captureWebcam, setStatus, getStatus };
