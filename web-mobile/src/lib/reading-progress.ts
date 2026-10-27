/**
 * 电脑与手机共享的逐章阅读进度。
 * ================================
 * 每章记一个完成比例,总进度只累计从第 1 章起连续读过的部分:跳读不会
 * 把百分比抬上去。旧电脑没有 /api/reading_progress 时自动退回旧接口,
 * 旧接口只有"读到第几章 + 章内滚到哪",此时按连续读到该章补出逐章数据。
 */
import { ApiError, apiGet, apiPost } from './api';
import { getActiveServer } from './connection';

export interface SharedProgressRecord {
  book: string;
  kind: 'novel' | 'comic';
  title: string;
  total: number;
  ch: number;
  chapterTitle: string;
  scroll: number;
  chapters: Record<string, number>;
  updated: number;
  percent: number;
}

export interface SharedProgressInput {
  book: string;
  kind?: 'novel' | 'comic';
  title?: string;
  total?: number;
  ch: number;
  chapterTitle?: string;
  scroll?: number;
  chapters?: Record<string, number>;
  updated?: number;
}

export interface LegacyProgress {
  chapter?: number;
  total?: number;
  chapterTitle?: string;
  scroll?: number;
  chapters?: Record<string, number>;
  updated?: number;
}

/** 比例到 98% 就算读完:手机滚到底常常差几个像素 */
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
  let units = 0;
  if (Object.keys(chapters).length) {
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
  const chapters: Record<string, number> = {};
  if (!ch) return chapters;
  const end = total > 0 ? Math.min(Math.max(1, ch), total) : Math.max(1, ch);
  for (let index = 1; index < end; index += 1) chapters[String(index)] = 1;
  const fraction = normalizeFraction(scroll);
  if (fraction > 0) chapters[String(end)] = fraction;
  return chapters;
}

export function mergeChapterMap(
  base: Record<string, number> | undefined,
  extra: Record<string, number> | undefined,
): Record<string, number> {
  const merged: Record<string, number> = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    const fraction = normalizeFraction(value);
    if (fraction <= 0) continue;
    merged[key] = Math.max(normalizeFraction(merged[key] ?? 0), fraction);
  }
  return merged;
}

function basename(path: string): string {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path || '');
}

/** 与电脑书架/手机书目一致的共享进度键。 */
export function sharedNovelKey(file: string): string {
  return `novel:${basename(file)}`;
}

export function sharedComicKey(title: string, file: string): string {
  return `comic:${title}/${basename(file)}`;
}

function stamp(value: unknown): number {
  const number = Number(value) || 0;
  if (number <= 0) return 0;
  // 旧接口用秒,新接口用毫秒
  return number < 100_000_000_000 ? number * 1000 : number;
}

function normalizeChapters(raw: unknown, total: number): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const chapters: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Math.floor(Number(key));
    if (!Number.isFinite(index) || index < 1) continue;
    if (total > 0 && index > total) continue;
    const fraction = normalizeFraction(value);
    if (fraction <= 0) continue;
    chapters[String(index)] = fraction;
  }
  return chapters;
}

function toRecord(book: string, raw: Record<string, unknown>): SharedProgressRecord {
  const total = Math.max(0, Math.floor(Number(raw.total) || 0));
  let ch = Math.max(0, Math.floor(Number(raw.ch) || 0));
  if (total > 0 && ch > total) ch = total;
  const scroll = clampRatio(raw.scroll);
  let chapters = normalizeChapters(raw.chapters, total);
  if (!Object.keys(chapters).length && ch > 0) {
    chapters = seedLegacyChapters(ch, scroll, total);
  }
  return {
    book,
    kind: raw.kind === 'comic' ? 'comic' : 'novel',
    title: String(raw.title || ''),
    total,
    ch,
    chapterTitle: String(raw.chapterTitle || raw.chapter || ''),
    scroll,
    chapters,
    updated: stamp(raw.updated ?? raw.ts),
    percent: continuousPercent({ total, ch, scroll, chapters }),
  };
}

