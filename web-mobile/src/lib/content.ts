/**
 * 阅读内容来源:同一套阅读器界面,数据可以来自电脑(在线)或本地书库(离线)。
 * 两个实现只差"去哪取章节/图片/进度",翻页、目录、排版、进度写入都留在页面里。
 */
import { apiGet, mediaUrl } from './api';
import { getActiveServer } from './connection';
import { displayName, isEpub } from './format';
import { loadProgress, saveProgress } from './progress';
import {
  fetchSharedProgress,
  queueSharedProgress,
  seedLegacyChapters,
  sharedComicKey,
  sharedNovelKey,
  type SharedProgressRecord,
} from './reading-progress';
import { removeBookData } from './offline/db';
import {
  localComicPageUrl,
  readLocalChapter,
  readLocalProgress,
  releaseBookAssets,
  writeLocalProgress,
  type LocalProgressInput,
} from './offline/reading';
import type { LocalBook } from './offline/db';
import type { NovelChapter, NovelMeta } from './types';

export interface ReadingPosition {
  ch: number;
  total: number;
  chapterTitle: string;
  scroll: number;
  chapters: Record<string, number>;
}

export interface NovelSource {
  mode: 'online' | 'local';
  /** 进度归属:在线用"服务器::文件名",本地用离线包 id */
  bookId: string;
  title: string;
  epub: boolean;
  /** 在线书的封面接口;直连模式 mediaUrl 会返回空,自动退回渐变封面 */
  coverUrl?: string;
  detailHref: string;
  readerHref(ch: number): string;
  loadMeta(): Promise<NovelMeta>;
  loadChapter(idx: number): Promise<NovelChapter>;
  loadProgress(): Promise<ReadingPosition | null>;
  saveProgress(
    ch: number,
    total: number,
    chapterTitle: string,
    scroll: number,
    chapters?: Record<string, number>,
  ): void;
}

export interface ComicSource {
  mode: 'online' | 'local';
  bookId: string;
  title: string;
  /** 本地包只有一个 PDF;在线则是这本书的全部 PDF(按阅读顺序) */
  files: string[];
  detailHref: string;
  readerHref(file: string, page: number): string;
  loadPageCount(file: string): Promise<number>;
  /** reload 只在在线模式有意义:同一 URL 强制电脑重新出图 */
  pageUrl(file: string, page: number, reload?: number): Promise<string>;
  loadProgress(file: string): Promise<ReadingPosition | null>;
  saveProgress(
    file: string,
    page: number,
    total: number,
    chapters?: Record<string, number>,
  ): void;
}

function comicKey(title: string, file: string): string {
  return `comic::${title}::${file}`;
}

function chaptersOrSeed(
  ch: number,
  scroll: number,
  total: number,
  chapters?: Record<string, number>,
): Record<string, number> {
  return chapters && Object.keys(chapters).length
    ? chapters
    : seedLegacyChapters(ch, scroll, total);
}

function positionOf(record: SharedProgressRecord): ReadingPosition {
  return {
    ch: record.ch,
    total: record.total,
    chapterTitle: record.chapterTitle,
    scroll: record.scroll,
    chapters: record.chapters,
  };
}

export function onlineNovelSource(file: string): NovelSource | null {
  const server = getActiveServer();
  if (!server) return null;
  const epub = isEpub(file);
  return {
    mode: 'online',
    bookId: `${server.id}::${file}`,
    title: displayName(file),
    epub,
    coverUrl: `/api/book_cover?file=${encodeURIComponent(file)}`,
    detailHref: `/book/${encodeURIComponent(file)}?kind=novel`,
    readerHref: (ch) => `/read/${encodeURIComponent(file)}?ch=${ch}`,
    loadMeta: () =>
      apiGet<NovelMeta>(epub ? '/api/epub_meta' : '/api/read_meta', { file }),
    loadChapter: (idx) =>
      apiGet<NovelChapter>(epub ? '/api/epub_read' : '/api/read', { file, ch: idx }),
    loadProgress: async () => {
      const book = sharedNovelKey(file);
      const saved = loadProgress(server.id, file);
      let shared: SharedProgressRecord | null = null;
      try {
        shared = (await fetchSharedProgress([book]))[book] || null;
      } catch {
        // 旧电脑/断网时仍可按手机缓存的位置接着读
      }
      if (saved) {
        const local = {
          ch: saved.chapter,
          total: saved.total || 0,
          chapterTitle: saved.chapterTitle || '',
          scroll: saved.scroll,
          chapters: chaptersOrSeed(
            saved.chapter,
            saved.scroll,
            saved.total || 0,
            saved.chapters,
          ),
        };
        if (!shared || (saved.updated || 0) > shared.updated) {
          // 手机上读到更后面:先补传电脑,再按手机位置接着读
          queueSharedProgress({
            book,
            kind: 'novel',
            title: displayName(file),
            total: local.total,
            ch: local.ch,
            chapterTitle: local.chapterTitle,
            scroll: local.scroll,
            chapters: local.chapters,
            updated: saved.updated,
          });
          return local;
        }
      }
      return shared ? positionOf(shared) : null;
    },
    saveProgress: (ch, total, chapterTitle, scroll, chapters) => {
      const updated = Date.now();
      const map = chapters || {};
      saveProgress(server.id, file, {
        chapter: ch,
        total,
        bookTitle: displayName(file),
        chapterTitle,
        scroll,
        chapters: map,
        updated,
      });
      queueSharedProgress({
        book: sharedNovelKey(file),
        kind: 'novel',
        title: displayName(file),
        total,
        ch,
        chapterTitle,
        scroll,
        chapters: map,
        updated,
      });
    },
  };
}

