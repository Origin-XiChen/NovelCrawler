const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

let stream = null;
let logFile = '';

function init() {
  if (stream) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch {
    stream = null;
  }
}

function write(level, args) {
  init();
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((value) => (value instanceof Error ? value.stack || value.message : String(value)))
    .join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  if (stream) stream.write(`${line}\n`);
}

module.exports = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  getLogFile: () => {
    init();
    return logFile;
  },
};
