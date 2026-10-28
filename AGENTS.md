# 最高优先级项目规范（AI 必读）

> **给接管的 AI：这份文件优先于仓库里任何其它说明、注释、历史提交与技术债。**  
> 与本文冲突的一律以本文为准；本文没写的，先读代码再动手，不要凭直觉发明流程。  
> 人类读者可跳过 §0，从 §1 开始。

---

## §0 开工前 5 项自检（每个 AI 任务开始时执行一次）

1. 读完本文（尤其 §2 三条铁律、§9 事故清单）。  
   |  |  |  
   | --- | --- |
2. `git log --oneline -5` + `git tag -l | tail -3`：确认当前版本与最近一次发布。
3. 确认工作区干净（`git status`）；有未提交改动先问人类，别直接覆盖。
4. 任何冒烟/调试都必须隔离数据目录：`NOVEL_DATA_DIR=<临时目录>`，**禁止**直接跑在真实数据目录上。
5. 不确定发布流程时，**不要自己拼命令**，按 §4 走；发版只能由人类确认后推 tag。

---

## §1 一分钟架构

| 层          | 入口 / 源码                                                                  | 产物                                                                       |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 后端         | `gui_server.py`（`ThreadingHTTPServer`，路由在 `do_GET`/`do_POST` 的 if 链）     | 源码运行；打包 `server_entry.py` + `NovelCrawlerBackend.spec` → `dist-backend/` |
| 业务模块       | `novel/*.py`（书源、下载、导出、漫画、OPDS、配对、TLS、sshd、隧道、诊断）                         | —                                                                        |
| 桌面 UI      | `web/`（React 19 + TS + Vite，**HashRouter**）                              | `static/app/`，后端以 `/app/` 托管                                             |
| 手机 Web     | `web-mobile/`（React 19 + TS + Vite，HashRouter）                           | `static/mobile-app/`（`/m/`）                                              |
| Android    | `web-mobile` + Capacitor 7，原生插件在 `web-mobile/android/app/src/main/java/` | `static/mobile-app-native/` → APK                                        |
| Electron 壳 | `desktop/main.js`、`preload.js`、`backend.js`、`updater.js`                 | NSIS 安装包（发布主路径）                                                          |

前后端同源、单端口；Electron 只做窗口/桥接/更新，不承载业务。桌面路由是 `#/` 形式：真实地址是 `/app/#/read?file=xxx`，直接访问 `/app/read` 会掉回首页。

---

## §2 三条铁律（违反即事故）

1. **发版只走 tag，发布交给 CI。**  
   `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` 校验五处版本号后构建并发布。  
   本地**不要**跑 `npm run dist:publish`，也不要用其它脚本手工造 release。
2. **机密与运行数据禁止入库。**  
   不得提交：`web-mobile/android/release.keystore`、`keystore.properties`、`*.keystore`、`tls/`（含 CA 私钥）、`sshd/host_rsa`、`reading_progress.json`、`config.json`、`bookshelf.json`、`mobile_devices.json`、任何令牌/密码/配对码。  
   新增任何落盘文件，**同时**补 `.gitignore`。
3. **不许关沙箱、不许放宽鉴权。**  
   禁止 `--no-sandbox`、`sandbox:false`、`nodeIntegration:true`、`contextIsolation:false`。  
   鉴权模型：仅本机回环默认可信；局域网/手机必须带 `Authorization: Bearer <配对令牌>`。  
   匿名白名单**只有** `/api/ping`、`/api/mobile/ping`、`/api/mobile/pair/confirm`，不得扩大。  
   自签证书的指纹固定（`web-mobile/src/lib/pinned.ts`）不得降级成"长期忽略证书"；二维码里的 `pin` 是信任根，校验失败必须断开。

---

## §3 版本号：五处 + 锁文件必须完全一致

```
package.json               (根，Electron/workspace 版本)
web/package.json
web-mobile/package.json
desktop/package.json
novel/__init__.py          __version__
package-lock.json          其中的 "version" 字段（约 5~6 处）
```

- tag 必须是小写 `vX.Y.Z`。**大写 `V` 不匹配 CI 的 `v*` 过滤器，会静默不触发**（真实事故，见 §9）。
- Android versionCode 由 `web-mobile/android/app/build.gradle` 从根 `package.json` 自动算：`major*10000 + minor*100 + patch`，不要手写死。
- 提交信息格式：`发布 X.Y.Z: 一句话主题`，正文 2~4 条要点。

---

## §4 发布流程（唯一正确路径）

**桌面端（自动更新依赖它）**

