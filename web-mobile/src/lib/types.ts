export interface ServerEntry {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  api: number;
  version: string;
  lastUsed: number;
  /** http=局域网/热点/隧道直连;wrtc=WebRTC 数据通道(仅当前页面有效) */
  transport?: 'http' | 'wrtc';
}

export interface PingResult {
  ok: boolean;
  name?: string;
  version?: string;
  api?: number;
  auth?: string;
  capabilities?: string[];
  mobile_build?: string;
}

export interface MobileDevice {
  id: string;
  name: string;
  created: number;
  last_seen: number;
  last_ip: string;
  online: boolean;
}

export interface ServerSummary {
  name: string;
  version: string;
  api: number;
  capabilities?: string[];
}

export interface PairResult {
  ok: boolean;
  token?: string;
  device?: MobileDevice;
  server?: ServerSummary;
  error?: string;
  code?: string;
}

export interface FileEntry {
  name: string;
  size: number;
}

export interface ComicFileGroup {
  title: string;
  dir: string;
  files: number;
  size: number;
  pdfs: string[];
  cover_url?: string;
  meta?: Record<string, unknown> | null;
}

export interface ChapterRef {
  idx: number;
  title: string;
  volume?: string;
  path?: string;
}

export interface NovelMeta {
  title?: string;
  total?: number;
  chapters: ChapterRef[];
}

export interface NovelChapter {
  title?: string;
  text?: string;
  html?: string;
}

export interface ComicPdfMeta {
  ok: boolean;
  meta?: Record<string, unknown> | null;
  pdfs: string[];
  current?: Record<string, unknown>;
}

export interface ComicPageMeta {
  ok: boolean;
  num_pages: number;
}

export interface DeviceList {
  ok: boolean;
  devices: MobileDevice[];
}

export interface PairPayload {
  baseUrl: string;
  code: string;
  name?: string;
}
