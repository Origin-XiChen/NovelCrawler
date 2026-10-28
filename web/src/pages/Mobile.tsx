import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  Copy,
  Download,
  ExternalLink,
  Flame,
  Globe2,
  KeyRound,
  Link2,
  Loader2,
  Package,
  QrCode,
  RefreshCw,
  Router,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  Terminal,
  Lock,
  Trash2,
  Wifi,
  Zap,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useToast } from '../lib/toast';
import type { ComicFileGroup, FileEntry } from '../lib/types';

type Tab = 'lan' | 'hotspot' | 'tunnel' | 'wrtc' | 'pack';

interface LanAdapter {
  ip: string;
  kind: string;
  label: string;
  name?: string;
  rank?: number;
  recommended?: boolean;
}

interface NetworkInfo {
  lan_access: boolean;
  ips: string[];
  port: string;
  primary_ip?: string;
  app_url?: string;
  adapters?: LanAdapter[];
  candidates?: { url: string; ip: string; kind: string; label: string; recommended?: boolean }[];
  scheme?: string;
  https_enabled?: boolean;
  https_port?: number;
  qr_b64?: string;
}

interface SshdInfo {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  port: number;
  user: string;
  password: string;
  target_port?: number;
  error?: string;
}

interface TlsInfo {
  ok: boolean;
  enabled: boolean;
  only: boolean;
  listening: boolean;
  scheme: string;
  port: number;
  http_port: number;
  https_port: number;
  ca_url: string;
  ca_exists?: boolean;
  cert_exists?: boolean;
  fingerprint?: string;
  ca_fingerprint?: string;
  pin?: string;
  hosts?: string[];
  not_after?: number;
  dir?: string;
  error?: string;
}

interface DoctorCheck {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
  recommended?: boolean;
}

interface DoctorInfo {
  ok: boolean;
  port: number;
  lan_access: boolean;
  bind_host: string;
  checks: DoctorCheck[];
  ssh?: {
    platform?: string;
    running: boolean;
    port: number;
    listening: boolean;
    password_auth?: boolean | null;
    authorized_keys?: boolean;
  };
  ssh_command?: string;
  ssh_host?: string;
}

interface HotspotInfo {
  hotspot_on: boolean;
  hotspot_ips: string[];
  hotspot_gw: string;
  wifi_ssid?: string;
  wifi_state?: string;
  ips?: string[];
}

interface TunnelInfo {
  running: boolean;
  url: string;
  cmd: string;
  args: string[];
  restart_count: number;
  uptime: number;
  log_tail: string[];
  config?: { cmd?: string; args?: string[]; url_regex?: string };
}

interface WrtcSession {
  session: string;
  connected: boolean;
  answer_ok: boolean;
  age: number;
}

interface WrtcStatus {
  available?: boolean;
  sessions?: WrtcSession[];
  events?: string[];
  cam?: { running?: boolean };
  signal?: { online?: number; topic?: string };
}

interface SyncTask {
  name?: string;
  title?: string;
  done?: number;
  total?: number;
  state?: string;
}

interface SyncSession {
  sid: string;
  ip?: string;
  ua?: string;
  online?: boolean;
  tasks?: SyncTask[];
}

interface PairInfo {
  ok: boolean;
  code: string;
  ttl: number;
  expires_at: number;
  uri: string;
  legacy_uri: string;
  base_url: string;
  lan_access: boolean;
  candidates?: string[];
  scheme?: string;
  pin?: string;
}

interface PairedDevice {
  id: string;
  name: string;
  created: number;
  last_seen: number;
  last_ip: string;
  online: boolean;
}

interface SettingsData {
  settings: {
    webrtc_turn_url?: string;
    webrtc_turn_user?: string;
    webrtc_turn_pass?: string;
  };
}

interface LocalSyncFile {
  name: string;
  size: number;
  mtime: number;
}

interface LocalSyncData {
  requested: boolean;
  requested_at: number;
  done_at: number;
  files?: LocalSyncFile[];
}

const TABS: { value: Tab; label: string; icon: typeof Wifi }[] = [
  { value: 'lan', label: '局域网扫码', icon: Wifi },
  { value: 'hotspot', label: '热点接力', icon: Flame },
  { value: 'tunnel', label: '公网穿透', icon: Globe2 },
  { value: 'wrtc', label: '任意网络直连', icon: Zap },
  { value: 'pack', label: '离线手机包', icon: Package },
];

const qrSrc = (value?: string) => (value ? `data:image/png;base64,${value}` : '');

