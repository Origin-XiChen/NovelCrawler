/**
 * 进度双向同步:手机离线阅读的进度在联网时回传电脑,换手机/重装后也能接着读。
 * 电脑端把逐章进度存在共享表里,这里只同步手机上真实存在的书,避免把整张表搬进来。
 */
import { getActiveServer } from '../connection';
import {
  fetchSharedProgress,
  pushSharedProgress,
  seedLegacyChapters,
  type SharedProgressRecord,
} from '../reading-progress';
import { allBooks, allProgress, putProgress, type LocalProgress } from './db';

export interface SyncResult {
  pushed: number;
  pulled: number;
  failed: number;
}

function chaptersOf(record: LocalProgress | SharedProgressRecord): Record<string, number> {
  const chapters = record.chapters;
  if (chapters && Object.keys(chapters).length) return chapters;
  return seedLegacyChapters(record.ch, record.scroll, record.total);
}

/** 一次尽力而为的同步:先取电脑上的进度(本机缺的或更旧的),再回传本地记录。 */
export const LAST_SYNC_KEY = 'nc.sync.last';

export function lastSyncAt(): number {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

export async function syncProgress(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, failed: 0 };
  if (!getActiveServer()) return result;

  let remote: Record<string, SharedProgressRecord> = {};
  try {
    const books = await allBooks();
    const [records, local] = await Promise.all([
      fetchSharedProgress(books.map((book) => book.id)),
      allProgress(),
    ]);
    remote = records;
    const localIds = new Set(books.map((book) => book.id));
    const byBook = new Map(local.map((item) => [item.bookId, item]));
    for (const [bookId, record] of Object.entries(records)) {
      if (!localIds.has(bookId)) continue;
      const mine = byBook.get(bookId);
      if (mine?.dirty) continue; // 本地刚翻过页、还没回传:不能被旧值盖掉
      if (mine && mine.ts >= record.updated) continue;
      await putProgress({
        bookId,
        kind: record.kind,
        title: record.title || mine?.title || '',
        chapter: record.chapterTitle || mine?.chapter || '',
        ch: record.ch,
        total: record.total,
        scroll: record.scroll,
        chapters: chaptersOf(record),
        ts: record.updated || Date.now(),
        dirty: false,
      });
      result.pulled += 1;
    }
  } catch {
    // 取不到远端进度不影响回传
  }

  for (const record of await allProgress()) {
    const remoteRecord = remote[record.bookId];
    // 旧版本留下的干净记录电脑可能还没见过:补传一次,相当于迁移
    if (!record.dirty && remoteRecord && record.ts <= remoteRecord.updated) continue;
    try {
      const chapters = chaptersOf(record);
      await pushSharedProgress({
        book: record.bookId,
        kind: record.kind,
        title: record.title,
        ch: record.ch,
        total: record.total,
        chapterTitle: record.chapter,
        scroll: record.scroll,
        chapters,
      });
      await putProgress({ ...record, chapters, dirty: false, ts: Date.now() });
      result.pushed += 1;
    } catch {
      result.failed += 1;
    }
  }
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {
    // 隐私模式忽略
  }
  return result;
}

export function dirtyCount(records: LocalProgress[]): number {
  return records.filter((item) => item.dirty).length;
}

let syncTimer: number | null = null;
let syncRunning = false;

/**
 * 延迟自动回传:阅读时每翻一章都会写一次本地进度,立刻上传会把请求打爆,
 * 所以这里做 4 秒防抖 + 单飞(同一时刻只跑一个),失败安静重试一次。
 * 用户在「同步管理」里手动点同步时走 syncProgress() 本体,不受影响。
 */
export function scheduleSync(delay = 4000): void {
  if (!getActiveServer()) return;
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(async () => {
    syncTimer = null;
    if (syncRunning) return;
    syncRunning = true;
    try {
      await syncProgress();
    } catch {
      // 网络抖动:再等 8 秒补一次,仍失败就留给下次阅读或手动同步
      window.setTimeout(() => { void syncProgress().catch(() => {}); }, 8000);
    } finally {
      syncRunning = false;
    }
  }, delay);
}
