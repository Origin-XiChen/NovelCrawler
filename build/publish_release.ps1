# 发布:创建 GitHub Release 并上传「dist\NovelCrawler 打包成的 zip」(不打印任何凭据)
#
# 形态变更(onedir):
#   原来上传单个 NovelCrawler.exe(onefile)。改为 onedir 后产物是
#   NovelCrawler.exe + _internal\,必须整个文件夹分发,所以这里打包成 zip 再上传。
#
# 重要:绝不能直接把 dist\NovelCrawler 整个压缩上传 ——
#   那个目录里存着**本机用户的数据**(config.json 里可能有代理/凭据、还有书架/订阅/
#   下载记录)。这里只挑构建产物(exe + _internal + 使用说明.txt)放进临时目录再压缩,
#   并在压缩后断言里面没有个人数据文件。
param([string]$Tag = '')
$ErrorActionPreference = 'Stop'
$repo = 'Origin-XiChen/NovelCrawler'
$root = Split-Path $PSScriptRoot -Parent

if (-not $Tag) {
    # 版本号从 novel/__init__.py 取,避免脚本里的 tag 与代码漂移
    $init = Join-Path $root 'novel\__init__.py'
    $m = Select-String -Path $init -Pattern '__version__\s*=\s*"([^"]+)"'
    if (-not $m) { throw "未能从 $init 读到 __version__" }
    $Tag = 'V' + $m.Matches[0].Groups[1].Value
}
Write-Host "发布 tag: $Tag"

$dist = Join-Path $root 'dist\NovelCrawler'
$exe = Join-Path $dist 'NovelCrawler.exe'
$internal = Join-Path $dist '_internal'
foreach ($p in @($exe, $internal)) {
    if (-not (Test-Path $p)) { throw "产物不完整,缺少 $p(先跑 build_exe.bat)" }
}

# ---- 只挑构建产物,放进干净的临时目录 ----
$packRoot = Join-Path $root 'build\pack'
if (Test-Path $packRoot) { Remove-Item $packRoot -Recurse -Force }
$stage = Join-Path $packRoot 'NovelCrawler'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item $exe (Join-Path $stage 'NovelCrawler.exe')
Copy-Item $internal $stage -Recurse
$readme = Join-Path $dist '使用说明.txt'
if (Test-Path $readme) { Copy-Item $readme (Join-Path $stage '使用说明.txt') }

$assetName = "NovelCrawler-$Tag.zip"
$zip = Join-Path $root "build\$assetName"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host '压缩中…'
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$size = (Get-Item $zip).Length
Write-Host ("待上传: {0}  ({1:N1} MB)" -f $zip, ($size / 1MB))

# ---- 断言:压缩包里没有本机个人数据 ----
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $names = $za.Entries | ForEach-Object { $_.FullName }
    $bad = $names | Where-Object {
        $_ -match '(?i)(config|bookshelf|comic_shelf|subscriptions|comic_subs|task_history|' +
                  'verify_|notes|source_candidates|window_state|opds_cookies|comic_base_overrides|' +
                  'comic_sources_custom|\.webview2-cache|playwright_driver)'
    }
    if ($bad) { throw ("压缩包里含本机数据文件,拒绝上传: " + ($bad -join ', ')) }
    Write-Host ("包内 {0} 个条目,未发现个人数据文件 ✓" -f $names.Count)
} finally { $za.Dispose() }

# 从 Git Credential Manager 取 token(只放入变量,不输出)
$cred = ("protocol=https`nhost=github.com`n`n" | git credential fill) -split "`n"
$tok = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $tok) { throw '未能取得 GitHub 凭据' }
Write-Host ("凭据前缀: {0}…  长度 {1}" -f $tok.Substring(0, 4), $tok.Length)

$hdr = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json';
          'User-Agent' = 'NovelCrawler-release' }

$notes = @'
## 免管理员运行 + 弹窗拦截不再静默(打包形态改为文件夹)

