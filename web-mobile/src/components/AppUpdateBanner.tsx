import { useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import { Download, X } from 'lucide-react';
import { fetchLatestApk, IS_NATIVE, openApkDownload, type ApkUpdate } from '../lib/native';

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** 「稍后再说」记到本地：同一版本不再反复弹，避免看起来像更新死循环 */
const skipKey = (version: string) => `nc.update.skip.${version}`;

function isSkipped(version: string): boolean {
  try {
    return localStorage.getItem(skipKey(version)) === '1';
  } catch {
    return false;
  }
}

function markSkipped(version: string): void {
  try {
    localStorage.setItem(skipKey(version), '1');
  } catch {
    // 隐私模式忽略
  }
}

export default function AppUpdateBanner() {
  const [update, setUpdate] = useState<ApkUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [opening, setOpening] = useState(false);
  const lastCheck = useRef(0);
  const checking = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    if (!IS_NATIVE) return;
    alive.current = true;

    const check = async (force: boolean) => {
      if (checking.current) return;
      if (!force && Date.now() - lastCheck.current < CHECK_INTERVAL) return;
      checking.current = true;
      lastCheck.current = Date.now();
      try {
        const found = await fetchLatestApk();
        if (alive.current && found && !isSkipped(found.version)) setUpdate(found);
      } catch {
        // GitHub 不可达时保持安静，设置页仍可手动检查
      } finally {
        checking.current = false;
      }
    };

    void check(true);
    let listener: { remove: () => Promise<void> } | null = null;
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void check(false);
    }).then((handle) => {
      listener = handle;
    });

    return () => {
      alive.current = false;
      void listener?.remove();
    };
  }, []);

  if (!update || dismissed) return null;

  const openDownload = async () => {
    setOpening(true);
    try {
      await openApkDownload(update.url);
    } catch {
      window.open(update.url, '_blank', 'noopener');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <span>
        <Download size={15} />
        发现手机 App 新版本 v{update.version}
      </span>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={opening}
        onClick={() => void openDownload()}
      >
        下载安装
      </button>
      <button
        type="button"
        className="update-banner__close"
        aria-label="稍后再说"
        onClick={() => {
          if (update) markSkipped(update.version);
          setDismissed(true);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
