import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Images,
  Library,
  List,
  Maximize2,
  Minimize2,
  Moon,
  RefreshCw,
  Search,
  Star,
  Sun,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { apiGet, apiPost, coverSrc } from '../lib/api';
import { formatBytes, relativeTime } from '../lib/format';
import {
  basename,
  continuousPercent,
  fetchReadingProgress,
  pushReadingProgress,
  seedLegacyChapters,
  type ReadingProgressInput,
  type ReadingProgressRecord,
} from '../lib/progress';
import { useToast } from '../lib/toast';
import { Modal } from '../components/Modal';
import type {
  ComicChapter,
  ComicFileGroup,
  ComicSearchItem,
  ComicSearchProgress,
  ComicShelfEntry,
  ComicSource,
} from '../lib/types';

type Tab = 'search' | 'shelf' | 'files';
type PackMode = 'per_chapter' | 'merged' | 'zip';

interface Variant {
  source: string;
  id: string;
  title: string;
  cover?: string;
  lang?: string;
  desc?: string;
}

interface Group {
  key: string;
  title: string;
  cover?: string;
  lang?: string;
  desc?: string;
  variants: Variant[];
}

interface DetailState {
  group: Group;
  variant: Variant;
  chapters: ComicChapter[];
  selected: string[];
  loading: boolean;
  error: string;
  blocked: boolean;
  downloading: boolean;
}

interface ReaderState {
  variant: Variant;
  chapters: ComicChapter[];
  index: number;
  pages: string[];
  loading: boolean;
  error: string;
}

interface PdfChapterMeta {
  pdf?: string;
  chapter?: string | number;
  title?: string;
  label?: string;
  first_page?: number;
  last_page?: number;
}

interface PdfVolume {
  volume?: string;
  chapters?: PdfChapterMeta[];
}

interface PdfMeta {
  mode?: string;
  volumes?: PdfVolume[];
}

interface PdfState {
  title: string;
  file: string;
  pages: number;
  page: number;
  loading: boolean;
  error: string;
  files: string[];
  meta: PdfMeta | null;
}

const CREAD_KEY = 'novelist_comic_progress';
const PDFREAD_KEY = 'novelist_comic_pdf_progress';
const COMIC_ZOOM_KEY = 'novelist_comic_zoom';
const COMIC_FIT_KEY = 'novelist_comic_fit';
const COMIC_DARK_KEY = 'novelist_comic_dark';
const PDF_CONT_KEY = 'novelist_pdf_continuous';

function loadStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

function loadStoredFlag(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

function savedComicIndex(variant: Variant, chapters: ComicChapter[]): number {
  try {
    const all = JSON.parse(localStorage.getItem(CREAD_KEY) || '{}') as Record<
      string,
      Record<string, number>
    >;
    const saved = Number(all[variant.source]?.[variant.id]) || 0;
    if (saved >= 1 && saved <= chapters.length) return saved - 1;
  } catch {
    /* 忽略损坏的进度记录 */
  }
  return 0;
}

function saveComicIndex(variant: Variant, index: number) {
  try {
    const all = JSON.parse(localStorage.getItem(CREAD_KEY) || '{}') as Record<
      string,
      Record<string, number>
    >;
    const books = all[variant.source] || {};
    books[variant.id] = index + 1;
    all[variant.source] = books;
    localStorage.setItem(CREAD_KEY, JSON.stringify(all));
  } catch {
    /* 忽略写入失败 */
  }
}

function comicProgressKey(title: string, file: string): string {
  return `comic:${title}/${basename(file)}`;
}

function pdfPageImage(title: string, file: string, page: number): string {
  return `/api/comic_page_image?title=${encodeURIComponent(title)}&file=${encodeURIComponent(file)}&page=${page}`;
}

interface RetryableImageProps {
  src: string;
  alt: string;
  className?: string;
  onRetryBlocked?: () => void;
  onClick?: () => void;
}

function RetryableImage({ src, alt, className, onRetryBlocked, onClick }: RetryableImageProps) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <div
        className={`comic-reader__retry${className ? ` ${className}` : ''}`}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          onRetryBlocked?.();
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            setFailed(false);
            setAttempt((value) => value + 1);
          }
        }}
      >
        {alt}加载失败，点击重试
      </div>
    );
  }
  const finalSrc = attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src;
  return (
    <img
      className={className}
      src={finalSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      onClick={
        onClick
          ? (event) => {
              event.stopPropagation();
              onClick();
            }
          : undefined
      }
      onError={() => {
        if (attempt < 2) setAttempt((value) => value + 1);
        else setFailed(true);
      }}
    />
  );
}

const TABS: { value: Tab; label: string }[] = [
  { value: 'search', label: '搜索' },
  { value: 'shelf', label: '收藏' },
  { value: 'files', label: '已下载' },
];

const PACK_MODES: { value: PackMode; label: string }[] = [
  { value: 'per_chapter', label: '每话一个 PDF' },
  { value: 'merged', label: '合并为整本 PDF' },
  { value: 'zip', label: '图片 ZIP' },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function groupKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '');
}

function mergeGroups(previous: Group[], items: ComicSearchItem[]): Group[] {
  const map = new Map(previous.map((group) => [group.key, { ...group, variants: [...group.variants] }]));
  for (const item of items) {
    if (!item?.id || !item.title) continue;
    const key = groupKey(item.title) || item.id;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        title: item.title,
        cover: item.cover,
        lang: item.lang,
        desc: item.desc,
        variants: [],
      };
      map.set(key, group);
    }
    if (!group.cover && item.cover) group.cover = item.cover;
    if (!group.lang && item.lang) group.lang = item.lang;
    if (!group.desc && item.desc) group.desc = item.desc;
    const source = item.source_key || 'mangadex';
    if (!group.variants.some((variant) => variant.source === source && variant.id === item.id)) {
      group.variants.push({
        source,
        id: item.id,
        title: item.title,
        cover: item.cover,
        lang: item.lang,
        desc: item.desc,
      });
    }
  }
  return [...map.values()];
}

function chapterLabel(chapter: ComicChapter | undefined, index: number): string {
  if (!chapter) return `第 ${index + 1} 话`;
  const title = (chapter.title || '').trim();
  const compactTitle = title.replace(/\s+/g, '');
  const bits: string[] = [];
  const volume = chapter.volume === undefined ? '' : String(chapter.volume).replace(/\s+/g, '');
  const number = chapter.chapter === undefined ? '' : String(chapter.chapter).replace(/\s+/g, '');
  if (volume && !compactTitle.includes(`第${volume}卷`)) bits.push(`第${chapter.volume}卷`);
  if (number && !compactTitle.includes(`第${number}话`)) bits.push(`第${chapter.chapter}话`);
  if (title) bits.push(title);
  return bits.join(' ') || `第 ${index + 1} 话`;
}

function comicImage(url: string, source: string): string {
  return `/api/comic_img?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source)}`;
}

function variantKey(variant: Variant): string {
  return `${variant.source}:${variant.id}`;
}

interface TocResponse {
  chapters?: ComicChapter[];
  error?: string;
  blocked?: boolean;
  hint?: string;
}

