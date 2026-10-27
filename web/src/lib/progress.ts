import { apiGet, apiPost } from './api';

export interface ReadingProgressRecord {
  book: string;
  kind: string;
  title: string;
  total: number;
  ch: number;
  chapterTitle: string;
  scroll: number;
  chapters: Record<string, number>;
  updated: number;
  percent: number;
}

export interface ReadingProgressInput {
  book: string;
  kind?: string;
  title?: string;
  total?: number;
  ch: number;
  chapterTitle?: string;
  scroll?: number;
  chapters?: Record<string, number>;
  updated?: number;
}

export const COMPLETE_AT = 0.98;

export function clampRatio(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(1, Math.max(0, number)) * 10000) / 10000;
}

export function normalizeFraction(value: unknown): number {
  const ratio = clampRatio(value);
  return ratio >= COMPLETE_AT ? 1 : ratio;
}

/** 总进度只累计从第 1 章起连续读过的部分:跳读、留空都不抬高百分比。 */
export function continuousPercent(rec: {
  total?: number;
  ch?: number;
  scroll?: number;
  chapters?: Record<string, number>;
}): number {
  const total = Math.floor(Number(rec.total) || 0);
  if (total <= 0) return 0;
  const chapters = rec.chapters ?? {};
  const keys = Object.keys(chapters);
  let units = 0;
  if (keys.length) {
    for (let index = 1; index <= total; index += 1) {
      const raw = chapters[String(index)];
      if (raw === undefined || raw === null) break;
      const fraction = normalizeFraction(raw);
      units += fraction;
      if (fraction < 1) break;
    }
  } else {
    units = Math.max(0, Math.floor(Number(rec.ch) || 0) - 1) + clampRatio(rec.scroll);
  }
  if (units >= total) return 100;
  return Math.max(0, Math.min(99, Math.round((units / total) * 100)));
}

/** 旧记录只有"读到第 ch 章 + 章内比例",迁移时视为连续读过来的。 */
export function seedLegacyChapters(
  ch: number,
  scroll: number,
  total: number,
): Record<string, number> {
  const end = total > 0 ? Math.min(Math.max(1, ch), total) : Math.max(1, ch);
  const chapters: Record<string, number> = {};
  if (!ch) return chapters;
  for (let index = 1; index < end; index += 1) chapters[String(index)] = 1;
  const fraction = normalizeFraction(scroll);
  if (fraction > 0) chapters[String(end)] = fraction;
  return chapters;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 与手机书目/离线包一致的共享进度键。 */
export function progressBookKey(mode: 'file' | 'url' | 'epub', value: string): string {
  if (mode === 'file') return `novel:${basename(value)}`;
  return `${mode === 'epub' ? 'epub' : 'url'}:${value}`;
}

export function shelfProgressKeys(localFile: string, url: string, epub: boolean): string[] {
  const keys: string[] = [];
  if (localFile) keys.push(`novel:${basename(localFile)}`);
  if (url && !url.startsWith('file:')) keys.push(`${epub ? 'epub' : 'url'}:${url}`);
  return keys;
}

export async function fetchReadingProgress(
  book?: string,
): Promise<Record<string, ReadingProgressRecord>> {
  const data = await apiGet<{ records?: Record<string, ReadingProgressRecord> }>(
    '/api/reading_progress',
    book ? { book } : undefined,
  );
  return data.records ?? {};
}

export async function pushReadingProgress(
  input: ReadingProgressInput,
): Promise<ReadingProgressRecord | null> {
  const data = await apiPost<{ record?: ReadingProgressRecord }>('/api/reading_progress', {
    ...input,
    updated: input.updated ?? Date.now(),
  });
  return data.record ?? null;
}
