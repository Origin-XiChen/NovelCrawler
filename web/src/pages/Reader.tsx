import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  List,
  Minus,
  NotebookPen,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import type { ReaderChapter, ReaderMeta } from '../lib/types';

type ReaderTheme = 'light' | 'sepia' | 'dark';
type ReaderMode = 'file' | 'online' | 'epub';

interface Note {
  id: string;
  ch: number;
  text: string;
  quote?: string;
  ts: number;
}

interface NotesData {
  bookmarks: number[];
  notes: Note[];
}

interface BookTocResponse {
  title?: string;
  toc?: { title?: string; url?: string }[];
}

interface EpubOnlineResponse {
  ok?: boolean;
  mode?: string;
  title?: string;
  chapters?: { idx?: number; title?: string; volume?: string }[];
}

const TOC_WINDOW = 240;

function stripHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

function isEpub(name: string): boolean {
  return name.toLowerCase().endsWith('.epub');
}

function formatNoteDate(ts?: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString();
}

export function ReaderPage() {
  const [params] = useSearchParams();
  const file = (params.get('file') ?? '').trim();
  const onlineUrl = (params.get('url') ?? '').trim();
  const epubUrl = (params.get('epub') ?? '').trim();
  const titleParam = (params.get('title') ?? '').trim();
  const mode: ReaderMode = epubUrl ? 'epub' : onlineUrl ? 'online' : 'file';
  const bookKey = epubUrl || onlineUrl || file;
  const localEpub = mode === 'file' && isEpub(file);
  const navigate = useNavigate();
  const { toast } = useToast();

  const [meta, setMeta] = useState<ReaderMeta | null>(null);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [idx, setIdx] = useState(1);
  const [loadedIdx, setLoadedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [metaHint, setMetaHint] = useState('');
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [tocQuery, setTocQuery] = useState('');
  const [notes, setNotes] = useState<NotesData>({ bookmarks: [], notes: [] });
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteChapter, setNoteChapter] = useState(1);
  const [noteQuote, setNoteQuote] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [selBubble, setSelBubble] = useState<{ quote: string; top: number; left: number } | null>(null);
  const [zoomImage, setZoomImage] = useState('');
  const [fontScale, setFontScale] = useState(() => {
    const saved = Number(localStorage.getItem('reader-font'));
    return Number.isFinite(saved) && saved > 0 ? Math.min(1.6, Math.max(0.85, saved)) : 1;
  });
  const [theme, setTheme] = useState<ReaderTheme>(() => {
    const saved = localStorage.getItem('reader-theme');
    return saved === 'sepia' || saved === 'dark' ? saved : 'light';
  });
  const seq = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const htmlRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<{ id: string; ch: number } | null>(null);

  // 旧版后端 /api/epub_meta 不返回 total,退回章节数
  const total = meta?.total ?? meta?.chapters.length ?? 0;

  useEffect(() => {
    if (!bookKey) {
      setError('缺少书籍参数');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setMeta(null);
    setChapter(null);
    setIdx(1);
    setLoadedIdx(0);
    setMetaHint('');
    setSelBubble(null);
    pendingAnchor.current = null;
    setNotes({ bookmarks: [], notes: [] });

    const load = async () => {
      try {
        let next: ReaderMeta;
        if (mode === 'online') {
          const data = await apiGet<BookTocResponse>('/api/book', { url: onlineUrl });
          const toc = data.toc ?? [];
          if (!toc.length) throw new Error('未获取到章节列表');
          next = {
            title: data.title || titleParam || '在线阅读',
            total: toc.length,
            chapters: toc.map((item, index) => ({
              idx: index + 1,
              title: item.title || `第 ${index + 1} 章`,
            })),
          };
        } else if (mode === 'epub') {
          const started = Date.now();
          setMetaHint('EPUB 正在下载并解析中…');
          const timer = window.setInterval(() => {
            setMetaHint(
              `EPUB 正在下载并解析中…已等待 ${Math.round((Date.now() - started) / 1000)} 秒`,
            );
          }, 1000);
          try {
            const data = await apiGet<EpubOnlineResponse>('/api/epub_online', { url: epubUrl });
            const chapters = (data.chapters ?? []).map((item, index) => ({
              idx: index + 1,
              title: item.title || `第 ${index + 1} 章`,
              volume: item.volume || '',
            }));
            if (!chapters.length) throw new Error('EPUB 无章节内容');
            next = {
              title: titleParam || data.title || 'EPUB 在线阅读',
              total: chapters.length,
              chapters,
            };
          } finally {
            window.clearInterval(timer);
            setMetaHint('');
          }
        } else if (localEpub) {
          const data = await apiGet<ReaderMeta>('/api/epub_meta', { file });
          next = {
            title: data.title || file,
            total: data.total ?? data.chapters.length,
            chapters: data.chapters ?? [],
          };
        } else {
          const data = await apiGet<ReaderMeta>('/api/read_meta', { file });
          next = {
            title: data.title || file,
            total: data.total ?? data.chapters.length,
            chapters: data.chapters ?? [],
          };
        }
        if (cancelled) return;
        setMeta(next);
        const saved = Number(localStorage.getItem(`reader:${bookKey}`) || 0);
        const start =
          next.chapters.find((item) => item.idx === saved)?.idx ?? next.chapters[0]?.idx ?? 1;
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
  }, [bookKey, epubUrl, file, localEpub, mode, onlineUrl, titleParam]);

  useEffect(() => {
    if (!meta || !bookKey) return;
    const id = ++seq.current;
    setChapterLoading(true);
    setSelBubble(null);
    const load = async () => {
      try {
        let data: ReaderChapter;
        if (mode === 'online') {
          data = await apiGet<ReaderChapter>('/api/online_read', { url: onlineUrl, ch: idx });
        } else if (mode === 'epub') {
          data = await apiGet<ReaderChapter>('/api/epub_online_read', { url: epubUrl, ch: idx });
        } else if (localEpub) {
          data = await apiGet<ReaderChapter>('/api/epub_read', { file, ch: idx });
        } else {
          data = await apiGet<ReaderChapter>('/api/read', { file, ch: idx });
        }
        if (id !== seq.current) return;
        setChapter({
          title: data.title || meta.chapters.find((item) => item.idx === idx)?.title || '',
          text: data.text || (data.html ? stripHtml(data.html) : ''),
          html: data.html || undefined,
        });
        setLoadedIdx(idx);
        localStorage.setItem(`reader:${bookKey}`, String(idx));
        contentRef.current?.scrollTo({ top: 0 });
      } catch (cause) {
        if (id !== seq.current) return;
        toast(cause instanceof Error ? cause.message : '章节加载失败', 'error');
      } finally {
        if (id === seq.current) setChapterLoading(false);
      }
    };
    void load();
    return () => {
      seq.current += 1;
    };
  }, [bookKey, epubUrl, file, idx, localEpub, meta, mode, onlineUrl, toast]);

  const loadNotes = useCallback(async () => {
    if (!bookKey) return;
    try {
      const data = await apiGet<NotesData>('/api/notes', { key: bookKey });
      setNotes({ bookmarks: data.bookmarks ?? [], notes: data.notes ?? [] });
    } catch {
      /* 笔记读取失败不阻塞阅读 */
    }
  }, [bookKey]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const go = useCallback(
    (next: number) => {
      if (!total) return;
      pendingAnchor.current = null;
      setIdx(Math.min(total, Math.max(1, next)));
    },
    [total],
  );

  const jumpTo = useCallback(
    (next: number) => {
      go(next);
      setTocOpen(false);
      setNotesOpen(false);
      setSelBubble(null);
    },
    [go],
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

  // EPUB 章节 HTML 注入后的增强:插图放大、脚注锚点、跨章节链接
  useEffect(() => {
    const root = htmlRef.current;
    if (!root || !chapter?.html) return;
    root.querySelectorAll<HTMLElement>('[style*="font-family"]').forEach((el) => {
      el.style.fontFamily = '';
    });
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
    const onImage = (event: Event) => {
      event.stopPropagation();
      const img = event.currentTarget as HTMLImageElement;
      setZoomImage(img.currentSrc || img.src);
    };
    images.forEach((img) => img.addEventListener('click', onImage));

    const cleanups: (() => void)[] = [];
    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
      const targetPath = anchor.getAttribute('data-epub-chap');
      if (targetPath) {
        const onClick = (event: Event) => {
          event.preventDefault();
          const decoded = decodeURIComponent(targetPath);
          const targetName = decoded.split('/').pop();
          const target =
            meta?.chapters.find((item) => item.path === decoded) ??
            meta?.chapters.find((item) => (item.path || '').split('/').pop() === targetName);
          if (target) {
            const hash = (anchor.getAttribute('href') || '').split('#')[1] || '';
            pendingAnchor.current = hash
              ? { id: decodeURIComponent(hash), ch: target.idx }
              : null;
            setIdx(target.idx);
            setTocOpen(false);
            setNotesOpen(false);
            setSelBubble(null);
          } else {
            toast('目标章节未找到', 'info');
          }
        };
        anchor.addEventListener('click', onClick);
        cleanups.push(() => anchor.removeEventListener('click', onClick));
      } else if ((anchor.getAttribute('href') || '').startsWith('#')) {
        const onClick = (event: Event) => {
          event.preventDefault();
          const id = decodeURIComponent((anchor.getAttribute('href') || '').slice(1));
          if (!id) return;
          const target = root.querySelector(`[id="${CSS.escape(id)}"]`);
          target?.scrollIntoView({ block: 'center' });
        };
        anchor.addEventListener('click', onClick);
        cleanups.push(() => anchor.removeEventListener('click', onClick));
      }
    });

    return () => {
      images.forEach((img) => img.removeEventListener('click', onImage));
      cleanups.forEach((fn) => fn());
    };
  }, [chapter?.html, meta, toast]);

  // 跨章节链接带锚点时,等新章节渲染后滚动到目标位置
  useEffect(() => {
    const root = htmlRef.current;
    const pending = pendingAnchor.current;
    if (!root || !pending || pending.ch !== idx || loadedIdx !== idx) return;
    pendingAnchor.current = null;
    const reveal = () => {
      if (!root.isConnected) return;
      const target = root.querySelector(`[id="${CSS.escape(pending.id)}"]`);
      target?.scrollIntoView({ block: 'center' });
    };
    reveal();
    const timers = [window.setTimeout(reveal, 350), window.setTimeout(reveal, 1200)];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [chapter?.html, idx, loadedIdx]);

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
  const title =
    meta?.title?.replace(/\.(txt|epub)$/i, '').replace(/\[[^\]]*\]$/, '') ||
    titleParam ||
    (mode === 'file' ? file : mode === 'epub' ? 'EPUB 在线阅读' : '在线阅读');
  const bookmarked = notes.bookmarks.includes(idx);
  const noteCount = notes.bookmarks.length + notes.notes.length;

  const toggleBookmark = async () => {
    if (!bookKey) return;
    try {
      const data = await apiPost<{ bookmarks: number[]; bookmarked: boolean }>('/api/notes', {
        key: bookKey,
        action: 'bookmark_toggle',
        ch: idx,
      });
      setNotes((prev) => ({ ...prev, bookmarks: data.bookmarks ?? [] }));
      toast(
        data.bookmarked ? `已添加书签：第 ${idx} 章` : `已取消书签：第 ${idx} 章`,
        'success',
      );
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '书签操作失败', 'error');
    }
  };

  const removeBookmark = async (ch: number) => {
    if (!bookKey) return;
    try {
      const data = await apiPost<{ bookmarks: number[] }>('/api/notes', {
        key: bookKey,
        action: 'bookmark_toggle',
        ch,
      });
      setNotes((prev) => ({ ...prev, bookmarks: data.bookmarks ?? [] }));
      toast('已移除书签', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '操作失败', 'error');
    }
  };

  const removeNote = async (noteId: string) => {
    if (!bookKey) return;
    try {
      const data = await apiPost<{ notes: Note[] }>('/api/notes', {
        key: bookKey,
        action: 'note_del',
        id: noteId,
      });
      setNotes((prev) => ({ ...prev, notes: data.notes ?? [] }));
      toast('笔记已删除', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '删除失败', 'error');
    }
  };

  const openNote = (quote: string) => {
    setNoteQuote(quote.slice(0, 300));
    setNoteChapter(idx);
    setNoteText('');
    setNoteOpen(true);
    setSelBubble(null);
  };

  const saveNote = async () => {
    const text = noteText.trim();
    if (!text) {
      toast('笔记内容不能为空', 'error');
      return;
    }
    if (!bookKey) return;
    setNoteSaving(true);
    try {
      const data = await apiPost<{ notes: Note[] }>('/api/notes', {
        key: bookKey,
        action: 'note_add',
        ch: noteChapter,
        text,
        quote: noteQuote,
      });
      setNotes((prev) => ({ ...prev, notes: data.notes ?? [] }));
      setNoteOpen(false);
      toast('笔记已保存', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '保存失败', 'error');
    } finally {
      setNoteSaving(false);
    }
  };

  const captureSelection = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      const root = htmlRef.current || contentRef.current;
      if (!root || !selection || selection.rangeCount === 0 || text.length < 2 || text.length > 300) {
        setSelBubble(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setSelBubble(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelBubble({
        quote: text,
        top: Math.max(8, rect.top - 44),
        left: Math.min(window.innerWidth - 116, Math.max(8, rect.left + rect.width / 2 - 52)),
      });
    }, 0);
  };

  if (error) {    return (
      <div className="page">
        <div className="empty" style={{ paddingTop: 80 }}>
          <div className="empty__icon">
            <X size={20} />
          </div>
          <div className="empty__title">无法打开这本书</div>
          <div className="empty__desc">{error}</div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 16 }}
            onClick={() => navigate(mode === 'file' ? '/files' : '/shelf')}
          >
            <ArrowLeft size={15} />
            {mode === 'file' ? '返回文件' : '返回书架'}
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
            className={`btn btn--ghost btn--sm btn--icon${tocOpen ? ' is-on' : ''}`}
            onClick={() => {
              setTocOpen((open) => !open);
              setNotesOpen(false);
            }}
            title="目录"
            aria-label="目录"
          >
            <List size={15} />
          </button>
          <button
            type="button"
            className={`btn btn--ghost btn--sm btn--icon${notesOpen ? ' is-on' : ''}`}
            onClick={() => {
              setNotesOpen((open) => !open);
              setTocOpen(false);
              setSelBubble(null);
            }}
            title="书签与笔记"
            aria-label="书签与笔记"
          >
            <NotebookPen size={15} />
            {noteCount ? <span className="reader__badge">{noteCount > 99 ? '99+' : noteCount}</span> : null}
          </button>
          <button
            type="button"
            className={`btn btn--ghost btn--sm btn--icon${bookmarked ? ' is-marked' : ''}`}
            onClick={() => void toggleBookmark()}
            disabled={!meta}
            title={bookmarked ? '取消书签' : '添加书签'}
            aria-label={bookmarked ? '取消书签' : '添加书签'}
            aria-pressed={bookmarked}
          >
            <Bookmark size={15} fill={bookmarked ? 'currentColor' : 'none'} />
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
                  onClick={() => jumpTo(item.idx)}
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

        {notesOpen ? (
          <aside className="reader__toc reader__notes">
            <div className="reader__toc-head">
              <div className="reader__notes-title">书签与笔记</div>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={() => setNotesOpen(false)}
                aria-label="收起笔记"
              >
                <X size={14} />
              </button>
            </div>
            <div className="reader__toc-list reader__notes-list">
              {notes.bookmarks.length ? (
                <>
                  <div className="reader__notes-group">书签 · {notes.bookmarks.length}</div>
                  {notes.bookmarks.map((ch) => {
                    const chapterTitle =
                      meta?.chapters.find((item) => item.idx === ch)?.title || `第 ${ch} 章`;
                    return (
                      <div
                        key={`bookmark-${ch}`}
                        className={`reader__bookmark-row${ch === idx ? ' is-current' : ''}`}
                      >
                        <button
                          type="button"
                          className="reader__bookmark-main"
                          onClick={() => jumpTo(ch)}
                          title={chapterTitle}
                        >
                          <Bookmark size={13} fill="currentColor" />
                          <span>{chapterTitle}</span>
                        </button>
                        <button
                          type="button"
                          className="reader__note-del"
                          onClick={() => void removeBookmark(ch)}
                          title="移除书签"
                          aria-label="移除书签"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </>
              ) : null}

              {notes.notes.length ? (
                <>
                  <div className="reader__notes-group">笔记 · {notes.notes.length}</div>
                  {notes.notes
                    .slice()
                    .reverse()
                    .map((note) => {
                      const chapterTitle =
                        meta?.chapters.find((item) => item.idx === note.ch)?.title ||
                        `第 ${note.ch} 章`;
                      return (
                        <div key={note.id} className="reader__note">
                          <div className="reader__note-head">
                            <button
                              type="button"
                              className="reader__note-jump"
                              onClick={() => jumpTo(note.ch)}
                              title={`跳到${chapterTitle}`}
                            >
                              <span>{chapterTitle}</span>
                              <span>{formatNoteDate(note.ts)}</span>
                            </button>
                            <button
                              type="button"
                              className="reader__note-del"
                              onClick={() => void removeNote(note.id)}
                              title="删除笔记"
                              aria-label="删除笔记"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {note.quote ? (
                            <div className="reader__note-quote">「{note.quote}」</div>
                          ) : null}
                          <div className="reader__note-text">{note.text}</div>
                        </div>
                      );
                    })}
                </>
              ) : null}

              {!notes.bookmarks.length && !notes.notes.length ? (
                <div className="reader__toc-empty">
                  暂无书签与笔记
                  <br />
                  点顶部书签收藏章节，划选正文即可记笔记
                </div>
              ) : null}
            </div>
            <div className="reader__notes-foot">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openNote('')}>
                <NotebookPen size={14} />
                写笔记
              </button>
            </div>
          </aside>
        ) : null}

        <main
          className="reader__main"
          ref={contentRef}
          onScroll={() => setSelBubble(null)}
        >
          <article
            className="reader__paper"
            style={{ fontSize: `${16 * fontScale}px` }}
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
            onKeyUp={captureSelection}
          >
            <h1 className="reader__title">
              {chapter?.title || meta?.chapters.find((item) => item.idx === idx)?.title}
            </h1>
            {loading || chapterLoading || !chapter ? (
              <div className="reader__loading">
                <span className="spinner" /> {metaHint || '正在加载正文…'}
              </div>
            ) : chapter.html ? (
              <div
                ref={htmlRef}
                className="reader__text reader__html"
                dangerouslySetInnerHTML={{ __html: chapter.html }}
              />
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

      {selBubble ? (
        <button
          type="button"
          className="reader__sel-bubble"
          style={{ top: selBubble.top, left: selBubble.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openNote(selBubble.quote)}
        >
          <NotebookPen size={14} />
          记笔记
        </button>
      ) : null}

      <Modal
        title="添加笔记"
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        width={500}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setNoteOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              disabled={noteSaving}
              onClick={() => void saveNote()}
            >
              {noteSaving ? '保存中…' : '保存笔记'}
            </button>
          </>
        }
      >
        <div className="reader__note-form">
          <div className="reader__note-form-meta">
            第 {noteChapter} 章
            {meta?.chapters.find((item) => item.idx === noteChapter)?.title
              ? ` · ${meta.chapters.find((item) => item.idx === noteChapter)?.title}`
              : ''}
          </div>
          {noteQuote ? <div className="reader__note-quote">「{noteQuote}」</div> : null}
          <textarea
            className="input settings-textarea reader__note-input"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="写点什么…（Ctrl+Enter 保存）"
            maxLength={2000}
            autoFocus
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void saveNote();
              }
            }}
          />
        </div>
      </Modal>

      <Modal
        title="插图"
        open={Boolean(zoomImage)}
        onClose={() => setZoomImage('')}
        width={920}
        footer={
          <button type="button" className="btn" onClick={() => setZoomImage('')}>
            关闭
          </button>
        }
      >
        {zoomImage ? <img className="reader__zoom-img" src={zoomImage} alt="插图" /> : null}
      </Modal>
    </div>
  );
}
