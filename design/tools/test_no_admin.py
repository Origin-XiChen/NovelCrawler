# -*- coding: utf-8 -*-
"""验证「不再需要管理员权限」这一组修复。

1) window2._webview_cache_dir():
   * 数据目录可写 → 用数据目录(开发模式下与原来的 cwd 行为一致);
   * 数据目录不可写 → 回退系统临时目录,而不是像原来那样直接失败。
   同时对比旧实现(os.getcwd())在不可写 cwd 下的表现,证明修的是真问题。
2) NovelCrawler.spec 里生成的版本资源文件:能被 PyInstaller 自己的
   VSVersionInfo 解析器 eval 出来(即格式合法),且版本号取自 novel.__version__。
"""
import os
import re
import sys


try:  # 中文控制台(cp936)编不出 ✓/⚠ 时会崩,这里只做兜底不改语义
    sys.stdout.reconfigure(errors="replace")
except (AttributeError, OSError):
    pass
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

fails = []


def check(label, cond, extra=""):
    print(f"  {'✅' if cond else '❌'} {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ============ 1) 缓存目录 ============
print("1) window2._webview_cache_dir() —— WebView2 用户数据目录")

src = open(os.path.join(ROOT, "window2.py"), encoding="utf-8").read()
m = re.search(r"def _webview_cache_dir\(\) -> str:.*?\n(?=\n\S|\nclass |\ndef )", src, re.S)
if not m:
    print("  ❌ 未能从 window2.py 抽出 _webview_cache_dir")
    sys.exit(1)
fn_src = m.group(0)

W2_CACHE = ".webview2-cache"


def run_with_data_dir(data_dir):
    """在受控命名空间里执行真实函数源码,返回它选的目录。"""
    ns = {
        "os": os,
        "tempfile": tempfile,
        "_APP_DATA_DIR": data_dir,
        "_MAIN_CACHE_DIR": W2_CACHE,
    }
    exec(fn_src, ns)  # noqa: S102 —— 测的就是文件里的真代码
    return ns["_webview_cache_dir"]()


# 1a) 可写的数据目录(正常情况)
tmp_ok = tempfile.mkdtemp(prefix="wv_ok_")
got = run_with_data_dir(tmp_ok)
check("数据目录可写时用它", got == os.path.join(tmp_ok, W2_CACHE), got)
check("目录被真正创建", os.path.isdir(got))

# 1b) 不可写的数据目录 → 必须回退 TEMP(而不是抛异常)
if sys.platform == "win32":
    ro = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
else:
    ro = "/proc"
try:
    probe = os.path.join(ro, ".novelist_probe")
    open(probe, "w").close()
    os.remove(probe)
    print(f"  ⚠ 跳过不可写场景:{ro} 竟然可写,无法构造")
except OSError:
    try:
        got2 = run_with_data_dir(ro)
        check("数据目录不可写时回退 TEMP(原来会失败)", got2.startswith(tempfile.gettempdir()), got2)
        check("回退目录可写", os.path.isdir(got2))
    except OSError as exc:
        check("数据目录不可写时不抛异常", False, f"{type(exc).__name__}: {exc}")

# 1c) 对照旧实现:不可写 cwd 下 os.makedirs 直接失败
print("\n   对照:旧实现(os.getcwd())在不可写目录下")
if sys.platform == "win32" and not os.access(ro, os.W_OK):
    try:
        os.makedirs(os.path.join(ro, W2_CACHE), exist_ok=True)
        print("      ⚠ 居然成功了(环境特殊),该对照不成立")
    except OSError as exc:
        print(f"      ✓ 旧做法抛 {type(exc).__name__} —— 这正是「只能以管理员运行」的由来")

# ============ 2) 版本资源 ============
print("\n2) 版本资源文件(spec 生成) —— 格式与内容")

spec = open(os.path.join(ROOT, "NovelCrawler.spec"), encoding="utf-8").read()
mv = re.search(r"def _write_version_file\(\) -> str:.*?\n\n\n", spec, re.S)
if not mv:
    print("  ❌ 未能从 spec 抽出 _write_version_file")
    sys.exit(1)

ns = {"os": os, "SPECPATH": ROOT}
exec(mv.group(0), ns)  # noqa: S102
path = ns["_write_version_file"]()
check("生成了版本资源文件", os.path.isfile(path), path)

body = open(path, encoding="utf-8").read()
from novel import __version__  # noqa: E402

check("版本号取自 novel.__version__", f"'{__version__}'" in body, f"__version__={__version__}")
check("含公司名", "CompanyName" in body)
check("含产品名", "ProductName" in body)
check("含文件描述", "FileDescription" in body)
check("含原始文件名", "OriginalFilename" in body)

# 用 PyInstaller 自己的解析器验证格式合法
try:
    from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo,  # noqa: E402
                                                     StringStruct, StringTable,
                                                     VarFileInfo, VarStruct, VSVersionInfo)
    obj = eval(body, {"VSVersionInfo": VSVersionInfo, "FixedFileInfo": FixedFileInfo,
                      "StringFileInfo": StringFileInfo, "StringTable": StringTable,
                      "StringStruct": StringStruct, "VarFileInfo": VarFileInfo,
                      "VarStruct": VarStruct})
    check("可被 PyInstaller 解析为 VSVersionInfo", isinstance(obj, VSVersionInfo))

    def _kv(s):
        """PyInstaller 6.x 用 name/val,老版本用 Key/Value。"""
        return (getattr(s, "name", None) or getattr(s, "Key", None),
                getattr(s, "val", None) or getattr(s, "Value", None))

    tables = obj.kids[0].kids if obj.kids else []
    strs = dict(_kv(s) for s in tables[0].kids) if tables else {}
    check("FileVersion 正确", strs.get("FileVersion") == __version__, str(strs.get("FileVersion")))
    check("ProductVersion 正确", strs.get("ProductVersion") == __version__)
    check("字符串表语言为 zh-CN(080404b0)", tables and tables[0].name == "080404b0",
          tables[0].name if tables else "")

    # 固定版本号:PyInstaller 把四段版本拆成 MS/LS 两个 DWORD,这里还原后比对
    want = tuple(int(x) for x in (__version__.split(".") + ["0", "0", "0"])[:4])
    got4 = (obj.ffi.fileVersionMS >> 16, obj.ffi.fileVersionMS & 0xFFFF,
            obj.ffi.fileVersionLS >> 16, obj.ffi.fileVersionLS & 0xFFFF)
    check(f"FixedFileInfo 四段版本还原为 {want}", got4 == want, f"还原={got4}")
    check("fileFlags=0(无调试/预发布标记)", obj.ffi.fileFlags == 0)
    check("fileType=1(应用程序)", obj.ffi.fileType == 1)
except ImportError as exc:
    print(f"  ⚠ 跳过解析校验(未安装 PyInstaller): {exc}")
except Exception as exc:  # noqa: BLE001
    check("版本资源格式合法", False, f"{type(exc).__name__}: {exc}")

print()
print("PASS" if not fails else f"FAIL({len(fails)}): " + "; ".join(fails))
sys.exit(1 if fails else 0)