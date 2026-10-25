const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');

function stateFile(userData) {
  return path.join(userData, 'window-state.json');
}

function visibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y),
    );
    return overlapX >= 120 && overlapY >= 80;
  });
}

function loadWindowState(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(userData), 'utf8'));
    if (
      Number.isFinite(data.x) &&
      Number.isFinite(data.y) &&
      Number.isFinite(data.width) &&
      Number.isFinite(data.height) &&
      data.width >= 1024 &&
      data.height >= 680 &&
      visibleOnSomeDisplay(data)
    ) {
      return data;
    }
  } catch {
    /* 没有历史状态 */
  }
  return {};
}

function attachWindowState(win, userData) {
  let timer = null;

  const save = () => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(stateFile(userData), JSON.stringify(win.getBounds()), 'utf8');
    } catch {
      /* 状态保存失败不影响使用 */
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 300);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

module.exports = { loadWindowState, attachWindowState };
