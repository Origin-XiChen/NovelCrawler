/**
 * 进度双向同步:手机本地读书进度在联网时回传电脑,重装 App/换手机后也能接着读。
 * 只有本地书库(离线导入的书)的进度参与,在线读电脑的进度本来就存在电脑上。
 */
import { apiGet, apiPost } from '../api';
import { getActiveServer } from '../connection';
import { allProgress, putProgress, type LocalProgress } from './db';

interface RemoteRecord {
  kind?: string;
  title?: string;
  chapter?: string;
  ch?: number;
  total?: number;
  scroll?: number;
  ts?: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  failed: number;
}

/** 一次尽力而为的同步:先取电脑上的进度(本机缺的或更旧的),再回传本地脏记录。 */
export async function syncProgress(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, failed: 0 };
  if (!getActiveServer()) return result;

  try {
    const remote = await apiGet<{ ok: boolean; records: Record<string, RemoteRecord> }>(
      '/api/mobile/progress',
    );
    const local = await allProgress();
    const byBook = new Map(local.map((item) => [item.bookId, item]));
    for (const [bookId, record] of Object.entries(remote.records || {})) {
      const mine = byBook.get(bookId);
      const remoteTs = Number(record.ts || 0) * 1000;
      if (mine && mine.ts >= remoteTs) continue;
      if (mine?.dirty) continue; // 本地刚翻过页、还没回传:不能被旧值盖掉
      const next: LocalProgress = {
        bookId,
        kind: (record.kind === 'comic' ? 'comic' : 'novel') as LocalProgress['kind'],
        title: String(record.title || mine?.title || ''),
        chapter: String(record.chapter || ''),
        ch: Number(record.ch || 0),
        total: Number(record.total || 0),
        scroll: Number(record.scroll || 0),
        ts: remoteTs || Date.now(),
        dirty: false,
      };
      await putProgress(next);
      result.pulled += 1;
    }
  } catch {
    // 取不到远端进度不影响回传
  }

  for (const record of await allProgress()) {
    if (!record.dirty) continue;
    try {
      await apiPost('/api/mobile/progress', {
        book: record.bookId,
        kind: record.kind,
        title: record.title,
        chapter: record.chapter,
        ch: record.ch,
        total: record.total,
        scroll: record.scroll,
      });
      await putProgress({ ...record, dirty: false });
      result.pushed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export function dirtyCount(records: LocalProgress[]): number {
  return records.filter((item) => item.dirty).length;
}
