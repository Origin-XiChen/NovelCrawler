import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

const TITLES: Record<string, string> = {
  '/': '概览',
  '/search': '搜索',
  '/shelf': '书架',
  '/tasks': '下载任务',
  '/files': '文件',
  '/comic': '漫画',
  '/settings': '设置',
};

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = `${TITLES[pathname] ?? 'NovelCrawler'} · NovelCrawler`;
  }, [pathname]);

  return (
    <div className="app">
      <TitleBar />
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
