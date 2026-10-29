const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const log = require('./logger');

/**
 * 应用内更新下载器（自建，替代 electron-updater 的下载链路）。
 *
 * 为什么不用 autoUpdater.downloadUpdate：
 *   它用分段/差分下载，遇到重试会把 download-progress 从 0 重新报一遍，
 *   界面上就是「下到 100% 又归零」；而 quitAndInstall 在安装器被取消或
 *   文件被占用时会静默失败，重启后还是旧版本。
 *
 * 这里做三件事，全程可控：
 *   1) check —— 走 GitHub Releases API 自己找最新一版（支持 Dev 预发布通道）；
 *   2) download —— HTTPS 直下 + Range 断点续传，进度按"已落盘字节"计算，只增不减；
 *   3) install —— 校验通过后调系统安装器（NSIS 向导），并退出应用让文件解锁。
 */

/**
 * 网络层优先走 Electron 的 net 模块：它用 Chromium 网络栈 + **系统证书库**。
 * 校园网/公司网常做 TLS 中间人，Node 自带的 CA 列表不认那张根证书，
 * 直接用 https 会报 `unable to verify the first certificate`；Chromium 栈没这个问题。
 * 测试环境（纯 Node）没有 net，自动回退到 https。
 */
let electronNet = null;
try {
  // eslint-disable-next-line global-require
  electronNet = require('electron').net || null;
} catch {
  electronNet = null;
}

const OWNER = 'Origin-XiChen';
const REPO = 'NovelCrawler';
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const USER_AGENT = 'NovelCrawler-Desktop';
const MAX_ATTEMPTS = 6;

/** 语义化比较:1.7.9-dev.2 < 1.7.9-dev.10 < 1.7.9 */
function compareVersion(a, b) {
  const split = (v) => {
    const text = String(v || '').replace(/^v/i, '');
    const [core, pre] = text.split('-');
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const dev = pre ? pre.replace(/^dev\.?/i, '') : '';
    // 没有预发布标记就是正式版：semver 里正式版大于同号的所有预发布，
    // 所以用 null 表示「比任何 dev 号都大」，不能用 -1。
    return { nums, dev: dev ? Number.parseInt(dev, 10) || 0 : null };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (diff !== 0) return diff;
  }
  if (left.dev === null && right.dev === null) return 0;
  if (left.dev === null) return 1;
  if (right.dev === null) return -1;
  return left.dev - right.dev;
}

/**
 * 发一个 GET，返回 { statusCode, headers, stream }。
 * 重定向自己跟（最多 8 跳），这样 Range 头能原样带到最终的 S3 地址上 ——
 * 交给底层自动跟随的话，部分实现会丢掉 Range，续传就退化成从 0 重下。
 */
function openStream(url, extraHeaders = {}, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('重定向次数过多'));

  if (electronNet) {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = electronNet.request({
          method: 'GET',
          url,
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT, ...extraHeaders },
        });
      } catch (error) {
        reject(new Error(`请求发送失败：${error.message}`));
        return;
      }
      request.on('response', (response) => {
        const status = response.statusCode || 0;
        const header = (name) => {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        };
        if (status >= 300 && status < 400 && header('location')) {
          const next = new URL(header('location'), url).toString();
          response.on('data', () => {});
          response.on('end', () => {
            resolve(openStream(next, extraHeaders, redirects + 1));
          });
          response.on('error', () => resolve(openStream(next, extraHeaders, redirects + 1)));
          return;
        }
        resolve({
          statusCode: status,
          headers: {
            'content-length': header('content-length'),
            'content-range': header('content-range'),
          },
          stream: response,
        });
      });
      request.on('error', (error) => reject(new Error(`网络错误：${error.message}`)));
      request.setTimeout?.(30000, () => request.abort());
      request.end();
    });
  }

  // 回退：纯 Node 环境（单元测试 / net 不可用）
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': USER_AGENT, ...extraHeaders };
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(openStream(new URL(res.headers.location, url).toString(), extraHeaders, redirects + 1));
        return;
      }
      resolve({
        statusCode: status,
        headers: {
          'content-length': res.headers['content-length'],
          'content-range': res.headers['content-range'],
        },
        stream: res,
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.on('error', (error) => reject(new Error(`网络错误：${error.message}`)));
  });
}

