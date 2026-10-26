import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const release = process.argv[2] === 'release';
const task = release ? 'assembleRelease' : 'assembleDebug';
const cwd = fileURLToPath(new URL('../android/', import.meta.url));
const windows = process.platform === 'win32';

const result = windows
  ? spawnSync('gradlew.bat', [task], { cwd, stdio: 'inherit', shell: true })
  : spawnSync('sh', ['gradlew', task], { cwd, stdio: 'inherit' });

process.exit(result.status ?? 1);
