const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const log = require('./logger');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配端口'))));
    });
  });
}

function pythonCandidates(root) {
  return [
    process.env.NOVEL_PYTHON,
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'bundle314', 'Scripts', 'python.exe'),
    'python',
  ].filter(Boolean);
}

function resolvePython(root) {
  for (const candidate of pythonCandidates(root)) {
    if (!path.isAbsolute(candidate)) {
      const probe = spawnSync(candidate, ['--version'], { windowsHide: true });
      if (probe.status === 0) return candidate;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Python 解释器，请设置 NOVEL_PYTHON 或创建 .venv');
}

function startBackend({ port, root, userData, packaged }) {
  const dataDir = path.join(userData, 'data');
  const logsDir = path.join(userData, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const env = {
    ...process.env,
    NOVEL_DATA_DIR: dataDir,
    NOVEL_LOG_FILE: path.join(logsDir, 'backend.log'),
  };

  let command;
  let args;
  let cwd;

  if (packaged) {
    const exe = path.join(process.resourcesPath, 'backend', 'NovelCrawlerBackend.exe');
    if (!fs.existsSync(exe)) {
      throw new Error(`后端不存在：${exe}`);
    }
    command = exe;
    args = ['--port', String(port)];
    cwd = path.dirname(exe);
  } else {
    command = resolvePython(root);
    args = [path.join(root, 'gui_server.py'), '--port', String(port)];
    cwd = root;
  }

  log.info('启动后端', command, args.join(' '), 'data=', dataDir);
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: 'ignore',
  });

  child.on('error', (error) => log.error('后端进程错误', error));
  child.on('exit', (code, signal) => log.info('后端进程退出', `code=${code}`, `signal=${signal}`));

  return child;
}

async function waitForPing(baseUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/ping`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.ok) return true;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  throw new Error(`后端启动超时（${lastError || '无响应'}）`);
}

function killBackend(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGTERM');
}

function readLogTail(userData, lines = 40) {
  try {
    const file = path.join(userData, 'logs', 'backend.log');
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

module.exports = { findFreePort, resolvePython, startBackend, waitForPing, killBackend, readLogTail };
