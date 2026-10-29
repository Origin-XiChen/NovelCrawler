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
  **Dev 用预发布后缀递增**：`1.7.9-dev.1 → .2 → .3`，正式版号 `1.7.9` 始终留给转正（semver 里 `1.7.9 > 1.7.9-dev.N`，转正后 Dev 用户能正常升上去）。
  每轮 Dev 只改后缀，五个版本号 + tag 同步，CI 正常构建；转正时把所有版本号改成 `1.7.9` 并 `--prerelease=false`。
- **Dev 预发布**：CI 默认建正式 release；要发 Dev 版，CI 成功后执行
  `gh release edit vX.Y.Z --prerelease`。此时 `/releases/latest` 与桌面 `allowPrerelease=false`
  都看不到它，只有开了 Dev 通道的客户端能收到。
- **APK 版本必须等于 tag**：上传前核对文件名里的版本（手机端会校验，不一致直接不提示更新）。
  历史事故：tag 升到 dev.5 但资产仍挂着 dev.4 的 APK，用户装完版本没变 → 反复提示更新，像死循环。
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
6. **`/api/mobile/ping` 崩溃会让手机显示"这个地址没有响应"**：TCP 能连上但服务端一个字节不回（`ERR_EMPTY_RESPONSE`）。排查时先看服务端日志有没有 traceback，别一头扎进网络/防火墙。
7. **在真实数据目录跑冒烟**：污染 `config.json` / 书架。一律 `NOVEL_DATA_DIR` 隔离。
7. **本机 `electron-builder --win nsis` 必失败**（makensis 成功，随后运行安装包生成卸载器时报
   「Error writing temporary file」）。本机自测改用 `npx electron-builder --win --dir`，
   产出 `release/win-unpacked/NovelCrawler.exe` 直接运行；正式安装包一律交给 CI。

---

## §9 版本进度

> 只记录**已发布的事实**，不写计划。每条四行：状态（含发布证据）/ 新增 / 修复 / 风险遗留。

### 1.7.10-dev.7 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 新增：**漫画整本下载**——`/api/mobile/bundle?kind=comic&title=X&all=1` 一次把该书全部话按序打进同一个包（`pages/` 连续编号 + `chapters[{label,from,pages}]`），电脑书库漫画卡片改为「整本 (N 话)」一键下载
- 新增：**书架按「书」聚合 + 批量删除**——同一漫画的多话合并为一行（显示 `N 话 · M 页`，整本包优先作为打开入口，旧数据标「逐话导入」）；顶部「选择」进入多选，底部工具条支持全选/删除所选，删一本会清掉它名下所有离线包
- 修复：小说离线封面——`novel_bundle` 走 `covers.ensure_cover`（缓存→EPUB 内嵌→来源→**本地生成**），纯 TXT 也有封面；`BUNDLE_VERSION` 1→2 让旧缓存失效、重新打包
- 风险遗留：漫画「同步后看不了」仍待复现（整本下载可绕开逐话包）

