'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('grayout', {
  onMode: cb => ipcRenderer.on('mode', (_e, payload) => cb(payload || {}))
});
