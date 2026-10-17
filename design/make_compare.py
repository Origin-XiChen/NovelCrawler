# -*- coding: utf-8 -*-
"""把"现状 vs 新设计"拼成对比图(带中文标注),输出到 design/shots/compare-*.png。"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "design", "shots")
OUT = SHOTS

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def font(size: int):
    for p in FONT_CANDIDATES:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


PAIRS = [
    ("门户 / 启动页", "cur-01-launcher.png", "new-08-home.png"),
    ("书架", "cur-03-book-shelf.png", "new-02-shelf.png"),
    ("搜索结果", "cur-02-book-search.png", "new-01-search.png"),
    ("设置", "cur-11-set-common.png", "new-06-settings.png"),
]

TARGET_W = 760        # 每张缩略图宽度
PAD = 18
LABEL_H = 40
TITLE_H = 54


def load(name):
    p = os.path.join(SHOTS, name)
    if not os.path.isfile(p):
        return None
    im = Image.open(p).convert("RGB")
    h = int(im.height * TARGET_W / im.width)
    return im.resize((TARGET_W, h), Image.LANCZOS)


rows = []
for title, a, b in PAIRS:
    ia, ib = load(a), load(b)
    if ia is None or ib is None:
        print("跳过(缺图):", title, a, b)
        continue
    h = max(ia.height, ib.height)
    rows.append((title, ia, ib, h))

if not rows:
    raise SystemExit("没有可用对比图")

W = PAD * 3 + TARGET_W * 2
H = TITLE_H + sum(LABEL_H + r[3] + PAD for r in rows)
canvas = Image.new("RGB", (W, H), (247, 245, 241))
d = ImageDraw.Draw(canvas)

f_title = font(26)
f_label = font(17)
f_tag = font(15)

y = 8
d.text((PAD, y), "UI 对比:现状(左) vs 新设计提案(右)", font=f_title, fill=(23, 24, 26))
y = TITLE_H

for title, ia, ib, h in rows:
    d.text((PAD, y + 8), title, font=f_label, fill=(85, 89, 94))
    # 左右标签
    d.text((PAD + TARGET_W - 92, y + 9), "现状", font=f_tag, fill=(179, 38, 30))
    d.text((PAD * 2 + TARGET_W + TARGET_W - 92, y + 9), "新设计", font=f_tag, fill=(44, 110, 99))
    yy = y + LABEL_H
    canvas.paste(ia, (PAD, yy))
    canvas.paste(ib, (PAD * 2 + TARGET_W, yy))
    # 细边框
    for x0 in (PAD, PAD * 2 + TARGET_W):
        d.rectangle([x0 - 1, yy - 1, x0 + TARGET_W, yy + h], outline=(214, 208, 200))
    y = yy + h + PAD

out = os.path.join(OUT, "compare-overview.png")
canvas.save(out, optimize=True)
print("saved", out, canvas.size)
