/**
 * 自签 HTTPS 的证书固定 —— 手机端。
 *
 * 思路(TOFU + 二维码带指纹,不用依赖系统信任库):
 *   1. 电脑生成一张自己的 CA,服务器证书由它签发;
 *   2. 配对二维码里带 `pin`(CA 证书 SHA-256 的前 128 位);
 *   3. 手机第一次连 https 时,先「忽略证书」把 /tls/ca.crt 取回来,
 *      用二维码里的 pin 校验它 —— 指纹是从屏幕上扫来的,攻击者改不了;
 *   4. 校验通过后把这张 CA 固定进原生 TrustManager,之后所有 https 请求
 *      只认这一张 CA(系统里其他根证书一律不认)。
 *
 * 没有原生插件时(浏览器里调试)自动退回普通 fetch,不阻塞功能。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface PinnedFetchResult {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  certPin?: string;
  chainPem?: string;
}

interface PinnedHttpsNative {
  status(): Promise<{ installed: boolean; pin: string }>;
  install(options: { pem: string; pin?: string }): Promise<{ ok: boolean; pin: string }>;
  clear(): Promise<{ ok: boolean }>;
  fetch(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    dataBase64?: string;
    timeout?: number;
    insecure?: boolean;
    wantCert?: boolean;
  }): Promise<PinnedFetchResult>;
}

const PinnedHttps = registerPlugin<PinnedHttpsNative>('PinnedHttps');

export function pinnedAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PinnedHttps');
  } catch {
    return false;
  }
}

function bytesToB64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 与电脑端 novel/tls.py::short_fingerprint 同口径:DER 的 SHA-256 前 16 字节。 */
export async function shortPinOfPem(pem: string): Promise<string> {
  const body = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) der[i] = raw.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', der);
  return bytesToB64Url(new Uint8Array(digest).slice(0, 16));
}

function b64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(text);
}

export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinError';
  }
}

/** 当前已固定的指纹(未固定返回空串)。 */
export async function pinnedStatus(): Promise<{ installed: boolean; pin: string }> {
  if (!pinnedAvailable()) return { installed: false, pin: '' };
  try {
    return await PinnedHttps.status();
  } catch {
    return { installed: false, pin: '' };
  }
}

/**
 * 确保已经固定这台电脑的 CA。
 * @param base 服务器基址(https://ip:port)
 * @param pin  二维码里带来的指纹;为空时只按「接受当前证书」处理(浏览器调试)
 */
export async function ensurePinned(base: string, pin?: string): Promise<boolean> {
  if (!pinnedAvailable()) return false;
  const want = String(pin || '').trim();
  const current = await pinnedStatus();
  if (current.installed && (!want || current.pin === want)) return true;
  // 指纹对不上(电脑重装过/换了 CA):旧固定值作废,重新走一次校验
  if (current.installed && want && current.pin !== want) {
    await PinnedHttps.clear().catch(() => undefined);
  }

  let res: PinnedFetchResult;
  try {
    res = await PinnedHttps.fetch({
      url: `${base.replace(/\/+$/, '')}/tls/ca.crt`,
      method: 'GET',
      insecure: true,
      timeout: 8000,
    });
  } catch (cause) {
    throw new PinError(
      `取证书失败：${cause instanceof Error ? cause.message : String(cause)}。确认电脑已开启 HTTPS。`,
    );
  }
  if (res.status !== 200) {
    throw new PinError(`电脑还没生成证书（HTTP ${res.status}），请先在电脑上打开「加密访问」。`);
  }
  const pem = new TextDecoder().decode(b64ToBytes(res.bodyBase64));
  if (!pem.includes('BEGIN CERTIFICATE')) {
    throw new PinError('电脑返回的不是证书文件');
  }
  const actual = await shortPinOfPem(pem);
  if (want && actual !== want) {
    throw new PinError('证书指纹与二维码不一致，可能有人在中间冒充电脑，已断开');
  }
  await PinnedHttps.install({ pem, pin: want || actual });
  return true;
}

/** 走固定通道的请求(只在 https + 原生环境生效)。 */
export async function pinnedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const source = new Headers(init.headers || {});
  source.forEach((value, key) => {
    headers[key] = value;
  });
  let dataBase64: string | undefined;
  const body = init.body;
  if (typeof body === 'string') {
    dataBase64 = bytesToB64(new TextEncoder().encode(body));
  } else if (body instanceof Blob) {
    dataBase64 = bytesToB64(new Uint8Array(await body.arrayBuffer()));
  } else if (body instanceof ArrayBuffer) {
    dataBase64 = bytesToB64(new Uint8Array(body));
  } else if (body instanceof Uint8Array) {
    dataBase64 = bytesToB64(body);
  }
  const res = await PinnedHttps.fetch({
    url,
    method: (init.method || 'GET').toUpperCase(),
    headers,
    dataBase64,
    timeout: 25000,
  });
  const payload = res.bodyBase64 ? b64ToBytes(res.bodyBase64) : null;
  const status = res.status;
  // 204/304 不允许带 body,构造 Response 时必须传 null
  const nullBody = status === 204 || status === 304;
  const bodyInit: BodyInit | null = nullBody || !payload
    ? null
    : (payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
  return new Response(bodyInit, {
    status,
    statusText: '',
    headers: res.headers || {},
  });
}

/** 是否该走固定通道:只有 https 且原生插件可用时才走。 */
export function shouldPin(url: string): boolean {
  return /^https:/i.test(url) && pinnedAvailable();
}
