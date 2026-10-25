import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.NOVEL_DEV_BACKEND_URL || 'http://127.0.0.1:8765';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  'img-src \'self\' data: blob: http: https:; ' +
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; font-src 'self' data:; " +
  "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

// 开发模式 Vite 会注入内联的 react-refresh 脚本，无法通过严格 CSP；
// 只在生产构建注入 CSP，桌面端实际加载的是生产产物。
function cspPlugin(): Plugin {
  return {
    name: 'novelcrawler-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), cspPlugin()],
  base: mode === 'production' ? '/app/' : '/',
  build: {
    outDir: '../static/app',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/icon': { target: BACKEND, changeOrigin: false },
    },
  },
}));
