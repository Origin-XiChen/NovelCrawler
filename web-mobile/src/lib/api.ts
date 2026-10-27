import { getActiveServer } from './connection';
import type { PairResult, PingResult, ServerEntry } from './types';
import { b64ToBlob, wrtcAlive, wrtcRequest } from './wrtc';

type Query = Record<string, string | number | boolean | undefined | null>;

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
  let res: Response;
  try {
    res = await fetch(resolveUrl(path + buildQuery(options.query), server), {
      method: options.method || 'GET',
      headers: requestHeaders(server, auth, options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new ApiError(OFFLINE_MESSAGE, 0, 'network');
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
  let res: Response;
  try {
    res = await fetch(resolveUrl(path + buildQuery(query), server), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        ...(server?.token ? { Authorization: `Bearer ${server.token}` } : {}),
      },
      body: blob,
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new ApiError('上传中断了，确认电脑还在线再试一次', 0, 'network');
  }
  return parseResponse<T>(res);
}

export async function pingServer(baseUrl: string): Promise<PingResult> {
  const base = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/api/mobile/ping`, { headers: { Accept: 'application/json' } });
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
  const res = await fetch(`${base}/api/mobile/pair/confirm`, {
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
    const res = await fetch(resolveUrl('/api/files', server), {
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
    res = await fetch(resolveUrl(path + buildQuery(query), server), {
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
