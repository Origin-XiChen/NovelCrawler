export interface DesktopBridge {
  isElectron: true;
  platform: string;
  version: string;
  packaged: boolean;
  backendUrl: string;
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  };
  openDir: (name?: string) => Promise<void>;
  /** 弹系统文件选择框,返回绝对路径;取消返回空串 */
  pickExe: () => Promise<string>;
  openDataDir: () => Promise<void>;
  notify: (message: string) => Promise<void>;
  updater: {
    /** 切换是否接收预发布(Dev)版本,返回切换后的值 */
    setPrerelease: (flag: boolean) => Promise<boolean>;
    getPrerelease: () => Promise<boolean>;
    check: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (cb: (status: UpdaterStatus) => void) => () => void;
  };
  openExternal: (url: string) => Promise<void>;
}

export type UpdaterStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseName?: string; releaseNotes?: string; size?: number }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number; bytesPerSecond?: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dev' };

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
