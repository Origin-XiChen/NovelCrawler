import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  Rows3,
  Sun,
  X,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { displayName, errorMessage } from '../lib/format';
import {
  localBook,
  localComicSource,
  onlineComicSource,
  type ComicSource,
} from '../lib/content';
import {
  continuousPercent,
  flushSharedProgress,
  seedLegacyChapters,
} from '../lib/reading-progress';
import type { ComicPdfMeta } from '../lib/types';

const NIGHT_KEY = 'nc_mobile_comic_night_v1';
const FIT_KEY = 'nc_mobile_comic_fit_v1';
const MODE_KEY = 'nc_mobile_comic_mode_v1';
const DEFAULT_ASPECT = 0.7;
const SCROLL_WINDOW = 9;
type FitMode = 'width' | 'height';
type ReadMode = 'page' | 'scroll';

interface ScrollImages {
  key: string;
  urls: Record<string, string>;
  errors: Record<string, string>;
}

const EMPTY_IMAGES: ScrollImages = { key: '', urls: {}, errors: {} };

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readFit(): FitMode {
  try {
    return localStorage.getItem(FIT_KEY) === 'height' ? 'height' : 'width';
  } catch {
    return 'width';
  }
}

function readMode(): ReadMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'page' ? 'page' : 'scroll';
  } catch {
    return 'scroll';
  }
}

interface ComicScrollPageProps {
  page: number;
  url: string;
  failure: string;
  ratio: number;
  active: boolean;
  onLoad: (page: number, image: HTMLImageElement) => void;
  onFail: (page: number) => void;
  onRetry: (page: number) => void;
}

const ComicScrollPage = memo(function ComicScrollPage({
  page,
  url,
  failure,
  ratio,
  active,
  onLoad,
  onFail,
  onRetry,
}: ComicScrollPageProps) {
  return (
    <div
      className="comic-scroll__page"
      data-comic-page={page}
      style={{ aspectRatio: ratio }}
    >
      {url ? (
        <img
          src={url}
          alt={`第 ${page} 页`}
          loading="lazy"
          decoding="async"
          draggable={false}
          onContextMenu={(event) => event.preventDefault()}
          onLoad={(event) => onLoad(page, event.currentTarget)}
          onError={() => onFail(page)}
        />
      ) : failure ? (
        <button
          type="button"
          className="comic-scroll__retry"
          onClick={() => onRetry(page)}
        >
          <strong>第 {page} 页加载失败</strong>
          <span>点击重新加载</span>
        </button>
      ) : (
        <div className="comic-scroll__pending">
          {active ? <Loader2 size={26} className="spin" /> : null}
        </div>
      )}
    </div>
  );
});

