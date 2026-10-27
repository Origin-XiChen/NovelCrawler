import type { PairPayload, ServerEntry } from './types';

const SERVERS_KEY = 'nc_mobile_servers_v1';
const ACTIVE_KEY = 'nc_mobile_active_v1';
const DEVICE_KEY = 'nc_mobile_device_id_v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式/存储已满时保持内存态可用
  }
}

function validServer(value: unknown): value is ServerEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as ServerEntry;
  return Boolean(item.id && item.baseUrl && item.token);
}

export function getServers(): ServerEntry[] {
  const list = readJson<unknown>(SERVERS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter(validServer).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

export function getActiveServer(): ServerEntry | null {
  const id = (() => {
    try {
      return localStorage.getItem(ACTIVE_KEY) || '';
    } catch {
      return '';
    }
  })();
  const servers = getServers();
  if (!id) return servers[0] || null;
  return servers.find((item) => item.id === id) || servers[0] || null;
}

export function saveServer(server: ServerEntry): void {
  const list = getServers().filter((item) => item.id !== server.id);
  list.unshift(server);
  writeJson(SERVERS_KEY, list);
  try {
    localStorage.setItem(ACTIVE_KEY, server.id);
  } catch {
    // ignore
  }
}

export function setActiveServer(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore
  }
}

export function touchServer(id: string): void {
  const list = getServers();
  const item = list.find((entry) => entry.id === id);
  if (!item) return;
  item.lastUsed = Date.now();
  writeJson(SERVERS_KEY, list);
}

export function removeServer(id: string): void {
  const list = getServers().filter((item) => item.id !== id);
  writeJson(SERVERS_KEY, list);
  try {
    const active = localStorage.getItem(ACTIVE_KEY);
    if (active === id) {
      if (list[0]) localStorage.setItem(ACTIVE_KEY, list[0].id);
      else localStorage.removeItem(ACTIVE_KEY);
    }
  } catch {
    // ignore
  }
}

/** 去掉尾部斜杠;只保留 http/https 基址。 */
export function trimBase(value: unknown): string {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(url) ? url : '';
}

/** 同一台电脑的全部候选地址:当前基址在最前,其余按记录顺序去重。 */
export function getCandidates(server: ServerEntry | null | undefined): string[] {
  if (!server) return [];
  const list: string[] = [];
  for (const raw of [server.baseUrl, ...(server.candidates || [])]) {
    const url = trimBase(raw);
    if (url && !list.includes(url)) list.push(url);
  }
  return list;
}

/** 切换当前使用的基址(自动选路/故障转移后调用)。 */
export function updateServerBase(id: string, baseUrl: string): void {
  const base = trimBase(baseUrl);
  if (!id || !base) return;
  const list = getServers();
  const item = list.find((entry) => entry.id === id);
  if (!item || item.baseUrl === base) return;
  item.baseUrl = base;
  item.lastUsed = Date.now();
  writeJson(SERVERS_KEY, list);
}

/** 把新发现的候选地址合并进记录(去重保序)。 */
export function mergeCandidates(id: string, extra: string[]): string[] {
  const list = getServers();
  const item = list.find((entry) => entry.id === id);
  if (!item) return [];
  const merged = getCandidates({ ...item, candidates: [...(item.candidates || []), ...extra] });
  if (merged.length !== (item.candidates || []).length) {
    item.candidates = merged;
    writeJson(SERVERS_KEY, list);
  }
  return merged;
}

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY) || '';
    if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch {
    // ignore
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const id = 'dev-' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

export function detectDeviceName(): string {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android 手机';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Windows/i.test(ua)) return 'Windows 浏览器';
  if (/Macintosh/i.test(ua)) return 'Mac 浏览器';
  return '手机浏览器';
}

export function normalizeBaseUrl(input: string): string {
  let text = String(input || '').trim();
  if (!text) throw new Error('请输入电脑地址');
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 地址');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('/mobile')) path = path.slice(0, -7);
  if (path.toLowerCase().endsWith('/m')) path = path.slice(0, -2);
  if (path === '/') path = '';
  return `${url.protocol}//${url.host}${path}`;
}

/** 二维码 alt 参数是逗号分隔的 host:port 列表,补上协议转成候选基址。 */
function altCandidates(protocol: string, alt: string | null, primary: string): string[] {
  const out: string[] = [];
  for (const raw of String(alt || '').split(',')) {
    const host = raw.trim();
    if (!host || !/^[A-Za-z0-9.:\-[\]]+$/.test(host)) continue;
    const url = `${protocol}//${host}`.replace(/\/+$/, '');
    if (url !== primary && !out.includes(url)) out.push(url);
  }
  return out;
}

export function parsePairPayload(raw: string): PairPayload | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const code = url.searchParams.get('pair') || url.searchParams.get('code') || '';
    if (!/^\d{6}$/.test(code)) return null;
    const name = url.searchParams.get('name') || undefined;
    if (url.protocol === 'novelcrawler:' || url.protocol === 'novelist:') {
      const host = url.searchParams.get('host') || '';
      const port = url.searchParams.get('port') || '';
      if (!host) return null;
      const scheme = url.searchParams.get('scheme') || 'http';
      return {
        baseUrl: `${scheme}://${host}${port ? ':' + port : ''}`,
        code,
        name,
        pin: url.searchParams.get('pin') || undefined,
      };
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      let path = url.pathname.replace(/\/+$/, '');
      if (path.toLowerCase().endsWith('/mobile')) path = path.slice(0, -7);
      if (path.toLowerCase().endsWith('/m')) path = path.slice(0, -2);
      if (path === '/') path = '';
      const baseUrl = `${url.protocol}//${url.host}${path}`;
      return {
        baseUrl,
        code,
        name,
        candidates: altCandidates(url.protocol, url.searchParams.get('alt'), baseUrl),
        pin: url.searchParams.get('pin') || undefined,
        ssh: url.searchParams.get('ssh') || undefined,
        sshPassword: url.searchParams.get('sshp') || undefined,
      };
    }
  } catch {
    // 不是 URL
  }
  return null;
}

/** 把 CA 短指纹写进服务器条目,后续换址/重启仍能校验同一张证书。 */
export function setServerPin(id: string, pin: string): void {
  const list = getServers();
  const item = list.find((entry) => entry.id === id);
  if (!item || !pin) return;
  item.pin = pin;
  writeJson(SERVERS_KEY, list);
}
