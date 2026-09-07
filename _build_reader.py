# -*- coding: utf-8 -*-
"""组装 static/reader.html —— 独立阅读器页面。

复用 index.html 的 <style> 与阅读器 DOM 块(抽取即得,保证视觉一致),
宿主脚本提供 api/esc/toast 桩 + 桌面窗口拖动/关闭 + 按 URL 参数启动阅读器。
"""
import io
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
src = io.open(os.path.join(ROOT, 'static', 'index.html'), encoding='utf-8').read()


def cut(start_marker, end_marker, include_end=False):
    a = src.index(start_marker)
    b = src.index(end_marker, a)
    if include_end:
        b += len(end_marker)
    return src[a:b]


style = cut('<style>', '</style>', include_end=True)
comic_dom = cut('<!-- 漫画独立阅读页(沉浸式', '<div class="cview" id="cview-shelf">')
pdf_dom = cut('<!-- ================== 漫画本地 PDF 阅读器', '<!-- 全局浮动窗口控制按钮')
novel_dom = cut('<div class="modal-mask" id="readerMask">', '<!-- 书架编辑(标签/分类/评分) -->')
toast_dom = '<div class="toast" id="toast"></div>'

css_extra = u'''
<style>
  /* ===== reader.html 独立窗口补充样式 ===== */
  html, body { height:100%; overflow:hidden; }
  /* 顶栏即拖动区(桌面模式):mousedown → /api/window/drag 接管 */
  body.desktop .reader-bar, body.desktop .reader-hd { -webkit-app-region: drag; }
  body.desktop .reader-bar button, body.desktop .reader-bar .rb,
  body.desktop .reader-bar span, body.desktop .reader-hd button { -webkit-app-region: no-drag; }
</style>
'''

boot = u'''<script>
/* ===== reader.html 宿主环境 ===== */
'use strict';
// 精简 api/esc/toast(独立页无主界面加载条)
async function api(path, opts, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(path, {...(opts || {}), signal: ctrl.signal});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally { clearTimeout(timer); }
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function jss(s) { return String(s ?? '').replace(/[\\'"]/g, '\\$&'); }
// 下载任务跟踪状态:独立页无后台下载系统,恒为空(后台任务标记恒不显示)
window._dlTasks = new Map();
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
}
// 视图切换桩(reader.html 只承载阅读视图)
window.comicShowView = function (v) {
  document.querySelectorAll('.cview').forEach(c => c.classList.toggle('active', c.id === 'cview-' + v));
};
window.showView = function () {};
window.isDesktop = function () { return !!(window.chrome && window.chrome.webview); };
// 窗口控制:桌面模式带 wid 调 /api/window/*(reader 窗口自身);浏览器模式无窗口概念
window.__READER_WID__ = new URLSearchParams(location.search).get('wid') || '';
function winPost(path, body) {
  try {
    return fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(Object.assign({win: window.__READER_WID__ || undefined}, body || {}))}).catch(function(){});
  } catch (e) { return Promise.resolve(); }
}
if (isDesktop()) document.body.classList.add('desktop');
// 关闭函数改写为关闭本窗口(桌面)/标签页(浏览器)
window.closeComicReader = function () {
  if (isDesktop()) { winPost('/api/window/close'); } else { window.close(); }
};
window.closeReader = function () {
  if (isDesktop()) { winPost('/api/window/close'); } else { window.close(); }
};
window.closeLocalPdf = function () {
  if (isDesktop()) { winPost('/api/window/close'); } else { window.close(); }
};
// 拖动:阅读器顶栏 → /api/window/drag(带 win)
document.addEventListener('mousedown', function (e) {
  if (!isDesktop()) return;
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('button, input, select, textarea, a, .btn-sm')) return;
  if (e.target.closest && e.target.closest('.reader-bar, .reader-hd')) { e.preventDefault(); winPost('/api/window/drag'); }
}, true);
// ===== 启动:按 URL 参数进入对应阅读器 =====
(function boot() {
  const q = new URLSearchParams(location.search);
  const mode = q.get('mode') || '';
  window.__EMBED_READER__ = true;   // 入口函数不再二次开窗
  const num = k => { const v = parseInt(q.get(k) || '1', 10); return isFinite(v) && v > 0 ? v : 1; };
  try {
    if (mode === 'comic') {
      comicOpenReader(q.get('source') || '', q.get('comic_id') || '', q.get('title') || '漫画', 'reader');
    } else if (mode === 'novel') {
      openReader(q.get('file') || '', num('idx'));
    } else if (mode === 'novel_online') {
      openReaderOnline(q.get('rurl') || '', q.get('title') || '在线阅读', num('idx'));
    } else if (mode === 'epub') {
      openEpubOnline(q.get('rurl') || '', q.get('title') || 'EPUB 在线阅读');
    } else if (mode === 'pdf') {
      comicOpenLocalPdf(q.get('title') || '漫画', q.get('file') || '');
    } else {
      document.body.innerHTML = '<div style="padding:40px; color:var(--muted); font-size:14px">缺少阅读参数(mode)</div>';
    }
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px; color:var(--danger); font-size:14px">打开失败: ' + esc(e.message) + '</div>';
  }
})();
</script>'''

html = (u'<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        u'<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        u'<title>阅读器 · 漫画+小说</title>\n'
        + style + u'\n' + css_extra + u'\n</head>\n<body>\n'
        + toast_dom + u'\n'
        + comic_dom + u'\n' + pdf_dom + u'\n' + novel_dom + u'\n'
        + u'<script src="/static/pdfjs/pdf.min.js"></script>\n'
        + u'<script src="/static/reader-core.js"></script>\n'
        + boot + u'\n</body>\n</html>\n')
out = os.path.join(ROOT, 'static', 'reader.html')
io.open(out, 'w', encoding='utf-8').write(html)
print('reader.html generated:', len(html), 'chars')
