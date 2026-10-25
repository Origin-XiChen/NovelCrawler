export function relativeTime(epochSeconds?: number): string {
  if (!epochSeconds) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(epochSeconds * 1000).toLocaleDateString('zh-CN');
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function pct(done?: number, total?: number): number {
  if (!done || !total) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function taskStateMeta(state: string): { label: string; tone: string } {
  switch (state) {
    case 'running':
    case 'downloading':
      return { label: '进行中', tone: 'badge--primary' };
    case 'paused':
      return { label: '已暂停', tone: 'badge--warn' };
    case 'done':
      return { label: '已完成', tone: 'badge--success' };
    case 'error':
      return { label: '失败', tone: 'badge--danger' };
    case 'cancelled':
      return { label: '已取消', tone: '' };
    default:
      return { label: state || '未知', tone: '' };
  }
}

export function taskKindLabel(kind?: string): string {
  switch (kind) {
    case 'chapter_download':
      return '章节下载';
    case 'opds_download':
      return 'OPDS 下载';
    case 'comic_download':
      return '漫画下载';
    case 'comic_refresh':
      return '漫画检查';
    case 'download':
      return '下载';
    case 'search':
      return '搜索';
    case 'sync':
      return '书源同步';
    case 'subscription':
      return '订阅刷新';
    case 'comic':
      return '漫画';
    default:
      return kind || '任务';
  }
}
