export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

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

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new ApiError(`接口返回了非 JSON 内容 (${res.status})`, res.status);
  }
  return res.json();
}

async function parseResponse<T>(res: Response): Promise<T> {
  const data = await readJson(res);
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败 (${res.status})`;
    throw new ApiError(message, res.status);
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error: unknown }).error) {
    throw new ApiError(String((data as { error: unknown }).error), res.status);
  }
  return data as T;
}

export async function apiGet<T>(path: string, params?: Query): Promise<T> {
  const res = await fetch(path + buildQuery(params), {
    headers: { Accept: 'application/json' },
  });
  return parseResponse<T>(res);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse<T>(res);
}

export async function apiDelete<T>(path: string, params?: Query): Promise<T> {
  const res = await fetch(path + buildQuery(params), {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  return parseResponse<T>(res);
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(path, { method: 'POST', body });
  return parseResponse<T>(res);
}

export function coverSrc(cover?: string): string {
  if (!cover) return '';
  if (cover.startsWith('http://') || cover.startsWith('https://')) {
    return `/api/cover?url=${encodeURIComponent(cover)}`;
  }
  return cover;
}
