import { useRef, useState } from 'react';
import { Check, CloudUpload, Download, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { errorMessage } from '../lib/format';
import { announceLibraryChange } from '../lib/offline/useLibrary';
import { importBook, refreshBook, type ImportProgress, type ImportTarget } from '../lib/offline/transfer';
import type { LocalBook } from '../lib/offline/db';

interface Props {
  target: ImportTarget;
  /** 已在手机上的这本(没有就显示"下载到手机") */
  local?: LocalBook;
  /** 电脑上的版本比本地新 */
  outdated?: boolean;
  compact?: boolean;
}

interface Busy {
  detail: string;
  done: number;
  total: number;
  stage: string;
}

/**
 * "下载到手机"按钮:一次导入=请求整本离线包 + 写本地书库。
 * 电脑打包大书会有几十秒静默期,所以进度文案来自 transfer 的打包轮询。
 */
export function DownloadButton({ target, local, outdated, compact }: Props) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const onStage = (p: ImportProgress) =>
    setBusy({ detail: p.detail, done: p.done, total: p.total, stage: p.stage });

  const start = async (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setError('');
    setBusy({ detail: '准备中…', done: 0, total: 0, stage: 'packing' });
    try {
      if (local) await refreshBook(local, onStage);
      else await importBook(target, onStage);
      announceLibraryChange();
      setBusy(null);
    } catch (cause) {
      setBusy(null);
      setError(errorMessage(cause));
      window.setTimeout(() => setError(''), 5000);
    } finally {
      busyRef.current = false;
    }
  };

  if (busy) {
    const percent = busy.total ? Math.round((busy.done / busy.total) * 100) : 0;
    return (
      <span className="offline-status offline-status--working">
        <Loader2 size={14} className="spin" />
        {busy.detail}
        {busy.stage === 'downloading' && busy.total > 0 && (
          <i className="offline-bar">
            <b style={{ width: `${percent}%` }} />
          </i>
        )}
      </span>
    );
  }
  if (error) {
    return (
      <span className="offline-status offline-status--failed">
        <WifiOff size={14} />
        {error}
      </span>
    );
  }
  if (local && !outdated) {
    return (
      <span className="offline-status offline-status--done">
        <Check size={14} />
        已存手机
      </span>
    );
  }
  return (
    <button type="button" className={compact ? 'chip-btn' : 'btn btn--ghost btn--sm'} onClick={start}>
      {local ? <RefreshCw size={compact ? 14 : 16} /> : <Download size={compact ? 14 : 16} />}
      {local ? '更新到手机' : compact ? '下载' : '下载到手机'}
    </button>
  );
}

/** 本地内容标记:书架/详情页用来区分"手机里的"和"电脑上的"。 */
export function LocalChip({ dirty }: { dirty?: boolean }) {
  return (
    <span className={`offline-chip${dirty ? ' is-dirty' : ''}`}>
      {dirty ? <CloudUpload size={12} /> : <WifiOff size={12} />}
      {dirty ? '待同步' : '离线'}
    </span>
  );
}
