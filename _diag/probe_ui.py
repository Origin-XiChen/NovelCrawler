import json,os,socket,subprocess,sys,time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA=os.path.join(ROOT,'_diag','_uidata'); PORT=8935
with open(os.path.join(DATA,'config.json'),'w',encoding='utf-8') as f:
    json.dump({"sources":[],"settings":{"lan_access":True,"https_enabled":False}},f)
env=dict(os.environ,NOVEL_DATA_DIR=DATA,PYTHONIOENCODING='utf-8')
p=subprocess.Popen([sys.executable,'-u','gui_server.py','--port',str(PORT)],cwd=ROOT,env=env,
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(80):
    try:
        socket.create_connection(('127.0.0.1',PORT),timeout=0.5).close(); break
    except OSError: time.sleep(0.25)
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b=pw.chromium.launch(channel='msedge',headless=True)
        pg=b.new_page(viewport={'width':1180,'height':1400})
        pg.goto(f'http://127.0.0.1:{PORT}/app/',wait_until='networkidle')
        pg.get_by_text('手机连接',exact=True).first.click()
        pg.wait_for_timeout(1500)
        print('before:', pg.locator('.mobile-pair-url').inner_text())
        pg.locator('.mobile-card', has_text='加密访问').locator('.switch').first.click()
        pg.wait_for_timeout(3000)
        print('after :', pg.locator('.mobile-pair-url').inner_text())
        print('pill  :', pg.locator('.tls-pill').inner_text())
        st=pg.evaluate("fetch('/api/network?force=1').then(r=>r.json()).then(d=>[d.scheme,d.port])")
        print('api   :', st)
        b.close()
finally:
    p.terminate()
