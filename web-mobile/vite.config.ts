import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.NOVEL_DEV_BACKEND_URL || 'http://127.0.0.1:8765';

const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version?: string };

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: http: https:; connect-src 'self' http: https: wss:; " +
  "font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'";

function cspPlugin(): Plugin {
  return {
    name: 'novelcrawler-mobile-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const native = mode === 'native';
  return {
    plugins: [react(), cspPlugin()],
    base: native ? '/' : mode === 'production' ? '/m/' : '/',
    define: {
      __APP_VERSION__: JSON.stringify(rootPkg.version || '0.0.0'),
    },
    build: {
      outDir: native ? '../static/mobile-app-native' : '../static/mobile-app',
      emptyOutDir: true,
      target: 'chrome100',
      rollupOptions: {
        output: {
          // 单包超过 1MB 时 esbuild 的 transform 会把源码写成 %TEMP% 临时文件再删,
          // 本机(Win + Defender)上这一步稳定报 "remove ...: Access is denied" 导致
          // 打包失败。拆成几个小 chunk 后每个都走内存管道,既绕开该问题,
          // 也让手机首次加载能并行取包。
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', 'scheduler'],
            vendor: ['jszip', 'jsqr', 'lucide-react'],
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': { target: BACKEND, changeOrigin: false },
        '/downloads': { target: BACKEND, changeOrigin: false },
        '/icon': { target: BACKEND, changeOrigin: false },
      },
    },
  };
});
