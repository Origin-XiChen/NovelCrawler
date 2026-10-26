import { getActiveServer } from './connection';
import type { PairResult, PingResult, ServerEntry } from './types';

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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const server = options.server === undefined ? getActiveServer() : options.server;
  const auth = options.auth !== false;
  const res = await fetch(resolveUrl(path + buildQuery(options.query), server), {
    method: options.method || 'GET',
    headers: requestHeaders(server, auth, options.body !== undefined),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
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

export async function pingServer(baseUrl: string): Promise<PingResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/mobile/ping`, { headers: { Accept: 'application/json' } });
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
  try {
    const res = await fetch(resolveUrl('/api/files', server), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${server.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
