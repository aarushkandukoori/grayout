'use strict';
// macOS permission status and deep links. Grayout needs Screen Recording
// (required) and Camera (optional). It never asks for Automation,
// Accessibility, or Full Disk Access.
const { systemPreferences, desktopCapturer, shell } = require('electron');

const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const CAMERA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';
const LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';
const TCC_RESET_CMD = 'tccutil reset ScreenCapture com.aarushkandukoori.grayout';

/**
 * Touch desktopCapturer once: this is what registers the app in
 * System Settings > Screen Recording and raises the prompt. Real captures go
 * through /usr/sbin/screencapture (see capture.js). Returns the source count.
 */
async function primeScreenPermission() {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return sources.length;
  } catch {
    return 0;
  }
}

let lastScreenStatus = null;

/**
 * 'granted' | 'denied' | 'not-determined' | 'restricted' | 'stale'
 * "stale" is the verified signature of an approval that macOS still reports as
 * granted while ScreenCaptureKit returns zero sources — typical after an update.
 * The desktopCapturer probe can take seconds (locked screen, sleeping display),
 * so callers that just need a quick answer pass { fresh: false } and get the
 * last probed value; the tray refresh and the onboarding poll probe for real.
 */
async function screenStatus({ fresh = true } = {}) {
  let status = 'not-determined';
  try { status = systemPreferences.getMediaAccessStatus('screen'); } catch {}
  if (status !== 'granted') { lastScreenStatus = status; return status; }
  if (!fresh && lastScreenStatus) return lastScreenStatus;
  const probe = primeScreenPermission();
  const timeout = new Promise(r => setTimeout(() => r(null), fresh ? 8000 : 1500));
  const n = await Promise.race([probe, timeout]);
  if (n === null) return lastScreenStatus || 'granted'; // probe still running: don't block the UI
  lastScreenStatus = n === 0 ? 'stale' : 'granted';
  return lastScreenStatus;
}

function screenStatusCached() { return lastScreenStatus; }

function cameraStatus() {
  try { return systemPreferences.getMediaAccessStatus('camera'); } catch { return 'not-determined'; }
}

async function requestCamera() {
  try { return await systemPreferences.askForMediaAccess('camera'); } catch { return false; }
}

const openScreenSettings = () => shell.openExternal(SCREEN_SETTINGS_URL);
const openCameraSettings = () => shell.openExternal(CAMERA_SETTINGS_URL);
const openLoginItems = () => shell.openExternal(LOGIN_ITEMS_URL);

module.exports = {
  primeScreenPermission, screenStatus, screenStatusCached, cameraStatus, requestCamera,
  openScreenSettings, openCameraSettings, openLoginItems,
  SCREEN_SETTINGS_URL, CAMERA_SETTINGS_URL, LOGIN_ITEMS_URL, TCC_RESET_CMD
};
