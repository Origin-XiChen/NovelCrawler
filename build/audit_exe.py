# -*- coding: utf-8 -*-
"""打包审计(onedir):确认 dist\\NovelCrawler\\ 里关键资源真的就位、node.exe 没有重复入包。

形态变更前这里读的是单文件 exe 内的 CArchive;改成 onedir 后依赖与数据都在
exe 同级的 `_internal/` 下,直接查文件系统更准(而且能读到真实的前端文件内容),
所以不再需要 CArchiveReader。

注意:本脚本会被 build_exe.bat 直接调用,那时控制台代码页是 936(GBK),
输出里出现 ✓/✗ 这类 GBK 编不出来的字符会直接抛 UnicodeEncodeError 把构建搞失败
(实测踩过)。所以标记一律用 ASCII 的 [OK]/[X],并在开头给 stdout 装上兜底。
"""
import os
import sys

try:  # 控制台不是 UTF-8 时也不要因为个别字符崩掉
    sys.stdout.reconfigure(errors="replace")
except (AttributeError, OSError):
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist", "NovelCrawler")
INTERNAL = os.path.join(DIST, "_internal")
EXE = os.path.join(DIST, "NovelCrawler.exe")

print(f"产物目录: {DIST}")
print(f"  启动器: {'存在' if os.path.isfile(EXE) else '**缺失**'}")
print(f"  _internal/: {'存在' if os.path.isdir(INTERNAL) else '**缺失**'}")
if not os.path.isdir(INTERNAL):
    print("审计失败: 没有 _internal/,这不像是 onedir 产物")
    sys.exit(1)

fails = []


def has(rel, want=True, label=""):
    # _internal 内的路径按 PyInstaller 习惯用正斜杠书写,这里两种分隔符都认
    p = os.path.join(INTERNAL, rel.replace("/", os.sep))
    ok = os.path.exists(p)
    print(f"  {'[OK]' if ok == want else '[X] '} {label or rel}: "
          f"{'存在' if ok else '不存在'}")
    if ok != want:
        fails.append(f"{label or rel} 期望{'存在' if want else '不存在'}")
    return p


has("static/index.html", True, "前端页面")
has("static/reader-core.js", True, "阅读器内核")
has("playwright/driver/package/cli.js", True, "Playwright JS 驱动")
has("playwright_node.zip", True, "内置 node 驱动压缩包")
has("webview/lib/runtimes/win-x64/native/WebView2Loader.dll", True, "WebView2Loader.dll")

# node.exe 只应存在于 playwright_node.zip 里(懒解压),不应再有一份解开的
strays = []
for dirpath, _dirs, files in os.walk(INTERNAL):
    for fn in files:
        if fn.lower() == "node.exe":
            strays.append(os.path.relpath(os.path.join(dirpath, fn), INTERNAL))
print(f"  {'[OK]' if not strays else '[X] '} 散落的 node.exe(应被剔除): "
      f"{'不存在' if not strays else '; '.join(strays)}")
if strays:
    fails.append("_internal 里存在多余的 node.exe")

# 关键回归:onedir 的启动器必须很小(不内嵌 250MB 归档),否则说明又退回 onefile 了 ——
# 而 onefile 正是「Could not create temporary directory!」的根源(见 UI-ANALYSIS.md 第 10 节)。
exe_mb = os.path.getsize(EXE) / 1048576
small = exe_mb < 60
print(f"  启动器体积: {exe_mb:.1f} MB "
      f"{'[OK] 符合 onedir,启动时无需解压' if small else '[X]  偏大,疑似仍是 onefile'}")
if not small:
    fails.append(f"启动器体积 {exe_mb:.1f}MB 过大,疑似仍为 onefile")

# 前端内容是否为最新(直接读磁盘上的真实文件)
with open(os.path.join(INTERNAL, "static", "index.html"), encoding="utf-8") as f:
    text = f.read()
for needle, want in (("vfManualBox", True), ("自动验证不可用", True),
                     ("_dlFinishPartial", True), ("手动态", False),
                     ("弹窗被浏览器拦截", True)):
    ok = (needle in text) == want
    print(f"  {'[OK]' if ok else '[X] '} 前端文案 {needle}: "
          f"{'存在' if needle in text else '不存在'}")
    if not ok:
        fails.append(f"前端文案 {needle} 不符合预期")
print(f"  前端大小: {len(text.encode('utf-8'))} 字节")

# 整包体积与文件数(便于对比 onefile 时代的 124.6MB 单文件)
total = 0
count = 0
for dirpath, _dirs, files in os.walk(DIST):
    for fn in files:
        try:
            total += os.path.getsize(os.path.join(dirpath, fn))
            count += 1
        except OSError:
            pass
print(f"  整个文件夹: {count} 个文件 / {total / 1048576:.1f} MB")

# 版本资源与签名(版本资源由 spec 决定;签名需要证书,NotSigned 属预期)
try:
    import subprocess
    ps = ("(Get-Item '{0}').VersionInfo | "
          "Select-Object FileVersion,CompanyName,ProductName | Format-List; "
          "(Get-AuthenticodeSignature '{0}').Status").format(EXE)
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                         capture_output=True, timeout=60)
    # 不用 text=True:它会按本地代码页(936)解码 PowerShell 的输出,
    # 遇到编不出来的字节会在读取线程里抛 UnicodeDecodeError(实测踩过)。
    text_out = (out.stdout or b"").decode("utf-8", "replace") or \
               (out.stdout or b"").decode("gbk", "replace")
    for line in text_out.strip().splitlines():
        if line.strip():
            print(f"  {line.strip()}")
except Exception as exc:  # noqa: BLE001
    print(f"  (版本/签名检查跳过: {type(exc).__name__}: {exc})")

print("审计通过" if not fails else "审计失败: " + "; ".join(fails))
sys.exit(1 if fails else 0)