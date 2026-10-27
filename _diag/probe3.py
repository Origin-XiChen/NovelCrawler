import json,os,urllib.parse
PORT=8942
from playwright.sync_api import sync_playwright
def probe(pg, fname):
    url=f'http://127.0.0.1:{PORT}/reader.html?mode=novel&file='+urllib.parse.quote(fname)+'&idx=1'
    pg.goto(url,wait_until='networkidle'); pg.wait_for_timeout(1000)
    return pg.evaluate("""()=>{
      const body=document.querySelector('.reader-body');
      const txt=body? body.innerText : '';
      const toc=document.querySelectorAll('.reader-toc__item,.toc-item').length;
      return {title:document.querySelector('.reader-hd')?document.querySelector('.reader-hd').innerText.trim().slice(0,40):'',
              firstLines: txt.split('\\n').filter(x=>x.trim()).slice(0,4),
              hasMarker: txt.includes('【章节】'), tocItems: toc};
    }""")
with sync_playwright() as pw:
    b=pw.chromium.launch(channel='msedge',headless=True)
    pg=b.new_page(viewport={'width':1000,'height':760})
    print('真实文件 ', json.dumps(probe(pg,'测试小说落盘[假源].txt'),ensure_ascii=False))
    print('我的样例 ', json.dumps(probe(pg,'_ui_sample.txt'),ensure_ascii=False))
    b.close()
