import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  Images,
  Loader2,
  RefreshCw,
  Search,
  Server,
  WifiOff,
} from 'lucide-react';
import { apiGet, mediaUrl } from '../lib/api';
import { getActiveServer, touchServer } from '../lib/connection';
import {
  displayName,
  errorMessage,
  formatSize,
  gradientFor,
  initialOf,
  isNovelFile,
} from '../lib/format';
import { loadAllProgress } from '../lib/progress';
import {
  fetchSharedProgress,
  fromLegacyProgress,
  type SharedProgressRecord,
} from '../lib/reading-progress';
import { DownloadButton } from '../components/OfflineControls';
import SkeletonList from '../components/SkeletonList';
import { syncProgress } from '../lib/offline/sync';
import { isOutdated } from '../lib/offline/transfer';
import { useScrollMemory } from '../lib/useScrollMemory';
import { useLocalLibrary } from '../lib/offline/useLibrary';
import type { LocalBook } from '../lib/offline/db';
import type { ComicFileGroup, FileEntry } from '../lib/types';

type ShelfTab = 'novel' | 'comic';

function NovelCover({
  name,
  epub,
  coverUrl,
}: {
  name: string;
  epub: boolean;
  coverUrl?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cover = coverUrl ? mediaUrl(coverUrl) : '';
  const showImage = Boolean(cover) && !failed;
  return (
    <div
      className="novel-cover"
      style={showImage ? undefined : { background: gradientFor(name) }}
    >
      {showImage ? (
        <img src={cover} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <>
          <span className="novel-cover__char">{initialOf(name)}</span>
          <span className="novel-cover__format">{epub ? 'EPUB' : 'TXT'}</span>
        </>
      )}
    </div>
  );
}

function ComicCover({ group }: { group: ComicFileGroup }) {
  const [failed, setFailed] = useState(false);
  const cover = group.cover_url ? mediaUrl(group.cover_url) : '';
  const showImage = Boolean(cover) && !failed;
  return (
    <div
      className="comic-cover"
      style={showImage ? undefined : { background: gradientFor(group.title) }}
    >
      {showImage ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{initialOf(group.title)}</span>
      )}
    </div>
  );
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [server] = useState(() => getActiveServer());
  const [tab, setTab] = useState<ShelfTab>('novel');
  const [novels, setNovels] = useState<FileEntry[]>([]);
  const [comics, setComics] = useState<ComicFileGroup[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [progressMap, setProgressMap] = useState<Record<string, SharedProgressRecord>>({});
  const library = useLocalLibrary();
  useScrollMemory(`library:${tab}`, !loading);
  const stored = useMemo(() => {
    const map: Record<string, LocalBook> = {};
    for (const book of library.books) map[book.id] = book;
    return map;
  }, [library.books]);

  const load = useCallback(
    async (background = false) => {
      if (!server) return;
      if (background) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const [filesData, comicsData, records] = await Promise.all([
          apiGet<{ files?: FileEntry[] }>('/api/files'),
          apiGet<{ items?: ComicFileGroup[] }>('/api/comic_files'),
          // 共享进度取不到(旧电脑/断网)时退回手机本地缓存
          fetchSharedProgress().catch(() => {
            const legacy = loadAllProgress(server.id);
            const fallback: Record<string, SharedProgressRecord> = {};
            for (const [file, record] of Object.entries(legacy)) {
              const book = `novel:${file}`;
              fallback[book] = fromLegacyProgress(book, record);
            }
            return fallback;
          }),
        ]);
        setNovels((filesData.files || []).filter((item) => isNovelFile(item.name)));
        setComics(comicsData.items || []);
        setProgressMap(records);
        touchServer(server.id);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [server],
  );

  useEffect(() => {
    if (!server) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, server]);

  // 连上电脑就把手机上攒的离线进度送回去
  useEffect(() => {
    if (!server) return;
    void syncProgress();
  }, [server]);

  const recent = useMemo(() => {
    let best: { file: string; record: SharedProgressRecord } | null = null;
    for (const novel of novels) {
      const record = progressMap[`novel:${novel.name}`];
      if (!record || !record.ch) continue;
      if (!best || record.updated > best.record.updated) best = { file: novel.name, record };
    }
    return best;
  }, [novels, progressMap]);

  const keyword = query.trim().toLowerCase();
  const visibleNovels = useMemo(
    () => novels.filter((item) => displayName(item.name).toLowerCase().includes(keyword)),
    [novels, keyword],
  );
  const visibleComics = useMemo(
    () => comics.filter((item) => item.title.toLowerCase().includes(keyword)),
    [comics, keyword],
  );

  const disconnected = !server || (Boolean(error) && !loading);
  // 首次加载就没连上:别再显示"电脑上还没有小说"误导人
  const offline = disconnected && novels.length === 0 && comics.length === 0;

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <div className="library-header__eyebrow">
            <span className={`status-dot${disconnected ? ' is-offline' : ''}`} />
            {!server ? '未连接电脑' : disconnected ? '连接断开' : '已连接'}
          </div>
          <h1>{server?.name || '电脑书库'}</h1>
          <p>{server ? server.baseUrl.replace(/^https?:\/\//, '') : '连接电脑后可下载新书'}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新书库"
          disabled={!server || refreshing || loading}
          onClick={() => void load(true)}
        >
          {refreshing ? <Loader2 size={20} className="spin" /> : <RefreshCw size={20} />}
        </button>
      </header>

      {!offline && (
        <>
          <div className="search-row">
            <Search size={18} />
            <input
              type="search"
              placeholder="搜索书名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="segmented" role="tablist" aria-label="书库类型">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'novel'}
              className={tab === 'novel' ? 'is-active' : ''}
              onClick={() => setTab('novel')}
            >
              <BookOpen size={17} /> 小说 <em>{novels.length}</em>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'comic'}
              className={tab === 'comic' ? 'is-active' : ''}
              onClick={() => setTab('comic')}
            >
              <Images size={17} /> 漫画 <em>{comics.length}</em>
            </button>
          </div>
        </>
      )}

      {error && !offline && (
        <div className="banner banner--error">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : offline ? (
        <div className="library-offline">
          <WifiOff size={30} />
          <h3>{server ? '连不上电脑' : '还没连接电脑'}</h3>
          <p>{server ? error : '连接电脑后可以挑选书库里的书下载到手机，已下载的书仍然可以离线阅读。'}</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => (server ? void load() : navigate('/connect'))}
          >
            {server ? <RefreshCw size={15} /> : <Server size={15} />}
            {server ? '重新连接' : '连接电脑'}
          </button>
        </div>
      ) : tab === 'novel' ? (
        <>
          {recent && !keyword && (
            <button
              type="button"
              className="continue-card"
              onClick={() =>
                navigate(`/read/${encodeURIComponent(recent.file)}?ch=${recent.record.ch}`)
              }
            >
              <div className="continue-card__glow" />
              <div className="continue-card__main">
                <span className="continue-card__label">继续阅读</span>
                <strong>{displayName(recent.file)}</strong>
                <span className="continue-card__meta">
                  第 {recent.record.ch} 章
                  {recent.record.total ? ` / 共 ${recent.record.total} 章` : ''}
                  {` · 总进度 ${recent.record.percent}%`}
                </span>
              </div>
              <div className="continue-card__ring">
                <span>{recent.record.percent}%</span>
              </div>
            </button>
          )}

          {visibleNovels.length === 0 ? (
            <div className="empty-state">
              <BookOpen size={34} />
              <h3>{keyword ? '没有匹配的书' : '电脑上还没有小说'}</h3>
              <p>
                {keyword
                  ? '换个关键词试试。'
                  : '在电脑端搜索并下载 TXT/EPUB 后，点右上角刷新。'}
              </p>
            </div>
          ) : (
            <div className="novel-list">
              {visibleNovels.map((item) => {
                const progress = progressMap[`novel:${item.name}`];
                const scale = progress?.percent || 0;
                const local = stored[`novel:${item.name}`];
                return (
                  <div className="shelf-row" key={item.name}>
                    <button
                      type="button"
                      className="shelf-row__main"
                      onClick={() =>
                        navigate(`/book/${encodeURIComponent(item.name)}?kind=novel`)
                      }
                    >
                      <NovelCover
                        name={item.name}
                        epub={/\.epub$/i.test(item.name)}
                        coverUrl={item.cover_url}
                      />
                      <div className="novel-row__main">
                        <strong>{displayName(item.name)}</strong>
                        <span className="novel-row__meta">
                          {/\.epub$/i.test(item.name) ? 'EPUB' : 'TXT'} · {formatSize(item.size)}
                          {local ? ' · 已在手机' : ''}
                        </span>
                        {progress && (
                          <span className="novel-row__progress">
                            {progress.chapterTitle || `第 ${progress.ch} 章`}
                            {` · 总进度 ${progress.percent}%`}
                            <i style={{ width: `${scale}%` }} />
                          </span>
                        )}
                      </div>
                      <ChevronRight size={18} className="muted" />
                    </button>
                    <div className="shelf-row__actions">
                      <DownloadButton
                        compact
                        local={local}
                        outdated={Boolean(
                          local && isOutdated(local, { mtime: 0, size: item.size }),
                        )}
                        target={{ kind: 'novel', file: item.name }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : visibleComics.length === 0 ? (
        <div className="empty-state">
          <Images size={34} />
          <h3>{keyword ? '没有匹配的漫画' : '电脑上还没有漫画'}</h3>
          <p>
            {keyword ? '换个关键词试试。' : '在电脑端下载漫画 PDF 后，点右上角刷新。'}
          </p>
        </div>
      ) : (
        <div className="comic-grid">
          {visibleComics.map((item) => {
            const pdfs = item.pdfs || [];
            const localCount = pdfs.filter(
              (pdf) => stored[`comic:${item.title}/${pdf}`],
            ).length;
            return (
              <div className="comic-card" key={item.title}>
                <button
                  type="button"
                  className="comic-card__open"
                  onClick={() => navigate(`/book/${encodeURIComponent(item.title)}?kind=comic`)}
                >
                  <ComicCover group={item} />
                  <strong>{item.title}</strong>
                  <span>
                    {item.files} 个文件 · {formatSize(item.size)}
                  </span>
                </button>
                {(
                  <div className="comic-card__foot">
                    {localCount > 0 && (
                      <span className="comic-card__stored">逐话 {localCount}/{pdfs.length}</span>
                    )}
                    {/* 整本下载:一次把这本书所有话打包,不用逐话点 */}
                    <DownloadButton
                      compact
                      local={stored[`comic:${item.title}/__all__`]}
                      label={`整本 (${pdfs.length} 话)`}
                      target={{ kind: 'comic', file: '', title: item.title, all: true }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="library-footnote">
        <Server size={14} />
        {server
          ? `电脑端版本 ${server.version || '未知'} · API ${server.api}`
          : '离线模式 · 只能阅读已下载到手机的书'}
      </div>
    </div>
  );
}
