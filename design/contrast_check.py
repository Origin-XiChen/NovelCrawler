# -*- coding: utf-8 -*-
"""配色对比度校验:输出每对前景/背景的 WCAG 比值,便于交付前逐条确认。"""

def lum(hexs: str) -> float:
    h = hexs.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg: str, bg: str) -> float:
    la, lb = lum(fg), lum(bg)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ---- 新设计系统(暖纸墨色 + 双模式低饱和强调色) ----
C = {
    "paper": "#F7F5F1",
    "surface": "#FFFFFF",
    "surface2": "#FBF9F6",
    "ink": "#17181A",
    "ink2": "#55595E",
    "ink3": "#6B7075",
    "line": "#E7E2DA",
    "lineStrong": "#8C8579",
    "brand": "#2C6E63",
    "brandHover": "#235A51",
    "brandSoft": "#EAF2EF",
    "novel": "#8E562F",      # 沙褐:小说模式强调
    "novelSoft": "#F4EADE",  # 小说卡底(浅)
    "comic": "#376C4C",      # 鼠尾草绿:漫画模式强调
    "comicSoft": "#E6EFE7",
    "success": "#2F7A4F",
    "warn": "#9A6208",
    "danger": "#B3261E",
    "dangerSoft": "#FBEAE8",
    "amberSoft": "#FAF0DC",
    "darkBg": "#17181A",
    "darkSurface": "#202225",
    "darkSurface2": "#26292C",
    "darkInk": "#F2F0EC",
    "darkInk2": "#B9B6B0",
    "darkInk3": "#96938D",
    "darkLine": "#33373B",
    "darkBrand": "#5FB39F",
}

CASES = [
    # (说明, 前景, 背景, 需要的最小比值)
    ("正文 ink / surface", C["ink"], C["surface"], 4.5),
    ("次要文字 ink2 / surface", C["ink2"], C["surface"], 4.5),
    ("三级文字 ink3 / surface", C["ink3"], C["surface"], 4.5),
    ("三级文字 ink3 / paper", C["ink3"], C["paper"], 4.5),
    ("白字 / 主按钮 brand", "#FFFFFF", C["brand"], 4.5),
    ("白字 / brand-hover", "#FFFFFF", C["brandHover"], 4.5),
    ("brand 文字 / brandSoft", C["brand"], C["brandSoft"], 4.5),
    ("警告文字 warn / surface", C["warn"], C["surface"], 4.5),
    ("警告文字 warn / amberSoft", C["warn"], C["amberSoft"], 4.5),
    ("危险文字 danger / surface", C["danger"], C["surface"], 4.5),
    ("危险文字 danger / dangerSoft", C["danger"], C["dangerSoft"], 4.5),
    ("成功文字 success / surface", C["success"], C["surface"], 4.5),
    ("小说强调 novel / surface", C["novel"], C["surface"], 4.5),
    ("小说强调 novel / novelSoft", C["novel"], C["novelSoft"], 4.5),
    ("漫画强调 comic / surface", C["comic"], C["surface"], 4.5),
    ("漫画强调 comic / comicSoft", C["comic"], C["comicSoft"], 4.5),
    ("ink 正文 / novelSoft 卡底", C["ink"], C["novelSoft"], 4.5),
    ("ink 正文 / comicSoft 卡底", C["ink"], C["comicSoft"], 4.5),
    ("ink2 / paper", C["ink2"], C["paper"], 4.5),
    ("控件边框 lineStrong / surface", C["lineStrong"], C["surface"], 3.0),
    ("深色:正文 darkInk / darkBg", C["darkInk"], C["darkBg"], 4.5),
    ("深色:正文 darkInk / darkSurface", C["darkInk"], C["darkSurface"], 4.5),
    ("深色:次要 darkInk2 / darkSurface", C["darkInk2"], C["darkSurface"], 4.5),
    ("深色:三级 darkInk3 / darkSurface", C["darkInk3"], C["darkSurface"], 4.5),
    ("深色:白字 / darkBrand", "#0F1113", C["darkBrand"], 4.5),
    ("深色:darkBrand 文字 / darkSurface", C["darkBrand"], C["darkSurface"], 4.5),
]

if __name__ == "__main__":
    bad = 0
    print(f"{'检查项':36s} {'实测':>7s}  {'要求':>5s}  结论")
    print("-" * 74)
    for name, fg, bg, need in CASES:
        r = ratio(fg, bg)
        ok = r >= need
        if not ok:
            bad += 1
        print(f"{name:36s} {r:6.2f}:1  {need:5.1f}  {'✅ 通过' if ok else '❌ 不达标'}")
    print("-" * 74)
    print(f"共 {len(CASES)} 项,不达标 {bad} 项")

