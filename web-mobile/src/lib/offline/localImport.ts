/**
 * 本地导入:手机自己选中的 EPUB/TXT 在浏览器里解析成与电脑端离线包
 * 相同的结构(manifest + chapters + assets),旧离线 ZIP 则原样入库。
 * 读章节/图片仍然只走 db.ts + reading.ts,不另开一套阅读逻辑。
 */
import JSZip from 'jszip';
import { putBook, releaseZip, saveChunk, saveSource, type ChapterRef, type LocalBook } from './db';

const BUNDLE_VERSION = 1;

/** 与 reading.ts 的 ASSET_RE 同一条规则 */
const ASSET_RE = /\/api\/epub_asset\?[^"'()\s]*?[&?]path=([^"'()\s)]+)/g;

interface BundleManifest {
  bundle_version: number;
  kind: 'txt' | 'epub' | 'comic' | 'snapshot';
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
  meta?: unknown;
  /** kind==="snapshot":电脑端「整包离线」里装了多本书 */
  books?: SnapshotBook[];
  /** 同一个包里附带的漫画(按页图打包) */
  comics?: SnapshotComic[];
}

interface SnapshotComic {
  title: string;
  /** 包内目录,形如 comics/<URL编码标题> */
  dir: string;
  pages: number;
  /** 每话起始页(1 基)与页数,供目录/按话跳转 */
  chapters?: { label: string; from: number; pages: number }[];
}

interface SnapshotBook {
  file: string;
  title?: string;
  size?: number;
  chapters?: number;
  has_data?: boolean;
  data: string;
  /** 包内封面路径(covers/xxx),没有则由 App 用首字渐变兜底 */
  cover?: string;
}

export interface LocalImportProgress {
  /** 当前第几个文件(从 1 开始) */
  index: number;
  total: number;
  name: string;
  detail: string;
}

export interface LocalImportOutcome {
  imported: LocalBook[];
  failed: { name: string; error: string }[];
}

export async function importLocalFiles(
  files: File[],
  onProgress?: (p: LocalImportProgress) => void,
): Promise<LocalImportOutcome> {
  const outcome: LocalImportOutcome = { imported: [], failed: [] };
  const usable = files.filter((file) => file && file.size > 0);
  for (let i = 0; i < usable.length; i += 1) {
    const file = usable[i];
    onProgress?.({
      index: i + 1,
      total: usable.length,
      name: file.name,
      detail: `正在解析 ${i + 1}/${usable.length}`,
    });
    try {
      outcome.imported.push(await importLocalFile(file));
    } catch (cause) {
      outcome.failed.push({
        name: file.name,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return outcome;
}

export function importLocalFile(file: File): Promise<LocalBook> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) return importBundleZip(file);
  if (name.endsWith('.epub')) return importEpub(file);
  if (name.endsWith('.txt')) return importTxt(file);
  return Promise.reject(new Error('只支持 EPUB、TXT 和 NovelCrawler 离线 ZIP'));
}

// ---------------- 旧离线 ZIP:已经是目标结构,直接入库 ----------------

async function importBundleZip(file: File): Promise<LocalBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('ZIP 解析失败,文件可能已损坏');
  }
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('这个 ZIP 里没有 manifest.json,不是 NovelCrawler 离线包');
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(await manifestFile.async('string')) as BundleManifest;
  } catch {
    throw new Error('manifest.json 内容损坏');
  }
  // 整包快照走自己的 schema,不受 bundle_version 约束 —— 它只是"一包多本"的容器。
  // 这一步必须放在版本校验之前,否则 pack 端写了更高版本号就会被误判为"包太新"。
  if (manifest.kind === 'snapshot') {
    // 电脑端整包快照:多本书共用一个 zip,章节在 data/<书名>.json 里。
    // 这里按 App 的 bundle 布局(chapters/NNNNN.json)给每本书重新打包一份,
    // 之后的阅读/进度逻辑与普通导入完全一致。
    const imported = await importSnapshotZip(zip, manifest);
    if (!imported.length) throw new Error('离线包里没有可导入的书');
    // 包里可能附带了原文件(EPUB/PDF),App 只读正文与页图,这里只是让用户知道体积花在哪
    if (Object.keys(zip.files).some((name) => name.startsWith('files/'))) {
      console.info('[import] 离线包包含原文件目录 files/,已忽略(仅内置 HTML 阅读器使用)');
    }
    return imported[0];
  }
  if ((manifest.bundle_version || 0) > BUNDLE_VERSION) {
    throw new Error('离线包版本过新,请先把手机 App 升级到最新版');
  }
  if (!manifest.kind || !manifest.file) throw new Error('manifest.json 缺少必要字段');

  const comic = manifest.kind === 'comic';
  const id = comic
    ? manifest.id || `comic:${manifest.title}/${manifest.file}`
    : `novel:${manifest.file}`;
  const total =
    manifest.total || (comic ? manifest.num_pages || 0 : (manifest.chapters || []).length);
  if (!total) throw new Error('离线包是空的');

  const title =
    manifest.title ||
    (comic ? manifest.file : manifest.file.replace(/\.[^.]+$/, ''));
  const book: LocalBook = {
    id,
    kind: comic ? 'comic' : 'novel',
    format: manifest.kind,
    title,
    file: manifest.file,
    total,
    chapters: manifest.chapters || [],
    assets: manifest.assets || {},
    coverArc: manifest.cover || '',
    size: file.size,
    srcMtime: Math.round(manifest.src_mtime || 0),
    srcSize: manifest.src_size || 0,
    importedAt: Date.now(),
    serverId: '',
    serverName: '本地导入',
    origin: 'import',
  };
  releaseZip(id);
  await saveChunk(id, file);
  await putBook(book);
  return book;
}

