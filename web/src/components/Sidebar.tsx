import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Download,
  FolderOpen,
  Images,
  LayoutDashboard,
  Library,
  ListTodo,
  RefreshCw,
  Search,
  Settings,
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
  const { state, check, download, install, appVersion } = useUpdate();

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

  if (state.phase === 'available') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <Download size={14} />
          发现 v{state.version}
        </div>
        <div className="update-card__meta">已就绪，可后台下载更新包</div>
        <button type="button" className="btn btn--sm" onClick={download}>
          下载更新
        </button>
      </div>
    );
  }

  if (state.phase === 'downloading') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <Download size={14} />
          正在下载 {state.percent ?? 0}%
        </div>
        <div className="update-card__bar">
          <i style={{ width: `${state.percent ?? 0}%` }} />
        </div>
      </div>
    );
  }

  if (state.phase === 'downloaded') {
    return (
      <div className="update-card">
        <div className="update-card__title">
          <Download size={14} />
          v{state.version} 已就绪
        </div>
        <div className="update-card__meta">退出时自动安装，也可以立即重启</div>
        <button type="button" className="btn btn--sm" onClick={install}>
          重启安装
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
