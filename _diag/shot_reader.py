import os,sys,urllib.parse
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT=int(sys.argv[1]) if len(sys.argv)>1 else 8942
url=f'http://127.0.0.1:{PORT}/reader.html?mode=novel&file='+urllib.parse.quote('_ui_sample.txt')+'&idx=1'
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b=pw.chromium.launch(channel='msedge',headless=True)
    pg=b.new_page(viewport={'width':1000,'height':760})
    pg.goto(url,wait_until='networkidle'); pg.wait_for_timeout(1200)
    pg.screenshot(path=os.path.join(ROOT,'_diag','rd_light.png'))
    pg.mouse.move(500,380); pg.wait_for_timeout(600)
    pg.screenshot(path=os.path.join(ROOT,'_diag','rd_bar.png'))
    pg.evaluate("document.documentElement.dataset.theme='dark'")
    pg.wait_for_timeout(400)
    pg.screenshot(path=os.path.join(ROOT,'_diag','rd_dark.png'))
    b.close()
print('ok')
