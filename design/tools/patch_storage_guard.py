# -*- coding: utf-8 -*-
"""顺手补齐 3 处裸 localStorage 读取(存储被禁用/隐私模式会直接抛异常)。

同一文件里其它同类读取都写了 try/catch(见 index.html:5989/7430、reader-core.js:18),
只有这 3 处漏了。都是"读不到就用默认值"的语义,补上后行为不变、只是不再抛。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IDX = os.path.join(ROOT, "static", "index.html")
CORE = os.path.join(ROOT, "static", "reader-core.js")

EDITS = {
    IDX: [
        (
            "    set('gsTheme', localStorage.getItem('novelist_theme') || 'auto');",
            "    let _theme = 'auto'; try { _theme = localStorage.getItem('novelist_theme') || 'auto'; } catch (e) {}\n"
            "    set('gsTheme', _theme);",
            "设置页回填主题:存储不可用时退回 auto",
        ),
        (
            "    if ((localStorage.getItem('novelist_theme') || 'auto') === 'auto') {",
            "    let _t = 'auto'; try { _t = localStorage.getItem('novelist_theme') || 'auto'; } catch (e) {}\n"
            "    if (_t === 'auto') {",
            "跟随系统主题监听:存储不可用时按 auto 处理",
        ),
    ],
    CORE: [
        (
            """function _loadPaper() {
  const p = localStorage.getItem(PAPER_KEY);
  return ['paper', 'green', 'sepia', 'night'].includes(p) ? p : 'paper';
}""",
            """function _loadPaper() {
  let p = 'paper';
  try { p = localStorage.getItem(PAPER_KEY); } catch (e) { /* 存储被禁用 → 用默认纸色 */ }
  return ['paper', 'green', 'sepia', 'night'].includes(p) ? p : 'paper';
}""",
            "纸色读取:存储不可用时退回 paper",
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
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())