// ---------------- EPUB:浏览器内解析,重建离线包 ----------------

async function importEpub(file: File): Promise<LocalBook> {
  const zip = await JSZip.loadAsync(file);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB(缺少 META-INF/container.xml)');
  const container = parseXml(await containerFile.async('string'));
  const rootfile = elements(container, 'rootfile')[0];
  const opfPath = normalizePath(rootfile?.getAttribute('full-path') || '');
  const opfFile = opfPath ? zip.file(opfPath) : null;
  if (!opfFile) throw new Error('EPUB 的 OPF 文件缺失或损坏');

  const opf = parseXml(await opfFile.async('string'));
  const base = posixDir(opfPath);
  const items = elements(opf, 'item');
  const manifest = new Map<string, { path: string; properties: string }>();
  for (const item of items) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      path: resolvePath(base, href),
      properties: item.getAttribute('properties') || '',
    });
  }
  const spine = elements(opf, 'itemref')
    .map((item) => item.getAttribute('idref') || '')
    .filter(Boolean);

  const rawChapters: { path: string; raw: string }[] = [];
  for (const idref of spine) {
    const entry = manifest.get(idref);
    if (!entry) continue;
    const chapterFile = zip.file(entry.path);
    if (!chapterFile) continue;
    rawChapters.push({ path: entry.path, raw: await decodeZipText(chapterFile) });
  }
  if (!rawChapters.length) throw new Error('EPUB 里没有可读的正文章节');

  const output = new JSZip();
  const assets: Record<string, string> = {};
  const chapters: ChapterRef[] = [];
  const pendingAssets: { path: string; arc: string }[] = [];

  const addAsset = (path: string): string => {
    const existing = assets[path];
    if (existing) return existing;
    if (!zip.file(path)) return ''; // 资源缺失:正文照读,坏图由阅读器兜底
    const ext = assetExt(path);
    const arc = `assets/${String(Object.keys(assets).length + 1).padStart(4, '0')}${ext}`;
    assets[path] = arc;
    pendingAssets.push({ path, arc });
    return arc;
  };

  const writeChapter = (idx: number, title: string, html: string, text: string) => {
    output.file(
      chapterName(idx),
      JSON.stringify({ idx, title, html, text }),
    );
    chapters.push({ idx, title });
  };

  let cover = '';
  const titleTag = elements(opf, 'title')[0]?.textContent?.trim() || '';

  // 单文件 EPUB(旧版导出)按 <h2 id="cN"> 锚点分章,与电脑端规则一致
  if (rawChapters.length === 1) {
    const single = rawChapters[0];
    const anchors = [...single.raw.matchAll(/<h2[^>]*id=["']c\d+["'][^>]*>([\s\S]*?)<\/h2>/gi)];
    if (anchors.length > 1) {
      const starts = anchors.map((a) => a.index || 0);
      for (let k = 0; k < anchors.length; k += 1) {
        const segment = single.raw.slice(starts[k], starts[k + 1] ?? single.raw.length);
        const heading = stripTags(anchors[k][1]).trim() || `第${k + 1}章`;
        const html = await processEpubChapter(segment, single.path, zip);
        collectAssets(html, addAsset);
        writeChapter(k + 1, heading, html, stripHtml(segment));
      }
      rawChapters.length = 0;
    }
  }

  for (const chapter of rawChapters) {
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(chapter.raw);
    const title = titleMatch?.[1]?.trim() || `第${chapters.length + 1}章`;
    const html = await processEpubChapter(chapter.raw, chapter.path, zip);
    collectAssets(html, addAsset);
    if (!cover) {
      const first = [...html.matchAll(ASSET_RE)]
        .map((m) => safeDecode(m[1]))
        .find((p) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(p) && /cover/i.test(p));
      if (first) cover = addAsset(first);
    }
    writeChapter(chapters.length + 1, title, html, stripHtml(chapter.raw));
  }

  const coverPath = epubCoverPath(opf, manifest, base);
  if (coverPath && !assets[coverPath]) {
    const arc = addAsset(coverPath);
    if (!cover) cover = arc;
  }

  for (const asset of pendingAssets) {
    const entry = zip.file(asset.path);
    if (!entry) continue;
    output.file(asset.arc, await entry.async('uint8array'), { compression: 'STORE' });
  }

  const title = titleTag || fileTitle(file.name);
  const manifestData: BundleManifest = {
    bundle_version: BUNDLE_VERSION,
    kind: 'epub',
    id: `novel:${file.name}`,
    title,
    file: file.name,
    chapters,
    total: chapters.length,
    assets,
    cover,
    src_size: file.size,
    src_mtime: Math.round((file.lastModified || Date.now()) / 1000),
    generated: Math.floor(Date.now() / 1000),
  };
  output.file('manifest.json', JSON.stringify(manifestData, null, 2));
  const blob = await output.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return persistBundle(manifestData, blob, file);
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('EPUB 的 XML 格式损坏');
  }
  return doc;
}

/** 按 localName 取元素,兼容各家不规范的命名空间写法 */
function elements(root: Document | Element, localName: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.localName === localName) out.push(child);
      walk(child);
    }
  };
  if (root.nodeType === 9) {
    const doc = root as Document;
    if (doc.documentElement) walk(doc.documentElement);
  } else {
    walk(root as Element);
  }
  return out;
}

