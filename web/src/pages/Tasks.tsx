import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FolderOpen,
  ListTodo,
  Pause,
  Play,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { useToast } from '../lib/toast';
import { relativeTime, taskKindLabel, taskStateMeta } from '../lib/format';
import type { Task, TaskHistoryEntry } from '../lib/types';
import { Modal } from '../components/Modal';

type Filter = 'all' | 'active' | 'finished' | 'error';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'finished', label: '已完成' },
  { value: 'error', label: '失败/取消' },
];

const ACTIVE_STATES = new Set(['running', 'downloading', 'paused']);
const PAUSABLE = new Set(['chapter_download', 'comic_download']);

function basename(file?: string): string {
  if (!file) return '';
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function kindIcon(kind?: string) {
  if (kind === 'search') return <Zap size={16} />;
  if (kind === 'comic_download' || kind === 'comic_refresh') return <Download size={16} />;
  if (kind?.includes('download')) return <Download size={16} />;
  return <ListTodo size={16} />;
}

function historyTime(entry: TaskHistoryEntry): number {
  return entry.ts ?? entry.time ?? entry.added ?? 0;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [clearOpen, setClearOpen] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [allResult, histResult] = await Promise.allSettled([
      apiGet<{ tasks: Task[] }>('/api/tasks_all'),
      apiGet<{ history: TaskHistoryEntry[] }>('/api/task_history'),
    ]);
    if (allResult.status === 'fulfilled') setTasks(allResult.value.tasks ?? []);
    else if (!silent) toast(allResult.reason instanceof Error ? allResult.reason.message : '任务加载失败', 'error');
    if (histResult.status === 'fulfilled') setHistory(histResult.value.history ?? []);
    if (!silent) setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(timer);
  }, [load]);

  const activeCount = tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (filter === 'active') return ACTIVE_STATES.has(task.state);
      if (filter === 'finished') return task.state === 'done';
      if (filter === 'error') return task.state === 'error' || task.state === 'cancelled';
      return true;
    });
  }, [filter, tasks]);

  const control = async (task: Task, action: 'stop' | 'pause' | 'resume' | 'switch_local') => {
    setBusy((prev) => ({ ...prev, [task.id]: true }));
    try {
      await apiPost('/api/task_control', { id: task.id, action });
      toast(
        action === 'stop'
          ? '已请求停止任务'
          : action === 'pause'
            ? '任务已暂停'
            : action === 'resume'
              ? '任务已继续'
              : '已切换为本地直抓',
      );
      await load(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
    }
  };

  const openOutput = async (file?: string) => {
    if (!window.desktop) {
      toast('仅桌面版支持打开目录', 'error');
      return;
    }
    await window.desktop.openDir(basename(file));
  };

  const clearHistory = async () => {
    try {
      await apiDelete('/api/task_history');
      setHistory([]);
      setClearOpen(false);
      toast('任务历史已清空');
    } catch (error) {
      toast(error instanceof Error ? error.message : '清空失败', 'error');
    }
  };

  const renderTask = (task: Task) => {
    const meta = taskStateMeta(task.state);
    const active = ACTIVE_STATES.has(task.state);
    const percent =
      task.total && task.total > 0
        ? Math.min(100, Math.round(((task.done ?? 0) / task.total) * 100))
        : active
          ? 6
          : 0;
    const isOpen = Boolean(expanded[task.id]);
    const logs = task.logs ?? [];
    return (
      <div key={task.id} className="task-item">
        <div className="task-row">
          <div className="task-row__icon">{kindIcon(task.kind)}</div>
          <div style={{ minWidth: 0 }}>
            <div className="task-row__title" title={task.title}>
              {task.title || '未命名任务'}
            </div>
            <div className="task-row__meta">
              <span className={`badge ${meta.tone}`}>{meta.label}</span>
              <span>{taskKindLabel(task.kind)}</span>
              {task.total ? (
                <span>
                  {task.done ?? 0} / {task.total}
                </span>
              ) : null}
              <span>{relativeTime(task.added)}</span>
            </div>
            {task.current ? <div className="task-row__current">{task.current}</div> : null}
            {task.error ? <div className="task-row__error">{task.error}</div> : null}
            {active || task.total ? (
              <div className="task-bar">
                <i style={{ width: `${percent}%` }} />
              </div>
            ) : null}
          </div>
          <div className="task-actions">
            {active ? (
              <>
                {PAUSABLE.has(task.kind) ? (
                  task.state === 'paused' ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy[task.id]}
                      onClick={() => void control(task, 'resume')}
                    >
                      <Play size={14} />
                      继续
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy[task.id]}
                      onClick={() => void control(task, 'pause')}
                    >
                      <Pause size={14} />
                      暂停
                    </button>
                  )
                ) : null}
                {task.kind === 'opds_download' && task.mode !== 'local' ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy[task.id]}
                    onClick={() => void control(task, 'switch_local')}
                  >
                    <Zap size={14} />
                    本地直抓
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy[task.id]}
                  onClick={() => void control(task, 'stop')}
                >
                  <Square size={13} />
                  停止
                </button>
              </>
            ) : null}
            {task.out_path ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void openOutput(task.out_path)}
                title={task.out_path}
              >
                <FolderOpen size={14} />
                文件
              </button>
            ) : null}
            {logs.length ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [task.id]: !prev[task.id] }))
                }
                aria-label={isOpen ? '收起日志' : '展开日志'}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : null}
          </div>
        </div>
        {isOpen && logs.length ? (
          <pre className="task-logs">{logs.slice(-60).join('\n')}</pre>
        ) : null}
      </div>
    );
  };

  const totalSize = history.reduce((sum, entry) => sum + (entry.size ?? 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">下载任务</h1>
          <p className="page-desc">
            {activeCount ? `${activeCount} 个任务进行中` : '当前队列空闲'} · 每 2.5 秒自动刷新
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
            <Clock3 size={15} />
            立即刷新
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => setClearOpen(true)}
            disabled={!history.length}
            title="清空历史记录"
            aria-label="清空历史记录"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="任务筛选">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={filter === item.value ? 'is-on' : ''}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="toolbar__hint">
          共 {tasks.length} 个任务 · 历史 {history.length} 条 · 累计 {Math.round(totalSize / 1024 / 1024)} MB
        </span>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card__head">
          <h2 className="card__title">当前与最近任务</h2>
          <span className="card__link">{activeCount} 个进行中</span>
        </div>
        <div className="card__body">
          {loading && !tasks.length ? (
            <div className="skeleton" style={{ height: 180 }} />
          ) : filteredTasks.length ? (
            <div className="task-list">{filteredTasks.map(renderTask)}</div>
          ) : (
            <div className="empty" style={{ padding: '30px 16px' }}>
              <div className="empty__icon">
                <ListTodo size={20} />
              </div>
              <div className="empty__title">没有任务</div>
              <div className="empty__desc">
                从书架启动下载后，进度会实时显示在这里。
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2 className="card__title">任务历史</h2>
          <span className="card__link">最近 {history.length} 条</span>
        </div>
        <div className="card__body">
          {history.length ? (
            <div className="history-list">
              {history.map((entry, index) => {
                const ok = entry.state === 'ok';
                return (
                  <div key={`${historyTime(entry)}-${index}`} className="history-row">
                    <div className={`history-row__dot${ok ? ' is-ok' : ' is-error'}`} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="history-row__title">
                        {entry.title || '未命名'}
                        <span className="badge">{entry.kind || '任务'}</span>
                        <span className={`badge ${ok ? 'badge--success' : 'badge--danger'}`}>
                          {ok ? '成功' : '失败'}
                        </span>
                      </div>
                      <div className="history-row__meta">
                        {relativeTime(historyTime(entry))}
                        {entry.detail ? ` · ${entry.detail}` : ''}
                        {entry.size ? ` · ${Math.round(entry.size / 1024)} KB` : ''}
                      </div>
                    </div>
                    {entry.file ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void openOutput(entry.file || '')}
                        title={entry.file}
                      >
                        <FolderOpen size={14} />
                        文件
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty" style={{ padding: '30px 16px' }}>
              <div className="empty__icon">
                <Clock3 size={20} />
              </div>
              <div className="empty__title">还没有历史记录</div>
              <div className="empty__desc">下载、追更和 OPDS 任务结束后会记录在这里。</div>
            </div>
          )}
        </div>
      </section>

      <Modal
        title="清空任务历史"
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setClearOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void clearHistory()}>
              清空
            </button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          只会删除历史记录，不会删除已下载的文件。确定继续吗？
        </p>
      </Modal>
    </div>
  );
}
