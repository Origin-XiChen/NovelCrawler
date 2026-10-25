const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('./logger');

let getWindow = () => null;
let started = false;

function send(status) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status);
  }
}

function init(options) {
  getWindow = options.getWindow;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (...args) => log.info('[updater]', ...args),
    warn: (...args) => log.warn('[updater]', ...args),
    error: (...args) => log.error('[updater]', ...args),
    debug: (...args) => log.info('[updater]', ...args),
  };

  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    send({
      type: 'available',
      version: info.version,
      releaseName: info.releaseName || undefined,
      releaseNotes:
        typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : undefined,
    }),
  );
  autoUpdater.on('update-not-available', (info) =>
    send({ type: 'not-available', version: info.version }),
  );
  autoUpdater.on('download-progress', (progress) =>
    send({
      type: 'progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    send({ type: 'downloaded', version: info.version }),
  );
  autoUpdater.on('error', (error) => {
    log.error('[updater]', error);
    send({ type: 'error', message: error?.message || String(error) });
  });

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      send({ type: 'dev' });
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      send({ type: 'error', message: error?.message || String(error) });
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      send({ type: 'error', message: error?.message || String(error) });
    }
  });

  ipcMain.handle('updater:install', () => {
    if (!app.isPackaged) return;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });
}

function scheduleStartupCheck(delayMs = 8000) {
  if (started || !app.isPackaged) return;
  started = true;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => log.warn('[updater] 启动检查失败', error));
  }, delayMs);
}

module.exports = { init, scheduleStartupCheck };
