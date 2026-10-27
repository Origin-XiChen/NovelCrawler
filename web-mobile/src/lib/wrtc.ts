/**
 * 任意网络直连(WebRTC DataChannel)
 * ============================
 * 电脑生成连接码(压缩 SDP)→ 手机扫码生成应答码 → 经公共 MQTT 主题自动回传。
 * 通道建立后,所有 /api 请求以 JSON 走 DataChannel,电脑端再转发给本机 HTTP 服务。
 * 通道只存在于当前页面生命周期,手机刷新后必须重新扫码。
 */
import type { PairResult, ServerEntry } from './types';

export interface WrtcResponse {
  status: number;
  type: 'json' | 'b64';
  body?: unknown;
  body_b64?: string;
  content_type?: string;
  error?: string;
}

export interface WrtcHandshake {
  session: string;
  /** 手动兜底:把这段应答码粘贴到电脑端「兜底方式」 */
  answerCode: string;
  autoSent: boolean;
  wait: (timeoutMs?: number) => Promise<void>;
}

interface PhoneHints {
  stun?: string[];
  turn?: { urls?: string[]; user?: string; pass?: string };
}

interface Pending {
  resolve: (res: WrtcResponse) => void;
  reject: (err: Error) => void;
  timer: number;
}

interface Link {
  session: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pending: Map<number, Pending>;
  openers: Set<() => void>;
  failers: Set<(err: Error) => void>;
  closed: boolean;
}

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.miwifi.com:3478',
];

const SIGNAL_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

let link: Link | null = null;
let seq = 0;

export function wrtcAlive(): boolean {
  return Boolean(link && !link.closed && link.dc?.readyState === 'open');
}

export function closeWrtc(): void {
  const current = link;
  link = null;
  if (!current) return;
  current.closed = true;
  const error = new Error('直连已断开，请重新扫描电脑连接码');
  current.failers.forEach((fn) => fn(error));
  current.failers.clear();
  current.openers.clear();
  current.pending.forEach((item) => {
    window.clearTimeout(item.timer);
    item.reject(error);
  });
  current.pending.clear();
  try {
    current.pc.close();
  } catch {
    // 已关闭
  }
}

function toBytes(b64: string): Uint8Array<ArrayBuffer> {
  let text = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(bin);
}

/** 应答码要放进 novelist-wrtc://v1/ 后面,必须用 urlsafe base64,与电脑端 encode_sdp 对齐。 */
function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64ToBlob(b64: string, type: string): Blob {
  return new Blob([toBytes(b64)], { type: type || 'application/octet-stream' });
}

async function decompressB64(b64: string): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前 WebView 不支持 zlib 解压，请更新 Android System WebView 或改用热点/公网穿透');
  }
  try {
    const stream = new Blob([toBytes(b64)]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buffer);
  } catch {
    throw new Error('连接码内容损坏，请在电脑上重新生成');
  }
}

async function compressStrToB64(text: string): Promise<string> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前 WebView 不支持 zlib 压缩，请更新 Android System WebView 或改用热点/公网穿透');
  }
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return bytesToB64Url(new Uint8Array(buffer));
}

function parseHints(offerText: string): PhoneHints | null {
  try {
    const index = offerText.indexOf('#');
    if (index < 0) return null;
    const raw = offerText.slice(index + 1).trim();
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(toBytes(raw))) as PhoneHints;
  } catch {
    return null;
  }
}

function waitIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

// ---------------- 信令:MQTT over WebSocket(仅 CONNECT/PUBLISH) ----------------
function mqttString(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(bytes.length + 2);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 255;
  out.set(bytes, 2);
  return out;
}

function mqttFixed(flags: number, body: Uint8Array): Uint8Array {
  const rem: number[] = [];
  let length = body.length;
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length) digit |= 0x80;
    rem.push(digit);
  } while (length);
  const out = new Uint8Array(1 + rem.length + body.length);
  out[0] = flags;
  out.set(rem, 1);
  out.set(body, 1 + rem.length);
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function mqttConnect(clientId: string): Uint8Array {
  const name = mqttString('MQTT');
  const body = new Uint8Array(name.length + 4);
  body.set(name, 0);
  body[name.length] = 4; // MQTT 3.1.1
  body[name.length + 1] = 0x02; // clean session
  body[name.length + 2] = 0;
  body[name.length + 3] = 60;
  return mqttFixed(0x10, concatBytes(body, mqttString(clientId)));
}

