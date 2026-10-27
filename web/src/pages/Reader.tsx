import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  List,
  Maximize2,
  Minimize2,
  Minus,
  NotebookPen,
  Plus,
  Search,
  Settings2,
  Trash2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import {
  clampRatio,
  continuousPercent,
  fetchReadingProgress,
  normalizeFraction,
  progressBookKey,
  pushReadingProgress,
  seedLegacyChapters,
  type ReadingProgressRecord,
} from '../lib/progress';
import type { ReaderChapter, ReaderMeta } from '../lib/types';

type ReaderTheme = 'light' | 'green' | 'sepia' | 'dark';
type ReaderMode = 'file' | 'online' | 'epub';

interface ReaderLayout {
  fs: number;
  lh: number;
  ff: string;
  w: number;
}

const LAYOUT_KEY = 'novelist_reader_layout';
const PAPER_KEY = 'novelist_paper';
const READ_KEY = 'novelist_reading_progress';
const READ_POS_KEY = 'novelist_reading_scroll';
const READER_ZOOM_KEY = 'novelist_reader_zoom';
const TTS_RATE_KEY = 'novelist_reader_tts_rate';
const DEFAULT_LAYOUT: ReaderLayout = { fs: 17, lh: 2.05, ff: 'songti', w: 880 };
const READER_FONTS = [
  { key: 'songti', name: '宋体', css: '"Georgia", "STSong", "SimSun", serif' },
  { key: 'kaiti', name: '楷体', css: '"KaiTi", "STKaiti", "楷体", serif' },
  { key: 'heiti', name: '黑体', css: '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif' },
  { key: 'dengxian', name: '等线', css: '"DengXian", "Microsoft YaHei", sans-serif' },
  { key: 'yuanti', name: '圆体', css: '"Yuanti SC", "YouYuan", "幼圆", sans-serif' },
  { key: 'fangsong', name: '仿宋', css: '"FangSong", "STFangsong", "仿宋", serif' },
  { key: 'yahei', name: '微软雅黑', css: '"Microsoft YaHei", "微软雅黑", sans-serif' },
];

function loadLayout(): ReaderLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') as Partial<ReaderLayout>;
    return {
      fs: Math.min(28, Math.max(13, Number(saved.fs) || DEFAULT_LAYOUT.fs)),
      lh: [1.6, 1.9, 2.05, 2.2].includes(Number(saved.lh)) ? Number(saved.lh) : DEFAULT_LAYOUT.lh,
      ff: READER_FONTS.some((font) => font.key === saved.ff) ? String(saved.ff) : DEFAULT_LAYOUT.ff,
      w: [720, 880, 1080].includes(Number(saved.w)) ? Number(saved.w) : DEFAULT_LAYOUT.w,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function loadTheme(): ReaderTheme {
  try {
    const paper = localStorage.getItem(PAPER_KEY);
    if (paper === 'paper') return 'light';
    if (paper === 'green' || paper === 'sepia') return paper;
    if (paper === 'night') return 'dark';
    const legacy = localStorage.getItem('reader-theme');
    if (legacy === 'green' || legacy === 'sepia' || legacy === 'dark') return legacy;
  } catch {
    /* 存储不可用时使用默认纸色 */
  }
  return 'light';
}

function loadNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

function readScrollTop(key: string, ch: number): number {
  try {
    const all = JSON.parse(localStorage.getItem(READ_POS_KEY) || '{}') as Record<
      string,
      Record<string, number>
    >;
    return Number(all[key]?.[ch]) || 0;
  } catch {
    return 0;
  }
}

function writeScrollTop(key: string, ch: number, top: number) {
  try {
    const all = JSON.parse(localStorage.getItem(READ_POS_KEY) || '{}') as Record<
      string,
      Record<string, number>
    >;
    const positions = all[key] || {};
    positions[ch] = Math.max(0, Math.round(top));
    all[key] = positions;
    localStorage.setItem(READ_POS_KEY, JSON.stringify(all));
  } catch {
    /* 滚动记忆失败不影响阅读 */
  }
}

function splitSpeech(text: string): string[] {
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [text];
  const chunks: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (sentence.length > 900) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < sentence.length; i += 900) chunks.push(sentence.slice(i, i + 900));
    } else if ((buffer + sentence).length > 900) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim()) chunks.push(buffer);
  return chunks.filter((chunk) => chunk.trim());
}

