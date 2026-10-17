import os, sys, json
ROOT = os.getcwd()
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp"); os.environ["TMP"] = os.environ["TEMP"]
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(channel="msedge", headless=True)
    p = b.new_context(viewport={"width":1440,"height":900}).new_page()
    p.goto("http://127.0.0.1:8899/", wait_until="load", timeout=60000)
    p.wait_for_timeout(2500)
    try:
        if p.is_visible("#devTipMask"):
            p.click("text=我知道了"); p.wait_for_timeout(400)
    except Exception: pass
    p.evaluate("enterMode('comic')"); p.wait_for_timeout(1500)
    p.evaluate("comicShowView('shelf')"); p.wait_for_timeout(3000)
    print("cNavShelf =", p.evaluate("document.getElementById('cNavShelf').textContent"))
    print("header    =", p.evaluate("document.querySelector('#cview-shelf .card-hd')?.innerText.slice(0,60)"))
    print("api       =", p.evaluate("fetch('/api/comic_shelf').then(r=>r.json()).then(j=>JSON.stringify({n:(j.shelf||[]).length, keys:Object.keys(j)}))"))
    print("grid kids =", p.evaluate("document.querySelectorAll('#cview-shelf .comic-card, #cview-shelf .cover-card, #cview-shelf .grid > *').length"))
    b.close()

