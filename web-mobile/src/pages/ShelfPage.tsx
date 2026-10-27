import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  Images,
  LibraryBig,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  WifiOff,
} from 'lucide-react';
import BookCover from '../components/BookCover';
import { DownloadButton, LocalChip } from '../components/OfflineControls';
import { getActiveServer } from '../lib/connection';
import { deleteLocalBook, localBookHref } from '../lib/content';
import { errorMessage, formatDate, formatSize, percent } from '../lib/format';
import { fetchCatalog, isOutdated } from '../lib/offline/transfer';
import {
  dirtyRecords,
  progressLabel,
  useLocalLibrary,
  announceLibraryChange,
} from '../lib/offline/useLibrary';
import type { LocalBook } from '../lib/offline/db';

type ShelfFilter = 'all' | 'novel' | 'comic';

export default function ShelfPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const server = getActiveServer();
  const library = useLocalLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ShelfFilter>(
    params.get('kind') === 'comic' ? 'comic' : 'all',
  );
  const [outdated, setOutdated] = useState<Record<string, boolean>>({});
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState('');

  const books = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return library.books.filter((book) => {
      if (filter !== 'all' && book.kind !== filter) return false;
      return !keyword || book.title.toLowerCase().includes(keyword) || book.file.toLowerCase().includes(keyword);
    });
  }, [filter, library.books, query]);

  const checkUpdates = async () => {
    setChecking(true);
    setNotice('');
    try {
      const data = await fetchCatalog();
      const entries = new Map<string, { mtime: number; size: number }>([
        ...data.novels.map((item) => [item.id, item] as const),
        ...data.comics.map((item) => [item.id, item] as const),
      ]);
      const next: Record<string, boolean> = {};
      let missing = 0;
      for (const book of library.books) {
        const entry = entries.get(book.id);
        if (!entry) {
          missing += 1;
          continue;
        }
        if (isOutdated(book, entry)) next[book.id] = true;
      }
      setOutdated(next);
      const count = Object.keys(next).length;
      setNotice(
        count
          ? `${count} 本有更新`
          : `本地内容都是最新${missing ? `，${missing} 本已不在电脑上` : ''}`,
      );
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };

  const remove = async (book: LocalBook) => {
    const detail =
      book.kind === 'comic' ? `${book.total} 页` : `${book.total} 章`;
    if (
      !window.confirm(
        `从手机删除《${book.title}》？\n离线包（${formatSize(book.size)} · ${detail}）会一起清掉，电脑上的原书不受影响。`,
      )
    ) {
      return;
    }
    setRemoving(book.id);
    try {
      await deleteLocalBook(book);
      announceLibraryChange();
      setNotice(`已从手机删除《${book.title}》。`);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setRemoving('');
    }
  };

  return (
    <div className="shelf-page">
      <header className="shelf-header">
        <div>
          <div className="library-header__eyebrow">
            <WifiOff size={13} /> 不联网可读
          </div>
          <h1>本地书架</h1>
          <p>{library.loading ? '正在读取…' : `${library.books.length} 本 · 占用 ${formatSize(library.bytes)}`}</p>
        </div>
        {server && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={checking}
            onClick={() => void checkUpdates()}
          >
            {checking ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            检查更新
          </button>
        )}
      </header>

      {notice && (
        <div className="banner banner--info">
          <span>{notice}</span>
          <button type="button" className="text-btn" onClick={() => setNotice('')}>
            知道了
          </button>
        </div>
      )}

      <div className="search-row">
        <Search size={18} />
        <input
          type="search"
          placeholder="搜索手机里的书"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="segmented" role="tablist" aria-label="内容类型">
        {(
          [
            { id: 'all' as ShelfFilter, label: '全部', icon: null },
            { id: 'novel' as ShelfFilter, label: '小说', icon: BookOpen },
            { id: 'comic' as ShelfFilter, label: '漫画', icon: Images },
          ]
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={filter === item.id ? 'is-active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {Icon && <Icon size={17} />} {item.label}
              <em>
                {item.id === 'all'
                  ? library.books.length
                  : library.books.filter((book) => book.kind === item.id).length}
              </em>
            </button>
          );
        })}
      </div>

      {library.loading ? (
        <div className="library-loading">
          <Loader2 size={26} className="spin" />
          <span>正在读取本地书库…</span>
        </div>
      ) : books.length === 0 ? (
        <div className="empty-state">
          <LibraryBig size={34} />
          <h3>{query || filter !== 'all' ? '没有匹配的书' : '手机里还没有书'}</h3>
          <p>
            {query || filter !== 'all'
              ? '换个关键词或类型。'
              : '连上电脑，在「电脑」页把想离线读的书下载到手机。'}
          </p>
          {!server && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate('/connect')}
            >
              连接电脑
            </button>
          )}
        </div>
      ) : (
        <div className="shelf-list">
          {books.map((book) => {
            const record = library.progress[book.id];
            const scale = record?.total ? percent(record.ch, record.total) : 0;
            const dirty = Boolean(record?.dirty);
            return (
              <div className="shelf-row" key={book.id}>
                <button
                  type="button"
                  className="shelf-row__main"
                  onClick={() => navigate(localBookHref(book))}
                >
                  <BookCover book={book} />
                  <div className="shelf-row__info">
                    <div className="shelf-row__title">
                      <strong>{book.title}</strong>
                    </div>
                    <span className="shelf-row__meta">
                      {book.kind === 'comic'
                        ? `${book.total} 页 · ${formatSize(book.size)}`
                        : `${book.total} 章 · ${formatSize(book.size)}`}
                      {` · ${formatDate(book.importedAt)} 导入`}
                      {dirty && <LocalChip dirty />}
                    </span>
                    {record && (
                      <span className="novel-row__progress">
                        {progressLabel(book, record)}
                        <i style={{ width: `${scale}%` }} />
                      </span>
                    )}
                    {!record && (
                      <span className="shelf-row__hint">还没在这台手机上读过</span>
                    )}
                  </div>
                  <ChevronRight size={18} className="muted" />
                </button>
                <div className="shelf-row__actions">
                  {outdated[book.id] && (
                    <DownloadButton
                      compact
                      outdated
                      local={book}
                      target={
                        book.kind === 'comic'
                          ? { kind: 'comic', file: book.file, title: book.title }
                          : { kind: 'novel', file: book.file }
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    aria-label={`从手机删除 ${book.title}`}
                    disabled={removing === book.id}
                    onClick={() => void remove(book)}
                  >
                    {removing === book.id ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <Trash2 size={16} />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {server && !library.loading && books.length > 0 && (
        <button type="button" className="shelf-more" onClick={() => navigate('/library')}>
          <Plus size={16} />
          去电脑书库下载新书
        </button>
      )}

      {Boolean(dirtyRecords(library).length) && (
        <p className="shelf-footnote">
          {dirtyRecords(library).length} 条进度待回传，连上电脑后会自动同步。
        </p>
      )}
    </div>
  );
}
