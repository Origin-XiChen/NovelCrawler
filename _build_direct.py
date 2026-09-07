# -*- coding: utf-8 -*-
"""组装 static/direct.html:模板 + 从 mobile.html 提取的已验证代码块。"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
mobile = io.open(os.path.join(ROOT, 'static', 'mobile.html'), encoding='utf-8').read()
_s = mobile.index('<!-- 内联 QR 生成器')
_e = mobile.index('</script>', _s) + len('</script>')
qr_lib = mobile[_s:_e]


def extract(start_marker, end_marker, include_end=False):
    s = mobile.index(start_marker)
    e = mobile.index(end_marker, s)
    if include_end:
        e += len(end_marker)
    return mobile[s:e]


# 压缩/解压助手
block_compress = extract('function b64ToBytes(b64) {', '// 手机会话 ID', include_end=False).rstrip()
# 云端信令:MQTT over WS 客户端 + sha256 + hints 解析
block_signal = extract('// ---------------- 云端信令:应答码自动回传', '// 等待 ICE 候选收集完成。').rstrip()
# ICE 等待
block_ice = extract('function waitIceGathering(pc, ms) {', 'async function wrtcConnect() {').rstrip()

template = r'''<!DOCTYPE html>
<!-- 「远程直连」独立连接页(连接文件)
     两种用法:
     ① 经临时隧道/局域网打开(http)——自动与电脑完成 P2P 握手(信令走当前 HTTP),
        成功后数据面切直连;失败自动回落当前通道,功能不受损。
     ② 作为本地文件打开(file://,微信/邮件传到手机)——扫电脑屏幕上的连接码一次,
        应答码经公共 MQTT 云端自动回传,零摄像头零粘贴。
     连接成功后可「载入完整阅读页」:完整页以 iframe 呈现,API 经 postMessage
     由本页的 WebRTC DataChannel 转发 —— 单一直连通道承载全部数据。 -->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#007AFF">
<title>漫画+小说 · 远程直连</title>
<style>
  :root { --bg:#F2F2F7; --card:#fff; --text:#1d1d1f; --muted:#86868b; --border:#e5e5ea;
          --primary:#007AFF; --danger:#FF3B30; --ok:#34C759; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#000; --card:#1c1c1e; --text:#f5f5f7; --muted:#98989d; --border:#2c2c2e; }
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
         min-height:100vh; padding:18px 16px 40px; }
  .topbar { display:flex; align-items:center; gap:10px; margin-bottom:16px; }
  .topbar h1 { font-size:17px; }
  .badge { font-size:11.5px; padding:3px 10px; border-radius:999px; background:var(--card); border:1px solid var(--border); color:var(--muted); }
  .badge.on { color:var(--ok); border-color:rgba(52,199,89,.4); }
  .badge.mid { color:var(--primary); border-color:rgba(0,122,255,.4); }
  .card { background:var(--card); border-radius:16px; padding:18px 16px; box-shadow:0 1px 4px rgba(0,0,0,.06); margin-bottom:14px; }
  .card h2 { font-size:15px; margin-bottom:8px; }
  .hint { font-size:12.5px; color:var(--muted); line-height:1.85; }
  .st { font-size:13px; line-height:1.9; margin-top:6px; min-height:20px; }
  .st.ok { color:var(--ok); }
  .st.warn { color:var(--danger); }
  .btns { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  button.fbtn { flex:1; min-width:130px; border:1px solid var(--border); background:var(--card); color:var(--text);
                border-radius:12px; padding:12px 10px; font-size:14px; font-weight:600; cursor:pointer; }
  button.fbtn.pri { background:var(--primary); border-color:var(--primary); color:#fff; }
  button.fbtn:disabled { opacity:.5; }
  textarea { width:100%; height:64px; border:1px solid var(--border); border-radius:10px; padding:8px;
             font-size:12px; resize:none; font-family:monospace; background:var(--card); color:var(--text); }
  video { width:100%; border-radius:12px; background:#000; max-height:230px; }
  details { margin-top:10px; }
  summary { font-size:12.5px; color:var(--muted); cursor:pointer; }
  #qrBox img { display:block; width:100%; image-rendering:pixelated; background:#fff; border-radius:10px; }
  .div { text-align:center; color:var(--muted); font-size:11.5px; margin:14px 0 10px; }
  #embWrap { position:fixed; inset:0; z-index:200; background:var(--bg); display:none; }
  #embWrap.show { display:block; }
  #embWrap iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  #embBar { position:absolute; top:0; left:0; right:0; height:34px; display:flex; align-items:center; gap:8px;
            padding:0 10px; background:rgba(0,0,0,.65); color:#fff; font-size:12px; z-index:2; }
  #embBar button { margin-left:auto; background:rgba(255,255,255,.18); color:#fff; border:0; border-radius:8px;
                   padding:4px 10px; font-size:12px; }
  .hide { display:none !important; }
</style>
</head>
<body>

<div class="topbar">
  <h1>📶 远程直连</h1>
  <span class="badge" id="badge">● 未连接</span>
</div>

<div class="card">
  <h2 id="secTitle">连接状态</h2>
  <div class="hint" id="modeHint"></div>
  <div class="st" id="st">初始化…</div>
  <div class="btns" id="actBtns"></div>
</div>

<div class="card" id="manualCard">
  <details id="manualBox">
    <summary>手动连接(扫电脑屏幕上的连接码 / 粘贴连接码)</summary>
    <div style="margin-top:10px">
      <button class="fbtn" style="width:100%" onclick="scanOffer()">📷 扫电脑屏幕</button>
      <div id="scanArea" class="hide" style="margin-top:10px">
        <video id="scanVideo" playsinline muted></video>
        <div class="hint" style="text-align:center;margin-top:6px">对准电脑屏幕上的二维码,识别后自动连接</div>
      </div>
      <textarea id="offerText" placeholder="或粘贴电脑屏幕上的连接码(novelist-wrtc://…)"></textarea>
      <div class="btns"><button class="fbtn pri" id="goBtn" onclick="manualConnect()">连接</button></div>
      <div id="qrBox" style="display:none;margin-top:12px"></div>
    </div>
  </details>
</div>

<div class="hint" style="text-align:center;line-height:1.8">
  电脑端:设置 → 手机 → 任意网络直连 → 生成连接码 / 一键临时隧道<br>
  本页可「保存到手机」,以后任何网络打开它即可直连
</div>

<div id="embWrap">
  <div id="embBar">
    <span>📖 完整阅读页(经直连通道)</span>
    <button onclick="closeEmb()">✕ 退出</button>
  </div>
  <iframe id="embFrame" title="完整阅读页"></iframe>
</div>

__QR_LIB__

<script>
__BLOCK_COMPRESS__

__BLOCK_SIGNAL__

__BLOCK_ICE__

// ==================== 编排逻辑 ====================
const IS_FILE = (location.protocol === 'file:' || location.protocol === 'data:');
const VIA = new URLSearchParams(location.search).get('via') || '';
const ST = { pc: null, dc: null, session: '', connected: false, failed: false };
const $ = id => document.getElementById(id);

function setBadge(text, cls) {
  const b = $('badge');
  b.textContent = text;
  b.className = 'badge' + (cls ? ' ' + cls : '');
}
function setStatus(text, cls) {
  const el = $('st');
  el.textContent = text;
  el.className = 'st' + (cls ? ' ' + cls : '');
}
function setActions(html) {
  $('actBtns').innerHTML = html || '';
}

// ---------- WebRTC 握手(自动/手动共用) ----------
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.miwifi.com:3478'];
let reqSeq = 0; const pend = {};
function wrpc(method, path) {
  return new Promise((resolve, reject) => {
    if (!ST.dc || ST.dc.readyState !== 'open') { reject(new Error('直连未建立')); return; }
    const id = ++reqSeq;
    pend[id] = { resolve, reject };
    ST.dc.send(JSON.stringify({ id: id, method: method || 'GET', path: path }));
    setTimeout(() => { if (pend[id]) { delete pend[id]; reject(new Error('请求超时')); } }, 120000);
  });
}
function wireDc(dc) {
  ST.dc = dc;
  const open = () => onP2pUp();
  if (dc.readyState === 'open') open();
  else dc.onopen = open;
  dc.onmessage = ev => {
    let j; try { j = JSON.parse(ev.data); } catch (e) { return; }
    let id = j.id;
    // 嵌入式完整页的请求 id 带 emb- 前缀,转发回 iframe
    if (typeof id === 'string' && id.indexOf('emb-') === 0) {
      const f = $('embFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage({ __emb: 'resp', id: id.slice(4),
        status: j.status, type: j.type, body: j.body, body_b64: j.body_b64,
        content_type: j.content_type, error: j.error }, '*');
      return;
    }
    const p = pend[id];
    if (!p) return;
    delete pend[id];
    if (j.status >= 400) p.reject(new Error(j.error || ('HTTP ' + j.status)));
    else p.resolve(j);
  };
  dc.onclose = () => {
    ST.dc = null; ST.connected = false;
    if (!$('embWrap').classList.contains('show')) {
      setBadge('● 连接断开', 'mid');
      setStatus('直连已断开。可重新扫码,或(若本页经隧道打开)刷新页面继续使用。', 'warn');
    }
  };
}
async function handshake(offerText, sessionId, submit) {
  const m = offerText.match(/novelist-wrtc:\/\/v1\/([\w-]+)/);
  if (!m) throw new Error('连接码格式不正确');
  const b64 = m[1];
  const sdp = await decompressB64(b64);
  if (!sdp || sdp.indexOf('v=') !== 0) throw new Error('连接码无效');
  const hints = parseOfferHints(offerText);
  const ice = [{ urls: (hints && hints.stun && hints.stun.length) ? hints.stun : DEFAULT_STUN }];
  if (hints && hints.turn && hints.turn.urls && hints.turn.urls.length) {
    ice.push({ urls: hints.turn.urls, username: hints.turn.user || '', credential: hints.turn.pass || '' });
  }
  if (ST.pc) { try { ST.pc.close(); } catch (e) {} ST.pc = null; }
  const pc = new RTCPeerConnection({ iceServers: ice });
  ST.pc = pc; ST.session = sessionId; ST.failed = false;
  pc.ondatachannel = ev => wireDc(ev.channel);
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') onP2pUp();
    else if (s === 'failed') onP2pFail();
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  setStatus('正在收集网络候选地址(最多 8 秒)…');
  await waitIceGathering(pc, 8000);
  const answerB64 = await compressStrToB64(pc.localDescription.sdp);
  if (submit === 'http') {
    const r = await fetch('/api/webrtc/answer', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId, answer_b64: answerB64 }) }).then(x => x.json());
    if (!r.ok) throw new Error(r.error || '提交应答失败');
  } else {
    const r = await signalSendAnswer(b64, answerB64, msg => setStatus(msg));
    if (!r.ok) {
      showAnswerQrFallback(answerB64);   // 云端回传失败:亮出应答码二维码,电脑端摄像头扫码兜底
      throw new Error('云端自动回传不可用。请让电脑端「摄像头扫码」对准下方二维码。');
    }
  }
  if (!ST.connected) setStatus('应答已送达,等待 P2P 打通(最多约 20 秒)…');  // DataChannel 可能先行打开
  return true;
}

// ---------- 结果处理 ----------
function onP2pUp() {
  if (ST.connected) return;
  ST.connected = true;
  setBadge('● P2P 直连', 'on');
  const viaNote = IS_FILE ? '' : '<div class="hint">数据已切换为点对点直连' +
    (VIA === 'tunnel' ? ',临时隧道只剩备份作用,可在电脑端停止。' : '。') + '</div>';
  setStatus('✅ P2P 直连已建立,数据不经第三方。', 'ok');
  $('secTitle').textContent = '已连接';
  if (IS_FILE) {
    setActions('<button class="fbtn pri" onclick="loadFullApp()">📖 载入完整阅读页(经直连通道)</button>'
      + '<div class="hint" style="margin-top:8px">完整页会内嵌在本页中打开,API 全部经点对点通道转发,无需任何网络。</div>');
  } else {
    setActions('<button class="fbtn pri" onclick="location.href=\'/mobile\'">📖 打开完整阅读页</button>'
      + '<button class="fbtn" onclick="saveThisPage()">💾 保存本连接文件</button>'
      + viaNote);
  }
}
function onP2pFail() {
  if (ST.failed || ST.connected) return;
  ST.failed = true;
  if (IS_FILE) {
    setBadge('● 打洞失败', '');
    setStatus('P2P 打洞未成功(NAT 限制)。可重试;或改用「热点接力」「公网穿透」方式。', 'warn');
    setActions('<button class="fbtn" onclick="location.reload()">🔄 重试</button>');
  } else {
    // 关键兜底:当前 HTTP 通道(隧道/局域网)仍然可用,功能不受损
    setBadge('● 已连接', 'on');
    setStatus('P2P 打洞未成功(NAT 限制),当前仍经'
      + (VIA === 'tunnel' ? '临时隧道中转' : '网页通道访问') + ' —— 功能完整,速度经中转。', 'ok');
    $('secTitle').textContent = '已连接(中转)';
    setActions('<button class="fbtn pri" onclick="location.href=\'/mobile\'">📖 打开完整阅读页</button>'
      + '<button class="fbtn" onclick="saveThisPage()">💾 保存本连接文件</button>');
  }
}

// ---------- 自动模式(http 来源):信令走当前 HTTP ----------
async function autoConnect() {
  setStatus('正在从电脑获取连接码(经当前连接)…');
  try {
    const offer = await fetch('/api/webrtc/offer').then(r => r.json());
    if (!offer.ok) throw new Error(offer.error || '电脑端未就绪');
    await handshake(offer.offer, offer.session, 'http');
  } catch (e) {
    // aiortc 未安装等情况:当前 HTTP 通道仍可用,不阻塞用户
    setBadge('● 已连接', 'on');
    setStatus('自动 P2P 不可用(' + e.message + ')。当前经'
      + (VIA === 'tunnel' ? '临时隧道中转' : '网页通道') + ',功能完整。', 'ok');
    $('secTitle').textContent = '已连接(中转)';
    setActions('<button class="fbtn pri" onclick="location.href=\'/mobile\'">📖 打开完整阅读页</button>'
      + '<button class="fbtn" onclick="saveThisPage()">💾 保存本连接文件</button>');
  }
}

// ---------- 手动模式(file:// 或重试):扫一次码 + 云端自动回传 ----------
async function manualConnect() {
  const offerText = ($('offerText').value || '').trim();
  const goBtn = $('goBtn');
  if (!offerText) { setStatus('请先扫码或粘贴电脑屏幕上的连接码', 'warn'); return; }
  goBtn.disabled = true;
  try {
    await handshake(offerText, 'manual', 'mqtt');
  } catch (e) {
    setStatus('连接失败: ' + e.message, 'warn');
  } finally {
    goBtn.disabled = false;
  }
}
async function scanOffer() {
  // 摄像头只能在安全上下文(https / localhost / 本地文件)调用:
  // 经 http://局域网IP 打开时浏览器会直接禁止,必须给出替代指引。
  if (!window.isSecureContext || !navigator.mediaDevices) {
    setStatus('浏览器禁止在 http 页面调用摄像头(仅 https / 本地文件可用)。'
      + (IS_FILE ? '' : '本场景一般无需扫码:经网络打开本页时会自动连接;')
      + '也可用系统相机扫连接码后复制粘贴到下方。', 'warn');
    return;
  }
  if (!('BarcodeDetector' in window)) {
    setStatus('当前浏览器不支持页内扫码(需 Chrome/Edge)。请用系统相机扫电脑屏幕上的连接码,复制后粘贴到下方', 'warn');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scanVideo');
    video.srcObject = stream;
    $('scanArea').classList.remove('hide');
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const timer = setInterval(async () => {
      try {
        const codes = await det.detect(video);
        for (const c of codes) {
          const raw = (c.rawValue || '').trim();
          if (raw.indexOf('novelist-wrtc://') >= 0) {
            clearInterval(timer);
            stream.getTracks().forEach(t => t.stop());
            $('scanArea').classList.add('hide');
            $('offerText').value = raw;
            manualConnect();
            return;
          }
        }
      } catch (e) { /* 单帧失败忽略 */ }
    }, 400);
  } catch (e) {
    setStatus('无法打开摄像头: ' + e.message, 'warn');
  }
}
// 手动模式失败时的兜底二维码(供电脑摄像头扫)
async function showAnswerQrFallback(answerB64) {
  const box = $('qrBox');
  try {
    const qr = qrcode(0, 'L');
    qr.addData('novelist-wrtc://v1/' + answerB64);
    qr.make();
    box.innerHTML = '<img src="' + qr.createDataURL(4, 4) + '" alt="应答二维码">';
    box.style.display = '';
  } catch (e) { /* 忽略 */ }
}

// ---------- 完整阅读页:file:// 模式经直连通道内嵌载入 ----------
let embBusy = false;
async function loadFullApp() {
  if (embBusy) return;
  embBusy = true;
  setStatus('正在经直连通道载入完整阅读页…');
  try {
    const resp = await wrpc('GET', '/mobile');
    if (resp.type !== 'b64') throw new Error('完整页获取失败');
    const bin = atob(resp.body_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let html = new TextDecoder().decode(bytes);
    // 注入嵌入标志:完整页的 API 请求改为 postMessage,由本页经 DataChannel 转发
    html = html.replace('</head>', '<script>window.__EMB__=1;<\\/script></head>');
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    $('embFrame').src = url;
    $('embWrap').classList.add('show');
    setStatus('完整阅读页已载入(数据经 P2P 直连)。', 'ok');
  } catch (e) {
    setStatus('载入失败: ' + e.message, 'warn');
  } finally {
    embBusy = false;
  }
}
// 转发完整页(iframe)的 API 请求到 DataChannel
window.addEventListener('message', ev => {
  if (ev.source !== $('embFrame').contentWindow) return;
  const d = ev.data;
  if (d && d.__emb === 'req') {
    if (!ST.dc || ST.dc.readyState !== 'open') {
      $('embFrame').contentWindow.postMessage({ __emb: 'resp', id: d.id,
        status: 502, error: '直连未建立' }, '*');
      return;
    }
    const msg = { id: 'emb-' + d.id, method: d.method || 'GET', path: d.path };
    if (d.query) msg.query = d.query;
    if (d.body_b64) { msg.body_b64 = d.body_b64; msg.content_type = d.content_type; }
    ST.dc.send(JSON.stringify(msg));
  }
});
function closeEmb() {
  $('embWrap').classList.remove('show');
  $('embFrame').src = 'about:blank';
}

// ---------- 保存本连接文件(http 模式) ----------
function saveThisPage() {
  const a = document.createElement('a');
  a.href = '/direct?dl=1';
  a.download = '漫画+小说-远程直连.html';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- 启动 ----------
(function boot() {
  const modeHint = $('modeHint');
  if (IS_FILE) {
    modeHint.innerHTML = '本页是「连接文件」:电脑生成连接码后,点下方扫码(或粘贴)即可与电脑建立点对点直连。';
    setBadge('● 未连接', '');
    setStatus('等待扫码或粘贴连接码…');
    $('manualBox').open = true;
  } else if (VIA === 'tunnel') {
    modeHint.innerHTML = '本页经<b>临时隧道</b>加载:正在自动与电脑建立 P2P 直连(信令走隧道,数据走直连);若打洞不成功会自动保持隧道中转。';
    setBadge('● 连接中', 'mid');
    autoConnect();
  } else {
    modeHint.innerHTML = '本页由电脑直接提供:正在自动建立 P2P 直连(信令走当前连接,数据走直连)。';
    setBadge('● 连接中', 'mid');
    autoConnect();
  }
})();
</script>
</body>
</html>
'''

out = (template
       .replace('__QR_LIB__', qr_lib)
       .replace('__BLOCK_COMPRESS__', block_compress)
       .replace('__BLOCK_SIGNAL__', block_signal)
       .replace('__BLOCK_ICE__', block_ice))

io.open(os.path.join(ROOT, 'static', 'direct.html'), 'w', encoding='utf-8').write(out)
print('direct.html written:', len(out), 'chars')
print('has qr lib:', 'QR Code Generator' in out)
print('has signal:', 'SIGNAL_BROKERS' in out)
print('has sha256:', 'function sha256Hex' in out)
print('has ice:', 'function waitIceGathering' in out)
print('has compress:', 'function compressStrToB64' in out)
