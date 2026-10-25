const { contextBridge, ipcRenderer } = require('electron');

const version = ipcRenderer.sendSync('app:version');
const packaged = ipcRenderer.sendSync('app:packaged');
const backendUrl = ipcRenderer.sendSync('app:backend-url');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
  version,
  packaged,
  backendUrl,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, maximized) => callback(Boolean(maximized));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
  openDir: (name = '') => ipcRenderer.invoke('shell:open-dir', name),
  openDataDir: () => ipcRenderer.invoke('shell:open-data-dir'),
  notify: (message) => ipcRenderer.invoke('app:notify', message),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
  },
});
