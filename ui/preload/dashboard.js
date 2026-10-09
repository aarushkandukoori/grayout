'use strict';
// The dashboard/settings window's only door into the main process.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('grayout', {
  // data
  get: day => invoke('dash:get', day || null),            // { stats, live, config, version, account, plans, freeChecks, includedChecks, selfHosted, keyMasked, hasKey, update, dataDir }
  getSettings: () => invoke('settings:get'),               // { config, account, plans, freeChecks, includedChecks, selfHosted, keyMasked, hasKey, secureStorage, loginItem, estimates, permissions, paths, tccResetCmd, version, isPackaged }
  saveSettings: partial => invoke('settings:save', partial), // { config, loginItem, estimates }
  // loop control
  pause: () => invoke('loop:pause'),
  resume: () => invoke('loop:resume'),
  pauseFor: minutes => invoke('loop:pauseFor', minutes),
  checkNow: () => invoke('loop:checkNow'),
  dispute: ts => invoke('loop:dispute', ts || null),
  restoreColor: () => invoke('loop:restoreColor'),
  // permissions
  getPermissions: () => invoke('perm:get'),
  openScreenSettings: () => invoke('perm:openScreen'),
  openCameraSettings: () => invoke('perm:openCamera'),
  openLoginItems: () => invoke('perm:openLoginItems'),
  requestCamera: () => invoke('perm:requestCamera'),
  recheck: () => invoke('perm:recheck'),
  // subscription — the same names the welcome window exposes
  accountStatus: opts => invoke('account:status', opts || null),      // { ok, configured, status, interval, service, usage, hasLicense, licenseMasked, needsSubscription }
  startCheckout: plan => invoke('account:startCheckout', plan),        // { ok, url, deviceCode, plan, trial, expiresIn, reused, opened } or { ok:false, kind:'already_subscribed', portalUrl, restored, opened }
  pollClaim: deviceCode => invoke('account:pollClaim', deviceCode),    // resolves when checkout finishes, is cancelled, or the code expires
  cancelClaim: () => invoke('account:cancelClaim'),
  activateLicense: license => invoke('account:activate', license),
  restoreLicense: () => invoke('account:restore'),                     // { ok, restored } — the key the service has on file for this Mac
  openBillingPortal: () => invoke('account:portal'),                   // { ok, url, opened, manageNote }
  // self-hosted model key: shown only while settings.selfHosted is true
  setApiKey: key => invoke('key:set', key),
  testApiKey: (key, frameB64) => invoke('key:test', key, frameB64),
  clearApiKey: () => invoke('key:clear'),
  // data management
  clearHistory: () => invoke('data:clearHistory'),
  revealData: () => invoke('data:reveal'),
  openConfigFile: () => invoke('data:openConfig'),
  copyVerdictLine: ts => invoke('data:copyVerdict', ts),
  // misc
  openExternal: url => invoke('shell:openExternal', url),
  copyText: text => invoke('clipboard:copy', text),
  checkForUpdates: () => invoke('updates:check'),
  onLive: cb => ipcRenderer.on('live', (_e, live) => cb(live)),
  onNavigate: cb => ipcRenderer.on('navigate', (_e, section) => cb(section))
});
