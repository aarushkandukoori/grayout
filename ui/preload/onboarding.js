'use strict';
// The welcome window's only door into the main process. There is no API key
// here any more: v2 sells a subscription and the service holds the model key.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('grayout', {
  // { step, completed, inApplications, screen, cameraStatus, account, plans,
  //   freeChecks, includedChecks, selfHosted, secureStorage, loginItem, config,
  //   estimates, version, isPackaged, grayscaleAvailable, tccResetCmd }
  getState: () => invoke('onb:getState'),
  setStep: n => invoke('onb:setStep', n),
  moveToApplications: () => invoke('onb:moveToApplications'),
  openScreenSettings: () => invoke('perm:openScreen'),
  openCameraSettings: () => invoke('perm:openCamera'),
  openLoginItems: () => invoke('perm:openLoginItems'),
  recheckScreen: () => invoke('perm:get'),
  relaunch: () => invoke('app:relaunch'),
  saveSetup: partial => invoke('settings:save', partial),
  requestCamera: () => invoke('perm:requestCamera'),
  previewGray: () => invoke('loop:previewGray'),
  finish: () => invoke('onb:finish'),
  // 100 checks on this Mac, no card, no account.
  startFree: () => invoke('onb:startFree'),

  // subscription — the same names the dashboard exposes
  accountStatus: opts => invoke('account:status', opts || null),      // { ok, plan, status, usage, hasLicense, licenseMasked, needsSubscription }
  startCheckout: plan => invoke('account:startCheckout', plan),        // { ok, url, deviceCode, plan, expiresIn, opened }
  pollClaim: deviceCode => invoke('account:pollClaim', deviceCode),    // resolves when checkout finishes, is cancelled, or times out
  cancelClaim: () => invoke('account:cancelClaim'),
  activateLicense: license => invoke('account:activate', license),
  openBillingPortal: () => invoke('account:portal'),

  openExternal: url => invoke('shell:openExternal', url),
  copyText: text => invoke('clipboard:copy', text)
});
