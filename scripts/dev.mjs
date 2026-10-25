import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PORT = Number(process.env.NOVEL_DEV_BACKEND_PORT || 8765);
const BACKEND = `http://127.0.0.1:${PORT}`;
const VITE = 'http://127.0.0.1:5173/';
const children = [];

function resolvePython() {
  const candidates = [
    process.env.NOVEL_PYTHON,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'bundle314', 'Scripts', 'python.exe'),
    process.platform === 'win32' ? 'python' : 'python3',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ['--version'], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  throw new Error('未找到 Python：请设置 NOVEL_PYTHON 或创建 .venv');
}

async function ping(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} 启动超时：${url}`);
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* 进程可能已退出 */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  const backendReady = await ping(`${BACKEND}/api/ping`);
  if (backendReady) {
    console.log(`[dev] 复用已运行的后端 ${BACKEND}`);
  } else {
    const python = resolvePython();
    console.log(`[dev] 启动后端：${python} gui_server.py --port ${PORT}`);
    const backend = run(python, ['gui_server.py', '--port', String(PORT)]);
    backend.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.error(`[dev] 后端异常退出（${code}）`);
        shutdown(1);
      }
    });
    await waitFor(`${BACKEND}/api/ping`, 45000, '后端');
  }

  console.log('[dev] 启动 Vite…');
  run(NPM, ['run', 'dev', '-w', 'web'], { shell: process.platform === 'win32' });
  await waitFor(VITE, 45000, 'Vite');

  console.log('[dev] 启动 Electron…');
  const electron = run(NPM, ['run', 'dev', '-w', 'desktop'], {
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: VITE,
      NOVEL_BACKEND_URL: BACKEND,
    },
  });
  electron.on('exit', (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : error}`);
  shutdown(1);
}
