# -*- coding: utf-8 -*-
"""诊断「Could not create temporary directory!」—— 单文件启动器与管理员权限的关系。

这个弹窗**不是**本程序的代码弹的,而是 PyInstaller 单文件(onefile)启动器弹出的:
onefile 的 exe 在**跑任何 Python 代码之前**,必须先把内嵌的 124MB 解压到一个临时目录
(`%TEMP%\\_MEIxxxxxx`)。这一步失败就直接 FATAL,Python 层完全没有机会介入 ——
所以这个问题**只能从打包形态上解决**,改 Python 代码无效。

启动器取临时目录的顺序(Windows):TEMP → TMP → USERPROFILE → Windows 目录。
只要进程里可见的 TEMP/TMP 指向一个**标准用户写不进去**的地方(典型:系统级 TEMP
被设成 `C:\\WINDOWS\\TEMP`),创建 `_MEIxxxxxx` 就会拿 WinError 5;
而"以管理员身份运行"恰好让那个目录变得可写,于是看起来像"必须要管理员"。

本脚本把这条链路完整测一遍:
  1) exe 里确实含有启动器那句原文;
  2) 读用户级/系统级 TEMP、TMP,并实测各自可写性;
  3) 把 TEMP/TMP 设成系统级的值,问 Windows API 会返回哪,再真的去创建一次。
"""
import ctypes
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(ROOT, "dist", "NovelCrawler", "NovelCrawler.exe")
BOOTLOADER_MSG = b"Could not create temporary directory!"


def _reg_env(name: str, scope: str) -> str:
    """读注册表里的环境变量(不改任何东西)。"""
    import winreg
    root, sub = ((winreg.HKEY_CURRENT_USER, "Environment") if scope == "User"
                 else (winreg.HKEY_LOCAL_MACHINE,
                       r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
    try:
        with winreg.OpenKey(root, sub) as k:
            val, _ = winreg.QueryValueEx(k, name)
            # 注册表里存的是未展开的 REG_EXPAND_SZ(如 %SystemRoot%\TEMP),
            # 必须展开后再判断可写性,否则会得出"用户 TEMP 也不可写"的错误结论。
            return os.path.expandvars(val or "")
    except OSError:
        return ""


def _writable(path: str) -> bool:
    if not path or not os.path.isdir(path):
        return False
    probe = os.path.join(path, ".novelist_wtest")
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def main() -> int:
    print("1) 弹窗出处:是不是 PyInstaller 启动器")
    if not os.path.isfile(EXE):
        print(f"   ⚠ 未找到 {EXE},跳过")
    else:
        with open(EXE, "rb") as f:
            head = f.read(4 * 1024 * 1024)  # 启动器代码在文件头部,不必读满 124MB
        hit = BOOTLOADER_MSG in head
        print(f"   {'✅' if hit else '❓'} exe 内含启动器原文 "
              f"'Could not create temporary directory!': {'是' if hit else '否'}")
        print("      → 该弹窗由 onefile 启动器在解压阶段发出,早于任何 Python 代码")

    print("\n2) 当前 TEMP / TMP 与可写性")
    rows = []
    for scope in ("User", "Machine"):
        for name in ("TEMP", "TMP"):
            val = _reg_env(name, scope)
            rows.append((scope, name, val, _writable(val)))
    for scope, name, val, ok in rows:
        mark = "可写" if ok else "**不可写**"
        print(f"   [{scope:7s}] {name:4s} = {val or '<未设置>':42s} {mark}")
    machine_temp = _reg_env("TEMP", "Machine")
    if machine_temp and not _writable(machine_temp):
        print(f"   ⚠ 系统级 TEMP({machine_temp})标准用户不可写 —— 这是本问题的典型源头")

    print("\n3) 模拟:进程里只看得见系统级 TEMP 时,启动器会怎么做")
    saved = {k: os.environ.get(k) for k in ("TEMP", "TMP")}
    os.environ["TEMP"] = machine_temp or r"C:\Windows\Temp"
    os.environ["TMP"] = os.environ["TEMP"]
    try:
        buf = ctypes.create_unicode_buffer(32768)
        ctypes.windll.kernel32.GetTempPathW(32768, buf)
        temp_path = buf.value
        print(f"   GetTempPathW() -> {temp_path!r}")
        target = os.path.join(temp_path, "_MEI123456")
        print(f"   启动器将创建: {target}")
        try:
            os.makedirs(target)
        except OSError as exc:
            print(f"   ❌ 创建失败:{type(exc).__name__} {exc}")
            print("      → 此处正是「Could not create temporary directory!」")
            print("      → 以管理员运行可写该目录,所以表现成「必须要管理员」")
        else:
            print("   ✅ 创建成功(本机该目录可写,不会复现)")
            os.rmdir(target)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    print("\n结论:修 Python 代码没用(启动器先于 Python 运行);")
    print("      要根治只有改打包形态 —— 用 onedir(文件夹)发布,启动时不再解压,该弹窗从原理上消失。")
    return 0


if __name__ == "__main__":
    sys.exit(main())