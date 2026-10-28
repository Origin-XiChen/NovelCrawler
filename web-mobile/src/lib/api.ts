import { getActiveServer, getCandidates, updateServerBase } from './connection';
import { pinnedFetch, shouldPin } from './pinned';
import { parseSshParam, sshConnect, sshStatus } from './ssh';
import type { PairResult, PingResult, ServerEntry } from './types';
import { b64ToBlob, wrtcAlive, wrtcRequest } from './wrtc';

type Query = Record<
  string,
  string | number | boolean | undefined | null | Array<string | number>
>;

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function buildQuery(params?: Query): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === '') continue;
        qs.append(key, String(entry));
      }
      continue;
    }
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export function resolveUrl(path: string, server: ServerEntry | null = getActiveServer()): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = server?.baseUrl?.replace(/\/+$/, '') || '';
  return base + path;
}

export function mediaUrl(path: string): string {
  const server = getActiveServer();
  if (server?.transport === 'wrtc') return '';
  const url = resolveUrl(path, server);
  if (!server?.token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(server.token)}`;
}

function requestHeaders(server: ServerEntry | null, auth: boolean, json = false): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  if (auth && server?.token) headers.Authorization = `Bearer ${server.token}`;
  return headers;
}

async function parseResponse<T>(res: Response): Promise<T> {
  const type = res.headers.get('content-type') || '';
  let data: unknown = null;
  if (type.includes('application/json')) {
    data = await res.json();
  }
  if (!res.ok) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const message = String(body.error || `请求失败 (${res.status})`);
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('nc-unauthorized'));
    }
    throw new ApiError(message, res.status, code);
  }
  if (!data) {
    throw new ApiError(`接口返回了非 JSON 内容 (${res.status})`, res.status);
  }
  if (typeof data === 'object' && data && 'error' in data && (data as Record<string, unknown>).error) {
    throw new ApiError(String((data as Record<string, unknown>).error), res.status);
  }
  return data as T;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  server?: ServerEntry | null;
  auth?: boolean;
}

/** fetch 抛 TypeError 时浏览器只给 "Failed to fetch",这里换成能行动的提示。 */
export const OFFLINE_MESSAGE = '连不上电脑，确认电脑端 Novelist 已打开、且和手机在同一网络';

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

// ---------------- 多地址自动选路 / 故障转移 ----------------
// 同一台电脑可能有多个可达地址(无线、热点、ZeroTier/Radmin 虚拟组网)。
// 校园网 AP 隔离常挡掉其中一个,所以请求失败时自动探测其余地址并切换。

const PROBE_TIMEOUT = 2200;

async function probeBase(base: string, timeoutMs = PROBE_TIMEOUT): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await netFetch(`${base.replace(/\/+$/, '')}/api/mobile/ping`, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 并发探测候选地址,按传入顺序返回第一个可用的(空串表示全都不通)。 */
export async function pickReachable(list: string[], timeoutMs = PROBE_TIMEOUT): Promise<string> {
  const unique: string[] = [];
  for (const raw of list) {
    const url = String(raw || '').trim().replace(/\/+$/, '');
    if (url && !unique.includes(url)) unique.push(url);
  }
  if (unique.length === 0) return '';
  if (unique.length === 1) return (await probeBase(unique[0], timeoutMs)) ? unique[0] : '';
  const results = await Promise.all(
    unique.map(async (url) => ({ url, ok: await probeBase(url, timeoutMs) })),
  );
  return results.find((item) => item.ok)?.url || '';
}

let swapPromise: Promise<ServerEntry | null> | null = null;

/** 当前地址连不上时,探测其余候选并切换到可用的那个。并发请求共用同一次探测。 */
async function swapToReachable(server: ServerEntry | null): Promise<ServerEntry | null> {
  if (!server || server.transport === 'wrtc') return null;
  const current = String(server.baseUrl || '').replace(/\/+$/, '');
  const others = getCandidates(server).filter((url) => url !== current);
  if (others.length === 0) return null;
  if (swapPromise) return swapPromise;
  swapPromise = (async () => {
    // ① 先看 SSH 隧道:它断了的话 127.0.0.1:<port> 一定连不上,
    //    但隧道本身可以重建 —— 不重建就永远回不去,只能让用户重新扫码。
    const tunnel = server.sshTunnel;
    if (tunnel && server.sshPassword) {
      const st = await sshStatus();
      if (!st.connected) {
        try {
          const target = parseSshParam(server.ssh || '');
          if (target) {
            await sshConnect(target, server.sshPassword, Number(tunnel.localPort) || 0,
                             Number(tunnel.localPort) || 0);
          }
        } catch {
          // 重建失败就继续走普通候选
        }
      }
    }
    // ② 依次探测候选;失败退避后最多再探两轮(切网瞬间前一两秒常打不通)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hit = await pickReachable(others);
      if (hit) {
        updateServerBase(server.id, hit);
        return getActiveServer();
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    return null;
  })();
  try {
    return await swapPromise;
  } finally {
    swapPromise = null;
  }
}

/**
 * 统一出口:https 且原生固定通道可用时走 PinnedHttps,其余照旧用 fetch。
 * 只有电脑那张 CA 能通过校验,系统里其他根证书签的假证书一律握手失败。
 */
async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (shouldPin(url)) return pinnedFetch(url, init);
  return fetch(url, init);
}

async function wrtcJson<T>(
  server: ServerEntry,
  method: string,
  path: string,
  query?: Query,
  body?: unknown,
): Promise<T> {
  if (!wrtcAlive()) throw new ApiError('直连已断开，请重新扫描电脑连接码', 0, 'wrtc');
  let res;
  try {
    res = await wrtcRequest({
      method,
      path,
      query: buildQuery(query).replace(/^\?/, ''),
      body,
      token: server.token,
    });
  } catch (cause) {
    throw new ApiError(cause instanceof Error ? cause.message : '直连中断了', 0, 'network');
  }
  if (res.status === 401) window.dispatchEvent(new CustomEvent('nc-unauthorized'));
  if (res.status >= 400) throw new ApiError(res.error || `请求失败 (${res.status})`, res.status);
  if (res.type !== 'json') throw new ApiError('直连接口返回了非 JSON 内容', res.status);
  const data = res.body;
  if (typeof data === 'object' && data && 'error' in data && (data as Record<string, unknown>).error) {
    throw new ApiError(String((data as Record<string, unknown>).error), res.status);
  }
  return data as T;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const server = options.server === undefined ? getActiveServer() : options.server;
  const auth = options.auth !== false;
  if (server?.transport === 'wrtc') {
    return wrtcJson<T>(server, options.method || 'GET', path, options.query, options.body);
  }
  const target = path + buildQuery(options.query);
  const send = (srv: ServerEntry | null) =>
    netFetch(resolveUrl(target, srv), {
      method: options.method || 'GET',
      headers: requestHeaders(srv, auth, options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  let res: Response;
  try {
    res = await send(server);
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    // 换个候选地址再试一次:校园网下主地址常被 AP 隔离挡住
    const swapped = await swapToReachable(server);
    if (!swapped || swapped.baseUrl === server?.baseUrl) {
      throw new ApiError(OFFLINE_MESSAGE, 0, 'network');
    }
    try {
      res = await send(swapped);
    } catch (cause2) {
      if (isAbort(cause2)) throw cause2;
      throw new ApiError(OFFLINE_MESSAGE, 0, 'network');
    }
  }
  return parseResponse<T>(res);
}

export function apiGet<T>(path: string, query?: Query): Promise<T> {
  return request<T>(path, { query });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body ?? {} });
}

export function apiDelete<T>(path: string, query?: Query): Promise<T> {
  return request<T>(path, { method: 'DELETE', query });
}

/** 原始字节上传(手机本地书回传电脑),不走 JSON 包装 */
export async function apiUpload<T>(path: string, blob: Blob, query?: Query): Promise<T> {
  const server = getActiveServer();
  if (server?.transport === 'wrtc') {
    throw new ApiError('直连模式暂不支持回传大文件，请改用局域网或热点连接后再同步', 0, 'wrtc');
  }
  const target = path + buildQuery(query);
  const send = (srv: ServerEntry | null) =>
    netFetch(resolveUrl(target, srv), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        ...(srv?.token ? { Authorization: `Bearer ${srv.token}` } : {}),
      },
      body: blob,
    });
  let res: Response;
  try {
    res = await send(server);
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    const swapped = await swapToReachable(server);
    if (!swapped || swapped.baseUrl === server?.baseUrl) {
      throw new ApiError('上传中断了，确认电脑还在线再试一次', 0, 'network');
    }
    try {
      res = await send(swapped);
    } catch (cause2) {
      if (isAbort(cause2)) throw cause2;
      throw new ApiError('上传中断了，确认电脑还在线再试一次', 0, 'network');
    }
  }
  return parseResponse<T>(res);
}

export async function pingServer(baseUrl: string): Promise<PingResult> {
  const base = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await netFetch(`${base}/api/mobile/ping`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('这个地址没有响应', 0, 'network');
  }
  if (!res.ok) throw new ApiError(`电脑无响应 (${res.status})`, res.status);
  return (await res.json()) as PingResult;
}

export async function pairServer(
  baseUrl: string,
  code: string,
  deviceId: string,
  deviceName: string,
): Promise<PairResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await netFetch(`${base}/api/mobile/pair/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, device_id: deviceId, device_name: deviceName }),
  });
  const data = (await res.json()) as PairResult;
  if (!res.ok || !data.ok) {
    throw new ApiError(data.error || `配对失败 (${res.status})`, res.status, data.code);
  }
  return data;
}

