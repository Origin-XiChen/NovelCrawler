import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-react';
import { apiGet, apiPost, checkServer } from '../lib/api';
import {
  getActiveServer,
  getServers,
  removeServer,
  setActiveServer,
  touchServer,
} from '../lib/connection';
import { errorMessage, relativeTime } from '../lib/format';
import { clearProgress } from '../lib/progress';
import type { DeviceList, MobileDevice, ServerEntry } from '../lib/types';

const APP_VERSION = '0.1.0';

export default function SettingsPage() {
  const navigate = useNavigate();
  const [active] = useState<ServerEntry | null>(() => getActiveServer());
  const [servers, setServers] = useState<ServerEntry[]>(() => getServers());
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [deviceError, setDeviceError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [testing, setTesting] = useState(false);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDeviceError('');
    try {
      const data = await apiGet<DeviceList>('/api/mobile/devices');
      setDevices(data.devices || []);
    } catch (cause) {
      setDeviceError(errorMessage(cause));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      navigate('/connect', { replace: true });
      return;
    }
    void loadDevices();
  }, [active, loadDevices, navigate]);

  if (!active) return null;

  const testConnection = async () => {
    setTesting(true);
    setNotice('');
    try {
      const ok = await checkServer(active);
      setNotice(ok ? '连接正常，电脑在线。' : '连接失败：电脑可能已关机或退出局域网，请重新扫码配对。');
    } finally {
      setTesting(false);
    }
  };

  const revokeDevice = async (device: MobileDevice) => {
    if (!window.confirm(`撤销「${device.name}」的配对权限？该设备需要重新扫码才能使用。`)) return;
    setBusy(device.id);
    setNotice('');
    try {
      const result = await apiPost<{ ok: boolean; error?: string }>('/api/mobile/devices/revoke', {
        device_id: device.id,
      });
      if (!result.ok) throw new Error(result.error || '撤销失败');
      setNotice(`已撤销「${device.name}」的配对权限。`);
      await loadDevices();
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const clearReadingProgress = () => {
    if (!window.confirm('清除本机记录的所有阅读进度？电脑上的书籍不受影响。')) return;
    clearProgress(active.id);
    setNotice('已清除本机阅读进度。');
  };

  const switchServer = async (server: ServerEntry) => {
    if (server.id === active.id) {
      navigate('/library');
      return;
    }
    setBusy(server.id);
    setNotice('');
    try {
      const ok = await checkServer(server);
      if (!ok) {
        setNotice(`「${server.name}」连接失败，可能需要重新配对。`);
        return;
      }
      setActiveServer(server.id);
      touchServer(server.id);
      navigate('/library', { replace: true });
    } finally {
      setBusy('');
    }
  };

  const deleteServer = (server: ServerEntry) => {
    if (!window.confirm(`移除「${server.name}」的本机配对信息？`)) return;
    removeServer(server.id);
    setServers(getServers());
    setNotice('已移除本机配对信息。');
  };

  const disconnect = async () => {
    if (
      !window.confirm(
        `断开与「${active.name}」的连接？本机配对信息会清除，再次阅读需要重新扫码配对。`,
      )
    ) {
      return;
    }
    setBusy('disconnect');
    try {
      await apiPost('/api/mobile/devices/revoke', { device_id: active.id });
    } catch {
      // 电脑离线时仍需允许本机断开
    }
    removeServer(active.id);
    navigate('/connect', { replace: true });
  };

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div>
          <span className="settings-header__eyebrow">我的</span>
          <h1>手机阅读</h1>
          <p>管理电脑连接和本机阅读数据</p>
        </div>
        <div className="settings-header__mark">
          <BookOpen size={26} strokeWidth={1.8} />
        </div>
      </header>

      {notice && (
        <div className="banner banner--info">
          <span>{notice}</span>
          <button type="button" className="text-btn" onClick={() => setNotice('')}>
            知道了
          </button>
        </div>
      )}

      <section className="settings-hero">
        <div className="settings-hero__icon">
          <Server size={24} />
        </div>
        <div className="settings-hero__main">
          <div className="settings-hero__title">
            {active.name}
            <span className="settings-hero__badge">v{active.version || '?'}</span>
          </div>
          <div className="settings-hero__url">{active.baseUrl.replace(/^https?:\/\//, '')}</div>
          <div className="settings-hero__meta">
            <Wifi size={13} /> 局域网直连 · API {active.api}
          </div>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={testing}
          onClick={() => void testConnection()}
        >
          {testing ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
          测试
        </button>
      </section>

      <section className="settings-section">
        <div className="settings-section__head">
          <h2>
            <Smartphone size={17} />
            已配对设备
          </h2>
          <button
            type="button"
            className="text-btn"
            disabled={devicesLoading}
            onClick={() => void loadDevices()}
          >
            {devicesLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            刷新
          </button>
        </div>
        <div className="settings-card">
          {deviceError ? (
            <div className="settings-empty settings-empty--error">
              <CircleAlert size={18} />
              <span>{deviceError}</span>
            </div>
          ) : devicesLoading && devices.length === 0 ? (
            <div className="settings-empty">
              <Loader2 size={18} className="spin" />
              <span>正在读取设备列表…</span>
            </div>
          ) : devices.length === 0 ? (
            <div className="settings-empty">
              <span>暂无已配对设备</span>
            </div>
          ) : (
            devices.map((device) => {
              const current = device.id === active.id;
              return (
                <div className="device-row" key={device.id}>
                  <span className={`device-dot${device.online ? ' is-online' : ''}`} />
                  <div className="device-row__main">
                    <div className="device-row__title">
                      {device.name}
                      {current && <span className="device-row__badge">本机</span>}
                    </div>
                    <div className="device-row__meta">
                      {device.last_ip || '未知地址'} · {relativeTime(device.last_seen)}
                    </div>
                  </div>
                  {!current && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      aria-label={`撤销 ${device.name}`}
                      disabled={busy === device.id}
                      onClick={() => void revokeDevice(device)}
                    >
                      {busy === device.id ? (
                        <Loader2 size={17} className="spin" />
                      ) : (
                        <Trash2 size={17} />
                      )}
                    </button>
                  )}
                  {current && <CircleCheck size={19} className="settings-current-icon" />}
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__head">
          <h2>阅读数据</h2>
        </div>
        <div className="settings-card">
          <button type="button" className="settings-item" onClick={clearReadingProgress}>
            <span className="settings-item__icon">
              <RotateCcw size={19} />
            </span>
            <span className="settings-item__main">
              <b>清除本机阅读进度</b>
              <em>只影响这台手机的记录，电脑书籍不变</em>
            </span>
            <ChevronRight size={18} className="muted" />
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__head">
          <h2>我的电脑</h2>
          <span>{servers.length} 台</span>
        </div>
        <div className="settings-card">
          {servers.map((server) => (
            <div className="server-row" key={server.id}>
              <button type="button" className="server-row__main" onClick={() => void switchServer(server)}>
                <span className="server-row__icon">
                  <Server size={18} />
                </span>
                <span className="server-row__text">
                  <b>{server.name}</b>
                  <em>{server.baseUrl.replace(/^https?:\/\//, '')}</em>
                </span>
                {server.id === active.id ? (
                  <span className="server-row__active">当前</span>
                ) : busy === server.id ? (
                  <Loader2 size={17} className="spin" />
                ) : (
                  <ChevronRight size={18} className="muted" />
                )}
              </button>
              {server.id !== active.id && (
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  aria-label={`移除 ${server.name}`}
                  onClick={() => deleteServer(server)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <button
        type="button"
        className="btn btn--danger btn--lg disconnect-btn"
        disabled={busy === 'disconnect'}
        onClick={() => void disconnect()}
      >
        {busy === 'disconnect' ? <Loader2 size={18} className="spin" /> : <LogOut size={18} />}
        断开与这台电脑的连接
      </button>

      <footer className="settings-about">
        <div>NovelCrawler 手机版 v{APP_VERSION}</div>
        <div>
          电脑端 v{active.version || '未知'} · 配对 API {active.api}
        </div>
        <p>电脑负责下载整理，手机负责阅读。数据只在局域网内传输。</p>
      </footer>
    </div>
  );
}
