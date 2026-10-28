'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dismeshClient', {
  getConfig: () => ipcRenderer.invoke('dismesh:get-config'),
  setServer: (url) => ipcRenderer.invoke('dismesh:set-server', url),
  forgetServer: () => ipcRenderer.invoke('dismesh:forget-server'),
  retryConnect: () => ipcRenderer.invoke('dismesh:retry-connect'),
  openExternal: (url) => ipcRenderer.invoke('dismesh:open-external', url),

  getAppSettings: () => ipcRenderer.invoke('dismesh:get-app-settings'),
  setAppSettings: (settings) => ipcRenderer.invoke('dismesh:set-app-settings', settings),
  pushNotification: (n) => ipcRenderer.send('dismesh:push-notification', n),
  setTrayLabels: (labels) => ipcRenderer.send('dismesh:set-tray-labels', labels),
  setTrayBadge: (badge) => ipcRenderer.send('dismesh:set-tray-badge', badge),
  onNavigateTo: (cb) => ipcRenderer.on('dismesh:navigate-to', (event, n) => cb(n)),
  onRequestLogout: (cb) => ipcRenderer.on('dismesh:request-logout', () => cb()),
});