function pickChineseVoice(): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find(
      (voice) =>
        /zh[-_]CN/i.test(voice.lang) &&
        /Huihui|Yaoyao|Xiaoxiao|Yunxi|Xiaoyi|Kangkang|Meijia/i.test(voice.name),
    ) ||
    voices.find((voice) => /^zh/i.test(voice.lang)) ||
    null
  );
}

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
  const [imgScale, setImgScale] = useState(0);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const [layout, setLayout] = useState<ReaderLayout>(loadLayout);
  const [theme, setTheme] = useState<ReaderTheme>(loadTheme);
  const [zoom, setZoom] = useState(() => loadNumber(READER_ZOOM_KEY, 1, 0.6, 2));
  const [ttsRate, setTtsRate] = useState(() => loadNumber(TTS_RATE_KEY, 1, 0.5, 2));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(0);
  const [chapterMap, setChapterMap] = useState<Record<string, number>>({});
  const seq = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const htmlRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<{ id: string; ch: number } | null>(null);
  const idxRef = useRef(idx);
  const bookKeyRef = useRef(bookKey);
  const posTimerRef = useRef<number | null>(null);
  const suppressSaveRef = useRef(false);
  const restoredKeyRef = useRef('');
  const ttsGenRef = useRef(0);
  const chapterMapRef = useRef<Record<string, number>>({});
  const loadedIdxRef = useRef(0);
  const progressKeyRef = useRef('');
  const metaRef = useRef<ReaderMeta | null>(null);
  const chapterTitleRef = useRef('');
  const scrollFractionRef = useRef(0);
  const resumeFractionRef = useRef<{ ch: number; scroll: number } | null>(null);
  const pendingSaveRef = useRef<{
    ch: number;
    scroll: number;
    chapters: Record<string, number>;
  } | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const progressKey = bookKey
    ? progressBookKey(
        mode === 'online' ? 'url' : mode,
        mode === 'file' ? file : mode === 'epub' ? epubUrl : onlineUrl,
      )
    : '';

  useEffect(() => {
    idxRef.current = idx;
    bookKeyRef.current = bookKey;
  }, [bookKey, idx]);

  // 旧版后端 /api/epub_meta 不返回 total,退回章节数
  const total = meta?.total ?? meta?.chapters.length ?? 0;

  useEffect(() => {
    progressKeyRef.current = progressKey;
  }, [progressKey]);

  const flushProgress = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    const key = progressKeyRef.current;
    if (!pending || !key) return;
    const info = metaRef.current;
    try {
      await pushReadingProgress({
        book: key,
        kind: 'novel',
        title: info?.title || '',
        total: info?.total ?? info?.chapters.length ?? 0,
        ch: pending.ch,
        chapterTitle: chapterTitleRef.current,
        scroll: pending.scroll,
        chapters: pending.chapters,
        updated: Date.now(),
      });
    } catch {
      /* 后端暂不可用时本地进度照旧,下次翻章再补 */
    }
  }, []);

  const noteChapterFraction = useCallback((ch: number, fraction: number) => {
    if (!ch) return chapterMapRef.current;
    const value = normalizeFraction(fraction);
    const previous = chapterMapRef.current;
    // 只增不减:回滚重读不会把已经读完的章抹掉
    if (previous[String(ch)] !== undefined && previous[String(ch)] >= value) {
      return previous;
    }
    const next = { ...previous, [String(ch)]: value };
    chapterMapRef.current = next;
    setChapterMap(next);
    return next;
  }, []);

  const queueProgress = useCallback(
    (ch: number, fraction: number, immediate = false) => {
      if (!ch) return;
      const chapters = noteChapterFraction(ch, fraction);
      pendingSaveRef.current = { ch, scroll: clampRatio(fraction), chapters };
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (immediate) {
        void flushProgress();
        return;
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushProgress();
      }, 800);
    },
    [flushProgress, noteChapterFraction],
  );

  const currentFraction = useCallback(() => {
    const root = contentRef.current;
    if (!root) return 0;
    const max = root.scrollHeight - root.clientHeight;
    // 短章节整章都在屏幕里,滚不动也要算读完
    if (max <= 4) return loadedIdxRef.current === idxRef.current ? 1 : 0;
    return clampRatio(root.scrollTop / max);
  }, []);

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
    metaRef.current = null;
    loadedIdxRef.current = 0;
    chapterTitleRef.current = '';
    chapterMapRef.current = {};
    setChapterMap({});
    scrollFractionRef.current = 0;
    resumeFractionRef.current = null;
    pendingSaveRef.current = null;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

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
        metaRef.current = next;
        let saved = Number(localStorage.getItem(`reader:${bookKey}`) || 0);
        if (!saved) {
          try {
            saved = Number(
              (JSON.parse(localStorage.getItem(READ_KEY) || '{}') as Record<string, number>)[bookKey] ||
                0,
            );
          } catch {
            saved = 0;
          }
        }

        // 共享进度优先:电脑和手机写同一份,谁最后读就从谁那里接着读
        let shared: ReadingProgressRecord | undefined;
        if (progressKey) {
          try {
            shared = (await fetchReadingProgress(progressKey))[progressKey];
          } catch {
            shared = undefined;
          }
        }
        if (cancelled) return;
        const chapterTotal = next.total ?? next.chapters.length;
        let start = shared?.ch || saved || 0;
        if (!next.chapters.some((item) => item.idx === start)) {
          start = next.chapters[0]?.idx ?? 1;
        }
        let chapters: Record<string, number> =
          shared && shared.chapters && Object.keys(shared.chapters).length
            ? { ...shared.chapters }
            : {};
        if (!Object.keys(chapters).length) {
          // 升级前的旧记录只有章节号:按连续阅读补一次,保住原百分比
          const legacyCh = shared?.ch || saved || 0;
          if (legacyCh > 0) {
            chapters = seedLegacyChapters(legacyCh, shared?.scroll ?? 0, chapterTotal);
          }
        }
        chapterMapRef.current = chapters;
        setChapterMap(chapters);
        resumeFractionRef.current =
          shared && shared.ch === start && shared.scroll > 0
            ? { ch: start, scroll: clampRatio(shared.scroll) }
            : null;
        scrollFractionRef.current = resumeFractionRef.current?.scroll ?? 0;
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
  }, [bookKey, epubUrl, file, localEpub, mode, onlineUrl, progressKey, titleParam]);

  useEffect(() => {
    if (!meta || !bookKey) return;
    const id = ++seq.current;
    setChapterLoading(true);
    setSelBubble(null);
    setScrollPercent(0);
    contentRef.current?.scrollTo({ top: 0 });
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
        const loadedTitle =
          data.title || meta.chapters.find((item) => item.idx === idx)?.title || '';
        setChapter({
          title: loadedTitle,
          text: data.text || (data.html ? stripHtml(data.html) : ''),
          html: data.html || undefined,
        });
        setLoadedIdx(idx);
        loadedIdxRef.current = idx;
        chapterTitleRef.current = loadedTitle;
        const resume = resumeFractionRef.current;
        const startFraction = resume && resume.ch === idx ? resume.scroll : 0;
        scrollFractionRef.current = startFraction;
        queueProgress(idx, startFraction, true);
        try {
          localStorage.setItem(`reader:${bookKey}`, String(idx));
          localStorage.setItem(`reader_ts:${bookKey}`, String(Date.now()));
          const progress = JSON.parse(localStorage.getItem(READ_KEY) || '{}') as Record<
            string,
            number
          >;
          progress[bookKey] = idx;
          localStorage.setItem(READ_KEY, JSON.stringify(progress));
        } catch {
          /* 进度写入失败不影响阅读 */
        }
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
  }, [bookKey, epubUrl, file, idx, localEpub, meta, mode, onlineUrl, queueProgress, toast]);

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

  const persistScroll = useCallback(
    (ch = idxRef.current, top = contentRef.current?.scrollTop ?? 0) => {
      const key = bookKeyRef.current;
      if (key) writeScrollTop(key, ch, top);
    },
    [],
  );

  const go = useCallback(
    (next: number) => {
      if (!total) return;
      const target = Math.min(total, Math.max(1, next));
      if (target === idxRef.current) return;
      persistScroll();
      queueProgress(idxRef.current, currentFraction(), true);
      pendingAnchor.current = null;
      scrollFractionRef.current = 0;
      setScrollPercent(0);
      setIdx(target);
      contentRef.current?.scrollTo({ top: 0 });
    },
    [currentFraction, persistScroll, queueProgress, total],
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

  const stopSpeak = useCallback(() => {
    ttsGenRef.current += 1;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const toggleSpeak = useCallback(() => {
    if (!('speechSynthesis' in window)) {
      toast('当前环境不支持朗读', 'error');
      return;
    }
    if (speaking) {
      stopSpeak();
      return;
    }
    const plain = (chapter?.html ? stripHtml(chapter.html) : chapter?.text || '').trim();
    if (!plain) {
      toast('本章暂无内容可朗读', 'info');
      return;
    }
    const chunks = splitSpeech(plain);
    const gen = ++ttsGenRef.current;
    const voice = pickChineseVoice();
    const speakAt = (index: number) => {
      if (gen !== ttsGenRef.current) return;
      if (index >= chunks.length) {
        setSpeaking(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'zh-CN';
      utterance.rate = ttsRate;
      utterance.onend = () => speakAt(index + 1);
      utterance.onerror = () => {
        if (gen === ttsGenRef.current) setSpeaking(false);
      };
      window.speechSynthesis.speak(utterance);
    };
    window.speechSynthesis.cancel();
    setSpeaking(true);
    speakAt(0);
  }, [chapter?.html, chapter?.text, speaking, stopSpeak, toast, ttsRate]);

  useEffect(() => {
    stopSpeak();
  }, [idx, stopSpeak]);

  useEffect(() => {
    return () => {
      ttsGenRef.current += 1;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const request = document.documentElement.requestFullscreen?.();
    if (request) void request.catch(() => toast('当前环境不支持全屏', 'info'));
  }, [toast]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleScroll = useCallback(() => {
    setSelBubble(null);
    const root = contentRef.current;
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    // 短章节整章可见,没有滚动条也要算读完
    const fraction =
      max > 0 ? clampRatio(root.scrollTop / max) : loadedIdxRef.current === idxRef.current ? 1 : 0;
    setScrollPercent(fraction * 100);
    scrollFractionRef.current = fraction;
    if (suppressSaveRef.current) return;
    if (posTimerRef.current) window.clearTimeout(posTimerRef.current);
    posTimerRef.current = window.setTimeout(() => {
      persistScroll(idxRef.current, root.scrollTop);
      queueProgress(idxRef.current, currentFraction());
    }, 250);
  }, [currentFraction, persistScroll, queueProgress]);

  useEffect(() => {
    return () => {
      if (posTimerRef.current) window.clearTimeout(posTimerRef.current);
      const root = contentRef.current;
      if (root && bookKeyRef.current) {
        writeScrollTop(bookKeyRef.current, idxRef.current, root.scrollTop);
      }
      if (progressKeyRef.current) {
        // 离开阅读器前把最后位置送出去,不等 800ms 防抖
        const fraction = currentFraction();
        const current = chapterMapRef.current[String(idxRef.current)];
        pendingSaveRef.current = {
          ch: idxRef.current,
          scroll: fraction,
          chapters:
            current !== undefined
              ? chapterMapRef.current
              : { ...chapterMapRef.current, [String(idxRef.current)]: fraction },
        };
        void flushProgress();
      }
    };
  }, [currentFraction, flushProgress]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [settingsOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      localStorage.setItem('reader-font', String(layout.fs));
    } catch {
      /* 存储不可用 */
    }
  }, [layout]);

  useEffect(() => {
    try {
      localStorage.setItem(PAPER_KEY, theme === 'light' ? 'paper' : theme);
      localStorage.setItem('reader-theme', theme);
    } catch {
      /* 存储不可用 */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(READER_ZOOM_KEY, String(zoom));
    } catch {
      /* 存储不可用 */
    }
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(TTS_RATE_KEY, String(ttsRate));
    } catch {
      /* 存储不可用 */
    }
  }, [ttsRate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'h') {
          event.preventDefault();
          setImmersive((value) => !value);
          setSettingsOpen(false);
        }
        return;
      }
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false);
        else if (zoomImage) setZoomImage('');
        else if (tocOpen) setTocOpen(false);
        else if (notesOpen) setNotesOpen(false);
        else if (selBubble) setSelBubble(null);
        else if (immersive) setImmersive(false);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(idx - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(idx + 1);
      } else if (event.key === 'PageDown' || (event.key === ' ' && (!event.shiftKey || tag !== 'BUTTON'))) {
        if (event.key === ' ' && tag === 'BUTTON') return;
        event.preventDefault();
        const root = contentRef.current;
        if (root) {
          root.scrollBy({
            top: root.clientHeight * 0.85 * (event.shiftKey ? -1 : 1),
            behavior: 'smooth',
          });
        }
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        const root = contentRef.current;
        if (root) root.scrollBy({ top: -root.clientHeight * 0.85, behavior: 'smooth' });
      } else if (event.key === 'f' || event.key === 'F') {
        toggleFullscreen();
      } else if (event.key === 't' || event.key === 'T') {
        setTocOpen((value) => !value);
        setNotesOpen(false);
        setSelBubble(null);
      } else if (event.key === 'n' || event.key === 'N') {
        setNotesOpen((value) => !value);
        setTocOpen(false);
        setSelBubble(null);
      } else if (event.key === 'r' || event.key === 'R') {
        toggleSpeak();
      } else if (event.key === '+' || event.key === '=') {
        setLayout((value) => ({ ...value, fs: Math.min(28, value.fs + 1) }));
      } else if (event.key === '-') {
        setLayout((value) => ({ ...value, fs: Math.max(13, value.fs - 1) }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    go,
    idx,
    immersive,
    notesOpen,
    selBubble,
    settingsOpen,
    tocOpen,
    toggleFullscreen,
    toggleSpeak,
    zoomImage,
  ]);

  useEffect(() => {
    if (loadedIdx !== idx || !bookKey) return;
    const root = contentRef.current;
    if (!root) return;
    const token = `${bookKey}\u0000${idx}`;
    if (restoredKeyRef.current === token) return;
    restoredKeyRef.current = token;
    if (pendingAnchor.current?.ch === idx) return;
    const top = readScrollTop(bookKey, idx);
    const resume = resumeFractionRef.current;
    const fraction = resume && resume.ch === idx ? resume.scroll : 0;
    suppressSaveRef.current = true;
    let cancelled = false;
    const apply = () => {
      if (cancelled || !root.isConnected) return;
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      const target = top > 0 ? top : Math.round(max * fraction);
      root.scrollTop = Math.min(target, max);
      if (max > 0) {
        const restored = clampRatio(root.scrollTop / max);
        setScrollPercent(restored * 100);
        scrollFractionRef.current = restored;
        if (restored > 0) queueProgress(idx, restored);
      } else {
        // 短章节整屏可见,滚不动也直接算读完
        setScrollPercent(100);
        scrollFractionRef.current = 1;
        queueProgress(idx, 1);
      }
    };
    const raf = window.requestAnimationFrame(apply);
    const timer = window.setTimeout(() => {
      apply();
      suppressSaveRef.current = false;
      resumeFractionRef.current = null;
    }, 300);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      suppressSaveRef.current = false;
    };
  }, [bookKey, chapter?.html, chapter?.text, idx, loadedIdx, queueProgress]);

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
      setImgScale(0);
      setImgNatural({ w: 0, h: 0 });
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

  const liveChapterMap = useMemo(() => {
    const current = chapterMap[String(idx)];
    const fraction = clampRatio(scrollPercent / 100);
    if (current !== undefined && current >= fraction) return chapterMap;
    return { ...chapterMap, [String(idx)]: fraction };
  }, [chapterMap, idx, scrollPercent]);

  const percent = useMemo(
    () => continuousPercent({ total, ch: idx, scroll: scrollPercent / 100, chapters: liveChapterMap }),
    [idx, liveChapterMap, scrollPercent, total],
  );
  const readerFont = READER_FONTS.find((font) => font.key === layout.ff) ?? READER_FONTS[0];
  const readerStyle = {
    '--reader-width': `${layout.w}px`,
    '--reader-font': readerFont.css,
  } as CSSProperties;
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

  const copySelection = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制选中文字', 'success');
      setSelBubble(null);
    } catch {
      toast('复制失败', 'error');
    }
  };

  const copyImage = async () => {
    if (!zoomImage) return;
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('load'));
        image.src = zoomImage;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('empty');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('图片已复制到剪贴板', 'success');
    } catch {
      toast('复制失败（可能受权限限制）', 'error');
    }
  };

  const openImageOriginal = () => {
    if (!zoomImage) return;
    const opened = window.open(zoomImage, '_blank', 'noopener,noreferrer');
    if (!opened) toast('无法打开新窗口', 'info');
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
        left: Math.min(window.innerWidth - 156, Math.max(8, rect.left + rect.width / 2 - 74)),
      });
    }, 0);
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
    <div
      ref={rootRef}
      className={`reader reader--${theme}${immersive ? ' reader--immersive' : ''}`}
      style={readerStyle}
    >      <header className="reader__bar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={15} />
          返回
        </button>
        <div className="reader__heading">
          <div className="reader__book" title={title}>
            {title}
          </div>
          {/* 章节名与书名相同时不要重复渲染 —— TXT 首章常把「书名」当标题解析出来,
              顶栏就会出现两行一模一样的文字 */}
          {(() => {
            const label = (chapter?.title || '').trim() || (loading ? '加载中…' : '');
            if (!label || label === title.trim()) return null;
            return <div className="reader__chapter-name">{label}</div>;
          })()}
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
            <button type="button" className={theme === 'green' ? 'is-on' : ''} onClick={() => setTheme('green')}>
              护眼
            </button>
            <button type="button" className={theme === 'sepia' ? 'is-on' : ''} onClick={() => setTheme('sepia')}>
              羊皮
            </button>
            <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')}>
              暗夜
            </button>
          </div>
          <div className="reader__font">
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              onClick={() => setLayout((value) => ({ ...value, fs: Math.max(13, value.fs - 1) }))}
              disabled={layout.fs <= 13}
              title="减小字号"
              aria-label="减小字号"
            >
              <Minus size={14} />
            </button>
            <span>{layout.fs}px</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              onClick={() => setLayout((value) => ({ ...value, fs: Math.min(28, value.fs + 1) }))}
              disabled={layout.fs >= 28}
              title="增大字号"
              aria-label="增大字号"
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            className={`btn btn--ghost btn--sm btn--icon${speaking ? ' is-on' : ''}`}
            onClick={toggleSpeak}
            title={speaking ? '停止朗读（R）' : '朗读本章（R）'}
            aria-label={speaking ? '停止朗读' : '朗读本章'}
            aria-pressed={speaking}
          >
            {speaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={toggleFullscreen}
            title={fullscreen ? '退出全屏（F）' : '全屏（F）'}
            aria-label={fullscreen ? '退出全屏' : '全屏'}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <div className="reader__settings-wrap" ref={settingsRef}>
            <button
              type="button"
              className={`btn btn--ghost btn--sm btn--icon${settingsOpen ? ' is-on' : ''}`}
              onClick={() => setSettingsOpen((value) => !value)}
              title="阅读设置"
              aria-label="阅读设置"
              aria-expanded={settingsOpen}
            >
              <Settings2 size={15} />
            </button>
            {settingsOpen ? (
              <div className="reader__settings" role="dialog" aria-label="阅读设置">
                <div className="reader__settings-hd">
                  <span>阅读设置</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--icon"
                    onClick={() => setSettingsOpen(false)}
                    aria-label="关闭阅读设置"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="reader__settings-label">纸张主题</div>
                <div className="reader__chip-row">
                  {(
                    [
                      ['light', '纸白'],
                      ['green', '护眼'],
                      ['sepia', '羊皮'],
                      ['dark', '暗夜'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={theme === key ? 'is-on' : ''}
                      onClick={() => setTheme(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="reader__settings-label">字体</div>
                <div className="reader__font-grid">
                  {READER_FONTS.map((font) => (
                    <button
                      key={font.key}
                      type="button"
                      className={layout.ff === font.key ? 'is-on' : ''}
                      style={{ fontFamily: font.css }}
                      onClick={() => setLayout((value) => ({ ...value, ff: font.key }))}
                    >
                      {font.name}
                    </button>
                  ))}
                </div>
                <div className="reader__settings-label">行距</div>
                <div className="reader__chip-row">
                  {[1.6, 1.9, 2.2].map((lineHeight) => (
                    <button
                      key={lineHeight}
                      type="button"
                      className={layout.lh === lineHeight ? 'is-on' : ''}
                      onClick={() => setLayout((value) => ({ ...value, lh: lineHeight }))}
                    >
                      {lineHeight.toFixed(1)}×
                    </button>
                  ))}
                </div>
                <div className="reader__settings-label">版心宽度</div>
                <div className="reader__chip-row">
                  {[
                    [720, '窄'],
                    [880, '中'],
                    [1080, '宽'],
                  ].map(([width, label]) => (
                    <button
                      key={width}
                      type="button"
                      className={layout.w === width ? 'is-on' : ''}
                      onClick={() => setLayout((value) => ({ ...value, w: Number(width) }))}
                    >
                      {label} {width}
                    </button>
                  ))}
                </div>
                <div className="reader__settings-label">屏幕缩放</div>
                <div className="reader__stepper">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--icon"
                    onClick={() => setZoom((value) => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))}
                    aria-label="缩小屏幕"
                  >
                    <Minus size={13} />
                  </button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--icon"
                    onClick={() => setZoom((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10))}
                    aria-label="放大屏幕"
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <div className="reader__settings-label">朗读语速</div>
                <div className="reader__chip-row">
                  {[0.8, 1, 1.2, 1.5].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={ttsRate === rate ? 'is-on' : ''}
                      onClick={() => setTtsRate(rate)}
                    >
                      {rate}×
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
              {tocItems.map((item) => {
                const fraction = normalizeFraction(liveChapterMap[String(item.idx)] ?? 0);
                return (
                  <button
                    key={item.idx}
                    type="button"
                    className={`reader__toc-item${item.idx === idx ? ' is-current' : ''}`}
                    onClick={() => jumpTo(item.idx)}
                    title={item.title}
                  >
                    <span className="reader__toc-main">
                      {item.volume ? (
                        <span className="reader__toc-volume">{item.volume}</span>
                      ) : null}
                      <span className="reader__toc-title">
                        {item.title || `第 ${item.idx} 章`}
                      </span>
                    </span>
                    {fraction > 0 ? (
                      <span
                        className={`reader__toc-pct${fraction >= 1 ? ' is-done' : ''}`}
                        title={`本章已读 ${Math.round(fraction * 100)}%`}
                      >
                        {fraction >= 1 ? '已读' : `${Math.round(fraction * 100)}%`}
                      </span>
                    ) : null}
                  </button>
                );
              })}
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
          onScroll={handleScroll}
          style={{ zoom } as CSSProperties}
        >
          <article
            className="reader__paper"
            style={{ fontSize: `${layout.fs}px`, lineHeight: layout.lh, fontFamily: 'var(--reader-font)' }}
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
            onKeyUp={captureSelection}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('a, img, button, input, textarea, select')) return;
              if (window.getSelection()?.toString().trim()) return;
              setImmersive((value) => !value);
              setSettingsOpen(false);
            }}
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
            <span
              className="reader__count"
              title="总进度只统计从第 1 章起连续读过的部分，跳读不计入"
            >
              {idx} / {total || '—'} · 总进度 {percent}%
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => go(idx + 1)} disabled={!total || idx >= total}>
              下一章
              <ChevronRight size={16} />
            </button>
          </div>
        </main>
      </div>

      {selBubble ? (
        <div
          className="reader__sel-bubble"
          style={{ top: selBubble.top, left: selBubble.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" onClick={() => openNote(selBubble.quote)}>
            <NotebookPen size={14} />
            记笔记
          </button>
          <button type="button" onClick={() => void copySelection(selBubble.quote)}>
            <Copy size={14} />
            复制
          </button>
        </div>
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
            {meta?.chapters.find((item) => item.idx === noteChapter)?.title ||
              `第 ${noteChapter} 章`}
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
        onClose={() => {
          setZoomImage('');
          setImgScale(0);
        }}
        width={920}
        footer={
          <div className="reader__zoom-tools">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setImgScale((value) => Math.max(0.1, Math.round(((value || 1) - 0.25) * 100) / 100))}
            >
              <ZoomOut size={14} />
              缩小
            </button>
            <span className="reader__zoom-pct">{imgScale > 0 ? `${Math.round(imgScale * 100)}%` : '适应'}</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setImgScale((value) => Math.min(8, Math.round(((value || 1) + 0.25) * 100) / 100))}
            >
              <ZoomIn size={14} />
              放大
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setImgScale(1)}>
              1:1
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setImgScale(0)}>
              适应
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyImage()}>
              <Copy size={14} />
              复制
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={openImageOriginal}>
              <ExternalLink size={14} />
              原图
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setZoomImage('');
                setImgScale(0);
              }}
            >
              关闭
            </button>
          </div>
        }
      >
        <div className="reader__zoom-stage">
          {zoomImage ? (
            <img
              className="reader__zoom-img"
              src={zoomImage}
              alt="插图"
              style={
                imgScale > 0 && imgNatural.w > 0
                  ? {
                      width: `${Math.round(imgNatural.w * imgScale)}px`,
                      maxWidth: 'none',
                      maxHeight: 'none',
                    }
                  : undefined
              }
              onLoad={(event) =>
                setImgNatural({
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                })
              }
              onDoubleClick={() => setImgScale((value) => (value > 0 ? 0 : 1))}
            />
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