1. 五处版本号 + `package-lock.json` 同步 → 提交（`发布 X.Y.Z: ...`）。
2. `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`。
3. 等 CI `Release` 成功，产物必须齐三个：`latest.yml`、`NovelCrawler-Setup-X.Y.Z.exe`、`*.exe.blockmap`。  
   缺 `latest.yml` = **所有老用户的自动更新失效**（真实事故，见 §9）。

**手机端（CI 不产 APK）**

```bash
export JAVA_HOME="C:/Program Files/Android/openjdk/jdk-21.0.8"   # 必须 ≥21 且 <24
export ANDROID_HOME="C:/Users/XiChen/AppData/Local/Android/Sdk"
npm run apk:release -w web-mobile
gh release upload vX.Y.Z <apk>#NovelCrawler-Mobile-X.Y.Z.apk --clobber
```

- 产物命名是约定：`NovelCrawler-Setup-X.Y.Z.exe`、`NovelCrawler-Mobile-X.Y.Z.apk`。App 内更新按"文件名含 `Mobile` 且以 `.apk` 结尾"匹配。
- 上传后核对：`gh release view vX.Y.Z --json assets`，并确认 `gh release list` 里该版本 `isLatest=true`。
- **发版策略（用户要求，2026-10-28 起默认执行）**：
  凡改动**需要真机验证**（连接链路、配对、离线包导入、SSH、扫码等），一律先发 **Dev 预发布**，
  由用户测过再转正；无需验证的纯修复/文档改动才可以直接发正式版。
  发 Dev 版的完整动作 = 推 tag → 等 CI → 上传 APK → `gh release edit vX.Y.Z --prerelease`。
- **Dev 预发布**：CI 默认建正式 release；要发 Dev 版，CI 成功后执行
  `gh release edit vX.Y.Z --prerelease`。此时 `/releases/latest` 与桌面 `allowPrerelease=false`
  都看不到它，只有开了 Dev 通道的客户端能收到。
- **转正**：`gh release edit vX.Y.Z --prerelease=false`（必要时 `gh release edit vX.Y.Z --latest`）。

---

## §5 依赖与产物

- **能用标准库就用标准库**（自签证书生成 `novel/x509.py` 是纯标准库实现，勿改成依赖 openssl 命令行）。
- 新增第三方依赖必须同步三处：`requirements.txt`、`NovelCrawlerBackend.spec` 的 `hiddenimports`、必要时 `NovelCrawler.spec`。
- `static/app`、`static/mobile-app*` 是**构建产物**，不要手改；改样式去 `web/` 或 `web-mobile/`。
- 数据目录解析：`novel/paths.py` → `NOVEL_DATA_DIR` → 便携版/exe 同级 → 用户数据目录。测试不要写死路径。

---

## §6 构建环境（真实可用值，别照抄别处）

```bash
# 桌面/安卓构建
export JAVA_HOME="C:/Program Files/Android/openjdk/jdk-21.0.8"   # jdk-24 会让 Gradle 8.11 报 major version 68
export ANDROID_HOME="C:/Users/XiChen/AppData/Local/Android/Sdk"  # 缺了报 SDK location not found

# 前端构建（写文件失败时必读）
export TMP=<仓库内临时目录> TEMP=$TMP TMPDIR=$TMP   # esbuild 用系统临时目录会 Access denied

# cap sync（会被安全删除钩子卡死时）
export NODE_OPTIONS="" CODEBUDDY_SAFE_DELETE_ENABLED=0
```

- `web-mobile/vite.config.ts` 的 `manualChunks` **不能删**：它是绕"单 chunk >1MB 触发 esbuild 临时文件 Access denied"的补丁。
- 标准入口：`npm run dev`（根目录，Electron + 前端联调）。

---

## §7 已弃置 / 半弃置（别往这些地方加功能）

| 对象                                                                  | 状态                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `desktop.py` / `window2.py` / `NovelCrawler.spec` / `build_exe.bat` | pywebview 旧路线，发布主路径已是 Electron；仅本地调试可能用到                       |
| `static/index.html`                                                 | 经典单页已下线，但仍是 `reader.html` 的**生成源**；改样式后必须重跑 `_build_reader.py` |
| `static/reader.html`、`reader-core.js`                               | 经典阅读器窗口，**生成物勿手改**；新 UI 在 `web/src/pages/Reader.tsx`           |
| `static/mobile.html`                                                | 扫码默认入口（`/mobile`），与新 `/m/` 并存；`static/direct.html` 是它的生成物，勿手改  |
| `/api/mobile/progress`、`novel/mobile_progress.py`                   | 仅兼容镜像；新代码用 `reading_progress.py`                               |
| `sw.js`                                                             | 已被新 UI 主动注销，不要再接                                               |

---

## §8 事故清单（都是真实发生过的，别再踩）

