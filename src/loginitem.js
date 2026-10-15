'use strict';
// Start at login via SMAppService (Electron's mainAppService type) when the app
// lives in /Applications, with a LaunchAgent fallback for the cases where
// macOS refuses to register an ad-hoc-signed bundle.
//
// The Mac App Store edition has no fallback (channel.features().
// loginItemFallback is false): App Review 2.4.5(iii) and the App Sandbox both
// rule out writing ~/Library/LaunchAgents, and a store-signed app registers
// with SMAppService normally. There it is SMAppService and nothing else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const channel = require('./channel');

const LABEL = 'com.aarushkandukoori.grayout';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const fallback = () => channel.features().loginItemFallback;

function inApplications() {
  try { return app.isInApplicationsFolder(); } catch { return false; }
}

function readStatus() {
  try {
    const s = app.getLoginItemSettings({ type: 'mainAppService' });
    if (s.status) return s.status; // 'enabled' | 'requires-approval' | 'not-registered' | 'not-found'
    return s.openAtLogin ? 'enabled' : 'not-registered';
  } catch {
    return 'not-found';
  }
}

function runLaunchctl(args) {
  return new Promise(resolve => execFile('/bin/launchctl', args, { timeout: 10000 }, err => resolve(!err)));
}
// Tests swap this out: nothing under test may touch the real launchd domain.
let launchctl = runLaunchctl;
function _setLaunchctl(fn) { launchctl = typeof fn === 'function' ? fn : runLaunchctl; }

function plistXml(execPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${execPath}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

async function installLaunchAgent() {
  const execPath = app.getPath('exe');
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plistXml(execPath), { mode: 0o644 });
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  return launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
}

async function removeLaunchAgent() {
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
  try { fs.unlinkSync(PLIST_PATH); } catch {}
}

function launchAgentInstalled() {
  if (!fallback()) return false;
  return fs.existsSync(PLIST_PATH);
}

/** Returns { status, inApplications, launchAgent } */
async function setStartAtLogin(on) {
  if (!inApplications()) return { status: 'not-in-applications', inApplications: false, launchAgent: launchAgentInstalled() };
  try { app.setLoginItemSettings({ openAtLogin: !!on, type: 'mainAppService' }); } catch {}
  let status = readStatus();
  if (!fallback()) return { status, inApplications: true, launchAgent: false };
  if (on && (status === 'not-found' || status === 'not-registered')) {
    const ok = await installLaunchAgent();
    if (ok) status = 'enabled';
  } else if (!on) {
    await removeLaunchAgent();
  }
  return { status, inApplications: true, launchAgent: launchAgentInstalled() };
}

function getStatus() {
  const la = launchAgentInstalled();
  let status = inApplications() ? readStatus() : 'not-in-applications';
  if (la && (status === 'not-registered' || status === 'not-found')) status = 'enabled';
  return { status, inApplications: inApplications(), launchAgent: la };
}

module.exports = { setStartAtLogin, getStatus, inApplications, LABEL, PLIST_PATH, _setLaunchctl };
