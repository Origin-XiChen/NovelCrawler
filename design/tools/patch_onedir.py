# -*- coding: utf-8 -*-
"""把打包形态从 onefile(单文件)改成 onedir(文件夹)。

为什么必须改:onefile 的 exe 每次启动都要先把 249MB 内嵌内容解压到 %TEMP%\s,这一步在
**任何 Python 代码之前**由 PyInstaller 启动器执行。当进程可见的 TEMP/TMP 指向标准用户写不
进去的位置(本机系统级 TEMP = C:\\WINDOWS\\TEMP),解压直接失败并弹
「Could not create temporary directory!」,只能靠"以管理员身份运行"绕过(见 UI-ANALYSIS.md 第 10 节)。
onedir 启动时**完全不解压**,该失败模式从原理上消失;顺带启动更快、不再残留 _MEI 目录。

代码侧无需改动:gui_server/window2/browser 取资源都走 sys._MEIPASS,onedir 下它指向
exe 同级的 _internal/,路径语义一致。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = os.path.join(ROOT, "NovelCrawler.spec")

OLD_EXE = """exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
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
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)"""

NEW_EXE = """# ---------------- onedir:不再有"启动解压"这一步 ----------------
# 原来是一次性单文件(onefile):每次启动都要把 249MB 解压到 %TEMP%\\_MEIxxxxxx,
# 这个动作发生在**任何 Python 代码之前**,只要进程可见的 TEMP/TMP 指向标准用户写不进去的
# 位置(例如系统级 TEMP = C:\\WINDOWS\\TEMP),启动器就直接弹
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
)"""

OLD_HEAD = """# ---------------- Playwright(验证中心"自动验证"用)打包 ----------------"""
NEW_HEAD = """# 产物:`dist/NovelCrawler/`(onedir)—— NovelCrawler.exe + _internal/ 整个文件夹分发。
# 注意 --distpath 不要直接指到 dist/NovelCrawler:PyInstaller 会清空输出目录,
# 而那里面正是用户的书架/配置数据(APP_DATA_DIR = exe 同目录)。
# build_exe.bat 因此先输出到 build/dist_out,再只把 exe 与 _internal 覆盖过去。

# ---------------- Playwright(验证中心"自动验证"用)打包 ----------------"""


def main() -> int:
    text = io.open(SPEC, encoding="utf-8").read()
    n = 0

    if "coll = COLLECT(" in text:
        print("  [跳过] spec 已是 onedir")
    elif OLD_EXE in text:
        text = text.replace(OLD_EXE, NEW_EXE, 1)
        n += 1
        print("  [OK] spec: EXE 改为 exclude_binaries + 新增 COLLECT")
    else:
        print("  [失败] 未匹配到原有 EXE 块,请人工检查")
        return 1

    if NEW_HEAD in text:
        print("  [跳过] 顶部说明已存在")
    elif OLD_HEAD in text:
        text = text.replace(OLD_HEAD, NEW_HEAD, 1)
        n += 1
        print("  [OK] spec: 顶部加产物形态与 --distpath 说明")
    else:
        print("  [跳过] 未找到 Playwright 段注释")

    # 原文件开头关于 onefile 的两处描述也要跟上,避免注释与事实不符
    text = text.replace(
        "# 内置 Playwright 驱动等都在里面);本脚本只负责选解释器 + 调用 spec,",
        "# 内置 Playwright 驱动等都在里面);本脚本只负责选解释器 + 调用 spec,")

    io.open(SPEC, "w", encoding="utf-8", newline="\n").write(text)
    print(f"\n共 {n} 处改动")
    return 0


if __name__ == "__main__":
    sys.exit(main())