import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  Check,
  ChevronRight,
  Loader2,
  ScanLine,
  Server,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-react';
import ScannerModal from '../components/ScannerModal';
import { checkServer, pingServer, pairServer } from '../lib/api';
import {
  detectDeviceName,
  getDeviceId,
  getServers,
  normalizeBaseUrl,
  parsePairPayload,
  removeServer,
  saveServer,
  setActiveServer,
  touchServer,
} from '../lib/connection';
import { errorMessage } from '../lib/format';
import { IS_NATIVE } from '../lib/native';
import type { ServerEntry } from '../lib/types';

function cleanPairQuery() {
  const url = new URL(window.location.href);
  for (const key of ['pair', 'code', 'v', 'name']) url.searchParams.delete(key);
  const [hashPath, hashQuery] = url.hash.split('?');
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    for (const key of ['pair', 'code', 'v', 'name']) params.delete(key);
    url.hash = params.size ? `${hashPath}?${params.toString()}` : hashPath;
  }
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}

export default function ConnectPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [servers, setServers] = useState<ServerEntry[]>(() => getServers());
  const [mode, setMode] = useState<'choose' | 'manual'>('choose');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const autoRan = useRef(false);
  const doPairRef = useRef<(base: string, pairCode: string) => Promise<void>>(
    async () => undefined,
  );
  const expired = searchParams.get('expired') === '1';

  const doPair = useCallback(
    async (baseInput: string, pairCode: string) => {
      setBusy('pair');
      setError('');
      setInfo('');
      try {
        const base = normalizeBaseUrl(baseInput);
        if (!/^\d{6}$/.test(pairCode.trim())) throw new Error('请输入 6 位配对码');
        let ping;
        try {
          ping = await pingServer(base);
        } catch (cause) {
          throw new Error(
            `连不上电脑（${errorMessage(cause)}）。请确认电脑已开机、已开启局域网访问，并与手机在同一网络。`,
          );
        }
        if (!ping.ok) throw new Error('电脑返回的配对信息异常，请升级桌面端后重试');
        const result = await pairServer(base, pairCode.trim(), getDeviceId(), detectDeviceName());
        if (!result.token || !result.device) throw new Error('电脑返回的配对信息不完整');
        saveServer({
          id: result.device.id,
          name: result.server?.name || ping.name || base,
          baseUrl: base,
          token: result.token,
          api: result.server?.api || ping.api || 1,
          version: result.server?.version || ping.version || '',
          lastUsed: Date.now(),
        });
        cleanPairQuery();
        navigate('/library', { replace: true });
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy('');
      }
    },
    [navigate],
  );
  doPairRef.current = doPair;

  useEffect(() => {
    if (autoRan.current) return;
    const outer = new URLSearchParams(window.location.search);
    const rawPair = outer.get('pair') || outer.get('code') || '';
    if (!rawPair) return;
    autoRan.current = true;
    const parsed = parsePairPayload(window.location.href);
    if (!parsed) {
      setError('二维码内容无效，请重新生成配对码');
      return;
    }
    setAddress(parsed.baseUrl);
    setCode(parsed.code);
    setMode('manual');
    setInfo('已识别配对二维码，正在连接电脑…');
    void doPairRef.current(parsed.baseUrl, parsed.code);
  }, []);

  const connectExisting = async (server: ServerEntry) => {
    if (busy) return;
    setBusy(server.id);
    setError('');
    setInfo('');
    try {
      const alive = await checkServer(server);
      if (!alive) {
        setError('连接失败：电脑未开机、局域网访问未开启，或令牌已失效。请重新扫码配对。');
        return;
      }
      setActiveServer(server.id);
      touchServer(server.id);
      navigate('/library', { replace: true });
    } finally {
      setBusy('');
    }
  };

  const handleScan = useCallback((raw: string) => {
    setScanOpen(false);
    const parsed = parsePairPayload(raw);
    if (!parsed) {
      setError('二维码不是 NovelCrawler 配对码');
      return;
    }
    setAddress(parsed.baseUrl);
    setCode(parsed.code);
    setMode('manual');
    setInfo('已识别配对二维码，正在连接电脑…');
    void doPairRef.current(parsed.baseUrl, parsed.code);
  }, []);

  const openScanner = () => {
    setError('');
    if (!window.isSecureContext) {
      setInfo('局域网 HTTP 下浏览器不能调用摄像头：请直接用手机系统相机扫描电脑上的二维码，会自动打开本页并完成配对；也可以手动输入地址和配对码。');
      return;
    }
    setScanOpen(true);
  };

  const deleteServer = (server: ServerEntry) => {
    if (!window.confirm(`删除「${server.name}」的配对信息？`)) return;
    removeServer(server.id);
    setServers(getServers());
  };

  return (
    <div className="connect-page">
      <header className="brand">
        <div className="brand__mark">
          <BookOpen size={30} strokeWidth={1.8} />
        </div>
        <div>
          <h1>NovelCrawler</h1>
          <p>手机书库</p>
        </div>
      </header>

      <section className="connect-hero">
        <h2>把电脑上的书，带到手机上继续读。</h2>
        <p>电脑负责下载和整理，手机负责阅读。局域网直连，数据不经过第三方。</p>
        <div className="connect-hero__pills">
          <span><Wifi size={14} /> 局域网直连</span>
          <span><ShieldCheck size={14} /> 配对令牌保护</span>
        </div>
      </section>

      {expired && (
        <div className="banner banner--warn">
          配对令牌已失效，请重新扫码，或在下面选择电脑重新配对。
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {info && <div className="banner banner--info">{info}</div>}

      <section className="connect-actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={openScanner}>
          <ScanLine size={20} />
          扫描电脑二维码
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--lg"
          onClick={() => setMode(mode === 'manual' ? 'choose' : 'manual')}
        >
          <Smartphone size={18} />
          手动输入地址和配对码
        </button>
        <p className="connect-tip">
          {IS_NATIVE || window.isSecureContext
            ? '也可以点击上方按钮扫描二维码，或手动输入地址和配对码。'
            : '局域网 HTTP 下请用手机系统相机扫码，二维码会自动打开本页并完成配对。'}
        </p>
      </section>

      {mode === 'manual' && (
        <form
          className="panel connect-form"
          onSubmit={(event) => {
            event.preventDefault();
            void doPair(address, code);
          }}
        >
          <label className="field">
            <span>电脑地址</span>
            <input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="192.168.1.5:8765"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <label className="field">
            <span>6 位配对码</span>
            <input
              className="code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <button type="submit" className="btn btn--primary btn--lg" disabled={busy === 'pair'}>
            {busy === 'pair' ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
            {busy === 'pair' ? '正在配对…' : '连接电脑'}
          </button>
        </form>
      )}

      {servers.length > 0 && (
        <section className="connect-servers">
          <div className="section-heading">
            <h3>已配对的电脑</h3>
            <span>{servers.length} 台</span>
          </div>
          <div className="server-list">
            {servers.map((server) => (
              <div
                key={server.id}
                className="server-card"
                role="button"
                tabIndex={0}
                onClick={() => void connectExisting(server)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') void connectExisting(server);
                }}
              >
                <div className="server-card__icon">
                  <Server size={20} />
                </div>
                <div className="server-card__main">
                  <div className="server-card__name">
                    {server.name}
                    <span className="server-card__badge">v{server.version || '?'}</span>
                  </div>
                  <div className="server-card__url">{server.baseUrl.replace(/^https?:\/\//, '')}</div>
                </div>
                {busy === server.id ? (
                  <Loader2 size={18} className="spin" />
                ) : (
                  <ChevronRight size={18} className="muted" />
                )}
                <button
                  type="button"
                  className="icon-btn server-card__delete"
                  aria-label={`删除 ${server.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteServer(server);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="connect-footer">
        <p>在电脑端打开「手机连接」页，开启局域网访问并点「生成配对码」。</p>
        <p>手机与电脑需要连接同一 Wi-Fi 或电脑热点。</p>
      </footer>

      {scanOpen && <ScannerModal onClose={() => setScanOpen(false)} onResult={handleScan} />}
    </div>
  );
}
