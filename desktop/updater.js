const { app, ipcMain } = require('electron');
const log = require('./logger');
const updates = require('./updates');

/**
 * 桌面端更新：检查 → 应用内下载（自建下载器，进度只增不减）→ 调系统安装器。
 *
 * 曾经用过 electron-updater 的 downloadUpdate + quitAndInstall，真机上是这样坏的：
 *   · 分段/差分下载遇到重试，`download-progress` 会从 0 重新报一遍 → 界面「下满又归零」
 *   · `quitAndInstall` 在安装器被取消或文件被占用时静默失败 → 重启还是旧版本
 * 现在检查与下载都自己实现（见 `updates.js`），下载完用系统 NSIS 向导安装。
 */

let getWindow = () => null;
let started = false;
// 当前候选版本（check 得到，download 使用）
let pending = null;
// 已下好、等待安装的安装包路径
let installer = '';
// 同一时刻只允许一个下载任务
let downloadPromise = null;

// 启动时不自动检查：更新完全由用户手动触发
const AUTO_CHECK = false;

function send(status) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status);
  }
}

/** Dev 通道开关与安装状态：落在 userData/updater.json，重启后仍生效 */
function settingsFile() {
  return require('path').join(app.getPath('userData'), 'updater.json');
}

function readSettings() {
  try {
    const data = JSON.parse(require('fs').readFileSync(settingsFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** 合并写入：只覆盖传入字段，别把 allowPrerelease 冲掉 */
function writeSettings(patch) {
  try {
    require('fs').writeFileSync(
      settingsFile(),
      JSON.stringify({ ...readSettings(), ...patch }),
      'utf8',
    );
  } catch (error) {
    log.warn('[updater] 保存更新设置失败', error);
  }
}

function readPrerelease() {
  return Boolean(readSettings().allowPrerelease);
}

/** 切换是否接收预发布版本；立即作用于下一次检查 */
function setPrerelease(flag) {
  const value = Boolean(flag);
  writeSettings({ allowPrerelease: value });
  send({ type: 'channel', prerelease: value });
  return value;
}

/** 上次安装没生效的版本号（装完版本没变时，避免反复提示同一个包） */
function takeFailedInstall() {
  const attempted = String(readSettings().installAttempted || '');
  if (!attempted) return '';
  // 已经升上去了就把标记清掉，别让它永久拦着
  if (updates.compareVersion(app.getVersion(), attempted) >= 0) {
    writeSettings({ installAttempted: '' });
    return '';
  }
  return attempted;
}

async function check() {
  if (!app.isPackaged) {
    send({ type: 'dev' });
    return;
  }
  send({ type: 'checking' });
  try {
    const found = await updates.checkUpdate(readPrerelease());
    if (!found) {
      pending = null;
      send({ type: 'not-available', version: app.getVersion() });
      return;
    }
    const failed = takeFailedInstall();
    if (failed && updates.compareVersion(found.version, failed) === 0) {
      log.warn('[updater] 上次安装未生效', { offered: found.version, current: app.getVersion() });
      send({
        type: 'error',
        message: `上次安装 v${found.version} 没有生效（安装可能被取消），请重新下载安装或到发布页手动安装`,
      });
      return;
    }
    pending = found;
    installer = '';
    send({
      type: 'available',
      version: found.version,
      releaseName: `v${found.version}`,
      releaseNotes: found.notes || undefined,
      size: found.size || undefined,
    });
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) });
  }
}

function download() {
  if (!app.isPackaged) return Promise.resolve();
  if (!pending) {
    send({ type: 'error', message: '请先检查更新' });
    return Promise.resolve();
  }
  if (downloadPromise) return downloadPromise;

  let lastEmit = 0;
  downloadPromise = (async () => {
    try {
      const file = await updates.download(pending, (progress) => {
        // 200ms 节流，避免 IPC 刷爆渲染进程
        const now = Date.now();
        if (progress.percent < 100 && now - lastEmit < 200) return;
        lastEmit = now;
        send({
          type: 'progress',
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        });
      });
      installer = file;
      send({ type: 'downloaded', version: pending.version });
    } catch (error) {
      log.error('[updater] 下载失败', error);
      send({ type: 'error', message: error?.message || String(error) });
    } finally {
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}

/** 调系统安装器：先记下"这次装哪个版本"，再拉起安装包并退出应用 */
function install() {
  if (!app.isPackaged) return false;
  if (!installer) {
    send({ type: 'error', message: '安装包还没下载好' });
    return false;
  }
  try {
    if (pending?.version) writeSettings({ installAttempted: pending.version });
    updates.install(installer);
    return true;
  } catch (error) {
    send({ type: 'error', message: error?.message || String(error) });
    return false;
  }
}

function init(options) {
  getWindow = options.getWindow;
  if (started) return;
  started = true;

  ipcMain.handle('updater:set-prerelease', (_event, flag) => setPrerelease(flag));
  ipcMain.handle('updater:get-prerelease', () => readPrerelease());
  ipcMain.handle('updater:check', () => check());
  ipcMain.handle('updater:download', () => download());
  ipcMain.handle('updater:install', () => install());
}

/** 保留调用点：启动自动检查已关闭（用户要求手动更新） */
function scheduleStartupCheck() {
  if (!AUTO_CHECK) return;
}

module.exports = { init, scheduleStartupCheck, setPrerelease, readPrerelease };
