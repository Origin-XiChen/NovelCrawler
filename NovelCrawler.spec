# -*- mode: python ; coding: utf-8 -*-

import os
import zipfile

import webview

# WebView2Loader.dll 从当前构建环境的 pywebview 包内动态解析(跨机器可移植)
_WEBVIEW_DLL = os.path.join(
    os.path.dirname(webview.__file__),
    "lib", "runtimes", "win-x64", "native", "WebView2Loader.dll",
)

# ---------------- Playwright(验证中心"自动验证"用)打包 ----------------
# 方案:JS 驱动(playwright/driver/package,约 9MB)直接进 exe;体积最大的
# node.exe(约 94MB)单独压成 zip 一起进 exe,首次调用验证时解压到数据目录
# (见 novel/browser.py ensure_driver)。这样做的原因:
#   * onefile 每次启动都会把内嵌数据解压到 %TEMP%,多 94MB 会让每次启动都慢几秒,
#     且本程序退出走 TerminateProcess(强杀),解压目录常残留 → 反复占用上百 MB;
#   * 懒解压只在真正点"验证"时做一次,之后复用,启动开销为 0。
_pw_datas = []
_pw_hidden = []
_pw_binaries = []
try:
    from PyInstaller.utils.hooks import (collect_data_files, collect_dynamic_libs,
                                         collect_submodules)
    import playwright as _pw  # noqa: F401

    # node.exe 不进 datas(单独压 zip);其余驱动文件/JS 全进。
    # 注意:collect_data_files 的 excludes 在 Windows 上不总能匹配,这里再按文件名
    # 显式过滤一遍,确保 94MB 的 node.exe 不会被原样再塞进 exe 一份。
    _pw_datas = [(src, dst) for (src, dst) in collect_data_files("playwright")
                 if os.path.basename(src).lower() != "node.exe"]
    _pw_hidden = collect_submodules("playwright") + collect_submodules("pyee")
    _pw_hidden += ["greenlet", "playwright.sync_api", "playwright.async_api"]
    _pw_binaries = collect_dynamic_libs("greenlet")

    # 压缩 node.exe → build/playwright_node.zip(带缓存:node.exe 未变则复用)
    _node = os.path.join(os.path.dirname(_pw.__file__), "driver", "node.exe")
    _zip = os.path.join("build", "playwright_node.zip")
    if os.path.isfile(_node):
        _need = True
        if os.path.isfile(_zip):
            _need = os.path.getmtime(_zip) < os.path.getmtime(_node)
        if _need:
            os.makedirs("build", exist_ok=True)
            with zipfile.ZipFile(_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as _z:
                _z.write(_node, "node.exe")
            print(f"[spec] 已打包 playwright node 驱动: {_zip} "
                  f"({os.path.getsize(_zip) / 1048576:.1f} MB)")
        _pw_datas.append((_zip, "."))
    else:
        print("[spec] 警告:未找到 playwright/driver/node.exe,自动验证将依赖系统 Node")
except Exception as _exc:  # noqa: BLE001
    print(f"[spec] 警告:Playwright 打包步骤跳过({type(_exc).__name__}: {_exc})")


a = Analysis(
    ['window2.py'],
    pathex=[],
    binaries=list(_pw_binaries),
    datas=[('static', 'static'), ('icon', 'icon'), (_WEBVIEW_DLL, 'webview/lib/runtimes/win-x64/native')] + _pw_datas,
    hiddenimports=['novel.browser', 'novel.verify', 'novel.opds', 'novel.epub', 'novel.searcher', 'novel.jsonpath', 'novel.fetcher', 'novel.downloader', 'novel.source_registry', 'novel.paths', 'novel.tasklog', 'novel.notes', 'novel.wenku8', 'novel.comic', 'novel.comic_cimoc', 'novel.pdfcover', 'novel.hotspot', 'novel.tunnel', 'novel.webrtc', 'novel.signal_mqtt', 'novel.camscan', 'img2pdf', 'qrcode', 'PIL', 'pypdf', 'cv2'] + _pw_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# Playwright 自带的 PyInstaller 钩子(playwright/_impl/__pyinstaller/hook-*.py)会无条件
# 把 94MB 的 node.exe 也收进来,和我们的 zip 重复。这里统一剔除:node.exe 只走压缩包
# 那条路(见文件开头说明),避免 exe 白胖 34MB + 每次启动多解压 94MB 到 %TEMP%。
a.binaries = [e for e in a.binaries if os.path.basename(e[0]).lower() != "node.exe"]
a.datas = [e for e in a.datas if os.path.basename(e[0]).lower() != "node.exe"]

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='NovelCrawler',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # node.exe 不能 UPX 压缩(会破坏可执行文件);其余保持默认
    upx_exclude=['node.exe', 'playwright_node.zip'],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
