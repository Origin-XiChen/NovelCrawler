export function formatSize(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function displayName(name: string): string {
  return String(name || '').replace(/\.(txt|epub|pdf)$/i, '');
}

export function isEpub(name: string): boolean {
  return /\.epub$/i.test(name || '');
}

export function isNovelFile(name: string): boolean {
  return /\.(txt|epub)$/i.test(name || '');
}

const GRADIENTS = [
  'linear-gradient(145deg, #2f6f6a 0%, #184746 100%)',
  'linear-gradient(145deg, #6b5b95 0%, #3f355f 100%)',
  'linear-gradient(145deg, #b06a4a 0%, #6f3c2a 100%)',
  'linear-gradient(145deg, #3f6b8f 0%, #234158 100%)',
  'linear-gradient(145deg, #8a6a3a 0%, #57411f 100%)',
  'linear-gradient(145deg, #7a4f63 0%, #4a2c3b 100%)',
  'linear-gradient(145deg, #4f6b4a 0%, #2c4129 100%)',
];

export function gradientFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

export function initialOf(name: string): string {
  const text = displayName(name).trim();
  return text.slice(0, 1) || '书';
}

export function percent(value: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

export function relativeTime(seconds: number): string {
  if (!seconds) return '从未连接';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (diff < 60) return '刚刚在线';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** 只到"哪一天":书架要的是导入日期,不是几点几分。 */
export function formatDate(milliseconds: number): string {
  if (!milliseconds) return '更早';
  const date = new Date(milliseconds);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return '今天';
  if (sameDay(date, new Date(today.getTime() - 86400000))) return '昨天';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() === today.getFullYear()
    ? `${month}-${day}`
    : `${date.getFullYear()}-${month}-${day}`;
}