### 1.7.10-dev.6 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 修复：**安装向导关不掉 / 装完仍是旧版**——`updater:install` 调 `quitAndInstall(false, true)`，第一个参数是 `isSilent`；本项目 `nsis.oneClick=false`，非静默调用会弹出「欢迎→选目录→安装→完成」整套向导，用户一取消就前功尽弃，下次启动又提示同一版本。改为 `quitAndInstall(true, true)`（安装器收到 `/S` 静默安装，装完 `--force-run` 自动拉起）
- 修复：`compareVersion` 把「无预发布标记」当成 `-1`，导致正式版 `1.7.10` 被判定**小于** `1.7.10-dev.5`，Dev 通道用户永远升不到对应正式版；改为 `null` 表示「比任何 dev 号都大」，与手机端 `compareVersions` 规则对齐
- 新增：安装结果校验——`updater:install` 前把待装版本写入 `userData/updater.json` 的 `installAttempted`；重启后若当前版本仍低于该值，`update-available` 改为报「上次安装未生效」并提示手动下载，不再无声循环。启动时若版本已追上则自动清除标记
- 其他：`updater.json` 改为合并写入（`readSettings`/`writeSettings`），避免写 `installAttempted` 时把 `allowPrerelease` 冲掉
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.10-dev.5 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 修复：**更新死循环**——桌面端 `update-available` 未校验版本，feed 给的版本等于/低于当前版本时仍提示更新（装完还提示）；现改为 `compareVersion` 比较，非更新直接回 `not-available`
- 修复：手机端 release 的 tag 与 APK 实际版本不一致时（例如 tag 升了但挂的是旧 APK）会无限提示；现校验资产文件名里的版本，不一致就跳过并不提示
- 其他：手机更新横幅「稍后再说」记到 `localStorage`，同一版本不再反复弹
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.10-dev.4 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 修复：**后端加全局异常兜底**（`Handler._safe_dispatch`）——此前任何处理函数抛异常都冒泡到 `socketserver`，连接被直接关闭、一个字节不回，客户端报「这个地址没有响应 / ERR_EMPTY_RESPONSE」，把一堆真实 bug 伪装成网络问题。现在统一打 traceback + 回 500 JSON（`send_response` 覆写置 `_responded`，响应已开始就不再补错误体）
- 修复：`POST /api/comic_subscriptions/pending` 把 `parsed.query`(str) 当 dict 传，**必然 AttributeError**；`_body()` 改为强制返回 dict（新增 `allow_empty`），非对象 JSON 一律 400，并收归 8 处自行 `json.loads(rfile.read())` 的接口；`?ch=abc` 类参数（3 处）改走 `_qs_int`
- 修复：**SSRF/开放代理**——`/api/cover`、`/api/comic_img`、`_epub_online_fetch` 只校验 `startswith("http")` 就把远端响应原样回给调用方，已实测可借它读到本机 `/api/settings`、内网与 `169.254.169.254`；新增 `_is_public_host()` + `_remote_url_error()` 要求解析结果全部 `is_global`
- 修复：`add_custom_source` 零校验（`POST /api/sources {}` 会落盘无 name 的源，导致书源列表/测试书源/候选源三接口全 `KeyError`）；`load_all_sources` 过滤残缺条目；WebRTC 回环桥接改用 `ProxyHandler({})`（Windows 下 `proxy_bypass('127.0.0.1')` 恒为 False，配了远程代理后手机直连通道整条失效）
- 其他：`comic_bundle` 的 title 兜底改为 `basename(dirname(src))`，让 manifest id 由构造保证等于 `comic:<目录名>/<文件名>`；实测五处口径（catalog / bundle / 手机两条导入路径 / 桌面 `Comics.tsx`）完全一致，双向进度回传闭环通过
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.10-dev.3 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 修复：同步管理页元素贴边——该页用了根本不存在的 `.page/.page-head` 类，等于没有内边距；改为 `.sync-page`（与 library/settings 同套 `max-width + 16px 内边距 + 安全区`）
- 其他：手机端名称全部英文化——`strings.xml` 的 `app_name`/`title_activity_main` 与 `manifest.webmanifest` 的 `name`/`short_name` 由「小说管家」改为 `NovelCrawler`（`capacitor.config.ts` 早已是英文）
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.10-dev.2 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 修复：设置页版本号与通道混显示（切换 Dev 开关会让"版本"看起来变了）——版本号原样显示，另用独立 `开发版` 标签；「接收 Dev 版本」改为「更新通道」，右侧加 `稳定/Dev` 胶囊；装了 dev 构建但通道为稳定时给出说明
- 修复：同步管理页排布——摘要改两列+电脑独占一行；行内百分比移到标题右侧、`待回传` 移到次行标签、进度条通栏、章节名单行省略
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.10-dev.1 — 2026-10-29
- 状态：已发布（Dev 预发布）
- 新增：封面闭环——`covers.ensure_cover` 新增"本地生成"兜底（标题+渐变 300x420 PNG），同步包与离线包都带 `cover`，手机书架直接显示；手机「同步管理」显示上次同步时间；阅读后 4 秒防抖自动回传（失败 8 秒后补一次）
- 修复：设置页 `.switch` 类**根本没有样式**（Dev 开关是不可见的空 span）；漫画阅读器禁用长按保存/系统菜单
- 其他：统一动效层（页面 6px 淡入、列表错峰入场、按压 0.985 反馈、进度条宽度缓动），全部包在 `prefers-reduced-motion` 内
- 风险遗留：漫画「同步后看不了」仍待复现

### 1.7.9 — 2026-10-29
- 状态：已发布（正式版）。经 dev.1/dev.2/dev.3 三轮真机验证后转正
- 新增：手机「同步管理」页（每本进度/待回传/一键回传）+ 电脑设置页同步管理列表；双端「接收 Dev 版本」开关与 `稳定/Dev` 通道标记；穿透厂商预设（樱花/cpolar/natapp/frp）与原生选客户端；电脑端「放行防火墙」与「网络诊断」按钮；服务默认绑 `0.0.0.0`，局域网放行改由 `_lan_allowed()` 在请求层判定（开关即时生效，无需重启）
- 修复：**`/api/mobile/ping` 因 `scheme` 未定义抛 NameError → 连接建立后立即关闭，手机显示「这个地址没有响应」/`ERR_EMPTY_RESPONSE`（手机长期连不上的真正根因）**；热点页/穿透页原先发「网页地址二维码」，改为各自发放配对码（`PairPanel` 统一三版式）；漫画阅读器顶栏缺定位规则导致与状态栏重叠；隧道地址纳入候选池；`swapToReachable` 先重建 SSH 隧道再三轮退避探测
- 其他：`versionCode` 正式版 `base*100+99`（高于同 base 的 Dev，可覆盖安装）；Dev 用 `-dev.N` 后缀递增，正式版号不被占用
- 风险遗留：漫画「同步后看不了」未复现（待用户提供截图/页数）

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

