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
  /* 窗口控制胶囊(最小化/最大化/关闭):独立窗口无原生标题栏,必须自带入口。
     仅桌面模式显示;鼠标移出顶栏区域时淡出,避免遮挡阅读内容。 */
  #winCtl { display:none; }
  body.desktop #winCtl {
    display:inline-flex; position:fixed; top:8px; right:12px;
    z-index:var(--z-boot); margin-left:0; gap:2px; padding:3px;
    border-radius:9px; vertical-align:middle; align-self:center;
    -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
    background:rgba(255,255,255,.55); box-shadow:0 2px 8px rgba(0,0,0,.06);
    opacity:.35; transition:opacity .18s;
  }
  body.desktop #winCtl:hover { opacity:1; }
  body.desktop #winCtl .tb-btn {
    -webkit-app-region:no-drag; cursor:pointer;
  }
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
// wid 由宿主在开窗时注入(?wid=readerN);缺失时后端会把它当 "main" —— 那样拖动会
// 去拖主窗口、关闭会关掉主窗口并连带退出进程,故此处直接拦截并告警。
window.__READER_WID__ = new URLSearchParams(location.search).get('wid') || '';
function winPost(path, body) {
  try {
    var wid = window.__READER_WID__;
    if (isDesktop() && path.indexOf('/api/window/') === 0 && !wid) {
      console.warn('[reader] 缺少 wid,已拦截窗口控制请求:', path);
      return Promise.resolve();
    }
    return fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(Object.assign({win: wid || undefined}, body || {}))}).catch(function(){});
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
// 最小化/最大化(带 win 路由到本阅读器窗口),供 #winCtl 胶囊调用
window.tbMin = function () { winPost('/api/window/minimize'); };
window.tbMax = function () { winPost('/api/window/maximize'); };
window.tbClose = function () {
  if (isDesktop()) { winPost('/api/window/close'); } else { window.close(); }
};
// 小说阅读器:点击正文空白处切换工具栏/目录显隐(沉浸模式)。
// reader-core._wireReaderUiToggle 只在 index.html 的 DOMContentLoaded 里调用(那时
// #readerMask 还不存在),独立窗口里没有任何地方调用 → 工具栏一旦隐藏就再也唤不起来。
// 这里在每次进入小说阅读时显式绑定(绑定是幂等的,靠 _uiToggleBound 去重)。
window._readerUiToggleBound = false;
window.bindReaderUiToggle = function () {
  const mask = document.getElementById('readerMask');
  if (!mask || mask._uiToggleBound) return;
  mask._uiToggleBound = true;
  window._readerUiToggleBound = true;
  mask.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('.reader-hd, .reader-bar, .reader-toc, .reader-toc-mask')) return;
    const hidden = document.body.classList.toggle('ui-hidden');
    if (!hidden) document.body.classList.remove('ui-hint');
  });
};
// 兜底:Esc 之外的快捷键 Ctrl/Cmd+H 强制显隐工具栏
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
    if (!document.body.classList.contains('novel-reading')) return;
    e.preventDefault();
    const hidden = document.body.classList.toggle('ui-hidden');
    if (!hidden) document.body.classList.remove('ui-hint');
  }
});
/* ===== 窗口交互:边缘/角落缩放 + 顶栏拖动 + 双击最大化 =====
   WebView2 子窗口盖满客户区,主窗口收不到 WM_NCHITTEST,故由 JS 捕获
   mousedown → HTTP /api/window/* (经 winPost 带上 win=wid) → 后端
   PostMessageW(WM_APP_MOVERESIZE) 发起系统原生拖动/缩放循环。
   与 index.html 主窗口行为保持一致(同一套 EDGE/GRIP 参数)。 */
