# -*- coding: utf-8 -*-
"""把「浏览器模式(正常模式)下被拦截」的审计与修复追加到 design/UI-ANALYSIS.md。"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "design", "UI-ANALYSIS.md")

ANCHOR = "* **字号字面量 302 处**:属存量,已用 lint 基线锁住\"只能减少\";彻底替换需要\n  逐条核对视觉,风险高于收益,留作后续按屏推进。"

SECTION = """
---

## 8. 浏览器模式(正常模式)下的「拦截」审计与修复

### 8.1 起因与结论

应用有两套运行形态:**桌面模式**(WebView2 壳,`window.chrome.webview` 存在,可开原生窗口)
与**浏览器模式**(真正的浏览器 —— 局域网/手机访问,或直接用浏览器打开),后者受浏览器
安全策略约束。用户报告"正常模式下会被拦截",即属于后者。

先确认了**反爬 403 拦截链路本身是完整的**(`novel/fetcher.py`、`novel/comic.py`、`novel/opds.py`、
`gui_server.py` 三处、`novel/browser.py` 都会在 401/403 时自动带验证中心 cookies 重试,
前端在 `index.html` 三处引导去验证中心,`verify.py` 自动登记待验证),本次未改动。

真正的缺口在**浏览器策略**这一类:全仓共 **5 处 `window.open`**,只有 **2 处**检查了返回值。

### 8.2 盘点结果

| # | 位置 | 用途 | 修复前被拦截时 |
|---|---|---|---|
| 1 | `index.html`(独立阅读器窗口) | 点「阅读」开新窗口 | ✅ 已提示 + 回退内嵌阅读器 |
| 2 | `reader-core.js`(`pdfOpenSystem`) | PDF「系统程序打开」 | ✅ 已 toast |
| 3 | `index.html`(`opdsConnectInSettings`) | OPDS 服务「浏览」 | ❌ **静默无反应** |
| 4 | `reader-core.js`(`openImgZoomSrc`) | 图片缩放「↗ 新窗口打开」 | ❌ **静默无反应** |
| 5 | `mobile.html`(`openOffPdf`) | 手机端「打开 PDF」 | ❌ **必然失败**(见下) |

第 5 处不是"可能被拦",而是**一定失败**:它用 `window.open('data:application/pdf;base64,…')`
做顶层导航,而 Chrome/Edge 自 v60 起**无条件禁止顶层导航到 `data:` URL**,与弹窗拦截器无关。

另发现一处同类不一致:`reader-core.js` 的 PDF 全屏 `requestFullscreen()` 漏了 `.catch()`
(同文件的 `comicReaderFullscreen` 早有),被策略拒绝时会产生未处理的 Promise rejection。

### 8.3 修复内容

* **OPDS「浏览」**:被拦 → 弹确认框说明原因、带上 URL 便于手动复制,并提供「在当前页打开」出口;
* **图片「↗ 新窗口」**:被拦 → toast 提示(与同文件 `pdfOpenSystem` 的处理保持一致);
* **手机端 PDF**:新增 `_pdfBlobUrl()` 把 base64 转成 **Blob URL** 再打开/下载,
  被拦时自动退回下载并提示"已改为下载该话";同时补 `URL.revokeObjectURL` 回收,避免内存泄漏;
* **PDF 全屏**:补 `.catch(() => {})`;
* 顺手补齐 **3 处裸 `localStorage` 读取**(设置页主题回填、跟随系统主题监听、阅读器纸色),
  同文件其它同类读取本就写了 `try/catch`,只有这 3 处漏了 —— 存储被禁用/隐私模式下会直接抛异常。

### 8.4 验证

* `design/tools/audit_browser_mode.py`:**高风险 0 处 / 共 99 处**。
  该工具第一版用"邻近 12 行是否出现 `try{`/`被拦截`"做判定,结果把 4 处真问题误判为"已处理"
  (邻近恰好有无关的 `try{`);已改为**只按本条语句的返回值处理**判定(`if (!w)` / `被拦截`),
  修正后立刻暴露了那 4 处。这也说明**审计工具本身要能被证伪**。
* `design/tools/_work/test_browser_mode.js`:**13 条断言 PASS**,覆盖图片 ↗ 与 OPDS 浏览
  在"允许/被拦/空参数"三种情形下的行为,以及全屏被拒不产生 unhandled rejection。
  该测试**可证伪**:临时去掉 `.catch(() => {})` 后同一测试报 `unhandled=1` 并 FAIL,恢复后 PASS。
* `design/tools/_work/test_mobile_pdf.js`:**11 条断言 PASS**(弹窗允许→新标签;
  被拦→退回下载 + 提示;保存用 Blob URL;内容缺失时提示;Blob URL 被回收)。
* `design/tools/e2e_opds_blocked.py`:**PASS** —— 真实浏览器里把 `window.open` 桩成返回 `null`,
  进设置 → 小说 → OPDS 书库点「浏览」,确认框正确弹出且文案带原因与 URL,控制台无报错。
* `design/tools/e2e_search_ui.py`:回归 **PASS**(32 条结果,进度文案与状态胶囊正常)。

> 两个测试文件放在 `design/tools/_work/`(该目录已在 `.gitignore` 中)。
> 它们是可重复运行的,只是不随仓库提交;需要时可直接 `node` 执行。
"""


def main() -> int:
    text = io.open(DOC, encoding="utf-8").read()
    if "## 8. 浏览器模式" in text:
        print("已存在第 8 节,跳过")
        return 0
    if ANCHOR not in text:
        print("未找到锚点,未追加")
        return 1
    text = text.replace(ANCHOR, ANCHOR + "\n" + SECTION, 1)
    io.open(DOC, "w", encoding="utf-8", newline="\n").write(text)
    print("已追加第 8 节,当前行数:", text.count("\n") + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())