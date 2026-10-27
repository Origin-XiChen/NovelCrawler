/**
 * 离线包导入:向电脑请求整本书的 ZIP,解出 manifest 后落进本地书库。
 * 只有这一步需要联网;之后断网照读。
 */
import JSZip from 'jszip';
import { apiDownload, apiGet } from '../api';
import { getActiveServer } from '../connection';
import { getBook, putBook, releaseZip, saveChunk, type ChapterRef, type LocalBook } from './db';

const SUPPORTED_BUNDLE_VERSION = 1;

/** 手机这次连接电脑的会话号:电脑"手机连接"页据此显示打包/传输进度 */
let sessionSid = '';
export function syncSid(): string {
  if (!sessionSid) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues?.(bytes);
    sessionSid =
      'app-' + Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
  }
  return sessionSid;
}

export interface CatalogNovel {
  id: string;
  file: string;
  kind: 'txt' | 'epub';
  title: string;
  size: number;
  mtime: number;
  chapters: number;
}

export interface CatalogComic {
  id: string;
  file: string;
  title: string;
  kind: 'comic';
  size: number;
  mtime: number;
  pages: number;
}

export interface CatalogResult {
  ok: boolean;
  novels: CatalogNovel[];
  comics: CatalogComic[];
  generated: number;
}

interface BundleManifest {
  bundle_version: number;
  kind: 'txt' | 'epub' | 'comic';
  id: string;
  title: string;
  file: string;
  chapters: ChapterRef[];
  total: number;
  assets: Record<string, string>;
  cover: string;
  src_size: number;
  src_mtime: number;
  generated: number;
  num_pages?: number;
}

export interface ImportTarget {
  kind: 'novel' | 'comic';
  /** 小说:文件名;漫画:PDF 文件名 */
  file: string;
  /** 漫画目录名(小说忽略) */
  title?: string;
}

export type ImportStage = 'packing' | 'downloading' | 'unpacking' | 'done';

export interface ImportProgress {
  stage: ImportStage;
  /** 打包阶段:电脑已处理 chapter/page 数;传输阶段:已收字节 */
  done: number;
  total: number;
  /** 传输阶段 0~1,打包阶段为 -1(总量未知) */
  ratio: number;
  detail: string;
}

export function fetchCatalog(): Promise<CatalogResult> {
  return apiGet<CatalogResult>('/api/mobile/catalog', { sid: syncSid() });
}

function stageText(stage: ImportStage, done: number, total: number): string {
  if (stage === 'packing') return total ? `电脑打包中 ${done}/${total}` : '电脑打包中…';
  if (stage === 'unpacking') return '正在写入本地书库…';
  if (stage === 'done') return '已可离线阅读';
  return total ? `下载中 ${Math.round((done / total) * 100)}%` : '下载中…';
}

/**
 * 大书在电脑端解包可能几十秒,而这段时间 HTTP 上一个字节都没有。
 * 轮询电脑的手机会话状态,把"打包中 120/3000 章"透给界面,否则用户只看到卡在 0%。
 */
interface SyncTask {
  name: string;
  size: number;
  sent: number;
  status: string;
}

const PACKING_RE = /^packing(?: (\d+)\/(\d+))?/;

function watchPacking(onStage?: (p: ImportProgress) => void): () => void {
  let stopped = false;
  let timer = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const data = await apiGet<{ session?: { tasks?: SyncTask[] } | null }>(
        '/api/sync_status',
        { sid: syncSid() },
      );
      const tasks = data.session?.tasks || [];
      const status = tasks.length ? tasks[tasks.length - 1].status || '' : '';
      const matched = PACKING_RE.exec(status);
      if (matched) {
        const done = Number(matched[1] || 0);
        const total = Number(matched[2] || 0);
        onStage?.({ stage: 'packing', done, total, ratio: -1, detail: stageText('packing', done, total) });
      }
    } catch {
      // 状态接口失败不影响下载本身
    }
    if (!stopped) timer = window.setTimeout(() => void tick(), 1500);
  };
  void tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/**
 * 导出一本书到本地。onStage 会先收到电脑端的打包进度(可能持续几十秒,
 * 大书是电脑在解 EPUB/PDF,不是手机在下载),再收到传输进度。
 */
export async function importBook(
  target: ImportTarget,
  onStage?: (p: ImportProgress) => void,
): Promise<LocalBook> {
  const server = getActiveServer();
  if (!server) throw new Error('请先连接电脑');
  const query: Record<string, string> = { kind: target.kind, sid: syncSid() };
  if (target.kind === 'comic') {
    query.title = target.title || '';
    query.file = target.file;
  } else {
    query.file = target.file;
  }

  const stopPackingWatch = watchPacking(onStage);
  let blob: Blob;
  try {
    blob = await apiDownload('/api/mobile/bundle', query, (received, total) => {
      onStage?.({
        stage: 'downloading',
        done: received,
        total,
        ratio: total ? Math.min(1, received / total) : 0,
        detail: stageText('downloading', received, total),
      });
    });
  } finally {
    stopPackingWatch();
  }

  onStage?.({ stage: 'unpacking', done: blob.size, total: blob.size, ratio: 1, detail: stageText('unpacking', 0, 0) });
  const zip = await JSZip.loadAsync(blob);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('离线包缺少 manifest,请让电脑重新打包');
  const manifest = JSON.parse(await manifestFile.async('string')) as BundleManifest;
  if ((manifest.bundle_version || 0) > SUPPORTED_BUNDLE_VERSION) {
    throw new Error('离线包版本过新,请把电脑端升级到最新版后重试');
  }

  const comic = manifest.kind === 'comic';
  const id = comic ? `comic:${manifest.title}/${manifest.file}` : `novel:${manifest.file}`;
  const previous = await getBook(id);
  if (previous) releaseZip(id); // 换包后旧的解包结果和它的 blob URL 都不能再用
  const book: LocalBook = {
    id,
    kind: comic ? 'comic' : 'novel',
    format: manifest.kind,
    title: manifest.title || (comic ? target.title || '' : manifest.file.replace(/\.[^.]+$/, '')),
    file: manifest.file,
    total: manifest.total || (comic ? manifest.num_pages || 0 : (manifest.chapters || []).length),
    chapters: manifest.chapters || [],
    assets: manifest.assets || {},
    coverArc: manifest.cover || '',
    size: blob.size,
    srcMtime: Math.round(manifest.src_mtime || 0),
    srcSize: manifest.src_size || 0,
    importedAt: Date.now(),
    serverId: server.id,
    serverName: server.name,
  };
  await saveChunk(id, blob);
  await putBook(book);
  onStage?.({ stage: 'done', done: blob.size, total: blob.size, ratio: 1, detail: stageText('done', 0, 0) });
  return book;
}

/** 重新拉一次离线包(电脑上这本书更新过时用)。 */
export function refreshBook(
  book: LocalBook,
  onStage?: (p: ImportProgress) => void,
): Promise<LocalBook> {
  return importBook(
    book.kind === 'comic'
      ? { kind: 'comic', file: book.file, title: book.title }
      : { kind: 'novel', file: book.file },
    onStage,
  );
}

/**
 * 电脑上的源文件是否比本地包新。
 * 只比 mtime+大小:电脑上重新下载过同一本书,这两个值一定会变。
 */
export function isOutdated(book: LocalBook, entry: { mtime: number; size: number } | undefined): boolean {
  if (!entry) return false;
  return entry.mtime > book.srcMtime + 1 || entry.size !== book.srcSize;
}