export async function checkServer(server: ServerEntry): Promise<boolean> {
  if (server.transport === 'wrtc') return wrtcAlive();
  try {
    const res = await netFetch(resolveUrl('/api/files', server), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${server.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 取一个二进制附件(整本离线包),按已收字节回报进度。
 * 电脑打包时先用小 body 回 JSON 错误,所以这里要按 content-type 分流。
 */
export async function apiDownload(
  path: string,
  query?: Query,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const server = getActiveServer();
  if (server?.transport === 'wrtc') {
    if (!wrtcAlive()) throw new ApiError('直连已断开，请重新扫描电脑连接码', 0, 'wrtc');
    const res = await wrtcRequest({
      path,
      query: buildQuery(query).replace(/^\?/, ''),
      token: server.token,
      timeoutMs: 180000,
    });
    if (res.status === 401) window.dispatchEvent(new CustomEvent('nc-unauthorized'));
    if (res.status >= 400) throw new ApiError(res.error || `下载失败 (${res.status})`, res.status);
    if (res.type !== 'b64' || !res.body_b64) throw new ApiError('电脑返回的下载内容异常', res.status);
    const blob = b64ToBlob(res.body_b64, res.content_type || 'application/octet-stream');
    onProgress?.(blob.size, blob.size);
    return blob;
  }
  let res: Response;
  try {
    res = await netFetch(resolveUrl(path + buildQuery(query), server), {
      headers: server?.token ? { Authorization: `Bearer ${server.token}` } : {},
      signal,
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new ApiError('下载中断了，确认电脑还在线再试一次', 0, 'network');
  }
  if (!res.ok) {
    let message = `下载失败 (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      message = String(body.error || message);
      code = typeof body.code === 'string' ? body.code : undefined;
    } catch {
      // 非 JSON 错误体,保留默认提示
    }
    if (res.status === 401) window.dispatchEvent(new CustomEvent('nc-unauthorized'));
    throw new ApiError(message, res.status, code);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') || '';
  if (!res.body || type.includes('application/json')) {
    // 没有流(旧 WebView)或电脑误回 JSON:整块读完
    const blob = await res.blob();
    onProgress?.(blob.size, blob.size || total);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as unknown as BlobPart);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  return new Blob(chunks, { type: 'application/zip' });
}
