import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
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
type FitMode = 'width' | 'height';

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
  const [draftPage, setDraftPage] = useState('1');
  const [chapterMap, setChapterMap] = useState<Record<string, number>>({});
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const pageRef = useRef(page);
  const totalRef = useRef(numPages);
  const sourceRef = useRef<ComicSource | null>(null);
  const fileRef = useRef(file);
  const chapterMapRef = useRef<Record<string, number>>({});
  pageRef.current = page;
  totalRef.current = numPages;
  sourceRef.current = source;
  fileRef.current = file;

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
    if (!source || !file || !page || numPages <= 0) return;
    // 看过的页记 1:总进度只累计从第 1 页连续翻过来的部分
    const next = { ...chapterMapRef.current, [String(page)]: 1 };
    chapterMapRef.current = next;
    setChapterMap(next);
    source.saveProgress(file, page, numPages, next);
  }, [file, numPages, page, source]);

  // 本地页是 ZIP 里的 JPEG,取出来才能给 img;所以图片地址是异步的
  useEffect(() => {
    if (!source || !file || !page) return;
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
  }, [file, imageReload, page, source]);

  useEffect(() => {
    if (!source || !file || numPages <= 0 || !page) return;
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
  }, [file, numPages, page, source]);

  const goPage = useCallback((next: number) => {
    const total = totalRef.current;
    setPage(Math.min(Math.max(1, next), Math.max(1, total)));
  }, []);

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

  const active = page || 1;
  const totalPercent = continuousPercent({ total: numPages, ch: page, chapters: chapterMap });
  const backHref = source?.detailHref || (id ? '/shelf' : '/library');

  return (
    <div className={`comic-reader${night ? ' is-night' : ''}`}>
      <header className={`reader-bar comic-top${chromeVisible ? ' is-visible' : ''}`}>
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
          aria-label={night ? '关闭夜间模式' : '开启夜间模式'}
          onClick={() => setNight((value) => !value)}
        >
          {night ? <Sun size={21} /> : <Moon size={21} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={fit === 'width' ? '切换为适应高度' : '切换为适应宽度'}
          onClick={() => setFit((value) => (value === 'width' ? 'height' : 'width'))}
        >
          {fit === 'width' ? <Maximize2 size={20} /> : <Minimize2 size={20} />}
        </button>
      </header>

      <main
        className={`comic-stage comic-stage--fit-${fit}${pageLoading ? ' is-loading' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
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
          disabled={numPages > 0 && page >= numPages}
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
                  第 {active} 页 · 共 {numPages} 页 · 总进度 {totalPercent}%
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
              value={active}
              onChange={(event) => goPage(Number(event.target.value))}
            />
            <div className="comic-jump">
              <button type="button" className="btn btn--ghost" onClick={() => goPage(page - 10)}>
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
              <button type="button" className="btn btn--ghost" onClick={() => goPage(page + 10)}>
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
