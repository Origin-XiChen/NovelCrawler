# -*- coding: utf-8 -*-
"""抓取"搜索进行中"与"搜索出结果"两个真实状态,输出到 design/shots/。

需要本地服务在 8899 端口(数据目录用 design/tools/_work/data)。
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)
OUT = os.path.join(ROOT, "design", "shots")
os.makedirs(OUT, exist_ok=True)
BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")

from playwright.sync_api import sync_playwright  # noqa: E402


def dismiss(page):
    try:
        if page.is_visible("#devTipMask"):
            page.click("text=我知道了")
            page.wait_for_timeout(400)
    except Exception:
        pass


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="msedge", headless=True)
    page = b.new_context(viewport={"width": 1440, "height": 900},
                         locale="zh-CN").new_page()
    page.goto(BASE + "/", wait_until="load", timeout=60000)
    page.wait_for_timeout(2500)
    dismiss(page)
    page.evaluate("enterMode('book')")
    page.wait_for_timeout(800)

    page.fill("#kw", "魔法")
    page.evaluate("onSearchBtn()")
    # 结果已经出来、但整体还没 done 的中间态(BUG-1 的表现)
    page.wait_for_timeout(14000)
    page.screenshot(path=os.path.join(OUT, "cur-06-book-search-searching.png"))
    print("shot cur-06-book-search-searching.png")

    # 等到真正结束(慢源约 2 分钟)
    for _ in range(60):
        page.wait_for_timeout(3000)
        state = page.evaluate(
            "fetch('/api/search_progress?id='+window.searchTid)"
            ".then(r=>r.json()).then(j=>j.state).catch(()=>'?')")
        if state in ("done", "error"):
            break
    page.wait_for_timeout(1500)
    page.screenshot(path=os.path.join(OUT, "cur-06-book-search-result.png"))
    print("shot cur-06-book-search-result.png  state=", state)

    ctx = page.context
    ctx.close()
    b.close()
print("done")