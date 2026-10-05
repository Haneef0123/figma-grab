'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tokenStatus: () => ipcRenderer.invoke('token:status'),
  saveToken: (t) => ipcRenderer.invoke('token:save', t),
  clearToken: () => ipcRenderer.invoke('token:clear'),
  start: (url, opts) => ipcRenderer.invoke('grab:start', url, opts),
  cancel: () => ipcRenderer.invoke('grab:cancel'),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('grab:progress', handler);
    return () => ipcRenderer.removeListener('grab:progress', handler);
  },
  openFigma: (url) => ipcRenderer.invoke('open:figma', url),
  openFolder: (dir) => ipcRenderer.invoke('open:folder', dir),
});
