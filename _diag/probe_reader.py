import json,os,sys,urllib.parse
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT=8942
url=f'http://127.0.0.1:{PORT}/reader.html?mode=novel&file='+urllib.parse.quote('_ui_sample.txt')+'&idx=1'
from playwright.sync_api import sync_playwright
JS = """() => {
  const pick = (el, props) => { if(!el) return null; const cs=getComputedStyle(el);
    const o={}; for(const p of props) o[p]=cs[p]; return o; };
  const bodyEl = document.querySelector('#readerMask .reader-body') || document.querySelector('.reader-body') || document.querySelector('#readerMask');
  const p = document.querySelector('#readerMask p') || document.querySelector('p');
  const bar = document.querySelector('.reader-bar');
  const hd = document.querySelector('.reader-hd');
  return {
    bodyTag: bodyEl ? bodyEl.className || bodyEl.id : null,
    bodyBox: bodyEl ? {w: bodyEl.clientWidth, pad: getComputedStyle(bodyEl).padding} : null,
    p: pick(p, ['fontSize','lineHeight','textIndent','marginTop','marginBottom','color','fontFamily','textAlign']),
    bar: bar ? {visible: getComputedStyle(bar).opacity, bg: getComputedStyle(bar).backgroundColor, h: bar.clientHeight} : null,
    hd: hd ? {bg: getComputedStyle(hd).backgroundColor, h: hd.clientHeight} : null,
    bg: getComputedStyle(document.body).backgroundColor,
    tip: (()=>{const t=document.querySelector('.reader-tip,.rd-tip'); return t? t.textContent.trim().slice(0,30):null})(),
    counts: {bars: document.querySelectorAll('.reader-bar').length, buttons: document.querySelectorAll('.reader-bar button,.rb-btn').length}
  };
}"""
with sync_playwright() as pw:
    b=pw.chromium.launch(channel='msedge',headless=True)
    pg=b.new_page(viewport={'width':1000,'height':760})
    pg.goto(url,wait_until='networkidle'); pg.wait_for_timeout(1500)
    print('before-click', json.dumps(pg.evaluate(JS), ensure_ascii=False))
    pg.mouse.click(500,400); pg.wait_for_timeout(900)
    print('after-click ', json.dumps(pg.evaluate(JS), ensure_ascii=False))
    pg.screenshot(path=os.path.join(ROOT,'_diag','rd_click.png'))
    b.close()
