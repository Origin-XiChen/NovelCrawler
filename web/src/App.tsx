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
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <Placeholder
              title="页面不存在"
              description="这个地址没有对应的新界面页面。"
              icon={BookOpen}
              features={['返回概览']}
            />
          }
        />
      </Route>
    </Routes>
  );
}
