import { useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppUpdateBanner from './components/AppUpdateBanner';
import BottomNav from './components/BottomNav';
import NativeBackButton from './components/NativeBackButton';
import BookPage from './pages/BookPage';
import ComicReaderPage from './pages/ComicReaderPage';
import ConnectPage from './pages/ConnectPage';
import LibraryPage from './pages/LibraryPage';
import NovelReaderPage from './pages/NovelReaderPage';
import SettingsPage from './pages/SettingsPage';
import { apiGet } from './lib/api';
import { loadedBuildId } from './lib/build';
import { getActiveServer } from './lib/connection';
import { IS_NATIVE } from './lib/native';
import type { PingResult } from './lib/types';

function PresenceWatcher() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (IS_NATIVE) return;
    const localBuild = loadedBuildId();
    const beat = async () => {
      if (!getActiveServer()) return;
      try {
        const info = await apiGet<PingResult>('/api/mobile/ping');
        if (localBuild && info.mobile_build && info.mobile_build !== localBuild) {
          setUpdateReady(true);
        }
      } catch {
        // 离线或令牌失效由各页面自行提示，心跳保持安静
      }
    };
    void beat();
    const timer = window.setInterval(() => void beat(), 60000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  if (!updateReady) return null;
  return (
    <div className="update-banner" role="status">
      <span>
        <RefreshCw size={15} />
        电脑端已更新，刷新后使用新版
      </span>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={() => window.location.reload()}
      >
        立即刷新
      </button>
    </div>
  );
}

function UnauthorizedBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const handle = () => navigate('/connect?expired=1', { replace: true });
    window.addEventListener('nc-unauthorized', handle);
    return () => window.removeEventListener('nc-unauthorized', handle);
  }, [navigate]);
  return null;
}

function RequireServer({ children }: { children: ReactNode }) {
  if (!getActiveServer()) return <Navigate to="/connect" replace />;
  return <>{children}</>;
}

function RootRedirect() {
  const hasPair = /[?&](pair|code)=/.test(window.location.search);
  if (hasPair) return <Navigate to="/connect" replace />;
  return <Navigate to={getActiveServer() ? '/library' : '/connect'} replace />;
}

function LibraryLayout() {
  return (
    <div className="app-shell">
      <div className="app-shell__main">
        <LibraryPage />
      </div>
      <BottomNav />
    </div>
  );
}

function SettingsLayout() {
  return (
    <div className="app-shell">
      <div className="app-shell__main">
        <SettingsPage />
      </div>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <NativeBackButton />
      <PresenceWatcher />
      <AppUpdateBanner />
      <UnauthorizedBridge />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route
          path="/library"
          element={
            <RequireServer>
              <LibraryLayout />
            </RequireServer>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireServer>
              <SettingsLayout />
            </RequireServer>
          }
        />
        <Route
          path="/book/:file"
          element={
            <RequireServer>
              <BookPage />
            </RequireServer>
          }
        />
        <Route
          path="/read/:file"
          element={
            <RequireServer>
              <NovelReaderPage />
            </RequireServer>
          }
        />
        <Route
          path="/comic/:title"
          element={
            <RequireServer>
              <ComicReaderPage />
            </RequireServer>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
