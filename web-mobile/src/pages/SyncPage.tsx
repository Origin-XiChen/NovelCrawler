import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CloudOff,
  CloudUpload,
  Download,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  allBooks,
  allProgress,
  type LocalBook,
  type LocalProgress,
} from '../lib/offline/db';
import {
  fetchCatalog,
  importBook,
  type CatalogComic,
  type CatalogNovel,
  type ImportTarget,
} from '../lib/offline/transfer';
import { lastSyncAt, syncProgress } from '../lib/offline/sync';
import { continuousPercent } from '../lib/reading-progress';
import { getActiveServer } from '../lib/connection';
import { useServerStatus } from '../lib/serverStatus';

/** 一条待同步的资源:电脑上有、手机上没有或已过期 */
interface PendingItem {
  key: string;
  kind: 'novel' | 'comic';
  title: string;
  reason: 'missing' | 'stale' | 'cover';
  detail: string;
  target: ImportTarget;
  local?: LocalBook;
}

/**
 * 同步中心:资源 + 进度。
 *
 * 资源部分回答"手机上的是不是电脑上最新的"——包括**封面**:电脑换了封面,
 * 这里会显示「封面过期」,重新下载即可带上新封面(打包时已把封面写进离线包)。
 */
export default function SyncPage() {
  const navigate = useNavigate();
  const server = getActiveServer();
  const link = useServerStatus();
  const [books, setBooks] = useState<LocalBook[]>([]);
  const [records, setRecords] = useState<LocalProgress[]>([]);
  const [catalog, setCatalog] = useState<{ novels: CatalogNovel[]; comics: CatalogComic[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [lastAt, setLastAt] = useState(() => lastSyncAt());

  const loadLocal = useCallback(async () => {
    const [b, p] = await Promise.all([allBooks(), allProgress()]);
    setBooks(b);
    setRecords(p);
  }, []);

  const loadRemote = useCallback(async () => {
    if (!server) return;
    try {
      const data = await fetchCatalog();
      setCatalog({ novels: data.novels, comics: data.comics });
    } catch {
      setCatalog(null);
    }
  }, [server]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadLocal();
      await loadRemote();
      setLoading(false);
    })();
  }, [loadLocal, loadRemote]);

  // 电脑重新上线后自动补拉一次资源清单
  useEffect(() => {
    if (link === 'online') void loadRemote();
  }, [link, loadRemote]);

  const recordMap = useMemo(() => {
    const map = new Map<string, LocalProgress>();
    records.forEach((item) => map.set(item.bookId, item));
    return map;
  }, [records]);

  /** 本地书索引:小说按文件名,漫画按书名聚合 */
  const localIndex = useMemo(() => {
    const novel = new Map<string, LocalBook>();
    const comic = new Map<string, LocalBook[]>();
    for (const book of books) {
      if (book.kind === 'comic') {
        const list = comic.get(book.title) || [];
        list.push(book);
        comic.set(book.title, list);
      } else {
        novel.set(book.file, book);
      }
    }
    return { novel, comic };
  }, [books]);

  /** 待同步资源:未下载 / 内容更新 / 封面过期 */
  const pending = useMemo<PendingItem[]>(() => {
    if (!catalog) return [];
    const out: PendingItem[] = [];
    for (const item of catalog.novels) {
      const local = localIndex.novel.get(item.file);
      if (!local) {
        out.push({
          key: `novel:${item.file}`,
          kind: 'novel',
          title: item.title,
          reason: 'missing',
          detail: `${item.chapters} 章 · 未下载`,
          target: { kind: 'novel', file: item.file },
        });
        continue;
      }
      const stale = item.mtime > local.srcMtime + 1 || item.size !== local.srcSize;
      const coverStale = Boolean(item.cover_mtime) && (item.cover_mtime as number) > local.importedAt / 1000;
      if (stale) {
        out.push({
          key: `novel:${item.file}`,
          kind: 'novel',
          title: item.title,
          reason: 'stale',
          detail: `电脑已更新 · ${item.chapters} 章`,
          target: { kind: 'novel', file: item.file },
          local,
        });
      } else if (coverStale) {
        out.push({
          key: `novel:${item.file}`,
          kind: 'novel',
          title: item.title,
          reason: 'cover',
          detail: '封面已更新',
          target: { kind: 'novel', file: item.file },
          local,
        });
      }
    }
    // 漫画:电脑按话列出,手机按书聚合
    const comicGroups = new Map<string, CatalogComic[]>();
    for (const item of catalog.comics) {
      const list = comicGroups.get(item.title) || [];
      list.push(item);
      comicGroups.set(item.title, list);
    }
    for (const [title, items] of comicGroups) {
      const locals = localIndex.comic.get(title) || [];
      const all = locals.find((book) => book.file === '__all__');
      const newest = Math.max(0, ...items.map((item) => item.mtime));
      if (!locals.length) {
        out.push({
          key: `comic:${title}`,
          kind: 'comic',
          title,
          reason: 'missing',
          detail: `${items.length} 话 · 未下载`,
          target: { kind: 'comic', file: '', title, all: true },
        });
        continue;
      }
      if (!all || newest > all.srcMtime + 1) {
        out.push({
          key: `comic:${title}`,
          kind: 'comic',
          title,
          reason: all ? 'stale' : 'missing',
          detail: all ? `${items.length} 话 · 电脑有更新` : `${items.length} 话 · 建议整本下载`,
          target: { kind: 'comic', file: '', title, all: true },
          local: all || locals[0],
        });
      }
    }
    const weight = { stale: 0, missing: 1, cover: 2 } as const;
    return out.sort((a, b) => weight[a.reason] - weight[b.reason]);
  }, [catalog, localIndex]);

  const rows = useMemo(() => {
    return books
      .map((book) => {
        const record = recordMap.get(book.id);
        return {
          book,
          record,
          percent: record ? continuousPercent(record) : 0,
          dirty: Boolean(record?.dirty),
        };
      })
      .sort((a, b) => {
        if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
        return (b.record?.ts || 0) - (a.record?.ts || 0);
      });
  }, [books, recordMap]);

  const dirtyTotal = rows.filter((row) => row.dirty).length;
  const online = link === 'online';

  const runUpdate = async (items: PendingItem[]) => {
    if (!items.length) return;
    setBusy(items.length === 1 ? items[0].key : '__all__');
    setNotice('');
    let done = 0;
    for (const item of items) {
      try {
        await importBook(item.target, (progress) => {
          setNotice(`${item.title}：${progress.detail || '处理中…'}`);
        });
        done += 1;
      } catch (cause) {
        setNotice(`《${item.title}》失败：${cause instanceof Error ? cause.message : String(cause)}`);
        break;
      }
    }
    await loadLocal();
    await loadRemote();
    setBusy('');
    setNotice(done === items.length ? `已同步 ${done} 本` : `完成 ${done}/${items.length} 本`);
  };

  const pushProgress = async () => {
    setBusy('__progress__');
    setNotice('');
    try {
      const result = await syncProgress();
      setLastAt(lastSyncAt());
      await loadLocal();
      setNotice(
        `已回传 ${result.pushed} 条，拉取 ${result.pulled} 条` +
          (result.failed ? `，失败 ${result.failed} 条` : ''),
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="sync-page">
      <header className="sync-page__head">
        <button
          type="button"
          className="icon-btn"
          aria-label="返回"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/shelf'))}
        >
          <ArrowLeft size={20} />
        </button>
        <h1>同步中心</h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新"
          onClick={() => {
            void loadLocal();
            void loadRemote();
          }}
        >
          <RefreshCw size={18} />
        </button>
      </header>

      {notice && (
        <div className="sync-notice" role="status">
          {notice}
        </div>
      )}

      <div className={online ? 'sync-link is-online' : 'sync-link'}>
        {online ? (
          <Wifi size={15} />
        ) : link === 'checking' ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <CloudOff size={15} />
        )}
        <span>
          {!server
            ? '还没连接电脑'
            : online
              ? `电脑在线${server.name ? ` · ${server.name}` : ''}`
              : link === 'checking'
                ? '正在检测电脑…'
                : '电脑离线'}
        </span>
        <em>{lastAt ? `上次同步 ${new Date(lastAt).toLocaleTimeString()}` : '还未同步过'}</em>
      </div>

      <section className="sync-block">
        <div className="sync-block__head">
          <h2>资源</h2>
          <span>{pending.length ? `${pending.length} 项待同步` : catalog ? '已是最新' : '—'}</span>
        </div>
        {!catalog && (
          <div className="sync-block__empty">
            {online ? '正在读取电脑资源…' : '电脑离线，看不到电脑上的资源'}
          </div>
        )}
        {catalog && pending.length === 0 && (
          <div className="sync-block__empty">手机上的内容都是电脑最新版（含封面）</div>
        )}
        {pending.length > 0 && (
          <>
            <div className="sync-block__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={!online || Boolean(busy)}
                onClick={() => void runUpdate(pending)}
              >
                {busy === '__all__' ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                全部更新（{pending.length}）
              </button>
            </div>
            <div className="sync-list">
              {pending.slice(0, 30).map((item) => (
                <div key={item.key} className="sync-row">
                  <div className="sync-row__main">
                    <div className="sync-row__title">
                      <strong title={item.title}>{item.title}</strong>
                      <span className="sync-row__kind">{item.kind === 'comic' ? '漫画' : '小说'}</span>
                    </div>
                    <div className="sync-row__meta">
                      <span>{item.detail}</span>
                      <span className={`sync-row__tag is-${item.reason}`}>
                        {item.reason === 'missing' ? '未下载' : item.reason === 'cover' ? '封面过期' : '可更新'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!online || Boolean(busy)}
                    onClick={() => void runUpdate([item])}
                  >
                    {busy === item.key ? <Loader2 size={14} className="spin" /> : '更新'}
                  </button>
                </div>
              ))}
            </div>
            {pending.length > 30 && (
              <div className="sync-note">
                还有 {pending.length - 30} 项未显示，先更新上面这些后再刷新
              </div>
            )}
          </>
        )}
      </section>

      <section className="sync-block">
        <div className="sync-block__head">
          <h2>阅读进度</h2>
          <span>{dirtyTotal ? `${dirtyTotal} 条待回传` : `${rows.length} 本`}</span>
        </div>
        <div className="sync-block__actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online || Boolean(busy)}
            onClick={() => void pushProgress()}
          >
            {busy === '__progress__' ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />}
            立即回传进度
          </button>
        </div>
        <div className="sync-list">
          {rows.slice(0, 30).map(({ book, record, percent, dirty }) => (
            <div key={book.id} className="sync-row">
              <div className="sync-row__main">
                <div className="sync-row__title">
                  <strong title={book.title}>{book.title}</strong>
                  <span className="sync-row__pct">{record ? `${percent}%` : '—'}</span>
                </div>
                <div className="sync-row__meta">
                  <span>{book.kind === 'comic' ? `${book.total} 页` : `${book.total} 章`}</span>
                  <span>{record ? `读到 ${record.ch}/${record.total || book.total}` : '未开始'}</span>
                  {dirty && <span className="sync-row__tag is-stale">待回传</span>}
                </div>
                {record && (
                  <div className="sync-row__bar">
                    <i style={{ width: `${Math.min(100, percent)}%` }} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {rows.length > 30 && (
          <div className="sync-note">还有 {rows.length - 30} 本未显示</div>
        )}
      </section>

      {!online && server && (
        <div className="sync-note">
          <WifiOff size={14} /> 电脑离线时仍可阅读已下载的内容，进度会在联网后自动回传。
        </div>
      )}
      {loading && <div className="sync-note">正在读取本地书库…</div>}
    </div>
  );
}
