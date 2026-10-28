import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Flame,
  Globe2,
  KeyRound,
  Loader2,
  ScanLine,
  Server,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  Zap,
} from 'lucide-react';
import ScannerModal from '../components/ScannerModal';
import { checkServer, pickReachable, pingServer, pairServer } from '../lib/api';
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
import { ensurePinned, pinnedAvailable, PinError } from '../lib/pinned';
import { parseSshParam, sshAvailable, sshConnect, sshDisconnect, sshTargetText } from '../lib/ssh';
import { IS_NATIVE } from '../lib/native';
import { pairOverWrtc, prepareWrtc, wrtcServerAlive, type WrtcHandshake } from '../lib/wrtc';
import type { ServerEntry } from '../lib/types';

type Method = 'lan' | 'hotspot' | 'tunnel' | 'wrtc';
type ScanTarget = 'pair' | 'wrtc';

const METHODS: { key: Method; label: string; icon: typeof Wifi }[] = [
  { key: 'lan', label: '局域网', icon: Wifi },
  { key: 'hotspot', label: '热点', icon: Flame },
  { key: 'tunnel', label: '穿透', icon: Globe2 },
  { key: 'wrtc', label: '直连', icon: Zap },
];

const HOTSPOT_PREFIX = '192.168.137.1';

function cleanPairQuery() {
  const url = new URL(window.location.href);
  for (const key of ['pair', 'code', 'v', 'name', 'pin', 'alt']) url.searchParams.delete(key);
  const [hashPath, hashQuery] = url.hash.split('?');
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    for (const key of ['pair', 'code', 'v', 'name', 'pin', 'alt']) params.delete(key);
    url.hash = params.size ? `${hashPath}?${params.toString()}` : hashPath;
  }
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}