export default function ComicReaderPage() {
  const navigate = useNavigate();
  // /comic/:title 读电脑上的漫画,/local/comic/:id 读手机里的离线包
  const { title = '', id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [initialPage] = useState(() => Math.max(0, Number(params.get('page')) || 0));
  const [source, setSource] = useState<ComicSource | null>(null);
  const [file, setFile] = useState(() => params.get('file') || '');
  const [page, setPage] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [pageSrc, setPageSrc] = useState('');
  const [pageLoading, setPageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [imageReload, setImageReload] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [night, setNight] = useState(() => readFlag(NIGHT_KEY));
  const [fit, setFit] = useState<FitMode>(() => readFit());
  const [mode, setMode] = useState<ReadMode>(() => readMode());
  const [draftPage, setDraftPage] = useState('1');
  const [chapterMap, setChapterMap] = useState<Record<string, number>>({});
  const [images, setImages] = useState<ScrollImages>(EMPTY_IMAGES);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const ratiosRef = useRef(ratios);
  const scrollAnchorRef = useRef<{ page: number; offset: number } | null>(null);
  ratiosRef.current = ratios;
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const pageRef = useRef(page);
  const totalRef = useRef(numPages);
  const sourceRef = useRef<ComicSource | null>(null);
  const fileRef = useRef(file);
  const modeRef = useRef(mode);
  const chromeRef = useRef(chromeVisible);
  const chapterMapRef = useRef<Record<string, number>>({});
  const stageRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const offsetsRef = useRef<number[]>([]);
  const imagesRef = useRef(images);
  const inflightRef = useRef(new Set<string>());
  const reloadsRef = useRef<Record<string, number>>({});
  const alignToRef = useRef<number | null>(null);
  const alignedKeyRef = useRef('');
  const scrollRafRef = useRef(0);
  const recalcRafRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const programmaticAtRef = useRef(0);
  pageRef.current = page;
  totalRef.current = numPages;
  sourceRef.current = source;
  fileRef.current = file;
  modeRef.current = mode;
  chromeRef.current = chromeVisible;
  imagesRef.current = images;

  const fileKey = source ? `${source.mode}:${file}` : '';
  const scrollImages = images.key === fileKey ? images : EMPTY_IMAGES;

  // 先确定内容来源:本地包直接查 IndexedDB,在线要先问电脑有几个 PDF
  useEffect(() => {
    let cancelled = false;
    setLoadingMeta(true);
    setError('');
    if (id) {
      localBook(id)
        .then((book) => {
          if (cancelled) return;
          if (!book || book.kind !== 'comic') {
            setError('这本漫画不在手机里,请先在"电脑"页下载到手机');
            setLoadingMeta(false);
            return;
          }
          setSource(localComicSource(book));
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(errorMessage(cause));
            setLoadingMeta(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
    if (!title) {
      navigate('/home', { replace: true });
      return undefined;
    }
    apiGet<ComicPdfMeta>('/api/comic_pdf_meta', { title })
      .then((data) => {
        if (cancelled) return;
        const pdfs = data.pdfs || [];
        if (!pdfs.length) throw new Error('这部漫画没有可阅读的 PDF');
        const online = onlineComicSource(title, pdfs);
        if (!online) {
          navigate('/connect', { replace: true });
          return;
        }
        setSource(online);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(errorMessage(cause));
          setLoadingMeta(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, navigate, reloadToken, title]);

  useEffect(() => {
    if (!source) return;
    if (file && source.files.includes(file)) return;
    setFile(source.files[0] || '');
  }, [file, source]);

  useEffect(() => {
    if (!source || !file) return;
    let cancelled = false;
    setLoadingMeta(true);
    setError('');
    Promise.all([source.loadPageCount(file), source.loadProgress(file)])
      .then(([count, saved]) => {
        if (cancelled) return;
        setNumPages(count);
        const seeded =
          saved?.chapters && Object.keys(saved.chapters).length
            ? saved.chapters
            : seedLegacyChapters(saved?.ch || 0, 0, count);
        chapterMapRef.current = seeded;
        setChapterMap(seeded);
        setPage((prev) => {
          const target = prev || initialPage || saved?.ch || 1;
          return Math.min(Math.max(1, target), Math.max(1, count));
        });
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, initialPage, reloadToken, source]);

  useEffect(() => {
    if (!source || !file || !page) return;
    const urlPage = Number(params.get('page')) || 0;
    const urlFile = params.get('file') || '';
    const sameFile = source.mode === 'local' ? !urlFile : urlFile === file;
    if (urlPage === page && sameFile) return;
    const next = new URLSearchParams(params);
    if (source.mode === 'local') next.delete('file');
    else next.set('file', file);
    next.set('page', String(page));
    setParams(next, { replace: true });
  }, [file, page, params, setParams, source]);

  useEffect(() => {
    try {
      localStorage.setItem(NIGHT_KEY, night ? '1' : '0');
    } catch {
      // ignore
    }
  }, [night]);

  useEffect(() => {
    try {
      localStorage.setItem(FIT_KEY, fit);
    } catch {
      // ignore
    }
  }, [fit]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  useEffect(() => {
    if (!source || !file || !page || numPages <= 0) return;
    // 看过的页记 1:总进度只累计从第 1 页连续翻过来的部分
    if (chapterMapRef.current[String(page)] !== 1) {
      const next = { ...chapterMapRef.current, [String(page)]: 1 };
      chapterMapRef.current = next;
      setChapterMap(next);
    }
    if (mode === 'scroll') {
      // 连续滚动时翻页很快,写盘防抖,离开页面时仍由 visibilitychange 兜底
      const timer = window.setTimeout(() => {
        source.saveProgress(file, pageRef.current, numPages, chapterMapRef.current);
      }, 650);
      return () => window.clearTimeout(timer);
    }
    source.saveProgress(file, page, numPages, chapterMapRef.current);
    return undefined;
  }, [file, mode, numPages, page, source]);

  // 本地页是 ZIP 里的 JPEG,取出来才能给 img;所以图片地址是异步的
  useEffect(() => {
    if (mode !== 'page' || !source || !file || !page) return;
    let cancelled = false;
    setPageLoading(true);
    setImageError(false);
    source
      .pageUrl(file, page, imageReload)
      .then((url) => {
        if (cancelled) return;
        setPageSrc(url);
        setPageLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setPageSrc('');
        setPageLoading(false);
        setImageError(true);
        setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [file, imageReload, mode, page, source]);

  useEffect(() => {
    if (mode !== 'page' || !source || !file || numPages <= 0 || !page) return;
    const images: HTMLImageElement[] = [];
    [page + 1, page + 2, page - 1]
      .filter((value) => value >= 1 && value <= numPages)
      .forEach((value) => {
        void source
          .pageUrl(file, value)
          .then((url) => {
            const image = new Image();
            image.src = url;
            images.push(image);
          })
          .catch(() => {
            // 预热失败不要紧,翻到那一页会再取一次
          });
      });
    return () => {
      images.forEach((image) => {
        image.src = '';
      });
    };
  }, [file, mode, numPages, page, source]);

  useEffect(() => {
    lastScrollTopRef.current = 0;
  }, [file, mode]);

  useEffect(() => {
    setRatios({});
    reloadsRef.current = {};
    scrollAnchorRef.current = null;
  }, [file, id, title]);

  const windowRange = useMemo(() => {
    if (numPages <= 0) return { start: 1, end: 0 };
    const start = Math.max(1, Math.min(page - 2, numPages - (SCROLL_WINDOW - 1)));
    return { start, end: Math.min(numPages, start + (SCROLL_WINDOW - 1)) };
  }, [numPages, page]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (recalcRafRef.current) cancelAnimationFrame(recalcRafRef.current);
    };
  }, []);

  const recalcOffsets = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const nodes = stage.querySelectorAll<HTMLElement>('[data-comic-page]');
    if (!nodes.length) {
      offsetsRef.current = [];
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    offsetsRef.current = Array.from(
      nodes,
      (node) => node.getBoundingClientRect().top - stageRect.top + stage.scrollTop,
    );
  }, []);

  const recalcRef = useRef(recalcOffsets);
  recalcRef.current = recalcOffsets;

  const scheduleRecalc = useCallback(() => {
    if (recalcRafRef.current) return;
    recalcRafRef.current = requestAnimationFrame(() => {
      recalcRafRef.current = 0;
      recalcRef.current();
    });
  }, []);

  const scrollToPage = useCallback((target: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    recalcRef.current();
    const top = offsetsRef.current[target - 1];
    if (top == null) return;
    const inset = chromeRef.current ? headerRef.current?.offsetHeight || 0 : 0;
    programmaticAtRef.current = Date.now();
    stage.scrollTop = Math.max(0, top - inset);
    lastScrollTopRef.current = stage.scrollTop;
  }, []);

  const loadScrollPage = useCallback(async (target: number, reload = 0) => {
    const currentSource = sourceRef.current;
    const currentFile = fileRef.current;
    if (!currentSource || !currentFile) return;
    const pageKey = String(target);
    const bookKey = `${currentSource.mode}:${currentFile}`;
    const flight = `${bookKey}#${pageKey}`;
    if (inflightRef.current.has(flight)) return;
    inflightRef.current.add(flight);
    try {
      const url = await currentSource.pageUrl(currentFile, target, reload);
      setImages((prev) => {
        const base = prev.key === bookKey ? prev : { key: bookKey, urls: {}, errors: {} };
        const errors = { ...base.errors };
        delete errors[pageKey];
        return { key: bookKey, urls: { ...base.urls, [pageKey]: url }, errors };
      });
    } catch (cause) {
      setImages((prev) => {
        const base = prev.key === bookKey ? prev : { key: bookKey, urls: {}, errors: {} };
        return {
          key: bookKey,
          urls: base.urls,
          errors: { ...base.errors, [pageKey]: errorMessage(cause) },
        };
      });
    } finally {
      inflightRef.current.delete(flight);
    }
  }, []);

  // 本地页走 LRU,翻远之后旧 blob 会被回收;把窗口外的地址从状态里丢掉,
  // 回头再看时重新取一次,不会拿到已经 revoke 的地址
  useEffect(() => {
    if (mode !== 'scroll' || !fileKey) return;
    const start = windowRange.start - 2;
    const end = windowRange.end + 2;
    setImages((prev) => {
      if (prev.key !== fileKey) return prev;
      let changed = false;
      const urls = { ...prev.urls };
      const errors = { ...prev.errors };
      for (const key of Object.keys(urls)) {
        const value = Number(key);
        if (value < start || value > end) {
          delete urls[key];
          changed = true;
        }
      }
      for (const key of Object.keys(errors)) {
        const value = Number(key);
        if (value < start || value > end) {
          delete errors[key];
          changed = true;
        }
      }
      return changed ? { ...prev, urls, errors } : prev;
    });
  }, [fileKey, mode, windowRange]);

  useEffect(() => {
    if (mode !== 'scroll' || !source || !file || numPages <= 0) return;
    const bookKey = `${source.mode}:${file}`;
    const state = imagesRef.current.key === bookKey ? imagesRef.current : EMPTY_IMAGES;
    for (let target = windowRange.start; target <= windowRange.end; target += 1) {
      const pageKey = String(target);
      if (state.urls[pageKey] || state.errors[pageKey]) continue;
      if (inflightRef.current.has(`${bookKey}#${pageKey}`)) continue;
      void loadScrollPage(target);
    }
  }, [file, loadScrollPage, mode, numPages, source, windowRange]);

  const handleScrollImageLoad = useCallback((target: number, image: HTMLImageElement) => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return;
    const ratio = width / height;
    const key = String(target);
    const current = ratiosRef.current[key];
    if (current && Math.abs(current - ratio) < 0.0001) return;
    // 占位比例换成真实比例会改变整列高度;先记住当前页的位置,渲染后补回滚动量
    const anchorPage = pageRef.current || 1;
    const anchorOffset = offsetsRef.current[anchorPage - 1];
    if (anchorOffset != null) {
      scrollAnchorRef.current = { page: anchorPage, offset: anchorOffset };
    }
    setRatios((prev) =>
      Math.abs((prev[key] || 0) - ratio) < 0.0001 ? prev : { ...prev, [key]: ratio },
    );
  }, []);

  const failScrollPage = useCallback((target: number) => {
    const currentSource = sourceRef.current;
    const currentFile = fileRef.current;
    if (!currentSource || !currentFile) return;
    const pageKey = String(target);
    const bookKey = `${currentSource.mode}:${currentFile}`;
    setImages((prev) => {
      const base = prev.key === bookKey ? prev : { key: bookKey, urls: {}, errors: {} };
      const urls = { ...base.urls };
      delete urls[pageKey];
      return { key: bookKey, urls, errors: { ...base.errors, [pageKey]: 'failed' } };
    });
  }, []);

  const retryScrollPage = useCallback(
    (target: number) => {
      const currentSource = sourceRef.current;
      const currentFile = fileRef.current;
      if (!currentSource || !currentFile) return;
      const pageKey = String(target);
      const bookKey = `${currentSource.mode}:${currentFile}`;
      const flight = `${bookKey}#${pageKey}`;
      inflightRef.current.delete(flight);
      setImages((prev) => {
        if (prev.key !== bookKey) return prev;
        const urls = { ...prev.urls };
        const errors = { ...prev.errors };
        delete urls[pageKey];
        delete errors[pageKey];
        return { ...prev, urls, errors };
      });
      const reload = (reloadsRef.current[pageKey] || 0) + 1;
      reloadsRef.current[pageKey] = reload;
      void loadScrollPage(target, reload);
    },
    [loadScrollPage],
  );

  const handleStageScroll = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || modeRef.current !== 'scroll') return;
    const top = stage.scrollTop;
    const delta = top - lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    if (
      Date.now() - programmaticAtRef.current > 250 &&
      Math.abs(delta) > 12
    ) {
      if (delta > 0 && top > 32 && chromeRef.current) setChromeVisible(false);
      else if (delta < 0 && !chromeRef.current) setChromeVisible(true);
    }
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const element = stageRef.current;
      if (!element) return;
      let offsets = offsetsRef.current;
      if (offsets.length !== totalRef.current) {
        recalcRef.current();
        offsets = offsetsRef.current;
      }
      if (!offsets.length) return;
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 4) {
        setPage((prev) => (prev === totalRef.current ? prev : totalRef.current));
        return;
      }
      const probe = element.scrollTop + element.clientHeight * 0.35;
      let lo = 0;
      let hi = offsets.length - 1;
      let found = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= probe) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const nextPage = Math.min(Math.max(1, found + 1), totalRef.current);
      setPage((prev) => (prev === nextPage ? prev : nextPage));
    });
  }, []);

  const goPage = useCallback(
    (next: number) => {
      const total = totalRef.current;
      const target = Math.min(Math.max(1, next), Math.max(1, total));
      setPage(target);
      if (modeRef.current === 'scroll') scrollToPage(target);
    },
    [scrollToPage],
  );

  useLayoutEffect(() => {
    if (mode !== 'scroll' || numPages <= 0) return;
    const key = `${source?.mode || ''}:${file}`;
    const forced = alignToRef.current;
    if (!forced && alignedKeyRef.current === key) return;
    const target = forced || pageRef.current || 1;
    if (!target) return;
    alignToRef.current = null;
    const raf = requestAnimationFrame(() => {
      scrollToPage(target);
      alignedKeyRef.current = key;
    });
    return () => cancelAnimationFrame(raf);
  }, [file, mode, numPages, page, scrollToPage, source]);

  useLayoutEffect(() => {
    if (mode !== 'scroll' || numPages <= 0) return;
    recalcOffsets();
    const raf = requestAnimationFrame(() => recalcRef.current());
    return () => cancelAnimationFrame(raf);
  }, [mode, numPages, recalcOffsets]);

  // 图片真实高度替换占位高度后，把当前页重新钉在原来的位置
  useLayoutEffect(() => {
    if (mode !== 'scroll') return;
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const stage = stageRef.current;
    if (!stage) return;
    recalcRef.current();
    const next = offsetsRef.current[anchor.page - 1];
    if (next != null && Math.abs(next - anchor.offset) > 0.5) {
      stage.scrollTop += next - anchor.offset;
      lastScrollTopRef.current = stage.scrollTop;
      programmaticAtRef.current = Date.now();
    }
  }, [mode, ratios]);

  useEffect(() => {
    if (mode !== 'scroll') return;
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(scheduleRecalc);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [mode, numPages, scheduleRecalc]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPage(pageRef.current - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goPage(pageRef.current + 1);
      } else if (event.key === 'Escape') {
        setSheetOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goPage]);

  useEffect(() => {
    const save = () => {
      const current = sourceRef.current;
      if (!current || !fileRef.current || totalRef.current <= 0 || !pageRef.current) return;
      current.saveProgress(
        fileRef.current,
        pageRef.current,
        totalRef.current,
        chapterMapRef.current,
      );
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        save();
        flushSharedProgress();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      save();
      flushSharedProgress();
    };
  }, []);

  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchRef.current.x;
    const dy = touch.clientY - touchRef.current.y;
    const elapsed = Date.now() - touchRef.current.time;
    if (elapsed > 800 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    goPage(pageRef.current + (dx < 0 ? 1 : -1));
  };

  const openSheet = () => {
    setDraftPage(String(page || 1));
    setSheetOpen(true);
  };

  const jumpToDraft = () => {
    goPage(Number(draftPage) || 1);
    setSheetOpen(false);
  };

  const nudgePage = (delta: number) => {
    const current = Number(draftPage) || pageRef.current || 1;
    const next = Math.min(Math.max(1, current + delta), Math.max(1, numPages));
    setDraftPage(String(next));
    goPage(next);
  };

  const toggleMode = () => {
    const next: ReadMode = mode === 'scroll' ? 'page' : 'scroll';
    if (next === 'scroll') alignToRef.current = pageRef.current || 1;
    setMode(next);
  };

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, index) => index + 1),
    [numPages],
  );

  const active = page || 1;
  const totalPercent = continuousPercent({ total: numPages, ch: page, chapters: chapterMap });
  const backHref = source?.detailHref || (id ? '/shelf' : '/library');
  const stageClass =
    mode === 'scroll'
      ? 'comic-stage comic-stage--scroll'
      : `comic-stage comic-stage--fit-${fit}${pageLoading ? ' is-loading' : ''}`;

  return (
    <div className={`comic-reader${night ? ' is-night' : ''}`}>
      <header
        ref={headerRef}
        className={`reader-bar comic-top${chromeVisible ? ' is-visible' : ''}`}
      >
        <button
          type="button"
          className="icon-btn"
          aria-label="返回漫画详情"
          onClick={() => navigate(backHref)}
        >
          <ArrowLeft size={22} />
        </button>
        <div className="comic-top__title">
          <strong>{source?.title || title || '正在打开…'}</strong>
          <span>
            {displayName(file) || '正在读取…'} · {page} / {numPages || '?'}
            {numPages > 0 ? ` · 总进度 ${totalPercent}%` : ''}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={mode === 'scroll' ? '切换为翻页模式' : '切换为连续滚动'}
          onClick={toggleMode}
        >
          {mode === 'scroll' ? <Columns3 size={21} /> : <Rows3 size={21} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={night ? '关闭夜间模式' : '开启夜间模式'}
          onClick={() => setNight((value) => !value)}
        >
          {night ? <Sun size={21} /> : <Moon size={21} />}
        </button>
        {mode === 'page' && (
          <button
            type="button"
            className="icon-btn"
            aria-label={fit === 'width' ? '切换为适应高度' : '切换为适应宽度'}
            onClick={() => setFit((value) => (value === 'width' ? 'height' : 'width'))}
          >
            {fit === 'width' ? <Maximize2 size={20} /> : <Minimize2 size={20} />}
          </button>
        )}
      </header>

      <main
        ref={stageRef}
        className={stageClass}
        onScroll={mode === 'scroll' ? handleStageScroll : undefined}
        onTouchStart={mode === 'page' ? handleTouchStart : undefined}
        onTouchEnd={mode === 'page' ? handleTouchEnd : undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, input')) return;
          setChromeVisible((value) => !value);
        }}
      >
        {error ? (
          <div className="reader-message">
            <p>{error}</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              重试
            </button>
          </div>
        ) : loadingMeta ? (
          <div className="reader-message">
            <Loader2 size={26} className="spin" />
            <p>正在读取漫画…</p>
          </div>
        ) : numPages === 0 ? (
          <div className="reader-message">
            <p>这部漫画没有可阅读的页面</p>
            <button type="button" className="btn btn--ghost" onClick={() => navigate(backHref)}>
              返回详情
            </button>
          </div>
        ) : mode === 'scroll' ? (
          <div className="comic-scroll">
            {pageNumbers.map((value) => {
              const pageKey = String(value);
              return (
                <ComicScrollPage
                  key={pageKey}
                  page={value}
                  url={scrollImages.urls[pageKey] || ''}
                  failure={scrollImages.errors[pageKey] || ''}
                  ratio={ratios[pageKey] ?? DEFAULT_ASPECT}
                  active={value === page}
                  onLoad={handleScrollImageLoad}
                  onFail={failScrollPage}
                  onRetry={retryScrollPage}
                />
              );
            })}
          </div>
        ) : (
          <>
            {pageSrc && (
              <img
                key={`${page}-${imageReload}`}
                className="comic-page-img"
                src={pageSrc}
                alt={`第 ${active} 页`}
                draggable={false}
                onContextMenu={(event) => event.preventDefault()}
                onLoad={() => setPageLoading(false)}
                onError={() => {
                  setPageLoading(false);
                  setImageError(true);
                }}
              />
            )}
            {pageLoading && (
              <div className="comic-page-loading">
                <Loader2 size={28} className="spin" />
              </div>
            )}
            {imageError && !pageLoading && (
              <div className="comic-image-error">
                <p>这一页加载失败,可能是内容已损坏。</p>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setImageReload((value) => value + 1)}
                >
                  重新加载
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className={`reader-bar comic-bottom${chromeVisible ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="icon-btn"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => goPage(page - 1)}
        >
          <ChevronLeft size={26} />
        </button>
        <button type="button" className="comic-page-indicator" onClick={openSheet}>
          <strong>{active}</strong>
          <span>/ {numPages || '?'}</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="下一页"
          disabled={numPages <= 0 || page >= numPages}
          onClick={() => goPage(page + 1)}
        >
          <ChevronRight size={26} />
        </button>
      </footer>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div
            className="comic-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="跳转到页面"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="reader-sheet__head">
              <div>
                <h2>跳转页面</h2>
                <p>
                  第 {Number(draftPage) || active} 页 · 共 {numPages} 页 · 总进度 {totalPercent}%
                </p>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setSheetOpen(false)}>
                <X size={22} />
              </button>
            </header>
            <input
              className="comic-slider"
              type="range"
              min={1}
              max={Math.max(1, numPages)}
              value={Number(draftPage) || active}
              onChange={(event) => {
                const value = Number(event.target.value);
                setDraftPage(String(value));
                if (mode === 'page') goPage(value);
              }}
              onPointerUp={(event) => {
                if (mode === 'scroll') {
                  goPage(Number((event.target as HTMLInputElement).value) || 1);
                }
              }}
            />
            <div className="comic-jump">
              <button type="button" className="btn btn--ghost" onClick={() => nudgePage(-10)}>
                -10
              </button>
              <label className="comic-jump__field">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={Math.max(1, numPages)}
                  value={draftPage}
                  onChange={(event) => setDraftPage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') jumpToDraft();
                  }}
                />
                <span>/ {numPages}</span>
              </label>
              <button type="button" className="btn btn--ghost" onClick={() => nudgePage(10)}>
                +10
              </button>
            </div>
            <button type="button" className="btn btn--primary btn--lg" onClick={jumpToDraft}>
              跳转
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
