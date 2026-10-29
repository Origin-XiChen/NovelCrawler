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
import { mediaUrl } from '../lib/api';
import { errorMessage } from '../lib/format';
import {
  localBook,
  localNovelSource,
  onlineNovelSource,
  type NovelSource,
} from '../lib/content';
import {
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderPrefs,
  type ReaderTheme,
} from '../lib/progress';
import {
  clampRatio,
  continuousPercent,
  flushSharedProgress,
  normalizeFraction,
  seedLegacyChapters,
} from '../lib/reading-progress';
import type { NovelChapter, NovelMeta } from '../lib/types';

const THEMES: { id: ReaderTheme; label: string; color: string }[] = [
  { id: 'paper', label: '纸白', color: '#f7f4ee' },
  { id: 'eye', label: '护眼', color: '#cfe7d2' },
  { id: 'sepia', label: '羊皮', color: '#efdfc2' },
  { id: 'night', label: '夜间', color: '#15171c' },
];

/** 在线章节里的 /api/... 资源要补上电脑地址;本地章节已经是 blob,不能再动。 */
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

function readRatio(element: HTMLElement | null, completeWhenFits = false): number {
  if (!element) return 0;
  const max = element.scrollHeight - element.clientHeight;
  if (max <= 4) return completeWhenFits ? 1 : 0;
  return clampRatio(element.scrollTop / max);
}

