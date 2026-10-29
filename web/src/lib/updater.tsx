import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UpdaterStatus } from '../types/desktop';

export type UpdatePhase =
  | 'idle'
  | 'dev'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  /** 下载进度 0-100（保留一位小数，界面再取整） */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** 安装包体积（check 阶段就有，用于"212 MB"这类提示） */
  size?: number;
  message?: string;
}

interface UpdateContextValue {
  state: UpdateState;
  appVersion: string;
  bridgeAvailable: boolean;
  check: () => void;
  /** 应用内下载安装包（自建下载器，支持续传，进度只增不减） */
  download: () => void;
  /** 调系统安装器：会退出应用再启动 NSIS 向导 */
  install: () => void;
  /** 兜底：直接在浏览器里打开发布页 */
  openDownloadPage: () => void;
}

/** 发布页地址:手动下载安装包 */
export const RELEASES_URL = 'https://github.com/Origin-XiChen/NovelCrawler/releases';

const UpdateContext = createContext<UpdateContextValue | null>(null);

function reduce(current: UpdateState, event: UpdaterStatus): UpdateState {
  switch (event.type) {
    case 'checking':
      return { ...current, phase: 'checking', message: undefined };
    case 'available':
      return {
        phase: 'available',
        version: event.version,
        message: event.releaseName,
        size: event.size,
      };
    case 'not-available':
      return { phase: 'not-available', version: event.version };
    case 'progress':
      return {
        ...current,
        phase: 'downloading',
        percent: event.percent,
        transferred: event.transferred,
        total: event.total || current.size,
        bytesPerSecond: event.bytesPerSecond,
      };
    case 'downloaded':
      return { ...current, phase: 'downloaded', version: event.version, percent: 100 };
    case 'error':
      return { ...current, phase: 'error', message: event.message };
    case 'dev':
      return { phase: 'dev' };
    default:
      return current;
  }
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const bridge = window.desktop?.updater;
  const [state, setState] = useState<UpdateState>({
    phase: bridge && window.desktop?.packaged ? 'idle' : 'dev',
  });

  useEffect(() => {
    if (!bridge) return;
    return bridge.onStatus((event) => {
      setState((current) => reduce(current, event));
    });
  }, [bridge]);

  const check = useCallback(() => {
    if (!bridge) {
      setState({ phase: 'dev' });
      return;
    }
    setState({ phase: 'checking' });
    void bridge.check();
  }, [bridge]);

  const download = useCallback(() => {
    if (!bridge) return;
    void bridge.download();
  }, [bridge]);

  const install = useCallback(() => {
    if (!bridge) return;
    void bridge.install();
  }, [bridge]);

  const openDownloadPage = useCallback(() => {
    const open = window.desktop?.openExternal;
    if (open) void open(RELEASES_URL);
    else window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');
  }, []);

  const value = useMemo(
    () => ({
      state,
      appVersion: window.desktop?.version ?? 'dev',
      bridgeAvailable: Boolean(bridge),
      check,
      download,
      install,
      openDownloadPage,
    }),
    [state, bridge, check, download, install, openDownloadPage],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error('useUpdate must be used inside UpdateProvider');
  return ctx;
}