async function decodeZipText(file: JSZip.JSZipObject): Promise<string> {
  const bytes = await file.async('uint8array');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function posixDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolvePath(baseDir: string, href: string): string {
  const clean = href.split('#')[0];
  return normalizePath(baseDir ? `${baseDir}/${clean}` : clean);
}

/** 与电脑端 quote() 一致:括号/单引号也编码,避免打断阅读器的资源地址正则 */
function assetUrl(path: string): string {
  return `/api/epub_asset?file=local&path=${encodeURIComponent(path).replace(
    /[()']/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

function assetExt(path: string): string {
  const match = /(\.[^./\\]{1,6})$/.exec(path);
  return match ? match[1].toLowerCase() : '.bin';
}

function isExternal(src: string): boolean {
  return /^(data:|https?:|\/\/|blob:)/i.test(src);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectAssets(html: string, add: (path: string) => string): void {
  for (const match of html.matchAll(ASSET_RE)) add(safeDecode(match[1]));
}

function replaceAttr(attrs: string, attr: string, value: string): string {
  const re = new RegExp(`(${attr}\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = re.exec(attrs);
  if (!match) return attrs;
  return attrs.slice(0, match.index) + `${attr}="${value}"` + attrs.slice(match.index + match[0].length);
}

function rewriteSrc(attrs: string, chapterPath: string, attr = 'src'): string {
  const re = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = re.exec(attrs);
  if (!match) return attrs;
  const src = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  if (!src || isExternal(src)) return attrs;
  const full = resolvePath(posixDir(chapterPath), src);
  return replaceAttr(attrs, attr, assetUrl(full));
}

function rewriteCssUrls(css: string, cssPath: string): string {
  const base = posixDir(cssPath);
  return css.replace(/url\(\s*(['"]?)([^'")\s]*)\1\s*\)/gi, (whole, quote: string, inner: string) => {
    const value = (inner || '').trim();
    if (!value || isExternal(value) || value.startsWith('/')) return whole;
    return `url(${quote}${assetUrl(resolvePath(base, value))}${quote})`;
  });
}

async function processEpubChapter(raw: string, chapterPath: string, zip: JSZip): Promise<string> {
  const styleBlocks = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  for (const link of raw.matchAll(
    /<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi,
  )) {
    const href = link[1];
    if (isExternal(href)) continue;
    const cssPath = resolvePath(posixDir(chapterPath), href);
    const cssFile = zip.file(cssPath);
    if (!cssFile) continue;
    const css = rewriteCssUrls(await decodeZipText(cssFile), cssPath);
    styleBlocks.push(css);
  }

  let html = raw.replace(/<(script|head|nav)[\s\S]*?<\/\1>/gi, '');
  if (styleBlocks.length) {
    const safe = styleBlocks
      .join('\n')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/\bfont-family\s*:\s*[^;}]+;?/gi, '')
      .replace(/(?<![\w-])\bfont\s*:\s*[^;}]+;?/gi, '');
    html = `<style>${safe}</style>\n${html}`;
  }
  html = html.replace(/<\/?(html|body)[^>]*>/gi, '');
  html = html.replace(/<img([^>]*)>/gi, (_whole, attrs: string) => `<img${rewriteSrc(attrs, chapterPath)}>`);
  html = html.replace(/<audio([^>]*)>/gi, (_whole, attrs: string) => `<audio${rewriteSrc(attrs, chapterPath)}>`);
  html = html.replace(/<video([^>]*)>/gi, (_whole, attrs: string) => `<video${rewriteSrc(attrs, chapterPath)}>`);
  html = html.replace(/<source([^>]*)>/gi, (_whole, attrs: string) => `<source${rewriteSrc(attrs, chapterPath)}>`);
  html = html.replace(/<image([^>]*)>/gi, (_whole, attrs: string) => {
    const attr = /\bxlink:href\s*=/i.test(attrs) ? 'xlink:href' : 'href';
    return `<image${rewriteSrc(attrs, chapterPath, attr)}>`;
  });
  html = html.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, _a, double, single, bare) => {
    const value = String(double ?? single ?? bare ?? '').trim().toLowerCase();
    return value.startsWith('javascript:') || value.startsWith('vbscript:') ? '' : whole;
  });
  return html;
}