### 📦 安装方式变了(请先看这条)
从本版起不再是一个单独的 exe,而是**一个文件夹**(已打包成 zip):
解压后目录里有 `NovelCrawler.exe` 和 `_internal\`,**双击 exe 即可**,
但请保留 `_internal\` 不要删、也不要只把 exe 单独拷出来。

**为什么改**:原来的单文件 exe 每次启动都要把约 250MB 解压到 `%TEMP%\_MEIxxxxxx`,
这个动作发生在任何程序代码之前。一旦系统里可见的临时目录标准用户写不进去
(例如机器级 `TEMP` 是 `C:\WINDOWS\TEMP`),就会弹
「Could not create temporary directory!」,用户只能靠"以管理员身份运行"绕过。
改成文件夹形态后启动**完全不解压**:该报错从原理上不会再出现,启动也快得多,
并且不再残留解压目录。

### 🔓 不再需要管理员权限
- 排查发现 exe 的清单其实是 `asInvoker`(**并没有**请求提权),真正的症结是上面的启动解压。
- 顺带修掉一处会静默降级的问题:WebView2 的缓存目录原来固定用当前工作目录
  (`os.getcwd()`),装在只读位置时会创建失败并**静默退回浏览器模式**;现在改为数据目录,
  并带系统临时目录兜底。

### 🖱 浏览器模式下弹窗被拦不再"点了没反应"
- OPDS「浏览」、图片「↗ 新窗口打开」等原本直接 `window.open`,被浏览器拦截时毫无提示;
  现在会明确告知被拦截,并提供"在当前页打开"等退路。
- 手机版「打开 PDF」原先走 `data:` URL 顶层导航 —— 这在 Chrome/Edge 上是**无条件禁止**的
  (与弹窗拦截无关),必然失败;改为 Blob URL,被拦时自动退回下载。

### 🔐 关于「Windows 已保护你的电脑 / 未知发布者」
该提示来自**程序没有数字签名**,与权限无关,以管理员运行也不会让它消失。
本版已补上完整的版本信息(公司/产品/版本/版权)、并关闭 UPX 压缩(UPX 壳是杀软判定
"可疑"的信号),让二进制看起来正常;但要彻底消除 SmartScreen,仍需代码签名证书。

### 📌 数据与运行环境
书架/订阅/下载数据默认保存在 exe 同目录;该位置不可写时自动改用 `%APPDATA%\NovelCrawler`。
需要系统 Edge/WebView2 运行时(Windows 10/11 自带)。
'@

$body = @{ tag_name = $Tag; name = $Tag; body = $notes; draft = $false; prerelease = $false } |
        ConvertTo-Json -Depth 5 -Compress
try {
    $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" `
        -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    Write-Host ("Release 已创建: id={0} {1}" -f $rel.id, $rel.html_url)
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 422) {
        Write-Host 'Release 已存在,复用现有条目'
        $all = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=20" -Headers $hdr
        $rel = $all | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
    } else { throw }
}
if (-not $rel) { throw '未取得 release 对象' }

# 删除同名旧资产(含 onefile 时代的 NovelCrawler.exe,避免新旧混在一起)
foreach ($a in @($rel.assets)) {
    if ($a.name -eq $assetName -or $a.name -eq 'NovelCrawler.exe') {
        Write-Host ("删除旧资产 id={0} name={1}" -f $a.id, $a.name)
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$repo/releases/assets/$($a.id)" -Headers $hdr | Out-Null
    }
}

$up = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=$assetName"
Write-Host ("开始上传({0:N1} MB,耐心等待)…" -f ($size / 1MB))
$sw = [Diagnostics.Stopwatch]::StartNew()
$res = Invoke-RestMethod -Method Post -Uri $up -Headers $hdr `
       -ContentType 'application/octet-stream' -InFile $zip -TimeoutSec 3600
Write-Host ("上传完成: {0} ({1:N1} MB) 用时 {2:N0}s" -f $res.name, ($res.size / 1MB), $sw.Elapsed.TotalSeconds)

$chk = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$Tag" -Headers $hdr
Write-Host ("校验: {0}  资产: {1}" -f $chk.tag_name, (($chk.assets | ForEach-Object { "$($_.name) $([int]($_.size/1MB))MB" }) -join ', '))
Write-Host ("下载页: {0}" -f $chk.html_url)