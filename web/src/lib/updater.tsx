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
  percent?: number;
  message?: string;
}

interface UpdateContextValue {
  state: UpdateState;
  appVersion: string;
  bridgeAvailable: boolean;
  check: () => void;
  /**
   * 打开发布页(手动更新)。
   *
   * 应用内下载/静默安装已停用:electron-updater 遇到断点重试会把进度
   * 从 0 重新报一遍(表现为"下满了又归零"),quitAndInstall 失败又会
   * 让"重启还是旧版本"。现在只负责告知有没有新版,下载安装交给浏览器。
   */
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
      return { phase: 'available', version: event.version, message: event.releaseName };
    case 'not-available':
      return { phase: 'not-available', version: event.version };
    case 'progress':
      return { ...current, phase: 'downloading', percent: Math.round(event.percent) };
    case 'downloaded':
      return { phase: 'downloaded', version: event.version, percent: 100 };
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
      openDownloadPage,
    }),
    [state, bridge, check, openDownloadPage],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error('useUpdate must be used inside UpdateProvider');
  return ctx;
}
