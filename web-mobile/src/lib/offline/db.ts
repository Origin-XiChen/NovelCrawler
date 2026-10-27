/**
 * 本地内容存储(IndexedDB)
 * ==========================
 * 手机 App 的离线书架落在浏览器 IndexedDB 上,三张表:
 *   books    一本书的元数据 + 章节目录 + 资源映射(来自离线包 manifest.json)
 *   chunks   整本离线包 ZIP 原样存一份 Blob,读章节/取图都从这里现解
 *   progress 本地阅读进度,联网时按设备回传电脑
 *
 * 存 ZIP 而不是拆成一章一条记录:导入只需一次写入,删除一本书也只动两行,
 * 不会留下半截数据;读的时候 JSZip 解一次就常驻内存,翻页不再有 IO。
 */
import JSZip from 'jszip';

const DB_NAME = 'nc-offline';
const DB_VERSION = 2;
const STORE_BOOKS = 'books';
const STORE_CHUNKS = 'chunks';
const STORE_PROGRESS = 'progress';
const STORE_SOURCES = 'sources';

export interface ChapterRef {
  idx: number;
  title: string;
  volume?: string;
  path?: string;
}

export interface LocalBook {
  id: string;
  kind: 'novel' | 'comic';
  format: 'txt' | 'epub' | 'comic';
  title: string;
  file: string;
  total: number;
  chapters: ChapterRef[];
  /** EPUB 内部资源路径 → 包内 assets/xxx 归档名 */
  assets: Record<string, string>;
  coverArc: string;
  /** 离线包 ZIP 体积 */
  size: number;
  /** 电脑上源文件的 mtime/大小,用于判断"这本书有没有更新" */
  srcMtime: number;
  srcSize: number;
  importedAt: number;
  /** 下载来源,便于提示"来自哪台电脑" */
  serverId: string;
  serverName: string;
  /** download=从电脑下载,import=手机本地导入(可同步回电脑) */
  origin?: 'download' | 'import';
  /** 本地导入的书是否已经回传给电脑 */
  syncState?: 'pending' | 'done';
}

export interface LocalProgress {
  bookId: string;
  kind: 'novel' | 'comic';
  title: string;
  /** 章节标题原文,回传电脑后电脑能显示"读到第 X 章 标题" */
  chapter: string;
  ch: number;
  total: number;
  scroll: number;
  ts: number;
  /** 本地改过、还没成功回传电脑 */
  dirty: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这台设备不支持本地存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) db.createObjectStore(STORE_PROGRESS, { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains(STORE_SOURCES)) db.createObjectStore(STORE_SOURCES, { keyPath: 'id' });
    };
    request.onblocked = () => reject(new Error('本地书库被其他页面占用,请关闭旧的标签页'));
    request.onerror = () => reject(request.error || new Error('本地书库打开失败'));
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = body(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error || new Error('本地存储读写失败'));
      }),
  );
}

/**
 * Android WebView 默认会把 IndexedDB 当可回收缓存清掉(存储紧张时)。
 * 申请持久化配额,离线书才不会"某天突然没了"。失败不影响功能,只是不再可靠。
 */
export async function ensurePersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}

export async function storageQuota(): Promise<{ used: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { used: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return null;
  }
}

export function putBook(book: LocalBook): Promise<LocalBook> {
  return run<LocalBook>(STORE_BOOKS, 'readwrite', (s) => s.put(book));
}

export function getBook(id: string): Promise<LocalBook | undefined> {
  return run<LocalBook | undefined>(STORE_BOOKS, 'readonly', (s) => s.get(id));
}

export function allBooks(): Promise<LocalBook[]> {
  return run<LocalBook[]>(STORE_BOOKS, 'readonly', (s) => s.getAll());
}

export function putProgress(record: LocalProgress): Promise<LocalProgress> {
  return run<LocalProgress>(STORE_PROGRESS, 'readwrite', (s) => s.put(record));
}

export function getProgress(bookId: string): Promise<LocalProgress | undefined> {
  return run<LocalProgress | undefined>(STORE_PROGRESS, 'readonly', (s) => s.get(bookId));
}

export function allProgress(): Promise<LocalProgress[]> {
  return run<LocalProgress[]>(STORE_PROGRESS, 'readonly', (s) => s.getAll());
}

async function deleteFrom(store: string, key: string): Promise<void> {
  await run<IDBRequest>(store, 'readwrite', (s) => s.delete(key));
}

/** 删掉一本书:内容 ZIP、原始文件、进度一起走,不留孤儿数据。 */
export async function removeBookData(id: string): Promise<void> {
  releaseZip(id);
  await deleteFrom(STORE_BOOKS, id);
  await deleteFrom(STORE_CHUNKS, id);
  await deleteFrom(STORE_PROGRESS, id);
  await deleteFrom(STORE_SOURCES, id);
}

/** 本地导入时保留原始 EPUB/TXT,同步回电脑时上传的就是它 */
export async function saveSource(id: string, data: Blob): Promise<void> {
  await run<IDBRequest>(STORE_SOURCES, 'readwrite', (s) => s.put({ id, data }));
}

export async function loadSource(id: string): Promise<Blob | null> {
  const row = await run<{ id: string; data: Blob } | undefined>(
    STORE_SOURCES,
    'readonly',
    (s) => s.get(id),
  );
  return row?.data || null;
}

export async function saveChunk(id: string, data: Blob): Promise<void> {
  await run<IDBRequest>(STORE_CHUNKS, 'readwrite', (s) => s.put({ id, data }));
}

export async function loadChunk(id: string): Promise<Blob | null> {
  const row = await run<{ id: string; data: Blob } | undefined>(STORE_CHUNKS, 'readonly', (s) => s.get(id));
  return row?.data || null;
}

// ---------------- ZIP 常驻缓存 ----------------
const zipCache = new Map<string, Promise<JSZip>>();

/** 一本书的 ZIP 只解一次;并发调用共享同一个解包 Promise。 */
export function zipOf(id: string): Promise<JSZip> {
  const cached = zipCache.get(id);
  if (cached) return cached;
  const next = loadChunk(id).then((blob) => {
    if (!blob) throw new Error('本地内容已丢失,请重新下载');
    return JSZip.loadAsync(blob);
  });
  zipCache.set(id, next);
  next.catch(() => zipCache.delete(id));
  return next;
}

export function releaseZip(id: string): void {
  zipCache.delete(id);
}
