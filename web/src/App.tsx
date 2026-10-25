import { Route, Routes } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';
import { SearchPage } from './pages/Search';
import { ShelfPage } from './pages/Shelf';
import { TasksPage } from './pages/Tasks';
import { FilesPage } from './pages/Files';
import { ReaderPage } from './pages/Reader';
import { ComicsPage } from './pages/Comics';
import { SettingsPage } from './pages/Settings';
import { SourcesPage } from './pages/Sources';
import { SubscriptionsPage } from './pages/Subscriptions';
import { OpdsPage } from './pages/Opds';
import { VerifyPage } from './pages/Verify';
import { MobilePage } from './pages/Mobile';
import { Placeholder } from './pages/Placeholder';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="shelf" element={<ShelfPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="read" element={<ReaderPage />} />
        <Route path="comic" element={<ComicsPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="opds" element={<OpdsPage />} />
        <Route path="verify" element={<VerifyPage />} />
        <Route path="mobile" element={<MobilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <Placeholder
              title="页面不存在"
              description="这个地址没有对应的页面，可能已经移动或删除。"
              icon={BookOpen}
            />
          }
        />
      </Route>
    </Routes>
  );
}
