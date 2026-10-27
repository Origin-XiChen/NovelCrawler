/**
 * 本地书库状态:首页与书架共用一份数据,导入/删除后广播刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import { allBooks, allProgress, type LocalBook, type LocalProgress } from './db';

const EVENT = 'nc-library-changed';

export interface LocalLibrary {
  books: LocalBook[];
  progress: Record<string, LocalProgress>;
  /** 本地内容占用(离线包体积合计,不是磁盘真实占用) */
  bytes: number;
  loading: boolean;
}

const EMPTY: LocalLibrary = { books: [], progress: {}, bytes: 0, loading: true };

/** 导入/删除之后调用,让所有展示本地书库的页面重新读一次。 */
export function announceLibraryChange(): void {
  window.dispatchEvent(new Event(EVENT));
}

export async function loadLibrary(): Promise<LocalLibrary> {
  const [books, records] = await Promise.all([allBooks(), allProgress()]);
  books.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
  const progress: Record<string, LocalProgress> = {};
  for (const record of records) progress[record.bookId] = record;
  return {
    books,
    progress,
    bytes: books.reduce((sum, book) => sum + (book.size || 0), 0),
    loading: false,
  };
}

/** 一本本地书在目录里排第几(读到哪章 → 章节号),用于"继续阅读"。 */
export function lastReadBook(library: LocalLibrary): {
  book: LocalBook;
  record: LocalProgress;
} | null {
  let best: { book: LocalBook; record: LocalProgress } | null = null;
  for (const book of library.books) {
    const record = library.progress[book.id];
    if (!record || !record.ch) continue;
    if (!best || record.ts > best.record.ts) best = { book, record };
  }
  return best;
}

/** "读到第 12 章 / 第 3 页"——漫画和小说的计量单位不一样。 */
export function progressLabel(book: LocalBook, record: LocalProgress): string {
  const unit = book.kind === 'comic' ? '页' : '章';
  const named = book.kind === 'novel' ? record.chapter.trim() : '';
  return named || `第 ${record.ch} ${unit}`;
}

export function dirtyRecords(library: LocalLibrary): LocalProgress[] {
  return Object.values(library.progress).filter((item) => item.dirty);
}

export function useLocalLibrary(): LocalLibrary & { reload: () => void } {
  const [state, setState] = useState<LocalLibrary>(EMPTY);

  const reload = useCallback(() => {
    loadLibrary()
      .then(setState)
      .catch(() => setState((previous) => ({ ...previous, loading: false })));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(EVENT, reload);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener(EVENT, reload);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [reload]);

  return { ...state, reload };
}
