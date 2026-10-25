import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { UpdateProvider } from './lib/updater';
import './styles/tokens.css';
import './styles/app.css';

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
