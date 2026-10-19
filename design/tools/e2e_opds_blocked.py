# -*- coding: utf-8 -*-
"""集成验证:浏览器模式下弹窗被拦 → OPDS「浏览」不再静默无反应。

做法:进入设置 → 小说 → OPDS 书库,把 window.open 桩成返回 null(模拟弹窗拦截器),
点「浏览」按钮,断言弹出确认框且文案说明了原因。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)
BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")
OUT = os.path.join(ROOT, "design", "shots")

from playwright.sync_api import sync_playwright  # noqa: E402

errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)
    # 在页面脚本之前把 window.open 桩成"被拦截"
    page.add_init_script("window.open = function(){ return null; };")
    page.goto(BASE + "/", wait_until="load", timeout=60000)
    page.wait_for_timeout(2600)
    for _ in range(3):
        if page.is_visible("#devTipMask"):
            page.click("text=我知道了", timeout=3000)
            page.wait_for_timeout(400)
            continue
        break

    page.evaluate("showSettings()")
    page.wait_for_timeout(500)
    page.evaluate("showSettingsCat('book')")
    page.wait_for_timeout(900)
    page.evaluate("showSetBookTab('opds')")
    page.wait_for_timeout(1600)

    n = page.evaluate("() => document.querySelectorAll('#setBookPane button, .settings-main button').length")
    btns = page.evaluate("""() => Array.from(document.querySelectorAll('button'))
        .filter(b => b.textContent.trim() === '浏览').length""")
    print(f"  OPDS 面板按钮数: {n},其中「浏览」{btns} 个")

    clicked = page.evaluate("""() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '浏览');
        if (!b) return false;
        b.click(); return true;
    }""")
    page.wait_for_timeout(900)
    page.screenshot(path=os.path.join(OUT, "e2e-04-opds-blocked.png"))

    res = page.evaluate("""() => ({
        shown: document.getElementById('confirmMask').classList.contains('show'),
        title: document.getElementById('confirmTitle').textContent,
        msg: document.getElementById('confirmMsg').textContent,
        ok: document.getElementById('confirmOkBtn').textContent,
    })""")
    print(f"  点击成功: {clicked}")
    print(f"  确认框: {res}")
    ctx.close()
    browser.close()

ok = True
print("\n判定:")
if not clicked:
    print("  ❌ 没找到「浏览」按钮"); ok = False
else:
    print("  ✅ 找到并点击了「浏览」按钮")
if not res["shown"]:
    print("  ❌ 弹窗被拦后没有任何反馈(静默无反应)"); ok = False
else:
    print("  ✅ 弹出了确认框(不再静默)")
if "弹窗被浏览器拦截" in res["msg"]:
    print("  ✅ 文案说明了原因")
else:
    print(f"  ❌ 文案未说明原因: {res['msg'][:60]}"); ok = False
if res["ok"] == "在当前页打开":
    print("  ✅ 提供了「在当前页打开」的出口")
else:
    print(f"  ⚠ 出口按钮文案为「{res['ok']}」")
if errors:
    print("  ❌ 控制台报错:")
    for e in errors[:5]:
        print("    ", e)
    ok = False
else:
    print("  ✅ 控制台无报错")
print("\n集成验证:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)