export function fromLegacyProgress(book: string, rec: LegacyProgress): SharedProgressRecord {
  return toRecord(book, {
    kind: 'novel',
    total: rec.total,
    ch: rec.chapter,
    chapterTitle: rec.chapterTitle,
    scroll: rec.scroll,
    chapters: rec.chapters,
    updated: rec.updated,
  });
}

// 旧电脑没有共享接口:记住这台服务器,之后直接走旧接口,少一次 404
const fallbackServers = new Set<string>();

function serverKey(): string {
  return getActiveServer()?.id || 'local';
}

function missingEndpoint(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 405);
}

function bookQuery(books?: string[]): { book: string[] } | undefined {
  const wanted = (books || []).filter(Boolean);
  return wanted.length ? { book: wanted } : undefined;
}

export async function fetchSharedProgress(
  books?: string[],
): Promise<Record<string, SharedProgressRecord>> {
  const key = serverKey();
  if (!fallbackServers.has(key)) {
    try {
      const data = await apiGet<{ records?: Record<string, Record<string, unknown>> }>(
        '/api/reading_progress',
        bookQuery(books),
      );
      const out: Record<string, SharedProgressRecord> = {};
      for (const [book, rec] of Object.entries(data.records || {})) {
        out[book] = toRecord(book, rec || {});
      }
      return out;
    } catch (cause) {
      if (!missingEndpoint(cause)) throw cause;
      fallbackServers.add(key);
    }
  }
  const data = await apiGet<{ records?: Record<string, Record<string, unknown>> }>(
    '/api/mobile/progress',
    bookQuery(books),
  );
  const out: Record<string, SharedProgressRecord> = {};
  for (const [book, rec] of Object.entries(data.records || {})) {
    out[book] = toRecord(book, rec || {});
  }
  return out;
}

export async function pushSharedProgress(
  input: SharedProgressInput,
): Promise<SharedProgressRecord | null> {
  const body = { ...input, updated: input.updated ?? Date.now() };
  const key = serverKey();
  if (!fallbackServers.has(key)) {
    try {
      const data = await apiPost<{ record?: Record<string, unknown> }>(
        '/api/reading_progress',
        body,
      );
      return data.record ? toRecord(body.book, data.record) : null;
    } catch (cause) {
      if (!missingEndpoint(cause)) throw cause;
      fallbackServers.add(key);
    }
  }
  await apiPost('/api/mobile/progress', {
    book: body.book,
    kind: body.kind,
    title: body.title,
    chapter: body.chapterTitle,
    ch: body.ch,
    total: body.total,
    scroll: body.scroll,
    ts: Math.floor(body.updated / 1000),
  });
  return null;
}

// 连续翻页时每 600ms 就回传一次太费流量:按书合并,最多 2 秒发一次
const queuedPushes = new Map<string, SharedProgressInput>();
const queuedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sendQueued(book: string): void {
  const timer = queuedTimers.get(book);
  if (timer) clearTimeout(timer);
  queuedTimers.delete(book);
  const input = queuedPushes.get(book);
  queuedPushes.delete(book);
  if (input) void pushSharedProgress(input).catch(() => undefined);
}

export function queueSharedProgress(input: SharedProgressInput, delay = 2000): void {
  queuedPushes.set(input.book, input);
  if (queuedTimers.has(input.book)) return;
  queuedTimers.set(
    input.book,
    setTimeout(() => {
      queuedTimers.delete(input.book);
      sendQueued(input.book);
    }, delay),
  );
}

/** 离开阅读器/切后台时把还没发出去的那一条立刻送出。 */
export function flushSharedProgress(book?: string): void {
  if (book) {
    sendQueued(book);
    return;
  }
  for (const key of [...queuedPushes.keys()]) sendQueued(key);
}
