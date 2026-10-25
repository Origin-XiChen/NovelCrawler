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
  notify: (message: string) => Promise<void>;
  updater: {
    check: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (cb: (status: UpdaterStatus) => void) => () => void;
  };
  openExternal: (url: string) => Promise<void>;
}

export type UpdaterStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseName?: string; releaseNotes?: string }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dev' };

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
