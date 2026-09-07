/* ============================================================
 * reader-core.js —— 阅读器共享内核
 * 由 index.html 抽取的三套阅读器逻辑(原样搬移):
 *   1) 本地 PDF 漫画阅读器(pdf.js,双页/卷目录/进度)
 *   2) 漫画在线阅读器(目录/图片流/缩放/夜读/页码HUD/失败重试)
 *   3) 小说阅读器(txt/epub/在线;字体/版式/书签笔记/TTS/划词)
 * 依赖宿主提供全局: api(), esc(), toast(), comicShowView(), showView()
 *   —— index.html 天然具备;reader.html 自带精简实现。
 * 加载顺序:先于 index.html 主脚本与本页启动代码。
 * ============================================================ */
'use strict';

const PDFREAD_KEY = 'novelist_comic_pdf_progress';
const PDFIMG_KEY = 'novelist_pdf_imgmode';
let pdfReader = {title: '', file: '', files: [], meta: null, curVol: null, curIdx: -1, pageNum: 1, scale: 0, twoPage: false, imgMode: false, imgMeta: null};
let _pdfImgMetaP = null;
try { pdfReader.imgMode = localStorage.getItem(PDFIMG_KEY) === '1'; } catch (e) { /* ignore */ }
let _pdfBackView = 'files';
let _pdfDoc = null;          // pdf.js 文档对象
let _pdfRenderTask = null;   // 当前渲染任务(取消旧任务)
function _pdfBase() { return '/downloads/comic/' + encodeURIComponent(pdfReader.title) + '/'; }
function _pdfUrl(file) { return _pdfBase() + encodeURIComponent(file); }
function comicOpenLocalPdf(title, file) {
  const all = (pdfReader.files && pdfReader.title === title) ? pdfReader.files : [];
  if (!all.length) {
    api('/api/comic_pdf_meta?title=' + encodeURIComponent(title) + '&file=' + encodeURIComponent(file || ''), {silent: true})
      .then(j => {
        if (j && j.ok) {
          pdfReader.meta = j.meta || null;
          pdfReader.files = j.pdfs || [];
          _pdfOpen(title, file || (j.pdfs || [])[0]);
        } else _pdfOpen(title, file || '');
      }).catch(() => _pdfOpen(title, file || ''));
  } else {
    _pdfOpen(title, file || all[0]);
  }
}
function _pdfOpen(title, file) {
  if (!file) { toast('未找到 PDF 文件'); return; }
  pdfReader.title = title; pdfReader.file = file;
  pdfReader.curIdx = pdfReader.files.indexOf(file);
  pdfReader.curVol = null;
  pdfReader.imgMeta = null; _pdfImgMetaP = null;
  const back = document.querySelector('#comicRoot .cview.active');
  _pdfBackView = back ? back.id.replace('cview-', '') : 'files';
  // 按 PDF 名匹配 per_chapter meta 里的卷/话
  if (pdfReader.meta && pdfReader.meta.mode === 'per_chapter') {
    for (const v of (pdfReader.meta.volumes || [])) {
      const hit = (v.chapters || []).find(c => c.pdf === file);
      if (hit) { pdfReader.curVol = v; break; }
    }
  }
  document.getElementById('pdfReaderTitle').textContent = '《' + title + '》 · ' + file.replace(/\.pdf$/i, '');
  const body = document.getElementById('pdfReaderBody');
  body.innerHTML = '<div class="empty" style="padding:40px; color:var(--muted)">加载 PDF 中…</div>';
  body.classList.remove('two-page');
  document.body.classList.add('comic-reading');
  const v = document.getElementById('cview-pdfreader');
  v.style.display = 'flex';
  renderPdfToc();
  _pdfUnload();
  _pdfSyncImgBtn();
  if (pdfReader.imgMode) _pdfRenderImg();
  else _pdfLoad();
}
function _pdfUnload() {
  if (_pdfRenderTask) { try { _pdfRenderTask.cancel(); } catch (e) { /* ignore */ } _pdfRenderTask = null; }
  if (_pdfDoc) { try { _pdfDoc.destroy(); } catch (e) { /* ignore */ } _pdfDoc = null; }
}
function _pdfReady() {
  return !!_pdfDoc || (pdfReader.imgMode && !!(pdfReader.imgMeta && pdfReader.imgMeta.numPages));
}
function _pdfNumPages() {
  return _pdfDoc ? _pdfDoc.numPages : ((pdfReader.imgMeta && pdfReader.imgMeta.numPages) || 0);
}
function _pdfSyncImgBtn() {
  const btn = document.getElementById('pdfImgModeBtn');
  if (btn) btn.classList.toggle('on', pdfReader.imgMode);
}
function _pdfRefresh() {
  if (pdfReader.imgMode) _pdfRenderImg();
  else _pdfRender();
}
function pdfToggleImgMode() {
  _pdfSetImgMode(!pdfReader.imgMode, !pdfReader.imgMode ? '已切换图片直读模式(低内存)' : '');
}
function _pdfSetImgMode(on, note) {
  pdfReader.imgMode = !!on;
  try { localStorage.setItem(PDFIMG_KEY, pdfReader.imgMode ? '1' : '0'); } catch (e) { /* ignore */ }
  pdfReader.scale = 0;  // 图片直读以适宽为基准
  _pdfSyncImgBtn();
  if (note) toast(note);
  if (pdfReader.imgMode) { _pdfUnload(); _pdfRenderImg(); }
  else _pdfLoad();
}
function _pdfImgMetaEnsure() {
  if (pdfReader.imgMeta) return Promise.resolve(pdfReader.imgMeta);
  if (!_pdfImgMetaP) {
    _pdfImgMetaP = api('/api/comic_page_meta?title=' + encodeURIComponent(pdfReader.title) +
                       '&file=' + encodeURIComponent(pdfReader.file), {silent: true})
      .then(j => { pdfReader.imgMeta = (j && j.ok) ? {numPages: j.num_pages || 0} : {numPages: 0}; })
      .catch(() => { pdfReader.imgMeta = {numPages: 0}; });
  }
  return _pdfImgMetaP.then(() => pdfReader.imgMeta);
}
async function _pdfRenderImg() {
  const body = document.getElementById('pdfReaderBody');
  const info = document.getElementById('pdfReaderInfo');
  if (!body) return;
  const meta = await _pdfImgMetaEnsure();
  if (!meta.numPages) {
    body.innerHTML = '<div class="empty" style="padding:40px">图片直读失败:无法解析该 PDF,建议点「系统内核」打开</div>';
    return;
  }
  const pn = Math.min(Math.max(1, pdfReader.pageNum), meta.numPages);
  pdfReader.pageNum = pn;
  if (info) info.textContent = '第 ' + pn + ' / ' + meta.numPages + ' 页 · 图片直读';
  _pdfSetProgress(pn);
  body.innerHTML = '';
  const pages = pdfReader.twoPage ? [pn, pn + 1].filter(p => p <= meta.numPages) : [pn];
  for (const num of pages) {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap' + (num === pn ? ' cur' : '');
    wrap.dataset.page = num;
    body.appendChild(wrap);
    const img = document.createElement('img');
    img.className = 'pdf-page';
    img.decoding = 'async';
    img.alt = '第 ' + num + ' 页';
    img.src = '/api/comic_page_image?title=' + encodeURIComponent(pdfReader.title) +
              '&file=' + encodeURIComponent(pdfReader.file) + '&page=' + num;
    if (pdfReader.scale) img.style.width = Math.round(Math.min(pdfReader.scale, 3.5) * 100) + '%';
    img.onerror = () => {
      img.onerror = null;
      img.style.width = '320px';
      img.src = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="452"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="50%" fill="#94a3b8" text-anchor="middle" font-size="14">第 ' + num + ' 页无内嵌图片</text></svg>');
    };
    wrap.appendChild(img);
    const no = document.createElement('div');
    no.className = 'pdf-page-no';
    no.textContent = '第 ' + num + ' 页';
    wrap.appendChild(no);
  }
  body.scrollTop = 0;
}
function pdfOpenSystem() {
  if (!pdfReader.file) return;
  const w = window.open(_pdfUrl(pdfReader.file), '_blank');
  if (!w) toast('弹窗被拦截,请允许弹窗后重试');
}
function _pdfLoad() {
  if (!window.pdfjsLib) { toast('PDF 内核加载失败'); return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.js';
  pdfjsLib.getDocument({url: _pdfUrl(pdfReader.file), isEvalSupported: false,
                        rangeChunkSize: 262144, disableAutoFetch: true,
                        disableStream: true}).promise
    .then(doc => {
      _pdfDoc = doc;
      const saved = _pdfGetProgress();
      let target = 1;
      if (saved && saved.title === pdfReader.title && saved.file === pdfReader.file) {
        target = Math.min(doc.numPages, Math.max(1, saved.page || 1));
        if (target > 1) document.getElementById('pdfReaderInfo').textContent = '继续上次: 第 ' + target + ' 页';
      }
      pdfReader.pageNum = target;
      pdfReader.scale = 0;
      pdfReader.twoPage = false;
      document.getElementById('pdfReaderBody').classList.remove('two-page');
      _pdfRender();
    })
    .catch(e => {
      const msg = String((e && e.message) || e);
      const big = /allocation|memory|out of/i.test(msg);
      if (big) { _pdfSetImgMode(true, '内存不足,已自动切换图片直读模式'); return; }
      document.getElementById('pdfReaderBody').innerHTML =
        '<div class="empty" style="padding:40px">PDF 加载失败: ' + esc(msg) + '</div>';
    });
}
async function _pdfRender() {
  const body = document.getElementById('pdfReaderBody');
  const info = document.getElementById('pdfReaderInfo');
  if (!_pdfDoc || !body) return;
  if (_pdfRenderTask) { try { _pdfRenderTask.cancel(); } catch (e) { /* ignore */ } _pdfRenderTask = null; }
  const pn = Math.min(Math.max(1, pdfReader.pageNum), _pdfDoc.numPages);
  pdfReader.pageNum = pn;
  if (info) info.textContent = '第 ' + pn + ' / ' + _pdfDoc.numPages + ' 页';
  _pdfSetProgress(pn);
  // 当前页尺寸决定缩放
  const page = await _pdfDoc.getPage(pn);
  const vp1 = page.getViewport({scale: 1});
  if (!pdfReader.scale) {
    const avail = Math.max(320, body.clientWidth - 48);
    pdfReader.scale = Math.max(0.4, Math.min(2.2, avail / vp1.width));
  }
  body.innerHTML = '';
  const pages = pdfReader.twoPage ? [pn, pn + 1].filter(p => p <= _pdfDoc.numPages) : [pn];
  for (const num of pages) {
    // 画布 + 页码角标包一层:每页自带页码,缺页一眼可见
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap' + (num === pn ? ' cur' : '');
    wrap.dataset.page = num;
    body.appendChild(wrap);
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    wrap.appendChild(canvas);
    const no = document.createElement('div');
    no.className = 'pdf-page-no';
    no.textContent = '第 ' + num + ' 页';
    wrap.appendChild(no);
    const pg = await _pdfDoc.getPage(num);
    // 渲染像素上限(约500万):超高分辨率页降采样渲染,位图内存可控;显示尺寸不变
    const v1 = pg.getViewport({scale: 1});
    let rs = pdfReader.scale;
    if (v1.width * v1.height * rs * rs > 5e6) rs = Math.sqrt(5e6 / (v1.width * v1.height));
    const vp = pg.getViewport({scale: rs});
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    if (rs < pdfReader.scale - 0.01) {
      canvas.style.width = Math.round(v1.width * pdfReader.scale) + 'px';
      canvas.style.height = Math.round(v1.height * pdfReader.scale) + 'px';
    }
    const ctx = canvas.getContext('2d');
    const rt = pg.render({canvasContext: ctx, viewport: vp});
    _pdfRenderTask = rt;
    await rt.promise;
  }
  _pdfRenderTask = null;
  body.scrollTop = 0;
}
function pdfBodyClick(e) {
  // 点击画布左 1/3=上一页,右 1/3=下一页(避开目录/按钮区)
  if (!_pdfReady()) return;
  const x = e.clientX, w = document.body.clientWidth;
  if (e.target && e.target.closest && e.target.closest('.reader-bar, #pdfTocWrap')) return;
  if (x < w * 0.33) pdfPrevPage();
  else if (x > w * 0.66) pdfNextPage();
}
function pdfPrevPage() {
  if (!_pdfReady()) return;
  const pn = pdfReader.pageNum - (pdfReader.twoPage ? 2 : 1);
  if (pn < 1) { toast('已经是第一页'); return; }
  pdfReader.pageNum = pn;
  _pdfRefresh();
}
function pdfNextPage() {
  if (!_pdfReady()) return;
  const pn = pdfReader.pageNum + (pdfReader.twoPage ? 2 : 1);
  if (pn > _pdfNumPages()) { toast('已经是最后一页'); return; }
  pdfReader.pageNum = pn;
  _pdfRefresh();
}
function pdfZoom(d) {
  if (!_pdfReady()) return;
  pdfReader.scale = Math.max(0.4, Math.min(3.5, (pdfReader.scale || 1) + d * 0.2));
  _pdfRefresh();
}
function pdfToggle2page() {
  if (!_pdfReady()) return;
  pdfReader.twoPage = !pdfReader.twoPage;
  document.getElementById('pdfReaderBody').classList.toggle('two-page', pdfReader.twoPage);
  _pdfRefresh();
}
function pdfToggleFull() {
  const v = document.getElementById('cview-pdfreader');
  if (!v) return;
  if (!document.fullscreenElement) { if (v.requestFullscreen) v.requestFullscreen(); }
  else if (document.exitFullscreen) document.exitFullscreen();
}
function pdfToggleToc() {
  const w = document.getElementById('pdfTocWrap');
  if (w) w.style.display = w.style.display === 'none' ? '' : 'none';
}
function renderPdfToc() {
  const box = document.getElementById('pdfTocList');
  if (!box) return;
  if (!pdfReader.meta) {
    box.innerHTML = (pdfReader.files || []).map((p, i) =>
      `<div class="rd-chap ${p === pdfReader.file ? 'active' : ''}" onclick="comicOpenLocalPdf('${jss(pdfReader.title)}','${jss(p)}')">
         <span class="ct">${esc(p.replace(/\.pdf$/i, ''))}</span></div>`).join('')
      || '<div class="empty">暂无目录信息</div>';
    return;
  }
  const vols = pdfReader.meta.volumes || [];
  if (!vols.length) { box.innerHTML = '<div class="empty">暂无目录信息</div>'; return; }
  box.innerHTML = vols.map((v, vi) => {
    const chapters = pdfReader.meta.mode === 'per_chapter'
      ? (v.chapters || []).map(c => {
          const active = c.pdf === pdfReader.file;
          const label = c.chapter ? `第${c.chapter}话` : (c.label || c.pdf.replace(/\.pdf$/i, ''));
          const onclick = `event.stopPropagation();comicOpenLocalPdf('${jss(pdfReader.title)}','${jss(c.pdf)}')`;
          return `<div class="rd-chap ${active ? 'active' : ''}" onclick="${onclick}"><span class="ct">${esc(label)}${c.title ? ' ' + esc(c.title) : ''}</span></div>`;
        }).join('')
      : (v.chapters || []).map(c => {
          const active = pdfReader.curVol === v;
          const label = (c.chapter ? `第${c.chapter}话` : c.label || '') + (c.title ? ' ' + c.title : '');
          const onclick = `event.stopPropagation();pdfJumpPage(${c.first_page || 1})`;
          return `<div class="rd-chap ${active ? 'active' : ''}" onclick="${onclick}"><span class="ct">${esc(label)}</span><span class="tb">第${c.first_page || 1}页</span></div>`;
        }).join('');
    return `<div class="rd-vol">📚 第${vi + 1}卷${v.volume ? ' · ' + esc(v.volume) : ''}</div>${chapters}`;
  }).join('');
}
function pdfJumpPage(page) {
  if (!_pdfReady()) { toast('PDF 尚未加载完成'); return; }
  pdfReader.pageNum = Math.min(_pdfNumPages(), Math.max(1, page));
  pdfToggleToc();
  _pdfRefresh();
}
function pdfPrevChapter() {
  if (pdfReader.curIdx > 0) comicOpenLocalPdf(pdfReader.title, pdfReader.files[pdfReader.curIdx - 1]);
  else if (pdfReader.meta && pdfReader.meta.mode === 'merged' && _pdfReady()) {
    // 合集模式:跳到上一话的起始页
    const all = [];
    for (const v of (pdfReader.meta.volumes || [])) for (const c of v.chapters || []) all.push(c);
    const cur = all.findIndex(c => (c.first_page || 1) <= pdfReader.pageNum && pdfReader.pageNum <= (c.last_page || Infinity));
    if (cur > 0) pdfJumpPage(all[cur - 1].first_page || 1);
    else toast('已经是第一话');
  } else toast('已经是第一话');
}
function pdfNextChapter() {
  if (pdfReader.curIdx < pdfReader.files.length - 1) comicOpenLocalPdf(pdfReader.title, pdfReader.files[pdfReader.curIdx + 1]);
  else if (pdfReader.meta && pdfReader.meta.mode === 'merged' && _pdfReady()) {
    const all = [];
    for (const v of (pdfReader.meta.volumes || [])) for (const c of v.chapters || []) all.push(c);
    const cur = all.findIndex(c => (c.first_page || 1) <= pdfReader.pageNum && pdfReader.pageNum <= (c.last_page || Infinity));
    if (cur >= 0 && cur < all.length - 1) pdfJumpPage(all[cur + 1].first_page || 1);
    else toast('已经是最后一话');
  } else toast('已经是最后一话');
}
function _pdfGetProgress() {
  try { return JSON.parse(localStorage.getItem(PDFREAD_KEY) || 'null'); } catch (e) { return null; }
}
function _pdfSetProgress(page) {
  try {
    localStorage.setItem(PDFREAD_KEY, JSON.stringify({title: pdfReader.title, file: pdfReader.file, page, ts: Date.now()}));
  } catch (e) { /* ignore */ }
}
function closeLocalPdf() {
  _pdfUnload();
  const v = document.getElementById('cview-pdfreader');
  if (v) v.style.display = 'none';
  document.body.classList.remove('comic-reading');
  document.getElementById('pdfReaderBody').classList.remove('two-page');
  comicShowView(_pdfBackView || 'files');
}

let comicReader = {source: '', comic_id: '', title: '', chapters: [], idx: 1, zoom: 1};

function comicChapLabel(c, i) {
  const t = (c.volume ? `第${c.volume}卷 ` : '') + (c.chapter ? `第${c.chapter}话` : '') + (c.title ? ' ' + c.title : '');
  return t.trim() || ('第' + (i + 1) + '话');
}
async function comicOpenReader(source, comic_id, title, from) {
  comicReader = {source, comic_id, title, from: from || 'search', chapters: [], idx: 1, zoom: 1, twoPage: false, thumbs: {}};
  // 进入沉浸阅读页(隐藏侧栏/顶栏,主区全幅)
  document.body.classList.add('comic-reading');
  comicShowView('reader');
  const bar = document.getElementById('readerBar');
  if (bar) bar.style.display = '';
  document.getElementById('comicRTitle').textContent = '《' + title + '》';
  const body = document.getElementById('comicRBody');
  body.innerHTML = '<div class="empty">加载目录中…</div>';
  body.classList.remove('two-page');
  document.getElementById('comicRTocWrap').classList.remove('show');
  document.getElementById('comicRPage').textContent = '';
  try {
    const j = await api('/api/comic_toc?id=' + encodeURIComponent(comic_id) + '&source=' + encodeURIComponent(source));
    if (!j.ok) throw new Error(j.error || '加载失败');
    openComicReader(source, comic_id, title, j.chapters || []);
  } catch (e) {
    body.innerHTML = '<div class="empty">目录加载失败: ' + esc(e.message) + '</div>';
  }
}
function openComicReader(source, comic_id, title, chapters) {
  comicReader.chapters = chapters;
  if (!chapters.length) { document.getElementById('comicRBody').innerHTML = '<div class="empty">暂无章节</div>'; return; }
  // 切到阅读器视图(必须清掉其他 cview 的 active,否则搜索/详情页与阅读器同框显示)
  comicShowView('reader');
  try {
    const saved = JSON.parse(localStorage.getItem(CREAD_KEY) || '{}');
    const pos = (saved[source] || {})[comic_id];
    if (pos) comicReader.idx = pos;
  } catch (e) {}
  comicReader.idx = Math.min(Math.max(1, comicReader.idx), chapters.length);
  document.onkeydown = e => {
    if (e.key === 'Escape') closeComicReader();
    else if (e.key === 'ArrowLeft') comicReaderPrev();
    else if (e.key === 'ArrowRight') comicReaderNext();
    else if (e.key === 'F' || e.key === 'f') comicReaderFullscreen();
    else if (e.key === 'T' || e.key === 't') comicRTocToggle();
    else if (e.key === '+' || e.key === '=') comicReaderAdj(0.1);    else if (e.key === '-') comicReaderAdj(-0.1);
  };
  renderComicRToc();
  comicApplyZoom();  // 应用持久化屏幕缩放
  comicApplyFit();   // 应用持久化适应模式(适宽/整页)
  comicApplyDark();  // 应用持久化夜读背景
  comicWireWheel();  // 绑定滚轮缩放(Ctrl+滚轮缩放 / 普通滚轮滚动)
  comicLoadEp(comicReader.idx);
}
/* 漫画阅读器滚轮:Ctrl/Cmd+滚轮 → 图片缩放;普通滚轮 → 保持页面滚动。
   绑定 document(漫画阅读态全局接管):否则工具条/空白处的 Ctrl+滚轮会触发
   WebView2 内置页面缩放,出现"连界面一起放大"。 */
let _comicWheelBound = null;
function comicWireWheel() {
  if (_comicWheelBound) return;  // document 级只绑一次,是否接管由 comic-reading 类决定
  _comicWheelBound = (e) => {
    if (!document.body.classList.contains('comic-reading')) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    comicReaderAdj(step);
  };
  document.addEventListener('wheel', _comicWheelBound, {passive: false});
}
// 退出阅读页:回到来源页(详情/搜索/收藏)
function closeComicReader() {
  document.body.classList.remove('comic-reading');
  document.body.classList.remove('comic-dark');
  document.onkeydown = null;
  const from = comicReader.from || 'search';
  comicShowView(from === 'detail' ? 'detail' : from);
}
// 点击画面空白处切换显隐顶栏(沉浸)
function toggleReaderUI() {
  const bar = document.getElementById('readerBar');
  if (bar) bar.style.display = bar.style.display === 'none' ? '' : 'none';
  document.getElementById('comicRTocWrap').classList.remove('show');
}
function renderComicRToc() {
  const box = document.getElementById('comicRToc');
  box.innerHTML = '';
  comicReader.chapters.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'rd-chap' + ((i + 1) === comicReader.idx ? ' active' : '');
    el.innerHTML = `<span class="ct">${(i + 1) + '. ' + comicChapLabel(c, i)}</span><span class="tb" onclick="event.stopPropagation();comicRThumb(${i})" title="缩略图预览">🖼</span>`;
    el.onclick = () => comicLoadEp(i + 1);
    box.appendChild(el);
  });
  const cur = box.querySelector('.rd-chap.active');
  if (cur) cur.scrollIntoView({block: 'center'});
}
// 目录缩略图索引:按话懒加载(仅展开时请求,并发上限 6)
let _thumbQueue = 0;
async function comicRThumb(i) {
  const box = document.getElementById('comicRToc');
  const existing = document.getElementById('rd-thumbs-' + i);
  if (existing) { existing.remove(); return; }
  const ch = comicReader.chapters[i];
  if (!ch) return;
  const grid = document.createElement('div');
  grid.id = 'rd-thumbs-' + i;
  grid.className = 'rd-thumbs';
  grid.innerHTML = '<div style="grid-column:1/-1; font-size:11px; color:var(--muted); padding:4px 0">加载缩略图…</div>';
  box.appendChild(grid);
  try {
    if (_thumbQueue >= 6) { grid.innerHTML = '<div style="grid-column:1/-1; font-size:11px; color:var(--muted)">并发已达上限,稍后重试</div>'; return; }
    _thumbQueue++;
    const j = await api('/api/comic_pages?source=' + encodeURIComponent(comicReader.source)
      + '&comic_id=' + encodeURIComponent(comicReader.comic_id) + '&ep_id=' + encodeURIComponent(ch.id), {silent: true});
    const urls = (j && j.urls) || [];
    grid.innerHTML = urls.slice(0, 12).map((u, k) =>
      `<img loading="lazy" src="/api/comic_img?source=${encodeURIComponent(comicReader.source)}&url=${encodeURIComponent(u)}" title="第 ${k + 1} 页" onclick="comicLoadEp(${i + 1})">`
    ).join('') + (urls.length > 12 ? `<div style="grid-column:1/-1; font-size:11px; color:var(--muted)">…共 ${urls.length} 页</div>` : '');
  } catch (e) {
    grid.innerHTML = '<div style="grid-column:1/-1; font-size:11px; color:var(--muted)">缩略图加载失败</div>';
  } finally { _thumbQueue = Math.max(0, _thumbQueue - 1); }
}
function comicRTocToggle() {
  document.getElementById('comicRTocWrap').classList.toggle('show');
}
function comicReaderFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}
function comicReaderTwoPage() {
  const body = document.getElementById('comicRBody');
  comicReader.twoPage = !comicReader.twoPage;
  body.classList.toggle('two-page', comicReader.twoPage);
  const btn = document.getElementById('comicRTwoBtn');
  if (btn) btn.style.borderColor = comicReader.twoPage ? 'var(--primary)' : '';
  if (comicReader.twoPage) toast('双页模式(宽窗口生效)');
}
function comicSavePos() {
  try {
    const all = JSON.parse(localStorage.getItem(CREAD_KEY) || '{}');
    (all[comicReader.source] = all[comicReader.source] || {})[comicReader.comic_id] = comicReader.idx;
    localStorage.setItem(CREAD_KEY, JSON.stringify(all));
  } catch (e) {}
}
async function comicLoadEp(idx) {
  comicReader.idx = idx;
  const ch = comicReader.chapters[idx - 1];
  document.getElementById('comicRPos').textContent = idx + ' / ' + comicReader.chapters.length;
  renderComicRToc();
  comicSavePos();
  const body = document.getElementById('comicRBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  if (comicReader.twoPage) body.classList.add('two-page');
  document.getElementById('comicRPrev').disabled = idx <= 1;
  document.getElementById('comicRNext').disabled = idx >= comicReader.chapters.length;
  try {
    const j = await api('/api/comic_pages?source=' + encodeURIComponent(comicReader.source)
      + '&comic_id=' + encodeURIComponent(comicReader.comic_id)
      + '&ep_id=' + encodeURIComponent(ch.id));
    if (!j.ok) throw new Error(j.error || '加载失败');
    const urls = j.urls || [];
    if (idx !== comicReader.idx) return;  // 切话竞态:过期响应直接丢弃
    if (!urls.length) { body.innerHTML = '<div class="empty">本话无图片</div>'; return; }
    document.getElementById('comicRPage').textContent = '本话 ' + urls.length + ' 页';
    body.innerHTML = urls.map((u, k) =>
      `<img src="/api/comic_img?source=${encodeURIComponent(comicReader.source)}&url=${encodeURIComponent(u)}" data-page="${k + 1}" data-retry="0" loading="lazy" onclick="event.stopPropagation();openImgZoom(this)" onerror="comicImgErr(this)">`
    ).join('');
    comicWireHud(urls.length);   // 滚动页码 HUD(IntersectionObserver)
    comicApplyZoom();  // 换话后应用持久化屏幕缩放
    comicApplyFit();   // 换话后重算整页适应(高度随缩放折算)
    _comicEpFade();    // 翻页淡入 120ms
    if (comicReader.twoPage) body.classList.add('two-page');
  } catch (e) {
    body.innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '<br><span style="font-size:11px; color:var(--muted)">拷贝漫画等源可能触发风控(210),请稍后重试</span></div>';
  }
}
function comicReaderPrev() { if (comicReader.idx > 1) comicLoadEp(comicReader.idx - 1); }
function comicReaderNext() { if (comicReader.idx < comicReader.chapters.length) comicLoadEp(comicReader.idx + 1); }
/* 滚动页码 HUD:IntersectionObserver 监听图片,滚动时右下角显示「第 X / N 页」(解决页数不直观) */
let _comicHudObs = null;
function comicWireHud(total) {
  const hud = document.getElementById('comicRHud');
  const body = document.getElementById('comicRBody');
  if (!hud || !body) return;
  hud.textContent = '1 / ' + total;
  hud.style.display = 'block';
  if (_comicHudObs) { _comicHudObs.disconnect(); _comicHudObs = null; }
  const visible = new Map();  // page -> intersectionRatio
  _comicHudObs = new IntersectionObserver(entries => {
    for (const en of entries) {
      const pg = parseInt(en.target.dataset.page || '0', 10);
      if (en.isIntersecting) visible.set(pg, en.intersectionRatio);
      else visible.delete(pg);
    }
    if (visible.size) {
      const cur = Math.min(...[...visible.keys()]);  // 最靠上的可见页
      hud.textContent = cur + ' / ' + total;
    }
  }, { root: body, threshold: [0, 0.25, 0.5] });
  body.querySelectorAll('img[data-page]').forEach(im => _comicHudObs.observe(im));
}
/* 单页图片加载失败:自动换参重试 2 次,仍失败显示「点击重试」占位(不再留空缺) */
function comicImgErr(el) {
  const n = parseInt(el.dataset.retry || '0', 10);
  if (n < 2) {
    el.dataset.retry = String(n + 1);
    const sep = el.src.indexOf('&retry=') >= 0 ? '' : '&retry=0';
    el.src = el.src.split('&retry=')[0] + sep + '&retry=' + (n + 1) + '.' + Date.now();
  } else {
    const ph = document.createElement('div');
    ph.className = 'cimg-fail';
    ph.dataset.page = el.dataset.page || '';
    ph.style.cssText = 'min-height:180px; display:flex; align-items:center; justify-content:center;'
      + 'color:var(--muted); font-size:13px; background:var(--secondary); border-radius:8px; margin:4px 0; cursor:pointer;';
    ph.textContent = '第 ' + (el.dataset.page || '?') + ' 页加载失败,点击重试';
    ph.onclick = ev => {
      ev.stopPropagation();
      el.dataset.retry = '0';
      el.src = el.src.split('&retry=')[0] + '&retry=r' + Date.now();
      ph.replaceWith(el);
    };
    el.replaceWith(ph);
  }
}
function comicReaderAdj(d) {
  // 图片级缩放:只缩放漫画图片本身,工具条/布局恒定(持久化)。
  // 适宽模式 → 图片宽度 = 100%*zoom;整页模式 → --cfit 高度按 zoom 折算(comicApplyFit)。
  comicReader.zoom = Math.min(2, Math.max(0.5, Math.round(((comicReader.zoom || 1) + d) * 10) / 10));
  try { localStorage.setItem('novelist_comic_zoom', String(comicReader.zoom)); } catch (e) {}
  comicApplyZoom();
}
/* 漫画阅读器应用持久化 zoom(打开/换话时调用):只作用于图片(--czoom),不再整体缩放布局 */
function comicApplyZoom() {
  comicReader.zoom = parseFloat(localStorage.getItem('novelist_comic_zoom') || '1') || 1;
  const body = document.getElementById('comicRBody');
  if (body) body.style.setProperty('--czoom', String(comicReader.zoom));
  const v = document.getElementById('comicRZoomVal');
  if (v) v.textContent = Math.round(comicReader.zoom * 100) + '%';
}
/* 适应模式(P2):width=满宽(默认) page=整页(单图高度不超可视区,高度按缩放折算) */
function comicApplyFit() {
  const body = document.getElementById('comicRBody');
  if (!body) return;
  const page = localStorage.getItem('novelist_comic_fit') === 'page';
  body.classList.toggle('fit-page', page);
  if (page) {
    const zoom = comicReader.zoom || 1;
    const h = (body.clientHeight || window.innerHeight) / zoom;
    body.style.setProperty('--cfit', Math.max(200, Math.floor(h)) + 'px');
  }
  const w = document.getElementById('comicRFitW'), p = document.getElementById('comicRFitP');
  if (w) w.classList.toggle('on', !page);
  if (p) p.classList.toggle('on', page);
}
function comicFitMode(m) {
  try { localStorage.setItem('novelist_comic_fit', m === 'page' ? 'page' : 'width'); } catch (e) {}
  comicApplyFit();
}
/* 夜读(P2):阅读页纯黑背景;持久化,退出阅读器时摘类避免影响主界面 */
function comicDarkToggle() {
  const on = !document.body.classList.contains('comic-dark');
  document.body.classList.toggle('comic-dark', on);
  try { localStorage.setItem('novelist_comic_dark', on ? '1' : '0'); } catch (e) {}
  const btn = document.getElementById('comicRDark');
  if (btn) btn.classList.toggle('on', on);
}
function comicApplyDark() {
  const on = localStorage.getItem('novelist_comic_dark') === '1';
  document.body.classList.toggle('comic-dark', on);
  const btn = document.getElementById('comicRDark');
  if (btn) btn.classList.toggle('on', on);
}
/* 翻页淡入(P2):重启动画(移除→强制 reflow→加回) */
function _comicEpFade() {
  const body = document.getElementById('comicRBody');
  body.classList.remove('ep-fade');
  void body.offsetWidth;
  body.classList.add('ep-fade');
}

let readerFile = null;  // 本地阅读模式:txt/epub 文件路径
let readerUrl = null;   // 在线阅读模式:书籍 URL(未下载的书走在线流式抓取)
let readerEpubUrl = null;  // EPUB 在线模式:远程 EPUB 直链(OPDS 在线阅读,不落盘)
let readerChapters = [];
let readerIdx = 1;
const READ_KEY = 'novelist_reading_progress';
const READ_POS_KEY = 'novelist_reading_scroll';   // {file: {idx, top}} 章节内滚动位置记忆
const LAYOUT_KEY = 'novelist_reader_layout';   // {fs, lh, ff, w} 排版持久化
const PAPER_KEY = 'novelist_paper';            // 纸张主题: paper/green/sepia/night
// 阅读字体库:名字 → CSS font-family(等线 DengXian 等 Windows 自带字体)
const READER_FONTS = {
  songti:  {name: '宋体',  css: '"Georgia", "STSong", "SimSun", serif'},
  kaiti:   {name: '楷体',  css: '"KaiTi", "STKaiti", "楷体", serif'},
  heiti:   {name: '黑体',  css: '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif'},
  dengxian:{name: '等线',  css: '"DengXian", "Microsoft YaHei", sans-serif'},
  yuanti:  {name: '圆体',  css: '"Yuanti SC", "YouYuan", "幼圆", sans-serif'},
  fangsong:{name: '仿宋',  css: '"FangSong", "STFangsong", "仿宋", serif'},
};
// 系统字体库探测:候选池仅列出本机"已安装"的字体,动态追加进 READER_FONTS(不覆盖内置)
// 注:宋体/楷体/黑体/仿宋/圆体已由内置项覆盖,这里只补充系统特有的字体
(function detectSysFonts() {
  const cands = [
    {key:'yahei',    name:'微软雅黑',  css:'"Microsoft YaHei","微软雅黑",sans-serif', probe:'Microsoft YaHei'},
    {key:'pingfang', name:'苹方',      css:'"PingFang SC","苹方",sans-serif',           probe:'PingFang SC'},
    {key:'lisu',     name:'隶书',      css:'"LiSu","隶书",serif',                       probe:'LiSu'},
    {key:'notosans', name:'思源黑体',  css:'"Noto Sans SC","Source Han Sans SC",sans-serif', probe:'Noto Sans SC'},
    {key:'notoserif',name:'思源宋体',  css:'"Noto Serif SC","Source Han Serif SC",serif',     probe:'Noto Serif SC'},
    {key:'lxgw',     name:'霞鹜文楷',  css:'"LXGW WenKai","霞鹜文楷",serif',            probe:'LXGW WenKai'},
  ];
  try {
    if (!document.fonts || !document.fonts.check) return;
    cands.forEach(f => {
      try {
        if (document.fonts.check('16px "' + f.probe + '", serif')) {
          if (!READER_FONTS[f.key]) READER_FONTS[f.key] = {name: f.name, css: f.css};
        }
      } catch (e) { /* 单个探测失败不影响其它 */ }
    });
  } catch (e) { /* 环境不支持字体探测时静默 */ }
})();
function _loadLayout() {
  try { return Object.assign({fs: 17, lh: 2.05, ff: 'songti'}, JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')); }
  catch (e) { return {fs: 17, lh: 2.05, ff: 'songti'}; }
}
function _saveLayout(obj) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(obj || _loadLayout())); } catch (e) {} }
let readerFont = _loadLayout().fs;
/* 屏幕缩放(整页 zoom,作用于正文滚动区;与字号 A-/A+ 独立) */
let readerZoom = parseFloat(localStorage.getItem('novelist_reader_zoom') || '1');
function applyReaderZoom() {
  const main = document.getElementById('readerMain');
  if (main) main.style.zoom = String(readerZoom);
  const v = document.getElementById('readerZoomVal');
  if (v) v.textContent = Math.round(readerZoom * 100) + '%';
}
function readerZoomAdj(d) {
  readerZoom = Math.min(2, Math.max(0.6, Math.round((readerZoom + d) * 10) / 10));
  try { localStorage.setItem('novelist_reader_zoom', String(readerZoom)); } catch (e) {}
  applyReaderZoom();
}
function applyReaderLayout() {
  const L = _loadLayout();
  const body = document.getElementById('readerBody');
  if (!body) return;
  body.style.fontSize = L.fs + 'px';
  body.style.lineHeight = String(L.lh);
  body.style.maxWidth = ([720, 880, 1080].includes(L.w) ? L.w : 880) + 'px';
  const f = READER_FONTS[L.ff] || READER_FONTS.songti;
  body.style.setProperty('--reader-font', f.css);  // 经 CSS 变量生效,!important 仍能压制 EPUB 内联字体
  applyReaderPaper();
  // 同步字体按钮文案
  const btn = document.getElementById('readerFontBtn');
  if (btn) btn.textContent = '文 ' + f.name;
}
function readerFontPick(ff) {
  const L = _loadLayout();
  L.ff = ff || 'songti';
  _saveLayout(L);  // 必须传入修改后的对象:无参版会重读旧值覆盖修改(字体切换不生效的根因)
  applyReaderLayout();
}

