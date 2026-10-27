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

---

## §9 版本进度

> 只记录**已发布的事实**，不写计划。每条四行：状态（含发布证据）/ 新增 / 修复 / 风险遗留。

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