function stripHtml(html: string): string {
  const withBreaks = html
    .replace(/<(script|style|head|nav)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const doc = new DOMParser().parseFromString(`<body>${withBreaks}</body>`, 'text/html');
  const text = doc.body.textContent || '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function epubCoverPath(
  opf: Document,
  manifest: Map<string, { path: string; properties: string }>,
  base: string,
): string {
  const coverItem = elements(opf, 'item').find((item) =>
    (item.getAttribute('properties') || '').split(/\s+/).includes('cover-image'),
  );
  if (coverItem) {
    const href = coverItem.getAttribute('href');
    if (href) return resolvePath(base, href);
  }
  const meta = elements(opf, 'meta').find((item) => item.getAttribute('name') === 'cover');
  const refId = meta?.getAttribute('content')?.trim();
  return refId ? manifest.get(refId)?.path || '' : '';
}

// ---------------- TXT:识别电脑端章节标记,没有标记就整本当一章 ----------------

async function importTxt(file: File): Promise<LocalBook> {
  const bytes = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\uFFFD') || looksGarbled(text)) {
    try {
      text = new TextDecoder('gb18030').decode(bytes);
    } catch {
      // UTF-8 结果已经是最好的一版
    }
  }
  text = text.replace(/^\uFEFF/, '');
  const title = fileTitle(file.name);
  const chapters = parseTxtChapters(text, title);
  if (!chapters.length) throw new Error('TXT 里没有找到正文');

  const output = new JSZip();
  const toc: ChapterRef[] = [];
  chapters.forEach((chapter, index) => {
    const idx = index + 1;
    output.file(chapterName(idx), JSON.stringify({ idx, title: chapter.title, text: chapter.text }));
    toc.push({ idx, title: chapter.title });
  });
  const manifestData: BundleManifest = {
    bundle_version: BUNDLE_VERSION,
    kind: 'txt',
    id: `novel:${file.name}`,
    title,
    file: file.name,
    chapters: toc,
    total: toc.length,
    assets: {},
    cover: '',
    src_size: file.size,
    src_mtime: Math.round((file.lastModified || Date.now()) / 1000),
    generated: Math.floor(Date.now() / 1000),
  };
  output.file('manifest.json', JSON.stringify(manifestData, null, 2));
  const blob = await output.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return persistBundle(manifestData, blob, file);
}

