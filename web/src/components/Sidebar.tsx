import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  BookMarked,
  Download,
  FolderOpen,
  Globe2,
  Images,
  LayoutDashboard,
  Library,
  ListTodo,
  RefreshCw,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { useUpdate } from '../lib/updater';

const NAV = [
  { to: '/', label: '概览', icon: LayoutDashboard, end: true },
  { to: '/search', label: '搜索', icon: Search },
  { to: '/shelf', label: '书架', icon: Library },
  { to: '/tasks', label: '下载任务', icon: ListTodo, badge: true },
  { to: '/files', label: '文件', icon: FolderOpen },
  { to: '/comic', label: '漫画', icon: Images },
];

function UpdateCard() {
  const { state, check, openDownloadPage, appVersion } = useUpdate();

  if (state.phase === 'dev') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <Sparkles size={14} />
          开发构建 v{appVersion}
        </div>
        <div className="update-card__meta">安装版会从 GitHub Releases 自动检查更新</div>
      </div>
    );
  }

  // 有新版本:只提示 + 给一个发布页入口。
  // 原来的「下载更新 / 进度条 / 重启安装」已撤掉 —— 应用内下载是分段续传,
  // 遇到重试会把进度从 0 重报(看起来像"下满又归零"),安装失败还会重启回旧版。
  if (state.phase === 'available' || state.phase === 'downloaded') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <Download size={14} />
          发现 v{state.version}
        </div>
        <div className="update-card__meta">手动更新：下载安装包后双击安装</div>
        <button type="button" className="btn btn--sm" onClick={openDownloadPage}>
          打开发布页
        </button>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <RefreshCw size={14} />
          检查更新失败
        </div>
        <div className="update-card__meta" title={state.message}>
          {state.message ? state.message.slice(0, 80) : `当前 v${appVersion}`}
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={check}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="update-card">
      <div className="update-card__title">
        <RefreshCw size={14} />
        {state.phase === 'checking' ? '正在检查更新…' : `已是最新 v${appVersion}`}
      </div>
      <div className="update-card__meta">
        {state.phase === 'not-available' ? 'GitHub 发布通道' : '自动检查 GitHub Releases'}
      </div>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={check}
        disabled={state.phase === 'checking'}
      >
        检查更新
      </button>
    </div>
  );
}

export function Sidebar() {
  const [activeCount, setActiveCount] = useState(0);
  const { appVersion } = useUpdate();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await apiGet<{ count: number }>('/api/tasks_active');
        if (alive) setActiveCount(data.count || 0);
      } catch {
        /* 后端暂不可用时静默 */
      }
    };
    void load();
    const timer = window.setInterval(load, 12000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <aside className="sidebar">
      <nav className="nav-group" aria-label="主导航">
        <div className="nav-label">资料库</div>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <item.icon size={17} strokeWidth={1.9} />
            <span>{item.label}</span>
            {item.badge && activeCount > 0 && (
              <span className="nav-item__badge">{activeCount}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <nav className="nav-group" aria-label="扩展">
        <div className="nav-label">扩展</div>
        <NavLink
          to="/sources"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Globe2 size={17} strokeWidth={1.9} />
          <span>书源</span>
        </NavLink>
        <NavLink
          to="/subscriptions"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Rss size={17} strokeWidth={1.9} />
          <span>订阅中心</span>
        </NavLink>
        <NavLink
          to="/opds"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <BookMarked size={17} strokeWidth={1.9} />
          <span>OPDS 书库</span>
        </NavLink>
        <NavLink
          to="/verify"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <ShieldCheck size={17} strokeWidth={1.9} />
          <span>验证中心</span>
        </NavLink>
        <NavLink
          to="/mobile"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Smartphone size={17} strokeWidth={1.9} />
          <span>手机连接</span>
        </NavLink>
      </nav>

      <nav className="nav-group" aria-label="系统">
        <div className="nav-label">系统</div>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <Settings size={17} strokeWidth={1.9} />
          <span>设置</span>
        </NavLink>
      </nav>

      <div className="sidebar__foot">
        <UpdateCard />
        <div className="sidebar__version">
          <span>v{appVersion}</span>
          <span>{window.desktop ? '桌面版' : '浏览器版'}</span>
        </div>
      </div>
    </aside>
  );
}