/** GET JSON（GitHub API） */
async function getJson(url) {
  const { statusCode, stream } = await openStream(url, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  if (statusCode !== 200) {
    stream.resume();
    const hint =
      statusCode === 403 || statusCode === 429
        ? 'GitHub 接口限流，请稍后再试'
        : statusCode === 404
          ? '找不到发布记录，请确认仓库可访问'
          : `GitHub 接口返回 ${statusCode}`;
    throw new Error(hint);
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error(`发布信息解析失败：${error.message}`);
  }
}

/**
 * 查最新可更新版本。
 * allowPrerelease=true 时把预发布（Dev）也纳入候选。
 * 返回 null 表示已是最新。
 */
async function checkUpdate(allowPrerelease) {
  // GitHub 的 releases 列表顺序并不严格按时间（实测 dev.10 排在 dev.9 之后），
  // 所以取足够多的条数后由 pickLatest 自己比版本，不依赖顺序。
  const list = await getJson(`${API_BASE}/releases?per_page=100`);
  return pickLatest(list, app.getVersion(), allowPrerelease);
}

/**
 * 从 release 列表里挑出可升级的最高版本（纯函数，便于单测）。
 * 规则：跳过 draft；稳定通道跳过 prerelease；必须有版本严格高于当前的
 * `NovelCrawler-Setup-*.exe` 资产，且资产名版本 == tag。
 */
function pickLatest(list, current, allowPrerelease) {
  let best = null;
  for (const release of Array.isArray(list) ? list : []) {
    if (!release || release.draft) continue;
    if (release.prerelease && !allowPrerelease) continue;
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!version || compareVersion(version, current) <= 0) continue;
    // 只认桌面安装包：手机 APK 命名不同，别拿来当更新源
    const asset = (release.assets || []).find((item) =>
      /^NovelCrawler-Setup-.*\.exe$/i.test(item.name || ''),
    );
    if (!asset) continue;
    // 资产名里的版本必须与 tag 一致，否则下了也装不出新版本（会变成更新死循环）
    const assetVersion =
      (asset.name || '').match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.exe$/i)?.[1] || '';
    if (assetVersion && compareVersion(assetVersion, version) !== 0) continue;
    if (!best || compareVersion(version, best.version) > 0) {
      best = {
        version,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
        // GitHub 新版接口会给 "sha256:..."；老资产没有就只校验体积
        digest: String(asset.digest || ''),
        notes: typeof release.body === 'string' ? release.body.slice(0, 2000) : '',
      };
    }
  }
  return best;
}

function updateDir() {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 安装包落地路径（按版本命名） */
function installerPath(version) {
  return path.join(updateDir(), `NovelCrawler-Setup-${version.replace(/[^\w.-]/g, '_')}.exe`);
}

/** 清掉除当前版本外的旧安装包与 .part，避免占硬盘 */
function pruneOldInstallers(keepName) {
  try {
    for (const name of fs.readdirSync(updateDir())) {
      if (name === keepName) continue;
      if (/^NovelCrawler-Setup-.*\.exe(\.part)?$/i.test(name)) {
        fs.rmSync(path.join(updateDir(), name), { force: true });
      }
    }
  } catch (error) {
    log.warn('[update] 清理旧安装包失败', error);
  }
}

/**
 * 把一段响应流写进 .part 文件。
 * @returns {Promise<{total:number, resumed:boolean}>}
 */
async function writeStream(stream, dest, offset, contentLength, contentRange, onProgress) {
  let total = 0;
  if (contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match) total = Number(match[1]) || 0;
  }
  if (!total) total = offset + (Number(contentLength) || 0);

  const file = fs.createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' });
  let written = offset;
  let lastAt = Date.now();
  let lastBytes = written;
  let lastEmitBytes = written;
  let bps = 0;

  const emit = (force = false) => {
    const now = Date.now();
    const dt = (now - lastAt) / 1000;
    if (dt >= 0.4) {
      bps = Math.max(0, Math.round((written - lastBytes) / dt));
      lastAt = now;
      lastBytes = written;
    }
    // 快链路上 200ms 可能已下几十 MB，光靠时间节流会让进度条"跳一大格"；
    // 再按每 1MB 补一次，慢链路仍由时间节流兜底。
    if (force || dt >= 0.2 || written - lastEmitBytes >= 1024 * 1024) {
      lastEmitBytes = written;
      onProgress({ transferred: written, total: total || written, bytesPerSecond: bps });
    }
  };

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      written += chunk.length;
      emit();
    });
    stream.on('error', (error) => {
      file.destroy();
      reject(error);
    });
    file.on('error', (error) => {
      stream.destroy();
      reject(error);
    });
    file.on('finish', () => {
      emit(true);
      resolve();
    });
    stream.pipe(file);
  });

  return { total: total || written, resumed: offset > 0 };
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * 下载安装包（支持断点续传，进度只增不减）。
 *
 * @param {{version:string,url:string,size?:number,digest?:string}} target
 * @param {(p:{percent:number,transferred:number,total:number,bytesPerSecond:number})=>void} onProgress
 * @returns {Promise<string>} 安装包本地路径
 */
