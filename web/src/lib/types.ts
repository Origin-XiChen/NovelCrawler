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
}

export interface ReaderMeta {
  title: string;
  total: number;
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
