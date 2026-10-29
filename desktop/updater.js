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

/** Dev 通道开关:落在 userData/updater.json,重启后仍然生效 */
function settingsFile() {
  return require('path').join(app.getPath('userData'), 'updater.json');
}

function readPrerelease() {
  try {
    return Boolean(JSON.parse(require('fs').readFileSync(settingsFile(), 'utf8')).allowPrerelease);
  } catch {
    return false;
  }
}

function writePrerelease(flag) {
  try {
    require('fs').writeFileSync(settingsFile(), JSON.stringify({ allowPrerelease: Boolean(flag) }), 'utf8');
  } catch (error) {
    log.warn('[updater] 保存 Dev 通道设置失败', error);
  }
}

/** 语义化比较:1.7.9-dev.2 < 1.7.9-dev.10 < 1.7.9（与手机端同一套规则） */
function compareVersion(a, b) {
  const split = (v) => {
    const text = String(v || '').replace(/^v/i, '');
    const [core, pre] = text.split('-');
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const dev = pre ? pre.replace(/^dev\.?/i, '') : '';
    return { nums, dev: dev ? Number.parseInt(dev, 10) || 0 : -1 };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (diff !== 0) return diff;
  }
  return left.dev - right.dev;
}


/** 切换是否接收预发布版本;立即作用于下一次检查 */
function setPrerelease(flag) {
  const value = Boolean(flag);
  autoUpdater.allowPrerelease = value;
  writePrerelease(value);
  send({ type: 'channel', prerelease: value });
  return value;
}

function init(options) {
  getWindow = options.getWindow;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = readPrerelease();
  autoUpdater.logger = {
    info: (...args) => log.info('[updater]', ...args),
    warn: (...args) => log.warn('[updater]', ...args),
    error: (...args) => log.error('[updater]', ...args),
    debug: (...args) => log.info('[updater]', ...args),
  };

  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    // 死循环防线:feed 里给的版本如果没有比当前版本更新(同号重发、或 prerelease
    // 通道读到同版本),直接判"已是最新",否则用户会陷入"装完还提示更新"的循环。
    const current = app.getVersion();
    if (info.version && compareVersion(info.version, current) <= 0) {
      log.warn('[updater] 忽略非更新的版本提示', { offered: info.version, current });
      send({ type: 'not-available', version: current });
      return;
    }
    send({
      type: 'available',
      version: info.version,
      releaseName: info.releaseName || undefined,
      releaseNotes:
        typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : undefined,
    });
  });
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

module.exports = { init, scheduleStartupCheck, setPrerelease, readPrerelease };
