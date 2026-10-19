# -*- coding: utf-8 -*-
"""给打印 ✓/⚠ 等符号的诊断脚本加 stdout 兜底。

这些脚本我自己跑时用 `-X utf8`,输出是 UTF-8,符号没问题;但一旦有人(或某个批处理)
在中文控制台上直接 `python xxx.py`,控制台是 cp936(GBK),打印 ✓/⚠ 会抛
UnicodeEncodeError 把脚本整个搞崩 —— build/audit_exe.py 就在构建里踩过一次。
统一在 import 之后加一句 reconfigure(errors='replace'),保证任何控制台都不崩。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GUARD_MARK = "sys.stdout.reconfigure"
GUARD = """

try:  # 中文控制台(cp936)编不出 ✓/⚠ 时会崩,这里只做兜底不改语义
    sys.stdout.reconfigure(errors="replace")
except (AttributeError, OSError):
    pass
"""

TARGETS = [
    "design/tools/test_no_admin.py",
    "design/tools/diag_temp_dir.py",
    "design/tools/probe_exe_sections.py",
    "design/tools/probe_exe_manifest.py",
    "design/tools/fix_bat_line_endings.py",
]


def main() -> int:
    for rel in TARGETS:
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            print(f"  [跳过] {rel} 不存在")
            continue
        text = io.open(path, encoding="utf-8").read()
        if GUARD_MARK in text:
            print(f"  [跳过] {rel} 已有兜底")
            continue
        if "\nimport sys\n" not in text:
            print(f"  [跳过] {rel} 未找到 'import sys' 锚点")
            continue
        text = text.replace("\nimport sys\n", "\nimport sys\n" + GUARD, 1)
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        print(f"  [OK] {rel} 已加 stdout 兜底")
    return 0


if __name__ == "__main__":
    sys.exit(main())