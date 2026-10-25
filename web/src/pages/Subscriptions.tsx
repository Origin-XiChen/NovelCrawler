import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Database,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import { relativeTime } from '../lib/format';
import type {
  ComicBaseMatch,
  SourceSyncStatus,
  Subscription,
  Task,
} from '../lib/types';

type Kind = 'novel' | 'comic';

interface AddForm {
  name: string;
  url: string;
  file: string;
  remark: string;
}

const EMPTY_FORM: AddForm = { name: '', url: '', file: '', remark: '' };

const STAGE_LABELS: Record<string, string> = {
  fetching: '拉取书源仓库',
  probing: '探测书源',
  verifying: '验证可用性',
  fixing: '修正搜索接口',
  done: '已完成',
};

function stageText(status?: SourceSyncStatus | null): string {
  if (!status) return '等待开始';
  if (status.error) return `失败：${status.error}`;
  const label = status.stage ? STAGE_LABELS[status.stage] ?? status.stage : '等待开始';
  if (status.stage === 'done') {
    return `完成：可用候选 ${status.candidates ?? 0} 个`;
  }
  return `${label} · 已处理 ${status.processed ?? 0} 个`;
}

function SubRow({
  sub,
  kind,
  busy,
  onRefresh,
  onDelete,
  onApplyPending,
}: {
  sub: Subscription;
  kind: Kind;
  busy: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onApplyPending?: () => void;
}) {
  const matches = sub.pending?.matches?.length ?? 0;
  const countText = sub.count
    ? `${sub.count} ${kind === 'comic' && /修正/.test(sub.status ?? '') ? '项' : '源'}`
    : '';
  return (
    <div className="source-row">
      <div className="source-row__main">
        <div className="source-row__title">
          <span className="source-row__name">{sub.name}</span>
          {kind === 'comic' ? <span className="badge badge--primary">漫画</span> : null}
          {matches ? <span className="badge badge--warn">待应用 {matches}</span> : null}
        </div>
        <div className="source-row__domain" title={sub.remark || sub.url}>
          {sub.remark || sub.url}
        </div>
        <div className="source-row__domain">
          {sub.status || '未同步'}
          {countText ? ` · ${countText}` : ''}
          {' · 上次：'}
          {sub.last_sync ? relativeTime(sub.last_sync) : '未同步'}
        </div>
      </div>
      <div className="source-row__actions">
        {matches && onApplyPending ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onApplyPending}>
            <Check size={14} />
            应用修正
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
          {busy ? '同步中…' : '刷新'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDelete}>
          <Trash2 size={14} />
          删除
        </button>
      </div>
    </div>
  );
}

