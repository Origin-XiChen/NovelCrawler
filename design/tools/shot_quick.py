# -*- coding: utf-8 -*-
"""快速取关键屏(门户 + 书架)的浅色/深色实拍,用于改动前后目视核对。

用法:bundle314\\Scripts\\python.exe -X utf8 design\\tools\\shot_quick.py [前缀] [视图...]
视图可选:launcher shelf search settings(默认 launcher shelf)
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)

BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")
PREFIX = sys.argv[1] if len(sys.argv) > 1 else "q"
VIEWS = sys.argv[2:] or ["launcher", "shelf"]
OUT = os.path.join(ROOT, "design", "shots")
os.makedirs(OUT, exist_ok=True)

from playwright.sync_api import sync_playwright  # noqa: E402


def dismiss(page):
    for _ in range(3):
        try:
            if page.is_visible("#devTipMask"):
                page.click("text=我知道了", timeout=3000)
                page.wait_for_timeout(400)
                continue
        except Exception:  # noqa: BLE001
            pass
        break


def theme(page, mode):
    page.evaluate("m => { document.documentElement.dataset.theme = m; }", mode)
    page.wait_for_timeout(500)


def shot(page, name):
    p = os.path.join(OUT, f"{PREFIX}-{name}.png")
    page.screenshot(path=p)
    print(f"  {p} ({os.path.getsize(p)//1024} KB)")


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900},
                              device_scale_factor=1, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="load", timeout=60000)
    page.wait_for_timeout(2600)
    dismiss(page)
    try:
        # 门户统计是异步拉的,等它落地再截图
        page.evaluate("loadLauncherStats && loadLauncherStats()")
    except Exception:  # noqa: BLE001
        pass
    page.wait_for_timeout(1200)

    if "launcher" in VIEWS:
        for mode in ("light", "dark"):
            theme(page, mode)
            shot(page, f"launcher-{mode}")
        theme(page, "light")

    if "shelf" in VIEWS or "search" in VIEWS or "settings" in VIEWS:
        page.evaluate("enterMode && enterMode('book')")
        page.wait_for_timeout(1500)

    if "search" in VIEWS:
        page.evaluate("showView && showView('search')")
        page.wait_for_timeout(900)
        shot(page, "search-light")

    if "shelf" in VIEWS:
        page.evaluate("showView && showView('shelf')")
        page.wait_for_timeout(1500)
        for mode in ("light", "dark"):
            theme(page, mode)
            shot(page, f"shelf-{mode}")
        theme(page, "light")

    if "settings" in VIEWS:
        page.evaluate("showSettings && showSettings()")
        page.wait_for_timeout(1400)
        page.evaluate("showSettingsCat && showSettingsCat('common')")
        page.wait_for_timeout(1200)
        shot(page, "settings-light")

    ctx.close()
    browser.close()
print("done")