async function openReader(file, goIdx) {
  readerFile = file;
  readerUrl = null;
  readerEpubUrl = null;
  document.body.classList.add('novel-reading');  // 全屏沉浸模式(隐藏顶栏/侧边栏)
  document.body.classList.add('ui-hidden');     // 默认隐藏工具栏/目录(纯沉浸)
  document.body.classList.add('ui-hint');      // 首次提示"点击唤起"
  _refreshBgTaskFlag();
  _wireReaderScrollSave();   // 绑定滚动位置记忆
  document.getElementById('readerMask').classList.add('show');
  document.getElementById('readerTitle').textContent = file;
  document.getElementById('readerBody').innerHTML = '<div class="empty">加载目录中…</div>';
  document.onkeydown = e => {
    if (e.key === 'Escape') closeReader();
    else if (e.key === 'ArrowLeft') readerPrev();
    else if (e.key === 'ArrowRight') readerNext();
  };
  try {
    const isEpub = file.toLowerCase().endsWith('.epub');
    const m = await api((isEpub ? '/api/epub_meta?file=' : '/api/read_meta?file=') + encodeURIComponent(file));
    readerChapters = m.chapters || [];
    let saved = 1;
    try { saved = JSON.parse(localStorage.getItem(READ_KEY) || '{}')[file] || 1; } catch (e) {}
    if (goIdx) saved = goIdx;
    readerIdx = Math.min(Math.max(1, saved), Math.max(1, readerChapters.length));
    renderChapterList();
    loadReaderNotes();   // 加载该书书签与笔记
    loadChapter(readerIdx);
  } catch (e) {
    document.getElementById('readerBody').innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
  }
}
/* 在线阅读:书架上未下载的书直接拉章节正文(在线流式,不落盘)。复用阅读器 UI */
async function openReaderOnline(url, title, goIdx) {
  readerUrl = url;
  readerFile = null;
  readerEpubUrl = null;
  document.body.classList.add('novel-reading');  // 全屏沉浸模式
  document.body.classList.add('ui-hidden');     // 默认隐藏工具栏
  document.body.classList.add('ui-hint');      // 首次提示
  _refreshBgTaskFlag();
  _wireReaderScrollSave();   // 绑定滚动位置记忆
  document.getElementById('readerMask').classList.add('show');
  document.getElementById('readerTitle').textContent = title || '在线阅读';
  document.getElementById('readerBody').innerHTML = '<div class="empty">在线加载目录中…</div>';
  document.onkeydown = e => {
    if (e.key === 'Escape') closeReader();
    else if (e.key === 'ArrowLeft') readerPrev();
    else if (e.key === 'ArrowRight') readerNext();
  };
  try {
    const m = await api('/api/book?url=' + encodeURIComponent(url));
    readerChapters = (m.toc || []).map((c, i) => ({idx: i + 1, title: c.title || ('第' + (i + 1) + '章')}));
    let saved = 1;
    try { saved = JSON.parse(localStorage.getItem(READ_KEY) || '{}')[url] || 1; } catch (e) {}
    if (goIdx) saved = goIdx;
    readerIdx = Math.min(Math.max(1, saved), Math.max(1, readerChapters.length));
    renderChapterList();
    loadReaderNotes();
    loadChapter(readerIdx);
  } catch (e) {
    document.getElementById('readerBody').innerHTML = `<div class="empty">在线目录加载失败: ${esc(e.message)}</div>`;
  }
}
/* OPDS EPUB 在线阅读:直读远程 EPUB 直链,不落盘(章节/插图走 /api/epub_online*) */
async function openEpubOnline(url, title) {
  readerEpubUrl = url;
  readerUrl = null;
  readerFile = null;
  document.body.classList.add('novel-reading');
  document.body.classList.add('ui-hidden');
  document.body.classList.add('ui-hint');
  _refreshBgTaskFlag();
  _wireReaderScrollSave();
  document.getElementById('readerMask').classList.add('show');
  document.getElementById('readerTitle').textContent = title || 'EPUB 在线阅读';
  document.getElementById('readerBody').innerHTML = '<div class="empty">EPUB 在线加载目录中…</div>';
  document.onkeydown = e => {
    if (e.key === 'Escape') closeReader();
    else if (e.key === 'ArrowLeft') readerPrev();
    else if (e.key === 'ArrowRight') readerNext();
  };
  try {
    // 大 EPUB(几十 MB)下载可能较慢:超时放宽到 180s,并提示用户
    document.getElementById('readerBody').innerHTML = '<div class="empty">EPUB 正在下载中…(文件较大时需数十秒,请稍候)</div>';
    const m = await api('/api/epub_online?url=' + encodeURIComponent(url), {silent: true}, 180000);
    if (!m.ok) throw new Error(m.error || 'EPUB 解析失败');
    readerChapters = (m.chapters || []).map((c, i) => ({idx: i + 1, title: c.title || ('第' + (i + 1) + '章')}));
    if (!readerChapters.length) { document.getElementById('readerBody').innerHTML = '<div class="empty">EPUB 无章节内容</div>'; return; }
    let saved = 1;
    try { saved = JSON.parse(localStorage.getItem(READ_KEY) || '{}')[url] || 1; } catch (e) {}
    readerIdx = Math.min(Math.max(1, saved), readerChapters.length);
    renderChapterList();
    loadReaderNotes();
    loadChapter(readerIdx);
  } catch (e) {
    document.getElementById('readerBody').innerHTML = `<div class="empty">EPUB 在线加载失败: ${esc(e.message)}<br><span style="font-size:12px; color:var(--muted)">可尝试改用「下载 EPUB」后本地阅读,或稍后重试</span></div>`;
  }
}
function closeReader() {
  document.getElementById('readerMask').classList.remove('show');
  document.body.classList.remove('novel-reading');  // 退出全屏
  document.body.classList.remove('has-bg-task');   // 同步清除后台任务标记
  document.body.classList.remove('ui-hint');        // 退出时清提示
  closeReaderToc();                                 // 关闭目录抽屉
  document.onkeydown = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();  // 关闭阅读器停止朗读
  _speaking = false;
  const sb = document.getElementById('btnSpeak');
  if (sb) { sb.textContent = '🔊'; sb.style.color = ''; }
  // 退出时清空阅读模式标记(避免下次错用)
  // readerFile / readerUrl 由下次 openReader/openReaderOnline 重设
  readerEpubUrl = null;  // EPUB 在线模式仅在本次阅读会话有效
}
/* 全屏阅读时,若用户开启了后台下载任务 → 加 .has-bg-task 类,任务按钮仍可见 */
function _refreshBgTaskFlag() {
  const has = [..._dlTasks.values()].some(t => t.state === 'running' || t.state === 'downloading' || t.state === 'paused');
  document.body.classList.toggle('has-bg-task', has);
}
/* 小说阅读器:点击正文切换 UI 显隐(仿漫画沉浸);工具栏/目录内点击不触发 */
function _wireReaderUiToggle() {
  const mask = document.getElementById('readerMask');
  if (!mask || mask._uiToggleBound) return;
  mask._uiToggleBound = true;
  mask.addEventListener('click', (ev) => {
    if (ev.target.closest('.reader-hd, .reader-bar, .reader-toc, .reader-toc-mask')) return;
    const hidden = document.body.classList.toggle('ui-hidden');
    // 首次点出工具栏后去掉提示
    if (!hidden) document.body.classList.remove('ui-hint');
  });
}
/* 章节滚动位置记忆:按章节独立保存(切章回跳仍恢复原位置),滚动节流写入 */
function _wireReaderScrollSave() {
  const main = document.getElementById('readerMain');
  if (!main || main._scrollBound) return;
  main._scrollBound = true;
  let t = null;
  main.addEventListener('scroll', () => {
    _updateReaderProg();
    clearTimeout(t);
    t = setTimeout(() => {
      if (!document.getElementById('readerMask').classList.contains('show')) return;
      const key = readerUrl || readerFile;
      if (!key) return;
      try {
        const all = JSON.parse(localStorage.getItem(READ_POS_KEY) || '{}');
        const m = all[key] || {};
        m[readerIdx] = main.scrollTop;
        all[key] = m;
        localStorage.setItem(READ_POS_KEY, JSON.stringify(all));
      } catch (e) {}
    }, 250);
  });
}
/* 目录抽屉开关 */
function toggleReaderToc() {
  const toc = document.getElementById('readerToc');
  const mask = document.getElementById('readerTocMask');
  const open = !toc.classList.contains('show');
  toc.classList.toggle('show', open);
  mask.classList.toggle('show', open);
  document.body.classList.remove('ui-hidden');  // 打开目录时保证工具栏可见
  if (open) {
    const cur = toc.querySelector('.toc-item.active');
    if (cur) cur.scrollIntoView({block: 'center'});
  }
}
function closeReaderToc() {
  document.getElementById('readerToc').classList.remove('show');
  document.getElementById('readerTocMask').classList.remove('show');
}
/* 等章节图片加载完成后滚动到锚点(替代固定延时,图多时定位准确) */
function _waitImagesThenScroll(hash, timeoutMs) {
  const body = document.getElementById('readerBody');
  if (!body) return;
  const find = () => {
    try { return body.querySelector('[id="' + CSS.escape(hash) + '"]'); } catch (e) { return null; }
  };
  const imgs = body.querySelectorAll('img');
  if (!imgs.length) {
    const el = find();
    if (el) el.scrollIntoView({block: 'center'});
    return;
  }
  const t0 = Date.now();
  const tick = () => {
    const done = [...imgs].every(i => i.complete);
    if (done || Date.now() - t0 > (timeoutMs || 2000)) {
      const el = find();
      if (el) el.scrollIntoView({block: 'center'});
    } else {
      setTimeout(tick, 80);
    }
  };
  tick();
}
function renderChapterList() {
  const box = document.getElementById('readerToc');
  box.innerHTML = '';
  let lastVol = '';
  readerChapters.forEach(c => {
    const vol = (c.volume || '').trim();
    if (vol && vol !== lastVol) {
      const vd = document.createElement('div');
      vd.className = 'toc-vol';
      vd.textContent = vol;
      box.appendChild(vd);
      lastVol = vol;
    }
    const el = document.createElement('div');
    el.className = 'toc-item' + (c.idx === readerIdx ? ' active' : '');
    el.textContent = c.idx + '. ' + c.title;
    el.onclick = () => { readerIdx = c.idx; loadChapter(c.idx); closeReaderToc(); };
    box.appendChild(el);
  });
  const cur = box.querySelector('.toc-item.active');
  if (cur) cur.scrollIntoView({block: 'center'});
}
async function loadChapter(idx) {
  readerIdx = idx;
  try {
    let ch;
    let isEpub = false;
    if (readerEpubUrl) {
      // EPUB 在线(OPDS 直链):后端直读远程文件,不落盘
      isEpub = true;
      ch = await api('/api/epub_online_read?url=' + encodeURIComponent(readerEpubUrl) + '&ch=' + idx);
    } else if (readerUrl) {
      ch = await api('/api/online_read?url=' + encodeURIComponent(readerUrl) + '&ch=' + idx);
    } else {
      isEpub = readerFile.toLowerCase().endsWith('.epub');
      ch = await api((isEpub ? '/api/epub_read?file=' : '/api/read?file=') + encodeURIComponent(readerFile) + '&ch=' + idx);
    }
    if (idx !== readerIdx) return;  // 切章竞态:过期响应直接丢弃,避免旧章节覆盖新章节
    document.getElementById('readerChapterTitle').textContent = ch.title || ('第' + idx + '章');
    const body = document.getElementById('readerBody');
    body.classList.remove('epub-html');
    applyReaderLayout();  // 应用持久化的字号/行距/字体
    applyReaderZoom();    // 应用持久化的屏幕缩放
    if (isEpub && ch.html) {
      // EPUB 保留结构(含 <img> 插图/表格/音视频),资源走 /api/epub_asset
      body.classList.add('epub-html');  // 布局约束(压制内嵌 style/宽表格/float 撑破)
      body.innerHTML = ch.html;
      // 清除 EPUB 内联字体样式,让阅读器统一字体设置生效
      body.querySelectorAll('[style*="font-family"]').forEach(el => {
        el.style.fontFamily = '';
      });
      // 压制 EPUB 内嵌 <style>/class 级 font-family(仅清内联不够:样式表规则
      // 优先级更高,仍会把正文顶回宋体)。注入一次性覆盖规则,所有层级强制
      // 使用阅读器 --reader-font(CSS 变量可继承,切换字体即时生效)。
      if (!document.getElementById('epubFontOverride')) {
        const _st = document.createElement('style');
        _st.id = 'epubFontOverride';
        _st.textContent = '#readerBody, #readerBody * { font-family: var(--reader-font) !important; }';
        document.head.appendChild(_st);
      }
      // 内部锚点跳转(脚注/目录链接):处理 # 开头且页内存在的 id
      body.querySelectorAll('a[href^="#"]').forEach(a => {
        const target = decodeURIComponent(a.getAttribute('href').slice(1));
        a.onclick = (ev) => {
          const el = body.querySelector('[id="' + CSS.escape(target) + '"]');
          if (el) { ev.preventDefault(); el.scrollIntoView({block: 'center'}); }
        };
      });
      // 跨章节链接跳转(EPUB 内 <a href="chap2.xhtml#id"> → 跳到对应章节)
      body.querySelectorAll('a[data-epub-chap]').forEach(a => {
        const targetPath = decodeURIComponent(a.getAttribute('data-epub-chap'));
        const hash = (a.getAttribute('href') || '').split('#')[1] || '';
        a.onclick = (ev) => {
          ev.preventDefault();
          const targetIdx = (readerChapters || []).findIndex(c => c.path === targetPath);
          if (targetIdx >= 0) {
            jumpReaderChapter(targetIdx + 1, hash);
          } else {
            // 后端只返回了 html 没带 path 时,尝试按文件名匹配
            const baseName = targetPath.split('/').pop();
            const i2 = (readerChapters || []).findIndex(c => (c.path || '').split('/').pop() === baseName);
            if (i2 >= 0) jumpReaderChapter(i2 + 1, hash);
            else toast('目标章节未找到');
          }
        };
      });
      // 插图:点击放大查看(可复制)
      body.querySelectorAll('img').forEach(img => { img.onclick = (ev) => { ev.stopPropagation(); openImgZoom(img); }; });
    } else {
      // TXT: 用 <p> 渲染(双倍行距 + 段落缩进,统一阅读体验)
      body.innerHTML = (ch.text || '(本章为空)').split(/\n+/).map(ps => '<p>' + esc(ps) + '</p>').join('');
    }
    const main = document.getElementById('readerMain');
    if (main) main.scrollTop = 0;
    try {
      const key = readerUrl || readerFile;
      const p = JSON.parse(localStorage.getItem(READ_KEY) || '{}');
      if (key) p[key] = idx;
      localStorage.setItem(READ_KEY, JSON.stringify(p));
    } catch (e) {}
    // 恢复本章滚动位置(按章记忆,仅在保存过本章位置时恢复)
    try {
      const key = readerUrl || readerFile;
      const m = key ? (JSON.parse(localStorage.getItem(READ_POS_KEY) || '{}')[key] || null) : null;
      const top = m ? (m[idx] || 0) : 0;
      if (top > 0 && main) {
        requestAnimationFrame(() => { if (main.scrollHeight > top) main.scrollTop = top; });
      }
    } catch (e) {}
    document.getElementById('btnPrev').disabled = idx <= 1;
    document.getElementById('btnNext').disabled = idx >= readerChapters.length;
    document.getElementById('readerPos').textContent = `${idx} / ${readerChapters.length}`;
    _updateBookmarkBtn();          // 刷新书签按钮状态
    if (_speaking) { speechSynthesis.cancel(); _speaking = false; const sb = document.getElementById('btnSpeak'); if (sb) { sb.textContent = '🔊'; sb.style.color = ''; } }  // 切章停止朗读
    document.querySelectorAll('.toc-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.textContent) === idx);
    });
  } catch (e) { toast('章节加载失败: ' + e.message); }
}
function readerPrev() { if (readerIdx > 1) loadChapter(readerIdx - 1); }
function readerNext() { if (readerIdx < readerChapters.length) loadChapter(readerIdx + 1); }

