# -*- coding: utf-8 -*-
"""「必须以管理员运行」这一类问题的程序侧修复(不动电脑设置)。

实测结论(design/tools/probe_exe_manifest.py):
  exe 内嵌 manifest 是 level="asInvoker" —— 它**没有**请求管理员权限;
  代码里也没有任何需要提权的操作(没有防火墙/热点创建,热点只做检测).
  也就是说「每次都要管理员」如果确实存在,来源只能是:系统设置/快捷方式勾了
  「以管理员身份运行」,或者 app 因为写不了某个目录而失败被误以为要提权.

真正会在程序侧逼出管理员权限的只有一处:
  window2.py 把 WebView2 用户数据目录固定成 os.getcwd()/.webview2-cache。
  双击启动时 cwd = exe 目录,一旦 exe 装在不允许写入的位置(如 Program Files),
  或通过「起始位置」指向别处的快捷方式启动,cwd 就可能不可写甚至指向系统目录,
  结果是 WebView2 环境创建失败 → 静默降级成浏览器模式,只能靠"以管理员身份运行"绕过。
  改到数据目录(APP_DATA_DIR 自带可写性探测与 %APPDATA% 回退),再兜底 TEMP。

另外两处属于「信任观感」,虽不能消除 SmartScreen,但都是发布侧该做的:
  * exe 现在**没有任何版本信息**(公司/产品/版本全空)→ 生成版本资源并在 spec 里挂上;
  * spec 里 upx=True → 实测产物没被 UPX 压(构建机没装 UPX),但换台机器就会压出一个
    带 UPX 壳的 exe,而 UPX 是杀软/SmartScreen 的重要负面信号 → 显式关掉。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W2 = os.path.join(ROOT, "window2.py")
SPEC = os.path.join(ROOT, "NovelCrawler.spec")
BAT = os.path.join(ROOT, "build_exe.bat")

# ---------------- window2.py:缓存目录 ----------------
HELPER = '''_MAIN_CACHE_DIR = ".webview2-cache"


def _webview_cache_dir() -> str:
    """WebView2 用户数据目录(缓存/登录态)。

    原来固定用 os.getcwd():双击启动时 cwd 是 exe 目录,一旦 exe 装在不允许写入的位置
    (如 Program Files),或通过「起始位置」指向别处的快捷方式启动,创建就会失败 →
    WebView2 环境创建失败 → 静默降级成浏览器模式,用户只能靠"以管理员身份运行"绕过。
    改到数据目录(APP_DATA_DIR 自带"exe 目录不可写就回退 %APPDATA%"的探测),
    再兜底系统临时目录,于是不再要求 exe 目录可写、也不需要管理员权限。
    开发模式下 APP_DATA_DIR 就是项目根目录,行为与原来一致(仍是 .webview2-cache)。
    """
    for base in (_APP_DATA_DIR, tempfile.gettempdir()):
        cand = os.path.join(base, _MAIN_CACHE_DIR)
        try:
            os.makedirs(cand, exist_ok=True)
            probe = os.path.join(cand, ".writetest")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(probe)
            return cand
        except OSError:
            continue
    return os.path.join(tempfile.gettempdir(), _MAIN_CACHE_DIR)
'''

# ---------------- NovelCrawler.spec:版本资源 + 关掉 UPX ----------------
SPEC_VERSION = '''
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
        StringStruct('FileDescription', 'NovelCrawler · 漫画+小说 多源下载器(学习版)'),
        StringStruct('FileVersion', '%(ver)s'),
        StringStruct('InternalName', 'NovelCrawler'),
        StringStruct('LegalCopyright', 'GPL-3.0 · 仅供个人学习与技术研究'),
        StringStruct('OriginalFilename', 'NovelCrawler.exe'),
        StringStruct('ProductName', 'NovelCrawler'),
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

'''

EDITS = {
    W2: [
        (
            "import sys\nimport threading\n",
            "import sys\nimport tempfile\nimport threading\n",
            "window2.py: 补 tempfile 导入",
        ),
        (
            '_MAIN_CACHE_DIR = ".webview2-cache"\n',
            HELPER,
            "window2.py: 新增可写位置探测的缓存目录函数",
        ),
        (
            "    cache_dir = os.path.join(os.getcwd(), \".webview2-cache\")\n",
            "    cache_dir = _webview_cache_dir()  # 不再依赖 cwd/exe 目录可写(见函数注释)\n",
            "window2.py: 主窗口缓存目录改用数据目录",
        ),
        (
            "    cache_dir = main.cache_dir if main else _MAIN_CACHE_DIR\n",
            "    cache_dir = main.cache_dir if main else _webview_cache_dir()\n",
            "window2.py: 阅读器兜底也用同一处",
        ),
    ],
    SPEC: [
        (
            "\na = Analysis(\n",
            SPEC_VERSION + "a = Analysis(\n",
            "spec: 插入版本资源生成",
        ),
        (
            """    upx=True,
    # node.exe 不能 UPX 压缩(会破坏可执行文件);其余保持默认
    upx_exclude=['node.exe', 'playwright_node.zip'],""",
            """    # UPX 关闭:UPX 壳是杀软 / SmartScreen 判定"可疑"的重要信号(大量恶意样本都用它)。
    # 原来写 True 只是因为本构建机没装 UPX 才没生效(实测产物无 UPX 节)——
    # 显式关掉,避免换台构建机就悄悄压出一个更容易被拦的 exe。
    upx=False,
    # node.exe 不能 UPX 压缩(会破坏可执行文件);留着以防将来重新开启 upx
    upx_exclude=['node.exe', 'playwright_node.zip'],
    version=_VERSION_FILE,""",
            "spec: 关掉 UPX + 挂上版本资源",
        ),
    ],
    BAT: [
        (
            """echo NovelCrawler NovelCrawler - 免安装版> "dist\\NovelCrawler\\使用说明.txt"
