# -*- coding: utf-8 -*-
"""让构建脚本能入库,同时继续忽略构建产物。

问题:.gitignore 里的 `build/` 把整个目录排除掉了,build/ 下**没有任何文件被跟踪**。
而 build_exe.bat 现在会调用 build/make_readme_txt.py 与 build/audit_exe.py ——
全新克隆将无法构建。这里把 `build/` 改成 `build/*`(只排除内容,允许用 ! 反选),
再把手写的脚本按扩展名反选回来;压缩包/日志/中间产物继续忽略。

注:git 规则里"父目录被排除时无法反选其子文件",所以必须用 `build/*` 而不是 `build/`。
"""
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GI = os.path.join(ROOT, ".gitignore")

OLD = """# ================= 构建与打包产物 =================
build/
dist/
*.spec.bak"""
NEW = """# ================= 构建与打包产物 =================
# 注意用 build/* 而不是 build/:后者会把整个目录排除掉,导致 build/ 下的**手写构建脚本**
# 也无法入库(实测如此),而 build_exe.bat 会调用其中的 make_readme_txt.py / audit_exe.py,
# 全新克隆就会构建不起来。用 build/* 只排除内容,下面再按扩展名把脚本反选回来。
build/*
!build/*.py
!build/*.ps1
!build/*.spec
dist/
*.spec.bak"""


def main() -> int:
    text = io.open(GI, encoding="utf-8").read()
    if OLD not in text:
        print("  [跳过] .gitignore 未匹配到原文(可能已改)")
        return 1
    io.open(GI, "w", encoding="utf-8", newline="\n").write(text.replace(OLD, NEW, 1))
    print("  [OK] .gitignore: build/ -> build/* + 反选脚本")

    # 用 git 自己判断,不靠推测
    probes = [
        ("build/audit_exe.py", False),
        ("build/make_readme_txt.py", False),
        ("build/publish_release.ps1", False),
        ("build/spec_console_twin.spec", False),
        ("build/playwright_node.zip", True),
        ("build/build_log_onedir.txt", True),
        ("build/version_info.txt", True),
        ("build/dist_out/", True),
        ("build/pyinstaller/", True),
        ("dist/NovelCrawler/NovelCrawler.exe", True),
    ]
    bad = 0
    for rel, want_ignored in probes:
        r = subprocess.run(["git", "check-ignore", "-q", rel], cwd=ROOT)
        ignored = (r.returncode == 0)
        ok = ignored == want_ignored
        if not ok:
            bad += 1
        print(f"  {'[OK]' if ok else '[X] '} {rel:38s} 期望{'忽略' if want_ignored else '入库'} "
              f"实际{'忽略' if ignored else '入库'}")
    print("PASS" if bad == 0 else f"FAIL({bad})")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())