/** 解出来大量替换符通常是编码猜错了,给 GB18030 一次机会 */
function looksGarbled(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample) return false;
  let bad = 0;
  for (const char of sample) {
    if (char === '\uFFFD') bad += 1;
  }
  return bad / sample.length > 0.005;
}

function parseTxtChapters(text: string, fallbackTitle: string): { title: string; text: string }[] {
  const chapters: { title: string; text: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^【章节】第(?:\d+|[一二三四五六七八九十百千零两]+)章$/.test(line)) {
      if (current) chapters.push({ title: current.title, text: current.lines.join('\n').trim() });
      current = { title: '', lines: [] };
      continue;
    }
    if (!current) continue;
    const head = /^==\s*(.+?)\s*==$/.exec(line);
    if (head && !current.title) {
      current.title = head[1].trim();
      continue;
    }
    current.lines.push(raw);
  }
  if (current) chapters.push({ title: current.title, text: current.lines.join('\n').trim() });
  if (!chapters.length) return [{ title: fallbackTitle, text: text.trim() }];
  return chapters.filter((chapter) => chapter.text);
}

function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function chapterName(idx: number): string {
  return `chapters/${String(idx).padStart(5, '0')}.json`;
}

async function persistBundle(manifest: BundleManifest, blob: Blob, file: File): Promise<LocalBook> {
  const id = `novel:${manifest.file}`;
  const book: LocalBook = {
    id,
    kind: 'novel',
    format: manifest.kind === 'epub' ? 'epub' : 'txt',
    title: manifest.title,
    file: manifest.file,
    total: manifest.total,
    chapters: manifest.chapters,
    assets: manifest.assets,
    coverArc: manifest.cover,
    size: file.size,
    srcMtime: Math.round((file.lastModified || Date.now()) / 1000),
    srcSize: file.size,
    importedAt: Date.now(),
    serverId: '',
    serverName: '本地导入',
    origin: 'import',
    syncState: 'pending',
  };
  releaseZip(id);
  await saveChunk(id, blob);
  await saveSource(id, file);
  await putBook(book);
  return book;
}

// ---------------- 电脑端整包快照:一包多本,拆成各自的 bundle ----------------

