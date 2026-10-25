import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const webEntry = path.join(ROOT, 'static', 'app', 'index.html');
if (!fs.existsSync(webEntry)) {
  console.error('[backend] 缺少 static/app/index.html，请先运行 npm run build:web');
  process.exit(1);
}

const python = resolvePython();
const version = spawnSync(python, ['-m', 'PyInstaller', '--version'], {
  windowsHide: true,
  encoding: 'utf8',
});
if (version.status !== 0) {
  console.error(`[backend] PyInstaller 未安装：${python} -m pip install pyinstaller`);
  process.exit(1);
}

console.log(`[backend] 使用 ${python}，PyInstaller ${version.stdout.trim()}`);
const result = spawnSync(
  python,
  [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--distpath',
    'dist-backend',
    '--workpath',
    'build/pyinstaller-backend',
    'NovelCrawlerBackend.spec',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const exe = path.join(ROOT, 'dist-backend', 'NovelCrawlerBackend', 'NovelCrawlerBackend.exe');
if (!fs.existsSync(exe)) {
  console.error(`[backend] 未找到产物：${exe}`);
  process.exit(1);
}
console.log(`[backend] 构建完成：${exe}`);
