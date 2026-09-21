'use strict';
// Start at login via SMAppService (Electron's mainAppService type) when the app
// lives in /Applications, with a LaunchAgent fallback for the cases where
// macOS refuses to register an ad-hoc-signed bundle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');

const LABEL = 'com.aarushkandukoori.grayout';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

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

function launchctl(args) {
  return new Promise(resolve => execFile('/bin/launchctl', args, { timeout: 10000 }, err => resolve(!err)));
}

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
  return fs.existsSync(PLIST_PATH);
}

/** Returns { status, inApplications, launchAgent } */
async function setStartAtLogin(on) {
  if (!inApplications()) return { status: 'not-in-applications', inApplications: false, launchAgent: launchAgentInstalled() };
  try { app.setLoginItemSettings({ openAtLogin: !!on, type: 'mainAppService' }); } catch {}
  let status = readStatus();
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

module.exports = { setStartAtLogin, getStatus, inApplications, LABEL, PLIST_PATH };
