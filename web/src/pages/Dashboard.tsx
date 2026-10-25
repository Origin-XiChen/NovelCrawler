import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  BookOpen,
  Download,
  FolderSearch,
  Library,
  ListTodo,
  Plus,
  Search,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet, coverSrc } from '../lib/api';
import type { ShelfEntry, Source, Task } from '../lib/types';
import { greeting, pct, relativeTime, taskKindLabel, taskStateMeta } from '../lib/format';

interface DashData {
  shelf: ShelfEntry[];
  tasks: Task[];
  sources: Source[];
  comics: number;
}

const EMPTY: DashData = { shelf: [], tasks: [], sources: [], comics: 0 };

function BookCard({ book }: { book: ShelfEntry }) {
  const [broken, setBroken] = useState(false);
  const cover = coverSrc(book.cover);

  return (
    <div className="book-card">
      <div className="book-card__cover">
        {cover && !broken ? (
          <img src={cover} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          (book.title || '书').slice(0, 1)
        )}
      </div>
      <div className="book-card__body">
        <div className="book-card__title" title={book.title}>
          {book.title}
        </div>
        <div className="book-card__meta">
          {book.author || book.source || '未知来源'}
          {book.local_chapters ? ` · ${book.local_chapters} 章` : ''}
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    let alive = true;

    const load = async () => {
      const [shelf, tasks, sources, comics] = await Promise.allSettled([
        apiGet<{ shelf: ShelfEntry[] }>('/api/shelf'),
        apiGet<{ tasks: Task[] }>('/api/tasks_all'),
        apiGet<{ sources: Source[] }>('/api/sources'),
        apiGet<{ shelf?: unknown[] }>('/api/comic_shelf'),
      ]);
      if (!alive) return;
      setData({
        shelf: shelf.status === 'fulfilled' ? shelf.value.shelf ?? [] : [],
        tasks: tasks.status === 'fulfilled' ? tasks.value.tasks ?? [] : [],
        sources: sources.status === 'fulfilled' ? sources.value.sources ?? [] : [],
        comics: comics.status === 'fulfilled' ? (comics.value.shelf?.length ?? 0) : 0,
      });
      setLoading(false);
    };

    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const activeTasks = data.tasks.filter((task) =>
    ['running', 'downloading', 'paused'].includes(task.state),
  );
  const enabledSources = data.sources.filter((source) => source.enabled !== false);
  const recentTasks = [...data.tasks]
    .sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
    .slice(0, 5);
  const recentBooks = data.shelf.slice(0, 6);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = keyword.trim();
    if (!value) return;
    navigate(`/search?q=${encodeURIComponent(value)}`);
  };

  return (
    <div className="page">
      <section className="hero">
        <div className="hero__eyebrow">NovelCrawler · 多源聚合</div>
        <h1 className="hero__title">
          {greeting()}，今天想读点什么？
        </h1>
        <p className="hero__desc">
          一次搜索覆盖全部书源，支持 EPUB / PDF 下载、书架追更与漫画打包。
        </p>
        <form className="hero__search" onSubmit={submit}>
          <input
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="输入书名或作者，例如：三体"
            aria-label="搜索书名或作者"
          />
          <button type="submit" className="btn">
            <Search size={16} />
            开始搜索
          </button>
        </form>
      </section>

      <section className="stats" aria-label="数据概览">
        <div className="stat">
          <div className="stat__top">
            <span className="stat__icon">
              <Library size={14} />
            </span>
            书架藏书
          </div>
          <div className="stat__value">{loading ? '—' : data.shelf.length}</div>
          <div className="stat__hint">本小说已收藏</div>
        </div>
        <div className="stat">
          <div className="stat__top">
            <span className="stat__icon">
              <ListTodo size={14} />
            </span>
            活跃任务
          </div>
          <div className="stat__value">{loading ? '—' : activeTasks.length}</div>
          <div className="stat__hint">
            {activeTasks.length > 0 ? '下载 / 搜索进行中' : '当前队列空闲'}
          </div>
        </div>
        <div className="stat">
          <div className="stat__top">
            <span className="stat__icon">
              <FolderSearch size={14} />
            </span>
            可用书源
          </div>
          <div className="stat__value">{loading ? '—' : enabledSources.length}</div>
          <div className="stat__hint">已启用的聚合源</div>
        </div>
        <div className="stat">
          <div className="stat__top">
            <span className="stat__icon">
              <BookOpen size={14} />
            </span>
            漫画收藏
          </div>
          <div className="stat__value">{loading ? '—' : data.comics}</div>
          <div className="stat__hint">部漫画已收藏</div>
        </div>
      </section>

      <div className="dash-grid">
        <section className="card">
          <div className="card__head">
            <h2 className="card__title">最近任务</h2>
            <Link className="card__link" to="/tasks">
              全部任务
              <ArrowRight size={13} />
            </Link>
          </div>
          <div className="card__body">
            {loading ? (
              <div className="task-list">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="task-row">
                    <div className="skeleton" style={{ width: 34, height: 34 }} />
                    <div>
                      <div className="skeleton" style={{ width: '42%', height: 12 }} />
                      <div
                        className="skeleton"
                        style={{ width: '64%', height: 10, marginTop: 7 }}
                      />
                    </div>
                    <div className="skeleton" style={{ width: 52, height: 20 }} />
                  </div>
                ))}
              </div>
            ) : recentTasks.length === 0 ? (
              <div className="empty">
                <div className="empty__icon">
                  <Download size={20} />
                </div>
                <div className="empty__title">还没有任务</div>
                <div className="empty__desc">搜索一本书并开始下载，进度会显示在这里。</div>
              </div>
            ) : (
              <div className="task-list">
                {recentTasks.map((task) => {
                  const state = taskStateMeta(task.state);
                  const progress = pct(task.done, task.total);
                  return (
                    <div key={task.id} className="task-row">
                      <div className="task-row__icon">
                        {task.kind === 'search' ? <Search size={15} /> : <Download size={15} />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="task-row__title" title={task.title}>
                          {task.title || '未命名任务'}
                        </div>
                        <div className="task-row__meta">
                          <span>{taskKindLabel(task.kind)}</span>
                          <span>·</span>
                          <span>{relativeTime(task.added)}</span>
                          {task.total ? (
                            <span>
                              · {task.done ?? 0}/{task.total}
                            </span>
                          ) : null}
                        </div>
                        {task.total ? (
                          <div className="task-bar">
                            <i style={{ width: `${progress}%` }} />
                          </div>
                        ) : null}
                      </div>
                      <span className={`badge ${state.tone}`}>{state.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2 className="card__title">书架速览</h2>
            <Link className="card__link" to="/shelf">
              进入书架
              <ArrowRight size={13} />
            </Link>
          </div>
          <div className="card__body">
            {loading ? (
              <div className="book-grid">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="book-card">
                    <div className="skeleton" style={{ width: 46, height: 62 }} />
                    <div style={{ flex: 1 }}>
                      <div className="skeleton" style={{ width: '80%', height: 12 }} />
                      <div
                        className="skeleton"
                        style={{ width: '55%', height: 10, marginTop: 8 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentBooks.length === 0 ? (
              <div className="empty">
                <div className="empty__icon">
                  <Plus size={20} />
                </div>
                <div className="empty__title">书架还是空的</div>
                <div className="empty__desc">搜索后点击「加入书架」，追更和阅读记录都会保留。</div>
              </div>
            ) : (
              <div className="book-grid">
                {recentBooks.map((book) => (
                  <BookCard key={`${book.url}-${book.source ?? ''}`} book={book} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
