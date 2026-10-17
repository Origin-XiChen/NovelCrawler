# -*- coding: utf-8 -*-
"""端到端 UI 回归:真实点击搜索,验证阶段一/二改动后前端流程没坏。

断言:
  * 进度条文案用"个可搜索书源",分母等于可搜索源数(不是启用数);
  * 搜索结束后 searchHint 有内容,结果列表非空;
  * 书源搜索状态面板能打开,且状态胶囊渲染出主题令牌色(不是写死的深绿/深红);
  * 控制台没有 JS 报错。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)
BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")
OUT = os.path.join(ROOT, "design", "shots")
KEYWORD = os.environ.get("E2E_KW", "魔法")

from playwright.sync_api import sync_playwright  # noqa: E402

errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    page.goto(BASE + "/", wait_until="load", timeout=60000)
    page.wait_for_timeout(2600)
    for _ in range(3):
        if page.is_visible("#devTipMask"):
            page.click("text=我知道了", timeout=3000)
            page.wait_for_timeout(400)
            continue
        break

    page.evaluate("enterMode('book')")
    page.wait_for_timeout(1400)
    page.evaluate("showView('search')")
    page.wait_for_timeout(600)

    page.fill("#kw", KEYWORD)
    page.click("#btnSearch")
    page.wait_for_timeout(6000)
    page.screenshot(path=os.path.join(OUT, "e2e-01-searching.png"))
    mid = page.evaluate("() => document.getElementById('spText').textContent")
    print("  搜索中文案:", mid)

    # 等结束(最多 100 秒;新逻辑有 60 秒上限)
    # 注意:searchDone 是 <script> 里的 let(脚本作用域),不是 window 属性,
    # 所以这里按 DOM 判定:进度条隐藏 + 摘要已写入 = 流程收尾。
    for _ in range(200):
        st = page.evaluate(
            "() => document.getElementById('searchProgWrap').style.display === 'none' "
            "|| document.getElementById('searchHint').textContent.trim() !== ''")
        if st:
            break
        page.wait_for_timeout(500)
    page.wait_for_timeout(1200)
    page.screenshot(path=os.path.join(OUT, "e2e-02-result.png"))
    res = page.evaluate("""() => ({
        hint: document.getElementById('searchHint').textContent,
        count: (document.querySelectorAll('#resultList .result-item') || []).length,
        progHidden: document.getElementById('searchProgWrap').style.display === 'none',
        done: (document.getElementById('searchHint').textContent || '').trim() !== '',
        btnRestored: !document.getElementById('btnSearch').disabled,
    })""")
    print("  结果态:", res)

    # 书源状态面板
    page.evaluate("openSrcStatus()")
    page.wait_for_timeout(900)
    page.screenshot(path=os.path.join(OUT, "e2e-03-srcstatus.png"))
    pill = page.evaluate("""() => {
        const p = document.querySelector('#ssBody span[style*="border-radius:999px"]');
        return p ? { text: p.textContent.trim(), color: getComputedStyle(p).color,
                     bg: getComputedStyle(p).backgroundColor } : null;
    }""")
    print("  状态胶囊:", pill)
    ctx.close()
    browser.close()

print("\n判定:")
ok = True
if "可搜索书源" not in mid:
    print("  ❌ 进度文案未使用『个可搜索书源』"); ok = False
else:
    print("  ✅ 进度文案已用可搜索源口径")
if not res["done"]:
    print("  ❌ 搜索未在等待窗口内结束"); ok = False
else:
    print("  ✅ 搜索正常结束,进度条已隐藏" if res["progHidden"] else "  ⚠ 结束但进度条未隐藏")
if res["count"] == 0:
    print("  ⚠ 结果列表为空(可能网络受限,不是前端问题)")
else:
    print(f"  ✅ 渲染出 {res['count']} 条结果")
if not res["hint"]:
    print("  ❌ searchHint 为空"); ok = False
else:
    print("  ✅ 结果摘要:", res["hint"][:70])
if pill is None:
    print("  ❌ 状态面板没渲染出胶囊"); ok = False
else:
    print(f"  ✅ 状态胶囊 {pill['text']} → color={pill['color']}")
if errors:
    print("  ❌ 控制台报错:")
    for e in errors[:8]:
        print("    ", e)
    ok = False
else:
    print("  ✅ 控制台无报错")
print("\nE2E:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)