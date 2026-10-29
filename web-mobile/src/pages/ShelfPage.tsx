import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  Check,
  ChevronRight,
  Images,
  LibraryBig,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  WifiOff,
} from 'lucide-react';
import BookCover from '../components/BookCover';
import { DownloadButton, LocalChip } from '../components/OfflineControls';
import { getActiveServer } from '../lib/connection';
import { deleteLocalBook, localBookHref, localReaderHref } from '../lib/content';
import { errorMessage, formatDate, formatSize } from '../lib/format';
import { continuousPercent } from '../lib/reading-progress';
import { importLocalFiles } from '../lib/offline/localImport';
import { fetchCatalog, isOutdated } from '../lib/offline/transfer';
import {
  dirtyRecords,
  progressLabel,
  useLocalLibrary,
  announceLibraryChange,
} from '../lib/offline/useLibrary';
import type { LocalBook } from '../lib/offline/db';

type ShelfFilter = 'all' | 'novel' | 'comic';

/** 书架上的一行 = 一本"书";漫画的多话在这里被合并 */
interface ShelfGroup {
  key: string;
  kind: 'novel' | 'comic';
  title: string;
  book: LocalBook;
  books: LocalBook[];
  chapters: number;
  pages: number;
  size: number;
  all?: LocalBook;
}

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
  // 批量删除:选择模式 + 已选的书(key)
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFiles = () => {
    if (importing) return;
    fileInput.current?.click();
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setNotice('');
    setImportNotice('');
    setImporting(files.length > 1 ? `正在导入 ${files.length} 个文件…` : `正在导入《${files[0].name}》…`);
    try {
      const outcome = await importLocalFiles(files, (progress) => {
        setImporting(`${progress.detail}：《${progress.name}》`);
      });
      announceLibraryChange();
      const names = outcome.imported.map((book) => `《${book.title}》`).join('、');
      setImporting('');
      if (outcome.failed.length) {
        setImportNotice(
          `${outcome.imported.length ? `已导入 ${names}；` : ''}${outcome.failed
            .map((item) => `${item.name}：${item.error}`)
            .join('；')}`,
        );
      } else if (names) {
        setImportNotice(`已导入 ${names}，不连电脑也能读。`);
      }
    } catch (cause) {
      setImporting('');
      setImportNotice(errorMessage(cause));
    }
  };

  /**
   * 书架按「书」聚合,不按话。
   * 漫画历史数据是按话导入的(`comic:书名/第1话.pdf`),直接铺开会变成十几本同名书;
   * 这里以书名分组,整本包(`__all__`)优先作为打开入口。
   */
  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const map = new Map<string, ShelfGroup>();
    for (const book of library.books) {
      if (filter !== 'all' && book.kind !== filter) continue;
      if (keyword && !book.title.toLowerCase().includes(keyword) && !book.file.toLowerCase().includes(keyword)) {
        continue;
      }
      const key = book.kind === 'comic' ? `comic:${book.title}` : book.id;
      const found = map.get(key);
      if (!found) {
        map.set(key, {
          key,
          kind: book.kind,
          title: book.title,
          book,
          books: [book],
          chapters: book.kind === 'comic' ? 1 : 0,
          pages: book.kind === 'comic' ? book.total : 0,
          size: book.size,
          all: book.file === '__all__' ? book : undefined,
        });
        continue;
      }
      found.books.push(book);
      found.size += book.size;
      if (book.kind === 'comic') {
        found.pages += book.total;
        found.chapters += 1;
        if (book.file === '__all__') found.all = book;
      }
    }
    return Array.from(map.values());
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

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 删一台手机上的「一本书」= 删掉它名下的所有本地包(漫画多话会一起清) */
  const removeGroup = async (group: ShelfGroup) => {
    const detail =
      group.kind === 'comic'
        ? `${group.chapters} 话 · ${group.pages} 页`
        : `${group.book.total} 章`;
    const extra = group.chapters > 1 ? `（共 ${group.chapters} 个离线包）` : '';
    if (
      !window.confirm(
        `从手机删除《${group.title}》？\n占用 ${formatSize(group.size)} · ${detail}${extra}\n电脑上的原书不受影响。`,
      )
    ) {
      return;
    }
    setRemoving(group.key);
    try {
      for (const book of group.books) await deleteLocalBook(book);
      announceLibraryChange();
      setNotice(`已从手机删除《${group.title}》。`);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setRemoving('');
    }
  };

  /** 批量删除:一次清掉选中的书,省得一本本点 */
  const removeSelected = async () => {
    const targets = groups.filter((group) => selected.has(group.key));
    if (!targets.length) return;
    const books = targets.reduce((sum, group) => sum + group.books.length, 0);
    const bytes = targets.reduce((sum, group) => sum + group.size, 0);
    if (
      !window.confirm(
        `删除选中的 ${targets.length} 本（共 ${books} 个离线包，${formatSize(bytes)}）？\n删除后需重新从电脑下载，电脑上的原书不受影响。`,
      )
    ) {
      return;
    }
    setRemoving('__bulk__');
    try {
      for (const group of targets) {
        for (const book of group.books) await deleteLocalBook(book);
      }
      announceLibraryChange();
      setNotice(`已删除 ${targets.length} 本，释放 ${formatSize(bytes)}。`);
      setSelected(new Set());
      setSelecting(false);
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
        <div className="shelf-header__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSelecting((prev) => !prev);
              setSelected(new Set());
            }}
          >
            {selecting ? '取消' : '选择'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={Boolean(importing)}
            onClick={pickFiles}
          >
            {importing ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
            导入
          </button>
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
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".epub,.txt,.zip,application/epub+zip,text/plain,application/zip"
        multiple
        hidden
        onChange={(event) => void handleFiles(event)}
      />

      {importing && (
        <div className="banner banner--info">
          <span className="banner__inline">
            <Loader2 size={14} className="spin" /> {importing}
          </span>
        </div>
      )}

      {importNotice && (
        <div className="banner banner--info">
          <span>{importNotice}</span>
          <button type="button" className="text-btn" onClick={() => setImportNotice('')}>
            知道了
          </button>
        </div>
      )}

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
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <LibraryBig size={34} />
          <h3>{query || filter !== 'all' ? '没有匹配的书' : '手机里还没有书'}</h3>
          <p>
            {query || filter !== 'all'
              ? '换个关键词或类型。'
              : '可以把手机里的 EPUB / TXT 导进来，也能连电脑下载书库里的书。'}
          </p>
          <div className="empty-state__actions">
            <button type="button" className="btn btn--primary" onClick={pickFiles}>
              <Upload size={16} />
              导入本地文件
            </button>
            {!server && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => navigate('/connect')}
              >
                连接电脑
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="shelf-list">
          {groups.map((group) => {
            const opened = group.all || group.book;
            const record = group.books
              .map((item) => library.progress[item.id])
              .filter(Boolean)
              .sort((a, b) => (b!.ts || 0) - (a!.ts || 0))[0];
            const scale = record ? continuousPercent(record) : 0;
            const dirty = Boolean(record?.dirty);
            const hasOutdated = group.books.some((item) => outdated[item.id]);
            const checked = selected.has(group.key);
            return (
              <div className={checked ? 'shelf-row is-checked' : 'shelf-row'} key={group.key}>
                {selecting && (
                  <button
                    type="button"
                    className={checked ? 'shelf-check is-on' : 'shelf-check'}
                    aria-label={checked ? '取消选择' : '选择'}
                    onClick={() => toggleSelect(group.key)}
                  >
                    {checked && <Check size={14} />}
                  </button>
                )}
                <button
                  type="button"
                  className="shelf-row__main"
                  onClick={() => {
                    if (selecting) {
                      toggleSelect(group.key);
                      return;
                    }
                    // 整本包直接进阅读器;只有逐话数据时进详情页(可继续下载整本)
                    if (group.kind === 'comic' && group.all) {
                      navigate(localReaderHref(group.all));
                      return;
                    }
                    navigate(localBookHref(opened));
                  }}
                >
                  <BookCover book={opened} />
                  <div className="shelf-row__info">
                    <div className="shelf-row__title">
                      <strong>{group.title}</strong>
                      {group.kind === 'comic' && group.chapters > 1 && !group.all && (
                        <em className="shelf-row__flag">逐话导入</em>
                      )}
                    </div>
                    <span className="shelf-row__meta">
                      {group.kind === 'comic'
                        ? `${group.chapters} 话 · ${group.pages} 页 · ${formatSize(group.size)}`
                        : `${opened.total} 章 · ${formatSize(group.size)}`}
                      {` · ${formatDate(opened.importedAt)} 导入`}
                      {opened.origin === 'import' &&
                        ` · ${opened.syncState === 'pending' ? '本地文件·待传电脑' : '本地文件'}`}
                      {dirty && <LocalChip dirty />}
                    </span>
                    {record && (
                      <span className="novel-row__progress">
                        {progressLabel(opened, record)} · 总进度 {scale}%
                        <i style={{ width: `${scale}%` }} />
                      </span>
                    )}
                    {!record && (
                      <span className="shelf-row__hint">还没在这台手机上读过</span>
                    )}
                  </div>
                  <ChevronRight size={18} className="muted" />
                </button>
                {!selecting && (
                  <div className="shelf-row__actions">
                    {hasOutdated && (
                      <DownloadButton
                        compact
                        outdated
                        local={opened}
                        target={
                          group.kind === 'comic'
                            ? { kind: 'comic', file: '', title: group.title, all: true }
                            : { kind: 'novel', file: opened.file }
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      aria-label={`从手机删除 ${group.title}`}
                      disabled={removing === group.key}
                      onClick={() => void removeGroup(group)}
                    >
                      {removing === group.key ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selecting && (
        <div className="shelf-bulk">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              setSelected(
                selected.size === groups.length ? new Set() : new Set(groups.map((group) => group.key)),
              )
            }
          >
            {selected.size === groups.length ? '取消全选' : '全选'}
          </button>
          <span className="shelf-bulk__count">已选 {selected.size} / {groups.length}</span>
          <button
            type="button"
            className="btn btn--sm shelf-bulk__danger"
            disabled={selected.size === 0 || removing === '__bulk__'}
            onClick={() => void removeSelected()}
          >
            {removing === '__bulk__' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            删除所选
          </button>
        </div>
      )}

      {!library.loading && groups.length > 0 && (
        <button
          type="button"
          className="shelf-more"
          disabled={Boolean(importing)}
          onClick={pickFiles}
        >
          {importing ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
          从手机导入 EPUB / TXT / 离线 ZIP
        </button>
      )}

      {server && !library.loading && groups.length > 0 && (
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
