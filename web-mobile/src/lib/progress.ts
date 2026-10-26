export interface ReadingProgress {
  chapter: number;
  total?: number;
  bookTitle?: string;
  chapterTitle?: string;
  scroll: number;
  updated: number;
}

const PROGRESS_KEY = 'nc_mobile_progress_v1';
const PREFS_KEY = 'nc_mobile_reader_prefs_v1';

type ProgressMap = Record<string, ReadingProgress>;

function readProgress(): ProgressMap {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const data = raw ? (JSON.parse(raw) as ProgressMap) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeProgress(data: ProgressMap): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function key(serverId: string, file: string): string {
  return `${serverId}::${file}`;
}

export function loadProgress(serverId: string, file: string): ReadingProgress | null {
  return readProgress()[key(serverId, file)] || null;
}

export function saveProgress(serverId: string, file: string, progress: ReadingProgress): void {
  const data = readProgress();
  data[key(serverId, file)] = progress;
  writeProgress(data);
}

export function loadAllProgress(serverId: string): Record<string, ReadingProgress> {
  const prefix = `${serverId}::`;
  const result: Record<string, ReadingProgress> = {};
  for (const [entryKey, progress] of Object.entries(readProgress())) {
    if (entryKey.startsWith(prefix)) result[entryKey.slice(prefix.length)] = progress;
  }
  return result;
}

export function latestProgress(serverId: string): { file: string; progress: ReadingProgress } | null {
  const prefix = `${serverId}::`;
  let best: { file: string; progress: ReadingProgress } | null = null;
  for (const [entryKey, progress] of Object.entries(readProgress())) {
    if (!entryKey.startsWith(prefix)) continue;
    if (!best || (progress.updated || 0) > (best.progress.updated || 0)) {
      best = { file: entryKey.slice(prefix.length), progress };
    }
  }
  return best;
}

export function clearProgress(serverId?: string): void {
  if (!serverId) {
    writeProgress({});
    return;
  }
  const prefix = `${serverId}::`;
  const data = readProgress();
  for (const entryKey of Object.keys(data)) {
    if (entryKey.startsWith(prefix)) delete data[entryKey];
  }
  writeProgress(data);
}

export type ReaderTheme = 'paper' | 'eye' | 'sepia' | 'night';

export interface ReaderPrefs {
  fontSize: number;
  lineHeight: number;
  theme: ReaderTheme;
  family: 'serif' | 'sans';
}

const DEFAULT_PREFS: ReaderPrefs = {
  fontSize: 18,
  lineHeight: 1.8,
  theme: 'paper',
  family: 'serif',
};

export function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const data = raw ? (JSON.parse(raw) as Partial<ReaderPrefs>) : {};
    return {
      fontSize: Math.min(28, Math.max(14, Number(data.fontSize) || DEFAULT_PREFS.fontSize)),
      lineHeight: Math.min(2.4, Math.max(1.4, Number(data.lineHeight) || DEFAULT_PREFS.lineHeight)),
      theme: (['paper', 'eye', 'sepia', 'night'] as ReaderTheme[]).includes(data.theme as ReaderTheme)
        ? (data.theme as ReaderTheme)
        : DEFAULT_PREFS.theme,
      family: data.family === 'sans' ? 'sans' : 'serif',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
