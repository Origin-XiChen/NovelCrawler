# -*- coding: utf-8 -*-
"""把 JS 里的颜色表换成主题令牌(阶段二)。

问题:SRC_STATUS / srcGroupColor / srcGroupBg 用的是写死的浅色底+深色字,
在深色主题下会变成"浅底深字卡在深色界面里",而且其中 3 组本来就不达 4.5:1
(实测 src-tag.ok 3.87:1、src-tag.direct 4.13:1、#16a34a/白 3.30:1)。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

PAIRS = [
    # 1) 搜索结果卡上的"可用/直连"标签(3.87:1 与 4.13:1 → 4.60:1 与 4.50:1)
    ('.result-item .src-tag.ok { background:var(--success-50); color:#248a3d; }',
     '.result-item .src-tag.ok { background:var(--success-50); color:var(--success); }',
     'src-tag.ok → var(--success)'),
    ('.result-item .src-tag.direct { background:var(--warn-50); color:#b25e00; }',
     '.result-item .src-tag.direct { background:var(--warn-50); color:var(--warn); }',
     'src-tag.direct → var(--warn)'),

    # 2) 书源状态色:改成主题令牌,深色模式自动跟随
    ("const SRC_STATUS = {'ok':'#16a34a','empty':'#d97706','error':'#dc2626','no_search':'#8a94a6','timeout':'#d97706'};",
     "const SRC_STATUS = {'ok':'var(--success)','empty':'var(--warn)','error':'var(--danger)',"
     "'no_search':'var(--text-3)','timeout':'var(--warn)'};",
     'SRC_STATUS → 主题令牌'),
    ("const c = SRC_STATUS[s.status] || '#8a94a6';",
     "const c = SRC_STATUS[s.status] || 'var(--text-3)';",
     'SRC_STATUS 兜底色 → var(--text-3)'),

    # 3) 分组色/底色:同样令牌化
    ("""function srcGroupColor(g) {
  if (g.timeout && !g.ok && !g.empty) return '#854F0B';
  if (g.error && !g.ok && !g.empty && !g.nosearch) return '#A32D2D';
  if (g.ok) return '#0F6E56';
  if (g.empty) return '#854F0B';
  return '#444441';
}""",
     """function srcGroupColor(g) {
  if (g.timeout && !g.ok && !g.empty) return 'var(--warn)';
  if (g.error && !g.ok && !g.empty && !g.nosearch) return 'var(--danger)';
  if (g.ok) return 'var(--success)';
  if (g.empty) return 'var(--warn)';
  return 'var(--text-2)';
}""",
     'srcGroupColor → 主题令牌'),
    ("""function srcGroupBg(g) {
  if (g.timeout && !g.ok && !g.empty) return '#FAEEDA';
  if (g.error && !g.ok && !g.empty && !g.nosearch) return '#FCEBEB';
  if (g.ok) return '#E1F5EE';
  if (g.empty) return '#FAEEDA';
  return '#F1EFE8';
}""",
     """function srcGroupBg(g) {
  if (g.timeout && !g.ok && !g.empty) return 'var(--warn-50)';
  if (g.error && !g.ok && !g.empty && !g.nosearch) return 'var(--danger-50)';
  if (g.ok) return 'var(--success-50)';
  if (g.empty) return 'var(--warn-50)';
  return 'var(--surface-2)';
}""",
     'srcGroupBg → 主题令牌'),
]


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    for old, new, label in PAIRS:
        n = text.count(old)
        if n:
            text = text.replace(old, new)
            print(f"  [OK x{n}] {label}")
        else:
            print(f"  [跳过] {label}(未匹配)")
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())