export default function NovelReaderPage() {
  const navigate = useNavigate();
  // /read/:file 读电脑上的书,/local/read/:id 读手机里的离线包
  const { file = '', id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [source, setSource] = useState<NovelSource | null>(null);
  const [initialChapter] = useState(() => Number(searchParams.get('ch')) || 0);

  const [meta, setMeta] = useState<NovelMeta | null>(null);
  const [chapter, setChapter] = useState(0);
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
  const [chapterMap, setChapterMap] = useState<Record<string, number>>({});
  const [scrollFraction, setScrollFraction] = useState(0);

  const scrollRef = useRef<HTMLElement>(null);
  const chapterRef = useRef(chapter);
  const metaRef = useRef<NovelMeta | null>(meta);
  const sourceRef = useRef<NovelSource | null>(null);
  const chapterTitleRef = useRef('');
  const chapterDataRef = useRef<NovelChapter | null>(null);
  const chapterMapRef = useRef<Record<string, number>>({});
  const pendingScrollRef = useRef(0);
  const scrollTimerRef = useRef(0);
  const scrollRafRef = useRef(0);

  chapterRef.current = chapter;
  metaRef.current = meta;
  sourceRef.current = source;

  const total = meta?.chapters.length || 0;
  const currentTitle =
    chapterData?.title ||
    meta?.chapters.find((item) => item.idx === chapter)?.title ||
    `第 ${chapter} 章`;
  const liveChapterMap = useMemo(() => {
    const map = { ...chapterMap };
    if (chapter) {
      const fraction = normalizeFraction(scrollFraction);
      map[String(chapter)] = Math.max(map[String(chapter)] || 0, fraction);
    }
    return map;
  }, [chapter, chapterMap, scrollFraction]);
  const progressPercent = total
    ? continuousPercent({
        total,
        ch: chapter,
        scroll: scrollFraction,
        chapters: liveChapterMap,
      })
    : 0;

  const currentFraction = useCallback(
    () => readRatio(scrollRef.current, Boolean(chapterDataRef.current)),
    [],
  );

  const rememberChapter = useCallback((index: number, fraction: number) => {
    if (!index) return;
    const value = normalizeFraction(fraction);
    if (value <= 0) return;
    const key = String(index);
    if (value <= (chapterMapRef.current[key] || 0)) return;
    const next = { ...chapterMapRef.current, [key]: value };
    chapterMapRef.current = next;
    setChapterMap(next);
  }, []);

  const persist = useCallback(
    (ratio?: number) => {
      const current = sourceRef.current;
      const currentMeta = metaRef.current;
      if (!current || !currentMeta || !chapterRef.current) return;
      const value = ratio === undefined ? currentFraction() : ratio;
      const key = String(chapterRef.current);
      const fraction = normalizeFraction(value);
      const map = { ...chapterMapRef.current };
      if (fraction > 0) map[key] = Math.max(map[key] || 0, fraction);
      chapterMapRef.current = map;
      setChapterMap(map);
      current.saveProgress(
        chapterRef.current,
        currentMeta.chapters.length,
        chapterTitleRef.current,
        value,
        map,
      );
    },
    [currentFraction],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    let cancelled = false;
    if (id) {
      setLoadingMeta(true);
      setError('');
      localBook(id)
        .then((book) => {
          if (cancelled) return;
          if (!book || book.kind !== 'novel') {
            setError('这本书不在手机里,请先在"电脑"页下载到手机');
            setLoadingMeta(false);
            return;
          }
          setSource(localNovelSource(book));
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
    if (!file) {
      navigate('/home', { replace: true });
      return undefined;
    }
    const online = onlineNovelSource(file);
    if (!online) {
      navigate('/connect', { replace: true });
      return undefined;
    }
    setSource(online);
    return undefined;
  }, [file, id, navigate]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setLoadingMeta(true);
    setError('');
    Promise.all([source.loadMeta(), source.loadProgress()])
      .then(([data, saved]) => {
        if (cancelled) return;
        const chapters = data.chapters || [];
        setMeta({ ...data, chapters });
        const maximum = Math.max(1, chapters.length);
        const start = Math.min(Math.max(1, initialChapter || saved?.ch || 1), maximum);
        const seeded =
          saved?.chapters && Object.keys(saved.chapters).length
            ? saved.chapters
            : seedLegacyChapters(saved?.ch || 0, saved?.scroll || 0, chapters.length);
        chapterMapRef.current = seeded;
        setChapterMap(seeded);
        chapterDataRef.current = null;
        setScrollFraction(0);
        // 明确跳章时不回滚滚动位置,只有"接着上次读"才恢复
        pendingScrollRef.current =
          initialChapter && initialChapter !== saved?.ch ? 0 : saved?.scroll || 0;
        setChapter(start);
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
  }, [initialChapter, reloadToken, source]);

  useEffect(() => {
    if (!meta || !chapter) return;
    if (Number(searchParams.get('ch')) === chapter) return;
    const next = new URLSearchParams(searchParams);
    next.set('ch', String(chapter));
    setSearchParams(next, { replace: true });
  }, [chapter, meta, searchParams, setSearchParams]);

  useEffect(() => {
    if (!source || !meta || !chapter) return;
    let cancelled = false;
    setLoadingChapter(true);
    setError('');
    setChapterData(null);
    chapterDataRef.current = null;
    source
      .loadChapter(chapter)
      .then((data) => {
        if (cancelled) return;
        setChapterData(data);
        chapterDataRef.current = data;
        chapterTitleRef.current = data.title || '';
        const savedScroll = pendingScrollRef.current;
        rememberChapter(chapter, savedScroll);
        setScrollFraction(savedScroll);
        persist(savedScroll);
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
  }, [chapter, meta, persist, reloadToken, rememberChapter, source]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistRef.current();
        flushSharedProgress();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearTimeout(scrollTimerRef.current);
      window.cancelAnimationFrame(scrollRafRef.current);
      persistRef.current();
      flushSharedProgress();
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
    if (!scrollRafRef.current) {
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        setScrollFraction(currentFraction());
      });
    }
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

  const renderedHtml = useMemo(() => {
    const html = chapterData?.html || '';
    if (!html) return '';
    return source?.mode === 'online' ? cleanHtml(html) : html;
  }, [chapterData, source]);
  // 滚动时百分比会频繁重渲染,段落节点缓存住,别每次都重建几千个 <p>
  const textBody = useMemo(
    () =>
      (chapterData?.text || '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => <p key={index}>{line}</p>),
    [chapterData?.text],
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

  const backHref = source?.detailHref || (id ? '/shelf' : '/library');

  return (
    <div className="reader" data-theme={prefs.theme}>
      <div className="reader-edge-progress">
        <i style={{ width: `${progressPercent}%` }} />
      </div>

      <header className={`reader-bar reader-top${chromeVisible ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="icon-btn"
          aria-label="返回详情"
          onClick={() => {
            persist();
            navigate(backHref);
          }}
        >
          <ArrowLeft size={22} />
        </button>
        <div className="reader-top__title">
          <strong>{source?.title || '正在打开…'}</strong>
          <span>{chapter ? currentTitle : ''}</span>
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
            {source && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setReloadToken((v) => v + 1)}
              >
                重试
              </button>
            )}
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
            {source?.epub ? (
              <div className="epub-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            ) : (
              <div className="txt-body">{textBody}</div>
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
          <span title="总进度只统计从第 1 章起连续读过的部分，跳读不计入">
            {chapter} / {total || '?'} · 总进度 {progressPercent}%
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
          disabled={!total || chapter >= total || loadingChapter}
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
              <p>
                {total} 章 · 当前第 {chapter} 章
              </p>
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
              tocItems.map((item) => {
                const fraction = normalizeFraction(liveChapterMap[String(item.idx)] ?? 0);
                return (
                  <button
                    type="button"
                    key={`${item.idx}-${item.title}`}
                    className={`toc-row${item.idx === chapter ? ' is-current' : ''}`}
                    onClick={() => goChapter(item.idx)}
                  >
                    <span>
                      {item.volume ? `${item.volume} · ` : ''}
                      {item.title || `第 ${item.idx} 章`}
                    </span>
                    {fraction > 0 && (
                      <span className={`toc-row__pct${fraction >= 1 ? ' is-done' : ''}`}>
                        {fraction >= 1 ? '已读' : `${Math.round(fraction * 100)}%`}
                      </span>
                    )}
                    <em>{item.idx}</em>
                  </button>
                );
              })
            )}
          </div>
          {(meta?.chapters?.length || 0) > 500 && (
            <p className="toc-more">章节较多，仅显示前 500 章；用搜索可缩小范围</p>
          )}
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