async function download(target, onProgress) {
  const dest = installerPath(target.version);
  const part = `${dest}.part`;
  const expected = Number(target.size) || 0;

  // 已下完且体积对得上：直接复用，避免重复下 200MB
  try {
    if (fs.existsSync(dest) && (!expected || fs.statSync(dest).size === expected)) {
      onProgress({ percent: 100, transferred: expected, total: expected, bytesPerSecond: 0 });
      return dest;
    }
  } catch (error) {
    log.warn('[update] 检查已下载安装包失败', error);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let offset = 0;
    try {
      offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    } catch {
      offset = 0;
    }
    if (expected && offset > expected) {
      // .part 比目标还大：只能重下
      fs.rmSync(part, { force: true });
      offset = 0;
    }
    if (expected && offset === expected) break;

    const report = (payload) => {
      const total = expected || payload.total || 0;
      const transferred = total ? Math.min(payload.transferred, total) : payload.transferred;
      const percent = total ? Math.min(100, (transferred / total) * 100) : 0;
      onProgress({
        percent: Math.round(percent * 10) / 10,
        transferred,
        total,
        bytesPerSecond: payload.bytesPerSecond || 0,
      });
    };
    try {
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const { statusCode, headers: resHeaders, stream } = await openStream(target.url, headers);
      if (statusCode === 416) {
        // 服务器认为范围越界：本地 .part 已经完整
        stream.resume();
        lastError = null;
        break;
      }
      if (statusCode !== 200 && statusCode !== 206) {
        stream.resume();
        throw new Error(`下载失败：HTTP ${statusCode}`);
      }
      // 服务器忽略 Range（回 200）时必须从头写，否则会拼出坏文件
      const start = statusCode === 206 ? offset : 0;
      if (start !== offset) {
        fs.rmSync(part, { force: true });
      }
      await writeStream(stream, part, start, resHeaders['content-length'], resHeaders['content-range'], report);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      log.warn(`[update] 第 ${attempt} 次下载失败，准备续传`, error.message);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }

  if (lastError) throw new Error(`下载安装包失败：${lastError.message}`);

  let size = 0;
  try {
    size = fs.statSync(part).size;
  } catch {
    throw new Error('安装包没有落盘，请重试');
  }
  if (expected && size !== expected) {
    throw new Error(`安装包不完整（${size}/${expected} 字节），请重试`);
  }

  // GitHub 提供 sha256 时做完整性校验，避免把半截文件丢给安装器
  const digest = String(target.digest || '').toLowerCase();
  if (digest.startsWith('sha256:')) {
    const actual = await sha256Of(part);
    if (actual !== digest.slice(7)) {
      fs.rmSync(part, { force: true });
      throw new Error('安装包校验失败（sha256 不匹配），已删除，请重试');
    }
  }

  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  pruneOldInstallers(path.basename(dest));
  onProgress({ percent: 100, transferred: size, total: size, bytesPerSecond: 0 });
  return dest;
}

/** 调系统安装器：拉起 NSIS 向导并退出应用（否则安装时文件被占用会失败） */
function install(file) {
  const target = file || '';
  if (!target || !fs.existsSync(target)) {
    throw new Error('安装包不存在，请重新下载');
  }
  const child = spawn(target, [], { detached: true, stdio: 'ignore' });
  child.unref();
  log.info('[update] 已启动安装程序', target);
  // 稍等让安装器先起来，再退出以解锁程序文件
  setTimeout(() => app.quit(), 1200);
  return true;
}

module.exports = { compareVersion, checkUpdate, pickLatest, download, install, installerPath };
