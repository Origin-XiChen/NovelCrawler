# -*- mode: python ; coding: utf-8 -*-

import os
import zipfile

import webview

# WebView2Loader.dll 从当前构建环境的 pywebview 包内动态解析(跨机器可移植)
_WEBVIEW_DLL = os.path.join(
    os.path.dirname(webview.__file__),
    "lib", "runtimes", "win-x64", "native", "WebView2Loader.dll",
)

# 产物:`dist/NovelCrawler/`(onedir)—— NovelCrawler.exe + _internal/ 整个文件夹分发。
# 注意 --distpath 不要直接指到 dist/NovelCrawler:PyInstaller 会清空输出目录,
# 而那里面正是用户的书架/配置数据(APP_DATA_DIR = exe 同目录)。
# build_exe.bat 因此先输出到 build/dist_out,再只把 exe 与 _internal 覆盖过去。

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


# ---------------- 版本资源(信任观感 / 签名身份归属) ----------------
# 原来 exe 没有任何版本信息:文件属性里公司/产品/版本全为空,系统对话框也显示不出
# 任何可核对的发布者身份。版本号从 novel.__version__ 取,避免与代码漂移。
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
    _path = os.path.join(_root, "build", "version_info.txt")
    os.makedirs(os.path.dirname(_path), exist_ok=True)
    _body = """VSVersionInfo(
  ffi=FixedFileInfo(filevers=%(tup)s, prodvers=%(tup)s, mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([
      StringTable('080404b0', [
        StringStruct('CompanyName', 'NovelCrawler'),
        StringStruct('FileDescription', '小说管家 · 漫画+小说 多源下载器(学习版)'),
        StringStruct('FileVersion', '%(ver)s'),
        StringStruct('InternalName', 'NovelCrawler'),
        StringStruct('LegalCopyright', 'GPL-3.0 · 仅供个人学习与技术研究'),
        StringStruct('OriginalFilename', 'NovelCrawler.exe'),
        StringStruct('ProductName', '小说管家'),
        StringStruct('ProductVersion', '%(ver)s')]),
    ]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])
  ]
)
""" % {"tup": repr(_tup), "ver": _v}
    with open(_path, "w", encoding="utf-8") as _f:
        _f.write(_body)
    print(f"[spec] 版本资源已生成: {_path}  (v{_v})")
    return _path


_VERSION_FILE = _write_version_file()

a = Analysis(
    ['window2.py'],
    pathex=[],
    binaries=list(_pw_binaries),
    datas=[('static', 'static'), ('icon', 'icon'), (_WEBVIEW_DLL, 'webview/lib/runtimes/win-x64/native')] + _pw_datas,
    hiddenimports=['novel.browser', 'novel.verify', 'novel.opds', 'novel.epub', 'novel.searcher', 'novel.jsonpath', 'novel.fetcher', 'novel.downloader', 'novel.source_registry', 'novel.paths', 'novel.tasklog', 'novel.notes', 'novel.wenku8', 'novel.comic', 'novel.comic_cimoc', 'novel.comic_pack', 'novel.pdfcover', 'novel.hotspot', 'novel.netinfo', 'novel.doctor', 'novel.tls', 'novel.x509', 'novel.sshd', 'novel.tunnel', 'novel.webrtc', 'novel.signal_mqtt', 'novel.camscan', 'img2pdf', 'qrcode', 'paramiko', 'cryptography', 'bcrypt', 'nacl', 'PIL', 'pypdf', 'cv2'] + _pw_hidden,
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

# ---------------- onedir:不再有"启动解压"这一步 ----------------
# 原来是一次性单文件(onefile):每次启动都要把 249MB 解压到 %TEMP%\_MEIxxxxxx,
# 这个动作发生在**任何 Python 代码之前**,只要进程可见的 TEMP/TMP 指向标准用户写不进去的
# 位置(例如系统级 TEMP = C:\WINDOWS\TEMP),启动器就直接弹
# 「Could not create temporary directory!」,只能以管理员运行绕过;
# 而且该目录在强杀退出后残留(本程序退出走 TerminateProcess),每次启动还慢几秒。
# 改成 onedir:依赖与数据放在 exe 同级的 _internal/,启动时零解压 —— 该失败模式从原理上消失。
# 代码无需改动:gui_server / window2 / browser 取资源都走 sys._MEIPASS,
# onedir 下它指向 _internal/,语义与原来一致。
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,       # 依赖/数据交给下面的 COLLECT,EXE 只留启动器
    name='NovelCrawler',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX 关闭:UPX 壳是杀软 / SmartScreen 判定"可疑"的重要信号(大量恶意样本都用它)。
    # 原来写 True 只是因为本构建机没装 UPX 才没生效(实测产物无 UPX 节)——
    # 显式关掉,避免换台构建机就悄悄压出一个更容易被拦的 exe。
    upx=False,
    # node.exe 不能 UPX 压缩(会破坏可执行文件);留着以防将来重新开启 upx
    upx_exclude=['node.exe', 'playwright_node.zip'],
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
    name='NovelCrawler',
)