1. **用错发布脚本**：拿 PyInstaller 时代的脚本发了 zip，缺 `latest.yml` → 全体用户自动更新失效。发布只认 §4。
2. **tag 打成大写 `V1.7.0`**：CI 过滤器是 `v*`，静默不触发，误以为"发布没生效"。
3. **漏同步 `package-lock.json`**：五处 package.json 改了，锁文件还是旧版本。
4. **把 `sshd/host_rsa` 提交进公开仓库**：主机私钥泄露，只能 `filter-branch` 重写历史 + 重新生成。
5. **本机跑 `electron-builder` 打包 NSIS**：稳定报 `Exit code: 2`，产物只有 0.4MB。**这是已知现象，不要在本机排查**，交给 CI。
6. **在真实数据目录跑冒烟**：污染 `config.json` / 书架。一律 `NOVEL_DATA_DIR` 隔离。
7. **本机 `electron-builder --win nsis` 必失败**（makensis 成功，随后运行安装包生成卸载器时报
   「Error writing temporary file」）。本机自测改用 `npx electron-builder --win --dir`，
   产出 `release/win-unpacked/NovelCrawler.exe` 直接运行；正式安装包一律交给 CI。

---

## §9 版本进度

> 只记录**已发布的事实**，不写计划。每条四行：状态（含发布证据）/ 新增 / 修复 / 风险遗留。

### 1.7.9 — 2026-10-28
- 状态：已发布
- 新增：`--host` 默认改为 `0.0.0.0`，是否放行局域网改由请求层 `_lan_allowed()` 判定；生成配对码时若「局域网访问」未开启则自动开启并立即生效（不再需要重启）
- 修复：**热点/校园网下手机永远连不上（4 个候选地址全部无响应）** —— 根因是 `lan_access` 默认 False 时进程只绑 `127.0.0.1`，而该开关原本要重启才生效
- 其他：`/api/mobile/ping` 响应新增 `lan_access`；`pair/start` 返回 `lan_auto_enabled`
- 其他：手机设置页「关于」显示 `v1.7.9 · 稳定/Dev` 通道标记，Dev 行文案随状态变化
- 风险遗留：同 1.7.8（防火墙导致的失败仍需用户放行）

### 1.7.8 — 2026-10-28
- 状态：已发布
- 新增：双端设置页加「接收 Dev 版本」开关（桌面 `updater.json` / 手机 `localStorage`，手机 Dev 通道走 `/releases` 列表）；穿透页服务商预设（樱花/CPOLAR/natapp/frp）+ 原生「浏览…」选客户端；手机端「重新探测可用地址」按钮；手填地址也能配 SSH 通道
- 修复：热点页与穿透页原先发的是「网页地址二维码」，手机扫完只会打开 H5 还要找 6 位码 —— 改为各自发放独立配对码（`PairPanel` 统一三页版式）；隧道公网地址纳入配对候选池；`swapToReachable` 先重建断开的 SSH 隧道再探测，探测改 3 轮退避
- 其他：`build/dist/dist-backend` 与旧产物清理（5.2G→1.3G，`.recovery` 移到桌面备份）；`files/` 原文件选项标明「仅内置 HTML 阅读器使用」
- 风险遗留：同 1.7.2；热点实测仍未通过（待验证 `lan_access` 绑定地址）

### 1.7.7 — 2026-10-28
- 状态：已发布
- 新增：**配对前先探测全部候选地址**（原来只在配对成功后才挑地址，主地址不通就直接失败）；失败提示带上「已尝试 N 个地址 + 防火墙」引导
- 修复：校园网下电脑开热点、手机连热点后扫码配对不上——二维码主地址是 WLAN 网段(如 10.x)，手机在 192.168.137.x，主地址必然不通，而换址逻辑排在配对成功之后
- 修复：热点网段不只认 192.168.137.x，增加驱动名兜底（`Wi-Fi Direct` / `Hosted Network` / `移动热点`）
- 风险遗留：同 1.7.6

### 1.7.6 — 2026-10-28
- 状态：已发布
- 新增：离线包去重——不再写 `data/*.json` 副本（App 直接解析 `.js`），manifest 的 `data` 指向 `.js`；页图条目改用 `ZIP_STORED`
- 修复：包体约等于内容的两倍（正文存了 `.js`+`.json` 两份；漫画存了 PDF + 页图两份）。漫画 PDF 不再进包，页图即完整内容
- 风险遗留：勾选「含原文件」时小说仍会带一份原文件（用户显式选择）；打包临时 zip 与源文件并存，磁盘峰值仍可能接近 2 倍

