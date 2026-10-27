import json,os
PORT=8944
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b=pw.chromium.launch(channel='msedge',headless=True)
    pg=b.new_page(viewport={'width':1180,'height':820})
    pg.goto(f'http://127.0.0.1:{PORT}/app/',wait_until='networkidle'); pg.wait_for_timeout(800)
    pg.get_by_text('文件',exact=True).first.click(); pg.wait_for_timeout(1500)
    row = pg.locator('text=_ui_sample').first
    print('found row:', row.count())
    # 同一行/卡片里找「阅读」按钮
    card = pg.locator('.file-card, .file-row, tr, li').filter(has_text='_ui_sample').first
    try:
        card.get_by_text('阅读').first.click(timeout=5000)
    except Exception as e:
        print('click fail', str(e)[:120])
        try:
            pg.get_by_text('_ui_sample').first.click()
        except Exception as e2:
            print('click2 fail', str(e2)[:120])
    pg.wait_for_timeout(2200)
    print('url:', pg.url)
    pg.screenshot(path=os.path.join(ROOT,'_diag','nr_light.png'))
    b.close()
