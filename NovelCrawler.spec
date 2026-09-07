# -*- mode: python ; coding: utf-8 -*-

import os
import webview

# WebView2Loader.dll 从当前构建环境的 pywebview 包内动态解析(跨机器可移植)
_WEBVIEW_DLL = os.path.join(
    os.path.dirname(webview.__file__),
    "lib", "runtimes", "win-x64", "native", "WebView2Loader.dll",
)


a = Analysis(
    ['window2.py'],
    pathex=[],
    binaries=[],
    datas=[('static', 'static'), ('icon', 'icon'), (_WEBVIEW_DLL, 'webview/lib/runtimes/win-x64/native')],
    hiddenimports=['novel.browser', 'novel.verify', 'novel.opds', 'novel.epub', 'novel.searcher', 'novel.jsonpath', 'novel.fetcher', 'novel.downloader', 'novel.source_registry', 'novel.paths', 'novel.tasklog', 'novel.notes', 'novel.wenku8', 'novel.comic', 'novel.comic_cimoc', 'novel.pdfcover', 'novel.hotspot', 'novel.tunnel', 'novel.webrtc', 'novel.signal_mqtt', 'novel.camscan', 'img2pdf', 'qrcode', 'PIL', 'pypdf', 'cv2'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

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
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