// 风控阻断时后端仍返回 200 并带 blocked,通用 apiGet 会抛错丢掉该标记
async function fetchToc(variant: Variant): Promise<TocResponse> {
  const query = new URLSearchParams({ id: variant.id, source: variant.source });
  const response = await fetch(`/api/comic_toc?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  let data: TocResponse;
  try {
    data = (await response.json()) as TocResponse;
  } catch {
    throw new Error(`话列表请求失败 (${response.status})`);
  }
  if (!response.ok && !data.error) {
    throw new Error(`话列表请求失败 (${response.status})`);
  }
  return data;
}

export function ComicsPage() {
  const [tab, setTab] = useState<Tab>('search');
  const [sources, setSources] = useState<ComicSource[]>([]);
  const [sourceKey, setSourceKey] = useState('');
  const [keyword, setKeyword] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<ComicSearchProgress | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [pdfReader, setPdfReader] = useState<PdfState | null>(null);
  const [mode, setMode] = useState<PackMode>('per_chapter');
  const [shelf, setShelf] = useState<ComicShelfEntry[]>([]);
  const [shelfLoading, setShelfLoading] = useState(true);
  const [shelfChecking, setShelfChecking] = useState(false);
  const [files, setFiles] = useState<ComicFileGroup[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [readBusy, setReadBusy] = useState<Record<string, boolean>>({});
  const [favoriteBusy, setFavoriteBusy] = useState('');
  const [fileBusy, setFileBusy] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<ComicShelfEntry | null>(null);
  const [readerZoom, setReaderZoom] = useState(() =>
    loadStoredNumber(COMIC_ZOOM_KEY, 1, 0.5, 2),
  );
  const [readerFit, setReaderFit] = useState<'width' | 'page'>(() =>
    localStorage.getItem(COMIC_FIT_KEY) === 'page' ? 'page' : 'width',
  );
  const [readerDark, setReaderDark] = useState(() => loadStoredFlag(COMIC_DARK_KEY));
  const [readerTwoPage, setReaderTwoPage] = useState(false);
  const [readerTocOpen, setReaderTocOpen] = useState(false);
  const [readerUiHidden, setReaderUiHidden] = useState(false);
  const [readerPageNo, setReaderPageNo] = useState(1);
  const [readerBodyHeight, setReaderBodyHeight] = useState(0);
  const [comicThumbs, setComicThumbs] = useState<
    Record<number, { loading?: boolean; urls?: string[]; error?: string }>
  >({});
  const [pdfZoom, setPdfZoom] = useState(1);
  const [pdfTwoPage, setPdfTwoPage] = useState(false);
  const [pdfContinuous, setPdfContinuous] = useState(
    () => localStorage.getItem(PDF_CONT_KEY) !== '0',
  );
  const [pdfTocOpen, setPdfTocOpen] = useState(false);
  const [pdfUiHidden, setPdfUiHidden] = useState(false);
  const [pdfChapterMap, setPdfChapterMap] = useState<Record<string, number>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);

  const searchSeq = useRef(0);
  const detailSeq = useRef(0);
  const readerSeq = useRef(0);
  const pdfSeq = useRef(0);
  const readerBodyRef = useRef<HTMLDivElement>(null);
  const pdfBodyRef = useRef<HTMLDivElement>(null);
  const lastReaderKeyRef = useRef('');
  const lastPdfKeyRef = useRef('');
  const pdfAligningRef = useRef(false);
  const pdfAlignStopRef = useRef<() => void>(() => undefined);
  const pdfChapterMapRef = useRef<Record<string, number>>({});
  const pdfPushTimerRef = useRef(0);
  const pdfLastPushRef = useRef<ReadingProgressInput | null>(null);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const navigate = useNavigate();

  const enabledSources = useMemo(() => sources.filter((source) => source.enabled), [sources]);

  const sourceName = useCallback(
    (key?: string) => sources.find((source) => source.key === key)?.name || key || '未知源',
    [sources],
  );

  const loadSources = useCallback(async () => {
    try {
      const data = await apiGet<{ sources: ComicSource[] }>('/api/comic_sources');
      const list = data.sources ?? [];
      setSources(list);
      const enabled = list.filter((source) => source.enabled);
      setSourceKey((previous) => {
        const valid = previous === '__all__' ? enabled.length > 1 : enabled.some((source) => source.key === previous);
        if (valid) return previous;
        return enabled.length > 1 ? '__all__' : enabled[0]?.key ?? 'mangadex';
      });
    } catch {
      setSources([]);
    }
  }, []);

  const loadShelf = useCallback(
    async (silent = false) => {
      if (!silent) setShelfLoading(true);
      try {
        const data = await apiGet<{ shelf: ComicShelfEntry[] }>('/api/comic_shelf');
        setShelf(data.shelf ?? []);
      } catch (error) {
        if (!silent) toast(error instanceof Error ? error.message : '漫画收藏加载失败', 'error');
      } finally {
        if (!silent) setShelfLoading(false);
      }
    },
    [toast],
  );

  const loadFiles = useCallback(
    async (silent = false) => {
      if (!silent) setFilesLoading(true);
      try {
        const data = await apiGet<{ items: ComicFileGroup[] }>('/api/comic_files');
        setFiles(data.items ?? []);
      } catch (error) {
        if (!silent) toast(error instanceof Error ? error.message : '漫画文件加载失败', 'error');
      } finally {
        if (!silent) setFilesLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadSources();
    void loadShelf();
    return () => {
      searchSeq.current += 1;
      detailSeq.current += 1;
      readerSeq.current += 1;
    };
  }, [loadShelf, loadSources]);

  useEffect(() => {
    if (tab === 'files') void loadFiles();
    if (tab === 'shelf') void loadShelf(true);
  }, [loadFiles, loadShelf, tab]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => toastRef.current('当前环境不支持全屏', 'info'));
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!reader) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setReaderZoom((value) =>
        Math.min(2, Math.max(0.5, Math.round((value + (event.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10)),
      );
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [reader]);

  useEffect(() => {
    if (!reader) {
      lastReaderKeyRef.current = '';
      return;
    }
    const key = `${reader.variant.source}:${reader.variant.id}:${reader.index}`;
    if (lastReaderKeyRef.current !== key) {
      lastReaderKeyRef.current = key;
      readerBodyRef.current?.scrollTo({ top: 0 });
      setReaderPageNo(1);
    }
  }, [reader]);

  useEffect(() => {
    if (!reader) return;
    saveComicIndex(reader.variant, reader.index);
  }, [reader?.index, reader?.variant.id, reader?.variant.source]);

  useEffect(() => {
    try {
      localStorage.setItem(COMIC_ZOOM_KEY, String(readerZoom));
    } catch {
      /* 存储不可用 */
    }
  }, [readerZoom]);

  useEffect(() => {
    try {
      localStorage.setItem(COMIC_FIT_KEY, readerFit);
    } catch {
      /* 存储不可用 */
    }
  }, [readerFit]);

  useEffect(() => {
    try {
      localStorage.setItem(COMIC_DARK_KEY, readerDark ? '1' : '0');
    } catch {
      /* 存储不可用 */
    }
  }, [readerDark]);

  useEffect(() => {
    try {
      localStorage.setItem(PDF_CONT_KEY, pdfContinuous ? '1' : '0');
    } catch {
      /* 存储不可用 */
    }
  }, [pdfContinuous]);

  useEffect(() => {
    if (!reader || readerFit !== 'page') return;
    const body = readerBodyRef.current;
    if (!body) return;
    const update = () => setReaderBodyHeight(body.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [reader, readerFit]);

  useEffect(() => {
    if (!reader || reader.loading || !reader.pages.length) {
      setReaderPageNo(1);
      return;
    }
    const body = readerBodyRef.current;
    if (!body) return;
    const visible = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page || 0);
          if (entry.isIntersecting) visible.set(page, entry.intersectionRatio);
          else visible.delete(page);
        }
        if (visible.size) setReaderPageNo(Math.min(...visible.keys()));
      },
      { root: body, threshold: [0, 0.25, 0.5] },
    );
    body.querySelectorAll<HTMLElement>('[data-page]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [reader?.pages, readerFit, readerTwoPage, readerZoom]);

  const flushPdfProgress = useCallback(() => {
    if (pdfPushTimerRef.current) {
      window.clearTimeout(pdfPushTimerRef.current);
      pdfPushTimerRef.current = 0;
    }
    const latest = pdfLastPushRef.current;
    pdfLastPushRef.current = null;
    if (latest) void pushReadingProgress(latest).catch(() => undefined);
  }, []);

  useEffect(() => () => flushPdfProgress(), [flushPdfProgress]);

  useEffect(() => {
    if (!pdfReader || pdfReader.loading || !pdfReader.pages) return;
    const pageKey = String(pdfReader.page);
    const map =
      pdfChapterMapRef.current[pageKey] === 1
        ? pdfChapterMapRef.current
        : { ...pdfChapterMapRef.current, [pageKey]: 1 };
    pdfChapterMapRef.current = map;
    setPdfChapterMap(map);
    try {
      localStorage.setItem(
        PDFREAD_KEY,
        JSON.stringify({
          title: pdfReader.title,
          file: pdfReader.file,
          page: pdfReader.page,
          ts: Date.now(),
          chapters: map,
        }),
      );
    } catch {
      /* 存储不可用 */
    }
    // 翻到的每一页都算"看过";总进度只累计从第 1 页连续翻过来的部分
    const input: ReadingProgressInput = {
      book: comicProgressKey(pdfReader.title, pdfReader.file),
      kind: 'comic',
      title: pdfReader.title,
      total: pdfReader.pages,
      ch: pdfReader.page,
      chapterTitle: basename(pdfReader.file),
      scroll: 0,
      chapters: map,
    };
    pdfLastPushRef.current = input;
    if (pdfPushTimerRef.current) window.clearTimeout(pdfPushTimerRef.current);
    pdfPushTimerRef.current = window.setTimeout(() => {
      const latest = pdfLastPushRef.current;
      pdfLastPushRef.current = null;
      if (latest) void pushReadingProgress(latest).catch(() => undefined);
    }, 1500);
  }, [pdfReader?.file, pdfReader?.loading, pdfReader?.page, pdfReader?.pages, pdfReader?.title]);

  const startPdfAlign = useCallback((targetPage: number) => {
    pdfAlignStopRef.current();
    const initialBody = pdfBodyRef.current;
    if (!initialBody) return () => undefined;
    let stopped = false;
    let interval = 0;
    let timer = 0;
    let stableSince = 0;
    let lastSignature = '';
    const finish = (aligned: boolean) => {
      if (stopped) return;
      stopped = true;
      pdfAligningRef.current = false;
      window.clearInterval(interval);
      window.clearTimeout(timer);
      pdfAlignStopRef.current = () => undefined;
      const body = pdfBodyRef.current;
      body?.removeEventListener('wheel', stop);
      body?.removeEventListener('touchmove', stop);
      body?.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', stop);
      if (aligned) {
        setPdfReader((prev) =>
          prev && prev.page !== targetPage ? { ...prev, page: targetPage } : prev,
        );
      }
    };
    const stop = () => finish(false);
    const align = () => {
      if (stopped) return;
      const body = pdfBodyRef.current;
      const wrap = body?.querySelector<HTMLElement>(`[data-page="${targetPage}"]`);
      if (!body || !wrap) return;
      const delta = wrap.getBoundingClientRect().top - body.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) {
        body.scrollTop += delta;
        stableSince = 0;
        return;
      }
      const targetImg = wrap.querySelector('img');
      if (targetImg && !targetImg.complete) {
        // 图片未就绪时页高不可信，等它撑开后再判定对齐
        stableSince = 0;
        lastSignature = '';
        return;
      }
      const signature = `${wrap.offsetTop}|${body.scrollHeight}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = window.performance.now();
      } else if (stableSince && window.performance.now() - stableSince > 450) {
        finish(true);
      }
    };
    pdfAligningRef.current = true;
    pdfAlignStopRef.current = stop;
    initialBody.addEventListener('wheel', stop, { passive: true });
    initialBody.addEventListener('touchmove', stop, { passive: true });
    initialBody.addEventListener('pointerdown', stop);
    window.addEventListener('keydown', stop);
    interval = window.setInterval(align, 80);
    timer = window.setTimeout(() => finish(false), 6000);
    align();
    return stop;
  }, []);

  useEffect(() => {
    if (!pdfReader || pdfReader.loading || pdfReader.error || !pdfContinuous) {
      lastPdfKeyRef.current = '';
      pdfAlignStopRef.current();
      return;
    }
    const key = `${pdfReader.title}|${pdfReader.file}|cont`;
    if (lastPdfKeyRef.current === key) return;
    if (!pdfBodyRef.current) return;
    lastPdfKeyRef.current = key;
    startPdfAlign(pdfReader.page);
    return () => {
      pdfAlignStopRef.current();
    };
  }, [
    pdfContinuous,
    pdfReader?.error,
    pdfReader?.file,
    pdfReader?.loading,
    pdfReader?.title,
    startPdfAlign,
  ]);

  useEffect(() => {
    if (!pdfTocOpen) return;
    const timer = window.setTimeout(() => {
      const active = document.querySelector('.comic-reader__drawer .is-current');
      active?.scrollIntoView({ block: 'center' });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [pdfTocOpen]);

  useEffect(() => {
    if (!reader || !readerTocOpen) return;
    const timer = window.setTimeout(() => {
      const active = document.querySelector('.comic-reader__drawer .is-current');
      active?.scrollIntoView({ block: 'center' });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [reader, readerTocOpen]);

  useEffect(() => {
    if (!reader) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'h') {
          event.preventDefault();
          setReaderUiHidden((value) => !value);
        }
        return;
      }
      if (event.key === 'Escape') {
        if (readerTocOpen) setReaderTocOpen(false);
        else if (readerUiHidden) setReaderUiHidden(false);
        else {
          setReader(null);
          setReaderTocOpen(false);
          setReaderUiHidden(false);
          setComicThumbs({});
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void showChapter(reader.index - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        void showChapter(reader.index + 1);
      } else if (event.key === 'PageDown' || event.key === ' ') {
        if (event.key === ' ' && tag === 'BUTTON') return;
        event.preventDefault();
        const body = readerBodyRef.current;
        if (body) {
          body.scrollBy({
            top: body.clientHeight * 0.85 * (event.shiftKey ? -1 : 1),
            behavior: 'smooth',
          });
        }
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        readerBodyRef.current?.scrollBy({ top: -readerBodyRef.current.clientHeight * 0.85, behavior: 'smooth' });
      } else if (event.key === 'f' || event.key === 'F') {
        toggleFullscreen();
      } else if (event.key === 't' || event.key === 'T') {
        setReaderTocOpen((value) => !value);
        setReaderUiHidden(false);
      } else if (event.key === 'd' || event.key === 'D') {
        setReaderDark((value) => !value);
      } else if (event.key === '+' || event.key === '=') {
        setReaderZoom((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10));
      } else if (event.key === '-') {
        setReaderZoom((value) => Math.max(0.5, Math.round((value - 0.1) * 10) / 10));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!pdfReader) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'h') {
          event.preventDefault();
          setPdfUiHidden((value) => !value);
        }
        return;
      }
      if (event.key === 'Escape') {
        if (pdfTocOpen) setPdfTocOpen(false);
        else if (pdfUiHidden) setPdfUiHidden(false);
        else {
          flushPdfProgress();
          setPdfReader(null);
          setPdfTocOpen(false);
          setPdfUiHidden(false);
        }
        return;
      }
      if (!pdfReader.pages) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (pdfContinuous) {
          pdfBodyRef.current?.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' });
        } else {
          const step = pdfTwoPage ? 2 : 1;
          setPdfReader((prev) =>
            prev && prev.page > 1 ? { ...prev, page: Math.max(1, prev.page - step) } : prev,
          );
        }
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (pdfContinuous) {
          pdfBodyRef.current?.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
        } else {
          const step = pdfTwoPage ? 2 : 1;
          setPdfReader((prev) =>
            prev && prev.page < prev.pages
              ? { ...prev, page: Math.min(prev.pages, prev.page + step) }
              : prev,
          );
        }
      } else if (event.key === ' ' || event.key === 'PageDown') {
        if (event.key === ' ' && tag === 'BUTTON') return;
        event.preventDefault();
        pdfBodyRef.current?.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        pdfBodyRef.current?.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' });
      } else if (event.key === 'f' || event.key === 'F') {
        toggleFullscreen();
      } else if (event.key === 't' || event.key === 'T') {
        setPdfTocOpen((value) => !value);
        setPdfUiHidden(false);
      } else if (event.key === 'c' || event.key === 'C') {
        setPdfContinuous((value) => !value);
        setPdfTwoPage(false);
        lastPdfKeyRef.current = '';
      } else if (event.key === '+' || event.key === '=') {
        setPdfZoom((value) => Math.min(3, Math.round((value + 0.2) * 10) / 10));
      } else if (event.key === '-') {
        setPdfZoom((value) => Math.max(0.4, Math.round((value - 0.2) * 10) / 10));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isFavorite = (variant: Variant) =>
    shelf.some((entry) => entry.source === variant.source && entry.comic_id === variant.id);

  const favorite = async (variant: Variant) => {
    const key = variantKey(variant);
    if (favoriteBusy === key || isFavorite(variant)) return;
    setFavoriteBusy(key);
    try {
      await apiPost('/api/comic_shelf', {
        title: variant.title,
        source: variant.source,
        comic_id: variant.id,
        cover: variant.cover || '',
      });
      toast(`已收藏《${variant.title}》`);
      await loadShelf(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : '收藏失败', 'error');
    } finally {
      setFavoriteBusy('');
    }
  };

  const fetchChapters = async (variant: Variant, seq: number) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const data = await fetchToc(variant);
        if (seq !== detailSeq.current) return;
        if (data.error) {
          if (data.blocked) {
            setDetail((prev) =>
              prev && seq === detailSeq.current
                ? { ...prev, loading: false, blocked: true, error: data.error || '站点暂时限制了访问' }
                : prev,
            );
            return;
          }
          throw new Error(data.error);
        }
        setDetail((prev) =>
          prev && seq === detailSeq.current
            ? { ...prev, loading: false, chapters: data.chapters ?? [], selected: [] }
            : prev,
        );
        return;
      } catch (error) {
        if (seq !== detailSeq.current) return;
        const message = error instanceof Error ? error.message : '话列表加载失败';
        const retryable = /210|429|403|过频|拦截|风控|超时|timeout/i.test(message);
        if (attempt < 3 && retryable) {
          setDetail((prev) =>
            prev && seq === detailSeq.current
              ? { ...prev, loading: true, error: `正在重试（${attempt}/2）· ${message}` }
              : prev,
          );
          await sleep(attempt === 1 ? 2500 : 4000);
          continue;
        }
        setDetail((prev) =>
          prev && seq === detailSeq.current ? { ...prev, loading: false, error: message } : prev,
        );
        return;
      }
    }
  };

  const openDetail = (group: Group, variant: Variant = group.variants[0]) => {
    const seq = ++detailSeq.current;
    setDetail({
      group,
      variant,
      chapters: [],
      selected: [],
      loading: true,
      error: '',
      blocked: false,
      downloading: false,
    });
    void fetchChapters(variant, seq);
  };

  const switchVariant = (variant: Variant) => {
    if (!detail || detail.loading) return;
    const seq = ++detailSeq.current;
    setDetail({
      ...detail,
      variant,
      chapters: [],
      selected: [],
      loading: true,
      error: '',
      blocked: false,
    });
    void fetchChapters(variant, seq);
  };

  const fetchPages = async (variant: Variant, chapters: ComicChapter[], index: number) => {
    const chapter = chapters[index];
    if (!chapter) return;
    const seq = ++readerSeq.current;
    saveComicIndex(variant, index);
    setReader((prev) =>
      prev ? { ...prev, index, pages: [], loading: true, error: '' } : prev,
    );
    try {
      const data = await apiGet<{ urls: string[] }>('/api/comic_pages', {
        source: variant.source,
        comic_id: variant.id,
        ep_id: chapter.id,
      });
      if (seq !== readerSeq.current) return;
      setReader((prev) => (prev ? { ...prev, pages: data.urls ?? [], loading: false } : prev));
    } catch (error) {
      if (seq !== readerSeq.current) return;
      setReader((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: error instanceof Error ? error.message : '图片列表获取失败',
            }
          : prev,
      );
    }
  };

  const openOnlineReader = (variant: Variant, chapters: ComicChapter[], index?: number) => {
    if (!chapters.length) {
      toast('暂无可阅读的话', 'error');
      return;
    }
    const target = index ?? savedComicIndex(variant, chapters);
    setDetail(null);
    flushPdfProgress();
    setPdfReader(null);
    setReaderTocOpen(false);
    setReaderUiHidden(false);
    setReaderTwoPage(false);
    setComicThumbs({});
    lastReaderKeyRef.current = '';
    setReader({ variant, chapters, index: target, pages: [], loading: true, error: '' });
    void fetchPages(variant, chapters, target);
  };

  const showChapter = async (index: number) => {
    if (!reader || index < 0 || index >= reader.chapters.length) return;
    await fetchPages(reader.variant, reader.chapters, index);
  };

  const jumpComicChapter = (index: number) => {
    setReaderTocOpen(false);
    void showChapter(index);
  };

  const toggleComicThumb = async (index: number) => {
    if (!reader) return;
    const chapter = reader.chapters[index];
    if (!chapter) return;
    if (comicThumbs[index]) {
      setComicThumbs((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    setComicThumbs((prev) => ({ ...prev, [index]: { loading: true } }));
    try {
      const data = await apiGet<{ urls: string[] }>('/api/comic_pages', {
        source: reader.variant.source,
        comic_id: reader.variant.id,
        ep_id: chapter.id,
      });
      setComicThumbs((prev) => ({
        ...prev,
        [index]: { loading: false, urls: (data.urls ?? []).slice(0, 12) },
      }));
    } catch (error) {
      setComicThumbs((prev) => ({
        ...prev,
        [index]: {
          loading: false,
          error: error instanceof Error ? error.message : '缩略图加载失败',
        },
      }));
    }
  };

  const readVariant = async (variant: Variant) => {
    const key = variantKey(variant);
    if (readBusy[key]) return;
    setReadBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const data = await fetchToc(variant);
      if (data.error) throw new Error(data.error);
      const chapters = data.chapters ?? [];
      if (!chapters.length) throw new Error('暂无章节');
      openOnlineReader(variant, chapters);
    } catch (error) {
      toast(error instanceof Error ? error.message : '打开失败', 'error');
    } finally {
      setReadBusy((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const openPdf = async (title: string, file: string) => {
    const seq = ++pdfSeq.current;
    flushPdfProgress();
    setReader(null);
    setPdfTocOpen(false);
    setPdfUiHidden(false);
    setPdfTwoPage(false);
    lastPdfKeyRef.current = '';
    setPdfReader({ title, file, pages: 0, page: 1, loading: true, error: '', files: [], meta: null });
    try {
      const metaData = await apiGet<{ meta?: PdfMeta | null; pdfs?: string[] }>(
        '/api/comic_pdf_meta',
        { title, file: file || '' },
      );
      if (seq !== pdfSeq.current) return;
      const files = metaData.pdfs ?? [];
      const actualFile = file || files[0] || '';
      if (!actualFile) throw new Error('未找到 PDF 文件');
      let savedPage = 1;
      let savedTs = 0;
      let savedChapters: Record<string, number> = {};
      try {
        const saved = JSON.parse(localStorage.getItem(PDFREAD_KEY) || 'null') as
          | {
              title?: string;
              file?: string;
              page?: number;
              ts?: number;
              chapters?: Record<string, number>;
            }
          | null;
        if (saved && saved.title === title && saved.file === actualFile) {
          savedPage = Math.max(1, Number(saved.page) || 1);
          savedTs = Number(saved.ts) || 0;
          if (saved.chapters && typeof saved.chapters === 'object') {
            savedChapters = saved.chapters;
          }
        }
      } catch {
        /* 忽略损坏的进度记录 */
      }
      const pageData = await apiGet<{ num_pages: number }>('/api/comic_page_meta', {
        title,
        file: actualFile,
      });
      if (seq !== pdfSeq.current) return;
      const pages = pageData.num_pages ?? 0;

      const book = comicProgressKey(title, actualFile);
      let shared: ReadingProgressRecord | undefined;
      try {
        shared = (await fetchReadingProgress(book))[book];
      } catch {
        shared = undefined;
      }
      if (seq !== pdfSeq.current) return;
      const sharedUpdated = Number(shared?.updated) || 0;
      let startPage = 1;
      let chapters: Record<string, number> = {};
      if (shared && sharedUpdated > savedTs) {
        startPage = Math.max(1, Number(shared.ch) || 1);
        chapters =
          shared.chapters && Object.keys(shared.chapters).length
            ? { ...shared.chapters }
            : seedLegacyChapters(startPage, 0, pages);
      } else {
        startPage = savedPage;
        chapters = Object.keys(savedChapters).length
          ? { ...savedChapters }
          : seedLegacyChapters(savedPage, 0, pages);
        if (savedTs > sharedUpdated) {
          // 本机进度比电脑上的共享记录新:顺手补传,免得换设备读丢
          void pushReadingProgress({
            book,
            kind: 'comic',
            title,
            total: pages,
            ch: savedPage,
            chapterTitle: basename(actualFile),
            scroll: 0,
            chapters,
            updated: savedTs,
          }).catch(() => undefined);
        }
      }
      pdfChapterMapRef.current = chapters;
      setPdfChapterMap(chapters);
      setPdfReader((prev) =>
        prev && prev.title === title
          ? {
              ...prev,
              file: actualFile,
              pages,
              page: Math.min(pages || 1, startPage),
              loading: false,
              files,
              meta: metaData.meta ?? null,
            }
          : prev,
      );
    } catch (error) {
      if (seq !== pdfSeq.current) return;
      setPdfReader((prev) =>
        prev
          ? { ...prev, loading: false, error: error instanceof Error ? error.message : 'PDF 解析失败' }
          : prev,
      );
    }
  };

  const pdfMetaChapters = useMemo(
    () => (pdfReader?.meta?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [pdfReader?.meta],
  );

  const pdfPercent = useMemo(() => {
    if (!pdfReader || !pdfReader.pages) return 0;
    const chapters = { ...pdfChapterMap, [String(pdfReader.page)]: 1 };
    return continuousPercent({ total: pdfReader.pages, ch: pdfReader.page, chapters });
  }, [pdfChapterMap, pdfReader?.page, pdfReader?.pages]);

  const changeReaderZoom = (delta: number) => {
    setReaderZoom((value) =>
      Math.min(2, Math.max(0.5, Math.round((value + delta) * 10) / 10)),
    );
  };

  const changePdfZoom = (delta: number) => {
    setPdfZoom((value) => Math.min(3, Math.max(0.4, Math.round((value + delta) * 10) / 10)));
  };

  const pdfGotoPage = (page: number) => {
    if (!pdfReader) return;
    const target = Math.min(pdfReader.pages || 1, Math.max(1, page));
    setPdfReader((prev) => (prev ? { ...prev, page: target } : prev));
    if (pdfContinuous) {
      startPdfAlign(target);
    }
  };

  const jumpPdfPage = (page?: number) => {
    setPdfTocOpen(false);
    pdfGotoPage(page || 1);
  };

  const pdfStepPage = (direction: number) => {
    if (!pdfReader) return;
    if (pdfContinuous) {
      const body = pdfBodyRef.current;
      const distance = (body?.clientHeight || window.innerHeight) * 0.9;
      body?.scrollBy({ top: distance * direction, behavior: 'smooth' });
      return;
    }
    const step = pdfTwoPage ? 2 : 1;
    const next = pdfReader.page + direction * step;
    if (next < 1) {
      toast('已经是第一页', 'info');
      return;
    }
    if (pdfReader.pages && next > pdfReader.pages) {
      toast('已经是最后一页', 'info');
      return;
    }
    setPdfReader((prev) =>
      prev ? { ...prev, page: Math.min(prev.pages || next, Math.max(1, next)) } : prev,
    );
  };

  const pdfPrevChapter = () => {
    if (!pdfReader) return;
    const index = pdfReader.files.indexOf(pdfReader.file);
    if (index > 0) {
      void openPdf(pdfReader.title, pdfReader.files[index - 1]);
      return;
    }
    if (pdfReader.meta?.mode === 'merged' && pdfMetaChapters.length) {
      const current = pdfMetaChapters.findIndex(
        (chapter) =>
          (chapter.first_page || 1) <= pdfReader.page &&
          pdfReader.page <= (chapter.last_page || Number.POSITIVE_INFINITY),
      );
      if (current > 0) {
        pdfGotoPage(pdfMetaChapters[current - 1].first_page || 1);
        return;
      }
    }
    toast('已经是第一话', 'info');
  };

  const pdfNextChapter = () => {
    if (!pdfReader) return;
    const index = pdfReader.files.indexOf(pdfReader.file);
    if (index >= 0 && index < pdfReader.files.length - 1) {
      void openPdf(pdfReader.title, pdfReader.files[index + 1]);
      return;
    }
    if (pdfReader.meta?.mode === 'merged' && pdfMetaChapters.length) {
      const current = pdfMetaChapters.findIndex(
        (chapter) =>
          (chapter.first_page || 1) <= pdfReader.page &&
          pdfReader.page <= (chapter.last_page || Number.POSITIVE_INFINITY),
      );
      if (current >= 0 && current < pdfMetaChapters.length - 1) {
        pdfGotoPage(pdfMetaChapters[current + 1].first_page || 1);
        return;
      }
    }
    toast('已经是最后一话', 'info');
  };

  const togglePdfContinuous = () => {
    const next = !pdfContinuous;
    setPdfContinuous(next);
    if (next) setPdfTwoPage(false);
    lastPdfKeyRef.current = '';
    toast(next ? '连续滚动：滚轮直接往下看' : '已切回单页模式', 'info');
  };

  const togglePdfTwoPage = () => {
    const next = !pdfTwoPage;
    setPdfTwoPage(next);
    if (next && pdfContinuous) setPdfContinuous(false);
    lastPdfKeyRef.current = '';
  };

  const handleComicBodyClick = () => {
    if (readerTocOpen) {
      setReaderTocOpen(false);
      return;
    }
    setReaderUiHidden((value) => !value);
  };

  const handlePdfScroll = () => {
    if (!pdfContinuous || pdfAligningRef.current) return;
    const body = pdfBodyRef.current;
    if (!body) return;
    const nodes = body.querySelectorAll<HTMLElement>('[data-page]');
    if (!nodes.length) return;
    const bodyRect = body.getBoundingClientRect();
    let current = Number(nodes[0].dataset.page || 1);
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) {
      current = Number(nodes[nodes.length - 1].dataset.page || current);
    } else {
      const probe = bodyRect.top + body.clientHeight * 0.3;
      nodes.forEach((node) => {
        if (node.getBoundingClientRect().top <= probe) {
          current = Number(node.dataset.page || current);
        }
      });
    }
    setPdfReader((prev) => (prev && prev.page !== current ? { ...prev, page: current } : prev));
  };

  const handlePdfBodyClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!pdfReader || pdfReader.loading || pdfReader.error) return;
    if ((event.target as HTMLElement).closest('button, a')) return;
    const x = event.clientX;
    const width = window.innerWidth;
    if (pdfContinuous) {
      if (x < width * 0.33) pdfStepPage(-1);
      else if (x > width * 0.66) pdfStepPage(1);
      return;
    }
    if (x < width * 0.33) pdfStepPage(-1);
    else if (x > width * 0.66) pdfStepPage(1);
  };

  const startSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = keyword.trim();
    if (!value) {
      toast('请输入漫画关键词', 'error');
      return;
    }
    const enabled = sources.filter((source) => source.enabled).map((source) => source.key);
    const target = sourceKey === '__all__' ? enabled.join(',') : sourceKey;
    if (sourceKey === '__all__' && !enabled.length) {
      toast('没有启用的漫画源', 'error');
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    setGroups([]);
    setSearchProgress({ state: 'running', done: 0, total: 0, sources: [], errors: [], batches: [] });
    try {
      const started = await apiGet<{ task_id: string }>('/api/comic_search_async', {
        q: value,
        source: target || 'mangadex',
      });
      for (;;) {
        if (seq !== searchSeq.current) return;
        const progress = await apiGet<ComicSearchProgress>('/api/comic_search_progress', {
          id: started.task_id,
        });
        if (seq !== searchSeq.current) return;
        setSearchProgress(progress);
        if (progress.batches?.length) {
          const items = progress.batches.flatMap((batch) => batch.items ?? []);
          if (items.length) setGroups((prev) => mergeGroups(prev, items));
        }
        if (progress.state === 'done') {
          const final = await apiGet<{ items?: ComicSearchItem[]; errors?: string[] }>(
            '/api/comic_search_result',
            { id: started.task_id },
          );
          if (seq !== searchSeq.current) return;
          if (final.items?.length) setGroups((prev) => mergeGroups(prev, final.items ?? []));
          if (final.errors?.length) {
            toast(`部分源搜索失败：${final.errors.join('；').slice(0, 120)}`, 'error');
          }
          break;
        }
        if (progress.state === 'error') {
          if (seq === searchSeq.current) toast('漫画搜索失败', 'error');
          break;
        }
        await sleep(700);
      }
    } catch (error) {
      if (seq === searchSeq.current) {
        toast(error instanceof Error ? error.message : '漫画搜索失败', 'error');
      }
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const openFromShelf = (entry: ComicShelfEntry) => {
    openDetail({
      key: variantKey({ source: entry.source, id: entry.comic_id, title: entry.title }),
      title: entry.title,
      cover: entry.cover,
      variants: [
        {
          source: entry.source,
          id: entry.comic_id,
          title: entry.title,
          cover: entry.cover,
        },
      ],
    });
  };

  const checkShelfUpdates = async () => {
    if (!shelf.length || shelfChecking) return;
    setShelfChecking(true);
    try {
      const data = await apiPost<{
        ok: boolean;
        updated: number;
        results: { title: string; new: number }[];
      }>('/api/comic_shelf/refresh', {});
      await loadShelf(true);
      if (data.updated > 0) {
        const names = (data.results ?? [])
          .filter((item) => item.new > 0)
          .map((item) => item.title)
          .slice(0, 5)
          .join('、');
        toast(`${data.updated} 部漫画有更新：${names}${data.updated > 5 ? '…' : ''}`);
      } else {
        toast('没有发现新更新');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '检查更新失败', 'error');
    } finally {
      setShelfChecking(false);
    }
  };

  const removeFavorite = async () => {
    if (!removeTarget) return;
    try {
      await apiPost('/api/comic_shelf/del', {
        source: removeTarget.source,
        comic_id: removeTarget.comic_id,
      });
      toast(`已取消收藏《${removeTarget.title}》`);
      setRemoveTarget(null);
      await loadShelf(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : '取消收藏失败', 'error');
    }
  };

  const downloadSelected = async () => {
    if (!detail || detail.downloading) return;
    const chapters = detail.chapters.filter((chapter) => detail.selected.includes(chapter.id));
    if (!chapters.length) {
      toast('请先勾选要下载的话', 'error');
      return;
    }
    setDetail((prev) => (prev ? { ...prev, downloading: true } : prev));
    try {
      await apiPost('/api/comic_download', {
        title: detail.group.title,
        chapters,
        source: detail.variant.source,
        comic_id: detail.variant.id,
        mode,
      });
      toast(`《${detail.group.title}》已加入下载队列（${chapters.length} 话）`);
      setDetail(null);
      navigate('/tasks');
    } catch (error) {
      toast(error instanceof Error ? error.message : '启动下载失败', 'error');
      setDetail((prev) => (prev ? { ...prev, downloading: false } : prev));
    }
  };

  const fileAction = async (title: string, action: 'compress' | 'split') => {
    const key = `${title}:${action}`;
    if (fileBusy[key]) return;
    setFileBusy((prev) => ({ ...prev, [key]: action }));
    try {
      if (action === 'compress') {
        const data = await apiPost<{
          ok: boolean;
          files?: number;
          before?: number;
          after?: number;
        }>('/api/comic_compress', { title });
        toast(
          `已压缩 ${data.files ?? 0} 个 PDF：${formatBytes(data.before)} → ${formatBytes(data.after)}`,
        );
      } else {
        const data = await apiPost<{
          ok: boolean;
          mode?: string;
          files?: number;
          total?: number;
          parts?: number;
          pages?: number;
        }>('/api/comic_split', { title });
        toast(
          data.mode === 'chapter'
            ? `已按章节拆分 ${data.files ?? 0}/${data.total ?? 0} 话，原文件保留`
            : `已拆分 ${data.files ?? 0} 个 PDF，共 ${data.parts ?? 0} 卷（每卷 ${data.pages ?? 0} 页）`,
        );
      }
      await loadFiles(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    } finally {
      setFileBusy((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const openDir = async (name?: string) => {
    if (!window.desktop) {
      toast('仅桌面版支持打开目录', 'error');
      return;
    }
    await window.desktop.openDir(name);
  };

  const toggleChapter = (id: string) => {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            selected: prev.selected.includes(id)
              ? prev.selected.filter((item) => item !== id)
              : [...prev.selected, id],
          }
        : prev,
    );
  };

  const allSelected =
    Boolean(detail?.chapters.length) &&
    detail?.chapters.every((chapter) => detail.selected.includes(chapter.id));

  const toggleAll = () => {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            selected: allSelected ? [] : prev.chapters.map((chapter) => chapter.id),
          }
        : prev,
    );
  };

  const shelfHint = shelfLoading
    ? '正在加载收藏…'
    : `${shelf.length} 部收藏 · ${shelf.filter((entry) => (entry.checked_chapters ?? 0) > (entry.have ?? 0)).length} 部有更新`;

  const visiblePdfPages =
    pdfReader && !pdfReader.loading && !pdfReader.error && pdfReader.pages
      ? pdfContinuous
        ? Array.from({ length: pdfReader.pages }, (_, index) => index + 1)
        : pdfTwoPage
          ? [pdfReader.page, pdfReader.page + 1].filter((page) => page <= pdfReader.pages)
          : [pdfReader.page]
      : [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">漫画</h1>
          <p className="page-desc">
            多源聚合搜索、在线看图、按话下载 PDF，收藏与本地漫画统一管理。
          </p>
        </div>
        <div className="page-actions">
          {tab === 'shelf' ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void checkShelfUpdates()}
              disabled={!shelf.length || shelfChecking}
            >
              <RefreshCw size={15} className={shelfChecking ? 'spin' : undefined} />
              {shelfChecking ? '检查中…' : '检查更新'}
            </button>
          ) : null}
          {tab === 'files' ? (
            <button type="button" className="btn btn--ghost" onClick={() => void loadFiles()}>
              <RefreshCw size={15} />
              刷新
            </button>
          ) : null}
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="漫画分区">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={tab === item.value ? 'is-on' : ''}
              onClick={() => setTab(item.value)}
            >
              {item.label}
              {item.value === 'shelf' && shelf.length ? ` ${shelf.length}` : ''}
              {item.value === 'files' && files.length ? ` ${files.length}` : ''}
            </button>
          ))}
        </div>
        <span className="toolbar__hint">
          {tab === 'search'
            ? searching
              ? '正在聚合搜索…'
              : `${enabledSources.length} 个漫画源可用`
            : tab === 'shelf'
              ? shelfHint
              : filesLoading
                ? '正在加载…'
                : `${files.length} 部 · ${formatBytes(files.reduce((sum, item) => sum + item.size, 0))}`}
        </span>
      </div>

      {tab === 'search' ? (
        <>
          <form className="search-bar" onSubmit={(event) => void startSearch(event)}>
            <input
              className="input"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索漫画（支持中英文，如 转生史莱姆 / slime）"
              aria-label="搜索漫画"
            />
            <select
              className="input comic-source-select"
              value={sourceKey}
              onChange={(event) => setSourceKey(event.target.value)}
              aria-label="漫画源"
            >
              {enabledSources.length > 1 ? (
                <option value="__all__">全部源（{enabledSources.length}）</option>
              ) : null}
              {sources.map((source) => (
                <option key={source.key} value={source.key} disabled={!source.enabled}>
                  {source.name}
                  {source.needs_proxy ? '（需代理）' : ''}
                  {source.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
            <button type="submit" className="btn" disabled={searching}>
              <Search size={16} />
              {searching ? '搜索中…' : '搜索'}
            </button>
          </form>

          {searching ? (
            <div className="progress-card">
              <span className="spinner" />
              <div className="progress-card__text">
                <div className="progress-card__title">
                  已搜索 {searchProgress?.done ?? 0}/{searchProgress?.total ?? 0} 个漫画源
                </div>
                <div className="progress-card__sub">
                  {searchProgress?.errors?.length
                    ? `${searchProgress.errors.length} 个源失败`
                    : '结果会随各源返回陆续出现'}
                </div>
                <div className="progress-track">
                  <i
                    style={{
                      width: `${searchProgress?.total ? Math.round(((searchProgress.done ?? 0) / searchProgress.total) * 100) : 6}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {searchProgress?.sources?.length ? (
            <div className="source-chips">
              {searchProgress.sources.map((source) => (
                <span
                  key={source.name}
                  className={`source-chip ${
                    source.status === 'done'
                      ? 'source-chip--ok'
                      : source.status === 'error'
                        ? 'source-chip--error'
                        : ''
                  }`}
                >
                  {sourceName(source.name)}
                  {source.status === 'error' ? ' · 失败' : ''}
                </span>
              ))}
            </div>
          ) : null}

          {searching && !groups.length ? (
            <div className="comic-grid">
              {Array.from({ length: 10 }).map((_, index) => (
                <div key={index} className="skeleton" style={{ height: 250 }} />
              ))}
            </div>
          ) : groups.length ? (
            <div className="comic-grid">
              {groups.map((group) => {
                const variant = group.variants[0];
                const favorited = isFavorite(variant);
                return (
                  <article key={group.key} className="comic-card">
                    <button
                      type="button"
                      className="comic-card__cover"
                      onClick={() => openDetail(group)}
                      aria-label={`查看《${group.title}》详情`}
                    >
                      {coverSrc(group.cover) ? (
                        <img src={coverSrc(group.cover)} alt="" loading="lazy" />
                      ) : (
                        group.title.slice(0, 1)
                      )}
                    </button>
                    <div className="comic-card__body">
                      <div className="comic-card__title" title={group.title}>
                        {group.title}
                      </div>
                      <div className="comic-card__meta">
                        <span className="badge badge--primary">
                          {group.variants.length > 1
                            ? `${group.variants.length} 个源`
                            : sourceName(variant.source)}
                        </span>
                        {group.lang ? <span className="badge">{group.lang}</span> : null}
                      </div>
                      <div className="comic-card__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => void favorite(variant)}
                          disabled={favorited || favoriteBusy === variantKey(variant)}
                          title={favorited ? '已收藏' : '收藏'}
                        >
                          <Star size={14} fill={favorited ? 'currentColor' : 'none'} />
                          {favorited ? '已收藏' : '收藏'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => void readVariant(variant)}
                          disabled={readBusy[variantKey(variant)]}
                          title="在线阅读"
                        >
                          <BookOpen size={14} />
                          阅读
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => openDetail(group)}
                        >
                          详情
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty">
              <div className="empty__icon">
                <Images size={20} />
              </div>
              <div className="empty__title">
                {searchProgress ? '没有找到相关漫画' : '搜索你想看的漫画'}
              </div>
              <div className="empty__desc">
                {searchProgress
                  ? '换个关键词或切换其它漫画源再试试。'
                  : '一次搜索覆盖全部已启用的漫画源，结果会按作品合并。'}
              </div>
            </div>
          )}
        </>
      ) : null}

      {tab === 'shelf' ? (
        shelfLoading ? (
          <div className="comic-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="skeleton" style={{ height: 280 }} />
            ))}
          </div>
        ) : shelf.length ? (
          <div className="comic-grid">
            {shelf.map((entry) => {
              const total = entry.checked_chapters ?? 0;
              const have = entry.have ?? 0;
              const fresh = Math.max(0, total - have);
              const variant: Variant = {
                source: entry.source,
                id: entry.comic_id,
                title: entry.title,
                cover: entry.cover,
              };
              return (
                <article key={`${entry.source}:${entry.comic_id}`} className="comic-card">
                  <button
                    type="button"
                    className="comic-card__cover"
                    onClick={() => openFromShelf(entry)}
                    aria-label={`查看《${entry.title}》详情`}
                  >
                    {coverSrc(entry.cover) ? (
                      <img src={coverSrc(entry.cover)} alt="" loading="lazy" />
                    ) : (
                      entry.title.slice(0, 1)
                    )}
                  </button>
                  <div className="comic-card__body">
                    <div className="comic-card__title" title={entry.title}>
                      {entry.title}
                    </div>
                    <div className="comic-card__meta">
                      <span className="badge badge--primary">{sourceName(entry.source)}</span>
                      {fresh > 0 ? (
                        <span className="badge badge--warn">{fresh} 话更新</span>
                      ) : null}
                      {!total ? (
                        <span className="badge">加入于 {relativeTime(entry.added)}</span>
                      ) : null}
                    </div>
                    {total ? (
                      <div className="comic-card__progress">
                        <div className="progress-track">
                          <i
                            style={{
                              width: `${Math.min(100, Math.round((have / total) * 100))}%`,
                            }}
                          />
                        </div>
                        <span>
                          本地 {have} / 共 {total} 话
                        </span>
                      </div>
                    ) : null}
                    <div className="comic-card__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => void readVariant(variant)}
                        disabled={readBusy[variantKey(variant)]}
                      >
                        <BookOpen size={14} />
                        阅读
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => openFromShelf(entry)}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm btn--icon"
                        onClick={() => setRemoveTarget(entry)}
                        aria-label="取消收藏"
                        title="取消收藏"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty">
            <div className="empty__icon">
              <Library size={20} />
            </div>
            <div className="empty__title">还没有收藏漫画</div>
            <div className="empty__desc">在搜索页点「收藏」，更新与阅读进度都会保留在这里。</div>
          </div>
        )
      ) : null}

      {tab === 'files' ? (
        filesLoading ? (
          <div className="comic-file-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="skeleton" style={{ height: 210 }} />
            ))}
          </div>
        ) : files.length ? (
          <div className="comic-file-grid">
            {files.map((group) => (
              <article key={group.title} className="comic-file-card">
                <div className="comic-file-card__cover">
                  <img src={group.cover_url} alt="" loading="lazy" />
                </div>
                <div className="comic-file-card__body">
                  <div className="comic-file-card__title" title={group.title}>
                    {group.title}
                  </div>
                  <div className="comic-file-card__meta">
                    {group.files} 个 PDF · {formatBytes(group.size)}
                  </div>
                  <div className="comic-pdf-chips">
                    {group.pdfs.slice(0, 4).map((pdf) => (
                      <button
                        key={pdf}
                        type="button"
                        onClick={() => void openPdf(group.title, pdf)}
                        title={pdf}
                      >
                        {pdf.replace(/\.pdf$/i, '')}
                      </button>
                    ))}
                    {group.pdfs.length > 4 ? <span>+{group.pdfs.length - 4}</span> : null}
                  </div>
                  <div className="comic-file-card__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void openPdf(group.title, group.pdfs[0])}
                      disabled={!group.pdfs.length}
                    >
                      <BookOpen size={14} />
                      阅读
                    </button>
                    <a
                      className="btn btn--ghost btn--sm"
                      href={`/api/comic_pack?title=${encodeURIComponent(group.title)}`}
                    >
                      <Download size={14} />
                      打包
                    </a>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void openDir(group.dir)}
                    >
                      <FolderOpen size={14} />
                      目录
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void fileAction(group.title, 'compress')}
                      disabled={fileBusy[`${group.title}:compress`] === 'compress'}
                      title="按设置中的 PDF 图片质量重新压缩，原文件保留"
                    >
                      {fileBusy[`${group.title}:compress`] === 'compress' ? '压缩中…' : '压缩'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void fileAction(group.title, 'split')}
                      disabled={fileBusy[`${group.title}:split`] === 'split'}
                      title="合集按章节拆分为每话 PDF，原文件保留"
                    >
                      {fileBusy[`${group.title}:split`] === 'split' ? '拆分中…' : '拆分'}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <div className="empty__icon">
              <Download size={20} />
            </div>
            <div className="empty__title">还没有下载漫画</div>
            <div className="empty__desc">
              在搜索或收藏里选择章节下载，PDF 会按书名归档到漫画目录。
            </div>
          </div>
        )
      ) : null}

      <Modal
        title={detail ? `《${detail.group.title}》` : '漫画详情'}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={760}
        footer={
          <>
            <span className="modal__hint" style={{ marginRight: 'auto' }}>
              已选 {detail?.selected.length ?? 0} / {detail?.chapters.length ?? 0} 话
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => setDetail(null)}>
              关闭
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void downloadSelected()}
              disabled={!detail?.selected.length || detail?.downloading}
            >
              <Download size={15} />
              {detail?.downloading ? '提交中…' : '下载选中'}
            </button>
          </>
        }
      >
        {detail ? (
          <div className="comic-detail">
            <div className="comic-detail__head">
              <div className="comic-detail__cover">
                {coverSrc(detail.variant.cover || detail.group.cover) ? (
                  <img
                    src={coverSrc(detail.variant.cover || detail.group.cover)}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  detail.group.title.slice(0, 1)
                )}
              </div>
              <div className="comic-detail__info">
                <div className="comic-detail__title">
                  {detail.variant.title || detail.group.title}
                </div>
                <div className="comic-detail__meta">
                  <span className="badge badge--primary">{sourceName(detail.variant.source)}</span>
                  {detail.variant.lang || detail.group.lang ? (
                    <span className="badge">{detail.variant.lang || detail.group.lang}</span>
                  ) : null}
                  <span className="badge">{detail.chapters.length} 话</span>
                </div>
                <p className="comic-detail__desc">
                  {detail.variant.desc || detail.group.desc || '暂无简介'}
                </p>
                <div className="comic-detail__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      void favorite({
                        source: detail.variant.source,
                        id: detail.variant.id,
                        title: detail.variant.title || detail.group.title,
                        cover: detail.variant.cover || detail.group.cover,
                      })
                    }
                    disabled={isFavorite(detail.variant) || favoriteBusy === variantKey(detail.variant)}
                  >
                    <Star
                      size={14}
                      fill={isFavorite(detail.variant) ? 'currentColor' : 'none'}
                    />
                    {isFavorite(detail.variant) ? '已收藏' : '收藏'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => openOnlineReader(detail.variant, detail.chapters)}
                    disabled={!detail.chapters.length}
                  >
                    <BookOpen size={14} />
                    开始阅读
                  </button>
                </div>
              </div>
            </div>

            {detail.group.variants.length > 1 ? (
              <div className="comic-detail__sources">
                <span>可用来源</span>
                {detail.group.variants.map((variant) => (
                  <button
                    key={variantKey(variant)}
                    type="button"
                    className={`btn btn--sm ${
                      variantKey(variant) === variantKey(detail.variant)
                        ? ''
                        : 'btn--ghost'
                    }`}
                    onClick={() => switchVariant(variant)}
                    disabled={detail.loading}
                  >
                    {sourceName(variant.source)}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="comic-detail__chapter-head">
              <div>
                <strong>话列表</strong>
                {!detail.loading ? <span> · 共 {detail.chapters.length} 话</span> : null}
              </div>
              <div className="comic-detail__chapter-tools">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={toggleAll}
                  disabled={!detail.chapters.length}
                >
                  {allSelected ? '清空' : '全选'}
                </button>
                <select
                  className="input comic-mode-select"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as PackMode)}
                  aria-label="打包方式"
                >
                  {PACK_MODES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {detail.loading ? (
              <div className="comic-chapters comic-chapters--state">
                <span className="spinner" /> 正在加载话列表…
                {detail.error ? <span>{detail.error}</span> : null}
              </div>
            ) : detail.error ? (
              <div className="comic-chapters comic-chapters--state">
                <div>{detail.error}</div>
                {detail.blocked ? (
                  <div className="comic-detail__hint">
                    可以切换其它来源，或在设置中配置代理后再试。
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    const seq = ++detailSeq.current;
                    setDetail((prev) =>
                      prev ? { ...prev, loading: true, error: '', blocked: false } : prev,
                    );
                    void fetchChapters(detail.variant, seq);
                  }}
                >
                  <RefreshCw size={14} />
                  重新加载
                </button>
              </div>
            ) : detail.chapters.length ? (
              <div className="comic-chapters">
                {detail.chapters.map((chapter, index) => {
                  const checked = detail.selected.includes(chapter.id);
                  return (
                    <label
                      key={`${chapter.id}-${index}`}
                      className={`comic-chapter${checked ? ' is-on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChapter(chapter.id)}
                      />
                      <span className="comic-chapter__label">
                        {chapterLabel(chapter, index)}
                      </span>
                      {chapter.lang ? (
                        <span className="comic-chapter__lang">{chapter.lang}</span>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm btn--icon"
                        onClick={(event) => {
                          event.preventDefault();
                          openOnlineReader(detail.variant, detail.chapters, index);
                        }}
                        title="阅读这一话"
                        aria-label="阅读这一话"
                      >
                        <BookOpen size={13} />
                      </button>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="comic-chapters comic-chapters--state">暂无章节</div>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        title="取消收藏"
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setRemoveTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void removeFavorite()}>
              取消收藏
            </button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          确定取消收藏《{removeTarget?.title}》吗？已下载的 PDF 不会被删除。
        </p>
      </Modal>

      {reader ? (
        <div
          className={`comic-reader${readerDark ? ' comic-reader--dark' : ''}${
            readerUiHidden ? ' comic-reader--ui-hidden' : ''
          }`}
          style={
            {
              '--czoom': String(readerZoom),
              '--cfit': `${Math.max(200, Math.floor((readerBodyHeight || window.innerHeight) / readerZoom))}px`,
            } as CSSProperties
          }
          role="dialog"
          aria-modal="true"
          aria-label="漫画阅读器"
        >
          <header className="comic-reader__bar">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setReader(null);
                setReaderTocOpen(false);
                setReaderUiHidden(false);
                setComicThumbs({});
              }}
              title="关闭(Esc)"
            >
              <X size={15} />
              关闭
            </button>
            <div className="comic-reader__heading">
              <div className="comic-reader__title" title={reader.variant.title}>
                {reader.variant.title}
              </div>
              <div className="comic-reader__sub">
                {chapterLabel(reader.chapters[reader.index], reader.index)}
                {reader.chapters.length ? ` · ${reader.index + 1}/${reader.chapters.length}` : ''}
                {reader.pages.length ? ` · 本话 ${reader.pages.length} 页` : ''}
              </div>
            </div>
            <div className="comic-reader__controls">
              <div className="comic-reader__group">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => changeReaderZoom(-0.1)}
                  disabled={readerZoom <= 0.5}
                  title="缩小(Ctrl+-)"
                  aria-label="缩小"
                >
                  <ZoomOut size={14} />
                </button>
                <span className="comic-reader__zoomval">{Math.round(readerZoom * 100)}%</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => changeReaderZoom(0.1)}
                  disabled={readerZoom >= 2}
                  title="放大(Ctrl++)"
                  aria-label="放大"
                >
                  <ZoomIn size={14} />
                </button>
              </div>
              <div className="comic-reader__group">
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${readerFit === 'width' ? ' is-on' : ''}`}
                  onClick={() => setReaderFit('width')}
                  title="图片适应宽度"
                >
                  适宽
                </button>
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${readerFit === 'page' ? ' is-on' : ''}`}
                  onClick={() => setReaderFit('page')}
                  title="整页显示(不超出一屏)"
                >
                  整页
                </button>
              </div>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${readerDark ? ' is-on' : ''}`}
                onClick={() => setReaderDark((value) => !value)}
                title="夜读模式(D)"
              >
                {readerDark ? <Sun size={14} /> : <Moon size={14} />}
                夜读
              </button>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${readerTocOpen ? ' is-on' : ''}`}
                onClick={() => {
                  setReaderTocOpen((value) => !value);
                  setReaderUiHidden(false);
                }}
                title="目录(T)"
              >
                <List size={14} />
                目录
              </button>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${readerTwoPage ? ' is-on' : ''}`}
                onClick={() => setReaderTwoPage((value) => !value)}
                title="双页并排(宽窗口生效)"
              >
                双页
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={toggleFullscreen}
                title="全屏(F)"
                aria-label="全屏"
              >
                {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void showChapter(reader.index - 1)}
                disabled={reader.index <= 0 || reader.loading}
                title="上一话(←)"
              >
                <ChevronLeft size={15} />
                上一话
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void showChapter(reader.index + 1)}
                disabled={reader.index >= reader.chapters.length - 1 || reader.loading}
                title="下一话(→)"
              >
                下一话
                <ChevronRight size={15} />
              </button>
            </div>
          </header>
          <div
            className={`comic-reader__body${readerTwoPage ? ' is-two-page' : ''}${
              readerFit === 'page' ? ' is-fit-page' : ''
            }`}
            ref={readerBodyRef}
            onClick={handleComicBodyClick}
          >
            {reader.loading ? (
              <div className="comic-reader__loading">
                <span className="spinner" /> 正在加载图片…
              </div>
            ) : reader.error ? (
              <div className="comic-reader__loading">
                <div>{reader.error}</div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    void showChapter(reader.index);
                  }}
                >
                  <RefreshCw size={14} />
                  重新加载
                </button>
              </div>
            ) : reader.pages.length ? (
              <>
                {reader.pages.map((url, index) => (
                  <div
                    className="comic-reader__page-wrap"
                    data-page={index + 1}
                    key={`${reader.index}-${index}-${url}`}
                  >
                    <RetryableImage
                      className="comic-reader__page"
                      src={comicImage(url, reader.variant.source)}
                      alt={`第 ${index + 1} 页`}
                      onRetryBlocked={() =>
                        toastRef.current(`第 ${index + 1} 页加载失败，点击占位可重试`, 'error')
                      }
                    />
                  </div>
                ))}
                <div className="comic-reader__end">
                  <span>本话结束 · 共 {reader.pages.length} 页</span>
                  <span className="comic-reader__end-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        void showChapter(reader.index - 1);
                      }}
                      disabled={reader.index <= 0 || reader.loading}
                    >
                      <ChevronLeft size={14} />
                      上一话
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        void showChapter(reader.index + 1);
                      }}
                      disabled={reader.index >= reader.chapters.length - 1 || reader.loading}
                    >
                      下一话
                      <ChevronRight size={14} />
                    </button>
                  </span>
                </div>
              </>
            ) : (
              <div className="comic-reader__loading">这一话没有可用图片。</div>
            )}
          </div>
          {readerTocOpen ? (
            <aside className="comic-reader__drawer" onClick={(event) => event.stopPropagation()}>
              <div className="comic-reader__drawer-head">
                <List size={15} />
                目录
                <span className="comic-reader__drawer-count">
                  {reader.index + 1} / {reader.chapters.length}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => setReaderTocOpen(false)}
                  aria-label="关闭目录"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="comic-reader__toc">
                {reader.chapters.map((chapter, index) => {
                  const thumbs = comicThumbs[index];
                  return (
                    <div key={`${chapter.id}-${index}`} className="comic-reader__toc-group">
                      <div
                        className={`comic-reader__toc-item${
                          index === reader.index ? ' is-current' : ''
                        }`}
                        role="button"
                        tabIndex={0}
                        onClick={() => jumpComicChapter(index)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            jumpComicChapter(index);
                          }
                        }}
                      >
                        <span className="comic-reader__toc-label">
                          {index + 1}. {chapterLabel(chapter, index)}
                        </span>
                        <button
                          type="button"
                          className={`comic-reader__thumb-btn${thumbs ? ' is-on' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleComicThumb(index);
                          }}
                          title="缩略图预览"
                          aria-label="缩略图预览"
                        >
                          <Images size={13} />
                        </button>
                      </div>
                      {thumbs ? (
                        <div className="comic-reader__thumbs">
                          {thumbs.loading ? (
                            <span className="comic-reader__thumbs-state">加载缩略图…</span>
                          ) : thumbs.error ? (
                            <span className="comic-reader__thumbs-state">{thumbs.error}</span>
                          ) : thumbs.urls?.length ? (
                            thumbs.urls.map((url, thumbIndex) => (
                              <button
                                key={`${thumbIndex}-${url}`}
                                type="button"
                                onClick={() => jumpComicChapter(index)}
                                title={`第 ${thumbIndex + 1} 页`}
                              >
                                <RetryableImage
                                  src={comicImage(url, reader.variant.source)}
                                  alt={`第 ${thumbIndex + 1} 页`}
                                />
                              </button>
                            ))
                          ) : (
                            <span className="comic-reader__thumbs-state">本话无图片</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </aside>
          ) : null}
          {!reader.loading && !reader.error && reader.pages.length ? (
            <div className="comic-reader__hud">
              {Math.min(readerPageNo, reader.pages.length)} / {reader.pages.length}
            </div>
          ) : null}
        </div>
      ) : null}

      {pdfReader ? (
        <div
          className={`comic-reader comic-reader--pdf${
            pdfUiHidden ? ' comic-reader--ui-hidden' : ''
          }`}
          style={{ '--pzoom': String(pdfZoom) } as CSSProperties}
          role="dialog"
          aria-modal="true"
          aria-label="PDF 阅读器"
        >
          <header className="comic-reader__bar">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                flushPdfProgress();
                setPdfReader(null);
                setPdfTocOpen(false);
                setPdfUiHidden(false);
              }}
              title="关闭(Esc)"
            >
              <X size={15} />
              关闭
            </button>
            <div className="comic-reader__heading">
              <div className="comic-reader__title" title={pdfReader.title}>
                {pdfReader.title}
              </div>
              <div className="comic-reader__sub" title={pdfReader.file}>
                {pdfReader.file}
                {pdfReader.pages
                  ? ` · ${pdfReader.page}/${pdfReader.pages} 页 · 总进度 ${pdfPercent}%`
                  : ''}
              </div>
            </div>
            <div className="comic-reader__controls">
              <div className="comic-reader__group">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => changePdfZoom(-0.2)}
                  disabled={pdfZoom <= 0.4}
                  title="缩小"
                  aria-label="缩小"
                >
                  <ZoomOut size={14} />
                </button>
                <span className="comic-reader__zoomval">{Math.round(pdfZoom * 100)}%</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => changePdfZoom(0.2)}
                  disabled={pdfZoom >= 3}
                  title="放大"
                  aria-label="放大"
                >
                  <ZoomIn size={14} />
                </button>
              </div>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${pdfTocOpen ? ' is-on' : ''}`}
                onClick={() => {
                  setPdfTocOpen((value) => !value);
                  setPdfUiHidden(false);
                }}
                title="卷/目录(T)"
              >
                <List size={14} />
                卷/目录
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={pdfPrevChapter}
                title="上一话(←)"
                disabled={pdfReader.loading || Boolean(pdfReader.error)}
              >
                <ChevronLeft size={14} />
                上一话
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={pdfNextChapter}
                title="下一话(→)"
                disabled={pdfReader.loading || Boolean(pdfReader.error)}
              >
                下一话
                <ChevronRight size={14} />
              </button>
              <div className="comic-reader__group">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => pdfStepPage(-1)}
                  disabled={pdfReader.loading || Boolean(pdfReader.error)}
                  title="上一页"
                  aria-label="上一页"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="comic-reader__zoomval">
                  {pdfReader.page} / {pdfReader.pages || '—'}
                  {pdfReader.pages ? ` · ${pdfPercent}%` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => pdfStepPage(1)}
                  disabled={pdfReader.loading || Boolean(pdfReader.error)}
                  title="下一页"
                  aria-label="下一页"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${pdfTwoPage ? ' is-on' : ''}`}
                onClick={togglePdfTwoPage}
                disabled={pdfContinuous}
                title="双页并排"
              >
                双页
              </button>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${pdfContinuous ? ' is-on' : ''}`}
                onClick={togglePdfContinuous}
                title="连续滚动(C)"
              >
                连续
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={toggleFullscreen}
                title="全屏(F)"
                aria-label="全屏"
              >
                {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </header>
          <div
            className={`comic-reader__body comic-reader__body--pdf${
              pdfTwoPage ? ' is-two-page' : ''
            }${pdfContinuous ? ' is-continuous' : ''}`}
            ref={pdfBodyRef}
            onScroll={handlePdfScroll}
            onClick={handlePdfBodyClick}
          >
            {pdfReader.loading ? (
              <div className="comic-reader__loading">
                <span className="spinner" /> 正在解析 PDF…
              </div>
            ) : pdfReader.error ? (
              <div className="comic-reader__loading">
                <div>{pdfReader.error}</div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    void openPdf(pdfReader.title, pdfReader.file);
                  }}
                >
                  <RefreshCw size={14} />
                  重新加载
                </button>
              </div>
            ) : !pdfReader.pages ? (
              <div className="comic-reader__loading">PDF 没有可用页面。</div>
            ) : (
              visiblePdfPages.map((page) => (
                <div
                  className={`comic-reader__pdf-wrap${
                    page === pdfReader.page && !pdfContinuous ? ' is-current' : ''
                  }`}
                  data-page={page}
                  key={`${pdfReader.file}-${page}`}
                >
                  <div className="comic-reader__pdf-no">第 {page} 页</div>
                  <RetryableImage
                    className="comic-reader__page comic-reader__page--pdf"
                    src={pdfPageImage(pdfReader.title, pdfReader.file, page)}
                    alt={`第 ${page} 页`}
                    onRetryBlocked={() =>
                      toastRef.current(`第 ${page} 页加载失败，点击占位可重试`, 'error')
                    }
                  />
                </div>
              ))
            )}
          </div>
          {pdfTocOpen ? (
            <aside className="comic-reader__drawer" onClick={(event) => event.stopPropagation()}>
              <div className="comic-reader__drawer-head">
                <List size={15} />
                卷 / 目录
                <span className="comic-reader__drawer-count">
                  {pdfReader.page} / {pdfReader.pages || '—'}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => setPdfTocOpen(false)}
                  aria-label="关闭目录"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="comic-reader__toc">
                {pdfReader.meta?.volumes?.length ? (
                  pdfReader.meta.volumes.map((volume, volumeIndex) => (
                    <div key={`${volumeIndex}-${volume.volume || ''}`} className="comic-reader__toc-group">
                      <div className="comic-reader__toc-vol">
                        第 {volumeIndex + 1} 卷
                        {volume.volume ? ` · ${volume.volume}` : ''}
                      </div>
                      {(volume.chapters ?? []).map((chapter, chapterIndex) => {
                        const perChapter = pdfReader.meta?.mode === 'per_chapter';
                        const active = perChapter
                          ? chapter.pdf === pdfReader.file
                          : (chapter.first_page || 1) <= pdfReader.page &&
                            pdfReader.page <=
                              (chapter.last_page || Number.POSITIVE_INFINITY);
                        const label = chapter.chapter
                          ? `第${chapter.chapter}话`
                          : chapter.label ||
                            chapter.pdf?.replace(/\.pdf$/i, '') ||
                            `第 ${chapterIndex + 1} 话`;
                        return (
                          <div
                            key={`${chapterIndex}-${chapter.pdf || chapter.first_page || ''}`}
                            className={`comic-reader__toc-item${active ? ' is-current' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              if (perChapter && chapter.pdf) {
                                setPdfTocOpen(false);
                                void openPdf(pdfReader.title, chapter.pdf);
                              } else {
                                jumpPdfPage(chapter.first_page || 1);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              if (perChapter && chapter.pdf) {
                                setPdfTocOpen(false);
                                void openPdf(pdfReader.title, chapter.pdf);
                              } else {
                                jumpPdfPage(chapter.first_page || 1);
                              }
                            }}
                          >
                            <span className="comic-reader__toc-label">
                              {label}
                              {chapter.title ? ` ${chapter.title}` : ''}
                            </span>
                            <span className="comic-reader__toc-hint">
                              {perChapter ? '' : `第 ${chapter.first_page || 1} 页`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))
                ) : pdfReader.files.length ? (
                  pdfReader.files.map((file) => (
                    <div
                      key={file}
                      className={`comic-reader__toc-item${
                        file === pdfReader.file ? ' is-current' : ''
                      }`}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setPdfTocOpen(false);
                        void openPdf(pdfReader.title, file);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setPdfTocOpen(false);
                        void openPdf(pdfReader.title, file);
                      }}
                    >
                      <span className="comic-reader__toc-label">
                        {file.replace(/\.pdf$/i, '')}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="comic-reader__toc-empty">暂无目录信息</div>
                )}
              </div>
            </aside>
          ) : null}
          {pdfContinuous && pdfReader.pages && !pdfReader.error ? (
            <div className="comic-reader__hud">
              {pdfReader.page} / {pdfReader.pages} · {pdfPercent}%
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
