import { useEffect, useState } from 'react';
import { checkServer } from './api';
import { getActiveServer } from './connection';

/**
 * 电脑在线状态(全局单例轮询)。
 *
 * 手机上"电脑在不在线"是几乎所有操作的共同前提:书架要显示离线标记、书库要禁下载、
 * 同步要说明为什么推不上去。以前各页面各自 try/catch 判断,结果互不一致。
 * 这里统一成一个 15 秒心跳 + 可见性变化立即探测,页面只订阅结果。
 */
export type ServerStatus = 'unknown' | 'checking' | 'online' | 'offline';

const INTERVAL = 15_000;
const RETRY_DELAY = 2_000;
const RETRY_TIMES = 2;

let status: ServerStatus = 'unknown';
let timer: number | null = null;
let inflight: Promise<ServerStatus> | null = null;
const listeners = new Set<(value: ServerStatus) => void>();

function publish(next: ServerStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((fn) => fn(next));
}

/** 立刻探测一次(并发请求共用同一次)',返回最新状态 */
export function refreshServerStatus(): Promise<ServerStatus> {
  const server = getActiveServer();
  if (!server) {
    publish('offline');
    return Promise.resolve('offline');
  }
  if (inflight) return inflight;
  publish(status === 'unknown' ? 'checking' : status);
  inflight = (async () => {
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt += 1) {
      if (await checkServer(server)) {
        publish('online');
        inflight = null;
        return 'online';
      }
      if (attempt < RETRY_TIMES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
    publish('offline');
    inflight = null;
    return 'offline';
  })();
  return inflight;
}

function startLoop() {
  if (timer !== null) return;
  timer = window.setInterval(() => void refreshServerStatus(), INTERVAL);
}

function stopLoop() {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/** 页面级订阅:挂载时启动心跳,卸载时按引用计数停掉 */
export function useServerStatus(): ServerStatus {
  const [value, setValue] = useState<ServerStatus>(status);
  useEffect(() => {
    listeners.add(setValue);
    startLoop();
    void refreshServerStatus();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshServerStatus();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      listeners.delete(setValue);
      document.removeEventListener('visibilitychange', onVisible);
      if (listeners.size === 0) stopLoop();
    };
  }, []);
  return value;
}