(function () {
  var EDGE = 10;       // JS 兜底热区宽度(grip 缺失时生效)
  var GRIP_W = 10;     // 边条厚度(四边可抓区)
  var GRIP_C = 20;     // 角块边长(四角可抓区,比边条大便于命中)
  function edgeAt(x, y) {
    var w = window.innerWidth, h = window.innerHeight;
    if (x <= EDGE && y <= EDGE) return 'top-left';
    if (x >= w - EDGE && y <= EDGE) return 'top-right';
    if (x <= EDGE && y >= h - EDGE) return 'bottom-left';
    if (x >= w - EDGE && y >= h - EDGE) return 'bottom-right';
    if (y <= EDGE) return 'top';
    if (y >= h - EDGE) return 'bottom';
    if (x <= EDGE) return 'left';
    if (x >= w - EDGE) return 'right';
    return null;
  }
  /* 边缘抓手:透明固定定位的边条/角块,自带原生缩放 cursor。
     最顶层独立元素,悬停必显示缩放手型;可抓区 10px 边条 / 20px 角块。 */
  (function setupGrips() {
    if (!document.body || !document.body.classList.contains('desktop')) return;
    var defs = [
      ['top',          'left:'+GRIP_C+'px;right:'+GRIP_C+'px;top:0;height:'+GRIP_W+'px',    'ns-resize'],
      ['bottom',       'left:'+GRIP_C+'px;right:'+GRIP_C+'px;bottom:0;height:'+GRIP_W+'px', 'ns-resize'],
      ['left',         'top:'+GRIP_C+'px;bottom:'+GRIP_C+'px;left:0;width:'+GRIP_W+'px',    'ew-resize'],
      ['right',        'top:'+GRIP_C+'px;bottom:'+GRIP_C+'px;right:0;width:'+GRIP_W+'px',   'ew-resize'],
      ['top-left',     'left:0;top:0;width:'+GRIP_C+'px;height:'+GRIP_C+'px',               'nwse-resize'],
      ['top-right',    'right:0;top:0;width:'+GRIP_C+'px;height:'+GRIP_C+'px',              'nesw-resize'],
      ['bottom-left',  'left:0;bottom:0;width:'+GRIP_C+'px;height:'+GRIP_C+'px',            'nesw-resize'],
      ['bottom-right', 'right:0;bottom:0;width:'+GRIP_C+'px;height:'+GRIP_C+'px',           'nwse-resize']
    ];
    defs.forEach(function (d) {
      var g = document.createElement('div');
      g.className = 'win-grip';
      g.style.cssText = 'position:fixed;z-index:var(--z-boot);background:transparent;' + d[1] + ';cursor:' + d[2] + ';';
      g.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        winPost('/api/window/resize', {edge: d[0]});
      });
      document.body.appendChild(g);
    });
  })();
  document.addEventListener('mousedown', function (e) {
    if (!isDesktop()) return;              // 浏览器模式无窗口可控
    if (e.button !== 0) return;
    if (e.target.classList && e.target.classList.contains('win-grip')) return;  // grip 自己已处理
    // 1) 边缘/角落缩放兜底(grip 未生效时)
    var edge = edgeAt(e.clientX, e.clientY);
    if (edge) { e.preventDefault(); winPost('/api/window/resize', {edge: edge}); return; }
    // 2) 顶栏拖动 / 双击最大化(交互元素排除)
    if (e.target.closest && e.target.closest('button, input, select, textarea, a, .btn-sm')) return;
    var tb = e.target.closest ? e.target.closest('.reader-bar, .reader-hd') : null;
    if (!tb) return;
    if (e.detail === 2) { winPost('/api/window/maximize'); return; }  // 双击最大化/还原
    e.preventDefault();
    winPost('/api/window/drag');
  }, true);
})();
// ===== 窗口控制胶囊:独立窗口无原生标题栏,补最小化/最大化/关闭入口 =====
(function setupWinCtl() {
  if (!isDesktop() || !document.body) return;
  var sp = document.createElement('span');
  sp.className = 'tb-btns';
  sp.id = 'winCtl';
  sp.innerHTML =
    '<button class="tb-btn" title="最小化" onclick="tbMin()">—</button>' +
    '<button class="tb-btn" title="最大化/还原" onclick="tbMax()">□</button>' +
    '<button class="tb-btn close" title="关闭" onclick="tbClose()">✕</button>';
  // 顶栏拖动监听会吃掉胶囊上的 mousedown,这里阻断冒泡并阻止拖动
  sp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  document.body.appendChild(sp);
})();
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
      window.bindReaderUiToggle();
    } else if (mode === 'novel_online') {
      openReaderOnline(q.get('rurl') || '', q.get('title') || '在线阅读', num('idx'));
      window.bindReaderUiToggle();
    } else if (mode === 'epub') {
      openEpubOnline(q.get('rurl') || '', q.get('title') || 'EPUB 在线阅读');
      window.bindReaderUiToggle();
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
