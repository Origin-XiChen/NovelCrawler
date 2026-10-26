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
import { apiGet, mediaUrl } from '../lib/api';
import { getActiveServer } from '../lib/connection';
import { displayName, errorMessage } from '../lib/format';
import { loadProgress, saveProgress } from '../lib/progress';
import type { ComicPageMeta, ComicPdfMeta } from '../lib/types';

const NIGHT_KEY = 'nc_mobile_comic_night_v1';
const FIT_KEY = 'nc_mobile_comic_fit_v1';
type FitMode = 'width' | 'height';

function comicKey(title: string, file: string): string {
  return `comic::${title}::${file}`;
}

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
  const { title = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const initialQueryRef = useRef({
    file: params.get('file') || '',
    page: Math.max(0, Number(params.get('page')) || 0),
  });
  const [server] = useState(() => getActiveServer());
  const [file, setFile] = useState(() => initialQueryRef.current.file);
  const [page, setPage] = useState(() => {
    const initial = initialQueryRef.current;
    if (initial.page) return initial.page;
    const active = getActiveServer();
    if (initial.file && active) {
      const saved = loadProgress(active.id, comicKey(title, initial.file));
      if (saved?.chapter) return Math.max(1, saved.chapter);
    }
    return 1;
  });
  const [numPages, setNumPages] = useState(0);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [error, setError] = useState('');
  const [metaReload, setMetaReload] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [imageReload, setImageReload] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [night, setNight] = useState(() => readFlag(NIGHT_KEY));
  const [fit, setFit] = useState<FitMode>(() => readFit());
  const [draftPage, setDraftPage] = useState('1');
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const pageRef = useRef(page);
  const totalRef = useRef(numPages);
  const fileRef = useRef(file);
  pageRef.current = page;
  totalRef.current = numPages;
  fileRef.current = file;

  useEffect(() => {
    if (!server) {
      navigate('/connect', { replace: true });
      return;
    }
    if (file) {
      setLoadingMeta(true);
      setError('');
      apiGet<ComicPageMeta>('/api/comic_page_meta', { title, file })
        .then((data) => {
          const total = Math.max(0, Number(data.num_pages) || 0);
          setNumPages(total);
          setPage((prev) => Math.min(Math.max(1, prev), Math.max(1, total)));
        })
        .catch((cause) => setError(errorMessage(cause)))
        .finally(() => setLoadingMeta(false));
      return;
    }
    let cancelled = false;
    setLoadingMeta(true);
    setError('');
    apiGet<ComicPdfMeta>('/api/comic_pdf_meta', { title })
      .then((data) => {
        if (cancelled) return;
        const first = data.pdfs?.[0] || '';
        if (!first) throw new Error('这部漫画没有可阅读的 PDF');
        const saved = loadProgress(server.id, comicKey(title, first));
        const target = Math.max(1, initialQueryRef.current.page || saved?.chapter || 1);
        setFile(first);
        setPage(target);
        navigate(
          `/comic/${encodeURIComponent(title)}?file=${encodeURIComponent(first)}&page=${target}`,
          { replace: true },
        );
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
  }, [file, metaReload, navigate, server, title]);

  useEffect(() => {
    if (!file) return;
    const urlFile = params.get('file') || '';
    const urlPage = Math.max(1, Number(params.get('page')) || 1);
    if (urlFile === file && urlPage === page) return;
    const next = new URLSearchParams(params);
    next.set('file', file);
    next.set('page', String(page));
    setParams(next, { replace: true });
  }, [file, page, params, setParams]);

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
    if (!server || !file || numPages <= 0) return;
    saveProgress(server.id, comicKey(title, file), {
      chapter: page,
      total: numPages,
      bookTitle: title,
      chapterTitle: displayName(file),
      scroll: 0,
      updated: Date.now(),
    });
  }, [file, numPages, page, server, title]);

  useEffect(() => {
    setPageLoading(true);
    setImageError(false);
  }, [page, imageReload]);

  useEffect(() => {
    if (!file || numPages <= 0) return;
    const images = [page + 1, page + 2, page - 1]
      .filter((value) => value >= 1 && value <= numPages)
      .map((value) => {
        const image = new Image();
        image.src = mediaUrl(
          `/api/comic_page_image?title=${encodeURIComponent(title)}&file=${encodeURIComponent(file)}&page=${value}`,
        );
        return image;
      });
    return () => {
      images.forEach((image) => {
        image.src = '';
      });
    };
  }, [file, numPages, page, title]);

  const goPage = useCallback(
    (next: number) => {
      const total = totalRef.current;
      const target = Math.min(Math.max(1, next), Math.max(1, total));
      setPage(target);
    },
    [],
  );

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
      if (!server || !fileRef.current || totalRef.current <= 0) return;
      saveProgress(server.id, comicKey(title, fileRef.current), {
        chapter: pageRef.current,
        total: totalRef.current,
        bookTitle: title,
        chapterTitle: displayName(fileRef.current),
        scroll: 0,
        updated: Date.now(),
      });
    };
    document.addEventListener('visibilitychange', save);
    return () => {
      document.removeEventListener('visibilitychange', save);
      save();
    };
  }, [server, title]);

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
    setDraftPage(String(page));
    setSheetOpen(true);
  };

  const jumpToDraft = () => {
    const value = Number(draftPage) || 1;
    goPage(value);
    setSheetOpen(false);
  };

  if (!server) return null;

  const pageUrl = file
    ? mediaUrl(
        `/api/comic_page_image?title=${encodeURIComponent(title)}&file=${encodeURIComponent(file)}&page=${page}&r=${imageReload}`,
      )
    : '';

  return (
    <div className={`comic-reader${night ? ' is-night' : ''}`}>
      <header className={`reader-bar comic-top${chromeVisible ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="icon-btn"
          aria-label="返回漫画详情"
          onClick={() => navigate(`/book/${encodeURIComponent(title)}?kind=comic`)}
        >
          <ArrowLeft size={22} />
        </button>
        <div className="comic-top__title">
          <strong>{title}</strong>
          <span>
            {displayName(file) || '正在读取…'} · {page} / {numPages || '?'}
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
              onClick={() => setMetaReload((value) => value + 1)}
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
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => navigate(`/book/${encodeURIComponent(title)}?kind=comic`)}
            >
              返回详情
            </button>
          </div>
        ) : (
          <>
            <img
              key={`${page}-${imageReload}`}
              className="comic-page-img"
              src={pageUrl}
              alt={`第 ${page} 页`}
              draggable={false}
              onLoad={() => setPageLoading(false)}
              onError={() => {
                setPageLoading(false);
                setImageError(true);
              }}
            />
            {pageLoading && (
              <div className="comic-page-loading">
                <Loader2 size={28} className="spin" />
              </div>
            )}
            {imageError && !pageLoading && (
              <div className="comic-image-error">
                <p>这一页加载失败，可能是网络中断。</p>
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
          <strong>{page}</strong>
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
                  第 {page} 页 · 共 {numPages} 页
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
              value={page}
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
