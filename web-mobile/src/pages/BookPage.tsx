import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, FileText, Images, Loader2, Play, Search } from 'lucide-react';
import { apiGet, mediaUrl } from '../lib/api';
import { getActiveServer } from '../lib/connection';
import {
  displayName,
  errorMessage,
  gradientFor,
  initialOf,
  isEpub,
  percent,
} from '../lib/format';
import { loadProgress } from '../lib/progress';
import type { ChapterRef, ComicPdfMeta, NovelMeta } from '../lib/types';

function chapterLabel(chapter: ChapterRef): string {
  const title = chapter.title || `第 ${chapter.idx} 章`;
  return chapter.volume ? `${chapter.volume} · ${title}` : title;
}

function NovelDetail({
  file,
  onBack,
}: {
  file: string;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const server = getActiveServer();
  const [meta, setMeta] = useState<NovelMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);
  const epub = isEpub(file);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiGet<NovelMeta>(epub ? '/api/epub_meta' : '/api/read_meta', { file })
      .then((data) => {
        if (cancelled) return;
        setMeta({ ...data, chapters: data.chapters || [] });
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
  }, [epub, file]);

  const chapters = meta?.chapters || [];
  const progress = server ? loadProgress(server.id, file) : null;
  const current = Math.min(Math.max(1, progress?.chapter || 1), Math.max(1, chapters.length));
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return chapters;
    return chapters.filter((item) => chapterLabel(item).toLowerCase().includes(keyword));
  }, [chapters, query]);
  const visible = filtered.slice(0, limit);

  return (
    <div className="detail-page">
      <header className="detail-top">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回书库">
          <ArrowLeft size={22} />
        </button>
        <span>{epub ? 'EPUB 小说' : 'TXT 小说'}</span>
        <span className="detail-top__spacer" />
      </header>

      <section className="detail-hero">
        <div className="detail-cover" style={{ background: gradientFor(file) }}>
          <span>{initialOf(file)}</span>
          <em>{epub ? 'EPUB' : 'TXT'}</em>
        </div>
        <div className="detail-info">
          <h1>{displayName(file)}</h1>
          <p>
            {loading ? '正在解析…' : `${chapters.length} 章`}
            {progress ? ` · 读到第 ${progress.chapter} 章` : ''}
          </p>
          <button
            type="button"
            className="btn btn--primary detail-read-btn"
            disabled={loading || chapters.length === 0}
            onClick={() => navigate(`/read/${encodeURIComponent(file)}?ch=${current}`)}
          >
            <Play size={17} />
            {progress ? `继续阅读 第 ${current} 章` : '开始阅读'}
          </button>
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
        <div className="library-loading">
          <Loader2 size={24} className="spin" />
          <span>正在读取目录…</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <BookOpen size={28} />
          <p>{query ? '没有匹配的章节' : '这本书没有可读章节'}</p>
        </div>
      ) : (
        <>
          <div className="chapter-list">
            {visible.map((chapter) => {
              const active = progress?.chapter === chapter.idx;
              return (
                <button
                  type="button"
                  key={`${chapter.idx}-${chapter.title}`}
                  className={`chapter-row${active ? ' is-current' : ''}`}
                  onClick={() =>
                    navigate(`/read/${encodeURIComponent(file)}?ch=${chapter.idx}`)
                  }
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
    </div>
  );
}

function ComicDetail({ title, onBack }: { title: string; onBack: () => void }) {
  const navigate = useNavigate();
  const server = getActiveServer();
  const [pdfs, setPdfs] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiGet<ComicPdfMeta>('/api/comic_pdf_meta', { title })
      .then((data) => {
        if (cancelled) return;
        setPdfs(data.pdfs || []);
        setMeta(data.meta || null);
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
  }, [title]);

  const recent = useMemo(() => {
    if (!server) return null;
    let best: { pdf: string; page: number; total?: number; updated: number } | null = null;
    for (const pdf of pdfs) {
      const progress = loadProgress(server.id, `comic::${title}::${pdf}`);
      if (!progress) continue;
      if (!best || progress.updated > best.updated) {
        best = { pdf, page: progress.chapter, total: progress.total, updated: progress.updated };
      }
    }
    return best;
  }, [pdfs, server, title]);

  const coverUrl =
    pdfs[0] && !coverFailed
      ? mediaUrl(`/api/comic_cover?title=${encodeURIComponent(title)}&file=${encodeURIComponent(pdfs[0])}`)
      : '';

  return (
    <div className="detail-page">
      <header className="detail-top">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回书库">
          <ArrowLeft size={22} />
        </button>
        <span>漫画</span>
        <span className="detail-top__spacer" />
      </header>

      <section className="detail-hero">
        <div className="detail-cover detail-cover--comic" style={{ background: gradientFor(title) }}>
          {coverUrl ? (
            <img src={coverUrl} alt="" onError={() => setCoverFailed(true)} />
          ) : (
            <span>{initialOf(title)}</span>
          )}
        </div>
        <div className="detail-info">
          <h1>{title}</h1>
          <p>{loading ? '正在读取…' : `${pdfs.length} 个 PDF${meta ? ' · 已打包' : ''}`}</p>
          {recent && (
            <button
              type="button"
              className="btn btn--primary detail-read-btn"
              onClick={() =>
                navigate(
                  `/comic/${encodeURIComponent(title)}?file=${encodeURIComponent(recent?.pdf || '')}&page=${recent?.page || 1}`,
                )
              }
            >
              <Play size={17} />
              继续阅读 第 {recent.page} 页
            </button>
          )}
        </div>
      </section>

      {error && <div className="banner banner--error">{error}</div>}

      <div className="detail-section-heading">
        <h2>阅读顺序</h2>
        <span>{pdfs.length} 个文件</span>
      </div>

      {loading ? (
        <div className="library-loading">
          <Loader2 size={24} className="spin" />
          <span>正在读取漫画…</span>
        </div>
      ) : pdfs.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <Images size={28} />
          <p>没有找到可阅读的 PDF</p>
        </div>
      ) : (
        <div className="chapter-list">
          {pdfs.map((pdf, index) => {
            const progress = server ? loadProgress(server.id, `comic::${title}::${pdf}`) : null;
            return (
              <button
                type="button"
                key={pdf}
                className="chapter-row"
                onClick={() =>
                  navigate(
                    `/comic/${encodeURIComponent(title)}?file=${encodeURIComponent(pdf)}&page=${progress?.chapter || 1}`,
                  )
                }
              >
                <span className="chapter-row__idx">{index + 1}</span>
                <span className="chapter-row__title">{displayName(pdf)}</span>
                {progress && (
                  <span className="chapter-row__badge">
                    {progress.total ? `${percent(progress.chapter, progress.total)}%` : '已读'}
                  </span>
                )}
                <FileText size={16} className="muted" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function BookPage() {
  const navigate = useNavigate();
  const { file = '' } = useParams();
  const [params] = useSearchParams();
  const kind = params.get('kind') || 'novel';
  const goBack = () => navigate('/library');

  if (kind === 'comic') {
    return <ComicDetail title={file} onBack={goBack} />;
  }
  return <NovelDetail file={file} onBack={goBack} />;
}
