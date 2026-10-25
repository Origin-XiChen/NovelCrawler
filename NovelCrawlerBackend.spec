# -*- mode: python ; coding: utf-8 -*-
"""Electron 版后端（仅 HTTP 服务，无桌面窗口）。

与 NovelCrawler.spec 的区别：
  * 入口是 server_entry.py，不创建 Win32/WebView2 窗口；
  * 产物名 NovelCrawlerBackend，作为 extraResources 放进 Electron 的 resources/backend；
  * 仍包含 static/（经典界面 + 新 React 界面在 static/app）与 Playwright 依赖。
"""

import os
import zipfile

# ---------------- Playwright（验证中心自动验证） ----------------
_pw_datas = []
_pw_hidden = []
_pw_binaries = []
try:
    from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules
    import playwright as _pw  # noqa: F401

    _pw_datas = [
        (src, dst)
        for (src, dst) in collect_data_files("playwright")
        if os.path.basename(src).lower() != "node.exe"
    ]
    _pw_hidden = collect_submodules("playwright") + collect_submodules("pyee")
    _pw_hidden += ["greenlet", "playwright.sync_api", "playwright.async_api"]
    _pw_binaries = collect_dynamic_libs("greenlet")

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
            print(f"[spec] packed playwright node driver: {_zip} "
                  f"({os.path.getsize(_zip) / 1048576:.1f} MB)")
        _pw_datas.append((_zip, "."))
    else:
        print("[spec] warning: playwright/driver/node.exe not found")
except Exception as _exc:  # noqa: BLE001
    print(f"[spec] warning: Playwright packaging skipped ({type(_exc).__name__}: {_exc})")


def _write_version_file() -> str:
    _root = os.path.abspath(globals().get("SPECPATH") or os.getcwd())
    try:
        import sys as _sys
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from novel import __version__ as _v
    except Exception:  # noqa: BLE001
        _v = "0.0.0"
    _nums = []
    for _p in (_v.split(".") + ["0", "0", "0", "0"])[:4]:
        try:
            _nums.append(int(_p))
        except ValueError:
            _nums.append(0)
    _tup = tuple(_nums)
    _path = os.path.join(_root, "build", "backend_version_info.txt")
    os.makedirs(os.path.dirname(_path), exist_ok=True)
    _body = """VSVersionInfo(
  ffi=FixedFileInfo(filevers=%(tup)s, prodvers=%(tup)s, mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([
      StringTable('080404b0', [
        StringStruct('CompanyName', 'NovelCrawler'),
        StringStruct('FileDescription', '小说管家 · 后端服务'),
        StringStruct('FileVersion', '%(ver)s'),
        StringStruct('InternalName', 'NovelCrawlerBackend'),
        StringStruct('LegalCopyright', 'GPL-3.0 · 仅供个人学习与技术研究'),
        StringStruct('OriginalFilename', 'NovelCrawlerBackend.exe'),
        StringStruct('ProductName', '小说管家'),
        StringStruct('ProductVersion', '%(ver)s')]),
    ]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])
  ]
)
""" % {"tup": repr(_tup), "ver": _v}
    with open(_path, "w", encoding="utf-8") as _f:
        _f.write(_body)
    print(f"[spec] version resource written: {_path}  (v{_v})")
    return _path


_VERSION_FILE = _write_version_file()

a = Analysis(
    ['server_entry.py'],
    pathex=[],
    binaries=list(_pw_binaries),
    datas=[
        ('static', 'static'),
        ('icon', 'icon'),
    ] + _pw_datas,
    hiddenimports=[
        'novel.browser', 'novel.verify', 'novel.opds', 'novel.epub', 'novel.searcher',
        'novel.jsonpath', 'novel.fetcher', 'novel.downloader', 'novel.source_registry',
        'novel.paths', 'novel.tasklog', 'novel.notes', 'novel.wenku8', 'novel.comic',
        'novel.comic_cimoc', 'novel.pdfcover', 'novel.hotspot', 'novel.tunnel',
        'novel.webrtc', 'novel.signal_mqtt', 'novel.camscan', 'img2pdf', 'qrcode',
        'PIL', 'pypdf', 'cv2',
    ] + _pw_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# Playwright 钩子会再次塞入 94MB 的 node.exe，这里剔除（只保留压缩包）。
a.binaries = [e for e in a.binaries if os.path.basename(e[0]).lower() != "node.exe"]
a.datas = [e for e in a.datas if os.path.basename(e[0]).lower() != "node.exe"]

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='NovelCrawlerBackend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    version=_VERSION_FILE,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=['node.exe', 'playwright_node.zip'],
    name='NovelCrawlerBackend',
)
