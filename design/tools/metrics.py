import re, sys
html = open(r"static/index.html", encoding="utf-8").read()

EMOJI = re.compile("[" "\U0001F300-\U0001FAFF" "\u2190-\u21FF" "\u2300-\u27BF" "\u2B00-\u2BFF" "\uFE0F" "]")
emo = EMOJI.findall(html)
print("结构性 emoji/符号 出现次数:", len(emo))
from collections import Counter
print("Top 20:", Counter(emo).most_common(20))

def lum(hexs):
    h = hexs.lstrip("#")
    if len(h) == 3: h = "".join(c*2 for c in h)
    r, g, b = (int(h[i:i+2], 16)/255 for i in (0, 2, 4))
    f = lambda c: c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
    r, g, b = f(r), f(g), f(b)
    return 0.2126*r + 0.7152*g + 0.0722*b

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi+0.05)/(lo+0.05)

pairs = [
    ("白字 / 门户绿卡 #34C759", "#ffffff", "#34C759"),
    ("白字 / 门户橙卡 #FF9500", "#ffffff", "#FF9500"),
    ("白字 / 主色 #007AFF", "#ffffff", "#007AFF"),
    ("正文 #1d1d1f / 白", "#1d1d1f", "#ffffff"),
    ("次要文字 #6e6e73 / 白", "#6e6e73", "#ffffff"),
    ("次要文字 #6e6e73 / 背景 #f5f5f7", "#6e6e73", "#f5f5f7"),
    ("边框 #d2d2d7 / 白", "#d2d2d7", "#ffffff"),
    ("白字 / 成功 #34C759", "#ffffff", "#34C759"),
    ("白字 / 危险 #FF3B30", "#ffffff", "#FF3B30"),
]
print("\n对比度(WCAG):")
for name, fg, bg in pairs:
    r = ratio(fg, bg)
    verdict = "AAA" if r >= 7 else ("AA" if r >= 4.5 else ("AA-大字号" if r >= 3 else "不达标"))
    print(f"  {name:34s} {r:5.2f}:1   {verdict}")

# 深色主题是否成对定义
dark = "prefers-color-scheme: dark" in html
theme_attr = re.findall(r'\[data-theme="([a-z]+)"\]', html)
print("\n深色模式: prefers-color-scheme 块 =", dark, " data-theme 取值 =", set(theme_attr))
