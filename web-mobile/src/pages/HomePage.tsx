import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  CloudUpload,
  HardDrive,
  Images,
  LibraryBig,
  Loader2,
  Plus,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import BookCover from '../components/BookCover';
import { getActiveServer } from '../lib/connection';
import { errorMessage, formatSize } from '../lib/format';
import { localReaderHref } from '../lib/content';
import { continuousPercent } from '../lib/reading-progress';
import { ensurePersistence, storageQuota } from '../lib/offline/db';
import { syncProgress } from '../lib/offline/sync';
import {
  dirtyRecords,
  lastReadBook,
  progressLabel,
  useLocalLibrary,
} from '../lib/offline/useLibrary';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export default function HomePage() {
  const navigate = useNavigate();
  const [server] = useState(() => getActiveServer());
  const library = useLocalLibrary();
  const [quota, setQuota] = useState<{ used: number; quota: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');

  const readQuota = useCallback(() => {
    storageQuota()
      .then(setQuota)
      .catch(() => setQuota(null));
  }, []);

  useEffect(() => {
    readQuota();
    // 不申请持久化,系统清理存储时离线书会整本消失
    void ensurePersistence().then(readQuota);
  }, [readQuota]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setNotice('');
    try {
      const result = await syncProgress();
      setNotice(
        result.pushed || result.pulled
          ? `已回传 ${result.pushed} 条，取回 ${result.pulled} 条进度`
          : '阅读进度已是最新',
      );
      if (result.failed) setNotice(`有 ${result.failed} 条进度没送出去，连上电脑再试`);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setSyncing(false);
      readQuota();
    }
  }, [readQuota]);

  // 连上电脑就把上次没送出去的进度补上,顺手取回电脑上的进度(换手机/重装能接读)
  useEffect(() => {
    if (!server) return;
    void sync();
  }, [server, sync]);

  const recent = lastReadBook(library);
  const dirty = dirtyRecords(library);
  const shelfCount = library.books.length;
  const novelCount = library.books.filter((book) => book.kind === 'novel').length;
  const comicCount = shelfCount - novelCount;

  return (
    <div className="home-page">
      <header className="home-header">
        <div>
          <button
            type="button"
            className={`home-status${server ? '' : ' is-offline'}`}
            onClick={() => navigate(server ? '/settings' : '/connect')}
          >
            <span className="status-dot" />
            {server ? server.name : '未连接电脑'}
            <ChevronRight size={13} />
          </button>
          <h1>{greeting()}</h1>
          <p>{server ? '电脑上的书，可以直接读，也能存到手机' : '手机里的书，不联网也能读'}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新本地书库"
          disabled={library.loading}
          onClick={library.reload}
        >
          {library.loading ? <Loader2 size={20} className="spin" /> : <RefreshCw size={20} />}
        </button>
      </header>

      {recent && (
        <button
          type="button"
          className="continue-card"
          aria-label={`继续阅读 ${recent.book.title}`}
          onClick={() => navigate(localReaderHref(recent.book))}
        >
          <div className="continue-card__glow" />
          <div className="continue-card__cover">
            <BookCover book={recent.book} />
          </div>
          <div className="continue-card__main">
            <span className="continue-card__label">继续阅读</span>
            <strong>{recent.book.title}</strong>
            <span className="continue-card__meta">
              {progressLabel(recent.book, recent.record)}
              {recent.record.total
                ? ` / 共 ${recent.record.total} ${recent.book.kind === 'comic' ? '页' : '章'}`
                : ''}
            </span>
          </div>
          <div className="continue-card__ring">
            <span>{continuousPercent(recent.record)}%</span>
          </div>
        </button>
      )}

      <section className="home-section">
        <div className="home-section__head">
          <h2>
            <LibraryBig size={17} />
            本地书架
          </h2>
          <button type="button" className="text-btn" onClick={() => navigate('/shelf')}>
            全部 {shelfCount} 本
          </button>
        </div>
        {library.loading ? (
          <div className="library-loading">
            <Loader2 size={22} className="spin" />
            <span>正在读取本地书库…</span>
          </div>
        ) : shelfCount === 0 ? (
          <div className="home-empty">
            <WifiOff size={22} />
            <h3>手机里还没有书</h3>
            <p>连上电脑，把想离线读的小说或漫画「下载到手机」。</p>
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={() => navigate(server ? '/library' : '/connect')}
            >
              {server ? '去电脑书库下载' : '连接电脑'}
            </button>
          </div>
        ) : (
          <div className="shelf-strip">
            {library.books.slice(0, 8).map((book) => (
              <button
                type="button"
                key={book.id}
                className="shelf-strip__item"
                onClick={() => navigate(localReaderHref(book))}
              >
                <BookCover book={book} />
                <span>{book.title}</span>
              </button>
            ))}
            <button
              type="button"
              className="shelf-strip__add"
              onClick={() => navigate(server ? '/library' : '/connect')}
            >
              <span className="shelf-strip__add-icon">
                <Plus size={20} />
              </span>
              <span className="shelf-strip__add-label">
                {server ? '下载新书' : '连接电脑'}
              </span>
            </button>
          </div>
        )}
      </section>

      <section className="home-stats">
        <button type="button" className="home-stat" onClick={() => navigate('/shelf')}>
          <BookOpen size={18} />
          <b>{novelCount}</b>
          <span>本离线小说</span>
        </button>
        <button type="button" className="home-stat" onClick={() => navigate('/shelf?kind=comic')}>
          <Images size={18} />
          <b>{comicCount}</b>
          <span>本离线漫画</span>
        </button>
        <div className="home-stat">
          <HardDrive size={18} />
          <b>{formatSize(library.bytes)}</b>
          <span>离线占用</span>
        </div>
      </section>

      {quota && (
        <p className="home-storage">
          <HardDrive size={12} />
          本机存储已用 {formatSize(quota.used)}
        </p>
      )}

      {server && (
        <section className="home-sync">
          <div className="home-sync__text">
            <b>
              <CloudUpload size={15} />
              阅读进度
            </b>
            <span>
              {syncing
                ? '正在同步…'
                : notice
                  ? notice
                  : dirty.length
                    ? `${dirty.length} 条进度还没回传电脑`
                    : '进度已全部同步到电脑'}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            立即同步
          </button>
        </section>
      )}
    </div>
  );
}
