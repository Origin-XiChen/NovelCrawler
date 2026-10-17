# -*- coding: utf-8 -*-
"""对新设计原型逐屏截图(Playwright + 系统 Edge)。输出 _ui/shots/new-*.png"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)
OUT = os.path.join(ROOT, "design", "shots")
os.makedirs(OUT, exist_ok=True)
URL = "file:///" + os.path.join(ROOT, "design", "redesign-preview.html").replace("\\", "/") + "?clean=1"

from playwright.sync_api import sync_playwright  # noqa: E402

VIEWS = [("search", "01-search"), ("shelf", "02-shelf"), ("comic", "03-comic-shelf"),
         ("history", "04-history"), ("files", "05-files"), ("settings", "06-settings"),
         ("verify", "07-verify"), ("home", "08-home"), ("spec", "09-spec")]

with sync_playwright() as pw:
    b = pw.chromium.launch(channel="msedge", headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(URL, wait_until="load")
    page.wait_for_timeout(700)
    for view, name in VIEWS:
        page.evaluate(f"window.go('{view}')")
        page.wait_for_timeout(320)
        p = os.path.join(OUT, f"new-{name}.png")
        page.screenshot(path=p)
        print("shot", os.path.basename(p))

    # 深色 + 书架
    page.evaluate("document.getElementById('themeBtn').click()")
    page.evaluate("window.go('shelf')")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, "new-10-dark-shelf.png"))
    print("shot new-10-dark-shelf.png")
    page.evaluate("document.getElementById('themeBtn').click()")

    # 窄屏(1024)看响应式折叠
    sm = ctx.new_page()
    sm.set_viewport_size({"width": 1024, "height": 720})
    sm.goto(URL, wait_until="load")
    sm.wait_for_timeout(500)
    sm.evaluate("window.go('shelf')")
    sm.wait_for_timeout(300)
    sm.screenshot(path=os.path.join(OUT, "new-11-narrow-1024.png"))
    print("shot new-11-narrow-1024.png")
    sm.close()
    ctx.close()
    b.close()
print("done")



