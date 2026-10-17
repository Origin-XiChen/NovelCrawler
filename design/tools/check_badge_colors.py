# -*- coding: utf-8 -*-
"""找出"同一行/同一规则里写死的前景色 + 背景色"并核算对比度。

只报不达标项,便于逐个换成令牌或加深取值。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex2rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def ratio(a, b):
    def lum(c):
        r, g, bl = (lin(x) for x in c)
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# 语义色的"软底 + 深字"配对:一律用令牌,深浅两套主题都靠令牌切换
PAIRS = [
    ("success 字 / success-50", "#2F7A4F", "#E1F5EE"),
    ("warn 字 / warn-50", "#9A6208", "#FAF0DC"),
    ("danger 字 / danger-50", "#B3261E", "#FBEAE8"),
    ("success 字 / 白", "#2F7A4F", "#FFFFFF"),
    ("warn 字 / 白", "#9A6208", "#FFFFFF"),
    ("danger 字 / 白", "#B3261E", "#FFFFFF"),
    ("text-2 / success-50", "#55595E", "#E1F5EE"),
    ("text-2 / surface-2", "#55595E", "#FBF9F6"),
]

# 这些写死的旧值已经换成令牌,再出现就是回退(阶段二 lint 的语义补充)
LEGACY_LITERALS = ["#248a3d", "#b25e00", "#16a34a", "#d97706", "#dc2626", "#8a94a6"]


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    print(f"{'项目':<26}{'前景/背景':<20}{'实测':>9}  4.5:1")
    bad = []
    for label, fg, bg in PAIRS:
        r = ratio(hex2rgb(fg), hex2rgb(bg))
        mark = "✅" if r >= 4.5 else "❌"
        if r < 4.5:
            bad.append(label)
        print(f"{label:<26}{fg + '/' + bg:<20}{r:>8.2f}:1  {mark}")

    print("\n旧写死值残留检查:")
    for lit in LEGACY_LITERALS:
        n = len(re.findall(re.escape(lit), text, re.I))
        if n:
            print(f"  ❌ {lit} 仍出现 {n} 次")
            bad.append(lit)
        else:
            print(f"  ✅ {lit} 已清理")

    print(f"\n不达标 {len(bad)} 项: {', '.join(bad) if bad else '无'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())