import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookPlus, Check, Search as SearchIcon, XCircle } from 'lucide-react';
import { apiGet, apiPost, coverSrc } from '../lib/api';
import { useToast } from '../lib/toast';
import type { SearchBook, SearchProgress } from '../lib/types';

type AddedState = 'adding' | 'done';

function ResultRow({
  book,
  state,
  onAdd,
}: {
  book: SearchBook;
  state?: AddedState;
  onAdd: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const cover = coverSrc(book.cover);

  return (
    <div className="result-row">
      <div className="result-row__cover">
        {cover && !broken ? (
          <img src={cover} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          (book.title || '书').slice(0, 1)
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="result-row__title" title={book.title}>
          {book.title}
        </div>
        <div className="result-row__meta">
          <span className="badge badge--primary">{book.source}</span>
          {book.author ? <span>{book.author}</span> : null}
        </div>
        {book.desc ? <div className="result-row__desc">{book.desc}</div> : null}
      </div>
      <button
        type="button"
        className={`btn btn--sm${state === 'done' ? ' btn--ghost' : ''}`}
        onClick={onAdd}
        disabled={state === 'adding' || state === 'done'}
      >
        {state === 'done' ? <Check size={14} /> : <BookPlus size={14} />}
        {state === 'done' ? '已加入' : state === 'adding' ? '加入中…' : '加入书架'}
      </button>
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [books, setBooks] = useState<SearchBook[]>([]);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<Record<string, AddedState>>({});
  const seq = useRef(0);
  const seen = useRef(new Set<string>());
  const lastQuery = useRef('');
  const { toast } = useToast();

  const run = useCallback(async (keyword: string) => {
    const id = ++seq.current;
    seen.current = new Set();
    setRunning(true);
    setError('');
    setBooks([]);
    setProgress(null);
    setAdded({});

    try {
      const { task_id: tid } = await apiGet<{ task_id: string }>('/api/search_async', { q: keyword });

      for (;;) {
        if (id !== seq.current) return;
        const snapshot = await apiGet<SearchProgress>('/api/search_progress', { id: tid });
        if (id !== seq.current) return;

        const fresh = snapshot.books.filter((book) => {
          const key = `${book.url}|${book.source}`;
          if (seen.current.has(key)) return false;
          seen.current.add(key);
          return true;
        });
        if (fresh.length) {
          setBooks((prev) => [...prev, ...fresh]);
        }
        setProgress({ ...snapshot, books: [] });

        if (snapshot.state === 'done') {
          const result = await apiGet<{ results: SearchBook[] }>('/api/search_result', {
            id: tid,
          });
          if (id !== seq.current) return;
          setBooks(result.results);
          break;
        }
        if (snapshot.state === 'error' || snapshot.state === 'paused' || snapshot.state === 'cancelled') {
          if (snapshot.error) setError(snapshot.error);
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 600));
      }
    } catch (cause) {
      if (id === seq.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (id === seq.current) setRunning(false);
    }
  }, []);

  useEffect(() => {
    setInput(q);
    if (q && q !== lastQuery.current) {
      lastQuery.current = q;
      void run(q);
    }
  }, [q, run]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const keyword = input.trim();
    if (!keyword) {
      toast('请输入书名或作者', 'error');
      return;
    }
    if (keyword === q) {
      lastQuery.current = keyword;
      void run(keyword);
    } else {
      setParams({ q: keyword });
    }
  };

  const addToShelf = async (book: SearchBook) => {
    const key = `${book.url}|${book.source}`;
    setAdded((prev) => ({ ...prev, [key]: 'adding' }));
    try {
      await apiPost('/api/shelf', {
        title: book.title,
        url: book.url,
        source: book.source,
        cover: book.cover ?? '',
      });
      setAdded((prev) => ({ ...prev, [key]: 'done' }));
      toast(`《${book.title}》已加入书架`);
    } catch (cause) {
      setAdded((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast(cause instanceof Error ? cause.message : '加入书架失败', 'error');
    }
  };

  const stateMeta =
    progress && progress.state !== 'running'
      ? progress.state === 'done'
        ? '搜索完成'
        : progress.state === 'paused'
          ? '已暂停'
          : '搜索中断'
      : '正在聚合全部书源';

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 8;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">搜索</h1>
          <p className="page-desc">一次输入，多源并发检索；结果可边搜边看，随时加入书架。</p>
        </div>
      </div>

      <form className="search-bar" onSubmit={submit} role="search">
        <input
          className="input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="输入书名或作者，支持中英文"
          aria-label="搜索关键词"
          autoFocus
        />
        <button type="submit" className="btn" disabled={running}>
          <SearchIcon size={16} />
          {running ? '搜索中…' : '搜索'}
        </button>
      </form>

      {running || progress ? (
        <div className="progress-card">
          {running ? <span className="spinner" aria-hidden="true" /> : null}
          <div className="progress-card__text">
            <div className="progress-card__title">{stateMeta}</div>
            <div className="progress-card__sub">
              {total > 0 ? `${done} / ${total} 个书源` : '正在准备书源…'}
              {progress?.skipped ? ` · 跳过 ${progress.skipped} 个近期失败源` : ''}
              {progress?.timed_out ? ' · 已达到搜索时限' : ''}
            </div>
            <div className="progress-track">
              <i style={{ width: `${percent}%` }} />
            </div>
          </div>
          <span className="badge badge--primary">{books.length} 本</span>
        </div>
      ) : null}

      {progress && progress.sources.length > 0 ? (
        <div className="source-chips">
          {progress.sources.slice(-16).map((source, index) => (
            <span
              key={`${source.name}-${index}`}
              className={`source-chip${source.status === 'error' ? ' source-chip--error' : ' source-chip--ok'}`}
              title={source.status}
            >
              {source.name}
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="progress-card" role="alert">
          <XCircle size={18} color="var(--danger)" />
          <div className="progress-card__text">
            <div className="progress-card__title">搜索未完成</div>
            <div className="progress-card__sub">{error}</div>
          </div>
        </div>
      ) : null}

      {books.length > 0 ? (
        <div className="results">
          {books.map((book) => {
            const key = `${book.url}|${book.source}`;
            return (
              <ResultRow
                key={key}
                book={book}
                state={added[key]}
                onAdd={() => void addToShelf(book)}
              />
            );
          })}
        </div>
      ) : !running && !error && progress ? (
        <div className="empty">
          <div className="empty__icon">
            <SearchIcon size={20} />
          </div>
          <div className="empty__title">没有找到结果</div>
          <div className="empty__desc">
            换一个关键词，或在设置中检查书源是否启用。部分源可能需要先完成人机验证。
          </div>
        </div>
      ) : null}
    </div>
  );
}