function mqttPublish(topic: string, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  return mqttFixed(0x30, concatBytes(mqttString(topic), payload));
}

function publishOnce(url: string, topic: string, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, 'mqtt');
    } catch {
      reject(new Error('连接失败'));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error('超时'));
    }, timeoutMs);
    const done = (fn: () => void) => {
      window.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      fn();
    };
    ws.onopen = () => {
      ws.send(mqttConnect(`nvl-m-${Math.random().toString(36).slice(2, 10)}`));
    };
    ws.onmessage = (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes[0] !== 0x20) return;
      if (bytes.length < 4 || bytes[3] !== 0) {
        done(() => reject(new Error('中继拒绝了连接')));
        return;
      }
      ws.send(mqttPublish(topic, text));
      window.setTimeout(() => done(resolve), 500);
    };
    ws.onerror = () => done(() => reject(new Error('连接失败')));
  });
}

async function signalSendAnswer(
  offerB64: string,
  answerB64: string,
  onState?: (message: string) => void,
): Promise<boolean> {
  const topic = `novelist-wrtc/v1/${sha256Hex(offerB64).slice(0, 24)}`;
  const payload = `novelist-wrtc-answer://v1/${answerB64}`;
  for (const url of SIGNAL_BROKERS) {
    const host = url.replace(/^wss:\/\//, '').split(':')[0];
    try {
      onState?.(`正在经云端把应答码送回电脑(${host})…`);
      await publishOnce(url, topic, payload, 8000);
      return true;
    } catch {
      // 换下一个 broker
    }
  }
  return false;
}

// 纯 JS SHA-256:连接码经 http 打开时没有 crypto.subtle,不能依赖安全上下文。
function sha256Hex(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  const length = text.length;
  const words: number[] = [];
  for (let i = 0; i < length; i += 1) {
    words[i >> 2] = (words[i >> 2] || 0) | (text.charCodeAt(i) << (24 - (i % 4) * 8));
  }
  words[length >> 2] = (words[length >> 2] || 0) | (0x80 << (24 - (length % 4) * 8));
  const blocks = Math.ceil((length + 9) / 64);
  for (let i = words.length; i < blocks * 16; i += 1) words[i] = 0;
  words[blocks * 16 - 1] = length * 8;
  const w = new Array<number>(64);
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < 16; i += 1) w[i] = words[b * 16 + i] | 0;
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    H = [
      (H[0] + a) | 0, (H[1] + bb) | 0, (H[2] + c) | 0, (H[3] + d) | 0,
      (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0,
    ];
  }
  return H.map((value) => `00000000${(value >>> 0).toString(16)}`.slice(-8)).join('');
}

