# -*- coding: utf-8 -*-
"""对当前 UI 逐屏实拍(Playwright + 系统 Edge,headless),用于 UI 分析取证。

用法:bundle314\\Scripts\\python.exe -X utf8 _ui\\shoot.py  [前缀]
输出:_ui/shots/<前缀>-NN-名称.png
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)

BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")
PREFIX = sys.argv[1] if len(sys.argv) > 1 else "cur"
OUT = os.path.join(ROOT, "design", "shots")
os.makedirs(OUT, exist_ok=True)

from playwright.sync_api import sync_playwright  # noqa: E402


def shot(page, name, full=False):
    p = os.path.join(OUT, f"{PREFIX}-{name}.png")
    page.screenshot(path=p, full_page=full)
    print(f"  shot {p}  ({os.path.getsize(p)//1024} KB)")
    return p


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900},
                              device_scale_factor=1, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="load", timeout=60000)
    page.wait_for_timeout(3000)  # 等启动遮罩/门户渲染
    # 关掉"每会话一次"的使用说明弹层,否则所有截图都被它挡住
    for _ in range(3):
        try:
            if page.is_visible("#devTipMask"):
                page.click("text=我知道了", timeout=3000)
                page.wait_for_timeout(500)
                continue
        except Exception:  # noqa: BLE001
            pass
        break
    page.wait_for_timeout(600)

    shot(page, "01-launcher")

    # 小说模式
    page.evaluate("enterMode && enterMode('book')")
    page.wait_for_timeout(1200)
    shot(page, "02-book-search")
    for view, label in (("shelf", "03-book-shelf"), ("files", "04-book-files"),
                        ("history", "05-book-history")):
        page.evaluate(f"showView('{view}')")
        page.wait_for_timeout(1200)
        shot(page, label)

    # 搜索一次(真实网络,失败也能看到空/错误态)
    try:
        page.fill("#kw", "史莱姆")
        page.evaluate("startSearch && startSearch()")
        page.wait_for_timeout(6000)
        shot(page, "06-book-search-result")
    except Exception as exc:  # noqa: BLE001
        print("  搜索截图跳过:", type(exc).__name__, exc)

    # 漫画模式
    page.evaluate("enterMode && enterMode('comic')")
    page.wait_for_timeout(1200)
    shot(page, "07-comic-search")
    for view, label in (("shelf", "08-comic-shelf"), ("files", "09-comic-files")):
        page.evaluate(f"comicShowView('{view}')")
        page.wait_for_timeout(1200)
        shot(page, label)

    # 任务面板
    try:
        page.evaluate("openTaskPanel && openTaskPanel()")
        page.wait_for_timeout(1200)
        shot(page, "10-task-panel")
        page.evaluate("closeTaskPanel && closeTaskPanel()")
    except Exception as exc:  # noqa: BLE001
        print("  任务面板跳过:", exc)

    # 设置页各分类
    page.evaluate("showSettings && showSettings()")
    page.wait_for_timeout(1000)
    for cat, label in (("common", "11-set-common"), ("book", "12-set-book"),
                       ("comic", "13-set-comic"), ("verify", "14-set-verify"),
                       ("phone", "15-set-phone")):
        try:
            page.evaluate(f"showSettingsCat('{cat}')")
            page.wait_for_timeout(1400)
            shot(page, label)
        except Exception as exc:  # noqa: BLE001
            print(f"  设置分类 {cat} 跳过:", exc)
    page.evaluate("closeSettingsPage && closeSettingsPage()")
    page.wait_for_timeout(600)

    # 手机尺寸(响应式)
    mob = ctx.new_page()
    mob.set_viewport_size({"width": 390, "height": 844})
    mob.goto(BASE + "/mobile", wait_until="load", timeout=60000)
    mob.wait_for_timeout(2500)
    shot(mob, "16-mobile-home")
    mob.close()

    # 小窗桌面(看是否溢出)
    sm = ctx.new_page()
    sm.set_viewport_size({"width": 1100, "height": 700})
    sm.goto(BASE + "/", wait_until="load", timeout=60000)
    sm.wait_for_timeout(2500)
    sm.evaluate("enterMode && enterMode('book')")
    sm.wait_for_timeout(1000)
    shot(sm, "17-narrow-1100")
    sm.close()

    ctx.close()
    browser.close()
print("done")



