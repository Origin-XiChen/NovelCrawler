export interface ServerEntry {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  api: number;
  version: string;
  lastUsed: number;
  /** http=局域网/热点/隧道直连;wrtc=WebRTC 数据通道(仅当前页面有效) */
  transport?: 'http' | 'wrtc';
  /**
   * 同一台电脑的全部候选地址(基址 + 二维码 alt + 配对响应下发)。
   * 校园网/AP 隔离下某个地址连不通时,请求失败会自动换到下一个可用的。
   */
  candidates?: string[];
  /**
   * 自签 HTTPS 的 CA 短指纹(base64url 128 位)。来自配对二维码这条可信通道,
   * 手机据此校验第一次取回的电脑 CA —— 对不上就是有人在中间冒充。
   */
  pin?: string;
  /** 这台电脑内建 SSH 通道的账号(user@host:port),空串表示没有 */
  ssh?: string;
  /** 如果当前是通过 SSH 隧道连的,记录隧道信息 & 断开后回退用的原始地址 */
  sshTunnel?: { target: string; localPort: number; via: string };
  /** 内建 sshd 密码(配对时由二维码带来,断线重连免手输) */
  sshPassword?: string;
}

export interface PingResult {
  ok: boolean;
  name?: string;
  version?: string;
  api?: number;
  auth?: string;
  capabilities?: string[];
  mobile_build?: string;
}

export interface MobileDevice {
  id: string;
  name: string;
  created: number;
  last_seen: number;
  last_ip: string;
  online: boolean;
}

export interface ServerSummary {
  name: string;
  version: string;
  api: number;
  capabilities?: string[];
  /** 电脑端下发的全部候选地址(热点/无线/虚拟组网) */
  candidates?: string[];
  /** 是否走自签 HTTPS */
  https?: boolean;
  /** 电脑端 CA 短指纹(手机据此固定证书) */
  pin?: string;
  /** 电脑端内建 SSH 通道账号(user@host:port) */
  ssh?: string;
  /** 内建 sshd 密码(配对时由二维码带来,便于断线重连免手输) */
  sshPassword?: string;
}

export interface PairResult {
  ok: boolean;
  token?: string;
  device?: MobileDevice;
  server?: ServerSummary;
  error?: string;
  code?: string;
}

export interface FileEntry {
  name: string;
  size: number;
  cover_url?: string;
}

export interface ComicFileGroup {
  title: string;
  dir: string;
  files: number;
  size: number;
  pdfs: string[];
  cover_url?: string;
  meta?: Record<string, unknown> | null;
}

export interface ChapterRef {
  idx: number;
  title: string;
  volume?: string;
  path?: string;
}

export interface NovelMeta {
  title?: string;
  total?: number;
  chapters: ChapterRef[];
}

export interface NovelChapter {
  title?: string;
  text?: string;
  html?: string;
}

export interface ComicPdfMeta {
  ok: boolean;
  meta?: Record<string, unknown> | null;
  pdfs: string[];
  current?: Record<string, unknown>;
}

export interface ComicPageMeta {
  ok: boolean;
  num_pages: number;
}

export interface DeviceList {
  ok: boolean;
  devices: MobileDevice[];
}

export interface PairPayload {
  baseUrl: string;
  code: string;
  name?: string;
  /** 二维码 alt 参数携带的备用地址(不含主地址) */
  candidates?: string[];
  /** 二维码携带的 CA 短指纹(https 时用于固定证书) */
  pin?: string;
  /** 二维码携带的 SSH 通道账号(user@host:port),用于内建隧道 */
  ssh?: string;
  /** 二维码携带的内建 sshd 密码(仅内建服务端才有,扫码即用) */
  sshPassword?: string;
}