// ---------------- 握手 ----------------
export async function prepareWrtc(
  offerText: string,
  onState?: (message: string) => void,
): Promise<WrtcHandshake> {
  const match = String(offerText || '').match(/novelist-wrtc:\/\/v1\/([\w-]+)/);
  if (!match) throw new Error('连接码格式不正确，请扫描电脑「任意网络直连」里的二维码');
  const offerB64 = match[1];
  onState?.('正在解析连接码…');
  const sdp = await decompressB64(offerB64);
  if (!sdp.startsWith('v=')) throw new Error('连接码无效，请在电脑上重新生成');

  closeWrtc();
  const hints = parseHints(offerText);
  const iceServers: RTCIceServer[] = [
    { urls: hints?.stun?.length ? hints.stun : DEFAULT_STUN },
  ];
  if (hints?.turn?.urls?.length) {
    iceServers.push({
      urls: hints.turn.urls,
      username: hints.turn.user || '',
      credential: hints.turn.pass || '',
    });
  }
  const pc = new RTCPeerConnection({ iceServers });
  const state: Link = {
    session: `m${Date.now().toString(36)}`,
    pc,
    dc: null,
    pending: new Map(),
    openers: new Set(),
    failers: new Set(),
    closed: false,
  };
  link = state;

  const handleMessage = (event: MessageEvent) => {
    let data: WrtcResponse & { id?: number };
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof data.id !== 'number') return;
    const pending = state.pending.get(data.id);
    if (!pending) return;
    state.pending.delete(data.id);
    window.clearTimeout(pending.timer);
    pending.resolve(data);
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    state.dc = channel;
    channel.onmessage = handleMessage;
    const opened = () => {
      if (state.closed) return;
      state.openers.forEach((fn) => fn());
      state.openers.clear();
    };
    if (channel.readyState === 'open') opened();
    else channel.onopen = opened;
    channel.onclose = () => {
      if (state.closed) return;
      state.closed = true;
      const error = new Error('直连已断开，请重新扫描电脑连接码');
      state.failers.forEach((fn) => fn(error));
      state.failers.clear();
      state.pending.forEach((item) => {
        window.clearTimeout(item.timer);
        item.reject(error);
      });
      state.pending.clear();
      if (link === state) link = null;
    };
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !state.closed) {
      const error = new Error('点对点打洞失败，请重试一次，或改用「热点接力 / 公网穿透」');
      state.failers.forEach((fn) => fn(error));
      state.failers.clear();
    }
  };

  onState?.('正在建立点对点通道…');
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  onState?.('正在收集网络候选地址（最多 8 秒）…');
  await waitIceGathering(pc, 8000);
  const answerB64 = await compressStrToB64(pc.localDescription?.sdp || '');
  const answerCode = `novelist-wrtc://v1/${answerB64}`;
  onState?.('正在经云端把应答码送回电脑…');
  const autoSent = await signalSendAnswer(offerB64, answerB64, onState);

  const wait = (timeoutMs = 30000) =>
    new Promise<void>((resolve, reject) => {
      if (state.dc?.readyState === 'open') {
        resolve();
        return;
      }
      if (state.closed) {
        reject(new Error('直连已断开，请重新扫描电脑连接码'));
        return;
      }
      const timer = window.setTimeout(() => {
        state.openers.delete(onOpen);
        state.failers.delete(onFail);
        reject(new Error('等待电脑接通超时，可点「继续等待」，或改用其他连接方式'));
      }, timeoutMs);
      const onOpen = () => {
        window.clearTimeout(timer);
        state.failers.delete(onFail);
        resolve();
      };
      const onFail = (error: Error) => {
        window.clearTimeout(timer);
        state.openers.delete(onOpen);
        reject(error);
      };
      state.openers.add(onOpen);
      state.failers.add(onFail);
    });

  return { session: state.session, answerCode, autoSent, wait };
}

export async function pairOverWrtc(deviceId: string, deviceName: string): Promise<PairResult> {
  if (!wrtcAlive()) throw new Error('直连通道未建立，请重新扫码');
  const start = await wrtcRequest({
    method: 'POST',
    path: '/api/mobile/pair/start',
    body: {},
  });
  if (start.status >= 400) throw new Error(start.error || '电脑没有生成配对码');
  const code = String((start.body as { code?: string } | undefined)?.code || '');
  if (!/^\d{6}$/.test(code)) throw new Error('电脑返回的配对码异常，请升级桌面端');
  const confirm = await wrtcRequest({
    method: 'POST',
    path: '/api/mobile/pair/confirm',
    body: { code, device_id: deviceId, device_name: deviceName },
  });
  if (confirm.status >= 400) throw new Error(confirm.error || '直连配对失败');
  const result = confirm.body as PairResult;
  if (!result?.ok || !result.token) throw new Error(result?.error || '电脑返回的配对信息不完整');
  return result;
}

export interface WrtcRequestInput {
  method?: string;
  path: string;
  query?: string;
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

export function wrtcRequest(input: WrtcRequestInput): Promise<WrtcResponse> {
  const current = link;
  if (!current || current.closed || current.dc?.readyState !== 'open') {
    return Promise.reject(new Error('直连已断开，请重新扫描电脑连接码'));
  }
  const id = ++seq;
  const message: Record<string, unknown> = {
    id,
    method: (input.method || 'GET').toUpperCase(),
    path: input.path,
    query: input.query || '',
  };
  if (input.token) message.token = input.token;
  if (input.body !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(input.body));
    message.body_b64 = bytesToB64(bytes);
    message.content_type = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      current.pending.delete(id);
      reject(new Error('直连请求超时'));
    }, input.timeoutMs || 120000);
    current.pending.set(id, { resolve, reject, timer });
    try {
      current.dc?.send(JSON.stringify(message));
    } catch (cause) {
      window.clearTimeout(timer);
      current.pending.delete(id);
      reject(cause instanceof Error ? cause : new Error('直连发送失败'));
    }
  });
}

/** 校验配对状态后供 ConnectPage 使用:直连会话只活在当前页面 */
export function wrtcServerAlive(server: ServerEntry): boolean {
  return server.transport === 'wrtc' && wrtcAlive();
}
