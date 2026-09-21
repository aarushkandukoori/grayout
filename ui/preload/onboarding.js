'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('grayout', {
  getState: () => invoke('onb:getState'),         // { step, completed, inApplications, screen, cameraStatus, hasKey, keyMasked, secureStorage, loginItem, config, estimates, version, isPackaged, grayscaleAvailable, tccResetCmd }
  setStep: n => invoke('onb:setStep', n),
  moveToApplications: () => invoke('onb:moveToApplications'),
  openScreenSettings: () => invoke('perm:openScreen'),
  openCameraSettings: () => invoke('perm:openCamera'),
  openLoginItems: () => invoke('perm:openLoginItems'),
  recheckScreen: () => invoke('perm:get'),
  relaunch: () => invoke('app:relaunch'),
  testApiKey: (key, frameB64) => invoke('key:test', key, frameB64),
  saveApiKey: key => invoke('key:set', key),
  useKeyForSession: key => invoke('key:session', key),
  saveSetup: partial => invoke('settings:save', partial),
  requestCamera: () => invoke('perm:requestCamera'),
  previewGray: () => invoke('loop:previewGray'),
  finish: () => invoke('onb:finish'),
  skipKey: () => invoke('onb:skipKey'),
  openExternal: url => invoke('shell:openExternal', url),
  copyText: text => invoke('clipboard:copy', text)
});
