import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { UpdateProvider } from './lib/updater';
import './styles/tokens.css';
import './styles/app.css';

// 经典界面曾注册 Service Worker 缓存旧入口,新界面首次加载时清理
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((reg) => void reg.unregister()))
    .catch(() => {});
}
if ('caches' in window) {
  void caches
    .keys()
    .then((keys) => keys.forEach((key) => void caches.delete(key)))
    .catch(() => {});
}

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <UpdateProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </UpdateProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
