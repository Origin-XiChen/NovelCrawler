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
  /** 选本地可执行文件(隧道客户端);返回绝对路径,取消返回空串 */
  pickExe: () => ipcRenderer.invoke('dialog:pick-exe'),
  openDataDir: () => ipcRenderer.invoke('shell:open-data-dir'),
  notify: (message) => ipcRenderer.invoke('app:notify', message),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  updater: {
    setPrerelease: (flag) => ipcRenderer.invoke('updater:set-prerelease', flag),
    getPrerelease: () => ipcRenderer.invoke('updater:get-prerelease'),
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