/** 热点/隧道二维码只有地址没有配对码:识别出来填进地址栏,让用户补 6 位码。 */
function parseServerAddress(raw: string): string | null {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let path = url.pathname.replace(/\/+$/, '');
    if (path.toLowerCase().endsWith('/mobile')) path = path.slice(0, -7);
    if (path.toLowerCase().endsWith('/m')) path = path.slice(0, -2);
    if (path === '/direct') path = '';
    if (path === '/') path = '';
    if (path) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export default function ConnectPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [servers, setServers] = useState<ServerEntry[]>(() => getServers());
  const [method, setMethod] = useState<Method>('lan');
  const [mode, setMode] = useState<'choose' | 'manual'>('choose');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [scanTarget, setScanTarget] = useState<ScanTarget | null>(null);
  const [wrtcOffer, setWrtcOffer] = useState('');
  const [wrtcAnswer, setWrtcAnswer] = useState('');
  const wrtcRef = useRef<WrtcHandshake | null>(null);
  const autoRan = useRef(false);
  // 二维码 alt 参数带来的备用地址(热点/虚拟组网),配对成功后一并存进候选列表
  const pairCandidatesRef = useRef<string[]>([]);
  // 二维码携带的 CA 指纹:配对过程中一直带着,配对成功后一并写进服务器条目
  const pairPinRef = useRef<string>('');
  const sshTargetRef = useRef<ReturnType<typeof parseSshParam>>(null);
  const sshTunnelRef = useRef<{ target: string; localPort: number; via: string } | null>(null);
  const tunnelVia = useRef('ssh');
  const [sshPassword, setSshPassword] = useState('');
  const [sshHint, setSshHint] = useState('');
  const doPairRef = useRef<(base: string, pairCode: string) => Promise<void>>(
    async () => undefined,
  );
  const expired = searchParams.get('expired') === '1';

  const doPair = useCallback(
    async (baseInput: string, pairCode: string, pinInput?: string) => {
      let probeList: string[] = [];
      setBusy('pair');
      setError('');
      setInfo('');
      try {
        let base = normalizeBaseUrl(baseInput);
        if (!/^\d{6}$/.test(pairCode.trim())) throw new Error('请输入 6 位配对码');
        // ---- 内建 SSH 通道:扫码带了 ssh 账号且用户填了密码时优先走隧道 ----
        // 隧道打通后,电脑的服务端口被映射到手机本机,后面所有请求都指向 127.0.0.1,
        // 校园网 AP 隔离 / 公网 NAT 都不再影响连接,且链路是加密的。
        if (base.trim() && sshTargetRef.current && sshPassword) {
          const target = sshTargetRef.current;
          setInfo(`正在建立 SSH 通道 ${sshTargetText(target)}…`);
          try {
            const tun = await sshConnect(target, sshPassword, Number(new URL(base).port) || 80);
            base = `http://127.0.0.1:${tun.localPort}`;
            sshTunnelRef.current = { target: sshTargetText(target), localPort: tun.localPort, via: tunnelVia.current };
            setInfo(`SSH 通道已建立，经 127.0.0.1:${tun.localPort} 连接电脑`);
          } catch (cause) {
            await sshDisconnect();
            throw new Error(`SSH 通道建立失败：${errorMessage(cause)}`);
          }
        }
        // ---- 配对前先探一遍候选地址 ----
        // 二维码的主地址是电脑选的,校园网下常常是 WLAN 网段的 IP;而手机此刻
        // 连的是电脑热点(192.168.137.x),两边不同网段 → 主地址必然打不通,
        // 以前会直接报「这个地址没有响应」,根本走不到配对成功后的换址逻辑。
        probeList = [];
        for (const raw of [base, ...pairCandidatesRef.current]) {
          const url = String(raw || '').trim().replace(/\/+$/, '');
          if (url && !probeList.includes(url)) probeList.push(url);
        }
        const viaTunnel = /^http://////127//.0//.0//.1/.test(base);
        if (!viaTunnel && probeList.length > 1) {
          setInfo('正在探测可用地址…');
          const hit = await pickReachable(probeList);
          if (hit) base = hit;
          setInfo('');
        }

        // 自签 HTTPS:先把电脑那张 CA 固定住再谈配对,否则后面每个请求都得
        // 依赖系统信任库里的一堆第三方根证书
        if (/^https:/i.test(base)) {
          const pin = String(pinInput || pairPinRef.current || '').trim();
          if (!pinnedAvailable()) {
            setInfo('当前环境不支持证书固定，请安装 App 版');
          } else if (!pin) {
            setInfo('二维码没带证书指纹，本次按「首次信任」处理，建议改用扫码配对');
            await ensurePinned(base);
          } else {
            setInfo('正在校验电脑证书…');
            await ensurePinned(base, pin);
            pairPinRef.current = pin;
          }
          setInfo('');
        }
        let ping;
        try {
          ping = await pingServer(base);
        } catch (cause) {
          throw new Error(
            `连不上电脑（${errorMessage(cause)}）。请确认电脑已开机、已开启局域网访问，并与手机处于同一网络。`,
          );
        }
        if (!ping.ok) throw new Error('电脑返回的配对信息异常，请升级桌面端后重试');
        const result = await pairServer(base, pairCode.trim(), getDeviceId(), detectDeviceName());
        if (!result.token || !result.device) throw new Error('电脑返回的配对信息不完整');
        // 合并三处候选:当前地址 + 二维码 alt + 电脑下发,再探测挑一个真正通的
        const merged: string[] = [];
        for (const raw of [base, ...pairCandidatesRef.current, ...(result.server?.candidates || [])]) {
          const url = String(raw || '').trim().replace(/\/+$/, '');
          if (url && !merged.includes(url)) merged.push(url);
        }
        let chosen = base;
        if (merged.length > 1) {
          setInfo('正在选择最快的连接地址…');
          const hit = await pickReachable(merged);
          if (hit) chosen = hit;
          setInfo('');
        }
        saveServer({
          id: result.device.id,
          name: result.server?.name || ping.name || base,
          baseUrl: chosen,
          token: result.token,
          api: result.server?.api || ping.api || 1,
          version: result.server?.version || ping.version || '',
          lastUsed: Date.now(),
          transport: 'http',
          candidates: merged,
          pin: result.server?.pin || pairPinRef.current || undefined,
          ssh: sshTargetText(sshTargetRef.current) || result.server?.ssh || undefined,
          sshPassword: sshPassword || undefined,
          sshTunnel: sshTunnelRef.current || undefined,
        });
        pairCandidatesRef.current = [];
        cleanPairQuery();
        navigate('/home', { replace: true });
      } catch (cause) {
        // 多地址全部不通时,最常见的原因不是地址选错而是防火墙:
        // 热点网卡常被 Windows 判为「公用网络」,默认阻止入站 8899。
        const base0 = probeList.length > 1
          ? `（已尝试 ${probeList.length} 个地址；若都失败，请确认电脑防火墙放行本程序，热点网卡通常被归为「公用网络」）`
          : '';
        setError((cause instanceof PinError ? cause.message : errorMessage(cause)) + base0);
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
    pairCandidatesRef.current = parsed.candidates || [];
    pairPinRef.current = parsed.pin || '';
    sshTargetRef.current = parseSshParam(parsed.ssh);
    if (parsed.sshPassword) setSshPassword(parsed.sshPassword);
    setSshHint(sshTargetRef.current
      ? `已从二维码拿到内建 SSH 通道（${sshTargetText(sshTargetRef.current)}）${parsed.sshPassword ? '与密码' : '，请补填密码'}，将自动走加密隧道`
      : '');
    setAddress(parsed.baseUrl);
    setCode(parsed.code);
    setMode('manual');
    setInfo('已识别配对二维码，正在连接电脑…');
    void doPairRef.current(parsed.baseUrl, parsed.code);
  }, []);

  const finishWrtc = async (handshake: WrtcHandshake) => {
    setInfo('直连已建立，正在完成配对…');
    const result = await pairOverWrtc(getDeviceId(), detectDeviceName());
    if (!result.token || !result.device) throw new Error(result.error || '电脑返回的配对信息不完整');
    saveServer({
      id: `wrtc:${result.device.id}`,
      name: result.server?.name || '电脑直连',
      baseUrl: `wrtc://${handshake.session}`,
      token: result.token,
      api: result.server?.api || 1,
      version: result.server?.version || '',
      lastUsed: Date.now(),
      transport: 'wrtc',
    });
    setWrtcAnswer('');
    setWrtcOffer('');
    wrtcRef.current = null;
    navigate('/home', { replace: true });
  };

  const startWrtc = async (offerInput?: string) => {
    const offer = String(offerInput ?? wrtcOffer).trim();
    if (busy) return;
    if (!offer) {
      setError('请先扫描电脑端「任意网络直连」生成的连接码，或粘贴连接码文本');
      return;
    }
    setBusy('wrtc');
    setError('');
    setInfo('');
    setWrtcAnswer('');
    wrtcRef.current = null;
    try {
      const handshake = await prepareWrtc(offer, (message) => setInfo(message));
      wrtcRef.current = handshake;
      setWrtcAnswer(handshake.answerCode);
      if (!handshake.autoSent) {
        setInfo(
          '云端回传不可用：请把下方应答码粘贴到电脑端「任意网络直连 → 兜底方式」，点「提交应答码」，再回到这里点「继续等待」。',
        );
        return;
      }
      setInfo('应答码已自动回传，正在等待电脑接通…');
      await handshake.wait(35000);
      await finishWrtc(handshake);
    } catch (cause) {
      setError(errorMessage(cause));
      setInfo('');
    } finally {
      setBusy('');
    }
  };

  const continueWrtc = async () => {
    const handshake = wrtcRef.current;
    if (!handshake || busy) return;
    setBusy('wrtc');
    setError('');
    setInfo('正在等待电脑接通…');
    try {
      await handshake.wait(40000);
      await finishWrtc(handshake);
    } catch (cause) {
      setError(errorMessage(cause));
      setInfo('');
    } finally {
      setBusy('');
    }
  };

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(wrtcAnswer);
      setInfo('应答码已复制，粘贴到电脑端即可');
    } catch {
      setError('复制失败，请长按文本框手动复制');
    }
  };

  const connectExisting = async (server: ServerEntry) => {
    if (busy) return;
    if (server.transport === 'wrtc') {
      if (wrtcServerAlive(server)) {
        setActiveServer(server.id);
        touchServer(server.id);
        navigate('/home', { replace: true });
        return;
      }
      setMethod('wrtc');
      setError('点对点直连会随页面刷新断开，请重新扫描电脑端生成的连接码。');
      return;
    }
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
      navigate('/home', { replace: true });
    } finally {
      setBusy('');
    }
  };

  const startWrtcRef = useRef(startWrtc);
  startWrtcRef.current = startWrtc;

  const handleScan = useCallback((raw: string) => {
    const text = String(raw || '').trim();
    if (text.includes('novelist-wrtc://')) {
      setMethod('wrtc');
      setWrtcOffer(text);
      void startWrtcRef.current(text);
      return;
    }
    const parsed = parsePairPayload(text);
    if (parsed) {
      pairCandidatesRef.current = parsed.candidates || [];
      pairPinRef.current = parsed.pin || '';
      sshTargetRef.current = parseSshParam(parsed.ssh);
      if (parsed.sshPassword) setSshPassword(parsed.sshPassword);
      setSshHint(sshTargetRef.current
        ? `已从二维码拿到内建 SSH 通道（${sshTargetText(sshTargetRef.current)}）${parsed.sshPassword ? '与密码' : '，请补填密码'}，将自动走加密隧道`
        : '');
      setAddress(parsed.baseUrl);
      setCode(parsed.code);
      setMode('manual');
      setInfo('已识别配对二维码，正在连接电脑…');
      void doPairRef.current(parsed.baseUrl, parsed.code);
      return;
    }
    const base = parseServerAddress(text);
    if (base) {
      const hotspot = base.includes(HOTSPOT_PREFIX);
      const tunnel = base.startsWith('https://');
      setMethod(hotspot ? 'hotspot' : tunnel ? 'tunnel' : 'lan');
      setAddress(base.replace(/^https?:\/\//, ''));
      setMode('manual');
      setInfo('已识别电脑地址，请再输入电脑上显示的 6 位配对码。');
      return;
    }
    setError('二维码不是 NovelCrawler 配对码或直连码');
  }, []);

  const switchMethod = (next: Method) => {
    if (next === method) return;
    setMethod(next);
    setError('');
    setInfo('');
  };

  const openScanner = (target: ScanTarget) => {
    setError('');
    if (!window.isSecureContext && !IS_NATIVE) {
      if (target === 'wrtc') {
        setInfo('局域网 HTTP 下浏览器不能调用摄像头：请在电脑上复制连接码文本，粘贴到下方输入框再点「建立直连」。');
      } else {
        setInfo(
          '局域网 HTTP 下浏览器不能调用摄像头：请直接用手机系统相机扫描电脑上的二维码，会自动打开本页完成配对；也可以手动输入地址和配对码。',
        );
        setMode('manual');
      }
      return;
    }
    setScanTarget(target);
  };

  const deleteServer = (server: ServerEntry) => {
    if (!window.confirm(`删除「${server.name}」的配对信息？`)) return;
    removeServer(server.id);
    setServers(getServers());
  };

  const showForm = method !== 'wrtc' && (mode === 'manual' || method !== 'lan');

  return (
    <div className="connect-page">
      <button type="button" className="connect-back" onClick={() => navigate('/home')}>
        <ArrowLeft size={16} />
        返回首页
      </button>
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
        <p>电脑负责下载和整理，手机负责阅读。四种连接方式，按你手头的网络挑一种。</p>
      </section>

      {expired && (
        <div className="banner banner--warn">
          配对令牌已失效，请重新扫码，或在下面选择电脑重新配对。
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {info && <div className="banner banner--info">{info}</div>}

      <section className="connect-methods">
        <div className="segmented segmented--small connect-method-tabs" role="tablist" aria-label="连接方式">
          {METHODS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={method === item.key}
                className={method === item.key ? 'is-active' : ''}
                onClick={() => switchMethod(item.key)}
              >
                <Icon size={14} />
                {item.label}
              </button>
            );
          })}
        </div>

        {method === 'lan' && (
          <div className="connect-method">
            <div className="connect-method__title">
              <Wifi size={16} />
              局域网扫码
            </div>
            <p>手机和电脑连同一个 Wi-Fi。电脑端「手机连接 → 局域网扫码」生成二维码，扫一次即可完成配对。</p>
            <div className="connect-method__actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => openScanner('pair')}>
                <ScanLine size={16} />
                扫描电脑二维码
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setMode(mode === 'manual' && method === 'lan' ? 'choose' : 'manual')}
              >
                <Smartphone size={15} />
                手动输入
              </button>
            </div>
            <p className="connect-tip connect-tip--secure">
              <ShieldCheck size={13} />
              {IS_NATIVE || window.isSecureContext
                ? '扫码会直接读取电脑屏幕上的二维码'
                : '局域网 HTTP 下请用手机系统相机扫码'}
            </p>
          </div>
        )}

        {method === 'hotspot' && (
          <div className="connect-method">
            <div className="connect-method__title">
              <Flame size={16} />
              热点接力
            </div>
            <ol className="connect-method__steps">
              <li>电脑打开「设置 → 网络 → 移动热点」并开启。</li>
              <li>手机 Wi-Fi 连接到这个电脑热点。</li>
              <li>按电脑端热点卡片上的地址（通常是 {HOTSPOT_PREFIX}）和端口连接。</li>
            </ol>
            <p>校园网 / 公司网禁止设备互访时，这条最稳。</p>
            <div className="connect-method__actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setAddress(HOTSPOT_PREFIX);
                  setInfo('补上电脑端口后点「连接电脑」（电脑端热点卡片上有完整地址，如 192.168.137.1:8899）。');
                }}
              >
                <KeyRound size={15} />
                填入热点地址
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openScanner('pair')}>
                <ScanLine size={15} />
                扫热点二维码
              </button>
            </div>
          </div>
        )}

        {method === 'tunnel' && (
          <div className="connect-method">
            <div className="connect-method__title">
              <Globe2 size={16} />
              公网穿透
            </div>
            <p>
              电脑端「手机连接 → 公网穿透」开启 natapp / cpolar / frp 等隧道后，把公网地址填到这里；手机在任何网络都能连。
            </p>
            <div className="connect-method__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openScanner('pair')}>
                <ScanLine size={15} />
                扫隧道二维码
              </button>
            </div>
          </div>
        )}

        {method === 'wrtc' && (
          <div className="connect-method">
            <div className="connect-method__title">
              <Zap size={16} />
              任意网络直连
            </div>
            <p>
              手机和电脑不在同一个网络也能连：电脑端「手机连接 → 任意网络直连」点「生成连接码」，手机扫一次码即可建立点对点通道。
            </p>
            <div className="connect-method__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={Boolean(busy)}
                onClick={() => openScanner('wrtc')}
              >
                <ScanLine size={16} />
                扫描电脑连接码
              </button>
            </div>
            <textarea
              className="wrtc-offer"
              rows={3}
              value={wrtcOffer}
              placeholder="或粘贴连接码文本 novelist-wrtc://v1/…"
              onChange={(event) => setWrtcOffer(event.target.value)}
            />
            <div className="connect-method__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={Boolean(busy) || !wrtcOffer.trim()}
                onClick={() => void startWrtc()}
              >
                {busy === 'wrtc' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
                {busy === 'wrtc' ? '正在连接…' : '建立直连'}
              </button>
              {wrtcAnswer && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={Boolean(busy)}
                  onClick={() => void continueWrtc()}
                >
                  <Loader2 size={15} />
                  继续等待
                </button>
              )}
            </div>
            {wrtcAnswer && (
              <>
                <p className="connect-method__fallback">
                  电脑一直没接通？展开电脑端「兜底方式」，把这段应答码粘贴进去提交，再点「继续等待」。
                </p>
                <textarea className="wrtc-answer" rows={3} readOnly value={wrtcAnswer} />
                <div className="connect-method__actions">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyAnswer()}>
                    复制应答码
                  </button>
                </div>
              </>
            )}
            <p className="connect-method__note">
              直连适合临时看文字章节；封面和插图不显示，整本大文件下载可能失败，需要时再连局域网或热点。
            </p>
          </div>
        )}
      </section>

      {showForm && (
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
              placeholder={method === 'hotspot' ? '192.168.137.1:8899' : method === 'tunnel' ? 'https://xxxx.cpolar.top' : '192.168.1.5:8899'}
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
          {sshHint && sshAvailable() && (
            <label className="field">
              <span>电脑登录密码（选填 · 走 SSH 加密通道）</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="填了就走内建 SSH 隧道，留空走局域网直连"
                value={sshPassword}
                onChange={(event) => setSshPassword(event.target.value)}
              />
              <p className="connect-tip">{sshHint}</p>
            </label>
          )}
          <button type="submit" className="btn btn--primary btn--lg" disabled={busy === 'pair'}>
            {busy === 'pair' ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
            {busy === 'pair' ? '正在配对…' : '连接电脑'}
          </button>
          <p className="connect-tip">
            电脑上的配对码 5 分钟内有效；地址要带端口，例如 192.168.1.5:8899。
          </p>
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
                    <span className="server-card__badge">
                      {server.transport === 'wrtc' ? '直连' : `v${server.version || '?'}`}
                    </span>
                  </div>
                  <div className="server-card__url">
                    {server.transport === 'wrtc'
                      ? '点对点直连 · 刷新后需重新扫码'
                      : server.baseUrl.replace(/^https?:\/\//, '')}
                  </div>
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
        <p>在电脑端打开「手机连接」页，按上方四种方式任一生成配对码或连接码。</p>
        <p>配对令牌只保存在本机，局域网直连的数据不经过第三方。</p>
      </footer>

      {scanTarget && (
        <ScannerModal
          onClose={() => setScanTarget(null)}
          onResult={(raw) => {
            setScanTarget(null);
            handleScan(raw);
          }}
        />
      )}
    </div>
  );
}