function downloadUrl(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function fetchQr(text: string): Promise<string> {
  if (!text) return '';
  try {
    const data = await apiGet<{ qr_b64?: string }>('/api/qr', { text });
    return data.qr_b64 ?? '';
  } catch {
    return '';
  }
}

function QrBox({ value, size = 112, alt }: { value?: string; size?: number; alt: string }) {
  if (!value) return null;
  return (
    <div className="mobile-qr" style={{ width: size, height: size }}>
      <img src={qrSrc(value)} alt={alt} width={size} height={size} />
    </div>
  );
}

function resultText(value: number) {
  return value > 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function lastSeenText(value: number) {
  if (!value) return '从未在线';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - value));
  if (diff < 60) return '刚刚在线';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function stampText(value: number) {
  if (!value) return '';
  const d = new Date(value * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function LanTab({ lanAccess, onLanChange }: { lanAccess: boolean; onLanChange: (value: boolean) => void }) {
  const { toast } = useToast();
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [sessions, setSessions] = useState<SyncSession[]>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [pairQr, setPairQr] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [revoking, setRevoking] = useState('');
  const [localSync, setLocalSync] = useState<LocalSyncData | null>(null);
  const [syncRefreshing, setSyncRefreshing] = useState(false);
  const [syncRequesting, setSyncRequesting] = useState(false);
  const [syncBusy, setSyncBusy] = useState('');
  // 手动选定的网卡(跨会话记住):校园网/AP 隔离下必须能选到虚拟组网那张网卡
  const [selectedIp, setSelectedIp] = useState<string>(() => {
    try {
      return localStorage.getItem('nc_lan_ip') || '';
    } catch {
      return '';
    }
  });
  const [doctor, setDoctor] = useState<DoctorInfo | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [sshd, setSshd] = useState<SshdInfo | null>(null);
  const [sshdBusy, setSshdBusy] = useState(false);
  const [tlsInfo, setTlsInfo] = useState<TlsInfo | null>(null);
  const [tlsBusy, setTlsBusy] = useState(false);
  const netSeq = useRef(0);

  const loadTls = useCallback(
    async (silent = true) => {
      try {
        const data = await apiGet<TlsInfo>('/api/tls');
        setTlsInfo(data);
      } catch (cause) {
        if (!silent) toast(cause instanceof Error ? cause.message : String(cause), 'error');
      }
    },
    [toast],
  );

  const applyTls = async (enabled: boolean, only: boolean) => {
    setTlsBusy(true);
    try {
      const data = await apiPost<TlsInfo & { error?: string }>('/api/tls', { enabled, only });
      if (data.error) {
        toast(data.error, 'error');
      } else {
        toast(enabled ? 'HTTPS 已开启，手机改用加密端口' : 'HTTPS 已关闭', 'success');
      }
      await loadTls();
      await loadNetwork(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setTlsBusy(false);
    }
  };

  const loadSshd = useCallback(async () => {
    try {
      setSshd(await apiGet<SshdInfo>('/api/sshd'));
    } catch {
      // 旧后端没有该接口时静默跳过
    }
  }, []);

  const applySshd = async (patch: Record<string, unknown>) => {
    setSshdBusy(true);
    try {
      const data = await apiPost<SshdInfo & { error?: string }>('/api/sshd', patch);
      if (data.error) toast(data.error, 'error');
      else toast(data.running ? '内建 SSH 通道已启动' : '内建 SSH 通道已关闭', 'success');
      await loadSshd();
      await loadNetwork(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSshdBusy(false);
    }
  };

  const copyFingerprint = async () => {
    const fp = tlsInfo?.fingerprint;
    if (!fp) return;
    try {
      await navigator.clipboard.writeText(fp);
      toast('证书指纹已复制', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
  };

  const runDoctor = async () => {
    setDoctorBusy(true);
    try {
      const data = await apiGet<DoctorInfo>('/api/doctor');
      setDoctor(data);
      toast(data.ok ? '体检通过，手机可以连进来' : '体检发现问题，见下方标注', data.ok ? 'success' : 'info');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setDoctorBusy(false);
    }
  };

  const copySshCommand = async () => {
    const cmd = doctor?.ssh_command;
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('SSH 命令已复制', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
  };

  const adapters = network?.adapters ?? [];
  const effectiveIp = (() => {
    if (adapters.length === 0) return network?.primary_ip || network?.ips?.[0] || '';
    if (selectedIp && adapters.some((item) => item.ip === selectedIp)) return selectedIp;
    return (adapters.find((item) => item.recommended) || adapters[0]).ip;
  })();

  const pickIp = (ip: string) => {
    setSelectedIp(ip);
    try {
      localStorage.setItem('nc_lan_ip', ip);
    } catch {
      // 隐私模式下忽略
    }
  };

  const loadNetwork = useCallback(
    async (force = false) => {
      // 地址表可能被「打开 HTTPS」这类操作并发刷新:只认最后发出的那次,
      // 否则先发后到的旧响应会把端口改回明文,用户照着复制就连到 301 上
      netSeq.current += 1;
      const seq = netSeq.current;
      try {
        const data = await apiGet<NetworkInfo>('/api/network', force ? { force: 1 } : undefined);
        if (seq !== netSeq.current) return;
        setNetwork(data);
        onLanChange(Boolean(data.lan_access));
      } catch (cause) {
        if (seq === netSeq.current) {
          toast(cause instanceof Error ? cause.message : String(cause), 'error');
        }
      }
    },
    [onLanChange, toast],
  );

  const loadDevices = useCallback(
    async (silent = false) => {
      if (!silent) setDevicesLoading(true);
      try {
        const data = await apiGet<{ devices?: PairedDevice[] }>('/api/mobile/devices');
        setDevices(data.devices ?? []);
      } catch (cause) {
        if (!silent) toast(cause instanceof Error ? cause.message : String(cause), 'error');
      } finally {
        if (!silent) setDevicesLoading(false);
      }
    },
    [toast],
  );

  const loadLocalSync = useCallback(
    async (silent = false) => {
      if (!silent) setSyncRefreshing(true);
      try {
        const data = await apiGet<LocalSyncData>('/api/mobile/sync/local');
        setLocalSync(data);
      } catch (cause) {
        if (!silent) toast(cause instanceof Error ? cause.message : String(cause), 'error');
      } finally {
        if (!silent) setSyncRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadNetwork();
    void loadDevices(true);
    void loadLocalSync(true);
    void loadTls();
    void loadSshd();
    const timer = window.setInterval(() => {
      void apiGet<{ sessions?: SyncSession[] }>('/api/sync_status')
        .then((data) => setSessions(data.sessions ?? []))
        .catch(() => undefined);
    }, 2000);
    const deviceTimer = window.setInterval(() => void loadDevices(true), 6000);
    const syncTimer = window.setInterval(() => void loadLocalSync(true), 3000);
    void apiGet<{ sessions?: SyncSession[] }>('/api/sync_status')
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => undefined);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(deviceTimer);
      window.clearInterval(syncTimer);
    };
  }, [loadDevices, loadLocalSync, loadNetwork, loadTls, loadSshd]);

  useEffect(() => {
    if (!pair) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [pair]);

  const toggleLan = async () => {
    const next = !lanAccess;
    setSaving(true);
    try {
      const data = await apiPost<{ restart_required?: boolean }>('/api/settings', {
        lan_access: next,
      });
      onLanChange(next);
      toast(
        data.restart_required ? '已保存，重启应用后生效' : '已保存局域网访问设置',
        data.restart_required ? 'info' : 'success',
      );
      await loadNetwork(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSaving(false);
    }
  };

  const startPairing = async () => {
    setPairLoading(true);
    try {
      // 把用户选定的网卡地址交给后端:配对二维码/链接优先用它,其余候选进 alt 参数
      const port = network?.port || location.port || '8899';
      const scheme = network?.scheme === 'https' ? 'https' : 'http';
      const base = effectiveIp ? `${scheme}://${effectiveIp}:${port}` : '';
      const data = await apiPost<PairInfo>('/api/mobile/pair/start', base ? { base_url: base } : {});
      setPair(data);
      setNowSec(Math.floor(Date.now() / 1000));
      setPairQr(await fetchQr(data.uri));
      if (!data.lan_access) toast('局域网访问未开启，请先开启并重启应用', 'info');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setPairLoading(false);
    }
  };

  const copyPairLink = async () => {
    if (!pair) return;
    try {
      await navigator.clipboard.writeText(pair.uri);
      toast('配对链接已复制', 'success');
    } catch {
      toast('复制失败，请手动选择链接', 'error');
    }
  };

  const revokeDevice = async (device: PairedDevice) => {
    if (!window.confirm(`撤销「${device.name}」的配对权限？该手机需要重新扫码才能使用。`)) return;
    setRevoking(device.id);
    try {
      const result = await apiPost<{ ok: boolean; error?: string }>('/api/mobile/devices/revoke', {
        device_id: device.id,
      });
      if (!result.ok) throw new Error(result.error || '撤销失败');
      toast('已撤销该手机的配对权限', 'success');
      await loadDevices(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setRevoking('');
    }
  };

  const startLocalSync = async () => {
    setSyncRequesting(true);
    try {
      const data = await apiPost<LocalSyncData>('/api/mobile/sync/request', {});
      setLocalSync((prev) => ({
        requested: data.requested,
        requested_at: data.requested_at,
        done_at: data.done_at,
        files: prev?.files ?? [],
      }));
      toast('已通知手机上传本地书，手机保持联网即可', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSyncRequesting(false);
    }
  };

  const importLocalFile = async (file: LocalSyncFile) => {
    setSyncBusy(file.name);
    try {
      const result = await apiPost<{ ok: boolean; name?: string; existed?: boolean; error?: string }>(
        '/api/mobile/sync/import',
        { name: file.name },
      );
      if (!result.ok) throw new Error(result.error || '导入失败');
      toast(
        result.existed ? `书库里已有《${result.name}》，已清理暂存文件` : `已收进书库：${result.name}`,
        'success',
      );
      await loadLocalSync(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSyncBusy('');
    }
  };

  const discardLocalFile = async (file: LocalSyncFile) => {
    if (!window.confirm(`从暂存区删除「${file.name}」？文件不会进入书库。`)) return;
    setSyncBusy(file.name);
    try {
      const result = await apiPost<{ ok: boolean; error?: string }>('/api/mobile/sync/discard', {
        name: file.name,
      });
      if (!result.ok) throw new Error(result.error || '删除失败');
      toast('已删除暂存文件', 'success');
      await loadLocalSync(true);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSyncBusy('');
    }
  };

  const localFiles = localSync?.files ?? [];
  // 开了自签 HTTPS 后,手机该连的是加密端口(network.port 已是 port+1),
  // 界面上展示的地址必须跟着换,否则用户照着手输会连到明文端口被 301
  const lanScheme = network?.scheme === 'https' ? 'https' : 'http';
  const baseUrl = effectiveIp
    ? `${lanScheme}://${effectiveIp}:${network?.port || location.port || '8899'}`
    : '';
  const serverBase = (pair?.base_url || baseUrl).replace(/\/+$/, '');
  const appUrl = serverBase ? `${serverBase}/m` : '';
  const remaining = pair ? Math.max(0, pair.expires_at - nowSec) : 0;
  const pairActive = Boolean(pair && remaining > 0 && pairQr);
  const remainingText = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  return (
    <div className="mobile-stack">
      <div className="settings-row">
        <div>
          <div className="settings-row__title">局域网访问</div>
          <div className="settings-row__desc">
            允许手机等同网络设备打开本程序；关闭时仅本机可访问，修改后需重启生效。
          </div>
        </div>
        <button
          type="button"
          className={`switch${lanAccess ? ' is-on' : ''}`}
          aria-label="切换局域网访问"
          disabled={saving}
          onClick={() => void toggleLan()}
        >
          <i />
        </button>
      </div>

      {adapters.length > 1 && (
        <div className="mobile-card">
          <div className="mobile-card__title">
            <Wifi size={16} />
            连接地址
            <button
              type="button"
              className="btn btn--ghost btn--sm mobile-card__title-action"
              onClick={() => void loadNetwork(true)}
            >
              <RefreshCw size={12} />
              重新检测
            </button>
          </div>
          <div className="mobile-hint">
            手机用哪个 IP 连进来。校园网/公司网那张网卡常被 AP 隔离挡住，手机连不通时换「虚拟组网」（ZeroTier / Radmin / Tailscale）。
          </div>
          <div className="mobile-nic">
            {adapters.map((item) => (
              <button
                key={item.ip}
                type="button"
                className={`mobile-nic__item${item.ip === effectiveIp ? ' is-active' : ''}`}
                onClick={() => pickIp(item.ip)}
              >
                <span className="mobile-nic__radio" />
                <span className="mobile-nic__body">
                  <span className="mobile-nic__label">
                    {item.label}
                    {item.recommended && <em className="mobile-nic__badge">推荐</em>}
                  </span>
                  <span className="mobile-nic__ip">{item.ip}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="mobile-details mobile-card" open>
        <summary>安全通道（自签 HTTPS / 内建 SSH）</summary>
        <div className="mobile-stack" style={{ marginTop: 12 }}>
      <div className="mobile-card">
        <div className="mobile-card__title">
          <Terminal size={16} />
          内建 SSH 通道
          {sshd?.running && <span className="tls-pill is-on">运行中 · {sshd.port}</span>}
          {sshd && !sshd.running && sshd.enabled && <span className="tls-pill is-warn">未启动</span>}
        </div>
        <div className="tls-row">
          <div>
            <div className="settings-row__title">开启内建 SSH</div>
            <div className="settings-row__desc">
              程序自己起一个 SSH 服务端，账号密码都由这里掌握，不碰 Windows 账户，也不需要装系统 sshd。
              手机扫配对码时会自动带上账号与密码，扫码即连。
            </div>
          </div>
          <button
            type="button"
            className={`switch${sshd?.enabled ? ' is-on' : ''}`}
            disabled={sshdBusy}
            onClick={() => void applySshd({ enabled: !sshd?.enabled, port: sshd?.port, user: sshd?.user })}
          >
            <i />
          </button>
        </div>
        {sshd?.enabled && (
          <>
            <div className="tls-fp">
              <div className="tls-fp__label">
                <Terminal size={13} />
                登录信息（只在本机可见）
              </div>
              <div className="tls-fp__value">
                {sshd.user}@{sshd.password ? '••••••••••••••' : '（未设置）'} · 端口 {sshd.port}
                {sshd.target_port ? ` → 转发到 127.0.0.1:${sshd.target_port}` : ''}
              </div>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!sshd.password}
                  onClick={() => void navigator.clipboard.writeText(
                    `ssh -N -L ${sshd.target_port || 8899}:127.0.0.1:${sshd.target_port || 8899} ${sshd.user}@<本机IP> -p ${sshd.port}`,
                  ).then(() => toast('命令已复制（密码请到上方点「显示密码」后手动填）', 'success'))
                    .catch(() => toast('复制失败', 'error'))}
                >
                  <Copy size={12} />
                  复制 ssh 命令
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={sshdBusy}
                  onClick={() => void applySshd({ enabled: true, port: sshd.port, user: sshd.user, reset_password: true })}
                >
                  {sshdBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                  重置密码
                </button>
              </div>
              <div className="mobile-hint" style={{ marginTop: 8 }}>
                密码只在电脑本机显示；手机端由配对二维码自动带入，不需要手输。
              </div>
            </div>
          </>
        )}
        {!sshd?.enabled && (
          <div className="mobile-hint">
            开启后可选端口（默认 2222）。它只允许端口转发到本程序，不提供 shell，拿到密码也无法操作电脑其它东西。
          </div>
        )}
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Lock size={16} />
          加密访问（自签 HTTPS）
          {tlsInfo?.enabled && (
            <span className={`tls-pill${tlsInfo.listening ? ' is-on' : ' is-warn'}`}>
              {tlsInfo.listening ? '加密端口已就绪' : '证书已生成，端口未启动'}
            </span>
          )}
        </div>
        <div className="tls-row">
          <div>
            <div className="settings-row__title">开启 HTTPS</div>
            <div className="settings-row__desc">
              手机到电脑这一段走 TLS。同一 Wi-Fi 下抓包只能看到密文，配对令牌和阅读记录不再裸奔。
              开关即时生效，不需要重启程序。
            </div>
          </div>
          <button
            type="button"
            className={`switch${tlsInfo?.enabled ? ' is-on' : ''}`}
            disabled={tlsBusy}
            onClick={() => void applyTls(!tlsInfo?.enabled, tlsInfo?.only ?? false)}
          >
            <i />
          </button>
        </div>
        {tlsInfo?.enabled && (
          <>
            <div className="tls-row">
              <div>
                <div className="settings-row__title">仅允许 HTTPS</div>
                <div className="settings-row__desc">
                  局域网里的明文请求会自动跳到加密端口。本机界面仍走明文，不受影响。
                </div>
              </div>
              <button
                type="button"
                className={`switch${tlsInfo.only ? ' is-on' : ''}`}
                disabled={tlsBusy}
                onClick={() => void applyTls(true, !tlsInfo.only)}
              >
                <i />
              </button>
            </div>
            <div className="mobile-hint">
              手机（App 或浏览器）需要先信任本机 CA，否则会提示连接不安全。
            </div>
            <div className="tls-fp">
              <div className="tls-fp__label">
                <ShieldCheck size={13} />
                证书指纹 SHA-256
              </div>
              <div className="tls-fp__value">{tlsInfo.fingerprint || '证书尚未生成'}</div>
              <div className="mobile-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!tlsInfo.fingerprint}
                  onClick={() => void copyFingerprint()}
                >
                  <Copy size={12} />
                  复制指纹
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => downloadUrl('/tls/ca.crt', 'novelist-ca.crt')}
                >
                  <Download size={12} />
                  下载 CA 证书
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={tlsBusy}
                  onClick={() => void applyTls(true, tlsInfo.only)}
                >
                  {tlsBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                  按当前网卡重签
                </button>
              </div>
            </div>
            <details className="mobile-details">
              <summary>手机怎么装这张 CA（一次即可）</summary>
              <ol className="doctor-steps">
                <li>点「下载 CA 证书」，把 novelist-ca.crt 传到手机（微信/数据线/文件管理器都行）。</li>
                <li>安卓：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择该文件。</li>
                <li>iOS：把文件隔空投送过去 → 设置里「已下载描述文件」安装 → 通用 → 关于本机 → 证书信任设置里打开完全信任。</li>
                <li>装完后手机访问 <code>{lanScheme}://{effectiveIp || '<本机IP>'}:{tlsInfo.https_port}</code> 就不再有安全提示。</li>
              </ol>
              <div className="mobile-hint">
                App 版会在配对时用二维码里的指纹校验这张 CA（pin{' '}
                <code>{tlsInfo.pin || '—'}</code>），证书被替换会直接拒绝连接。
              </div>
            </details>
          </>
        )}
        {!tlsInfo?.enabled && (
          <div className="mobile-hint">
            开启后手机改用端口 {tlsInfo?.https_port ?? (network?.port ? Number(network.port) + 1 : 8900)}，原先的明文端口仍可供本机界面使用。
          </div>
        )}
      </div>
        </div>
      </details>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Smartphone size={16} />
          手机扫码配对
        </div>
        <div className="mobile-card__row mobile-card__row--top">
          {pairActive ? (
            <QrBox value={pairQr} size={168} alt="手机配对二维码" />
          ) : (
            <div className="mobile-pair-empty">
              <QrCode size={36} />
              <span>{pair ? '配对码已过期' : '等待生成配对码'}</span>
            </div>
          )}
          <div className="mobile-card__main">
            <div className="mobile-pair-url">{appUrl || '未检测到局域网 IP'}</div>
            {pairActive ? (
              <>
                <div className="mobile-pair-code">
                  {pair?.code.replace(/(\d{3})(\d{3})/, '$1 $2')}
                </div>
                <div className="mobile-hint">
                  剩余 {remainingText} 后过期 · 配对码仅可使用一次
                </div>
                <div className="mobile-actions">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyPairLink()}>
                    <Copy size={13} />
                    复制链接
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={pairLoading}
                    onClick={() => void startPairing()}
                  >
                    {pairLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                    刷新二维码
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mobile-hint">
                  点「生成配对码」后，用手机系统相机或微信扫码，会自动打开新版手机页面并完成配对。
                  局域网 HTTP 下浏览器不能调用摄像头，请勿用网页扫码。
                </div>
                {pair && <div className="mobile-warn">配对码已过期，请重新生成。</div>}
                {!lanAccess && (
                  <div className="mobile-warn">局域网访问未开启，请先打开上方开关并重启应用。</div>
                )}
                <div className="mobile-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={pairLoading || !lanAccess}
                    onClick={() => void startPairing()}
                  >
                    {pairLoading ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
                    生成配对码
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="mobile-pair-foot">
          <span>二维码内置一次性配对码，5 分钟内有效</span>
          <span>手机需能访问上方地址（同一 Wi-Fi / 热点 / 虚拟组网）</span>
        </div>
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <ShieldCheck size={16} />
          已配对手机
          <button
            type="button"
            className="btn btn--ghost btn--sm mobile-card__title-action"
            disabled={devicesLoading}
            onClick={() => void loadDevices()}
          >
            {devicesLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            刷新
          </button>
        </div>
        {devices.length === 0 ? (
          <div className="mobile-hint">还没有手机完成配对。生成配对码后扫码即可。</div>
        ) : (
          <div className="mobile-list">
            {devices.map((device) => (
              <div className="mobile-list__row mobile-device-row" key={device.id}>
                <span className={device.online ? 'dot dot--on' : 'dot'} />
                <div className="mobile-list__main">
                  <div className="mobile-list__title">
                    {device.name}
                    <span className="mobile-list__meta">
                      {device.online ? '在线' : lastSeenText(device.last_seen)}
                    </span>
                  </div>
                  <div className="mobile-list__sub">{device.last_ip || device.id}</div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={revoking === device.id}
                  onClick={() => void revokeDevice(device)}
                >
                  {revoking === device.id ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  撤销
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Link2 size={16} />
          手机同步状态
        </div>
        {sessions.length === 0 ? (
          <div className="mobile-hint">暂无手机连接</div>
        ) : (
          <div className="mobile-list">
            {sessions.map((item) => (
              <div className="mobile-list__row" key={item.sid}>
                <span className={item.online ? 'dot dot--on' : 'dot'} />
                <div className="mobile-list__main">
                  <div className="mobile-list__title">
                    {item.ip || '未知设备'}
                    <span className="mobile-list__meta">{item.online ? '在线' : '离线'}</span>
                  </div>
                  <div className="mobile-list__sub">{item.ua || item.sid}</div>
                  {(item.tasks ?? []).length > 0 && (
                    <div className="mobile-list__tasks">
                      {(item.tasks ?? []).slice(-3).map((task, index) => (
                        <div key={`${task.name ?? task.title ?? 'task'}-${index}`}>
                          {task.name ?? task.title ?? '任务'} · {task.done ?? 0}/
                          {task.total ?? '?'}
                          {task.state ? ` · ${task.state}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Send size={16} />
          手机本地书
          <button
            type="button"
            className="btn btn--ghost btn--sm mobile-card__title-action"
            disabled={syncRefreshing}
            onClick={() => void loadLocalSync()}
          >
            {syncRefreshing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            刷新
          </button>
        </div>
        <div className="mobile-hint">
          手机上导入的 EPUB / TXT 会先落到这台电脑的暂存区，确认后再收进小说书库；同名不同内容不会覆盖电脑上的书。
        </div>
        <div className="mobile-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={syncRequesting}
            onClick={() => void startLocalSync()}
          >
            {syncRequesting ? <Loader2 size={14} className="spin" /> : <Smartphone size={14} />}
            同步手机本地
          </button>
          <span className="mobile-hint">
            {localSync?.done_at
              ? `上次同步：${stampText(localSync.done_at)}`
              : '手机会上传尚未回传的书，传完自动停止'}
          </span>
        </div>
        {localSync?.requested && (
          <div className="mobile-warn">
            等待手机上传… 请在手机上打开 Novelist 并保持联网，App 每分钟会自动检查一次。
          </div>
        )}
        {localFiles.length === 0 ? (
          <div className="mobile-hint">暂存区没有待收的文件。</div>
        ) : (
          <div className="mobile-list">
            {localFiles.map((file) => (
              <div className="mobile-list__row mobile-device-row" key={file.name}>
                <div className="mobile-list__main">
                  <div className="mobile-list__title">
                    {file.name}
                    <span className="mobile-list__meta">{formatBytes(file.size)}</span>
                  </div>
                  <div className="mobile-list__sub">上传于 {stampText(file.mtime)}</div>
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={syncBusy === file.name}
                  onClick={() => void importLocalFile(file)}
                >
                  {syncBusy === file.name ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                  收进书库
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={syncBusy === file.name}
                  onClick={() => void discardLocalFile(file)}
                >
                  <Trash2 size={12} />
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Activity size={16} />
          连接体检
          <button
            type="button"
            className="btn btn--ghost btn--sm mobile-card__title-action"
            disabled={doctorBusy}
            onClick={() => void runDoctor()}
          >
            {doctorBusy ? <Loader2 size={12} className="spin" /> : <Activity size={12} />}
            {doctor ? '重新体检' : '开始体检'}
          </button>
        </div>
        <div className="mobile-hint">
          逐项实测：局域网开关、绑定地址、回环、每张网卡、防火墙、SSH 服务端。手机连不上时先看这里。
        </div>
        {doctor && (
          <>
            <div className={`doctor-summary${doctor.ok ? ' is-ok' : ' is-bad'}`}>
              {doctor.ok
                ? `体检通过：${doctor.checks.filter((item) => item.status === 'ok').length} 项正常`
                : `发现 ${doctor.checks.filter((item) => item.status === 'fail').length} 处阻断，按提示处理后重新体检`}
            </div>
            <div className="doctor-list">
              {doctor.checks.map((check) => (
                <div className={`doctor-item doctor-item--${check.status}`} key={check.key}>
                  <span className="doctor-item__dot" />
                  <div className="doctor-item__main">
                    <div className="doctor-item__title">
                      {check.label}
                      {check.recommended && <em className="doctor-item__badge">推荐地址</em>}
                    </div>
                    <div className="doctor-item__detail">{check.detail}</div>
                    {check.hint && <div className="doctor-item__hint">{check.hint}</div>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <details className="mobile-details mobile-card">
        <summary>
          <Terminal size={16} />
          加密通道（SSH 转发）
          {doctor?.ssh?.running && doctor?.ssh?.listening ? (
            <span className="doctor-pill">sshd 运行中</span>
          ) : null}
        </summary>
        <div className="mobile-hint">
          局域网与虚拟组网都是明文 HTTP，配对令牌可能被同网段嗅探。用电脑上已装的 OpenSSH
          服务端把端口经 SSH 转发到手机本地回环，全链路加密，且不必把 HTTP 端口暴露给网络。
        </div>
        {doctor?.ssh && !doctor.ssh.running && (
          <div className="mobile-warn">
            未检测到 sshd。Windows 可在「设置 → 系统 → 可选功能」中安装 OpenSSH 服务器。
          </div>
        )}
        {doctor?.ssh_command ? (
          <>
            <div className="doctor-cmd">
              <code>{doctor.ssh_command}</code>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copySshCommand()}>
                <Copy size={12} />
                复制
              </button>
            </div>
            <ol className="doctor-steps">
              <li>手机装任意 SSH 客户端（Termux、JuiceSSH、Termius 均可），并与电脑处于同一网络或虚拟组网。</li>
              <li>
                把手机客户端的公钥追加到电脑的 <code>~/.ssh/authorized_keys</code>
                （电脑端已设为{doctor.ssh?.password_auth === false ? '仅公钥登录' : '公钥/密码登录'}）。
              </li>
              <li>在手机上执行上面的命令，并保持会话不关闭。</li>
              <li>
                手机浏览器或 App 里把手动地址改成 <code>http://127.0.0.1:{doctor.port}</code> 即可加密访问。
              </li>
            </ol>
          </>
        ) : (
          <div className="mobile-hint">点上方「开始体检」后生成专属命令。</div>
        )}
      </details>
    </div>
  );
}

function HotspotTab({ lanAccess, port }: { lanAccess: boolean; port: string }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<HotspotInfo | null>(null);
  const [qr, setQr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const data = await apiGet<HotspotInfo>('/api/hotspot', force ? { force: 1 } : undefined);
        setInfo(data);
        if (data.hotspot_on) {
          const ip = (data.hotspot_ips ?? [])[0] || data.hotspot_gw;
          setQr(await fetchQr(`http://${ip}:${port || location.port || '8899'}/mobile`));
        } else {
          setQr('');
        }
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : String(cause), 'error');
      } finally {
        setLoading(false);
      }
    },
    [port, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openSettings = async () => {
    try {
      await apiPost('/api/hotspot/open');
      toast('已打开 Windows 热点设置，开启后点「重新检测」', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const hotspotIp = info ? (info.hotspot_ips ?? [])[0] || info.hotspot_gw : '';
  const url = hotspotIp ? `http://${hotspotIp}:${port || location.port || '8899'}/mobile` : '';

  return (
    <div className="mobile-stack">
      <div className="mobile-note">
        校园网 / 公司网常开启 AP 隔离，同网段设备禁止互访。让电脑开启 Windows 移动热点，手机连上后即可绕开限制。
      </div>

      {!lanAccess && (
        <div className="mobile-warn">
          局域网访问未开启：请到「局域网扫码」页签开启并重启应用，否则手机连上热点也打不开本程序。
        </div>
      )}

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Flame size={16} />
          移动热点检测
        </div>
        {info?.hotspot_on ? (
          <div className="mobile-status mobile-status--ok">
            <span className="dot dot--on" />
            移动热点已开启，热点网段 IP：<code>{hotspotIp}</code>
          </div>
        ) : (
          <div className="mobile-status">
            <span className="dot" />
            移动热点未开启（检测不到 192.168.137.x 网段）
          </div>
        )}
        <div className="mobile-hint">
          无线状态：{info?.wifi_state || '未知'}
          {info?.wifi_ssid ? `（SSID：${info.wifi_ssid}）` : ''} · 本机 IP：
          {(info?.ips ?? []).join(' / ') || '无'}
        </div>
        {info?.hotspot_on && (
          <div className="mobile-card__row mobile-card__row--top">
            <QrBox value={qr} alt="热点二维码" />
            <div className="mobile-card__main">
              <div className="mobile-hint">手机连接电脑热点后扫码：</div>
              <div className="mobile-url">{url}</div>
            </div>
          </div>
        )}
        <div className="mobile-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openSettings()}>
            <ExternalLink size={14} />
            打开 Windows 热点设置
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={loading}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            重新检测
          </button>
        </div>
      </div>
    </div>
  );
}

function TunnelTab() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TunnelInfo | null>(null);
  const [qr, setQr] = useState('');
  const [autoQr, setAutoQr] = useState('');
  const [autoUrl, setAutoUrl] = useState('');
  const [cmd, setCmd] = useState('');
  const [args, setArgs] = useState('');
  const [presets, setPresets] = useState<Record<string, { label: string; args_hint: string }>>({});
  const [clients, setClients] = useState<{ path: string; name: string; provider: string }[]>([]);
  const [regex, setRegex] = useState('');
  const [busy, setBusy] = useState('');
  const seeded = useRef(false);

  const loadPresets = useCallback(async () => {
    try {
      const data = await apiGet<{ providers?: Record<string, { label: string; args_hint: string }>; clients?: { path: string; name: string; provider: string }[] }>('/api/tunnel_presets');
      setPresets(data.providers || {});
      setClients(data.clients || []);
    } catch {
      // 老后端没有该接口时保持手填
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<TunnelInfo>('/api/tunnel');
      setStatus(data);
      if (!seeded.current) {
        seeded.current = true;
        setCmd(data.config?.cmd ?? data.cmd ?? '');
        setArgs(data.config?.args?.join(' ') ?? (data.args ?? []).join(' '));
        setRegex(data.config?.url_regex ?? '');
      }
      if (data.running && data.url) {
        setQr(await fetchQr(`${data.url.replace(/\/$/, '')}/mobile`));
      } else {
        setQr('');
        setAutoQr('');
        setAutoUrl('');
      }
    } catch {
      /* 静默轮询 */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPresets();
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [load, loadPresets]);

  const start = async () => {
    if (!cmd.trim()) {
      toast('请先填写隧道客户端路径', 'error');
      return;
    }
    setBusy('start');
    try {
      await apiPost('/api/tunnel', {
        action: 'start',
        cmd: cmd.trim(),
        args,
        url_regex: regex,
      });
      setAutoUrl('');
      setAutoQr('');
      toast('隧道已启动，正在获取公网地址…', 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await apiPost('/api/tunnel', { action: 'stop' });
      setAutoUrl('');
      setAutoQr('');
      toast('隧道已停止', 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const autoStart = async () => {
    setBusy('auto');
    try {
      const data = await apiPost<{ ok?: boolean; url?: string; preset?: string }>('/api/tunnel', {
        action: 'start_auto',
      });
      if (!data.ok || !data.url) throw new Error('免费隧道服务暂时不可用');
      const direct = `${data.url.replace(/\/$/, '')}/direct?via=tunnel`;
      setAutoUrl(direct);
      setAutoQr(await fetchQr(direct));
      toast(`临时隧道已建立（${data.preset ?? 'SSH'}）`, 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const mobileUrl = status?.running && status.url ? `${status.url.replace(/\/$/, '')}/mobile` : '';

  return (
    <div className="mobile-stack">
      <div className="mobile-note">
        电脑主动出站连接隧道服务，手机通过公网域名访问。需先安装 natapp / cpolar / frp
        等客户端，或用下方免注册临时隧道。
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Globe2 size={16} />
          临时隧道（免注册，首次准备推荐）
        </div>
        <div className="mobile-hint">
          使用系统自带 ssh 连接免费隧道服务，手机任意网络扫码即可打开连接页。
        </div>
        <div className="mobile-actions">
          <button type="button" className="btn btn--sm" disabled={busy === 'auto'} onClick={() => void autoStart()}>
            {busy === 'auto' ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
            {busy === 'auto' ? '正在连接（最多约 40 秒）…' : '一键开启临时隧道'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => downloadUrl('/direct?dl=1', 'NovelCrawler-远程直连.html')}
          >
            <Download size={14} />
            下载连接文件
          </button>
        </div>
        {autoUrl && autoQr ? (
          <div className="mobile-card__row mobile-card__row--top">
            <QrBox value={autoQr} size={132} alt="临时隧道连接页二维码" />
            <div className="mobile-card__main">
              <div className="mobile-hint">手机（任意网络）扫码打开远程直连页：</div>
              <div className="mobile-url">{autoUrl}</div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Router size={16} />
          自定义隧道客户端
        </div>
        {status?.running ? (
          <div className="mobile-status mobile-status--ok">
            <span className="dot dot--on" />
            隧道运行中{status.uptime ? `（已运行 ${Math.round(status.uptime / 60)} 分钟）` : ''}
            {status.restart_count ? ` · 自动重启 ${status.restart_count} 次` : ''}
          </div>
        ) : (
          <div className="mobile-status">
            <span className="dot" />
            隧道未运行
          </div>
        )}
        {status?.running && mobileUrl && (
          <div className="mobile-card__row mobile-card__row--top">
            <QrBox value={qr} alt="公网隧道二维码" />
            <div className="mobile-card__main">
              <div className="mobile-hint">手机任意网络扫码 / 访问：</div>
              <div className="mobile-url">{mobileUrl}</div>
            </div>
          </div>
        )}
        {status?.running && !status.url && (
          <div className="mobile-warn">尚未捕获公网地址，请确认客户端会在日志中打印地址。</div>
        )}

        <div className="form-grid mobile-form">
          <label className="field mobile-form__full">
            <span>服务商预设（自动填客户端与参数）</span>
            <select
              className="input"
              defaultValue=""
              onChange={(event) => {
                const key = event.target.value;
                const preset = presets[key];
                if (!preset) return;
                setArgs(preset.args_hint.replace(/（.*?）/g, '').trim());
                const hit = clients.find((item) => item.provider === key);
                if (hit) setCmd(hit.path);
                else if (!clients.length) toast('没自动找到客户端，请手动填路径', 'error');
              }}
            >
              <option value="">— 选择穿透服务 —</option>
              {Object.entries(presets).map(([key, item]) => (
                <option key={key} value={key}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="field mobile-form__full">
            <span>隧道客户端路径</span>
            <input
              className="input"
              value={cmd}
              placeholder="C:\tools\natapp.exe / cpolar.exe / frpc.exe"
              onChange={(event) => setCmd(event.target.value)}
            />
          </label>
          <label className="field mobile-form__full">
            <span>启动参数</span>
            <input
              className="input"
              value={args}
              placeholder="-authtoken=xxxx / http -port=8899"
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <label className="field mobile-form__full">
            <span>公网地址识别正则（高级，一般留空）</span>
            <input
              className="input"
              value={regex}
              placeholder="留空 = 默认规则"
              onChange={(event) => setRegex(event.target.value)}
            />
          </label>
        </div>

        <div className="mobile-actions">
          <button type="button" className="btn btn--sm" disabled={busy === 'start'} onClick={() => void start()}>
            <Globe2 size={14} />
            启动隧道
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy === 'stop'} onClick={() => void stop()}>
            <Square size={14} />
            停止
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
            <RefreshCw size={14} />
            刷新状态
          </button>
        </div>

        <details className="mobile-details">
          <summary>客户端日志</summary>
          <pre className="mobile-log">{(status?.log_tail ?? []).join('\n') || '暂无日志'}</pre>
        </details>
      </div>
    </div>
  );
}

function WrtcTab() {
  const { toast } = useToast();
  const [status, setStatus] = useState<WrtcStatus | null>(null);
  const [qr, setQr] = useState('');
  const [offerCode, setOfferCode] = useState('');
  const [session, setSession] = useState('');
  const [answer, setAnswer] = useState('');
  const [turn, setTurn] = useState({ url: '', user: '', pass: '' });
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiGet<WrtcStatus>('/api/webrtc/status');
      setStatus(data);
    } catch {
      /* 静默轮询 */
    }
  }, []);

  useEffect(() => {
    void load();
    void apiGet<SettingsData>('/api/settings')
      .then((data) =>
        setTurn({
          url: data.settings?.webrtc_turn_url ?? '',
          user: data.settings?.webrtc_turn_user ?? '',
          pass: data.settings?.webrtc_turn_pass ?? '',
        }),
      )
      .catch(() => undefined);
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  const generate = async () => {
    setBusy('offer');
    try {
      const data = await apiGet<{
        ok?: boolean;
        session?: string;
        qr_b64?: string;
        offer?: string;
        signal_auto?: boolean;
      }>('/api/webrtc/offer');
      if (!data.ok) throw new Error('生成连接码失败');
      setSession(data.session ?? '');
      setQr(data.qr_b64 ?? '');
      setOfferCode(data.offer ?? '');
      toast(
        data.signal_auto ? '连接码已生成，手机扫码后应答码会自动回传' : '连接码已生成，请用摄像头或手动应答码',
        'success',
      );
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const copyOffer = async () => {
    try {
      await navigator.clipboard.writeText(offerCode);
      toast('连接码已复制，去手机「连接电脑 → 直连」里粘贴', 'success');
    } catch {
      toast('复制失败，请手动选择文本框内容', 'error');
    }
  };

  const disconnect = async () => {
    setBusy('stop');
    try {
      await apiPost('/api/webrtc/stop', {});
      setSession('');
      setQr('');
      setOfferCode('');
      toast('已断开全部直连会话', 'success');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleCam = async () => {
    const running = Boolean(status?.cam?.running);
    setBusy('cam');
    try {
      await apiPost('/api/webrtc/cam', { action: running ? 'stop' : 'start' });
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const submitAnswer = async () => {
    if (!session) {
      toast('请先生成连接码', 'error');
      return;
    }
    if (!answer.trim()) {
      toast('请粘贴手机端应答码', 'error');
      return;
    }
    setBusy('answer');
    try {
      await apiPost('/api/webrtc/answer', { session, answer_b64: answer.trim() });
      toast('应答码已提交，等待直连建立…', 'success');
      setAnswer('');
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const saveTurn = async () => {
    setBusy('turn');
    try {
      await apiPost('/api/settings', {
        webrtc_turn_url: turn.url,
        webrtc_turn_user: turn.user,
        webrtc_turn_pass: turn.pass,
      });
      toast('TURN 配置已保存，重新生成连接码后生效', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const sessions = status?.sessions ?? [];
  const camRunning = Boolean(status?.cam?.running);
  const signalOnline = status?.signal?.online ?? 0;

  return (
    <div className="mobile-stack">
      <div className="mobile-note">
        手机在任何网络与电脑点对点直连：电脑生成连接码 → 手机 App「连接电脑 → 直连」扫一次码即可。
      </div>

      {status?.available === false && (
        <div className="mobile-warn">
          未安装 WebRTC 库（aiortc），该方式暂不可用。安装依赖后重启程序即可启用。
        </div>
      )}

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Zap size={16} />
          点对点直连
        </div>
        <div className="mobile-actions">
          <button type="button" className="btn btn--sm" disabled={busy === 'offer'} onClick={() => void generate()}>
            <Link2 size={14} />
            生成连接码
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy === 'cam'}
            onClick={() => void toggleCam()}
          >
            <Camera size={14} />
            {camRunning ? '停止摄像头扫码' : '摄像头扫码（兜底）'}
          </button>
          {(sessions.length > 0 || session) && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy === 'stop'}
              onClick={() => void disconnect()}
            >
              <Square size={14} />
              断开
            </button>
          )}
        </div>

        {qr && (
          <div className="mobile-card__row mobile-card__row--top">
            <div className="mobile-qr mobile-qr--lg">
              <img src={qrSrc(qr)} alt="WebRTC 连接码" />
            </div>
            <div className="mobile-card__main">
              <div className="mobile-card__title">手机端操作</div>
              <div className="mobile-hint">
                1. 手机打开 App「连接电脑」页，选「直连」
                <br />
                2. 点「扫描电脑连接码」对准二维码
                <br />
                3. 等待自动握手，成功后自动进入书库
              </div>
            </div>
          </div>
        )}

        {sessions.length > 0 ? (
          <div className="mobile-list">
            {sessions.map((item) => (
              <div className="mobile-list__row" key={item.session}>
                <span className={item.connected ? 'dot dot--on' : 'dot'} />
                <div className="mobile-list__main">
                  <div className="mobile-list__title">
                    会话 {item.session}
                    <span className="mobile-list__meta">
                      {item.connected ? '已直连' : item.answer_ok ? '打洞中' : '等待扫码'} · {Math.round(item.age)}s
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mobile-hint">暂无直连会话</div>
        )}

        {status?.signal?.topic && (
          <div className={signalOnline > 0 ? 'mobile-status mobile-status--ok' : 'mobile-warn'}>
            云端自动回传：{signalOnline > 0 ? `${signalOnline}/3 中继节点已连接` : '未连上，请改用摄像头或手动粘贴应答码'}
          </div>
        )}
      </div>

      <details className="mobile-details mobile-card">
        <summary>兜底方式：手动粘贴应答码 / 事件日志</summary>
        <div className="mobile-card__main" style={{ marginTop: 10 }}>
          {offerCode && (
            <>
              <div className="mobile-hint">
                手机在当前网络下不能扫码时（例如局域网 HTTP 页面），复制这段连接码，粘贴到手机「连接电脑 → 直连 →
                粘贴连接码文本」，再点「建立直连」。
              </div>
              <textarea className="input mobile-textarea" readOnly value={offerCode} />
              <div className="mobile-actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyOffer()}>
                  <Copy size={14} />
                  复制连接码
                </button>
              </div>
            </>
          )}
          <textarea
            className="input mobile-textarea"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="粘贴手机端应答码（novelist-wrtc://v1/…）"
          />
          <div className="mobile-actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy === 'answer'}
              onClick={() => void submitAnswer()}
            >
              <Send size={14} />
              提交应答码
            </button>
          </div>
          <pre className="mobile-log">{(status?.events ?? []).slice(-14).join('\n') || '暂无事件'}</pre>
        </div>
      </details>

      <details className="mobile-details mobile-card">
        <summary>TURN 中继（打洞总失败时配置，可留空）</summary>
        <div className="mobile-card__main" style={{ marginTop: 10 }}>
          <div className="mobile-hint">
            校园网多为对称 NAT，可配置 metered.ca 等免费 TURN 节点兜底。
          </div>
          <div className="form-grid mobile-form">
            <label className="field mobile-form__full">
              <span>TURN 地址（多个逗号分隔）</span>
              <input
                className="input"
                value={turn.url}
                placeholder="turn:openrelay.metered.ca:443?transport=tcp"
                onChange={(event) => setTurn({ ...turn, url: event.target.value })}
              />
            </label>
            <label className="field">
              <span>用户名</span>
              <input
                className="input"
                value={turn.user}
                onChange={(event) => setTurn({ ...turn, user: event.target.value })}
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                className="input"
                type="password"
                value={turn.pass}
                onChange={(event) => setTurn({ ...turn, pass: event.target.value })}
              />
            </label>
          </div>
          <div className="mobile-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy === 'turn'}
              onClick={() => void saveTurn()}
            >
              保存 TURN 配置
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function PackTab() {
  const { toast } = useToast();
  const [books, setBooks] = useState<FileEntry[]>([]);
  const [comics, setComics] = useState<ComicFileGroup[]>([]);
  const [bookSel, setBookSel] = useState<string[]>([]);
  const [comicSel, setComicSel] = useState<string[]>([]);
  const [withFiles, setWithFiles] = useState(true);
  const [job, setJob] = useState('');
  const [progress, setProgress] = useState(0);
  const [packState, setPackState] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiGet<{ files?: FileEntry[] }>('/api/files'),
      apiGet<{ items?: ComicFileGroup[] }>('/api/comic_files'),
    ])
      .then(([fileData, comicData]) => {
        if (!alive) return;
        setBooks(fileData.files ?? []);
        setComics(comicData.items ?? []);
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), 'error'))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  useEffect(() => {
    if (!job) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void apiGet<{ status?: string; progress?: number; error?: string }>('/api/snapshot_status', { job })
        .then((data) => {
          if (!alive) return;
          setProgress(data.progress ?? 0);
          setPackState(data.status ?? '');
          if (data.status === 'ready') {
            window.clearInterval(timer);
            downloadUrl(`/api/snapshot_download?job=${encodeURIComponent(job)}`, 'NovelCrawler-离线版.zip');
            setJob('');
            setPackState('');
            setProgress(0);
            toast('离线包已下载，可发送到手机', 'success');
          } else if (data.status === 'error' || data.status === 'not_found') {
            window.clearInterval(timer);
            setJob('');
            setPackState('');
            toast(`打包失败：${data.error || '未知原因'}`, 'error');
          }
        })
        .catch(() => undefined);
    }, 700);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [job, toast]);

  const toggle = (list: string[], setList: (value: string[]) => void, name: string) => {
    setList(list.includes(name) ? list.filter((item) => item !== name) : [...list, name]);
  };

  const toggleAll = (list: string[], setList: (value: string[]) => void, all: string[]) => {
    setList(list.length === all.length ? [] : all);
  };

  const estimate = useMemo(() => {
    let size = 0;
    bookSel.forEach((name) => {
      const file = books.find((item) => item.name === name);
      if (file) size += file.size * 1.4;
    });
    comicSel.forEach((title) => {
      const comic = comics.find((item) => item.title === title);
      if (comic) size += comic.size;
    });
    return size;
  }, [bookSel, comicSel, books, comics]);

  const start = async () => {
    if (!bookSel.length && !comicSel.length) {
      toast('请先勾选要打包的小说或漫画', 'error');
      return;
    }
    try {
      const data = await apiPost<{ job_id?: string; error?: string }>('/api/snapshot_start', {
        favs: bookSel,
        comics: comicSel,
        with_files: withFiles,
        sid: '',
      });
      if (!data.job_id) throw new Error(data.error || '无法启动打包');
      setJob(data.job_id);
      setProgress(0);
      setPackState('packing');
      toast('已开始打包…', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const bookNames = books.map((item) => item.name);
  const comicNames = comics.map((item) => item.title);
  const total = bookSel.length + comicSel.length;

  return (
    <div className="mobile-stack">
      <div className="mobile-note">
        把已下载的小说 / 漫画打包成离线文件，通过微信 / QQ / 邮件发给手机，无需连接电脑即可阅读。
      </div>

      <div className="mobile-card">
        <div className="mobile-card__title">
          <Package size={16} />
          打包选项
        </div>
        <div className="mobile-actions">
          <div className="segmented">
            <button type="button" className="is-on" disabled>
              离线手机包（ZIP）
            </button>
          </div>
          {(
            <label className="mobile-check">
              <input type="checkbox" checked={withFiles} onChange={(event) => setWithFiles(event.target.checked)} />
              含原文件（EPUB / PDF）
            </label>
          )}
        </div>

        <div className="mobile-pack-grid">
          <div className="mobile-pack">
            <div className="mobile-pack__head">
              <b>小说</b>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => toggleAll(bookSel, setBookSel, bookNames)}
              >
                全选 / 清空
              </button>
            </div>
            <div className="mobile-pack__list">
              {loading ? (
                <div className="mobile-hint">加载中…</div>
              ) : books.length === 0 ? (
                <div className="mobile-hint">暂无小说文件</div>
              ) : (
                books.map((item) => (
                  <label className="mobile-check" key={item.name}>
                    <input
                      type="checkbox"
                      checked={bookSel.includes(item.name)}
                      onChange={() => toggle(bookSel, setBookSel, item.name)}
                    />
                    <span className="mobile-check__name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="mobile-check__size">{resultText(item.size)}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="mobile-pack">
            <div className="mobile-pack__head">
              <b>漫画</b>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => toggleAll(comicSel, setComicSel, comicNames)}
              >
                全选 / 清空
              </button>
            </div>
            <div className="mobile-pack__list">
              {loading ? (
                <div className="mobile-hint">加载中…</div>
              ) : comics.length === 0 ? (
                <div className="mobile-hint">暂无漫画文件</div>
              ) : (
                comics.map((item) => (
                  <label className="mobile-check" key={item.title}>
                    <input
                      type="checkbox"
                      checked={comicSel.includes(item.title)}
                      onChange={() => toggle(comicSel, setComicSel, item.title)}
                    />
                    <span className="mobile-check__name" title={item.title}>
                      {item.title}
                    </span>
                    <span className="mobile-check__size">{resultText(item.size)}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mobile-actions">
          <button type="button" className="btn btn--sm" disabled={Boolean(job)} onClick={() => void start()}>
            <Package size={14} />
            {job ? '正在打包…' : '开始打包并下载'}
          </button>
          <span className="mobile-hint">
            {total ? `已选 ${total} 项 · 预计约 ${resultText(estimate)}` : '未选择内容'}
          </span>
        </div>

        {job && (
          <div className="mobile-progress">
            <div className="mobile-hint">{packState === 'ready' ? '打包完成，开始下载…' : `正在打包… ${progress}%`}</div>
            <div className="progress-track">
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        <div className="mobile-hint">
          打包完成后把文件发到手机：HTML 直接打开；ZIP 解压后打开其中的 index.html。
        </div>
      </div>
    </div>
  );
}

export function MobilePage() {
  const [tab, setTab] = useState<Tab>('lan');
  const [lanAccess, setLanAccess] = useState(false);
  const [port, setPort] = useState('');

  useEffect(() => {
    void apiGet<NetworkInfo>('/api/network')
      .then((data) => {
        setLanAccess(Boolean(data.lan_access));
        setPort(data.port || '');
      })
      .catch(() => undefined);
  }, []);

  const content =
    tab === 'lan' ? (
      <LanTab lanAccess={lanAccess} onLanChange={setLanAccess} />
    ) : tab === 'hotspot' ? (
      <HotspotTab lanAccess={lanAccess} port={port} />
    ) : tab === 'tunnel' ? (
      <TunnelTab />
    ) : tab === 'wrtc' ? (
      <WrtcTab />
    ) : (
      <PackTab />
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">手机连接</h1>
          <p className="page-desc">局域网扫码、热点接力、公网穿透、点对点直连与离线手机包。</p>
        </div>
      </div>

      <div className="segmented mobile-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            className={tab === item.value ? 'is-on' : ''}
            onClick={() => setTab(item.value)}
          >
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </div>

      {content}
    </div>
  );
}
