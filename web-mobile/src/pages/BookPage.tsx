import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, FileText, Images, Loader2, Play, Search } from 'lucide-react';
import { apiGet } from '../lib/api';
import { errorMessage, gradientFor, initialOf, percent } from '../lib/format';
import BookCover from '../components/BookCover';
import { DownloadButton, LocalChip } from '../components/OfflineControls';
import {
  localComicSource,
  localNovelSource,
  onlineComicSource,
  onlineNovelSource,
  type ComicSource,
  type NovelSource,
} from '../lib/content';
import { useLocalLibrary } from '../lib/offline/useLibrary';
import type { LocalBook } from '../lib/offline/db';
import type { ImportTarget } from '../lib/offline/transfer';
import type { ChapterRef, ComicPdfMeta, NovelMeta } from '../lib/types';

function chapterLabel(chapter: ChapterRef): string {
  const title = chapter.title || `第 ${chapter.idx} 章`;
  return chapter.volume ? `${chapter.volume} · ${title}` : title;
}

function Loading({ text }: { text: string }) {
  return (
    <div className="library-loading">
      <Loader2 size={24} className="spin" />
      <span>{text}</span>
    </div>
  );
}

function DetailTop({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <header className="detail-top">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="返回书架">
        <ArrowLeft size={22} />
      </button>
      <span>{label}</span>
      <span className="detail-top__spacer" />
    </header>
  );
}

function Shell({ label, onBack, children }: { label: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="detail-page">
      <DetailTop label={label} onBack={onBack} />
      {children}
    </div>
  );
}

function Notice({ title, text, onBack }: { title: string; text: string; onBack: () => void }) {
  return (
    <Shell label="内容详情" onBack={onBack}>
      <div className="empty-state">
        <BookOpen size={34} />
        <h3>{title}</h3>
        <p>{text}</p>
        <button type="button" className="btn btn--primary" onClick={onBack}>
          返回
        </button>
      </div>
    </Shell>
  );
}

function NovelDetail({
  source,
  target,
  local,
  onBack,
}: {
  source: NovelSource;
  /** 在线书才有"下载到手机";本地内容传 null */
  target: ImportTarget | null;
  local?: LocalBook;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<NovelMeta | null>(null);
  const [current, setCurrent] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([source.loadMeta(), source.loadProgress()])
      .then(([data, saved]) => {
        if (cancelled) return;
        const chapters = data.chapters || [];
        setMeta({ ...data, chapters });
        setCurrent(Math.min(Math.max(1, saved?.ch || 1), Math.max(1, chapters.length)));
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const chapters = meta?.chapters || [];
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return chapters;
    return chapters.filter((item) => chapterLabel(item).toLowerCase().includes(keyword));
  }, [chapters, query]);
  const visible = filtered.slice(0, limit);

  return (
    <Shell
      label={source.mode === 'local' ? '手机里的小说' : source.epub ? 'EPUB 小说' : 'TXT 小说'}
      onBack={onBack}
    >
      <section className="detail-hero">
        {local ? (
          <BookCover book={local} />
        ) : (
          <div className="detail-cover" style={{ background: gradientFor(source.title) }}>
            <span>{initialOf(source.title)}</span>
            <em>{source.epub ? 'EPUB' : 'TXT'}</em>
          </div>
        )}
        <div className="detail-info">
          <h1>{source.title}</h1>
          <p className="detail-info__row">
            <span>{loading ? '正在解析…' : `${chapters.length} 章`}</span>
            {local && <LocalChip />}
          </p>
          <button
            type="button"
            className="btn btn--primary detail-read-btn"
            disabled={loading || chapters.length === 0}
            onClick={() => navigate(source.readerHref(current))}
          >
            <Play size={17} />
            {current > 1 ? `继续阅读 第 ${current} 章` : '开始阅读'}
          </button>
          {target && <DownloadButton compact target={target} local={local} />}
        </div>
      </section>

      {error && <div className="banner banner--error">{error}</div>}

      <div className="detail-section-heading">
        <h2>目录</h2>
        <span>{chapters.length} 章</span>
      </div>

      <div className="search-row search-row--compact">
        <Search size={17} />
        <input
          type="search"
          placeholder="搜索章节"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(200);
          }}
        />
      </div>

      {loading ? (
        <Loading text="正在读取目录…" />
      ) : visible.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <BookOpen size={28} />
          <p>{query ? '没有匹配的章节' : '这本书没有可读章节'}</p>
        </div>
      ) : (
        <>
          <div className="chapter-list">
            {visible.map((chapter) => {
              const active = chapter.idx === current;
              return (
                <button
                  type="button"
                  key={`${chapter.idx}-${chapter.title}`}
                  className={`chapter-row${active ? ' is-current' : ''}`}
                  onClick={() => navigate(source.readerHref(chapter.idx))}
                >
                  <span className="chapter-row__idx">{chapter.idx}</span>
                  <span className="chapter-row__title">{chapterLabel(chapter)}</span>
                  {active && <span className="chapter-row__badge">当前</span>}
                </button>
              );
            })}
          </div>
          {filtered.length > visible.length && (
            <button type="button" className="load-more" onClick={() => setLimit(limit + 300)}>
              加载更多（还有 {filtered.length - visible.length} 章）
            </button>
          )}
        </>
      )}
    </Shell>
  );
}

