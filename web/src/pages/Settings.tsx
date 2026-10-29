import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Database,
  Download,
  FolderOpen,
  Gauge,
  Github,
  Images,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useTheme, type ThemeMode } from '../lib/theme';
import { formatBytes } from '../lib/format';
import { useUpdate } from '../lib/updater';
import { openExternal } from '../lib/desktop';
import { useToast } from '../lib/toast';
import type { ComicSource } from '../lib/types';

type Tab = 'general' | 'data' | 'comic';
type BackupKind = 'novel' | 'comic';

interface CleanRule {
  pattern: string;
  replace?: string;
  limit?: number;
}

interface SettingsPayload {
  proxy?: string;
  delay?: number | string;
  search_timeout?: number | string;
  out_dir?: string;
  verify_ssl?: boolean;
  clean_rules?: CleanRule[];
  manga_cdn_custom?: string[];
  pdf_quality?: string;
}

interface ComicTestResult {
  ok?: boolean;
  ms?: number;
  count?: number;
  error?: string;
}

interface ComicImportResult {
  ok?: boolean;
  added?: number;
  dup?: number;
  errors?: string[];
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const TABS: { value: Tab; label: string; icon: typeof Settings2 }[] = [
  { value: 'general', label: '通用', icon: Settings2 },
  { value: 'data', label: '数据与规则', icon: Database },
  { value: 'comic', label: '漫画', icon: Images },
];

const PDF_QUALITIES = [
  { value: 'original', label: '原图', desc: '体积最大' },
  { value: 'hq', label: '高清', desc: '推荐' },
  { value: 'eco', label: '省流', desc: '体积最小' },
];

function parseCleanRules(text: string): { rules: CleanRule[]; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { rules: [], error: cause instanceof Error ? cause.message : 'JSON 解析失败' };
  }
  if (!Array.isArray(parsed)) return { rules: [], error: '规则必须是 JSON 数组' };
  const rules: CleanRule[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { rules: [], error: `第 ${index + 1} 条不是对象` };
    }
    const rule = item as Record<string, unknown>;
    if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) {
      return { rules: [], error: `第 ${index + 1} 条缺少 pattern` };
    }
    if (rule.replace !== undefined && typeof rule.replace !== 'string') {
      return { rules: [], error: `第 ${index + 1} 条 replace 必须是字符串` };
    }
    if (
      rule.limit !== undefined &&
      (typeof rule.limit !== 'number' || !Number.isFinite(rule.limit) || rule.limit < 0)
    ) {
      return { rules: [], error: `第 ${index + 1} 条 limit 必须是非负数字` };
    }
    rules.push({
      pattern: rule.pattern,
      replace: typeof rule.replace === 'string' ? rule.replace : '',
      ...(typeof rule.limit === 'number' ? { limit: rule.limit } : {}),
    });
  }
  return { rules, error: '' };
}

function dateStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  const { state, appVersion, bridgeAvailable, check, download, install, openDownloadPage } = useUpdate();
  // Dev 通道:与手机端一致,开启后检查预发布版本
  // 同步管理:电脑侧的逐章进度(手机回传 + 本机阅读都记在这里)
  const [syncRecords, setSyncRecords] = useState<{
    book: string; title?: string; ch?: number; total?: number; percent?: number; updated?: number;
  }[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setSyncLoading(true);
    apiGet<{ records?: Record<string, { title?: string; ch?: number; total?: number; percent?: number; updated?: number }> }>('/api/reading_progress')
      .then((data) => {
        if (!alive) return;
        const list = Object.entries(data.records || {}).map(([book, rec]) => ({ book, ...rec }));
        list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        setSyncRecords(list.slice(0, 20));
      })
      .catch(() => { /* 老后端没有该接口时忽略 */ })
      .finally(() => { if (alive) setSyncLoading(false); });
    return () => { alive = false; };
  }, []);
  const [devChannel, setDevChannel] = useState(false);
  useEffect(() => {
    window.desktop?.updater?.getPrerelease?.()
      .then((flag) => setDevChannel(Boolean(flag)))
      .catch(() => { /* 旧版壳没有该接口 */ });
  }, []);
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('general');
  const [loading, setLoading] = useState(true);
  const [dataDir, setDataDir] = useState('');

  const [proxy, setProxy] = useState('');
  const [delaySec, setDelaySec] = useState('1.2');
  const [timeoutSec, setTimeoutSec] = useState('60');
  const [outDir, setOutDir] = useState('downloads');
  const [verifySsl, setVerifySsl] = useState(true);
  const [savingGeneral, setSavingGeneral] = useState(false);

  const [cleanJson, setCleanJson] = useState('[]');
  const [savedCleanJson, setSavedCleanJson] = useState('[]');
  const [savingClean, setSavingClean] = useState(false);

  const [cdns, setCdns] = useState<string[]>([]);
  const [cdnInput, setCdnInput] = useState('');
  const [savingCdn, setSavingCdn] = useState(false);
  const [pdfQuality, setPdfQuality] = useState('hq');

  const [comicSources, setComicSources] = useState<ComicSource[]>([]);
  const [comicLoading, setComicLoading] = useState(false);
  const [comicLoaded, setComicLoaded] = useState(false);
  const [toggleBusy, setToggleBusy] = useState('');
  const [testing, setTesting] = useState('');
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [deleteSource, setDeleteSource] = useState<ComicSource | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [backupBusy, setBackupBusy] = useState<BackupKind | ''>('');
  const [importKind, setImportKind] = useState<BackupKind>('novel');
  const shelfFileRef = useRef<HTMLInputElement>(null);

  const cleanPreview = useMemo(() => parseCleanRules(cleanJson), [cleanJson]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ settings?: SettingsPayload; data_dir?: string }>('/api/settings');
      const settings = data.settings ?? {};
      setDataDir(data.data_dir ?? '');
      setProxy(String(settings.proxy ?? ''));
      const rawDelay = settings.delay;
      setDelaySec(
        typeof rawDelay === 'number' && Number.isFinite(rawDelay)
          ? String(rawDelay)
          : rawDelay === 'auto' || rawDelay === undefined
            ? '0.5'
            : String(rawDelay),
      );
      setTimeoutSec(String(settings.search_timeout ?? 60));
      setOutDir(String(settings.out_dir ?? 'downloads'));
      setVerifySsl(settings.verify_ssl !== false);
      const rules = Array.isArray(settings.clean_rules) ? settings.clean_rules : [];
      const text = JSON.stringify(rules, null, 2);
      setCleanJson(text);
      setSavedCleanJson(text);
      setCdns((settings.manga_cdn_custom ?? []).map(String));
      setPdfQuality(
        ['original', 'hq', 'eco'].includes(String(settings.pdf_quality))
          ? String(settings.pdf_quality)
          : 'hq',
      );
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadComicSources = useCallback(async () => {
    setComicLoading(true);
    try {
      const data = await apiGet<{ sources?: ComicSource[] }>('/api/comic_sources');
      setComicSources(data.sources ?? []);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setComicLoading(false);
      setComicLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    if (tab === 'comic' && !comicLoaded) void loadComicSources();
  }, [tab, comicLoaded, loadComicSources]);

  const openDataDir = async () => {
    if (!window.desktop) {
      toast('仅桌面版支持打开数据目录', 'error');
      return;
    }
    await window.desktop.openDataDir();
  };

  const saveGeneral = async () => {
    const delayValue = Number(delaySec);
    if (!Number.isFinite(delayValue) || delayValue < 0) {
      toast('章节间隔需为 0 以上的数字', 'error');
      return;
    }
    const timeoutValue = Number.parseInt(timeoutSec, 10);
    if (!Number.isFinite(timeoutValue) || timeoutValue < 0) {
      toast('搜索等待上限需为 0 以上的整数', 'error');
      return;
    }
    const nextOut = outDir.trim() || 'downloads';
    setSavingGeneral(true);
    try {
      const result = await apiPost<{ ok?: boolean; restart_required?: boolean }>('/api/settings', {
        proxy: proxy.trim(),
        delay: delayValue,
        search_timeout: timeoutValue,
        out_dir: nextOut,
        verify_ssl: verifySsl,
      });
      setProxy(proxy.trim());
      setOutDir(nextOut);
      setTimeoutSec(String(timeoutValue));
      toast('设置已保存', 'success');
      if (result.restart_required) toast('局域网访问开关已变更，重启应用后生效', 'info');
    } catch (cause) {
      toast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveClean = async () => {
    if (cleanPreview.error) {
      toast(`规则格式有误：${cleanPreview.error}`, 'error');
      return;
    }
    setSavingClean(true);
    try {
      await apiPost('/api/settings', { clean_rules: cleanPreview.rules });
      setSavedCleanJson(cleanJson);
      toast(`已保存 ${cleanPreview.rules.length} 条净化规则`, 'success');
    } catch (cause) {
      toast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setSavingClean(false);
    }
  };

  const saveCdns = async (next: string[]) => {
    const previous = cdns;
    setCdns(next);
    setSavingCdn(true);
    try {
      await apiPost('/api/settings', { manga_cdn_custom: next });
      toast('CDN 设置已保存', 'success');
    } catch (cause) {
      setCdns(previous);
      toast(`CDN 保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setSavingCdn(false);
    }
  };

  const addCdn = () => {
    const value = cdnInput.trim().replace(/^https?:\/\//i, '').split('/')[0];
    if (!value) {
      toast('请输入镜像域名', 'error');
      return;
    }
    if (cdns.includes(value)) {
      toast('该域名已在列表中', 'info');
      return;
    }
    if (cdns.length >= 8) {
      toast('最多添加 8 个 CDN', 'error');
      return;
    }
    setCdnInput('');
    void saveCdns([...cdns, value]);
  };

  const makeCdnDefault = (index: number) => {
    const next = [...cdns];
    const [picked] = next.splice(index, 1);
    next.unshift(picked);
    void saveCdns(next);
  };

  const removeCdn = (index: number) => {
    void saveCdns(cdns.filter((_, itemIndex) => itemIndex !== index));
  };

  const savePdfQuality = async (value: string) => {
    const previous = pdfQuality;
    setPdfQuality(value);
    try {
      await apiPost('/api/settings', { pdf_quality: value });
      toast('PDF 图片质量已保存', 'success');
    } catch (cause) {
      setPdfQuality(previous);
      toast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    }
  };

  const toggleComicSource = async (source: ComicSource, enabled: boolean) => {
    setToggleBusy(source.key);
    try {
      await apiPost('/api/comic_source_toggle', { name: source.key, enabled });
      setComicSources((prev) =>
        prev.map((item) => (item.key === source.key ? { ...item, enabled } : item)),
      );
      toast(enabled ? `已启用「${source.name}」` : `已停用「${source.name}」`, enabled ? 'success' : 'info');
    } catch (cause) {
      toast(`切换失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setToggleBusy('');
    }
  };

  const testComicSource = async (key: string) => {
    setTesting(key);
    setTestResults((prev) => ({ ...prev, [key]: '测试中…' }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch('/api/comic_source_test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: key }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: ComicTestResult;
        error?: string;
      };
      const result = data.result;
      let text: string;
      if (data.ok && result) {
        text = result.ok
          ? `${result.ms ?? 0} ms · ${result.count ?? 0} 条`
          : `✗ ${String(result.error || '失败').slice(0, 60)}`;
      } else {
        text = `✗ ${String(data.error || '失败').slice(0, 60)}`;
      }
      setTestResults((prev) => ({ ...prev, [key]: text }));
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      setTestResults((prev) => ({
        ...prev,
        [key]: aborted ? '✗ 超时' : `✗ ${cause instanceof Error ? cause.message : String(cause)}`,
      }));
    } finally {
      window.clearTimeout(timer);
      setTesting('');
    }
  };

  const submitImport = async () => {
    const text = importJson.trim();
    if (!text) {
      toast('请粘贴漫画源规则 JSON', 'error');
      return;
    }
    setImporting(true);
    try {
      const result = await apiPost<ComicImportResult>('/api/comic_source_import', { json: text });
      const parts = [`导入 ${result.added ?? 0} 个漫画源`];
      if (result.dup) parts.push(`更新 ${result.dup} 个同名源`);
      if (result.errors?.length) parts.push(`跳过 ${result.errors.length} 条`);
      toast(parts.join('，'), 'success');
      setImportOpen(false);
      setImportJson('');
      void loadComicSources();
    } catch (cause) {
      toast(`导入失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  const confirmDeleteSource = async () => {
    if (!deleteSource) return;
    setDeleting(true);
    try {
      await apiDelete('/api/comic_source', { key: deleteSource.key });
      toast(`已删除「${deleteSource.name}」`, 'success');
      setDeleteSource(null);
      void loadComicSources();
    } catch (cause) {
      toast(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const backupShelf = async (kind: BackupKind) => {
    setBackupBusy(kind);
    try {
      const data = await apiGet<{ shelf?: unknown[] }>(
        kind === 'novel' ? '/api/shelf_backup' : '/api/comic_shelf_backup',
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${kind === 'novel' ? '小说' : '漫画'}书架备份-${dateStamp()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(
        `已导出 ${data.shelf?.length ?? 0} ${kind === 'novel' ? '本' : '部'}`,
        'success',
      );
    } catch (cause) {
      toast(`备份失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBackupBusy('');
    }
  };

  const pickShelfFile = (kind: BackupKind) => {
    setImportKind(kind);
    if (shelfFileRef.current) {
      shelfFileRef.current.value = '';
      shelfFileRef.current.click();
    }
  };

  const onShelfFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const shelf = Array.isArray(parsed)
        ? parsed
        : (parsed as { shelf?: unknown } | null)?.shelf;
      if (!Array.isArray(shelf) || !shelf.length) {
        toast('文件中没有书架数据', 'error');
        return;
      }
      const result = await apiPost<{ ok?: boolean; added?: number; total?: number }>(
        importKind === 'novel' ? '/api/shelf_import' : '/api/comic_shelf_import',
        { shelf },
      );
      toast(
        importKind === 'novel'
          ? `导入完成：新增 ${result.added ?? 0} 本，共 ${result.total ?? 0} 本`
          : `导入完成：新增 ${result.added ?? 0} 部`,
        'success',
      );
    } catch (cause) {
      toast(`导入失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      event.target.value = '';
    }
  };

  const enabledSources = comicSources.filter((source) => source.enabled).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-desc">通用选项、数据规则与漫画偏好。</p>
        </div>
      </div>

      <div className="segmented settings-tabs" role="tablist" aria-label="设置分类">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              className={tab === item.value ? 'is-on' : ''}
              onClick={() => setTab(item.value)}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="empty">正在读取设置…</div>
      ) : tab === 'general' ? (
        <div className="settings-panel">
          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">网络与下载</div>
                <div className="settings-card__desc">
                  代理、章节间隔与聚合搜索等待上限，保存后即时生效。
                </div>
              </div>
            </div>
            <div className="settings-form">
              <label className="field field--full">
                <span>代理地址（留空 = 直连）</span>
                <input
                  className="input"
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                />
              </label>
              <label className="field">
                <span>默认章节间隔（秒）</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.1}
                  value={delaySec}
                  onChange={(event) => setDelaySec(event.target.value)}
                />
              </label>
              <label className="field">
                <span>搜索等待上限（秒，0 = 不限时）</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={5}
                  value={timeoutSec}
                  onChange={(event) => setTimeoutSec(event.target.value)}
                />
              </label>
              <label className="field field--full">
                <span>默认输出目录</span>
                <input
                  className="input"
                  value={outDir}
                  onChange={(event) => setOutDir(event.target.value)}
                  placeholder="downloads"
                />
              </label>
              <label className="field">
                <span>SSL 证书校验</span>
                <select
                  className="input"
                  value={verifySsl ? 'true' : 'false'}
                  onChange={(event) => setVerifySsl(event.target.value === 'true')}
                >
                  <option value="true">校验（推荐）</option>
                  <option value="false">不校验（兼容证书过期站点）</option>
                </select>
              </label>
            </div>
            <div className="settings-hint">
              聚合搜索到上限后用已完成源的结果收口，未返回的源标记「超时」；相对输出目录以数据目录为基准。
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void saveGeneral()}
                disabled={savingGeneral}
              >
                <Save size={15} />
                {savingGeneral ? '保存中…' : '保存设置'}
              </button>
            </div>
          </section>

          <div className="settings-section">
            <div className="settings-row">
              <div>
                <div className="settings-row__title">外观</div>
                <div className="settings-row__desc">深色模式会同步应用到所有新界面。</div>
              </div>
              <div className="segmented" role="group" aria-label="主题">
                {THEMES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={mode === item.value ? 'is-on' : ''}
                    onClick={() => setMode(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__title">接收 Dev 版本</div>
                <div className="settings-row__desc">开启后检查更新会包含预发布版本，仅建议测试机使用</div>
              </div>
              <button
                type="button"
                className={`switch${devChannel ? ' is-on' : ''}`}
                disabled={!bridgeAvailable}
                onClick={async () => {
                  const next = !devChannel;
                  setDevChannel(next);
                  try {
                    await window.desktop?.updater?.setPrerelease?.(next);
                  } catch {
                    /* 忽略：下次重启仍以文件中的值为准 */
                  }
                }}
              >
                <i />
              </button>
            </div>

            <div className="settings-row">
              <div style={{ width: '100%' }}>
                <div className="settings-row__title">同步管理</div>
                <div className="settings-row__desc">
                  {syncLoading
                    ? '读取中…'
                    : syncRecords.length
                      ? '电脑侧的逐章进度（含手机回传），按最后阅读时间排序'
                      : '还没有任何阅读记录'}
                </div>
                {syncRecords.length > 0 && (
                  <div className="sync-mini">
                    {syncRecords.map((rec) => (
                      <div key={rec.book} className="sync-mini__row">
                        <span className="sync-mini__name" title={rec.title || rec.book}>
                          {rec.title || rec.book}
                        </span>
                        <span className="sync-mini__meta">
                          {rec.ch || 0}/{rec.total || 0} 章
                        </span>
                        <span className="sync-mini__bar">
                          <i style={{ width: `${Math.min(100, rec.percent || 0)}%` }} />
                        </span>
                        <span className="sync-mini__pct">{rec.percent || 0}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="settings-row__title">版本更新</div>
                <div className="settings-row__desc">
                  当前 v{appVersion}
                  {!bridgeAvailable
                    ? ' · 浏览器模式不支持检查更新'
                    : state.phase === 'available'
                      ? ` · 发现 v${state.version}${state.size ? `（${formatBytes(state.size)}）` : ''}`
                      : state.phase === 'downloaded'
                        ? ` · 新版 v${state.version} 已下载，等待安装`
                        : state.phase === 'downloading'
                          ? ` · 正在下载 v${state.version}`
                          : state.phase === 'error'
                            ? ` · ${state.message ?? '检查失败'}`
                            : ' · GitHub Releases 通道'}
                </div>
                {(state.phase === 'downloading' || state.phase === 'downloaded') && (
                  <div className="settings-update">
                    <div className="settings-update__bar">
                      <i style={{ width: `${Math.min(100, state.percent ?? 0)}%` }} />
                    </div>
                    <div className="settings-update__meta">
                      <span>
                        {state.phase === 'downloaded'
                          ? '下载完成 · 校验通过'
                          : `${formatBytes(state.transferred)} / ${formatBytes(state.total)}`}
                      </span>
                      <span>
                        {state.phase === 'downloading'
                          ? `${(state.percent ?? 0).toFixed(1)}%${state.bytesPerSecond ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ''}`
                          : '100%'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {state.phase === 'available' ? (
                  <>
                    <button type="button" className="btn" onClick={download}>
                      <Download size={15} />
                      下载更新
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={openDownloadPage}>
                      发布页
                    </button>
                  </>
                ) : state.phase === 'downloaded' ? (
                  <button type="button" className="btn" onClick={install}>
                    <Download size={15} />
                    安装并重启
                  </button>
                ) : state.phase === 'error' ? (
                  <>
                    <button type="button" className="btn btn--ghost" onClick={openDownloadPage}>
                      发布页
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={check}>
                      <RefreshCw size={15} />
                      重试
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={check}
                    disabled={!bridgeAvailable || state.phase === 'checking' || state.phase === 'downloading'}
                  >
                    <RefreshCw size={15} />
                    {state.phase === 'checking'
                      ? '检查中…'
                      : state.phase === 'downloading'
                        ? '下载中…'
                        : '检查更新'}
                  </button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__title">数据目录</div>
                <div className="settings-row__desc" title={dataDir}>
                  {dataDir || '书架、配置、下载文件都保存在这里。'}
                </div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => void openDataDir()}>
                <FolderOpen size={15} />
                打开目录
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__title">关于</div>
                <div className="settings-row__desc">
                  NovelCrawler · 多源小说 / 漫画聚合下载器 · GPL-3.0
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => openExternal('https://github.com/Origin-XiChen/NovelCrawler')}
              >
                <Github size={15} />
                GitHub
              </button>
            </div>
          </div>
        </div>
      ) : tab === 'data' ? (
        <div className="settings-panel">
          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">净化规则</div>
                <div className="settings-card__desc">
                  对后续抓取的正文做正则替换，用于清理广告残留。
                </div>
              </div>
              <span className={`badge ${cleanPreview.error ? 'badge--danger' : 'badge--primary'}`}>
                {cleanPreview.error ? '格式有误' : `${cleanPreview.rules.length} 条`}
              </span>
            </div>
            <textarea
              className="input settings-textarea"
              rows={10}
              spellCheck={false}
              value={cleanJson}
              onChange={(event) => setCleanJson(event.target.value)}
              placeholder='[{"pattern":"记住本站网址[^\\n]{0,40}","replace":""}]'
            />
            <div className="settings-hint">
              每条规则：pattern（正则）、replace（替换文本）、可选 limit（次数）。JSON 中的反斜杠需转义（如
              \\n）；保存后对新抓取章节生效。
            </div>
            {cleanPreview.error ? (
              <div className="settings-error">规则格式有误：{cleanPreview.error}</div>
            ) : null}
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setCleanJson(savedCleanJson)}
                disabled={cleanJson === savedCleanJson}
              >
                <RotateCcw size={15} />
                还原
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void saveClean()}
                disabled={savingClean || Boolean(cleanPreview.error)}
              >
                <Save size={15} />
                {savingClean ? '保存中…' : '保存规则'}
              </button>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">书架备份与导入</div>
                <div className="settings-card__desc">
                  导出为 JSON；导入时按书籍链接 / 漫画标识去重合并。
                </div>
              </div>
            </div>
            <div className="settings-backup-grid">
              <div className="settings-backup">
                <div className="settings-backup__title">小说书架</div>
                <div className="settings-backup__desc">包含标签、评分与分类。</div>
                <div className="settings-backup__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void backupShelf('novel')}
                    disabled={backupBusy === 'novel'}
                  >
                    <Download size={14} />
                    {backupBusy === 'novel' ? '导出中…' : '备份'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => pickShelfFile('novel')}
                  >
                    <Upload size={14} />
                    导入
                  </button>
                </div>
              </div>
              <div className="settings-backup">
                <div className="settings-backup__title">漫画书架</div>
                <div className="settings-backup__desc">包含收藏的封面与阅读进度。</div>
                <div className="settings-backup__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void backupShelf('comic')}
                    disabled={backupBusy === 'comic'}
                  >
                    <Download size={14} />
                    {backupBusy === 'comic' ? '导出中…' : '备份'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => pickShelfFile('comic')}
                  >
                    <Upload size={14} />
                    导入
                  </button>
                </div>
              </div>
            </div>
            <input
              ref={shelfFileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void onShelfFile(event)}
            />
          </section>
        </div>
      ) : (
        <div className="settings-panel">
          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">漫画源</div>
                <div className="settings-card__desc">
                  已启用 {enabledSources} / 共 {comicSources.length} 个源 · 停用后搜索与下载不再使用
                </div>
              </div>
              <div className="settings-actions settings-actions--inline">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void loadComicSources()}
                  disabled={comicLoading}
                >
                  <RefreshCw size={14} className={comicLoading ? 'spin' : ''} />
                  刷新
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setImportOpen(true)}>
                  <Plus size={14} />
                  导入源
                </button>
              </div>
            </div>
            {comicLoading && !comicSources.length ? (
              <div className="empty">加载中…</div>
            ) : comicSources.length ? (
              <div className="settings-list">
                {comicSources.map((source) => (
                  <div className="settings-list__row" key={source.key}>
                    <input
                      type="checkbox"
                      className="settings-check"
                      checked={source.enabled}
                      disabled={toggleBusy === source.key}
                      onChange={(event) => void toggleComicSource(source, event.target.checked)}
                      aria-label={`启用 ${source.name}`}
                    />
                    <div className="settings-list__main">
                      <div className="settings-list__title">
                        <span className="settings-list__name">{source.name}</span>
                        {source.custom ? (
                          <span className="badge badge--primary">自定义</span>
                        ) : null}
                        {source.needs_proxy ? (
                          <span className="badge badge--warn">需代理</span>
                        ) : null}
                      </div>
                      <div className="settings-list__meta" title={source.note || ''}>
                        {source.note || (source.custom ? '自定义源' : '内置源')}
                      </div>
                    </div>
                    <span className="settings-list__result">{testResults[source.key] || ''}</span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={testing === source.key}
                      onClick={() => void testComicSource(source.key)}
                    >
                      <Gauge size={14} />
                      {testing === source.key ? '测试中…' : '测速'}
                    </button>
                    {source.custom ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setDeleteSource(source)}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">暂无漫画源</div>
            )}
            <div className="settings-hint">
              自定义源来自订阅同步或粘贴导入；删除仅移除本地规则，订阅源重新同步可恢复。
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">MangaDex 图片 CDN（镜像）</div>
                <div className="settings-card__desc">
                  首个为默认镜像 · 失败自动回退官方节点 · 保存后即时生效
                </div>
              </div>
            </div>
            {cdns.length ? (
              <div className="settings-list settings-list--compact">
                {cdns.map((cdn, index) => (
                  <div className="settings-list__row" key={cdn}>
                    <span className="settings-list__name settings-list__name--mono">{cdn}</span>
                    {index === 0 ? (
                      <span className="badge badge--primary">默认</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => makeCdnDefault(index)}
                        disabled={savingCdn}
                      >
                        <ArrowUp size={14} />
                        设为默认
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--icon"
                      aria-label={`删除 ${cdn}`}
                      onClick={() => removeCdn(index)}
                      disabled={savingCdn}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-empty">未添加自定义 CDN · 当前使用 API 返回的官方节点</div>
            )}
            <div className="settings-inline-form">
              <input
                className="input"
                value={cdnInput}
                onChange={(event) => setCdnInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCdn();
                  }
                }}
                placeholder="输入镜像域名，如 xxx.mangadex.network（可带协议头）"
              />
              <button type="button" className="btn" onClick={addCdn} disabled={savingCdn}>
                <Plus size={15} />
                添加
              </button>
            </div>
            <div className="settings-hint">
              未添加时使用官方节点；官方节点慢或不可达时可添加第三方镜像，对下载与在线阅读生效。
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card__head">
              <div>
                <div className="settings-card__title">漫画 PDF 图片质量</div>
                <div className="settings-card__desc">仅对新下载生效，已下载文件不变。</div>
              </div>
            </div>
            <div className="segmented" role="group" aria-label="PDF 图片质量">
              {PDF_QUALITIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={pdfQuality === item.value ? 'is-on' : ''}
                  onClick={() => void savePdfQuality(item.value)}
                >
                  {item.label}
                  <span className="settings-seg-hint">{item.desc}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <Modal
        title="导入漫画源"
        open={importOpen}
        onClose={() => setImportOpen(false)}
        width={640}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void submitImport()}
              disabled={importing}
            >
              {importing ? '导入中…' : '导入'}
            </button>
          </>
        }
      >
        <div className="settings-hint" style={{ marginBottom: 10 }}>
          支持单条或数组（Cimoc 风格 JSON）；同名源会被更新，格式错误的条目会被跳过。
        </div>
        <textarea
          className="input settings-textarea"
          rows={12}
          spellCheck={false}
          value={importJson}
          onChange={(event) => setImportJson(event.target.value)}
          placeholder='{ "name": "示例源", "base": "https://example.com", ... }'
        />
        <details className="verify-manual" style={{ marginTop: 12 }}>
          <summary>规则格式说明</summary>
          <div className="verify-manual__body">
            <p>
              search / toc / pages 三段规则，支持 json 与 html 解析。
              可粘贴别人分享的整条规则，导入后立即生效并进入漫画源列表。
            </p>
          </div>
        </details>
      </Modal>

      <Modal
        title="删除自定义漫画源"
        open={Boolean(deleteSource)}
        onClose={() => setDeleteSource(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDeleteSource(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void confirmDeleteSource()}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.8 }}>
          确定删除「{deleteSource?.name ?? ''}」？删除仅移除本地规则，不影响订阅本身；
          订阅源重新同步可恢复。
        </p>
      </Modal>
    </div>
  );
}
