import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import type { PendingVerify, VerifiedSite, VerifyCapability } from '../lib/types';

function targetOf(item: PendingVerify) {
  return item.url && item.url.startsWith('http') ? item.url : `https://${item.host}/`;
}

function verifyDate(value?: number) {
  return value ? new Date(value * 1000).toLocaleDateString('zh-CN') : '—';
}

export function VerifyPage() {
  const { toast } = useToast();
  const [capability, setCapability] = useState<VerifyCapability | null>(null);
  const [verified, setVerified] = useState<VerifiedSite[]>([]);
  const [pending, setPending] = useState<PendingVerify[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<VerifiedSite | null>(null);
  const manualRef = useRef<HTMLDetailsElement>(null);
  const manualTouched = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, pendingData, cap] = await Promise.all([
        apiGet<{ verified: (VerifiedSite | string)[] }>('/api/verify_status'),
        apiGet<{ pending: PendingVerify[] }>('/api/verify_pending'),
        apiGet<VerifyCapability>('/api/verify_capability').catch(() => null),
      ]);
      setVerified(
        (status.verified ?? []).map((item) =>
          typeof item === 'string' ? { host: item } : { ...item, host: item.host ?? '' },
        ),
      );
      setPending(pendingData.pending ?? []);
      setCapability(cap);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const autoAvailable = Boolean(capability?.playwright && capability.driver !== false);

  useEffect(() => {
    if (!manualRef.current || capability === null || manualTouched.current) return;
    manualRef.current.open = !autoAvailable;
  }, [capability, autoAvailable]);

  const startVerify = async (targetUrl: string, targetName: string) => {
    if (!targetUrl.startsWith('http')) {
      toast('请填写需要验证的完整网址（http/https）', 'error');
      return;
    }
    if (!autoAvailable) {
      toast('自动验证不可用，已切换到手动方式', 'info');
      setUrl(targetUrl);
      setName(targetName);
      if (manualRef.current) manualRef.current.open = true;
      return;
    }
    setBusy('verify');
    toast('已打开浏览器窗口，请完成人机验证…', 'info');
    try {
      const data = await apiPost<{ ok?: boolean; host?: string; cookies?: number }>('/api/verify', {
        url: targetUrl,
        name: targetName,
      });
      if (!data.ok) throw new Error('未检测到验证通过');
      toast(`验证通过：${data.host ?? targetName}（${data.cookies ?? 0} 个 cookies）`, 'success');
      setUrl('');
      setName('');
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast(`验证失败：${message}`, 'error');
      setUrl(targetUrl);
      setName(targetName);
      if (manualRef.current) manualRef.current.open = true;
    } finally {
      setBusy('');
    }
  };

  const openBrowser = async () => {
    if (!url.startsWith('http')) {
      toast('请先填写需要验证的完整网址', 'error');
      return;
    }
    setBusy('open');
    try {
      const data = await apiPost<{ ok?: boolean; error?: string }>('/api/verify_open', { url });
      if (!data.ok) throw new Error(data.error || '系统未能打开浏览器');
      toast('已用系统浏览器打开，完成验证后请复制 Cookie', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const saveCookie = async () => {
    if (!url.startsWith('http')) {
      toast('请先填写需要验证的完整网址', 'error');
      return;
    }
    if (!cookie.trim()) {
      toast('请先粘贴 Cookie 内容', 'error');
      return;
    }
    setBusy('cookie');
    try {
      const data = await apiPost<{ ok?: boolean; host?: string; cookies?: number }>(
        '/api/verify_cookie',
        { url, name, cookie },
      );
      if (!data.ok) throw new Error('校验未通过');
      toast(`验证通过：${data.host}（${data.cookies ?? 0} 个 cookies）`, 'success');
      setCookie('');
      setUrl('');
      setName('');
      await load();
    } catch (cause) {
      toast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const manualFor = (item: PendingVerify) => {
    setUrl(targetOf(item));
    setName(item.name || item.host);
    if (manualRef.current) manualRef.current.open = true;
    toast('已填入验证目标，请用系统浏览器完成验证后粘贴 Cookie', 'info');
  };

  const ignorePending = async (host: string) => {
    setBusy(`ignore:${host}`);
    try {
      await apiDelete('/api/verify_pending', { host });
      toast('已忽略该待验证项', 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const removeVerified = async () => {
    if (!deleteTarget) return;
    const host = deleteTarget.host;
    setDeleteTarget(null);
    setBusy(`del:${host}`);
    try {
      await apiDelete('/api/verify', { host });
      toast('已删除验证记录', 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">验证中心</h1>
          <p className="page-desc">
            为遇到 403 / 401 或 Cloudflare 人机验证的站点保存 cookies，书籍、漫画与 OPDS 通用。
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn--ghost" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={15} />
            重新体检
          </button>
        </div>
      </div>

      <div
        className="verify-cap"
        style={{
          borderColor: autoAvailable ? 'var(--success)' : 'var(--warn)',
        }}
      >
        {autoAvailable ? (
          <CheckCircle2 size={18} style={{ color: 'var(--success)' }} />
        ) : (
          <ShieldQuestion size={18} style={{ color: 'var(--warn)' }} />
        )}
        <div>
          {autoAvailable ? (
            <>
              <b>自动验证可用</b>：点击验证后会弹出内置浏览器窗口，完成人机验证即自动保存
              cookies
              {capability?.channels?.length ? `（内核：${capability.channels.join('/')}）` : ''}
              {capability?.driver_src ? ` · 驱动：${capability.driver_src}` : ''}
            </>
          ) : (
            <>
              <b>自动验证不可用</b>
              {capability?.error ? `：${capability.error}` : ''}。请使用下方手动方式（免依赖）。
            </>
          )}
        </div>
      </div>

      <div className="verify-form">
        <label className="field" style={{ width: 150 }}>
          <span>服务名称</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 240 }}>
          <span>需要验证的网址</span>
          <input
            className="input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.gutenberg.org/opds/"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void startVerify(url.trim(), name.trim());
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy === 'verify'}
          onClick={() => void startVerify(url.trim(), name.trim())}
        >
          <ShieldCheck size={15} />
          {busy === 'verify' ? '验证中…' : autoAvailable ? '发起验证' : '手动验证'}
        </button>
      </div>

      <details
        className="verify-manual"
        ref={manualRef}
        onToggle={() => {
          manualTouched.current = true;
        }}
      >
        <summary>手动方式（免依赖）：系统浏览器验证 → 粘贴 Cookie</summary>
        <div className="verify-manual__body">
          <p>
            1) 用系统浏览器打开验证页；
            <br />
            2) 完成人机验证，直到页面能正常显示内容；
            <br />
            3) 按 F12 → Network → 刷新页面 → 点第一个请求 → Headers，复制{' '}
            <code>Cookie:</code> 整行；
            <br />
            4) 粘贴到下方并保存，后端会实际请求一次确认可读后才落盘。
          </p>
          <div className="verify-manual__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy === 'open'}
              onClick={() => void openBrowser()}
            >
              <ExternalLink size={14} />
              用系统浏览器打开
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy === 'cookie'}
              onClick={() => void saveCookie()}
            >
              校验并保存 Cookie
            </button>
          </div>
          <textarea
            className="input"
            style={{ width: '100%', height: 84, marginTop: 8, fontFamily: 'monospace' }}
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="粘贴 Cookie，形如：cf_clearance=xxx; sessionid=yyy"
          />
          <div className="verify-manual__hint">
            Cookie 不要外传；Cloudflare 站点请确认包含 <code>cf_clearance</code>。
          </div>
        </div>
      </details>

      <h2 className="section-title">待验证（请求遇到 403/401 自动收集）</h2>
      {pending.length === 0 ? (
        <div className="empty">暂无待验证的服务</div>
      ) : (
        <div className="source-list">
          {pending.map((item) => (
            <div className="source-row" key={item.host}>
              <div className="source-row__main">
                <div className="source-row__title">
                  <span className="source-row__name">{item.name || item.host}</span>
                  <span className="badge badge--warn">待验证</span>
                </div>
                <div className="source-row__domain">
                  {item.host} · 验证目标：{targetOf(item)}
                </div>
              </div>
              <div className="source-row__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy === 'verify'}
                  onClick={() => void startVerify(targetOf(item), item.name || item.host)}
                >
                  {autoAvailable ? '验证' : '手动验证'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => manualFor(item)}
                >
                  粘贴 Cookie
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy === `ignore:${item.host}`}
                  onClick={() => void ignorePending(item.host)}
                >
                  忽略
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">已验证</h2>
      {verified.length === 0 ? (
        <div className="empty">无已验证站点</div>
      ) : (
        <div className="source-list">
          {verified.map((item) => (
            <div className="source-row" key={item.host}>
              <div className="source-row__main">
                <div className="source-row__title">
                  <span className="source-row__name">{item.name || item.host}</span>
                  {item.expired ? (
                    <span className="badge badge--danger">已过期</span>
                  ) : (
                    <span className="badge badge--success">有效</span>
                  )}
                </div>
                <div className="source-row__domain">
                  {item.host} · 最近验证 {verifyDate(item.ts ?? item.last_ok)}
                </div>
              </div>
              <div className="source-row__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy === `del:${item.host}`}
                  onClick={() => setDeleteTarget(item)}
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title="删除验证记录"
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void removeVerified()}>
              <Trash2 size={14} />
              删除
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.8 }}>
          删除「{deleteTarget?.name || deleteTarget?.host}」的验证记录后，该站点需要重新验证。
        </p>
      </Modal>
    </div>
  );
}
