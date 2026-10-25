import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Minus,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { useToast } from '../lib/toast';
import type { ReaderChapter, ReaderMeta } from '../lib/types';

type ReaderTheme = 'light' | 'sepia' | 'dark';

const TOC_WINDOW = 240;

function stripHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

function isEpub(name: string): boolean {
  return name.toLowerCase().endsWith('.epub');
}

export function ReaderPage() {
  const [params] = useSearchParams();
  const file = params.get('file') ?? '';
  const navigate = useNavigate();
  const { toast } = useToast();

  const [meta, setMeta] = useState<ReaderMeta | null>(null);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [idx, setIdx] = useState(1);
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [tocQuery, setTocQuery] = useState('');
  const [fontScale, setFontScale] = useState(() => {
    const saved = Number(localStorage.getItem('reader-font'));
    return Number.isFinite(saved) && saved > 0 ? Math.min(1.6, Math.max(0.85, saved)) : 1;
  });
  const [theme, setTheme] = useState<ReaderTheme>(() => {
    const saved = localStorage.getItem('reader-theme');
    return saved === 'sepia' || saved === 'dark' ? saved : 'light';
  });
  const seq = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const epub = isEpub(file);
  // 旧版后端 /api/epub_meta 不返回 total,退回章节数
  const total = meta?.total ?? meta?.chapters.length ?? 0;

  useEffect(() => {
    if (!file) {
      setError('缺少文件名');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    const load = async () => {
      try {
        const data = epub
          ? await apiGet<ReaderMeta>('/api/epub_meta', { file })
          : await apiGet<ReaderMeta>('/api/read_meta', { file });
        if (cancelled) return;
        setMeta(data);
        const saved = Number(localStorage.getItem(`reader:${file}`) || 0);
        const start = data.chapters.find((item) => item.idx === saved)?.idx ?? data.chapters[0]?.idx ?? 1;
        setIdx(start);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '书籍加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [epub, file]);

  useEffect(() => {
    if (!meta || !file) return;
    const id = ++seq.current;
    setChapterLoading(true);
    const load = async () => {
      try {
        const data = epub
          ? await apiGet<ReaderChapter>('/api/epub_read', { file, ch: idx })
          : await apiGet<ReaderChapter>('/api/read', { file, ch: idx });
        if (id !== seq.current) return;
        setChapter({
          title: data.title || meta.chapters.find((item) => item.idx === idx)?.title || '',
          text: data.text || (data.html ? stripHtml(data.html) : ''),
        });
        setChapterLoading(false);
        localStorage.setItem(`reader:${file}`, String(idx));
        contentRef.current?.scrollTo({ top: 0 });
      } catch (cause) {
        if (id !== seq.current) return;
        setChapterLoading(false);
        toast(cause instanceof Error ? cause.message : '章节加载失败', 'error');
      }
    };
    void load();
    return () => {
      seq.current += 1;
    };
  }, [epub, file, idx, meta, toast]);

  const go = useCallback(
    (next: number) => {
      if (!total) return;
      setIdx(Math.min(total, Math.max(1, next)));
    },
    [total],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      // 焦点在按钮上时空格应触发按钮本身,避免翻页两次
      if (event.key === ' ' && tag === 'BUTTON') return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(idx - 1);
      } else if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        go(idx + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, idx]);

  useEffect(() => {
    localStorage.setItem('reader-font', String(fontScale));
  }, [fontScale]);
  useEffect(() => {
    localStorage.setItem('reader-theme', theme);
  }, [theme]);

  const tocItems = useMemo(() => {
    if (!meta) return [];
    const keyword = tocQuery.trim().toLowerCase();
    if (keyword) {
      return meta.chapters
        .filter((item) => item.title.toLowerCase().includes(keyword) || String(item.idx) === keyword)
        .slice(0, 300);
    }
    if (meta.chapters.length <= TOC_WINDOW) return meta.chapters;
    const position = meta.chapters.findIndex((item) => item.idx === idx);
    const start = Math.max(0, Math.min(meta.chapters.length - TOC_WINDOW, position - 80));
    return meta.chapters.slice(start, start + TOC_WINDOW);
  }, [idx, meta, tocQuery]);

  const percent = total ? Math.round((idx / total) * 100) : 0;
  const title = meta?.title?.replace(/\.(txt|epub)$/i, '').replace(/\[[^\]]*\]$/, '') || file;

  const changeChapter = (next: number) => {
    go(next);
    setTocOpen(false);
  };

  if (error) {
    return (
      <div className="page">
        <div className="empty" style={{ paddingTop: 80 }}>
          <div className="empty__icon">
            <X size={20} />
          </div>
          <div className="empty__title">无法打开这本书</div>
          <div className="empty__desc">{error}</div>
          <button type="button" className="btn" style={{ marginTop: 16 }} onClick={() => navigate('/files')}>
            <ArrowLeft size={15} />
            返回文件
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`reader reader--${theme}`}>
      <header className="reader__bar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={15} />
          返回
        </button>
        <div className="reader__heading">
          <div className="reader__book" title={title}>
            {title}
          </div>
          <div className="reader__chapter-name">{chapter?.title || (loading ? '加载中…' : '')}</div>
        </div>
        <div className="reader__tools">
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={() => setTocOpen((open) => !open)}
            title="目录"
            aria-label="目录"
          >
            <List size={15} />
          </button>
          <div className="segmented reader__theme" role="group" aria-label="阅读主题">
            <button type="button" className={theme === 'light' ? 'is-on' : ''} onClick={() => setTheme('light')}>
              纸白
            </button>
            <button type="button" className={theme === 'sepia' ? 'is-on' : ''} onClick={() => setTheme('sepia')}>
              米黄
            </button>
            <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')}>
              夜间
            </button>
          </div>
          <div className="reader__font">
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              onClick={() => setFontScale((value) => Math.max(0.85, Number((value - 0.05).toFixed(2))))}
              disabled={fontScale <= 0.85}
              aria-label="减小字号"
            >
              <Minus size={14} />
            </button>
            <span>{Math.round(fontScale * 100)}%</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              onClick={() => setFontScale((value) => Math.min(1.6, Number((value + 0.05).toFixed(2))))}
              disabled={fontScale >= 1.6}
              aria-label="增大字号"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </header>

      <div className="reader__progress">
        <i style={{ width: `${percent}%` }} />
      </div>

      <div className="reader__body">
        {tocOpen ? (
          <aside className="reader__toc">
            <div className="reader__toc-head">
              <div className="toolbar__search">
                <Search size={14} />
                <input
                  className="input"
                  value={tocQuery}
                  onChange={(event) => setTocQuery(event.target.value)}
                  placeholder="搜索章节"
                  aria-label="搜索章节"
                />
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={() => setTocOpen(false)}
                aria-label="收起目录"
              >
                <X size={14} />
              </button>
            </div>
            <div className="reader__toc-list">
              {tocItems.map((item) => (
                <button
                  key={item.idx}
                  type="button"
                  className={`reader__toc-item${item.idx === idx ? ' is-current' : ''}`}
                  onClick={() => changeChapter(item.idx)}
                  title={item.title}
                >
                  {item.volume ? <span className="reader__toc-volume">{item.volume}</span> : null}
                  <span>{item.title || `第 ${item.idx} 章`}</span>
                </button>
              ))}
              {!tocItems.length ? <div className="reader__toc-empty">没有匹配的章节</div> : null}
            </div>
            {meta && meta.chapters.length > tocItems.length && !tocQuery ? (
              <div className="reader__toc-hint">
                共 {meta.chapters.length} 章，仅显示当前附近章节；搜索章节名可定位全部。
              </div>
            ) : null}
          </aside>
        ) : null}

        <main className="reader__main" ref={contentRef}>
          <article
            className="reader__paper"
            style={{ fontSize: `${16 * fontScale}px` }}
          >
            <h1 className="reader__title">{chapter?.title || meta?.chapters.find((item) => item.idx === idx)?.title}</h1>
            {loading || chapterLoading || !chapter ? (
              <div className="reader__loading">
                <span className="spinner" /> 正在加载正文…
              </div>
            ) : chapter.text ? (
              <div className="reader__text">{chapter.text}</div>
            ) : (
              <div className="reader__loading">这一章没有正文内容。</div>
            )}
          </article>

          <div className="reader__nav">
            <button type="button" className="btn btn--ghost" onClick={() => go(idx - 1)} disabled={idx <= 1}>
              <ChevronLeft size={16} />
              上一章
            </button>
            <span className="reader__count">
              {idx} / {total || '—'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => go(idx + 1)} disabled={!total || idx >= total}>
              下一章
              <ChevronRight size={16} />
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
