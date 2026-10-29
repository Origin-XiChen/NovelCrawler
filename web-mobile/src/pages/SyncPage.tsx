import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CloudUpload, RefreshCw } from 'lucide-react';
import {
  allBooks,
  allProgress,
  type LocalBook,
  type LocalProgress,
} from '../lib/offline/db';
import { lastSyncAt, syncProgress } from '../lib/offline/sync';
import { continuousPercent } from '../lib/reading-progress';
import { getActiveServer } from '../lib/connection';

/**
 * 同步管理:一眼看到"这台手机上有哪些书、各自读到哪、哪些进度还没回传给电脑"。
 *
 * 之前这些信息散在书架卡片和阅读器里,出问题时(比如"电脑上看不到手机读的进度")
 * 没有任何地方能确认到底传没传。这里把本地进度表完整摊开。
 */
export default function SyncPage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<LocalBook[]>([]);
  const [records, setRecords] = useState<LocalProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [lastAt, setLastAt] = useState(() => lastSyncAt());

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([allBooks(), allProgress()]);
    setBooks(b);
    setRecords(p);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recordMap = useMemo(() => {
    const map = new Map<string, LocalProgress>();
    records.forEach((item) => map.set(item.bookId, item));
    return map;
  }, [records]);

  const rows = useMemo(() => {
    const list = books.map((book) => {
      const record = recordMap.get(book.id);
      return {
        book,
        record,
        percent: record ? continuousPercent(record) : 0,
        dirty: Boolean(record?.dirty),
      };
    });
    // 有进度的排前面,再按最后阅读时间倒序
    return list.sort((a, b) => {
      if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
      return (b.record?.ts || 0) - (a.record?.ts || 0);
    });
  }, [books, recordMap]);

  const dirtyTotal = rows.filter((row) => row.dirty).length;
  const server = getActiveServer();

  const push = async () => {
    setBusy(true);
    setNotice('');
    try {
      const result = await syncProgress();
      setLastAt(lastSyncAt());
      await load();
      setNotice(
        `已回传 ${result.pushed} 条，拉取 ${result.pulled} 条` +
          (result.failed ? `，失败 ${result.failed} 条` : ''),
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-page">
      <header className="sync-page__head">
        <button type="button" className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
        </button>
        <h1>同步管理</h1>
        <button type="button" className="icon-btn" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw size={18} />
        </button>
      </header>

      <div className="sync-summary">
        <div>
          <b>{rows.length}</b>
          <span>本机书籍</span>
        </div>
        <div>
          <b className={dirtyTotal ? 'is-warn' : ''}>{dirtyTotal}</b>
          <span>待回传</span>
        </div>
        <div>
          <b>{server ? server.name || '已配对' : '未连接'}</b>
          <span>电脑</span>
        </div>
      </div>

      <div className="sync-last">
        {lastAt ? `上次同步：${new Date(lastAt).toLocaleString()}` : '还没有同步过'}
      </div>
      <div className="sync-actions">
        <button type="button" className="btn btn--sm" disabled={busy || !server} onClick={() => void push()}>
          <CloudUpload size={14} />
          {busy ? '同步中…' : '立即同步进度'}
        </button>
      </div>
      {notice && <div className="sync-notice">{notice}</div>}

      {rows.length === 0 && (
        <div className="empty-hint">还没有下载或导入任何书。去「书架 → 电脑」挑一本下载吧。</div>
      )}

      <div className="sync-list">
        {rows.map(({ book, record, percent, dirty }) => (
          <div key={book.id} className="sync-row">
            <div className="sync-row__main">
              <div className="sync-row__title">
                <strong title={book.title}>{book.title}</strong>
                <span className="sync-row__pct">{record ? `${percent}%` : '—'}</span>
              </div>
              <div className="sync-row__meta">
                <span>{book.kind === 'comic' ? `${book.total} 页` : `${book.total} 章`}</span>
                <span>{record ? `读到 ${record.ch}/${record.total || book.total}` : '未开始'}</span>
                {dirty && <span className="sync-row__tag">待回传</span>}
              </div>
              {record?.chapter && <div className="sync-row__chapter">{record.chapter}</div>}
              {record && (
                <div className="sync-row__bar">
                  <i style={{ width: `${Math.min(100, percent)}%` }} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
