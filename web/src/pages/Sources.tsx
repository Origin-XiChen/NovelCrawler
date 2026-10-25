import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  Check,
  Copy,
  Database,
  Eraser,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import type {
  SourceCandidate,
  SourceHealthStatus,
  SourceItem,
  SourceSyncStatus,
} from '../lib/types';

type Tab = 'list' | 'candidates' | 'sync';

interface TestState {
  running?: boolean;
  ok?: boolean;
  report?: string[];
  error?: string;
}

interface AddForm {
  name: string;
  base: string;
  charset: string;
  method: string;
  path: string;
  param: string;
  extra: string;
  bookPattern: string;
  chapterPattern: string;
  contentSelector: string;
  tocReverse: boolean;
  verifySsl: boolean;
  render: boolean;
  apiUrl: string;
  apiList: string;
  apiName: string;
  apiAuthor: string;
  apiId: string;
  apiUrlTpl: string;
}

const EMPTY_FORM: AddForm = {
  name: '',
  base: '',
  charset: 'utf-8',
  method: '',
  path: '/',
  param: 's',
  extra: '',
  bookPattern: '',
  chapterPattern: '',
  contentSelector: '',
  tocReverse: false,
  verifySsl: true,
  render: false,
  apiUrl: '',
  apiList: '$',
  apiName: '',
  apiAuthor: '',
  apiId: '',
  apiUrlTpl: '/',
};

const STAGE_LABELS: Record<string, string> = {
  fetching: '拉取书源仓库',
  probing: '探测书源',
  verifying: '验证可用性',
  fixing: '修正搜索接口',
  done: '已完成',
};

function stageLabel(stage?: string) {
  if (!stage) return '等待开始';
  return STAGE_LABELS[stage] ?? stage;
}

