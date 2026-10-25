import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Download,
  FileText,
  FolderOpen,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiUpload } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useToast } from '../lib/toast';
import { Modal } from '../components/Modal';
import type { FileEntry } from '../lib/types';

type Sort = 'name' | 'size';

function isEpub(name: string): boolean {
  return name.toLowerCase().endsWith('.epub');
}

function displayName(name: string): string {
  return name.replace(/\.(txt|epub)$/i, '').replace(/\[[^\]]*\]$/, '');
}

export function FilesPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<FileEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiGet<{ files: FileEntry[] }>('/api/files');
      setFiles(data.files ?? []);
    } catch (error) {
      toast(error instanceof Error ? error.message : '文件列表加载失败', 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = files.filter((file) => !keyword || file.name.toLowerCase().includes(keyword));
    return list.sort((a, b) =>
      sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, 'zh-CN'),
    );
  }, [files, query, sort]);

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const remove = async () => {
    if (!removeTarget) return;
    setBusy((prev) => ({ ...prev, [removeTarget.name]: 'remove' }));
    try {
      await apiDelete('/api/file', { name: removeTarget.name });
      setFiles((prev) => prev.filter((file) => file.name !== removeTarget.name));
      toast(`已删除 ${removeTarget.name}`);
      setRemoveTarget(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error');
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        if (removeTarget) delete next[removeTarget.name];
        return next;
      });
    }
  };

  const convert = async (file: FileEntry) => {
    setBusy((prev) => ({ ...prev, [file.name]: 'convert' }));
    try {
      const data = await apiPost<{ file: string; chapters: number }>('/api/convert', {
        file: file.name,
      });
      toast(`已生成 ${data.file}（${data.chapters} 章）`);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : '转换失败', 'error');
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[file.name];
        return next;
      });
    }
  };

  const upload = async (file?: File) => {
    if (!file) return;
    if (!/\.(txt|epub)$/i.test(file.name)) {
      toast('仅支持 .txt / .epub 文件', 'error');
      return;
    }
    setUploading(true);
    try {
      const data = await apiUpload<{ ok: boolean; file: string }>('/api/upload', file);
      toast(`已上传 ${data.file}`);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : '上传失败', 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const openDir = async (name?: string) => {
    if (!window.desktop) {
      toast('仅桌面版支持打开目录', 'error');
      return;
    }
    await window.desktop.openDir(name);
  };

  const downloadUrl = (name: string) => `/downloads/${encodeURIComponent(name)}?dl=1`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">文件</h1>
          <p className="page-desc">
            {files.length} 个文件 · 共 {formatBytes(totalSize)}
          </p>
        </div>
        <div className="page-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.epub"
            style={{ display: 'none' }}
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            className="btn"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <Upload size={15} />
            {uploading ? '上传中…' : '上传书籍'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void openDir()}>
            <FolderOpen size={15} />
            打开目录
          </button>
          <button type="button" className="btn btn--ghost btn--icon" onClick={() => void load()} aria-label="刷新">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__search">
          <Search size={15} />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件名"
            aria-label="搜索文件"
          />
        </div>
        <div className="segmented" role="group" aria-label="排序">
          <button type="button" className={sort === 'name' ? 'is-on' : ''} onClick={() => setSort('name')}>
            按名称
          </button>
          <button type="button" className={sort === 'size' ? 'is-on' : ''} onClick={() => setSort('size')}>
            按大小
          </button>
        </div>
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: 320 }} />
      ) : filtered.length ? (
        <div className="file-list">
          {filtered.map((file) => {
            const epub = isEpub(file.name);
            const working = busy[file.name];
            return (
              <div key={file.name} className="file-row">
                <div className={`file-row__icon${epub ? ' is-epub' : ''}`}>
                  <FileText size={18} />
                </div>
                <div className="file-row__body">
                  <div className="file-row__name" title={file.name}>
                    {displayName(file.name)}
                    <span className="badge">{epub ? 'EPUB' : 'TXT'}</span>
                  </div>
                  <div className="file-row__meta">
                    {formatBytes(file.size)}
                    <span>·</span>
                    <span>{file.name}</span>
                  </div>
                </div>
                <div className="file-row__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => navigate(`/read?file=${encodeURIComponent(file.name)}`)}
                  >
                    <BookOpen size={14} />
                    阅读
                  </button>
                  {!epub ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void convert(file)}
                      disabled={working === 'convert'}
                      title="TXT 转换为 EPUB"
                    >
                      <Wand2 size={14} />
                      {working === 'convert' ? '转换中…' : '转 EPUB'}
                    </button>
                  ) : null}
                  {window.desktop ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void openDir(file.name)}
                      title="在文件夹中显示"
                    >
                      <FolderOpen size={14} />
                      定位
                    </button>
                  ) : (
                    <a className="btn btn--ghost btn--sm" href={downloadUrl(file.name)}>
                      <Download size={14} />
                      下载
                    </a>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm btn--icon"
                    onClick={() => setRemoveTarget(file)}
                    disabled={working === 'remove'}
                    aria-label="删除文件"
                    title="删除文件"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="empty__icon">
            {files.length ? <Search size={20} /> : <FolderOpen size={20} />}
          </div>
          <div className="empty__title">{files.length ? '没有匹配的文件' : '还没有下载文件'}</div>
          <div className="empty__desc">
            {files.length
              ? '换个关键词试试。'
              : '从书架启动下载，或上传本地的 TXT / EPUB 开始阅读。'}
          </div>
        </div>
      )}

      <Modal
        title="删除文件"
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setRemoveTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void remove()}>
              删除
            </button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          确定删除《{removeTarget ? displayName(removeTarget.name) : ''}》吗？文件将从磁盘移除，无法撤销。
        </p>
      </Modal>
    </div>
  );
}
