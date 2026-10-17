# -*- coding: utf-8 -*-
"""从 static/index.html 里解析真实令牌值,重算对比度(而不是相信文档里的数)。

用法:python design/tools/verify_tokens.py
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")


def srgb_to_lin(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb) -> float:
    r, g, b = (srgb_to_lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def parse_color(value: str):
    """支持 #rgb/#rrggbb 与 rgba(r,g,b,a);返回 (r,g,b) 或 None(alpha 忽略,按已合成看)。"""
    v = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", v)
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"#([0-9a-fA-F]{3})", v)
    if m:
        h = m.group(1)
        return tuple(int(ch * 2, 16) for ch in h)
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)", v)
    if m:
        return tuple(int(m.group(i)) for i in (1, 2, 3))
    return None


def ratio(a, b) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def extract_tokens(text: str, selector: str) -> dict:
    """从指定选择器的规则块里抓 --name: value。"""
    idx = text.find(selector)
    if idx < 0:
        return {}
    end = text.find("}", idx)
    block = text[idx:end]
    return dict(re.findall(r"--([a-z0-9-]+)\s*:\s*([^;]+);", block))


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    light = extract_tokens(text, ":root {")
    dark = extract_tokens(text, '[data-theme="dark"] {')

    def col(env, name, fallback=None):
        v = env.get(name, "").strip()
        v = re.sub(r"/\*.*?\*/", "", v).strip()
        c = parse_color(v)
        return c if c else fallback

    checks = []

    def add(label, fg, bg, need):
        if fg is None or bg is None:
            checks.append((label, None, need, "取色失败"))
            return
        checks.append((label, ratio(fg, bg), need, ""))

    # ---- 浅色 ----
    surface = col(light, "card") or (255, 255, 255)
    paper = col(light, "bg")
    add("正文 text / card", col(light, "text"), surface, 4.5)
    add("次要 text-2 / card", col(light, "text-2"), surface, 4.5)
    add("三级 text-3 / card", col(light, "text-3"), surface, 4.5)
    add("三级 text-3 / bg", col(light, "text-3"), paper, 4.5)
    add("muted / card", col(light, "muted"), surface, 4.5)
    add("on-brand / primary", col(light, "on-brand"), col(light, "primary"), 4.5)
    add("on-brand / success", col(light, "on-brand"), col(light, "success"), 4.5)
    add("on-brand / danger", col(light, "on-brand"), col(light, "danger"), 4.5)
    add("on-brand / warn", col(light, "on-brand"), col(light, "warn"), 4.5)
    add("primary 文字 / card", col(light, "primary"), surface, 4.5)
    add("success 文字 / card", col(light, "success"), surface, 4.5)
    add("danger 文字 / card", col(light, "danger"), surface, 4.5)
    add("warn 文字 / card", col(light, "warn"), surface, 4.5)
    add("novel / card", col(light, "novel"), surface, 4.5)
    add("comic / card", col(light, "comic"), surface, 4.5)
    add("novel / novel-soft", col(light, "novel"), col(light, "novel-soft"), 4.5)
    add("comic / comic-soft", col(light, "comic"), col(light, "comic-soft"), 4.5)
    add("text / novel-soft", col(light, "text"), col(light, "novel-soft"), 4.5)
    add("text / comic-soft", col(light, "text"), col(light, "comic-soft"), 4.5)
    add("text-2 / novel-soft(门户卡说明)", col(light, "text-2"), col(light, "novel-soft"), 4.5)
    add("text-2 / comic-soft(门户卡说明)", col(light, "text-2"), col(light, "comic-soft"), 4.5)
    add("muted / card(角标/次要)", col(light, "muted"), surface, 4.5)
    add("border-strong / card(控件边界)", col(light, "border-strong"), surface, 3.0)

    # ---- 深色 ----
    dsurface = col(dark, "card") or (32, 34, 37)
    add("深色 正文 / card", col(dark, "text"), dsurface, 4.5)
    add("深色 次要 / card", col(dark, "text-2"), dsurface, 4.5)
    add("深色 三级 / card", col(dark, "text-3"), dsurface, 4.5)
    add("深色 muted / card", col(dark, "muted"), dsurface, 4.5)
    add("深色 on-brand / primary", col(dark, "on-brand"), col(dark, "primary"), 4.5)
    add("深色 primary 文字 / card", col(dark, "primary"), dsurface, 4.5)
    add("深色 success 文字 / card", col(dark, "success"), dsurface, 4.5)
    add("深色 danger 文字 / card", col(dark, "danger"), dsurface, 4.5)
    add("深色 warn 文字 / card", col(dark, "warn"), dsurface, 4.5)
    add("深色 novel / card", col(dark, "novel"), dsurface, 4.5)
    add("深色 comic / card", col(dark, "comic"), dsurface, 4.5)
    add("深色 border-strong / card", col(dark, "border-strong"), dsurface, 3.0)

    print(f"{'检查项':<34}{'实测':>9}{'要求':>7}  结论")
    print("-" * 62)
    bad = 0
    for label, r, need, err in checks:
        if r is None:
            print(f"{label:<34}{'--':>9}{need:>7}  ❌ {err}")
            bad += 1
            continue
        ok = r >= need
        bad += 0 if ok else 1
        print(f"{label:<34}{r:>8.2f}:1{need:>7}  {'✅ 通过' if ok else '❌ 不达标'}")
    print("-" * 62)
    print(f"共 {len(checks)} 项,不达标 {bad} 项")
    # 顺带报告令牌覆盖率:是否还有旧值残留
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())