export function SubscriptionsPage() {
  const { toast } = useToast();
  const [kind, setKind] = useState<Kind>('novel');
  const [novelSubs, setNovelSubs] = useState<Subscription[]>([]);
  const [comicSubs, setComicSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [novelSync, setNovelSync] = useState<SourceSyncStatus | null>(null);
  const [busyUrl, setBusyUrl] = useState('');

  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null);

  const [baseTarget, setBaseTarget] = useState<Subscription | null>(null);
  const [baseMatches, setBaseMatches] = useState<ComicBaseMatch[]>([]);
  const [baseSelected, setBaseSelected] = useState<Set<string>>(new Set());
  const [baseBusy, setBaseBusy] = useState(false);

  const loadNovel = useCallback(async () => {
    const data = await apiGet<{ subscriptions: Subscription[] }>('/api/subscriptions');
    setNovelSubs(data.subscriptions ?? []);
  }, []);

  const loadComic = useCallback(async () => {
    const data = await apiGet<{ subscriptions: Subscription[] }>('/api/comic_subscriptions');
    setComicSubs(data.subscriptions ?? []);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      await Promise.all([loadNovel(), loadComic()]);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setLoading(false);
    }
  }, [loadComic, loadNovel, toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!novelSync?.running) return;
    const timer = window.setInterval(() => {
      void apiGet<SourceSyncStatus>('/api/sync_status')
        .then((state) => {
          setNovelSync(state);
          if (!state.running) {
            setBusyUrl('');
            void loadNovel();
            toast(
              state.error ? `订阅同步失败：${state.error}` : '订阅同步完成，可到候选池查看',
              state.error ? 'error' : 'success',
            );
          }
        })
        .catch(() => {
          /* 下一轮继续 */
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [novelSync?.running, loadNovel, toast]);

  const subs = kind === 'novel' ? novelSubs : comicSubs;
  const syncText = useMemo(() => (kind === 'novel' ? stageText(novelSync) : ''), [kind, novelSync]);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (!form.url.trim()) {
      toast('请填写 GitHub 仓库地址或规则直链', 'error');
      return;
    }
    setAddBusy(true);
    try {
      const path = kind === 'novel' ? '/api/subscriptions' : '/api/comic_subscriptions';
      await apiPost(path, {
        name: form.name.trim(),
        url: form.url.trim(),
        file: form.file.trim(),
        remark: form.remark.trim(),
      });
      toast('订阅已添加', 'success');
      setAddOpen(false);
      setForm(EMPTY_FORM);
      if (kind === 'novel') await loadNovel();
      else await loadComic();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setAddBusy(false);
    }
  };

  const refreshNovel = async (sub: Subscription) => {
    if (busyUrl) return;
    setBusyUrl(sub.url);
    try {
      const data = await apiPost<{ status?: SourceSyncStatus }>('/api/subscriptions/refresh', {
        url: sub.url,
      });
      setNovelSync(data.status ?? { running: true, stage: 'fetching' });
      toast(`正在同步「${sub.name}」…`, 'success');
    } catch (cause) {
      setBusyUrl('');
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const openBaseModal = (sub: Subscription, matches: ComicBaseMatch[]) => {
    setBaseTarget(sub);
    setBaseMatches(matches);
    setBaseSelected(new Set(matches.map((item) => item.key)));
  };

  const openPending = (sub: Subscription) => {
    const matches = sub.pending?.matches ?? [];
    if (!matches.length) {
      toast('该订阅没有待应用的地址修正', 'info');
      return;
    }
    openBaseModal(sub, matches);
  };

  const refreshComic = async (sub: Subscription) => {
    if (busyUrl) return;
    setBusyUrl(sub.url);
    try {
      const started = await apiPost<{ task_id: string }>('/api/comic_subscriptions/refresh', {
        url: sub.url,
      });
      const deadline = Date.now() + 90_000;
      let failed = '';
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        const data = await apiGet<{ tasks: Task[] }>('/api/tasks_all');
        const task = (data.tasks ?? []).find((item) => item.id === started.task_id);
        if (!task) break;
        if (task.state === 'error') {
          failed = task.error || '同步失败';
          break;
        }
        if (task.state === 'done' || task.state === 'completed') break;
      }
      if (failed) throw new Error(failed);
      const info = await apiGet<{
        pending?: { matches?: ComicBaseMatch[] } | null;
        unmatched?: number;
        status?: string;
      }>('/api/comic_subscriptions/pending', { url: sub.url });
      await loadComic();
      const matches = info.pending?.matches ?? [];
      if (matches.length) {
        openBaseModal(sub, matches);
        toast(`已拉取 ${matches.length} 个可修正的源，请勾选应用`, 'success');
      } else {
        toast(info.status || '同步完成', 'success');
      }
    } catch (cause) {
      toast(`同步失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusyUrl('');
    }
  };

  const applyBase = async () => {
    if (!baseTarget) return;
    const keys = [...baseSelected];
    if (!keys.length) {
      toast('请先勾选要应用的源', 'error');
      return;
    }
    setBaseBusy(true);
    try {
      const data = await apiPost<{ count?: number }>('/api/comic_base_apply', {
        url: baseTarget.url,
        keys,
      });
      toast(`已应用 ${data.count ?? 0} 个地址修正`, 'success');
      setBaseTarget(null);
      await loadComic();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBaseBusy(false);
    }
  };

  const removeSub = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const path = kind === 'novel' ? '/api/subscriptions' : '/api/comic_subscriptions';
      await apiDelete(path, { url: target.url });
      toast('已删除订阅', 'success');
      if (kind === 'novel') await loadNovel();
      else await loadComic();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const toggleBase = (key: string) => {
    setBaseSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">订阅中心</h1>
          <p className="page-desc">
            订阅 GitHub 书源仓库或规则直链，同步后进入书源候选池；漫画订阅支持 Cimoc 地址修正表。
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn--ghost" to="/sources?tab=candidates">
            <Database size={15} />
            候选池
          </Link>
          <button type="button" className="btn" onClick={openAdd}>
            <Plus size={15} />
            添加订阅
          </button>
        </div>
      </div>

      <div className="tabbar" role="tablist" aria-label="订阅类型">
        {(
          [
            ['novel', '小说订阅'],
            ['comic', '漫画订阅'],
          ] as [Kind, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={kind === value ? 'is-on' : ''}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="source-toolbar">
        <span className="source-stat">
          共 {subs.length} 个订阅
          {kind === 'novel' && novelSync?.running ? ` · ${syncText}` : ''}
        </span>
      </div>

      {kind === 'comic' ? (
        <div className="source-report" style={{ marginBottom: 12 }}>
          订阅支持三种内容：漫画源规则（JSON 数组或单条）、Cimoc sourceBaseUrl
          地址修正表、自定义规则直链。刷新地址修正表后勾选应用，可一键复活失效源；
          删除订阅会一并移除其导入的自定义源与地址修正。
        </div>
      ) : null}

      {loading ? (
        <div className="empty">正在加载订阅…</div>
      ) : subs.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">
            <Rss size={22} />
          </div>
          <div className="empty__title">还没有订阅</div>
          <div className="empty__desc">
            添加 GitHub 书源仓库或规则直链，刷新后可在候选池筛选导入。
          </div>
        </div>
      ) : (
        <div className="source-list">
          {subs.map((sub) => (
            <SubRow
              key={`${sub.url}|${sub.file ?? ''}`}
              sub={sub}
              kind={kind}
              busy={busyUrl === sub.url}
              onRefresh={() => {
                if (kind === 'novel') void refreshNovel(sub);
                else void refreshComic(sub);
              }}
              onDelete={() => setDeleteTarget(sub)}
              onApplyPending={
                kind === 'comic' && (sub.pending?.matches?.length ?? 0) > 0
                  ? () => openPending(sub)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <Modal
        title={kind === 'novel' ? '添加小说订阅' : '添加漫画订阅'}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        width={620}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setAddOpen(false)}>
              取消
            </button>
            <button type="button" className="btn" disabled={addBusy} onClick={() => void submitAdd()}>
              {addBusy ? '添加中…' : '添加订阅'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label className="field">
            <span>订阅名称</span>
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="可选，默认使用地址"
            />
          </label>
          <label className="field">
            <span>文件路径</span>
            <input
              className="input"
              value={form.file}
              onChange={(event) => setForm({ ...form, file: event.target.value })}
              placeholder="可选，仓库内的书源文件"
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>GitHub 仓库 / 规则直链 *</span>
            <input
              className="input"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              placeholder="https://github.com/用户名/仓库 或 https://.../sources.json"
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>备注</span>
            <input
              className="input"
              value={form.remark}
              onChange={(event) => setForm({ ...form, remark: event.target.value })}
              placeholder="可选，用于列表说明"
            />
          </label>
        </div>
      </Modal>

      <Modal
        title="删除订阅"
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void removeSub()}>
              <Trash2 size={14} />
              删除
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.8 }}>
          确定删除「{deleteTarget?.name}」吗？
          {kind === 'comic'
            ? '该订阅导入的自定义漫画源与地址修正会一并移除。'
            : '已导入的书源不会被删除。'}
        </p>
      </Modal>

      <Modal
        title="应用漫画源地址修正"
        open={Boolean(baseTarget)}
        onClose={() => setBaseTarget(null)}
        width={640}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setBaseTarget(null)}>
              跳过
            </button>
            <button
              type="button"
              className="btn"
              disabled={baseBusy || baseSelected.size === 0}
              onClick={() => void applyBase()}
            >
              <Check size={14} />
              {baseBusy ? '应用中…' : `应用所选（${baseSelected.size}）`}
            </button>
          </>
        }
      >
        <p style={{ margin: '0 0 10px', color: 'var(--text-2)', fontSize: 13, lineHeight: 1.8 }}>
          勾选要修正的漫画源，应用后立即生效；删除该订阅可回滚全部修正。
        </p>
        <div className="candidate-list">
          {baseMatches.map((match) => (
            <label key={match.key} className="candidate-row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={baseSelected.has(match.key)}
                onChange={() => toggleBase(match.key)}
              />
              <span className="candidate-row__name">{match.name}</span>
              <span className="candidate-row__base">
                {match.old_base} → <b style={{ color: 'var(--success)' }}>{match.base}</b>
              </span>
            </label>
          ))}
        </div>
      </Modal>
    </div>
  );
}
