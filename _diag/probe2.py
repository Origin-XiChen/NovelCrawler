import json,os,urllib.parse
PORT=8942
url=f'http://127.0.0.1:{PORT}/reader.html?mode=novel&file='+urllib.parse.quote('_ui_sample.txt')+'&idx=1'
from playwright.sync_api import sync_playwright
JS="""()=>({
 body: document.body.className,
 bars: [...document.querySelectorAll('.reader-bar')].map(b=>{const r=b.getBoundingClientRect();const cs=getComputedStyle(b);return {cls:b.className,h:Math.round(r.height),top:Math.round(r.top),disp:cs.display,op:cs.opacity,bg:cs.backgroundColor,btns:b.querySelectorAll('button').length}}),
 hd: [...document.querySelectorAll('.reader-hd')].map(h=>{const r=h.getBoundingClientRect();return {cls:h.className,h:Math.round(r.height),top:Math.round(r.top)}}),
 toc: document.querySelectorAll('.reader-toc').length
})"""
with sync_playwright() as pw:
    b=pw.chromium.launch(channel='msedge',headless=True)
    pg=b.new_page(viewport={'width':1000,'height':760})
    pg.goto(url,wait_until='networkidle'); pg.wait_for_timeout(1200)
    print('A',json.dumps(pg.evaluate(JS),ensure_ascii=False))
    pg.mouse.click(500,400); pg.wait_for_timeout(700)
    print('B',json.dumps(pg.evaluate(JS),ensure_ascii=False))
    pg.screenshot(path=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'_diag','rd_hidden.png'))
    b.close()
