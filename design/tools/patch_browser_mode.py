# -*- coding: utf-8 -*-
"""浏览器模式(正常模式)下"被浏览器拦截"的看护补齐。

审计结论(design/tools/audit_browser_mode.py + 人工核对):
  全仓 5 处 window.open,只有 2 处检查了返回值:
    ✅ index.html:7477  独立阅读器窗口(有 toast + 回退内嵌阅读器)
    ✅ reader-core.js:399 PDF「系统程序打开」(有 toast)
    ❌ index.html:5224  OPDS 服务「浏览」——被拦后静默无反应
    ❌ reader-core.js:1527 图片缩放「↗ 新窗口打开」——被拦后静默无反应
    ❌ mobile.html:3288 手机端「打开 PDF」——用 data: URL 做顶层导航,
       Chrome/Edge 自 v60 起**无条件禁止**,与弹窗拦截无关,必然失败

本脚本按各处语义补上失败回退:
  * OPDS「浏览」:被拦 → 询问是否在当前页打开(并展示 URL 便于手动复制);
  * 图片「↗」:被拦 → toast 提示(与同文件 pdfOpenSystem 的处理保持一致);
  * 手机端 PDF:数据统一转 Blob URL(可正常导航/下载),被拦 → 退回下载;
  * PDF 全屏:requestFullscreen 补 .catch()(同文件 740 行早有,526 行漏了),
    避免被拒时抛未处理的 Promise rejection。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IDX = os.path.join(ROOT, "static", "index.html")
CORE = os.path.join(ROOT, "static", "reader-core.js")
MOB = os.path.join(ROOT, "static", "mobile.html")

EDITS = {
    IDX: [
        (
            "async function opdsConnectInSettings(url) { if (url) window.open(url, '_blank'); }",
            """async function opdsConnectInSettings(url) {
  if (!url) return;
  // 浏览器会拦截非手势/被策略拦截的弹窗,原来直接 window.open 点了没反应
  const w = window.open(url, '_blank');
  if (!w) {
    showConfirm('弹窗被浏览器拦截,无法新窗口打开该 OPDS 服务。是否在当前页打开?\\n' + url,
      {title: '弹窗被拦截', okText: '在当前页打开', danger: false}).then(go => {
      if (go) location.href = url;
    });
  }
}""",
            "OPDS 浏览:被拦 → 询问在当前页打开",
        ),
    ],
    CORE: [
        (
            "function openImgZoomSrc() { window.open(_imgZoomUrl, '_blank'); }",
            """function openImgZoomSrc() {
  if (!_imgZoomUrl) return;
  const w = window.open(_imgZoomUrl, '_blank');
  if (!w) toast('弹窗被浏览器拦截,可在图片上右键「在新标签页中打开」');
}""",
            "图片 ↗ 新窗口:被拦 → 提示",
        ),
        (
            "  if (!document.fullscreenElement) { if (v.requestFullscreen) v.requestFullscreen(); }",
            "  // requestFullscreen 返回 Promise,被策略拒绝时要吃掉 rejection(与 comicReaderFullscreen 保持一致)\n"
            "  if (!document.fullscreenElement) { if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); }",
            "PDF 全屏:补 .catch() 防空 rejection",
        ),
    ],
    MOB: [
        (
            """function dlOffPdf(title, name) {
  const b64 = offPdfB64(title, name);
  if (!b64) { toast('未找到该话内容'); return; }
  const a = document.createElement('a');
  a.href = 'data:application/pdf;base64,' + b64;
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  toast('已开始保存:' + name + '(保存到系统下载目录)');
}
function openOffPdf(title, name) {
  const b64 = offPdfB64(title, name);
  if (!b64) { toast('未找到该话内容'); return; }
  window.open('data:application/pdf;base64,' + b64, '_blank');
}""",
            """/* data: URL 不能作为顶层导航(Chrome/Edge v60 起无条件拦截,与弹窗拦截无关),
   移动端对 data: 下载也常加限制 —— 统一转成 Blob URL 再打开/下载 */
function _pdfBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
}
function _pdfSaveBlob(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function dlOffPdf(title, name) {
  const b64 = offPdfB64(title, name);
  if (!b64) { toast('未找到该话内容'); return; }
  try {
    const url = _pdfBlobUrl(b64);
    _pdfSaveBlob(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('已开始保存:' + name + '(保存到系统下载目录)');
  } catch (e) { toast('保存失败:' + e.message); }
}
function openOffPdf(title, name) {
  const b64 = offPdfB64(title, name);
  if (!b64) { toast('未找到该话内容'); return; }
  let url = '';
  try { url = _pdfBlobUrl(b64); } catch (e) { toast('打开失败:' + e.message); return; }
  const w = window.open(url, '_blank');
  if (!w) {
    // 弹窗被拦 → 直接下载,别让按钮点了没反应
    _pdfSaveBlob(url, name);
    toast('弹窗被浏览器拦截,已改为下载该话');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}""",
            "手机端 PDF:data: URL → Blob URL + 被拦回退下载",
        ),
    ],
}


def main() -> int:
    total = 0
    for path, edits in EDITS.items():
        text = io.open(path, encoding="utf-8").read()
        name = os.path.relpath(path, ROOT)
        for old, new, label in edits:
            if old not in text:
                print(f"  [跳过] {name} · {label}(未匹配)")
                continue
            text = text.replace(old, new, 1)
            total += 1
            print(f"  [OK] {name} · {label}")
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"\n共应用 {total} 处")
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())