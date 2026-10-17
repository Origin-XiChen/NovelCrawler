import os
ROOT = os.getcwd()
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp"); os.environ["TMP"] = os.environ["TEMP"]
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(channel="msedge", headless=True)
    p = b.new_context(viewport={"width":1440,"height":900}, locale="zh-CN").new_page()
    p.goto("http://127.0.0.1:8899/", wait_until="load", timeout=60000)
    p.wait_for_timeout(2500)
    try:
        if p.is_visible("#devTipMask"):
            p.click("text=我知道了"); p.wait_for_timeout(400)
    except Exception: pass
    p.evaluate("enterMode('book')"); p.wait_for_timeout(800)
    # 用 OPDS 模式搜(离线源,能出结果,不依赖被墙站点)
    p.fill("#kw", "史莱姆")
    p.evaluate("onSearchBtn()")
    p.wait_for_timeout(25000)
    p.screenshot(path=os.path.join(ROOT, "design", "shots", "cur-06-book-search-result.png"))
    print("rows =", p.evaluate("document.querySelectorAll('#resultList > *').length"))
    print("text =", p.evaluate("(document.getElementById('resultList')||{}).innerText?.slice(0,160)"))
    b.close()