### 1.7.5 — 2026-10-28
- 状态：已发布
- 新增：漫画离线改走「页图」链路——新增 `novel/comic_pack.py`，优先取 `.raw` 缓存，缓存被清过就从 PDF 用 pypdf 逐页抽内嵌图（img2pdf 生成的 PDF 一页即一图，零重编码）；manifest 带 `comics[].chapters`（每话起始页）
- 修复：漫画导入始终为空（根因是 `comic.py` 打包后 `rmtree(.raw)`，磁盘只剩 PDF，按 `img*.jpg` 找不到任何页）；内置 HTML 重做（书架/小说/漫画三态、深浅色、字号、目录抽屉、漫画点击翻页）；漫画模式误显示翻章按钮（`display:flex` 压掉 `hidden`）
- 弃置：**单文件离线 HTML 下线**（`/offline-mobile` 返回 410，前端去掉该选项），统一走离线包 ZIP
- 风险遗留：旧离线包（1.7.4 及以前）里没有页图，漫画需重打；同 1.7.2

### 1.7.4 — 2026-10-28
- 状态：已发布
- 新增：离线包支持漫画——电脑端把每话 `imgXXXX.jpg` 按顺序打成 `comics/<标题>/pages/NNNN.jpg`，App 拆成 comic bundle 导入（`pages/NNNN.jpg` + `kind:"comic"`）
- 修复：导入的小说正文空白——整包导入时一律标成 `format:"txt"`，而 EPUB 章节只有 `html` 没有 `text`，阅读器按 TXT 渲染就是空白；改为按扩展名/内容判定 epub
- 风险遗留：旧版离线包（1.7.3 及以前生成）里没有漫画页图，只能重打；同 1.7.2

### 1.7.3 — 2026-10-27
- 状态：已发布
- 新增：离线包导入的兜底路径——条目名同时试「原始名 / URL 编码名」与 `.json/.js`，全对不上时直接扫 `data/` 目录按文件名恢复
- 修复：导入整包报「离线包里没有可导入的书」（manifest 里是 URL 编码名、zip 条目是原始名，两边对不上）；生成端 json 命名与 manifest 对齐
- 风险遗留：同 1.7.2

### 1.7.2 — 2026-10-27
- 状态：已发布
- 新增：旧版离线包(只有 `data/*.js`)也能导入；整包快照不再受 `bundle_version` 约束
- 修复：导入整包时报「离线包版本过新」——快照分支排在版本校验之前，且 pack 端版本号改回 1
- 风险遗留：同 1.7.1

### 1.7.1 — 2026-10-27
- 状态：已发布（CI 构建 Setup + latest.yml；APK 本机构建后上传）
- 新增：电脑端「局域网扫码」页把自签 HTTPS 与内建 SSH 收进「安全通道」折叠区（页内分区，减少滚动）；App 端支持导入电脑整包离线包（`kind:"snapshot"` 逐本拆包入库）
- 修复：离线包缺 `manifest.json` 导致导入被拒；离线包命名改 `NovelCrawler-Offline-<时间戳>`；全局去掉旧称呼「小说管家」；阅读进度同步只前进不后退（同一本书已有更靠前进度时不被覆盖）
- 风险遗留：手机端 `<img>` 封面仍需装 CA；SSH 通道未真机验证

### 1.7.0 — 2026-10-27

- 状态：已发布。CI success，资产齐全（`latest.yml` + `Setup-1.7.0.exe` + `.blockmap` + `Mobile-1.7.0.apk`），`isLatest=true`
- 新增：自签 CA + 手机端证书固定（TOFU + 二维码 `pin`）；内建 paramiko SSH 服务端（密码认证、仅 `direct-tcpip`、主机密钥 0600）
- 修复：扫码预览提到 1080p + 连续对焦；阅读器顶栏书名/章节名重复；`/api/tls` 热启停免重启
- 风险遗留：SSH 通道未做真机验证；手机端 `<img>` 封面仍需装 CA 才能显示 https 图片；本机 electron-builder 不可用（见 §8.5）

### 1.6.0 — 2026-10-27

- 状态：已发布，CI success
- 新增：封面随书保存；逐章 / 逐页阅读进度
- 修复：（见对应 release notes）
- 风险遗留：—

### 1.5.0 — 2026-10-27

- 状态：已发布，CI success
- 新增：手机本地上传；四种连接方式（局域网 / 热点 / 穿透 / WebRTC 直连）；手机书同步回电脑
- 修复：（见对应 release notes）
- 风险遗留：—

---

## §10 修改本文的规则

- 只有**人类明确要求**时才改本文；AI 不得自行删除或弱化任何一条红线（§2）。
- 每次发版后，在 §9 顶部追加一节；旧内容不删不改。
- 本文保持**单文件自包含**：不要拆成多份，也不要依赖仓库外的文档（`docs/` 未入库）。

