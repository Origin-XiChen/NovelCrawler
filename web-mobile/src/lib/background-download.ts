/**
 * 手机端离线包的后台下载通道。
 * 真正的下载在 Android 前台服务里跑,WebView 被冻结/锁屏也不影响;
 * JS 只轮询状态,回前台后再把落盘的文件读进来导入书库。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface BackgroundDownloadState {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled' | string;
  path: string;
  fileName: string;
  title: string;
  received: number;
  total: number;
  error: string;
  updated: number;
}

interface NativeBackgroundDownload {
  download(options: {
    url: string;
    fileName: string;
    title?: string;
    headers?: Record<string, string>;
    pinned?: boolean;
  }): Promise<{ id: string; path: string; fileName: string }>;
  status(options: { id: string }): Promise<BackgroundDownloadState>;
  list(): Promise<{ items: BackgroundDownloadState[] }>;
  cancel(options: { id: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
}

const Native = registerPlugin<NativeBackgroundDownload>('BackgroundDownload');

export const BACKGROUND_DOWNLOAD_AVAILABLE = (() => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BackgroundDownload');
  } catch {
    return false;
  }
})();

let queue: Promise<unknown> = Promise.resolve();
let active = 0;

/** 当前页面自己发起的下载还在处理中（含导入），恢复逻辑要避让 */
export function hasActiveBackgroundDownload(): boolean {
  return active > 0;
}

/** 原生服务同一时刻只跑一个任务,这里也串行化,避免"全部更新"互相抢 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readFileBlob(path: string): Promise<Blob> {
  return fetch(Capacitor.convertFileSrc(path)).then((res) => {
    if (!res.ok) throw new Error(`读取下载文件失败 (${res.status})`);
    return res.blob();
  });
}

export interface BackgroundDownloadProgress {
  received: number;
  total: number;
  state: string;
}

export interface BackgroundDownloadResult {
  blob: Blob;
  path: string;
  id: string;
}

export function downloadInBackground(
  options: {
    url: string;
    fileName: string;
    title: string;
    headers?: Record<string, string>;
    pinned?: boolean;
  },
  onProgress?: (progress: BackgroundDownloadProgress) => void,
): Promise<BackgroundDownloadResult> {
  return enqueue(async () => {
    active += 1;
    try {
      const ticket = await Native.download(options);
      for (;;) {
        let state: BackgroundDownloadState;
        try {
          state = await Native.status({ id: ticket.id });
        } catch (cause) {
          await Native.remove({ id: ticket.id }).catch(() => undefined);
          throw new Error(cause instanceof Error ? cause.message : '后台下载状态丢失');
        }
        onProgress?.({
          received: Number(state.received) || 0,
          total: Number(state.total) || 0,
          state: state.state,
        });
        if (state.state === 'done') {
          if (!state.path) {
            await Native.remove({ id: ticket.id }).catch(() => undefined);
            throw new Error('下载完成但文件路径为空');
          }
          try {
            const blob = await readFileBlob(state.path);
            await Native.remove({ id: ticket.id }).catch(() => undefined);
            return { blob, path: state.path, id: ticket.id };
          } catch (cause) {
            await Native.remove({ id: ticket.id }).catch(() => undefined);
            throw cause;
          }
        }
        if (state.state === 'error' || state.state === 'cancelled') {
          await Native.remove({ id: ticket.id }).catch(() => undefined);
          throw new Error(
            state.error || (state.state === 'cancelled' ? '下载已取消' : '下载失败'),
          );
        }
        // 定时器在后台会被节流,但这不影响原生下载;回前台后下一轮立刻读到结果
        await sleep(1000);
      }
    } finally {
      active = Math.max(0, active - 1);
    }
  });
}

export async function listBackgroundDownloads(): Promise<BackgroundDownloadState[]> {
  if (!BACKGROUND_DOWNLOAD_AVAILABLE) return [];
  try {
    const { items } = await Native.list();
    return items;
  } catch {
    return [];
  }
}

export function readBackgroundDownload(path: string): Promise<Blob> {
  return readFileBlob(path);
}

export async function removeBackgroundDownload(id: string): Promise<void> {
  if (!BACKGROUND_DOWNLOAD_AVAILABLE) return;
  try {
    await Native.remove({ id });
  } catch {
    // 文件可能已经被系统清理,忽略
  }
}

export async function cancelBackgroundDownload(id: string): Promise<void> {
  if (!BACKGROUND_DOWNLOAD_AVAILABLE) return;
  try {
    await Native.cancel({ id });
  } catch {
    // ignore
  }
}
