import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Loader2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { apiGet, mediaUrl } from '../lib/api';
import { getActiveServer } from '../lib/connection';
import { displayName, errorMessage, percent } from '../lib/format';
import {
  loadProgress,
  loadReaderPrefs,
  saveProgress,
  saveReaderPrefs,
  type ReaderPrefs,
  type ReaderTheme,
  type ReadingProgress,
} from '../lib/progress';
import type { NovelChapter, NovelMeta } from '../lib/types';

const THEMES: { id: ReaderTheme; label: string; color: string }[] = [
  { id: 'paper', label: '纸白', color: '#f7f4ee' },
  { id: 'eye', label: '护眼', color: '#cfe7d2' },
  { id: 'sepia', label: '羊皮', color: '#efdfc2' },
  { id: 'night', label: '夜间', color: '#15171c' },
];

function cleanHtml(html: string): string {
  return html
    .replace(
      /(\s(?:src|href|poster)\s*=\s*["'])(\/api\/[^"']*)/gi,
      (_match, prefix: string, path: string) => prefix + mediaUrl(path),
    )
    .replace(
      /url\(\s*(['"]?)(\/api\/[^)'"]*)\1\s*\)/gi,
      (_match, quote: string, path: string) => `url(${quote}${mediaUrl(path)}${quote})`,
    );
}

function readRatio(element: HTMLElement | null): number {
  if (!element) return 0;
  const max = element.scrollHeight - element.clientHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, element.scrollTop / max));
}

export default function NovelReaderPage() {
  const navigate = useNavigate();
  const { file = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [server] = useState(() => getActiveServer());
  const epub = /\.epub$/i.test(file);
  const [initialProgress] = useState<ReadingProgress | null>(() =>
    server ? loadProgress(server.id, file) : null,
  );
  const requestedChapter = Number(searchParams.get('ch')) || 0;
  const startChapter = Math.max(1, requestedChapter || initialProgress?.chapter || 1);

  const [meta, setMeta] = useState<NovelMeta | null>(null);
  const [chapter, setChapter] = useState(startChapter);
  const [chapterData, setChapterData] = useState<NovelChapter | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocQuery, setTocQuery] = useState('');
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadReaderPrefs());

  const scrollRef = useRef<HTMLElement>(null);
  const chapterRef = useRef(chapter);
  const metaRef = useRef<NovelMeta | null>(meta);
  const chapterTitleRef = useRef('');
  const pendingScrollRef = useRef(
    initialProgress && initialProgress.chapter === startChapter ? initialProgress.scroll : 0,
  );
  const scrollTimerRef = useRef(0);

  chapterRef.current = chapter;
  metaRef.current = meta;

  const total = meta?.chapters.length || 0;
  const currentTitle =
    chapterData?.title ||
    meta?.chapters.find((item) => item.idx === chapter)?.title ||
    `第 ${chapter} 章`;
  const progressPercent = total ? percent(chapter, total) : 0;

  const persist = useCallback(
    (ratio?: number) => {
      const currentMeta = metaRef.current;
      if (!server || !currentMeta) return;
      const value = ratio === undefined ? readRatio(scrollRef.current) : ratio;
      saveProgress(server.id, file, {
        chapter: chapterRef.current,
        total: currentMeta.chapters.length,
        bookTitle: displayName(file),
        chapterTitle: chapterTitleRef.current,
        scroll: value,
        updated: Date.now(),
      });
    },
    [file, server],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (!server) {
      navigate('/connect', { replace: true });
      return;
    }
    let cancelled = false;
    setLoadingMeta(true);
    setError('');
    apiGet<NovelMeta>(epub ? '/api/epub_meta' : '/api/read_meta', { file })
      .then((data) => {
        if (cancelled) return;
        const chapters = data.chapters || [];
        setMeta({ ...data, chapters });
        setChapter((prev) => {
          const next = Math.min(Math.max(1, prev), Math.max(1, chapters.length));
          if (next !== prev) pendingScrollRef.current = 0;
          return next;
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
  }, [epub, file, navigate, server]);

  useEffect(() => {
    if (!meta) return;
    if (Number(searchParams.get('ch')) === chapter) return;
    const next = new URLSearchParams(searchParams);
    next.set('ch', String(chapter));
    setSearchParams(next, { replace: true });
  }, [chapter, meta, searchParams, setSearchParams]);

  useEffect(() => {
    if (!meta || meta.chapters.length === 0) return;
    let cancelled = false;
    setLoadingChapter(true);
    setError('');
    setChapterData(null);
    apiGet<NovelChapter>(epub ? '/api/epub_read' : '/api/read', { file, ch: chapter })
      .then((data) => {
        if (cancelled) return;
        setChapterData(data);
        chapterTitleRef.current = data.title || '';
        const savedScroll = pendingScrollRef.current;
        if (server) {
          saveProgress(server.id, file, {
            chapter,
            total: meta.chapters.length,
            bookTitle: displayName(file),
            chapterTitle: data.title || '',
            scroll: savedScroll,
            updated: Date.now(),
          });
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const element = scrollRef.current;
            if (!element) return;
            element.scrollTop = savedScroll * Math.max(0, element.scrollHeight - element.clientHeight);
          });
        });
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingChapter(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chapter, epub, file, meta, reloadToken, server]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') persistRef.current();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearTimeout(scrollTimerRef.current);
      persistRef.current();
    };
  }, []);

  const goChapter = useCallback(
    (index: number) => {
      const maximum = metaRef.current?.chapters.length || 0;
      if (index < 1 || index > maximum) return;
      setTocOpen(false);
      setChromeVisible(true);
      if (index === chapterRef.current) return;
      persist();
      pendingScrollRef.current = 0;
      setChapter(index);
    },
    [persist],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goChapter(chapterRef.current - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goChapter(chapterRef.current + 1);
      } else if (event.key === 'Escape') {
        setTocOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goChapter]);

  useEffect(() => {
    if (!tocOpen) return;
    const timer = window.setTimeout(() => {
      document.querySelector('.toc-row.is-current')?.scrollIntoView({ block: 'center' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [tocOpen]);

  const handleScroll = () => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = 0;
      persist();
    }, 600);
  };

  const handleContentClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    setChromeVisible((value) => !value);
  };

  const handleArticleClick = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) {
      handleContentClick(event);
      return;
    }
    const marker = anchor.getAttribute('data-epub-chap');
    if (marker) {
      event.preventDefault();
      event.stopPropagation();
      const targetPath = decodeURIComponent(marker);
      const target = meta?.chapters.find((item) => item.path === targetPath);
      if (target) goChapter(target.idx);
      return;
    }
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  };

  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch };
      saveReaderPrefs(next);
      return next;
    });
  };

  const renderedHtml = useMemo(
    () => (chapterData?.html ? cleanHtml(chapterData.html) : ''),
    [chapterData],
  );
  const tocItems = useMemo(() => {
    const chapters = meta?.chapters || [];
    const keyword = tocQuery.trim().toLowerCase();
    if (!keyword) return chapters.slice(0, 500);
    return chapters
      .filter((item) =>
        `${item.volume || ''} ${item.title || ''} ${item.idx}`.toLowerCase().includes(keyword),
      )
      .slice(0, 500);
  }, [meta, tocQuery]);

  const fontFamily =
    prefs.family === 'serif'
      ? '"Noto Serif SC", "Songti SC", STSong, SimSun, serif'
      : 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

  if (!server) return null;

  return (
    <div className="reader" data-theme={prefs.theme}>
      <div className="reader-edge-progress">
        <i style={{ width: `${progressPercent}%` }} />
      </div>

      <header className={`reader-bar reader-top${chromeVisible ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="icon-btn"
          aria-label="返回目录"
          onClick={() => {
            persist();
            navigate(`/book/${encodeURIComponent(file)}?kind=novel`);
          }}
        >
          <ArrowLeft size={22} />
        </button>
        <div className="reader-top__title">
          <strong>{displayName(file)}</strong>
          <span>{currentTitle}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="目录"
          onClick={() => setTocOpen(true)}
        >
          <List size={22} />
        </button>
        <button
          type="button"
          className="reader-aa"
          aria-label="阅读设置"
          onClick={() => setSettingsOpen(true)}
        >
          Aa
        </button>
      </header>

      <main ref={scrollRef} className="reader-scroll" onScroll={handleScroll}>
        {error ? (
          <div className="reader-message">
            <p>{error}</p>
            <button type="button" className="btn btn--primary" onClick={() => setReloadToken((v) => v + 1)}>
              重试
            </button>
          </div>
        ) : loadingMeta || loadingChapter ? (
          <div className="reader-message">
            <Loader2 size={26} className="spin" />
            <p>{loadingMeta ? '正在读取目录…' : '正在加载章节…'}</p>
          </div>
        ) : (
          <article
            className="reader-content"
            style={{
              fontSize: `${prefs.fontSize}px`,
              lineHeight: prefs.lineHeight,
              fontFamily,
            }}
            onClick={handleArticleClick}
          >
            <h1 className="reader-chapter-title">{chapterData?.title || currentTitle}</h1>
            {epub ? (
              <div className="epub-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            ) : (
              <div className="txt-body">
                {(chapterData?.text || '')
                  .split(/\n+/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
              </div>
            )}
            {chapter < total && (
              <button
                type="button"
                className="reader-next-chapter"
                onClick={() => goChapter(chapter + 1)}
              >
                下一章
                <ChevronRight size={16} />
              </button>
            )}
            <div className="reader-end">— 本章完 —</div>
          </article>
        )}
      </main>

      <footer className={`reader-bar reader-bottom${chromeVisible ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="icon-btn"
          aria-label="上一章"
          disabled={chapter <= 1 || loadingChapter}
          onClick={() => goChapter(chapter - 1)}
        >
          <ChevronLeft size={24} />
        </button>
        <div className="reader-progress">
          <span>
            {chapter} / {total || '?'}
          </span>
          <div className="reader-progress__track">
            <i style={{ width: `${progressPercent}%` }} />
          </div>
          <span>{currentTitle}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="下一章"
          disabled={chapter >= total || loadingChapter}
          onClick={() => goChapter(chapter + 1)}
        >
          <ChevronRight size={24} />
        </button>
      </footer>

      {tocOpen && (
        <div className="reader-sheet" role="dialog" aria-modal="true" aria-label="目录">
          <header className="reader-sheet__head">
            <div>
              <h2>目录</h2>
              <p>{total} 章 · 当前第 {chapter} 章</p>
            </div>
            <button type="button" className="icon-btn" aria-label="关闭目录" onClick={() => setTocOpen(false)}>
              <X size={22} />
            </button>
          </header>
          <div className="search-row search-row--compact">
            <List size={16} />
            <input
              type="search"
              placeholder="搜索章节"
              value={tocQuery}
              onChange={(event) => setTocQuery(event.target.value)}
            />
          </div>
          <div className="toc-list">
            {tocItems.length === 0 ? (
              <p className="muted toc-empty">没有匹配的章节</p>
            ) : (
              tocItems.map((item) => (
                <button
                  type="button"
                  key={`${item.idx}-${item.title}`}
                  className={`toc-row${item.idx === chapter ? ' is-current' : ''}`}
                  onClick={() => goChapter(item.idx)}
                >
                  <span>{item.volume ? `${item.volume} · ` : ''}{item.title || `第 ${item.idx} 章`}</span>
                  <em>{item.idx}</em>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div
            className="reader-settings"
            role="dialog"
            aria-modal="true"
            aria-label="阅读设置"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="reader-sheet__head">
              <div>
                <h2>阅读设置</h2>
                <p>偏好会自动保存</p>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
                <X size={22} />
              </button>
            </header>

            <div className="setting-row">
              <span>字号</span>
              <div className="stepper">
                <button
                  type="button"
                  aria-label="减小字号"
                  disabled={prefs.fontSize <= 14}
                  onClick={() => updatePrefs({ fontSize: prefs.fontSize - 1 })}
                >
                  <Minus size={16} />
                </button>
                <b>{prefs.fontSize}</b>
                <button
                  type="button"
                  aria-label="增大字号"
                  disabled={prefs.fontSize >= 28}
                  onClick={() => updatePrefs({ fontSize: prefs.fontSize + 1 })}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div className="setting-row">
              <span>行距</span>
              <div className="stepper">
                <button
                  type="button"
                  aria-label="减小行距"
                  disabled={prefs.lineHeight <= 1.4}
                  onClick={() => updatePrefs({ lineHeight: Math.round((prefs.lineHeight - 0.1) * 10) / 10 })}
                >
                  <Minus size={16} />
                </button>
                <b>{prefs.lineHeight.toFixed(1)}</b>
                <button
                  type="button"
                  aria-label="增大行距"
                  disabled={prefs.lineHeight >= 2.4}
                  onClick={() => updatePrefs({ lineHeight: Math.round((prefs.lineHeight + 0.1) * 10) / 10 })}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div className="setting-row setting-row--column">
              <span>纸张</span>
              <div className="theme-swatches">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    className={`theme-swatch${prefs.theme === theme.id ? ' is-active' : ''}`}
                    onClick={() => updatePrefs({ theme: theme.id })}
                  >
                    <i style={{ background: theme.color }} />
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <span>字体</span>
              <div className="segmented segmented--small">
                <button
                  type="button"
                  className={prefs.family === 'serif' ? 'is-active' : ''}
                  onClick={() => updatePrefs({ family: 'serif' })}
                >
                  宋体
                </button>
                <button
                  type="button"
                  className={prefs.family === 'sans' ? 'is-active' : ''}
                  onClick={() => updatePrefs({ family: 'sans' })}
                >
                  黑体
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
