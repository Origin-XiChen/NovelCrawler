# -*- coding: utf-8 -*-
"""设计令牌守卫(阶段二的"防回退"闸门)。

检查 static/index.html 里是否新增了写死的颜色 / 字号。
存量以基线文件(design/ui-lint-baseline.json)为准:数量只允许减少。

用法:
  python design/tools/lint_ui.py            # 对比基线,超出即失败(退出码 1)
  python design/tools/lint_ui.py --update   # 把当前数量写成新基线

规则(有意做得很窄,只挡"新增写死值"):
  * 颜色:color / background / background-color / border-color / fill / stroke 里的 #hex 或 rgb()
    允许 var(--token)、transparent、currentColor、inherit、none、#000/#fff 以外的关键词。
  * 字号:font-size:Npx 里不使用 var(--fs-*) 的字面量。
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")
BASELINE = os.path.join(ROOT, "design", "ui-lint-baseline.json")

COLOR_PROPS = ("color", "background", "background-color", "border-color", "fill", "stroke")
# 允许出现的"非令牌"颜色值(纯黑/纯白/透明 等中性值,以及 r,g,b 变量组合)
ALLOW = {"transparent", "currentcolor", "inherit", "none", "initial", "unset"}


def collect(text: str):
    """返回 (颜色字面量列表, 字号字面量列表)。逐行扫描,行号从 1 开始。"""
    colors, fonts = [], []
    for i, line in enumerate(text.split("\n"), 1):
        for prop in COLOR_PROPS:
            # 匹配 "background:#123456" / "border-color: rgba(...)" / "stroke='#abc'"
            for m in re.finditer(rf"(?:^|[;\s\"'])" + re.escape(prop) + r"\s*[:=]\s*([^;\"'\n]+)", line, re.I):
                val = m.group(1).strip()
                if "var(" in val:
                    continue
                for c in re.findall(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)", val):
                    if c.lower() in ALLOW:
                        continue
                    colors.append((i, c))
        for m in re.finditer(r"font-size\s*[:=]\s*([^;\"'\n]+)", line, re.I):
            val = m.group(1).strip()
            if "var(" in val:
                continue
            if re.match(r"^\d+(\.\d+)?px$", val):
                fonts.append((i, val))
    return colors, fonts


def main() -> int:
    update = "--update" in sys.argv
    text = io.open(TARGET, encoding="utf-8").read()
    colors, fonts = collect(text)
    cur = {
        "colors": len(colors),
        "fonts": len(fonts),
        "colorValues": sorted({c for _, c in colors}),
    }
    if update or not os.path.isfile(BASELINE):
        io.open(BASELINE, "w", encoding="utf-8").write(json.dumps(cur, ensure_ascii=False, indent=2))
        print(f"已写入基线 {BASELINE}: 颜色 {cur['colors']} 处 / 字号 {cur['fonts']} 处")
        return 0
    base = json.loads(io.open(BASELINE, encoding="utf-8").read())
    print(f"颜色字面量: 当前 {cur['colors']} / 基线 {base['colors']}")
    print(f"字号字面量: 当前 {cur['fonts']} / 基线 {base['fonts']}")
    failed = False
    if cur["colors"] > base["colors"]:
        failed = True
        print(f"\n❌ 新增了写死颜色({cur['colors'] - base['colors']} 处)。请改用 var(--token)。")
        new_vals = sorted(set(cur["colorValues"]) - set(base.get("colorValues", [])))
        for v in new_vals[:20]:
            line = next((ln for ln, c in colors if c == v), "?")
            print(f"   {v}   (首次出现在 L{line})")
    if cur["fonts"] > base["fonts"]:
        failed = True
        print(f"\n❌ 新增了写死字号({cur['fonts'] - base['fonts']} 处)。请改用 var(--fs-*)。")
    if not failed:
        print("\n✅ 未新增写死颜色/字号。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())