function SourceBadges({ source }: { source: SourceItem }) {
  const api = Boolean(source.api_rules && (source.api_rules as { search?: unknown }).search);
  return (
    <span className="source-badges">
      {api ? <span className="badge badge--primary">API</span> : null}
      {source.render ? <span className="badge badge--primary">渲染</span> : null}
      {source.search_ok ? <span className="badge badge--success">搜索</span> : null}
      {source.custom ? <span className="badge badge--warn">自定义</span> : null}
      {source.enabled === false ? <span className="badge badge--danger">已停用</span> : null}
    </span>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="update-card__bar" style={{ marginTop: 10 }}>
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function SourcesPage() {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const value = searchParams.get('tab');
    return value === 'candidates' || value === 'sync' ? value : 'list';
  });
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [health, setHealth] = useState<SourceHealthStatus | null>(null);
  const [sync, setSync] = useState<SourceSyncStatus | null>(null);
  const [candidates, setCandidates] = useState<SourceCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [syncLimit, setSyncLimit] = useState('');
  const [syncMinContent, setSyncMinContent] = useState('100');

  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; errors: string[] } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<SourceItem | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const data = await apiGet<{ sources: SourceItem[] }>('/api/settings');
      setSources(data.sources ?? []);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadCandidates = useCallback(async () => {
    setCandidatesLoading(true);
    try {
      const data = await apiGet<{ candidates: SourceCandidate[] }>('/api/source_candidates');
      setCandidates(data.candidates ?? []);
      setSelectedCandidates(new Set());
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setCandidatesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadSources();
    apiGet<SourceSyncStatus>('/api/sync_status')
      .then((data) => setSync(data))
      .catch(() => {
        /* 状态接口失败不阻塞页面 */
      });
  }, [loadSources]);

  useEffect(() => {
    if (tab === 'candidates') void loadCandidates();
  }, [tab, loadCandidates]);

  useEffect(() => {
    if (!health?.running) return;
    const timer = window.setInterval(() => {
      void apiGet<SourceHealthStatus>('/api/source_health_status')
        .then((state) => {
          setHealth(state);
          if (!state.running) {
            void loadSources();
            if (state.dead?.length) {
              toast(`体检完成：已自动停用 ${state.dead.length} 个失效源`, 'success');
            } else if (!state.error) {
              toast('体检完成：启用中的书源均可访问', 'success');
            }
          }
        })
        .catch(() => {
          /* 下一轮继续 */
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [health?.running, loadSources, toast]);

  useEffect(() => {
    if (!sync?.running) return;
    const timer = window.setInterval(() => {
      void apiGet<SourceSyncStatus>('/api/sync_status')
        .then((state) => {
          setSync(state);
          if (!state.running) {
            void loadSources();
            if (state.error) toast(`同步失败：${state.error}`, 'error');
            else toast('书源仓库同步完成', 'success');
          }
        })
        .catch(() => {
          /* 下一轮继续 */
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [sync?.running, loadSources, toast]);

  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter(
      (source) =>
        source.name.toLowerCase().includes(text) ||
        (source.base ?? '').toLowerCase().includes(text),
    );
  }, [sources, keyword]);

  const stats = useMemo(() => {
    const enabled = sources.filter((source) => source.enabled !== false).length;
    const searchable = sources.filter((source) => source.search_ok).length;
    return { total: sources.length, enabled, searchable };
  }, [sources]);

  const toggle = async (source: SourceItem, enabled: boolean) => {
    setSources((prev) =>
      prev.map((item) => (item.name === source.name ? { ...item, enabled } : item)),
    );
    try {
      await apiPost('/api/source_toggle', { name: source.name, enabled });
      toast(`${enabled ? '已启用' : '已停用'}「${source.name}」`, 'success');
    } catch (cause) {
      setSources((prev) =>
        prev.map((item) =>
          item.name === source.name ? { ...item, enabled: source.enabled } : item,
        ),
      );
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const testSource = async (source: SourceItem) => {
    setTests((prev) => ({ ...prev, [source.name]: { running: true } }));
    try {
      const data = await apiGet<{ ok?: boolean; report?: string[] }>('/api/test_source', {
        name: source.name,
      });
      setTests((prev) => ({
        ...prev,
        [source.name]: { ok: data.ok, report: data.report ?? [] },
      }));
      toast(
        data.ok ? `书源可用：${source.name}` : `书源部分功能不可用：${source.name}`,
        data.ok ? 'success' : 'error',
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTests((prev) => ({ ...prev, [source.name]: { error: message } }));
      toast(`测试失败：${message}`, 'error');
    }
  };

  const exportSource = async (source: SourceItem) => {
    try {
      const data = await apiGet<{ text: string }>('/api/source_rule', { name: source.name });
      try {
        await navigator.clipboard.writeText(data.text);
        toast('书源规则已复制到剪贴板', 'success');
      } catch {
        const blob = new Blob([data.text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${source.name}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        toast('剪贴板不可用，已下载书源文件', 'success');
      }
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const removeSource = async () => {
    if (!deleteTarget) return;
    try {
      await apiDelete('/api/sources', { name: deleteTarget.name });
      toast(`已删除「${deleteTarget.name}」`, 'success');
      setDeleteTarget(null);
      void loadSources();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const submitAdd = async () => {
    if (!form.name.trim() || !form.base.trim()) {
      toast('请填写书源名称与域名', 'error');
      return;
    }
    let extra: Record<string, unknown> | null = null;
    if (form.method && form.extra.trim()) {
      try {
        extra = JSON.parse(form.extra.trim()) as Record<string, unknown>;
      } catch {
        toast('附加参数不是合法 JSON', 'error');
        return;
      }
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      base: form.base.trim(),
      charset: form.charset,
      toc_reverse: form.tocReverse,
      verify_ssl: form.verifySsl,
      render: form.render,
    };
    if (form.bookPattern.trim()) payload.book_href_pattern = form.bookPattern.trim();
    if (form.chapterPattern.trim()) payload.chapter_href_pattern = form.chapterPattern.trim();
    if (form.contentSelector.trim()) payload.content_selector = form.contentSelector.trim();
    if (form.method) {
      payload.search = {
        method: form.method,
        path: form.path.trim() || '/',
        param: form.param.trim() || 's',
        ...(extra ? { extra } : {}),
      };
    }
    if (form.apiUrl.trim()) {
      payload.api_rules = {
        search: {
          url: form.apiUrl.trim(),
          list: form.apiList.trim() || '$',
          name: form.apiName.trim(),
          author: form.apiAuthor.trim(),
          id: form.apiId.trim(),
          book_url: form.apiUrlTpl.trim() || '/',
        },
      };
    }

    setAddBusy(true);
    try {
      await apiPost('/api/sources', payload);
      toast('书源已添加，可点「测试」验证', 'success');
      setAddOpen(false);
      setForm(EMPTY_FORM);
      void loadSources();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setAddBusy(false);
    }
  };

  const submitImport = async () => {
    if (!importText.trim()) {
      toast('请粘贴书源 JSON', 'error');
      return;
    }
    setImportBusy(true);
    setImportResult(null);
    try {
      const data = await apiPost<{ imported?: string[]; errors?: string[] }>(
        '/api/source_import',
        { text: importText },
      );
      setImportResult({ imported: data.imported ?? [], errors: data.errors ?? [] });
      if (data.imported?.length) {
        setImportText('');
        void loadSources();
        toast(`已导入 ${data.imported.length} 个书源`, 'success');
      }
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setImportBusy(false);
    }
  };

  const runHealth = async () => {
    try {
      setHealth({ running: true, total: 0, dead: [] });
      await apiPost('/api/source_health');
      toast('正在体检启用中的书源…', 'success');
    } catch (cause) {
      setHealth(null);
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const runCleanup = async () => {
    try {
      const data = await apiPost<{ disabled?: string[] }>('/api/source_cleanup');
      const disabled = data.disabled ?? [];
      toast(
        disabled.length
          ? `已停用 ${disabled.length} 个近期连续失败的源`
          : '暂无连续失败的源（搜索几次后会自动积累）',
        disabled.length ? 'success' : 'info',
      );
      void loadSources();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const startSync = async () => {
    try {
      const limit = syncLimit.trim() ? Number(syncLimit) : undefined;
      const minContent = syncMinContent.trim() ? Number(syncMinContent) : 100;
      const data = await apiPost<{ status?: SourceSyncStatus }>('/api/source_sync', {
        ...(limit ? { limit } : {}),
        min_content: minContent,
      });
      setSync(data.status ?? { running: true, stage: 'fetching' });
      toast('已开始同步书源仓库', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const fixSearch = async () => {
    try {
      const data = await apiPost<{ status?: SourceSyncStatus }>('/api/source_fix_search');
      setSync(data.status ?? { running: true, stage: 'fixing' });
      toast('正在二次修正候选源的搜索接口', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const importCandidates = async () => {
    const names = [...selectedCandidates];
    if (!names.length) {
      toast('请先勾选候选源', 'error');
      return;
    }
    try {
      const data = await apiPost<{ imported?: string[]; errors?: string[] }>(
        '/api/source_candidates_import',
        { names },
      );
      const imported = data.imported ?? [];
      const errors = data.errors ?? [];
      toast(
        errors.length
          ? `导入 ${imported.length} 个，失败 ${errors.length} 个`
          : `已导入 ${imported.length} 个候选源`,
        errors.length ? 'error' : 'success',
      );
      void loadSources();
      void loadCandidates();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const toggleCandidate = (name: string) => {
    setSelectedCandidates((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allCandidatesChecked =
    candidates.length > 0 && selectedCandidates.size === candidates.length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">书源</h1>
          <p className="page-desc">
            管理小说书源、体检失效站点、从仓库同步并筛选候选源。
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn--ghost" onClick={() => void runHealth()}>
            <Activity size={15} />
            体检
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void runCleanup()}>
            <Eraser size={15} />
            清理失效
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(true)}>
            <Upload size={15} />
            导入
          </button>
          <button type="button" className="btn" onClick={() => setAddOpen(true)}>
            <Plus size={15} />
            添加书源
          </button>
        </div>
      </div>

      <div className="tabbar" role="tablist" aria-label="书源工具">
        {(
          [
            ['list', '书源列表'],
            ['candidates', '候选池'],
            ['sync', '同步中心'],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'is-on' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'list' ? (
        <>
          <div className="source-toolbar">
            <div className="toolbar__search" style={{ flex: 1, minWidth: 220 }}>
              <Search size={15} />
              <input
                className="input"
                placeholder="按名称或域名筛选"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
            <span className="source-stat">
              共 {stats.total} · 启用 {stats.enabled} · 可搜索 {stats.searchable}
            </span>
            {health?.running ? (
              <span className="source-stat">体检中 {health.total ?? 0} 个…</span>
            ) : null}
          </div>

          {loading ? (
            <div className="empty">正在加载书源…</div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <div className="empty__icon">
                <Globe2 size={22} />
              </div>
              <div className="empty__title">没有匹配的书源</div>
              <div className="empty__desc">换个关键词，或添加/导入新的书源。</div>
            </div>
          ) : (
            <div className="source-list">
              {visible.map((source) => {
                const state = tests[source.name];
                return (
                  <div className="source-row" key={source.name}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={source.enabled !== false}
                      aria-label={`${source.enabled !== false ? '停用' : '启用'} ${source.name}`}
                      className={`switch${source.enabled !== false ? ' is-on' : ''}`}
                      onClick={() => void toggle(source, source.enabled === false)}
                    >
                      <i />
                    </button>
                    <div className="source-row__main">
                      <div className="source-row__title">
                        <span className="source-row__name">{source.name}</span>
                        <SourceBadges source={source} />
                      </div>
                      <div className="source-row__domain" title={source.base}>
                        {source.base || '未填写域名'}
                      </div>
                      {state ? (
                        <div className="source-report">
                          {state.running
                            ? '测试中（可能需要数十秒）…'
                            : state.error
                              ? `测试失败：${state.error}`
                              : (state.report ?? []).map((line, index) => (
                                  <div key={`${source.name}-${index}`}>{line}</div>
                                ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="source-row__actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        disabled={state?.running}
                        onClick={() => void testSource(source)}
                      >
                        {state?.running ? '测试中…' : '测试'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => void exportSource(source)}
                      >
                        <Copy size={13} />
                        导出
                      </button>
                      {source.custom ? (
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          onClick={() => setDeleteTarget(source)}
                        >
                          <Trash2 size={13} />
                          删除
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {tab === 'candidates' ? (
        <div className="card">
          <div className="card__head">
            <div>
              <div className="card__title">候选池</div>
              <div className="source-stat">
                同步仓库后得到的可用候选源，导入后可在书源列表启用。
              </div>
            </div>
            <div className="page-actions">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void loadCandidates()}
                disabled={candidatesLoading}
              >
                <RefreshCw size={14} />
                刷新
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void fixSearch()}>
                修正搜索接口
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!selectedCandidates.size}
                onClick={() => void importCandidates()}
              >
                导入所选（{selectedCandidates.size}）
              </button>
            </div>
          </div>
          <div className="card__body">
            {candidatesLoading ? (
              <div className="empty">正在加载候选池…</div>
            ) : candidates.length === 0 ? (
              <div className="empty">
                <div className="empty__icon">
                  <Database size={22} />
                </div>
                <div className="empty__title">候选池还是空的</div>
                <div className="empty__desc">到「同步中心」跑一次仓库同步，稍后回来查看。</div>
              </div>
            ) : (
              <>
                <label className="candidate-selectall">
                  <input
                    type="checkbox"
                    checked={allCandidatesChecked}
                    onChange={(event) => {
                      setSelectedCandidates(
                        event.target.checked
                          ? new Set(candidates.map((item) => item.name))
                          : new Set(),
                      );
                    }}
                  />
                  全选（{candidates.length}）
                </label>
                <div className="candidate-list">
                  {candidates.map((candidate) => (
                    <label className="candidate-row" key={`${candidate.name}-${candidate.base}`}>
                      <input
                        type="checkbox"
                        checked={selectedCandidates.has(candidate.name)}
                        onChange={() => toggleCandidate(candidate.name)}
                      />
                      <span className="candidate-row__name">{candidate.name}</span>
                      <span className="candidate-row__base" title={candidate.base}>
                        {candidate.base}
                      </span>
                      <span
                        className={`badge ${
                          candidate.status === '新' ? 'badge--success' : 'badge--primary'
                        }`}
                      >
                        {candidate.status}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === 'sync' ? (
        <div className="card">
          <div className="card__head">
            <div>
              <div className="card__title">仓库同步</div>
              <div className="source-stat">
                从社区书源仓库拉取规则，探测可用性并写入候选池；不会直接启用任何源。
              </div>
            </div>
          </div>
          <div className="card__body">
            <div className="form-grid" style={{ maxWidth: 480 }}>
              <label className="field">
                <span>探测数量上限（留空 = 全部）</span>
                <input
                  className="input"
                  inputMode="numeric"
                  value={syncLimit}
                  placeholder="例如 50"
                  onChange={(event) => setSyncLimit(event.target.value)}
                />
              </label>
              <label className="field">
                <span>最少正文字数</span>
                <input
                  className="input"
                  inputMode="numeric"
                  value={syncMinContent}
                  onChange={(event) => setSyncMinContent(event.target.value)}
                />
              </label>
            </div>
            <div className="page-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                disabled={Boolean(sync?.running)}
                onClick={() => void startSync()}
              >
                <RefreshCw size={15} />
                {sync?.running ? '同步进行中…' : '开始同步'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setTab('candidates')}
              >
                查看候选池
              </button>
            </div>

            <div className="sync-status">
              <div className="sync-status__head">
                <span className={`badge ${sync?.running ? 'badge--warn' : 'badge--success'}`}>
                  {sync?.running ? '进行中' : '空闲'}
                </span>
                <span>{stageLabel(sync?.stage)}</span>
                {sync?.processed || sync?.total ? (
                  <span className="source-stat">
                    {sync.processed ?? 0}
                    {sync.total ? ` / ${sync.total}` : ''} 个
                  </span>
                ) : null}
                {sync?.ok ? <span className="source-stat">可用 {sync.ok}</span> : null}
                {sync?.candidates ? (
                  <span className="source-stat">候选 {sync.candidates}</span>
                ) : null}
              </div>
              {sync?.running ? (
                <ProgressBar
                  percent={
                    sync.total && sync.total > 0
                      ? Math.round(((sync.processed ?? 0) * 100) / sync.total)
                      : 0
                  }
                />
              ) : null}
              {sync?.error ? <div className="source-report">{sync.error}</div> : null}
              {sync?.message ? <div className="source-report">{sync.message}</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        title="添加书源"
        open={addOpen}
        onClose={() => setAddOpen(false)}
        width={720}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setAddOpen(false)}>
              取消
            </button>
            <button type="button" className="btn" disabled={addBusy} onClick={() => void submitAdd()}>
              {addBusy ? '添加中…' : '添加'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label className="field">
            <span>名称 *</span>
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>域名 *</span>
            <input
              className="input"
              placeholder="https://example.com"
              value={form.base}
              onChange={(event) => setForm({ ...form, base: event.target.value })}
            />
          </label>
          <label className="field">
            <span>编码</span>
            <select
              className="input"
              value={form.charset}
              onChange={(event) => setForm({ ...form, charset: event.target.value })}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gbk">GBK</option>
            </select>
          </label>
          <label className="field">
            <span>搜索方式</span>
            <select
              className="input"
              value={form.method}
              onChange={(event) => setForm({ ...form, method: event.target.value })}
            >
              <option value="">不配置 / 仅 API</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </label>
          {form.method ? (
            <>
              <label className="field">
                <span>搜索路径</span>
                <input
                  className="input"
                  value={form.path}
                  onChange={(event) => setForm({ ...form, path: event.target.value })}
                />
              </label>
              <label className="field">
                <span>搜索参数名</span>
                <input
                  className="input"
                  value={form.param}
                  onChange={(event) => setForm({ ...form, param: event.target.value })}
                />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span>附加参数 JSON（可选）</span>
                <textarea
                  className="input"
                  rows={2}
                  value={form.extra}
                  onChange={(event) => setForm({ ...form, extra: event.target.value })}
                  placeholder='{"type":"novel"}'
                />
              </label>
            </>
          ) : null}
          <label className="field">
            <span>书籍链接正则</span>
            <input
              className="input"
              value={form.bookPattern}
              onChange={(event) => setForm({ ...form, bookPattern: event.target.value })}
            />
          </label>
          <label className="field">
            <span>章节链接正则</span>
            <input
              className="input"
              value={form.chapterPattern}
              onChange={(event) => setForm({ ...form, chapterPattern: event.target.value })}
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>正文选择器（CSS）</span>
            <input
              className="input"
              value={form.contentSelector}
              onChange={(event) => setForm({ ...form, contentSelector: event.target.value })}
            />
          </label>
          <label className="field">
            <span>目录倒序</span>
            <select
              className="input"
              value={form.tocReverse ? 'true' : 'false'}
              onChange={(event) => setForm({ ...form, tocReverse: event.target.value === 'true' })}
            >
              <option value="false">否</option>
              <option value="true">是</option>
            </select>
          </label>
          <label className="field">
            <span>SSL 校验</span>
            <select
              className="input"
              value={form.verifySsl ? 'true' : 'false'}
              onChange={(event) => setForm({ ...form, verifySsl: event.target.value === 'true' })}
            >
              <option value="true">校验</option>
              <option value="false">不校验</option>
            </select>
          </label>
          <label className="field">
            <span>需要浏览器渲染</span>
            <select
              className="input"
              value={form.render ? 'true' : 'false'}
              onChange={(event) => setForm({ ...form, render: event.target.value === 'true' })}
            >
              <option value="false">否</option>
              <option value="true">是</option>
            </select>
          </label>
          <div className="form-divider">API 搜索（可选，配置后优先走 JSON 接口）</div>
          <label className="field">
            <span>API 搜索 URL</span>
            <input
              className="input"
              value={form.apiUrl}
              onChange={(event) => setForm({ ...form, apiUrl: event.target.value })}
              placeholder="https://example.com/api/search?q={q}"
            />
          </label>
          <label className="field">
            <span>结果列表路径</span>
            <input
              className="input"
              value={form.apiList}
              onChange={(event) => setForm({ ...form, apiList: event.target.value })}
            />
          </label>
          <label className="field">
            <span>书名字段</span>
            <input
              className="input"
              value={form.apiName}
              onChange={(event) => setForm({ ...form, apiName: event.target.value })}
            />
          </label>
          <label className="field">
            <span>作者字段</span>
            <input
              className="input"
              value={form.apiAuthor}
              onChange={(event) => setForm({ ...form, apiAuthor: event.target.value })}
            />
          </label>
          <label className="field">
            <span>ID 字段</span>
            <input
              className="input"
              value={form.apiId}
              onChange={(event) => setForm({ ...form, apiId: event.target.value })}
            />
          </label>
          <label className="field">
            <span>详情 URL 模板</span>
            <input
              className="input"
              value={form.apiUrlTpl}
              onChange={(event) => setForm({ ...form, apiUrlTpl: event.target.value })}
              placeholder="/book/{id}，可用 {id} 占位"
            />
          </label>
        </div>
      </Modal>

      <Modal
        title="导入书源"
        open={importOpen}
        onClose={() => setImportOpen(false)}
        width={620}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(false)}>
              关闭
            </button>
            <button
              type="button"
              className="btn"
              disabled={importBusy}
              onClick={() => void submitImport()}
            >
              {importBusy ? '导入中…' : '导入'}
            </button>
          </>
        }
      >
        <label className="field">
          <span>书源 JSON（支持单个对象或数组）</span>
          <textarea
            className="input"
            rows={10}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder='{"name": "示例书源", "base": "https://example.com", ...}'
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </label>
        {importResult ? (
          <div className="source-report" style={{ marginTop: 10 }}>
            {importResult.imported.length ? (
              <div>
                <Check size={13} /> 导入成功：{importResult.imported.join('、')}
              </div>
            ) : null}
            {importResult.errors.map((error) => (
              <div key={error}>失败：{error}</div>
            ))}
          </div>
        ) : null}
      </Modal>

      <Modal
        title="删除书源"
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void removeSource()}>
              删除
            </button>
          </>
        }
      >
        确定删除自定义书源「{deleteTarget?.name}」？该操作不会影响已下载的书。
      </Modal>
    </div>
  );
}
