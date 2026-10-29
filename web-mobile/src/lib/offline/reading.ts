/**
 * 本地内容读取:从离线包 ZIP 里取章节正文、漫画页与封面。
 * 全程不联网;EPUB 的图片/字体地址换成 blob,和电脑端渲染结果一致。
 */
import { getBook, getProgress, putProgress, releaseZip, zipOf, type LocalBook, type LocalProgress } from './db';
import { scheduleSync } from './sync';

/** 与 novel/mobile_bundle.py 的 _ASSET_RE 同一条规则 */
const ASSET_RE = /\/api\/epub_asset\?[^"'()\s]*?[&?]path=([^"'()\s)]+)/g;

const assetUrls = new Map<string, string>();
const pageUrls = new Map<string, string>();
// 连续滚动一次会同时显示当前页前后若干页,窗口取 9;缓存留一倍余量,
// 避免刚滚过的页被淘汰后 blob URL 失效
const PAGE_CACHE_SIZE = 18;

function arcKey(bookId: string, arc: string): string {
  return `${bookId}::${arc}`;
}

async function blobUrlOf(bookId: string, arc: string): Promise<string> {
  const key = arcKey(bookId, arc);
  const cached = assetUrls.get(key);
  if (cached) return cached;
  const zip = await zipOf(bookId);
  const file = zip.file(arc);
  if (!file) throw new Error(`离线包缺少 ${arc}`);
  const blob = await file.async('blob');
  const url = URL.createObjectURL(blob);
  assetUrls.set(key, url);
  return url;
}

/** 漫画页用 LRU:一页几百 KB,整本缓存会把内存吃掉。 */
async function pageUrlOf(bookId: string, arc: string): Promise<string> {
  const key = arcKey(bookId, arc);
  const cached = pageUrls.get(key);
  if (cached) {
    // 命中即"最近用过":删掉再插回,保持顺序
    pageUrls.delete(key);
    pageUrls.set(key, cached);
    return cached;
  }
  const zip = await zipOf(bookId);
  const file = zip.file(arc);
  if (!file) throw new Error(`离线包缺少第 ${arc} 页`);
  const url = URL.createObjectURL(await file.async('blob'));
  pageUrls.set(key, url);
  while (pageUrls.size > PAGE_CACHE_SIZE) {
    const oldest = pageUrls.keys().next().value;
    if (!oldest) break;
    const stale = pageUrls.get(oldest);
    pageUrls.delete(oldest);
    if (stale) URL.revokeObjectURL(stale);
  }
  return url;
}

export interface LocalChapter {
  idx: number;
  title: string;
  text: string;
  html: string;
}

function chapterName(idx: number): string {
  return `chapters/${String(idx).padStart(5, '0')}.json`;
}

/**
 * 读一本本地小说的某章。EPUB 的 html 里资源地址换成本地 blob,
 * 章节 JSON 的格式由电脑端 novel/mobile_bundle.py 决定(两端只有一处解析逻辑)。
 */
export async function readLocalChapter(book: LocalBook, idx: number): Promise<LocalChapter> {
  const zip = await zipOf(book.id);
  const file = zip.file(chapterName(idx));
  if (!file) throw new Error('这一章不在本地包里,请重新下载这本书');
  const raw = JSON.parse(await file.async('string')) as {
    idx?: number;
    title?: string;
    text?: string;
    html?: string;
  };
  let html = raw.html || '';
  if (html && book.format === 'epub') {
    const map = new Map<string, string>();
    const paths = new Set<string>();
    for (const match of html.matchAll(ASSET_RE)) {
      try {
        paths.add(decodeURIComponent(match[1]));
      } catch {
        paths.add(match[1]);
      }
    }
    for (const path of paths) {
      const arc = book.assets[path];
      if (!arc) continue;
      // 单张图缺失只让那张图坏掉,正文照常读
      try {
        map.set(path, await blobUrlOf(book.id, arc));
      } catch {
        map.set(path, '');
      }
    }
    html = html.replace(ASSET_RE, (whole, encoded: string) => {
      let path = encoded;
      try {
        path = decodeURIComponent(encoded);
      } catch {
        // 电脑没编码的少数情况按原样查
      }
      return map.get(path) ?? whole;
    });
  }
  return {
    idx: raw.idx ?? idx,
    title: raw.title || `第 ${idx} 章`,
    text: raw.text || '',
    html,
  };
}

export function localComicPageUrl(book: LocalBook, page: number): Promise<string> {
  return pageUrlOf(book.id, `pages/${String(page).padStart(4, '0')}.jpg`);
}

/** 封面:小说取 manifest.cover(可能是 EPUB 声明的封面图),漫画取第一页。 */
export async function localCoverUrl(book: LocalBook): Promise<string> {
  if (!book.coverArc) return '';
  return book.kind === 'comic'
    ? pageUrlOf(book.id, book.coverArc)
    : blobUrlOf(book.id, book.coverArc);
}

/** 阅读器只拿目录,不必解包:manifest 已存在 books 表里。 */
export function localBook(id: string): Promise<LocalBook | undefined> {
  return getBook(id);
}

/** 删书时把这本书的 blob 地址全部释放,否则图片一直占着内存。 */
export function releaseBookAssets(bookId: string): void {
  const prefix = `${bookId}::`;
  for (const [key, url] of [...assetUrls, ...pageUrls]) {
    if (!key.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    if (assetUrls.has(key)) assetUrls.delete(key);
    if (pageUrls.has(key)) pageUrls.delete(key);
  }
  releaseZip(bookId);
}

export interface LocalProgressInput {
  ch: number;
  total: number;
  chapterTitle?: string;
  scroll?: number;
  chapters?: Record<string, number>;
}

/** 读到哪了就记一笔,并标成"待回传"。联网时由 syncProgress 送给电脑。 */
export async function writeLocalProgress(book: LocalBook, input: LocalProgressInput): Promise<void> {
  const previous = await getProgress(book.id);
  const chapters: Record<string, number> = { ...(previous?.chapters || {}) };
  for (const [key, value] of Object.entries(input.chapters || {})) {
    const ratio = Math.min(1, Math.max(0, Number(value) || 0));
    if (ratio >= 0.98) chapters[key] = 1;
    else if (ratio > 0) chapters[key] = Math.max(chapters[key] || 0, ratio);
  }
  scheduleSync();
  await putProgress({
    bookId: book.id,
    kind: book.kind,
    title: book.title,
    chapter: input.chapterTitle || previous?.chapter || '',
    ch: Math.max(0, Math.round(input.ch)),
    total: Math.max(0, Math.round(input.total)),
    scroll: Math.min(1, Math.max(0, input.scroll || 0)),
    chapters,
    ts: Date.now(),
    dirty: true,
  });
}

export function readLocalProgress(bookId: string): Promise<LocalProgress | undefined> {
  return getProgress(bookId);
}
