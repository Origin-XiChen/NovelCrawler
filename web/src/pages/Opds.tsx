import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookMarked,
  BookOpen,
  Compass,
  Download,
  Folder,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import type { OpdsItem } from '../lib/types';

interface OpdsService {
  name: string;
  url: string;
  isDefault?: boolean;
}

const DEFAULT_SERVICES: OpdsService[] = [
  { name: 'wenku8 轻小说', url: 'https://opds.wol.moe/zh_CN', isDefault: true },
];

const STORAGE_KEY = 'novelist_opds_services';

function loadServices(): OpdsService[] {
  const defaults = DEFAULT_SERVICES.map((item) => ({ ...item, isDefault: true }));
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as OpdsService[];
    if (Array.isArray(raw)) {
      return defaults.concat(raw.map((item) => ({ ...item, isDefault: false })));
    }
  } catch {
    /* 本地缓存损坏时忽略 */
  }
  return defaults;
}

function saveCustomServices(services: OpdsService[]) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(services.filter((item) => !item.isDefault).map(({ name, url }) => ({ name, url }))),
  );
}

function bookCover(item: OpdsItem) {
  if (!item.cover) return null;
  return item.cover;
}

export function OpdsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [services, setServices] = useState<OpdsService[]>(() => loadServices());
  const [serviceIndex, setServiceIndex] = useState(0);
  const [url, setUrl] = useState(() => loadServices()[0]?.url ?? '');
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<OpdsItem[]>([]);
  const [crumbs, setCrumbs] = useState<{ url: string; title: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [challenging, setChallenging] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const [downloadItem, setDownloadItem] = useState<OpdsItem | null>(null);
  const [downloadMode, setDownloadMode] = useState<'server' | 'local'>('server');
  const [downloadBusy, setDownloadBusy] = useState(false);

  const loadCatalog = useCallback(async (target: string): Promise<string | null> => {
    if (!target.trim()) {
      toast('请填写 OPDS 地址', 'error');
      return null;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiGet<{ url: string; items: OpdsItem[] }>('/api/opds', { url: target });
      const resolved = data.url || target;
      setUrl(resolved);
      setItems(data.items ?? []);
      return resolved;
    } catch (cause) {
      setItems([]);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const openService = async () => {
    const target = url.trim() || services[serviceIndex]?.url || DEFAULT_SERVICES[0].url;
    const resolved = await loadCatalog(target.replace(/\{q\}/g, ''));
    if (resolved) setCrumbs([{ url: resolved, title: '根目录' }]);
  };

  const chooseService = (index: number) => {
    setServiceIndex(index);
    const service = services[index];
    if (service) setUrl(service.url);
  };

  const search = async () => {
    const text = keyword.trim();
    if (!text) {
      toast('请输入关键词', 'error');
      return;
    }
    const base = url.trim() || services[serviceIndex]?.url || DEFAULT_SERVICES[0].url;
    const target = base.includes('{q}')
      ? base.replace('{q}', encodeURIComponent(text))
      : `${base.split('?')[0].replace(/\/+$/, '')}/search.opds?q=${encodeURIComponent(text)}`;
    const resolved = await loadCatalog(target);
    if (resolved) {
      setCrumbs([
        { url: base.split('?')[0], title: '根目录' },
        { url: resolved, title: `搜索：${text}` },
      ]);
    }
  };

  const openItem = async (item: OpdsItem) => {
    const resolved = await loadCatalog(item.href);
    if (resolved) setCrumbs((prev) => [...prev, { url: resolved, title: item.title }]);
  };

  const goCrumb = async (index: number) => {
    const crumb = crumbs[index];
    if (!crumb) return;
    const resolved = await loadCatalog(crumb.url);
    if (resolved) setCrumbs(crumbs.slice(0, index + 1));
  };

  const addService = () => {
    if (!addName.trim() || !addUrl.trim()) {
      toast('请填写服务名称和地址', 'error');
      return;
    }
    if (!/^https?:\/\//.test(addUrl.trim())) {
      toast('地址需 http(s) 开头', 'error');
      return;
    }
    const next = services.concat({
      name: addName.trim(),
      url: addUrl.trim(),
      isDefault: false,
    });
    setServices(next);
    saveCustomServices(next);
    setServiceIndex(next.length - 1);
    setUrl(addUrl.trim());
    setAddOpen(false);
    setAddName('');
    setAddUrl('');
    toast(`已添加 OPDS 服务：${addName.trim()}`, 'success');
  };

  const removeService = () => {
    const current = services[serviceIndex];
    if (!current || current.isDefault) {
      toast('预置服务不可删除', 'info');
      return;
    }
    const next = services.filter((_, index) => index !== serviceIndex);
    setServices(next);
    saveCustomServices(next);
    setServiceIndex(0);
    setUrl(next[0]?.url ?? '');
    toast(`已删除服务：${current.name}`, 'success');
  };

  const challenge = async () => {
    if (!url.trim()) {
      toast('请先填写 OPDS 地址', 'error');
      return;
    }
    setChallenging(true);
    toast('已打开浏览器窗口，请完成人机验证…', 'info');
    try {
      const data = await apiPost<{ ok?: boolean; cookies?: number }>('/api/opds_challenge', {
        url: url.trim(),
      });
      if (!data.ok) throw new Error('验证未通过');
      toast(`验证通过，已保存 ${data.cookies ?? 0} 个 cookies`, 'success');
      openService();
    } catch (cause) {
      toast(`验证失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setChallenging(false);
    }
  };

  const favorite = async (item: OpdsItem) => {
    if (!item.epub) return;
    try {
      await apiPost('/api/shelf', {
        title: item.title,
        url: item.epub,
        source: 'OPDS',
        cover: item.cover || '',
      });
      toast(`已收藏《${item.title}》到书架`, 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const startDownload = async () => {
    if (!downloadItem?.epub) return;
    setDownloadBusy(true);
    try {
      await apiPost('/api/opds_download', {
        url: downloadItem.epub,
        title: downloadItem.title,
        mode: downloadMode,
        cover: downloadItem.cover || '',
      });
      toast(
        `《${downloadItem.title}》已加入下载队列（${
          downloadMode === 'local' ? '本地直抓' : '服务端生成'
        }）`,
        'success',
      );
      setDownloadItem(null);
    } catch (cause) {
      toast(`启动失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">OPDS 书库</h1>
          <p className="page-desc">
            浏览通用 OPDS 目录，直接搜索文库并下载 EPUB；收藏后可加入书架管理。
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={challenging}
            onClick={() => void challenge()}
          >
            <ShieldCheck size={15} />
            {challenging ? '验证中…' : '手动验证'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setAddOpen(true)}>
            <Plus size={15} />
            添加服务
          </button>
          <button type="button" className="btn" onClick={() => navigate('/tasks')}>
            <Download size={15} />
            下载任务
          </button>
        </div>
      </div>

      <div className="source-toolbar">
        <select
          className="input"
          style={{ width: 180 }}
          value={String(serviceIndex)}
          onChange={(event) => chooseService(Number(event.target.value))}
          aria-label="OPDS 服务"
        >
          {services.map((service, index) => (
            <option key={`${service.name}|${service.url}`} value={index}>
              {service.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={removeService}
          disabled={services[serviceIndex]?.isDefault}
        >
          <Trash2 size={14} />
          删除服务
        </button>
        <div className="toolbar__search" style={{ flex: 1, minWidth: 240 }}>
          <Compass size={15} />
          <input
            className="input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="OPDS 目录地址（支持 {q} 占位）"
            onKeyDown={(event) => {
              if (event.key === 'Enter') openService();
            }}
          />
        </div>
        <button type="button" className="btn" onClick={() => void openService()}>
          打开目录
        </button>
      </div>

      <div className="source-toolbar">
        <div className="toolbar__search" style={{ flex: 1, minWidth: 240 }}>
          <Search size={15} />
          <input
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索该书库关键词（如 史莱姆 / Pride）"
            onKeyDown={(event) => {
              if (event.key === 'Enter') search();
            }}
          />
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void search()}>
          搜索 OPDS
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={loading}
          onClick={() => void loadCatalog(url)}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      {crumbs.length ? (
        <div className="opds-crumbs">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.url}|${index}`}>
              {index > 0 ? <span className="opds-crumbs__sep">›</span> : null}
              <button
                type="button"
                className="opds-crumbs__link"
                onClick={() => goCrumb(index)}
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="source-report" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="empty">正在读取 OPDS 目录…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">
            <BookMarked size={22} />
          </div>
          <div className="empty__title">{crumbs.length ? '该目录暂无条目' : '打开目录开始浏览'}</div>
          <div className="empty__desc">
            选择服务并点击「打开目录」，或直接输入关键词搜索 OPDS 文库。
          </div>
        </div>
      ) : (
        <div className="source-list">
          {items.map((item, index) =>
            item.is_nav ? (
              <button
                key={`${item.href}|${index}`}
                type="button"
                className="source-row opds-row"
                onClick={() => openItem(item)}
              >
                <span className="opds-row__icon">
                  <Folder size={18} />
                </span>
                <span className="source-row__main">
                  <span className="source-row__name">{item.title}</span>
                </span>
                <span className="source-stat">目录</span>
              </button>
            ) : (
              <div className="source-row" key={`${item.href}|${index}`}>
                {bookCover(item) ? (
                  <img className="opds-cover" src={bookCover(item) ?? ''} alt="" loading="lazy" />
                ) : (
                  <span className="opds-cover opds-cover--fallback">
                    {(item.title || '书').slice(0, 1)}
                  </span>
                )}
                <div className="source-row__main">
                  <div className="source-row__title">
                    <span className="source-row__name">{item.title}</span>
                    {item.epub ? <span className="badge badge--primary">EPUB</span> : null}
                  </div>
                  {item.desc ? (
                    <div className="source-row__domain" title={item.desc}>
                      {item.desc}
                    </div>
                  ) : null}
                </div>
                <div className="source-row__actions">
                  {item.href ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => openItem(item)}
                    >
                      详情
                    </button>
                  ) : null}
                  {item.epub ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      title="不下载，直接在阅读器中打开"
                      onClick={() =>
                        navigate(
                          `/read?epub=${encodeURIComponent(item.epub)}&title=${encodeURIComponent(
                            item.title,
                          )}`,
                        )
                      }
                    >
                      <BookOpen size={14} />
                      在线阅读
                    </button>
                  ) : null}
                  {item.epub ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      title="收藏到书架"
                      onClick={() => void favorite(item)}
                    >
                      <Star size={14} />
                      收藏
                    </button>
                  ) : null}
                  {item.epub ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setDownloadMode('server');
                        setDownloadItem(item);
                      }}
                    >
                      <Download size={14} />
                      下载
                    </button>
                  ) : null}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      <Modal
        title="添加 OPDS 服务"
        open={addOpen}
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setAddOpen(false)}>
              取消
            </button>
            <button type="button" className="btn" onClick={addService}>
              添加
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label className="field">
            <span>服务名称</span>
            <input
              className="input"
              value={addName}
              onChange={(event) => setAddName(event.target.value)}
              placeholder="如：我的自建书库"
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>OPDS 地址</span>
            <input
              className="input"
              value={addUrl}
              onChange={(event) => setAddUrl(event.target.value)}
              placeholder="https://example.com/opds 或 .../search.opds?q={q}"
            />
          </label>
        </div>
      </Modal>

      <Modal
        title="下载 EPUB"
        open={Boolean(downloadItem)}
        onClose={() => setDownloadItem(null)}
        width={520}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDownloadItem(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              disabled={downloadBusy}
              onClick={() => void startDownload()}
            >
              <Download size={14} />
              {downloadBusy ? '启动中…' : '开始下载'}
            </button>
          </>
        }
      >
        <div className="opds-download">
          <div className="opds-download__head">
            {downloadItem?.cover ? (
              <img className="opds-cover" src={downloadItem.cover} alt="" />
            ) : (
              <span className="opds-cover opds-cover--fallback">
                {(downloadItem?.title || '书').slice(0, 1)}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="source-row__name">{downloadItem?.title}</div>
              <div className="source-row__domain">EPUB · {downloadItem?.epub}</div>
            </div>
          </div>
          {downloadItem?.desc ? (
            <div className="source-report">{downloadItem.desc}</div>
          ) : null}
          <div className="opds-mode-grid">
            <button
              type="button"
              className={`opds-mode${downloadMode === 'server' ? ' is-on' : ''}`}
              onClick={() => setDownloadMode('server')}
            >
              <b>服务端生成</b>
              <span>由 OPDS 服务生成 EPUB，较慢且无实时进度</span>
            </button>
            <button
              type="button"
              className={`opds-mode${downloadMode === 'local' ? ' is-on' : ''}`}
              onClick={() => setDownloadMode('local')}
            >
              <b>本地直抓</b>
              <span>本地抓取原站并生成 EPUB，速度较快、有进度</span>
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