/* ================== 书签与划词笔记 ================== */
let _readerNotes = null;   // 当前书 {bookmarks, notes} 缓存
let _noteSelText = '';     // 划词待保存的原文
function _notesKey() { return readerUrl || readerFile || '未知书'; }
async function loadReaderNotes() {
  try {
    _readerNotes = await api('/api/notes?key=' + encodeURIComponent(_notesKey()));
    _updateBookmarkBtn();
  } catch (e) { _readerNotes = null; }
}
function _updateBookmarkBtn() {
  const btn = document.getElementById('btnBookmark');
  if (!btn) return;
  const marked = _readerNotes && (_readerNotes.bookmarks || []).includes(readerIdx);
  btn.textContent = marked ? '★' : '☆';
  btn.style.color = marked ? 'var(--warn)' : '';
  btn.title = marked ? '取消书签' : '书签(收藏本章)';
}
async function readerBookmarkToggle() {
  if (!readerFile) return;
  try {
    const j = await api('/api/notes', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: _notesKey(), action: 'bookmark_toggle', ch: readerIdx})
    });
    if (_readerNotes) _readerNotes.bookmarks = j.bookmarks;
    _updateBookmarkBtn();
    toast(j.bookmarked ? `已添加书签:第 ${readerIdx} 章` : `已取消书签:第 ${readerIdx} 章`);
  } catch (e) { toast('书签操作失败: ' + e.message); }
}
function showReaderNotes() {
  if (!readerFile) return;
  document.getElementById('notesTitle').textContent = readerFile;
  const box = document.getElementById('notesBody');
  const marks = (_readerNotes && _readerNotes.bookmarks) || [];
  const notes = (_readerNotes && _readerNotes.notes) || [];
  if (!marks.length && !notes.length) {
    box.innerHTML = '<div class="empty" style="padding:20px">暂无书签与笔记<br>阅读时点 ★ 收藏章节,划选文字可添加笔记</div>';
  } else {
    let h = '';
    if (marks.length) {
      h += '<div style="font-size:12px; font-weight:600; color:var(--muted); margin:6px 0">📌 书签(' + marks.length + ')</div>';
      h += marks.map(ch => {
        const t = readerChapters[ch - 1] ? readerChapters[ch - 1].title : ('第' + ch + '章');
        return `<div class="shelf-row" style="cursor:pointer" onclick="jumpReaderChapter(${ch})"><div class="sinfo"><div class="stitle">★ ${esc(t)}</div></div><div class="sops"><button class="btn-sm" onclick="event.stopPropagation();readerBookmarkDel(${ch})">移除</button></div></div>`;
      }).join('');
    }
    if (notes.length) {
      h += '<div style="font-size:12px; font-weight:600; color:var(--muted); margin:10px 0 6px">✏️ 笔记(' + notes.length + ')</div>';
      h += notes.slice().reverse().map(n => {
        const t = readerChapters[n.ch - 1] ? readerChapters[n.ch - 1].title : ('第' + n.ch + '章');
        return `<div class="shelf-row" style="cursor:pointer; align-items:flex-start" onclick="jumpReaderChapter(${n.ch})">
          <div class="sinfo" style="flex:1; min-width:0">
            <div class="stitle">✏️ ${esc(t)} · ${new Date(n.ts * 1000).toLocaleDateString()}</div>
            ${n.quote ? `<div style="font-size:11px; color:var(--muted); border-left:2px solid var(--primary); padding-left:6px; margin:4px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(n.quote)}</div>` : ''}
            <div style="font-size:13px; color:var(--text); margin-top:2px">${esc(n.text)}</div>
          </div>
          <div class="sops"><button class="btn-sm" onclick="event.stopPropagation();readerNoteDel('${n.id}')">删除</button></div>
        </div>`;
      }).join('');
    }
    box.innerHTML = h;
  }
  document.getElementById('notesMask').classList.add('show');
}
function closeReaderNotes() { document.getElementById('notesMask').classList.remove('show'); }
function jumpReaderChapter(ch, hash) {
  closeReaderNotes();
  const doJump = () => {
    loadChapter(ch);
    if (hash) {
      // 等章节加载 + 图片加载完成后滚动到锚点(图多时定位准确)
      _waitImagesThenScroll(hash, 2500);
    }
  };
  if (readerIdx === ch && hash) {
    // 当前章节内跳锚点
    const body = document.getElementById('readerBody');
    try { const el = body.querySelector('[id="' + CSS.escape(hash) + '"]'); if (el) el.scrollIntoView({block: 'center'}); return; } catch (e) {}
  }
  doJump();
}
async function readerBookmarkDel(ch) {
  try {
    const j = await api('/api/notes', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: _notesKey(), action: 'bookmark_toggle', ch})});
    if (_readerNotes) _readerNotes.bookmarks = j.bookmarks;
    showReaderNotes(); _updateBookmarkBtn();
  } catch (e) { toast('操作失败: ' + e.message); }
}
async function readerNoteDel(id) {
  try {
    const j = await api('/api/notes', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: _notesKey(), action: 'note_del', id})});
    if (_readerNotes) _readerNotes.notes = j.notes;
    showReaderNotes();
  } catch (e) { toast('操作失败: ' + e.message); }
}
// 划词 → 添加笔记
function openNoteAdd(quote, ch) {
  _noteSelText = quote || '';
  document.getElementById('noteQuote').textContent = (quote ? '「' + quote + '」' : '');
  document.getElementById('noteText').value = '';
  document.getElementById('noteText').dataset.ch = ch;
  document.getElementById('noteAddMask').classList.add('show');
  setTimeout(() => document.getElementById('noteText').focus(), 100);
}
function closeNoteAdd() { document.getElementById('noteAddMask').classList.remove('show'); }
async function saveNoteAdd() {
  const text = document.getElementById('noteText').value.trim();
  const ch = parseInt(document.getElementById('noteText').dataset.ch || readerIdx, 10);
  if (!text) { toast('笔记内容不能为空'); return; }
  try {
    const j = await api('/api/notes', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: _notesKey(), action: 'note_add', ch, text, quote: _noteSelText})});
    if (_readerNotes) _readerNotes.notes = j.notes;
    closeNoteAdd();
    toast('笔记已保存');
  } catch (e) { toast('保存失败: ' + e.message); }
}
// 划词检测(reader-body 内选中文本)
document.addEventListener('mouseup', (ev) => {
  const body = document.getElementById('readerBody');
  if (!body || !body.contains(ev.target) || document.getElementById('readerMask').classList.contains('show') === false) return;
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (text.length >= 2 && text.length <= 300) {
    openNoteAdd(text, readerIdx);
  }
});

/* ================== TTS 朗读(Web Speech API) ================== */
let _speaking = false;
function _pickZhVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  return voices.find(v => /zh[-_]CN/i.test(v.lang) && /Huihui|Yaoyao|Xiaoxiao|Yunxi|Xiaoyi|kangkang|Meijia/i.test(v.name))
      || voices.find(v => /zh/i.test(v.lang)) || voices[0];
}
function toggleReaderSpeak() {
  if (!('speechSynthesis' in window)) { toast('当前环境不支持朗读'); return; }
  const btn = document.getElementById('btnSpeak');
  if (_speaking) {
    speechSynthesis.cancel();
    _speaking = false;
    btn.textContent = '🔊'; btn.style.color = '';
    return;
  }
  const text = document.getElementById('readerBody').innerText || '';
  const plain = text.replace(/\n{2,}/g, '\n').slice(0, 8000);
  if (!plain.trim()) { toast('本章暂无内容可朗读'); return; }
  const u = new SpeechSynthesisUtterance(plain);
  const v = _pickZhVoice();
  if (v) u.voice = v;
  u.lang = (v && v.lang) || 'zh-CN';
  u.rate = 1.0;
  u.onend = u.onerror = () => { _speaking = false; btn.textContent = '🔊'; btn.style.color = ''; };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  _speaking = true;
  btn.textContent = '⏹'; btn.style.color = 'var(--danger)';
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();  // 预加载语音列表

/* ================== 阅读器图片查看/复制 ================== */
let _imgZoomUrl = '';
let _imgZoomScale = 0;  // 0=按需计算,>0=当前缩放倍数
function openImgZoom(img) {
  _imgZoomUrl = img.currentSrc || img.src || '';
  const big = document.getElementById('imgZoomSrc');
  big.onload = () => { _imgZoomScale = 0; imgZoomFit(); };
  big.onerror = () => { big.style.width = ''; };
  big.src = _imgZoomUrl;
  document.getElementById('imgZoomMask').classList.add('show');
}
function closeImgZoom() { document.getElementById('imgZoomMask').classList.remove('show'); }
function imgZoomApply() {
  const img = document.getElementById('imgZoomSrc');
  img.style.width = Math.round((img.naturalWidth || 0) * _imgZoomScale) + 'px';
  img.style.height = 'auto';
  const pct = document.getElementById('imgZoomPct');
  if (pct) pct.textContent = Math.round(_imgZoomScale * 100) + '%';
}
function imgZoomScale(d) {
  if (!_imgZoomScale) _imgZoomScale = 1;
  _imgZoomScale = Math.min(8, Math.max(0.1, Math.round((_imgZoomScale + (d > 0 ? 0.25 : -0.25)) * 100) / 100));
  imgZoomApply();
}
function imgZoom100() { _imgZoomScale = 1; imgZoomApply(); }
function imgZoomFit() {
  const wrap = document.getElementById('imgZoomWrap');
  const img = document.getElementById('imgZoomSrc');
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh || !wrap) return;
  _imgZoomScale = Math.min(1, wrap.clientWidth / nw, wrap.clientHeight / nh);
  if (_imgZoomScale < 0.05) _imgZoomScale = 0.05;
  imgZoomApply();
}
// Ctrl/Cmd+滚轮 缩放大图;普通滚轮在容器内滚动查看(长图/横图细节)
document.addEventListener('wheel', (ev) => {
  if (!document.getElementById('imgZoomMask').classList.contains('show')) return;
  if (!(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  if (!_imgZoomScale) _imgZoomScale = 1;
  _imgZoomScale = Math.min(8, Math.max(0.1, Math.round((_imgZoomScale + (ev.deltaY < 0 ? 0.2 : -0.2)) * 100) / 100));
  imgZoomApply();
}, {passive: false});
// 双击切换 适应 ↔ 100%
document.getElementById('imgZoomWrap').addEventListener('dblclick', () => {
  if (!_imgZoomScale || _imgZoomScale < 0.99) imgZoom100(); else imgZoomFit();
});
function openImgZoomSrc() { window.open(_imgZoomUrl, '_blank'); }
async function copyImgZoom() {
  const src = _imgZoomUrl;
  if (!src) return;
  try {
    const blob = await fetch(src).then(r => r.blob());
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
    toast('图片已复制到剪贴板');
  } catch (e) {
    // 降级:canvas 重绘后复制(同源 /api/* 资源无污染)
    try {
      const c = document.createElement('canvas');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(async b => {
        try { await navigator.clipboard.write([new ClipboardItem({'image/png': b})]); toast('图片已复制到剪贴板'); }
        catch (e2) { toast('复制失败(浏览器权限限制)'); }
      }, 'image/png');
    } catch (e3) { toast('复制失败: ' + e3.message); }
  }
}
// Esc 关闭图片查看(优先于阅读器关闭;图片打开时按 Esc 只关图片)
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.getElementById('imgZoomMask').classList.contains('show')) {
    ev.stopImmediatePropagation();  // 阻止阅读器的 Esc 关闭,先关图片
    closeImgZoom();
  }
});
function readerFontAdj(delta) {
  const L = _loadLayout();
  L.fs = Math.min(28, Math.max(13, (L.fs || 17) + delta));
  _saveLayout(L);
  readerFont = L.fs;
  applyReaderLayout();
}
function readerLineAdj() {  // 行距循环:1.6 / 1.9 / 2.2
  const L = _loadLayout();
  const seq = [1.6, 1.9, 2.2];
  const i = seq.indexOf(L.lh || 2.05);
  L.lh = seq[(i + 1) % seq.length];
  _saveLayout(L);
  applyReaderLayout();
}
function readerFontToggle() {  // 兼容旧调用
  showReaderFonts();
}
function _loadPaper() {
  const p = localStorage.getItem(PAPER_KEY);
  return ['paper', 'green', 'sepia', 'night'].includes(p) ? p : 'paper';
}
function applyReaderPaper() {
  const body = document.getElementById('readerBody');
  if (!body) return;
  const p = _loadPaper();
  if (p === 'paper') body.removeAttribute('data-paper');
  else body.setAttribute('data-paper', p);
}
function readerPaperPick(p) {
  try { localStorage.setItem(PAPER_KEY, p); } catch (e) {}
  applyReaderPaper();
  showReaderLayout();  // 重渲染弹层以刷新选中态
}
function readerWidthPick(w) {
  const L = _loadLayout();
  L.w = w;
  _saveLayout(L);  // 必须传入修改后的对象,否则重读旧值覆盖修改
  applyReaderLayout();
  showReaderLayout();
}
/* 章内进度条:scroll 事件里即时刷新,宽度 = scrollTop / 可滚动余量 */
function _updateReaderProg() {
  const main = document.getElementById('readerMain');
  const fill = document.getElementById('readerProgFill');
  if (!main || !fill) return;
  const max = main.scrollHeight - main.clientHeight;
  const pct = max > 0 ? Math.min(100, Math.max(0, main.scrollTop / max * 100)) : 0;
  fill.style.width = pct + '%';
}
function showReaderLayout() {  // 纸张主题 + 版心宽度弹层(复用字体弹层模式)
  let mask = document.getElementById('layoutPickMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'layoutPickMask';
    mask.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.3); z-index:var(--z-notify); display:none; align-items:center; justify-content:center;';
    mask.onclick = (e) => { if (e.target === mask) mask.style.display = 'none'; };
    document.body.appendChild(mask);
  }
  const curPaper = _loadPaper();
  const curW = _loadLayout().w || 880;
  const papers = [['paper', '纸白', '#ffffff'], ['green', '护眼绿', '#c7edcc'], ['sepia', '羊皮纸', '#f4ecd8'], ['night', '暗夜', '#1c1c1e']];
  const widths = [[720, '窄 720'], [880, '中 880'], [1080, '宽 1080']];
  const chip = (on) => 'flex:1; padding:8px 0; border-radius:8px; border:1px solid var(--border); cursor:pointer; font-size:12px; font-family:inherit; ' +
    (on ? 'background:var(--primary-50); border-color:var(--primary); color:var(--primary); font-weight:600;' : 'background:transparent; color:var(--text);');
  mask.innerHTML = '<div style="background:var(--card); border-radius:14px; padding:16px 18px; box-shadow:var(--shadow-lg); min-width:260px" onclick="event.stopPropagation()">'
    + '<div style="font-weight:600; font-size:13px; margin-bottom:10px">纸张主题</div>'
    + '<div style="display:flex; gap:6px; margin-bottom:14px">'
    + papers.map(([k, n, c]) => '<button onclick="readerPaperPick(\'' + k + '\')" style="' + chip(k === curPaper) + '">'
        + '<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:' + c + '; margin-right:5px; vertical-align:-1px; border:0.5px solid rgba(0,0,0,.2)"></span>' + n + '</button>').join('')
    + '</div>'
    + '<div style="font-weight:600; font-size:13px; margin-bottom:10px">版心宽度</div>'
    + '<div style="display:flex; gap:6px">'
    + widths.map(([w, n]) => '<button onclick="readerWidthPick(' + w + ')" style="' + chip(w === curW) + '">' + n + '</button>').join('')
    + '</div>'
    + '</div>';
  mask.style.display = 'flex';
}
function showReaderFonts() {  // 字体选择弹层
  let mask = document.getElementById('fontPickMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'fontPickMask';
    mask.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.3); z-index:var(--z-notify); display:none; align-items:center; justify-content:center;';
    mask.onclick = (e) => { if (e.target === mask) mask.style.display = 'none'; };
    document.body.appendChild(mask);
  }
  const cur = _loadLayout().ff;
  mask.innerHTML = '<div style="background:var(--card); border-radius:14px; padding:16px 18px; box-shadow:var(--shadow-lg); min-width:220px" onclick="event.stopPropagation()">'
    + '<div style="font-weight:600; font-size:13px; margin-bottom:10px">选择阅读字体</div>'
    + Object.entries(READER_FONTS).map(([k, v]) =>
        '<div onclick="readerFontPick(\'' + k + '\');document.getElementById(\'fontPickMask\').style.display=\'none\'" style="padding:8px 12px; border-radius:8px; cursor:pointer; font-size:14px; ' + (k === cur ? 'background:var(--primary-50); color:var(--primary); font-weight:600;' : 'color:var(--text);') + '; font-family:' + v.css + '; transition:.12s" onmouseover="this.style.background=\'var(--secondary)\'" onmouseout="this.style.background=\'' + (k === cur ? 'var(--primary-50)' : 'transparent') + '\'">'
        + v.name + '</div>').join('')
    + '</div>';
  mask.style.display = 'flex';
}

/* ================== 书架 ================== */