export function localNovelSource(book: LocalBook): NovelSource {
  return {
    mode: 'local',
    bookId: book.id,
    title: book.title,
    epub: book.format === 'epub',
    detailHref: `/local/book/${encodeURIComponent(book.id)}`,
    readerHref: (ch) => `/local/read/${encodeURIComponent(book.id)}?ch=${ch}`,
    loadMeta: async () => ({
      title: book.title,
      total: book.total,
      chapters: book.chapters,
    }),
    loadChapter: (idx) => readLocalChapter(book, idx),
    loadProgress: async () => {
      const record = await readLocalProgress(book.id);
      if (!record) return null;
      return {
        ch: record.ch,
        total: record.total,
        chapterTitle: record.chapter,
        scroll: record.scroll,
        chapters: chaptersOrSeed(record.ch, record.scroll, record.total, record.chapters),
      };
    },
    saveProgress: (ch, total, chapterTitle, scroll, chapters) => {
      const input: LocalProgressInput = { ch, total, chapterTitle, scroll, chapters };
      void writeLocalProgress(book, input);
    },
  };
}

export function onlineComicSource(title: string, files: string[]): ComicSource | null {
  const server = getActiveServer();
  if (!server) return null;
  return {
    mode: 'online',
    bookId: `${server.id}::${comicKey(title, files[0] || '')}`,
    title,
    files,
    detailHref: `/book/${encodeURIComponent(title)}?kind=comic`,
    readerHref: (file, page) =>
      `/comic/${encodeURIComponent(title)}?file=${encodeURIComponent(file)}&page=${page}`,
    loadPageCount: async (file) => {
      const data = await apiGet<{ ok: boolean; num_pages: number }>('/api/comic_page_meta', {
        title,
        file,
      });
      return Math.max(0, Number(data.num_pages) || 0);
    },
    pageUrl: async (file, page, reload = 0) =>
      mediaUrl(
        `/api/comic_page_image?title=${encodeURIComponent(title)}&file=${encodeURIComponent(
          file,
        )}&page=${page}&r=${reload}`,
      ),
    loadProgress: async (file) => {
      const book = sharedComicKey(title, file);
      const saved = loadProgress(server.id, comicKey(title, file));
      let shared: SharedProgressRecord | null = null;
      try {
        shared = (await fetchSharedProgress([book]))[book] || null;
      } catch {
        // 旧电脑/断网时仍可按手机缓存的位置接着读
      }
      if (saved) {
        const local = {
          ch: saved.chapter,
          total: saved.total || 0,
          chapterTitle: saved.chapterTitle || '',
          scroll: saved.scroll,
          chapters: chaptersOrSeed(
            saved.chapter,
            saved.scroll,
            saved.total || 0,
            saved.chapters,
          ),
        };
        if (!shared || (saved.updated || 0) > shared.updated) {
          queueSharedProgress({
            book,
            kind: 'comic',
            title,
            total: local.total,
            ch: local.ch,
            chapterTitle: local.chapterTitle,
            scroll: 0,
            chapters: local.chapters,
            updated: saved.updated,
          });
          return local;
        }
      }
      return shared ? positionOf(shared) : null;
    },
    saveProgress: (file, page, total, chapters) => {
      const updated = Date.now();
      const map = chapters || {};
      saveProgress(server.id, comicKey(title, file), {
        chapter: page,
        total,
        bookTitle: title,
        chapterTitle: displayName(file),
        scroll: 0,
        chapters: map,
        updated,
      });
      queueSharedProgress({
        book: sharedComicKey(title, file),
        kind: 'comic',
        title,
        total,
        ch: page,
        chapterTitle: displayName(file),
        scroll: 0,
        chapters: map,
        updated,
      });
    },
  };
}

export function localComicSource(book: LocalBook): ComicSource {
  return {
    mode: 'local',
    bookId: book.id,
    title: book.title,
    files: [book.file],
    detailHref: `/local/book/${encodeURIComponent(book.id)}`,
    readerHref: (_file, page) => `/local/comic/${encodeURIComponent(book.id)}?page=${page}`,
    loadPageCount: async () => book.total,
    pageUrl: (_file, page) => localComicPageUrl(book, page),
    loadProgress: async () => {
      const record = await readLocalProgress(book.id);
      if (!record) return null;
      return {
        ch: record.ch,
        total: record.total,
        chapterTitle: record.chapter,
        scroll: record.scroll,
        chapters: chaptersOrSeed(record.ch, 0, record.total, record.chapters),
      };
    },
    saveProgress: (_file, page, total, chapters) => {
      void writeLocalProgress(book, {
        ch: page,
        total,
        chapterTitle: `第 ${page} 页`,
        chapters,
      });
    },
  };
}

/** 路由参数可能来自收藏/后退,书已被删除时要能明确告诉用户,而不是白屏。 */
export { localBook } from './offline/reading';

/** 本地书的详情页(目录/继续阅读),和在线的 /book/:file 分开走路由。 */
export function localBookHref(book: LocalBook): string {
  return `/local/book/${encodeURIComponent(book.id)}`;
}

/** 一本本地书该去哪个阅读器:漫画翻页、小说翻章。 */
export function localReaderHref(book: LocalBook): string {
  const id = encodeURIComponent(book.id);
  return book.kind === 'comic' ? `/local/comic/${id}` : `/local/read/${id}`;
}

/** 从本地书库删掉一本书(内容、目录、进度一起清)。 */
export async function deleteLocalBook(book: LocalBook): Promise<void> {
  releaseBookAssets(book.id);
  await removeBookData(book.id);
}
