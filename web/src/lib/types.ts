export interface ShelfEntry {
  title: string;
  author?: string;
  url: string;
  source?: string;
  cover?: string;
  tags?: string[];
  category?: string;
  rating?: number;
  added?: number;
  checked_chapters?: number;
  have?: number;
  local_chapters?: number;
  local_file?: string;
  local_epub?: boolean;
  last_check?: number;
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  state: string;
  done?: number;
  total?: number;
  current?: string;
  added?: number;
  started?: number;
  error?: string;
  logs?: string[];
  out_path?: string;
  book?: string;
  mode?: string;
}

export interface TaskHistoryEntry {
  ts?: number;
  kind?: string;
  title?: string;
  state?: string;
  detail?: string;
  file?: string;
  size?: number;
  source?: string;
  time?: number;
  added?: number;
  done?: number;
  total?: number;
  out_path?: string;
  error?: string;
}

export interface FileEntry {
  name: string;
  size: number;
}

export interface ComicShelfEntry {
  title: string;
  source: string;
  comic_id: string;
  cover?: string;
  added?: number;
  checked_chapters?: number;
  have?: number;
}

export interface ComicSource {
  key: string;
  name: string;
  enabled: boolean;
  needs_proxy?: boolean;
  note?: string;
  custom?: boolean;
}

export interface ComicSearchItem {
  id: string;
  title: string;
  cover?: string;
  lang?: string;
  desc?: string;
  source_key?: string;
}

export interface ComicChapter {
  id: string;
  volume?: string | number;
  chapter?: string | number;
  title?: string;
  lang?: string;
}

export interface ComicSearchProgress {
  state: 'running' | 'done' | 'error';
  done: number;
  total: number;
  sources: { name: string; status: string }[];
  errors: string[];
  batches: { source_key: string; items: ComicSearchItem[] }[];
}

export interface ComicFileGroup {
  title: string;
  dir: string;
  files: number;
  size: number;
  pdfs: string[];
  cover_url: string;
  meta?: { mode?: string; volumes?: unknown[] } | null;
}

export interface ReaderChapterMeta {
  idx: number;
  title: string;
  volume?: string;
  path?: string;
}

export interface ReaderMeta {
  title: string;
  total?: number;
  chapters: ReaderChapterMeta[];
}

export interface ReaderChapter {
  idx?: number;
  title: string;
  text: string;
  html?: string;
}

export interface Source {
  name: string;
  base?: string;
  enabled?: boolean;
}

export interface SourceItem extends Source {
  custom?: boolean;
  search_ok?: boolean;
  render?: boolean;
  charset?: string;
  search?: Record<string, unknown> | null;
  api_rules?: Record<string, unknown> | null;
  verify_ssl?: boolean;
  [key: string]: unknown;
}

export interface SourceCandidate {
  name: string;
  base: string;
  status: string;
  charset?: string;
  verify_ssl?: boolean;
  [key: string]: unknown;
}

export interface SourceSyncStatus {
  running?: boolean;
  stage?: string;
  processed?: number;
  total?: number;
  ok?: number;
  candidates?: number;
  error?: string;
  message?: string;
  sub_name?: string;
}

export interface SourceHealthStatus {
  running?: boolean;
  total?: number;
  dead?: string[];
  error?: string;
}

export interface VerifiedSite {
  host: string;
  name?: string;
  url?: string;
  ts?: number;
  last_ok?: number;
  expired?: boolean;
}

export interface PendingVerify {
  host: string;
  url?: string;
  name?: string;
}

export interface VerifyCapability {
  playwright?: boolean;
  error?: string;
  channels?: string[];
  driver?: boolean;
  driver_src?: string;
}

export interface OpdsItem {
  title: string;
  href: string;
  epub: string;
  cover?: string;
  desc?: string;
  is_nav: boolean;
}

export interface ComicBaseMatch {
  key: string;
  name: string;
  base: string;
  old_base: string;
  applied?: boolean;
}

export interface Subscription {
  name: string;
  url: string;
  file?: string;
  remark?: string;
  resolved?: string;
  added?: number;
  last_sync?: number | null;
  status?: string;
  count?: number;
  unmatched?: number;
  pending?: { ts?: number; matches?: ComicBaseMatch[] } | null;
}

export interface SearchBook {
  title: string;
  author?: string;
  url: string;
  source: string;
  cover?: string;
  desc?: string;
  raw_title?: string;
}

export interface SearchProgress {
  state: 'running' | 'done' | 'error' | 'paused' | 'cancelled';
  done: number;
  total: number;
  sources: { name: string; status: string }[];
  error?: string;
  paused?: boolean;
  books: SearchBook[];
  skipped?: number;
  searchable?: number;
  enabled?: number;
  timed_out?: boolean;
}
