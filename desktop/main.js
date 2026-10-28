'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} = require('electron');
const log = require('./logger');
const {
  findFreePort,
  startBackend,
  waitForPing,
  killBackend,
  readLogTail,
} = require('./backend');
const { loadWindowState, attachWindowState } = require('./window-state');
const updater = require('./updater');

const ROOT = path.resolve(__dirname, '..');
app.setName('NovelCrawler');
if (process.env.NOVEL_USER_DATA_DIR) {
  const userData = path.resolve(process.env.NOVEL_USER_DATA_DIR);
  app.setPath('userData', userData);
  app.setPath('cache', path.join(userData, 'cache'));
}

let backendUrl = process.env.NOVEL_BACKEND_URL || '';
let backendChild = null;
let mainWindow = null;
let splashWindow = null;
let appUrl = '';

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(url);
    }
  } catch {
    /* 忽略非法链接 */
  }
}

function isInternalUrl(target) {
  try {
    const origin = new URL(target).origin;
    const allowed = new Set([new URL(appUrl).origin]);
    if (backendUrl) allowed.add(new URL(backendUrl).origin);
    return allowed.has(origin);
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.on('app:packaged', (event) => {
    event.returnValue = app.isPackaged;
  });
  ipcMain.on('app:backend-url', (event) => {
    event.returnValue = backendUrl;
  });

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle('shell:open-dir', async (_event, name = '') => {
    try {
      const response = await fetch(`${backendUrl}/api/open_dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data && data.ok === false) throw new Error(data.error || '打开目录失败');
      return;
    } catch (error) {
      log.warn('调用后端打开目录失败，回退到数据目录', error);
      await shell.openPath(app.getPath('userData'));
    }
  });

  ipcMain.handle('shell:open-data-dir', async () => {
    const dir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  // 选隧道客户端等本地可执行文件:浏览器拿不到完整路径,必须走主进程
  ipcMain.handle('dialog:pick-exe', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择客户端程序',
      properties: ['openFile'],
      filters: [
        { name: '可执行文件', extensions: ['exe', 'bat', 'cmd'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return '';
    return result.filePaths[0];
  });

  ipcMain.handle('updater:set-prerelease', (_event, flag) => updater.setPrerelease(flag));
  ipcMain.handle('updater:get-prerelease', () => updater.readPrerelease());

  ipcMain.handle('app:notify', (_event, message) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: 'NovelCrawler', body: String(message) }).show();
  });

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url === 'string') openExternal(url);
  });
}

function createSplash() {
  const win = new BrowserWindow({
    width: 380,
    height: 232,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#17181a',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  void win.loadFile(path.join(__dirname, 'splash.html'));
  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null;
  });
  return win;
}

function createMainWindow(url) {
  const userData = app.getPath('userData');
  const bounds = loadWindowState(userData);

  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 840,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181a' : '#f7f5f1',
    title: '小说管家',
    icon: app.isPackaged ? undefined : path.join(ROOT, 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 最小化/被遮挡时仍保持搜索轮询与任务进度刷新
      backgroundThrottling: false,
    },
  });

  if (!bounds.width) win.center();
  attachWindowState(win, userData);

  win.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    win.show();
  });

  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, target) => {
    if (isInternalUrl(target)) return;
    event.preventDefault();
    openExternal(target);
  });

  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    log.error('页面加载失败', code, description, validatedUrl);
  });

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  void win.loadURL(url);
  return win;
}

async function bootstrap() {
  app.setAppUserModelId('com.originxichen.novelcrawler');
  Menu.setApplicationMenu(null);
  registerIpc();
  updater.init({ getWindow: () => mainWindow });

  if (app.isPackaged) {
    splashWindow = createSplash();
    const port = await findFreePort();
    backendUrl = `http://127.0.0.1:${port}`;
    backendChild = startBackend({
      port,
      root: ROOT,
      userData: app.getPath('userData'),
      packaged: true,
    });
    await waitForPing(backendUrl);
    appUrl = `${backendUrl}/app/`;
  } else {
    appUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173/';
    if (!backendUrl) {
      splashWindow = createSplash();
      const port = 8765;
      backendUrl = `http://127.0.0.1:${port}`;
      backendChild = startBackend({
        port,
        root: ROOT,
        userData: app.getPath('userData'),
        packaged: false,
      });
    }
    await waitForPing(backendUrl);
  }

  mainWindow = createMainWindow(appUrl);
  updater.scheduleStartupCheck();
}

function fatal(error) {
  log.error('启动失败', error);
  if (splashWindow) {
    splashWindow.destroy();
    splashWindow = null;
  }
  const tail = readLogTail(app.getPath('userData'));
  dialog.showErrorBox(
    '小说管家启动失败',
    `${error?.message || String(error)}\n\n日志：${log.getLogFile()}\n\n${tail}`,
  );
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch(fatal);

  app.on('before-quit', () => {
    killBackend(backendChild);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

process.on('exit', () => {
  killBackend(backendChild);
});
