import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Images,
  Library,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { apiGet, apiPost, coverSrc } from '../lib/api';
import { formatBytes, relativeTime } from '../lib/format';
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

interface PdfState {
  title: string;
  file: string;
  pages: number;
  page: number;
  loading: boolean;
  error: string;
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
  const bits: string[] = [];
  if (chapter.volume !== undefined && chapter.volume !== '') bits.push(`第${chapter.volume}卷`);
  if (chapter.chapter !== undefined && chapter.chapter !== '') bits.push(`第${chapter.chapter}话`);
  if (chapter.title) bits.push(chapter.title);
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

  const searchSeq = useRef(0);
  const detailSeq = useRef(0);
  const readerSeq = useRef(0);
  const readerBodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
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

  useEffect(() => {
    if (reader) readerBodyRef.current?.scrollTo({ top: 0 });
  }, [reader]);

  useEffect(() => {
    if (!reader) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'Escape') {
        setReader(null);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void showChapter(reader.index - 1);
      } else if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        void showChapter(reader.index + 1);
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
      if (event.key === 'Escape') setPdfReader(null);
      if (!pdfReader.pages) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPdfReader((prev) => (prev && prev.page > 1 ? { ...prev, page: prev.page - 1 } : prev));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPdfReader((prev) =>
          prev && prev.page < prev.pages ? { ...prev, page: prev.page + 1 } : prev,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdfReader]);

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

  const openOnlineReader = (variant: Variant, chapters: ComicChapter[], index = 0) => {
    if (!chapters.length) {
      toast('暂无可阅读的话', 'error');
      return;
    }
    setDetail(null);
    setPdfReader(null);
    setReader({ variant, chapters, index, pages: [], loading: true, error: '' });
    void fetchPages(variant, chapters, index);
  };

  const showChapter = async (index: number) => {
    if (!reader || index < 0 || index >= reader.chapters.length) return;
    await fetchPages(reader.variant, reader.chapters, index);
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
      openOnlineReader(variant, chapters, 0);
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
    setReader(null);
    setPdfReader({ title, file, pages: 0, page: 1, loading: true, error: '' });
    try {
      const data = await apiGet<{ num_pages: number }>('/api/comic_page_meta', { title, file });
      setPdfReader((prev) =>
        prev && prev.title === title && prev.file === file
          ? { ...prev, pages: data.num_pages ?? 0, loading: false }
          : prev,
      );
    } catch (error) {
      setPdfReader((prev) =>
        prev
          ? { ...prev, loading: false, error: error instanceof Error ? error.message : 'PDF 解析失败' }
          : prev,
      );
    }
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
                    onClick={() => openOnlineReader(detail.variant, detail.chapters, 0)}
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
        <div className="comic-reader" role="dialog" aria-modal="true" aria-label="漫画阅读器">
          <header className="comic-reader__bar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReader(null)}>
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
              </div>
            </div>
            <div className="comic-reader__controls">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void showChapter(reader.index - 1)}
                disabled={reader.index <= 0 || reader.loading}
              >
                <ChevronLeft size={15} />
                上一话
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void showChapter(reader.index + 1)}
                disabled={reader.index >= reader.chapters.length - 1 || reader.loading}
              >
                下一话
                <ChevronRight size={15} />
              </button>
            </div>
          </header>
          <div className="comic-reader__body" ref={readerBodyRef}>
            {reader.loading ? (
              <div className="comic-reader__loading">
                <span className="spinner" /> 正在加载图片…
              </div>
            ) : reader.error ? (
              <div className="comic-reader__loading">{reader.error}</div>
            ) : reader.pages.length ? (
              <>
                {reader.pages.map((url, index) => (
                  <img
                    key={`${index}-${url}`}
                    className="comic-reader__page"
                    src={comicImage(url, reader.variant.source)}
                    alt={`第 ${index + 1} 页`}
                    loading="lazy"
                    onError={(event) => event.currentTarget.classList.add('is-broken')}
                  />
                ))}
                <div className="comic-reader__end">
                  本话结束 · 共 {reader.pages.length} 页
                </div>
              </>
            ) : (
              <div className="comic-reader__loading">这一话没有可用图片。</div>
            )}
          </div>
        </div>
      ) : null}

      {pdfReader ? (
        <div className="comic-reader" role="dialog" aria-modal="true" aria-label="PDF 阅读器">
          <header className="comic-reader__bar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPdfReader(null)}>
              <X size={15} />
              关闭
            </button>
            <div className="comic-reader__heading">
              <div className="comic-reader__title" title={pdfReader.title}>
                {pdfReader.title}
              </div>
              <div className="comic-reader__sub" title={pdfReader.file}>
                {pdfReader.file}
              </div>
            </div>
            <div className="comic-reader__controls">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setPdfReader((prev) => (prev ? { ...prev, page: prev.page - 1 } : prev))}
                disabled={pdfReader.page <= 1}
              >
                <ChevronLeft size={15} />
                上一页
              </button>
              <span className="comic-reader__count">
                {pdfReader.page} / {pdfReader.pages || '—'}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setPdfReader((prev) => (prev ? { ...prev, page: prev.page + 1 } : prev))}
                disabled={!pdfReader.pages || pdfReader.page >= pdfReader.pages}
              >
                下一页
                <ChevronRight size={15} />
              </button>
            </div>
          </header>
          <div className="comic-reader__body">
            {pdfReader.loading ? (
              <div className="comic-reader__loading">
                <span className="spinner" /> 正在解析 PDF…
              </div>
            ) : pdfReader.error ? (
              <div className="comic-reader__loading">{pdfReader.error}</div>
            ) : (
              <img
                key={pdfReader.page}
                className="comic-reader__page comic-reader__page--pdf"
                src={`/api/comic_page_image?title=${encodeURIComponent(pdfReader.title)}&file=${encodeURIComponent(pdfReader.file)}&page=${pdfReader.page}`}
                alt={`第 ${pdfReader.page} 页`}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
