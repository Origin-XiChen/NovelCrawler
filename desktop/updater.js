const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('./logger');

let getWindow = () => null;
let started = false;
// 当前已下载/待安装的版本,用于记录"这次安装装的是哪个版本"
let pendingVersion = '';

function send(status) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status);
  }
}

/** Dev 通道开关与安装状态:落在 userData/updater.json,重启后仍然生效 */
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

/** 合并写入:只覆盖传入的字段,别把 allowPrerelease 之类的旧值冲掉 */
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

function writePrerelease(flag) {
  writeSettings({ allowPrerelease: Boolean(flag) });
}

/** 语义化比较:1.7.9-dev.2 < 1.7.9-dev.10 < 1.7.9（与手机端同一套规则） */
function compareVersion(a, b) {
  const split = (v) => {
    const text = String(v || '').replace(/^v/i, '');
    const [core, pre] = text.split('-');
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    // 没有预发布标记就是正式版。semver 里正式版大于同号的所有预发布,
    // 所以这里必须用 null 表示「比任何 dev 号都大」,不能用 -1 ——
    // 用 -1 会让 1.7.10 小于 1.7.10-dev.5,Dev 通道用户永远升不到正式版。
    const dev = pre ? Number.parseInt(pre.replace(/^dev\.?/i, ''), 10) || 0 : null;
    return { nums, dev };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (diff !== 0) return diff;
  }
  // 主版本号相同,再比预发布:正式版 > 预发布 > 更小的 dev 号
  if (left.dev === null && right.dev === null) return 0;
  if (left.dev === null) return 1;
  if (right.dev === null) return -1;
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

  // 启动时自检:当前版本已经追上(或超过)上次尝试安装的版本 → 说明装成功了,
  // 把标记清掉,免得下次同版本再来时被误判成"安装未生效"。
  const bootState = readSettings();
  if (bootState.installAttempted
      && compareVersion(app.getVersion(), bootState.installAttempted) >= 0) {
    writeSettings({ installAttempted: '' });
  }

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
    // 第二条防线:上一轮已经对这个版本执行过安装,重启后当前版本却没变 ——
    // 说明安装没落地(文件被占用 / 安装器被取消)。此时再提示"可更新"只会让
    // 用户无限重复装同一个包,直接报错并给出可执行的出路。
    const attempted = String(readSettings().installAttempted || '');
    if (info.version && attempted && compareVersion(info.version, attempted) === 0) {
      log.warn('[updater] 上次安装未生效', { offered: info.version, current });
      send({
        type: 'error',
        message: `上次安装 v${info.version} 没有生效(安装可能被取消或文件被占用),请到 GitHub Releases 手动下载安装包`,
      });
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
  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = info.version || pendingVersion;
    send({ type: 'downloaded', version: info.version });
  });
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
    // 先记下"这次要装哪个版本":重启后若当前版本仍是旧的,update-available
    // 会据此判定安装未生效,改为报错而不是继续提示同一个包。
    if (pendingVersion) writeSettings({ installAttempted: pendingVersion });
    // isSilent 必须为 true:nsis 配置是 oneClick:false(带向导的安装器),
    // 非静默调用会把「欢迎 → 选择目录 → 安装 → 完成」整套向导弹出来,
    // 用户一取消就前功尽弃,下次启动又提示同一个版本 —— 表现为「更新提示关不掉」。
    // 静默安装给安装器传 /S,装完由 --force-run 自动拉起新版本。
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
}

// 更新一律手动:启动不再自动检查(用户要求 2026-10-29)。
// 自动下载/静默安装曾在真机上反复失败,留下一堆"下载到 100% 又归零"的体验问题。
const AUTO_CHECK = false;

function scheduleStartupCheck(delayMs = 8000) {
  if (!AUTO_CHECK) return;
  if (started || !app.isPackaged) return;
  started = true;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => log.warn('[updater] 启动检查失败', error));
  }, delayMs);
}

module.exports = { init, scheduleStartupCheck, setPrerelease, readPrerelease };
