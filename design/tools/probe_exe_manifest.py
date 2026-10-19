# -*- coding: utf-8 -*-
"""读 exe 内嵌清单(RT_MANIFEST),确认是否请求管理员权限。

「需要管理员运行」这类问题的第一现场就在 manifest 的 requestedExecutionLevel:
  asInvoker          → 不请求提权(双击不会出 UAC)
  requireAdministrator → 每次启动都弹 UAC
  highestAvailable   → 当前用户是管理员时会弹 UAC
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    exe = os.path.join(ROOT, "dist", "NovelCrawler", "NovelCrawler.exe")
    if not os.path.isfile(exe):
        print("未找到:", exe)
        return 1
    b = open(exe, "rb").read()
    print(f"exe: {exe}")
    print(f"大小: {len(b)/1024/1024:.1f} MB\n")

    print("关键标记扫描:")
    for kw in [b"requestedExecutionLevel", b"asInvoker", b"requireAdministrator",
               b"highestAvailable", b"trustInfo", b"requestedPrivileges",
               b"dpiAware", b"maxversiontested", b"activeCodePage"]:
        i = b.find(kw)
        print(f"  {kw.decode():26s} {'找到 @ ' + str(i) if i >= 0 else '未找到'}")

    i = b.find(b"requestedExecutionLevel")
    if i > 0:
        seg = b[max(0, i - 420):i + 200].decode("utf-8", "replace")
        seg = re.sub(r"[\x00-\x08\x0b-\x1f]", "", seg)
        print("\n--- requestedExecutionLevel 所在片段 ---")
        print(seg)
    else:
        print("\n未找到 requestedExecutionLevel:说明 exe 没有请求提权(默认 asInvoker)。")

    # 顺便看有没有版本资源(影响「未知发布者」观感与 SmartScreen 信誉归属)
    print("\n版本资源扫描:")
    for kw in [b"FileVersion", b"ProductName", b"CompanyName", b"LegalCopyright"]:
        hit = b.find(kw.decode("ascii").encode("utf-16-le")) >= 0 or b.find(kw) >= 0
        print(f"  {kw.decode():16s} {'存在' if hit else '不存在'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())