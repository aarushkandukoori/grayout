'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('grayout', {
  onRequestFrame: cb => ipcRenderer.on('request-frame', () => cb()),
  sendFrame: b64 => ipcRenderer.send('frame-response', typeof b64 === 'string' ? b64 : null),
  sendStatus: status => ipcRenderer.send('camera-status', String(status || ''))
});
