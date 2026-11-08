'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dismeshClient', {
  getConfig: () => ipcRenderer.invoke('dismesh:get-config'),
  setServer: (url) => ipcRenderer.invoke('dismesh:set-server', url),
  forgetServer: () => ipcRenderer.invoke('dismesh:forget-server'),
  retryConnect: () => ipcRenderer.invoke('dismesh:retry-connect'),
  getNetworkInterfaces: () => ipcRenderer.invoke('dismesh:get-network-interfaces'),
  openExternal: (url) => ipcRenderer.invoke('dismesh:open-external', url),

  getAppSettings: () => ipcRenderer.invoke('dismesh:get-app-settings'),
  setAppSettings: (settings) => ipcRenderer.invoke('dismesh:set-app-settings', settings),
  pushNotification: (n) => ipcRenderer.send('dismesh:push-notification', n),
  clearNotifications: (keys) => ipcRenderer.send('dismesh:clear-notifications', keys),
  setTrayLabels: (labels) => ipcRenderer.send('dismesh:set-tray-labels', labels),
  setTrayBadge: (badge) => ipcRenderer.send('dismesh:set-tray-badge', badge),
  selectDownloadDir: () => ipcRenderer.invoke('dismesh:select-download-dir'),
  showDownload: (id) => ipcRenderer.invoke('dismesh:show-download', id),
  openDownload: (id) => ipcRenderer.invoke('dismesh:open-download', id),
  cancelDownload: (id) => ipcRenderer.invoke('dismesh:cancel-download', id),
  openDownloadDir: () => ipcRenderer.invoke('dismesh:open-download-dir'),
  onDownloadEvent: (cb) => ipcRenderer.on('dismesh:download-event', (event, d) => cb(d)),
  onNavigateTo: (cb) => ipcRenderer.on('dismesh:navigate-to', (event, n) => cb(n)),
  onRequestLogout: (cb) => ipcRenderer.on('dismesh:request-logout', () => cb()),
});
