# -*- coding: utf-8 -*-
"""阶段一收尾的小改动:注释与门户"使用说明"入口的可访问性。"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

PAIRS = [
    ("showDevTip('main');           // 启动弹门户使用说明(每会话一次)",
     "showDevTip('main');           // 启动弹门户使用说明(仅首次自动弹;之后用门户底部「ℹ 使用说明」随时打开)",
     '启动提示注释'),
    ('<span class="dev-badge" onclick="showDevTip(\'main\', true)">ℹ 使用说明</span>',
     '<span class="dev-badge" role="button" tabindex="0" title="打开使用说明" '
     'aria-label="打开使用说明" onclick="showDevTip(\'main\', true)" '
     'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();showDevTip(\'main\',true);}">'
     'ℹ 使用说明</span>',
     '使用说明入口键盘可达'),
]


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    for old, new, label in PAIRS:
        if old in text:
            text = text.replace(old, new, 1)
            print(f"  [OK] {label}")
        else:
            print(f"  [跳过] {label}(未匹配)")
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())