echo.>> "dist\\NovelCrawler\\使用说明.txt"
echo 双击 NovelCrawler.exe 即可使用。>> "dist\\NovelCrawler\\使用说明.txt"
echo 书架/订阅/下载等数据保存在 exe 同目录。>> "dist\\NovelCrawler\\使用说明.txt"
echo 需要 Edge WebView2 运行时,Windows 10/11 自带。>> "dist\\NovelCrawler\\使用说明.txt\"""",
            """echo NovelCrawler NovelCrawler - 免安装版> "dist\\NovelCrawler\\使用说明.txt"
echo.>> "dist\\NovelCrawler\\使用说明.txt"
echo 双击 NovelCrawler.exe 即可使用,**不需要管理员权限**。>> "dist\\NovelCrawler\\使用说明.txt"
echo 书架/订阅/下载等数据默认保存在 exe 同目录;>> "dist\\NovelCrawler\\使用说明.txt"
echo 若该目录不可写(例如放在 Program Files),会自动改用>> "dist\\NovelCrawler\\使用说明.txt"
echo %%APPDATA%%\\NovelCrawler,并在「设置 - 数据存储位置」中显示实际路径。>> "dist\\NovelCrawler\\使用说明.txt"
echo 需要 Edge WebView2 运行时,Windows 10/11 自带。>> "dist\\NovelCrawler\\使用说明.txt"
echo.>> "dist\\NovelCrawler\\使用说明.txt"
echo 首次运行若出现「未知发布者 / Windows 已保护你的电脑」提示,>> "dist\\NovelCrawler\\使用说明.txt"
echo 点「更多信息」-「仍要运行」即可;这不是需要管理员权限。>> "dist\\NovelCrawler\\使用说明.txt\"""",
            "bat: 更正使用说明(数据位置 + 无需管理员 + 未知发布者处理)",
        ),
    ],
}


def main() -> int:
    total = 0
    for path, edits in EDITS.items():
        text = io.open(path, encoding="utf-8").read()
        name = os.path.relpath(path, ROOT)
        for old, new, label in edits:
            if old not in text:
                print(f"  [跳过] {name} · {label}")
                continue
            text = text.replace(old, new, 1)
            total += 1
            print(f"  [OK] {name} · {label}")
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"\n共应用 {total} 处")
    return 0


if __name__ == "__main__":
    sys.exit(main())