async function importSnapshotZip(zip: JSZip, manifest: BundleManifest): Promise<LocalBook[]> {
  const out: LocalBook[] = [];
  for (const item of manifest.books || []) {
    if (!item?.file || !item?.data) continue;
    // 包内文件名有两套写法:ZIP 条目用原始文件名,manifest 里是 URL 编码的。
    // 两种都试一遍(并且 .json / .js 都试),否则会「一条都没匹配上」。
    let entry: JSZip.JSZipObject | null = null;
    const seen = new Set<string>();
    for (const base of [item.data, decodeURIComponent(item.data)]) {
      for (const name of [base, base.replace(/\.json$/i, '.js')]) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const hit = zip.file(name);
        if (hit) { entry = hit; break; }
      }
      if (entry) break;
    }
    if (!entry) continue;
    const jsonEntry = /\.json$/i.test((entry as JSZip.JSZipObject).name);
    let chapters: { title?: string; text?: string; html?: string }[] = [];
    try {
      const raw = await entry.async('string');
      const text = jsonEntry ? raw : raw.slice(raw.lastIndexOf('=') + 1).replace(/;\s*$/, '');
      const payload = JSON.parse(text) as { chapters?: typeof chapters };
      chapters = payload.chapters || [];
    } catch {
      continue;
    }
    if (!chapters.length) continue;

    // 格式必须按真实内容判断:EPUB 的章节只有 html 没有 text,
    // 若一律标成 txt,阅读器会渲染 text → 整页空白(真实事故)。
    const isEpub = /\.epub$/i.test(item.file) || chapters.some((c) => !!c.html);
    const fmt: 'txt' | 'epub' = isEpub ? 'epub' : 'txt';
    const id = `novel:${item.file}`;
    // 封面:整包里自带 covers/xxx,先读出来,后面写内层 manifest 时要引用它
    let coverBytes: Uint8Array | null = null;
    let coverArc = '';
    if (item.cover) {
      const coverFile = zip.file(item.cover) || zip.file(decodeURIComponent(item.cover));
      if (coverFile) {
        coverBytes = await coverFile.async('uint8array');
        coverArc = 'cover.jpg';
      }
    }
    // 重新打包成 App 认的布局:manifest.json + chapters/00001.json
    const bundle = new JSZip();
    bundle.file('manifest.json', JSON.stringify({
      bundle_version: 1,
      kind: fmt,
      id,
      title: item.title || item.file.replace(/\.[^.]+$/, ''),
      file: item.file,
      chapters: chapters.map((c, i) => ({ idx: i + 1, title: c.title || `第${i + 1}章` })),
      total: chapters.length,
      assets: {},
      cover: coverArc,
      src_size: item.size || 0,
      src_mtime: 0,
      generated: Math.floor(Date.now() / 1000),
    }));
    if (coverBytes) bundle.file('cover.jpg', coverBytes);
    chapters.forEach((c, i) => {
      bundle.file(`chapters/${String(i + 1).padStart(5, '0')}.json`, JSON.stringify(c));
    });
    const blob = await bundle.generateAsync({ type: 'blob' });

    const book: LocalBook = {
      id,
      kind: 'novel',
      format: fmt,
      title: item.title || item.file.replace(/\.[^.]+$/, ''),
      file: item.file,
      total: chapters.length,
      chapters: chapters.map((c, i) => ({ idx: i + 1, title: c.title || `第${i + 1}章` })),
      assets: {},
      coverArc,
      size: item.size || blob.size,
      srcMtime: 0,
      srcSize: item.size || 0,
      importedAt: Date.now(),
      serverId: '',
      serverName: '本地导入',
      origin: 'import',
    };
    releaseZip(id);
    await saveChunk(id, blob);
    await putBook(book);
    out.push(book);
  }
  // ---- 漫画:整包里是 comics/<标题>/pages/NNNN.jpg,拆成 comic bundle ----
  for (const comic of manifest.comics || []) {
    if (!comic?.title || !comic?.dir) continue;
    const prefix = `${comic.dir.replace(/\/+$/, '')}/pages/`;
    const pages = Object.keys(zip.files)
      .filter((n) => n.startsWith(prefix) && !zip.files[n].dir)
      .sort();
    if (!pages.length) continue;

    const id = `comic:${comic.title}`;
    const bundle = new JSZip();
    bundle.file('manifest.json', JSON.stringify({
      bundle_version: 1,
      kind: 'comic',
      id,
      title: comic.title,
      file: `${comic.title}/`,
      chapters: (comic.chapters || []).map((ch, i) => ({
        idx: i + 1,
        title: ch.label,
        path: `pages/${String(ch.from).padStart(4, '0')}.jpg`,
      })),
      total: pages.length,
      num_pages: pages.length,
      assets: {},
      cover: 'pages/0001.jpg',
      src_size: 0,
      src_mtime: 0,
      generated: Math.floor(Date.now() / 1000),
    }));
    for (let i = 0; i < pages.length; i += 1) {
      const pageFile = zip.file(pages[i]);
      if (!pageFile) continue;
      bundle.file(`pages/${String(i + 1).padStart(4, '0')}.jpg`, await pageFile.async('uint8array'));
    }
    const blob = await bundle.generateAsync({ type: 'blob' });

    const book: LocalBook = {
      id,
      kind: 'comic',
      format: 'comic',
      title: comic.title,
      file: `${comic.title}/`,
      total: pages.length,
      chapters: [],
      assets: {},
      coverArc: 'pages/0001.jpg',
      size: blob.size,
      srcMtime: 0,
      srcSize: 0,
      importedAt: Date.now(),
      serverId: '',
      serverName: '本地导入',
      origin: 'import',
    };
    releaseZip(id);
    await saveChunk(id, blob);
    await putBook(book);
    out.push(book);
  }

  // 兜底:manifest 缺 books 或名字全对不上时,直接扫 data/ 目录按文件名恢复。
  // 宁可多一次遍历,也不要让用户看到「没有可导入的书」。
  if (!out.length) {
    const names = Object.keys(zip.files).filter(
      (n) => /^data\/[^/]+\.(json|js)$/i.test(n) && !zip.files[n].dir,
    );
    const grouped = new Map<string, string>();
    for (const n of names) {
      const key = n.replace(/\.(json|js)$/i, '');
      if (!grouped.has(key) || /\.json$/i.test(n)) grouped.set(key, n);
    }
    for (const [key, entryName] of grouped) {
      const entry = zip.file(entryName);
      if (!entry) continue;
      const raw = await entry.async('string');
      const text = /\.json$/i.test(entryName) ? raw : raw.slice(raw.lastIndexOf('=') + 1).replace(/;\s*$/, '');
      let chapters: { title?: string; text?: string; html?: string }[] = [];
      try {
        chapters = ((JSON.parse(text) as { chapters?: typeof chapters }).chapters) || [];
      } catch {
        continue;
      }
      if (!chapters.length) continue;
      const fileName = decodeURIComponent(key.split('/').pop() || key);
      const id = `novel:${fileName}`;
      const bundle = new JSZip();
      bundle.file('manifest.json', JSON.stringify({
        bundle_version: 1, kind: 'txt', id, title: fileName.replace(/\.[^.]+$/, ''),
        file: fileName,
        chapters: chapters.map((c, i) => ({ idx: i + 1, title: c.title || `第${i + 1}章` })),
        total: chapters.length, assets: {}, cover: '', src_size: 0, src_mtime: 0,
        generated: Math.floor(Date.now() / 1000),
      }));
      chapters.forEach((c, i) => {
        bundle.file(`chapters/${String(i + 1).padStart(5, '0')}.json`, JSON.stringify(c));
      });
      const blob = await bundle.generateAsync({ type: 'blob' });
      const book: LocalBook = {
        id, kind: 'novel', format: 'txt', title: fileName.replace(/\.[^.]+$/, ''),
        file: fileName, total: chapters.length,
        chapters: chapters.map((c, i) => ({ idx: i + 1, title: c.title || `第${i + 1}章` })),
        assets: {}, coverArc: '', size: blob.size, srcMtime: 0, srcSize: 0,
        importedAt: Date.now(), serverId: '', serverName: '本地导入', origin: 'import',
      };
      releaseZip(id);
      await saveChunk(id, blob);
      await putBook(book);
      out.push(book);
    }
  }
  return out;
}
