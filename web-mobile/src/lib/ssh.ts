/**
 * App 内置 SSH 通道(密码认证 + 本地端口转发)。
 *
 * 用途:电脑在校园网/公网后面、手机和电脑不在同一网段时,直连会被 AP 隔离或
 * NAT 挡住。用一条 SSH 隧道把「电脑上的服务端口」映射到手机本机端口,App 之后
 * 只要访问 http://127.0.0.1:<localPort> 就等于访问电脑,流量全程加密。
 *
 * 只传密码,不传任何密钥文件。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SshConnectResult {
  ok: boolean;
  localPort: number;
  host: string;
  hostFingerprint: string;
}

interface SshStatus {
  connected: boolean;
  localPort: number;
  host: string;
  hostFingerprint: string;
}

interface SshNative {
  connect(options: {
    host: string;
    port?: number;
    user: string;
    password: string;
    localPort?: number;
    remotePort: number;
  }): Promise<SshConnectResult>;
  status(): Promise<SshStatus>;
  disconnect(): Promise<{ ok: boolean }>;
}

const SshTunnel = registerPlugin<SshNative>('SshTunnel');

export interface SshTarget {
  user: string;
  host: string;
  port: number;
}

export function sshAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SshTunnel');
  } catch {
    return false;
  }
}

/** 解析二维码里的 `ssh=user@host:port`。 */
export function parseSshParam(raw: string | null | undefined): SshTarget | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const at = text.lastIndexOf('@');
  if (at <= 0) return null;
  const user = text.slice(0, at);
  let host = text.slice(at + 1);
  let port = 22;
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    const maybe = Number(host.slice(colon + 1));
    if (Number.isFinite(maybe) && maybe > 0 && maybe < 65536) {
      port = maybe;
      host = host.slice(0, colon);
    }
  }
  if (!user || !host) return null;
  return { user, host, port };
}

export function sshTargetText(target: SshTarget | null): string {
  if (!target) return '';
  return `${target.user}@${target.host}:${target.port}`;
}

export async function sshStatus(): Promise<SshStatus> {
  if (!sshAvailable()) return { connected: false, localPort: 0, host: '', hostFingerprint: '' };
  try {
    return await SshTunnel.status();
  } catch {
    return { connected: false, localPort: 0, host: '', hostFingerprint: '' };
  }
}

/**
 * 建隧道。remotePort 是电脑上的服务端口,localPort 缺省用同一个。
 * 失败会抛 Error(带 native 给的原文,便于用户判断是密码错还是网络不通)。
 */
export async function sshConnect(
  target: SshTarget,
  password: string,
  remotePort: number,
  localPort = remotePort,
): Promise<SshConnectResult> {
  if (!sshAvailable()) throw new Error('当前环境不支持 SSH 通道，请使用 App 版');
  return SshTunnel.connect({
    host: target.host,
    port: target.port,
    user: target.user,
    password,
    remotePort,
    localPort,
  });
}

export async function sshDisconnect(): Promise<void> {
  if (!sshAvailable()) return;
  try {
    await SshTunnel.disconnect();
  } catch {
    // 已经断开就算了
  }
}
