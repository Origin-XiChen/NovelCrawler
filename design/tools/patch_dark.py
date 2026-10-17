# -*- coding: utf-8 -*-
"""把 [data-theme="dark"] 规则里的旧冷灰字面量映射到新的暖色深色令牌(阶段一)。

注意:只在带 [data-theme="dark"] 的行上替换。像 .dl-float(下载浮条)/
.reader-body[data-paper="night"]/图片放大遮罩这些"始终是深色"的元素,
它们故意写死深色值,两种主题下都不该变,所以必须跳过。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

# 字面量 → 令牌(仅限 dark 行)
LINE_MAP = [
    ("#3a3a3c", "var(--surface-2)"),
    ("#48484a", "var(--surface-3)"),
    ("#2c2c2e", "var(--card)"),
    ("#333336", "var(--surface-2)"),
    ("#0d0d0f", "#121316"),
    ("#f5f5f7", "var(--text)"),
]
# 半透明深色浮层:旧 #2c2c2e(=rgb(44,44,46)) → 新 #202225(=rgb(32,34,37))
RGBA_MAP = [
    ("rgba(44,44,46,", "rgba(32,34,37,"),
    ("rgba(30,30,32,", "rgba(23,24,26,"),
]


def main() -> int:
    with io.open(TARGET, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    changes = []
    for i, line in enumerate(lines):
        if '[data-theme="dark"]' not in line:
            continue
        new = line
        for old, tok in LINE_MAP:
            # 只替换独立色值,避免碰 #3a3a3c1f 这类带 alpha 的写法
            new = re.sub(re.escape(old) + r"(?![0-9a-fA-F])", tok, new)
        for old, tok in RGBA_MAP:
            new = new.replace(old, tok)
        if new != line:
            changes.append((i + 1, line.strip(), new.strip()))
            lines[i] = new
    if changes:
        with io.open(TARGET, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines))
    for ln, old, new in changes:
        print(f"L{ln}: {new}")
    print(f"共改写 {len(changes)} 行 dark 规则")
    return 0


if __name__ == "__main__":
    sys.exit(main())