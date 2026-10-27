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
  percent,
} from '../lib/format';
import { loadAllProgress } from '../lib/progress';
import { DownloadButton } from '../components/OfflineControls';
import { syncProgress } from '../lib/offline/sync';
import { isOutdated } from '../lib/offline/transfer';
import { useLocalLibrary } from '../lib/offline/useLibrary';
import type { LocalBook } from '../lib/offline/db';
import type { ComicFileGroup, FileEntry } from '../lib/types';

type ShelfTab = 'novel' | 'comic';

function NovelCover({ name, epub }: { name: string; epub: boolean }) {
  return (
    <div className="novel-cover" style={{ background: gradientFor(name) }}>
      <span className="novel-cover__char">{initialOf(name)}</span>
      <span className="novel-cover__format">{epub ? 'EPUB' : 'TXT'}</span>
    </div>
  );
}

function ComicCover({ group }: { group: ComicFileGroup }) {
  const [failed, setFailed] = useState(false);
  const showImage = group.cover_url && !failed;
  return (
    <div
      className="comic-cover"
      style={showImage ? undefined : { background: gradientFor(group.title) }}
    >
      {showImage ? (
        <img
          src={mediaUrl(group.cover_url || '')}
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
  const library = useLocalLibrary();
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
        const [filesData, comicsData] = await Promise.all([
          apiGet<{ files?: FileEntry[] }>('/api/files'),
          apiGet<{ items?: ComicFileGroup[] }>('/api/comic_files'),
        ]);
        setNovels((filesData.files || []).filter((item) => isNovelFile(item.name)));
        setComics(comicsData.items || []);
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
      navigate('/connect', { replace: true });
      return;
    }
    void load();
  }, [load, navigate, server]);

  // 连上电脑就把手机上攒的离线进度送回去
  useEffect(() => {
    if (!server) return;
    void syncProgress();
  }, [server]);

  const progressMap = useMemo(
    () => (server ? loadAllProgress(server.id) : {}),
    [server],
  );

  const recent = useMemo(() => {
    let best: { file: string; chapter: number; total?: number; updated: number } | null = null;
    for (const novel of novels) {
      const progress = progressMap[novel.name];
      if (!progress) continue;
      if (!best || progress.updated > best.updated) {
        best = {
          file: novel.name,
          chapter: progress.chapter,
          total: progress.total,
          updated: progress.updated,
        };
      }
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

  if (!server) return null;

  const disconnected = Boolean(error) && !loading;
  // 首次加载就没连上:别再显示"电脑上还没有小说"误导人
  const offline = disconnected && novels.length === 0 && comics.length === 0;

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <div className="library-header__eyebrow">
            <span className={`status-dot${disconnected ? ' is-offline' : ''}`} />
            {disconnected ? '连接断开' : '已连接'}
          </div>
          <h1>{server.name}</h1>
          <p>{server.baseUrl.replace(/^https?:\/\//, '')}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新书库"
          disabled={refreshing || loading}
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
        <div className="library-loading">
          <Loader2 size={26} className="spin" />
          <span>正在读取书库…</span>
        </div>
      ) : offline ? (
        <div className="library-offline">
          <WifiOff size={30} />
          <h3>连不上电脑</h3>
          <p>{error}</p>
          <button type="button" className="btn btn--ghost" onClick={() => void load()}>
            <RefreshCw size={15} />
            重新连接
          </button>
        </div>
      ) : tab === 'novel' ? (
        <>
          {recent && !keyword && (
            <button
              type="button"
              className="continue-card"
              onClick={() =>
                navigate(`/read/${encodeURIComponent(recent.file)}?ch=${recent.chapter}`)
              }
            >
              <div className="continue-card__glow" />
              <div className="continue-card__main">
                <span className="continue-card__label">继续阅读</span>
                <strong>{displayName(recent.file)}</strong>
                <span className="continue-card__meta">
                  第 {recent.chapter} 章{recent.total ? ` / 共 ${recent.total} 章` : ''}
                </span>
              </div>
              <div className="continue-card__ring">
                <span>{percent(recent.chapter, recent.total || 0)}%</span>
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
                const progress = progressMap[item.name];
                const scale = progress?.total
                  ? percent(progress.chapter, progress.total)
                  : 0;
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
                      <NovelCover name={item.name} epub={/\.epub$/i.test(item.name)} />
                      <div className="novel-row__main">
                        <strong>{displayName(item.name)}</strong>
                        <span className="novel-row__meta">
                          {/\.epub$/i.test(item.name) ? 'EPUB' : 'TXT'} · {formatSize(item.size)}
                          {local ? ' · 已在手机' : ''}
                        </span>
                        {progress && (
                          <span className="novel-row__progress">
                            {progress.chapterTitle || `第 ${progress.chapter} 章`}
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
            const pending =
              pdfs.find((pdf) => !stored[`comic:${item.title}/${pdf}`]) || pdfs[0] || '';
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
                {pending && (
                  <div className="comic-card__foot">
                    {localCount > 0 && (
                      <span className="comic-card__stored">手机 {localCount}/{pdfs.length}</span>
                    )}
                    <DownloadButton
                      compact
                      local={stored[`comic:${item.title}/${pending}`]}
                      target={{ kind: 'comic', file: pending, title: item.title }}
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
        电脑端版本 {server.version || '未知'} · API {server.api}
      </div>
    </div>
  );
}
