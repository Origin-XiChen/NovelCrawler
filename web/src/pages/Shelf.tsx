import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Download,
  FolderOpen,
  Library,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, coverSrc } from '../lib/api';
import { useToast } from '../lib/toast';
import { Modal } from '../components/Modal';
import type { ShelfEntry } from '../lib/types';
import { relativeTime } from '../lib/format';

type Filter = 'all' | 'updates' | 'downloaded' | 'pending';
type BusyAction = 'refresh' | 'remove';
type Format = 'txt' | 'epub';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'updates', label: '有更新' },
  { value: 'downloaded', label: '已下载' },
  { value: 'pending', label: '未下载' },
];

function newCount(entry: ShelfEntry): number {
  const total = entry.checked_chapters ?? 0;
  const have = entry.have ?? entry.local_chapters ?? 0;
  return Math.max(0, total - have);
}

function localFileOf(entry: ShelfEntry): string {
  if (entry.local_file) return entry.local_file;
  return entry.url.startsWith('file:') ? entry.url.slice(5) : '';
}

export function ShelfPage() {
  const [entries, setEntries] = useState<ShelfEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<Record<string, BusyAction>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState<ShelfEntry | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ShelfEntry | null>(null);
  const [format, setFormat] = useState<Format>(
    () => (localStorage.getItem('shelf-format') === 'epub' ? 'epub' : 'txt'),
  );
  const [workers, setWorkers] = useState(1);
  const [delay, setDelay] = useState('auto');
  const [starting, setStarting] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiGet<{ shelf: ShelfEntry[] }>('/api/shelf');
      setEntries(data.shelf ?? []);
    } catch (error) {
      if (!silent) toast(error instanceof Error ? error.message : '书架加载失败', 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const hasLocal = Boolean(entry.local_chapters || localFileOf(entry));
      if (filter === 'updates' && newCount(entry) <= 0) return false;
      if (filter === 'downloaded' && !hasLocal) return false;
      if (filter === 'pending' && hasLocal) return false;
      if (!keyword) return true;
      const haystack = [entry.title, entry.author, entry.source, entry.category, ...(entry.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [entries, filter, query]);

  const refreshOne = useCallback(
    async (entry: ShelfEntry) => {
      setBusy((prev) => ({ ...prev, [entry.url]: 'refresh' }));
      try {
        const data = await apiPost<{ total: number; have: number; new: number }>('/api/shelf/refresh', {
          url: entry.url,
        });
        setEntries((prev) =>
          prev.map((item) =>
            item.url === entry.url
              ? { ...item, checked_chapters: data.total, have: data.have }
              : item,
          ),
        );
        toast(
          data.new > 0
            ? `《${entry.title}》有 ${data.new} 章更新`
            : `《${entry.title}》已是最新（${data.have}/${data.total} 章）`,
        );
      } catch (error) {
        toast(error instanceof Error ? error.message : '检查更新失败', 'error');
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[entry.url];
          return next;
        });
      }
    },
    [toast],
  );

  const refreshAll = async () => {
    const checkable = entries.filter((entry) => !entry.url.startsWith('file:'));
    if (!checkable.length || checkingAll) return;
    setCheckingAll(true);
    let updated = 0;
    let failed = 0;
    for (const entry of checkable) {
      setBusy((prev) => ({ ...prev, [entry.url]: 'refresh' }));
      try {
        const data = await apiPost<{ total: number; have: number; new: number }>('/api/shelf/refresh', {
          url: entry.url,
        });
        if (data.new > 0) updated += 1;
        setEntries((prev) =>
          prev.map((item) =>
            item.url === entry.url
              ? { ...item, checked_chapters: data.total, have: data.have }
              : item,
          ),
        );
      } catch {
        failed += 1;
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[entry.url];
          return next;
        });
      }
    }
    setCheckingAll(false);
    toast(
      `检查完成：${updated} 本有更新${failed ? `，${failed} 本失败` : ''}`,
      failed ? 'error' : 'default',
    );
  };

  const startDownload = async () => {
    if (!downloadTarget) return;
    setStarting(true);
    try {
      await apiPost<{ task_id: string }>('/api/download', {
        url: downloadTarget.url,
        start: 1,
        end: null,
        delay,
        out_dir: 'downloads',
        format,
        workers,
      });
      localStorage.setItem('shelf-format', format);
      toast(`《${downloadTarget.title}》已加入下载队列`);
      setDownloadTarget(null);
      navigate('/tasks');
    } catch (error) {
      toast(error instanceof Error ? error.message : '启动下载失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy((prev) => ({ ...prev, [removeTarget.url]: 'remove' }));
    try {
      await apiDelete('/api/shelf', { url: removeTarget.url });
      setEntries((prev) => prev.filter((item) => item.url !== removeTarget.url));
      toast(`已从书架移除《${removeTarget.title}》`);
      setRemoveTarget(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : '移除失败', 'error');
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        if (removeTarget) delete next[removeTarget.url];
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

  const updates = entries.filter((entry) => newCount(entry) > 0).length;
  const downloaded = entries.filter((entry) => entry.local_chapters || localFileOf(entry)).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">书架</h1>
          <p className="page-desc">
            {entries.length} 本收藏 · {downloaded} 本已下载
            {updates ? ` · ${updates} 本有更新` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void refreshAll()}
            disabled={!entries.some((entry) => !entry.url.startsWith('file:')) || checkingAll}
          >
            <RefreshCw size={15} className={checkingAll ? 'spin' : undefined} />
            {checkingAll ? '检查中…' : '全部检查'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void openDir()}>
            <FolderOpen size={15} />
            下载目录
          </button>
          <button type="button" className="btn btn--ghost btn--icon" onClick={() => void load()} aria-label="刷新书架">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__search">
          <Search size={15} />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选书名、作者、来源或标签"
            aria-label="筛选书架"
          />
        </div>
        <div className="segmented" role="group" aria-label="书架筛选">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={filter === item.value ? 'is-on' : ''}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="shelf-grid">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton" style={{ height: 188 }} />
          ))}
        </div>
      ) : filtered.length ? (
        <div className="shelf-grid">
          {filtered.map((entry) => {
            const local = entry.local_chapters ?? 0;
            const checked = entry.checked_chapters ?? 0;
            const fresh = newCount(entry);
            const cover = coverSrc(entry.cover);
            const working = busy[entry.url];
            const localFile = localFileOf(entry);
            const fromFile = entry.url.startsWith('file:');
            return (
              <article key={entry.url} className="shelf-card">
                <div className="shelf-card__top">
                  <div className="shelf-card__cover">
                    {cover ? <img src={cover} alt="" loading="lazy" /> : entry.title.slice(0, 1)}
                  </div>
                  <div className="shelf-card__info">
                    <h2 className="shelf-card__title" title={entry.title}>
                      {entry.title}
                    </h2>
                    <div className="shelf-card__meta">
                      {entry.source ? <span className="badge badge--primary">{entry.source}</span> : null}
                      {fresh > 0 ? <span className="badge badge--warn">{fresh} 章更新</span> : null}
                      {!localFile ? <span className="badge">未下载</span> : null}
                    </div>
                    {entry.tags?.length ? (
                      <div className="shelf-card__tags">
                        {entry.tags.slice(0, 3).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="shelf-card__progress">
                      {checked > 0 ? (
                        <>
                          <div className="progress-track">
                            <i style={{ width: `${Math.min(100, Math.round((local / checked) * 100))}%` }} />
                          </div>
                          <span>
                            本地 {local} / 共 {checked} 章
                          </span>
                        </>
                      ) : local > 0 ? (
                        <span>本地已下载 {local} 章</span>
                      ) : fromFile ? (
                        <span>本地 {localFile.toLowerCase().endsWith('.epub') ? 'EPUB' : 'TXT'} 文件</span>
                      ) : (
                        <span>加入于 {relativeTime(entry.added)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="shelf-card__actions">
                  {localFile ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => navigate(`/read?file=${encodeURIComponent(localFile)}`)}
                    >
                      <BookOpen size={14} />
                      阅读
                    </button>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={() => setDownloadTarget(entry)}>
                      <Download size={14} />
                      下载
                    </button>
                  )}
                  {localFile && !fromFile ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setDownloadTarget(entry)}
                      title="重新下载或更新本地文件"
                    >
                      <Download size={14} />
                      续传
                    </button>
                  ) : null}
                  {!fromFile ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void refreshOne(entry)}
                      disabled={working === 'refresh'}
                    >
                      <RefreshCw size={14} className={working === 'refresh' ? 'spin' : undefined} />
                      检查更新
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--icon"
                    onClick={() => setRemoveTarget(entry)}
                    disabled={working === 'remove'}
                    aria-label="从书架移除"
                    title="从书架移除"
                  >
                    <Trash2 size={14} />
                  </button>
                  {localFile ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--icon"
                      onClick={() => void openDir(localFile)}
                      title="在文件夹中显示"
                      aria-label="在文件夹中显示"
                    >
                      <FolderOpen size={14} />
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="empty__icon">
            {entries.length ? <Library size={20} /> : <BookOpen size={20} />}
          </div>
          <div className="empty__title">{entries.length ? '没有匹配的收藏' : '书架还是空的'}</div>
          <div className="empty__desc">
            {entries.length
              ? '换个筛选条件，或在搜索页把想看的书加入书架。'
              : '搜索一本书并加入书架，追更与阅读记录都会保留。'}
          </div>
          {!entries.length ? (
            <button type="button" className="btn" style={{ marginTop: 16 }} onClick={() => navigate('/search')}>
              <Search size={15} />
              去搜索
            </button>
          ) : null}
        </div>
      )}

      <Modal
        title={`下载《${downloadTarget?.title ?? ''}》`}
        open={Boolean(downloadTarget)}
        onClose={() => setDownloadTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDownloadTarget(null)}>
              取消
            </button>
            <button type="button" className="btn" onClick={() => void startDownload()} disabled={starting}>
              <Download size={15} />
              {starting ? '启动中…' : '开始下载'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label className="field">
            <span>导出格式</span>
            <div className="segmented" role="group" aria-label="导出格式">
              <button
                type="button"
                className={format === 'txt' ? 'is-on' : ''}
                onClick={() => setFormat('txt')}
              >
                TXT
              </button>
              <button
                type="button"
                className={format === 'epub' ? 'is-on' : ''}
                onClick={() => setFormat('epub')}
              >
                EPUB
              </button>
            </div>
          </label>
          <label className="field">
            <span>并发抓取</span>
            <select className="input" value={workers} onChange={(event) => setWorkers(Number(event.target.value))}>
              <option value={1}>1（最稳）</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={5}>5（快，风险高）</option>
            </select>
          </label>
          <label className="field">
            <span>章节间隔</span>
            <select className="input" value={delay} onChange={(event) => setDelay(event.target.value)}>
              <option value="auto">自动（推荐）</option>
              <option value="0.3">极速 0.3s</option>
              <option value="0.5">快速 0.5s</option>
              <option value="1.0">标准 1.0s</option>
              <option value="2.0">保守 2.0s</option>
            </select>
          </label>
        </div>
        <p className="modal__hint">
          TXT 支持断点续传；下载过程中可以在「下载任务」里暂停、继续或停止。
        </p>
      </Modal>

      <Modal
        title="从书架移除"
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setRemoveTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void confirmRemove()}>
              移除
            </button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          确定从书架移除《{removeTarget?.title}》吗？已下载的文件不会被删除。
        </p>
      </Modal>
    </div>
  );
}