function ComicDetail({
  source,
  download,
  local,
  localBooks,
  onBack,
}: {
  source: ComicSource;
  /** 每个 PDF 各自的下载目标;本地内容传 null */
  download: ((file: string) => ImportTarget) | null;
  local?: LocalBook;
  localBooks: LocalBook[];
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [totalMap, setTotalMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const files = source.files;

  // 一本漫画可能有多个 PDF,各自的阅读进度分开记
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const progress: Record<string, number> = {};
    const totals: Record<string, number> = {};
    Promise.all(
      files.map(async (file) => {
        const saved = await source.loadProgress(file);
        if (!saved) return;
        if (saved.ch) progress[file] = saved.ch;
        if (saved.total) totals[file] = saved.total;
      }),
    )
      .then(() => {
        if (cancelled) return;
        setProgressMap(progress);
        setTotalMap(totals);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [files, source]);

  const stored = useMemo(() => {
    const map: Record<string, LocalBook> = {};
    for (const book of localBooks) {
      if (book.kind === 'comic') map[`comic:${book.title}/${book.file}`] = book;
    }
    return map;
  }, [localBooks]);

  const recentFile = files.find((file) => progressMap[file]);
  const recentPage = recentFile ? progressMap[recentFile] : 0;

  return (
    <Shell label={source.mode === 'local' ? '手机里的漫画' : '漫画'} onBack={onBack}>
      <section className="detail-hero">
        {local ? (
          <BookCover book={local} />
        ) : (
          <div className="detail-cover detail-cover--comic" style={{ background: gradientFor(source.title) }}>
            <span>{initialOf(source.title)}</span>
          </div>
        )}
        <div className="detail-info">
          <h1>{source.title}</h1>
          <p className="detail-info__row">
            <span>{loading ? '正在读取…' : `${files.length} 个 PDF`}</span>
            {local && <LocalChip />}
          </p>
          {recentPage > 0 && (
            <button
              type="button"
              className="btn btn--primary detail-read-btn"
              onClick={() => navigate(source.readerHref(recentFile || files[0], recentPage))}
            >
              <Play size={17} />
              继续阅读 第 {recentPage} 页
            </button>
          )}
        </div>
      </section>

      {error && <div className="banner banner--error">{error}</div>}

      <div className="detail-section-heading">
        <h2>阅读顺序</h2>
        <span>{files.length} 个文件</span>
      </div>

      {loading ? (
        <Loading text="正在读取漫画…" />
      ) : files.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <Images size={28} />
          <p>没有找到可阅读的 PDF</p>
        </div>
      ) : (
        <div className="chapter-list">
          {files.map((pdf, index) => {
            const page = progressMap[pdf] || 0;
            const total = totalMap[pdf] || 0;
            const mine = local || stored[`comic:${source.title}/${pdf}`];
            return (
              <div className="chapter-row chapter-row--split" key={pdf}>
                <button
                  type="button"
                  className="chapter-row__open"
                  onClick={() => navigate(source.readerHref(pdf, page || 1))}
                >
                  <span className="chapter-row__idx">{index + 1}</span>
                  <span className="chapter-row__title">{pdf}</span>
                  {page > 0 && (
                    <span className="chapter-row__badge">
                      {total ? `${percent(page, total)}%` : '已读'}
                    </span>
                  )}
                  <FileText size={16} className="muted" />
                </button>
                {download && <DownloadButton compact target={download(pdf)} local={mine} />}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

export default function BookPage() {
  const navigate = useNavigate();
  const { file = '', id = '' } = useParams();
  const [params] = useSearchParams();
  const kind = params.get('kind') || 'novel';
  const library = useLocalLibrary();
  const local = id ? library.books.find((item) => item.id === id) : undefined;
  const [onlineComic, setOnlineComic] = useState<{ source: ComicSource | null; error: string }>({
    source: null,
    error: '',
  });

  const comicTitle = kind === 'comic' && !id ? file : '';
  useEffect(() => {
    if (!comicTitle) return;
    let cancelled = false;
    setOnlineComic({ source: null, error: '' });
    apiGet<ComicPdfMeta>('/api/comic_pdf_meta', { title: comicTitle })
      .then((data) => {
        if (cancelled) return;
        const source = onlineComicSource(comicTitle, data.pdfs || []);
        if (!source) {
          setOnlineComic({ source: null, error: '请先连接电脑' });
          return;
        }
        setOnlineComic({ source, error: '' });
      })
      .catch((cause) => {
        if (!cancelled) setOnlineComic({ source: null, error: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [comicTitle]);

  // 源对象必须稳定:详情页取数以它为依赖,每次渲染都新建会无限重读
  const localSource = useMemo(() => {
    if (!local) return null;
    return local.kind === 'comic'
      ? { kind: 'comic' as const, source: localComicSource(local) }
      : { kind: 'novel' as const, source: localNovelSource(local) };
  }, [local]);
  const remoteNovelSource = useMemo(
    () => (id || kind === 'comic' ? null : onlineNovelSource(file)),
    [file, id, kind],
  );

  if (id) {
    const goBack = () => navigate('/shelf');
    if (library.loading) {
      return (
        <Shell label="内容详情" onBack={goBack}>
          <Loading text="正在读取本地内容…" />
        </Shell>
      );
    }
    if (!local || !localSource) {
      return (
        <Notice
          title="这本书不在手机里"
          text="可能已经从手机删除,在「电脑」页重新下载后可以继续阅读。"
          onBack={goBack}
        />
      );
    }
    return localSource.kind === 'comic' ? (
      <ComicDetail
        source={localSource.source}
        download={null}
        local={local}
        localBooks={library.books}
        onBack={goBack}
      />
    ) : (
      <NovelDetail
        source={localSource.source}
        target={null}
        local={local}
        onBack={goBack}
      />
    );
  }

  const goBack = () => navigate('/library');

  if (kind === 'comic') {
    if (onlineComic.error) {
      return <Notice title="打不开这本漫画" text={onlineComic.error} onBack={goBack} />;
    }
    if (!onlineComic.source) {
      return (
        <Shell label="漫画" onBack={goBack}>
          <Loading text="正在读取漫画…" />
        </Shell>
      );
    }
    return (
      <ComicDetail
        source={onlineComic.source}
        download={(pdf) => ({ kind: 'comic', file: pdf, title: file })}
        localBooks={library.books}
        onBack={goBack}
      />
    );
  }

  if (!remoteNovelSource) {
    return <Notice title="还没连上电脑" text="连上电脑后才能直接读电脑上的书。" onBack={goBack} />;
  }
  const storedNovel = library.books.find((item) => item.id === `novel:${file}`);
  return (
    <NovelDetail
      source={remoteNovelSource}
      target={{ kind: 'novel', file }}
      local={storedNovel}
      onBack={goBack}
    />
  );
}
